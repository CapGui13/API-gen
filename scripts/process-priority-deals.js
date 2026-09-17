#!/usr/bin/env node
'use strict';

// Pré-calcul prioritaire des donnes créées "fresh" dans PLAY.
// Chaque runner lance plusieurs Worker Threads. Un worker :
//   1) réclame atomiquement une donne dans Redis ;
//   2) calcule immédiatement la table DD exacte ;
//   3) publie progressivement les tables statistiques brutes à 24, 48 puis 72 tirages
//      POUR LES DEUX CAMPS ;
//   4) passe à la donne suivante tant que la file n'est pas vide.
// PLAY reste libre de calculer localement en parallèle : le premier résultat arrivé gagne.

const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const PRIORITY_QUEUE_KEY = 'bridge-deal-pool:v3:priority:queue';
const PRIORITY_JOB_TTL_SECONDS = 6 * 60 * 60;
const PRIORITY_CONCURRENCY = clampInt(process.env.BRIDGE_PRIORITY_CONCURRENCY, 2, 1, 4);
const PRIORITY_MAX_JOBS_PER_WORKER = clampInt(process.env.BRIDGE_PRIORITY_MAX_JOBS_PER_WORKER, 12, 1, 100);
const SAMPLE_COUNT = 72;
const CHECKPOINTS = new Set([24, 48, 72]);
const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];

let StatisticalPar = null;
let calcDDTable = null;

function clampInt(raw, fallback, min, max) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function redisCommand(command) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('priority-storage-unavailable');
    const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error || `Upstash HTTP ${resp.status}`);
    return data.result;
}

function ensureDds() {
    if (calcDDTable && StatisticalPar) return;
    StatisticalPar = require('../lib/pool-statistical-sampler');
    global.Module = global.Module || {};
    require('../api/dds-lib.js');
    calcDDTable = global.Module.cwrap('generateDDTable', 'string', ['string']);
}

function dealToPbn(hands) {
    return 'N:' + SEATS.map(seat => SUITS.map(suit => String(hands[seat][suit] || '')).join('.')).join(' ');
}

function solveTableForHands(hands) {
    ensureDds();
    const raw = calcDDTable(dealToPbn(hands));
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') throw new Error('DDS table invalide');
    return parsed;
}

function configForSide(side) {
    const normalized = side === 'EW' ? 'EW' : 'NS';
    const knownSeats = normalized === 'NS' ? ['N', 'S'] : ['E', 'W'];
    const randomizedSeats = normalized === 'NS' ? ['E', 'W'] : ['N', 'S'];
    return {
        ok: true,
        mode: 'two-known-hands',
        knownSeats: knownSeats.slice(),
        humanSeats: knownSeats.slice(),
        actualHumanSeats: knownSeats.slice(),
        pendingSeats: [],
        reservedHumanSeats: knownSeats.slice(),
        randomizedSeats: randomizedSeats.slice(),
        botSeats: randomizedSeats.slice(),
        humanSide: normalized,
        botSide: normalized === 'NS' ? 'EW' : 'NS',
        diagnosticPerspective: 'optimal-contract-side'
    };
}

function normalizeHands(rawHands) {
    if (!rawHands || typeof rawHands !== 'object') return null;
    const hands = {};
    const seen = new Set();
    for (const seat of SEATS) {
        const rawHand = rawHands[seat];
        if (!rawHand || typeof rawHand !== 'object') return null;
        hands[seat] = {};
        let count = 0;
        for (const suit of SUITS) {
            const ranks = String(rawHand[suit] || '').toUpperCase();
            if (!/^[AKQJT98765432]*$/.test(ranks)) return null;
            hands[seat][suit] = ranks;
            count += ranks.length;
            for (const rank of ranks) {
                const card = suit + rank;
                if (seen.has(card)) return null;
                seen.add(card);
            }
        }
        if (count !== 13) return null;
    }
    return seen.size === 52 ? hands : null;
}

const CLAIM_LUA = `
local queueKey = KEYS[1]
local nowMs = tonumber(ARGV[1])
local nowIso = ARGV[2]
local workerId = ARGV[3]
local ttl = tonumber(ARGV[4])
for i = 1, 64 do
  local jobKey = redis.call('LPOP', queueKey)
  if not jobKey then return nil end
  local raw = redis.call('GET', jobKey)
  if raw then
    local ok, rec = pcall(cjson.decode, raw)
    if ok then
      local status = tostring(rec['status'] or '')
      local updatedMs = tonumber(rec['updatedAtMs'] or 0)
      local stale = status == 'processing' and updatedMs > 0 and (nowMs - updatedMs) > 600000
      if status == 'queued' or stale then
        rec['status'] = 'processing'
        rec['workerId'] = workerId
        rec['updatedAtMs'] = nowMs
        rec['updatedAt'] = nowIso
        redis.call('SET', jobKey, cjson.encode(rec), 'EX', ttl)
        return {jobKey, cjson.encode(rec)}
      end
    end
  end
end
return nil
`;

async function claimPriorityJob(workerId) {
    const now = new Date();
    const result = await redisCommand([
        'EVAL', CLAIM_LUA, '1', PRIORITY_QUEUE_KEY,
        String(now.getTime()), now.toISOString(), workerId, String(PRIORITY_JOB_TTL_SECONDS)
    ]);
    if (!Array.isArray(result) || result.length < 2) return null;
    const jobKey = String(result[0] || '');
    let job;
    try { job = JSON.parse(result[1]); } catch (_) { return null; }
    return jobKey && job ? { jobKey, job } : null;
}

async function saveJob(jobKey, job) {
    job.updatedAtMs = Date.now();
    job.updatedAt = new Date(job.updatedAtMs).toISOString();
    await redisCommand(['SET', jobKey, JSON.stringify(job), 'EX', String(PRIORITY_JOB_TTL_SECONDS)]);
}

function buildProgressPayload(job, ddTable, sides, sampleCount) {
    ensureDds();
    return {
        format: 'universal-dd-72',
        statisticalSeedId: job.statisticalSeedId,
        samplingSeedVersion: StatisticalPar.STATISTICAL_PAR_SAMPLING_SEED_VERSION,
        sampleCount,
        sides: {
            NS: sides.NS.slice(0, sampleCount),
            EW: sides.EW.slice(0, sampleCount)
        }
    };
}

async function processJob(jobKey, job, workerId) {
    ensureDds();
    const hands = normalizeHands(job && job.hands);
    const statisticalSeedId = String(job && job.statisticalSeedId || '').trim();
    if (!hands || !statisticalSeedId) throw new Error('priority-job-invalide');

    const startedAt = Date.now();
    const deal = { hands, statisticalSeedId };
    const ddTable = solveTableForHands(hands);
    const sides = { NS: [], EW: [] };

    job.status = 'processing';
    job.workerId = workerId;
    job.ddTable = ddTable;
    job.sampleCount = 0;
    job.precomputeMs = Date.now() - startedAt;
    await saveJob(jobKey, job); // le DD exact peut déjà être récupéré par PLAY

    const configs = { NS: configForSide('NS'), EW: configForSide('EW') };
    for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex++) {
        // Interleaver NS/EW : le premier palier utile (24) arrive simultanément pour
        // les deux camps, au lieu de faire attendre EW derrière 72 calculs NS.
        for (const side of ['NS', 'EW']) {
            const sampleHands = StatisticalPar.sampleHandsDeterministic(deal, configs[side], sampleIndex);
            sides[side].push({ sampleIndex, table: solveTableForHands(sampleHands) });
        }
        const completed = sampleIndex + 1;
        if (CHECKPOINTS.has(completed)) {
            job.sampleCount = completed;
            job.precomputedStatV1 = buildProgressPayload(job, ddTable, sides, completed);
            job.precomputeMs = Date.now() - startedAt;
            job.status = completed >= SAMPLE_COUNT ? 'done' : 'processing';
            if (job.status === 'done') job.completedAt = new Date().toISOString();
            await saveJob(jobKey, job);
            parentPort && parentPort.postMessage({
                type: 'progress', id: statisticalSeedId, sampleCount: completed,
                ms: job.precomputeMs, status: job.status
            });
        }
    }
}

async function workerLoop(workerId) {
    let processed = 0;
    while (processed < PRIORITY_MAX_JOBS_PER_WORKER) {
        const claimed = await claimPriorityJob(workerId);
        if (!claimed) break;
        const { jobKey, job } = claimed;
        try {
            await processJob(jobKey, job, workerId);
            processed++;
        } catch (err) {
            job.status = 'error';
            job.error = String(err && err.message || err || 'priority-precompute-error').slice(0, 500);
            job.workerId = workerId;
            try { await saveJob(jobKey, job); } catch (_) {}
            parentPort && parentPort.postMessage({ type: 'error', id: job.statisticalSeedId || '', error: job.error });
            processed++;
        }
    }
    return processed;
}

async function mainThread() {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('UPSTASH secrets absents');
    const shard = String(process.env.BRIDGE_PRIORITY_SHARD || process.env.GITHUB_JOB || 'local').replace(/[^A-Za-z0-9_.-]/g, '-');
    const workers = [];
    let total = 0;
    for (let i = 0; i < PRIORITY_CONCURRENCY; i++) {
        const workerId = `${shard}-${process.pid}-${i}-${crypto.randomBytes(4).toString('hex')}`;
        const worker = new Worker(__filename, { workerData: { workerId } });
        worker.on('message', message => {
            if (!message) return;
            if (message.type === 'progress') {
                console.log(`[priority] ${message.id} -> ${message.sampleCount}/72 (${message.status}, ${message.ms} ms)`);
            } else if (message.type === 'error') {
                console.error(`[priority] ${message.id || '?'} ECHEC: ${message.error}`);
            } else if (message.type === 'done') {
                total += Number(message.processed || 0);
            }
        });
        workers.push(new Promise((resolve, reject) => {
            worker.once('error', reject);
            worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`worker ${workerId} exit ${code}`)));
        }));
    }
    await Promise.all(workers);
    console.log(`[priority] file drainée sur ce runner — jobs traités=${total}`);
}

if (isMainThread) {
    mainThread().catch(err => {
        console.error('[priority] ECHEC:', err && err.stack || err);
        process.exitCode = 1;
    });
} else {
    const workerId = String(workerData && workerData.workerId || `worker-${process.pid}`);
    workerLoop(workerId)
        .then(processed => { parentPort.postMessage({ type: 'done', processed }); })
        .catch(err => {
            parentPort.postMessage({ type: 'error', id: '', error: String(err && err.stack || err) });
            process.exitCode = 1;
        });
}
