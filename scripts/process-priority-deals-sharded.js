#!/usr/bin/env node
'use strict';

// R141 — pré-calcul prioritaire sharded.
// Une donne fraîche n'est plus monopolisée par un seul Worker Thread : le premier worker
// qui rencontre son descripteur la découpe en 73 tâches indépendantes (DD exact + 72
// redistributions). Tous les runners/threads du workflow peuvent alors collaborer sur la
// MÊME donne. Chaque sample calcule NS puis EW et publie sa paire dans un hash Redis.
// Dès que 0..23, 0..47 ou 0..71 sont tous présents, un worker assemble le checkpoint et
// le rend immédiatement visible à PLAY via la même structure precomputedStatV1 qu'avant.

const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PRIORITY_QUEUE_KEY = 'bridge-deal-pool:v3:priority:queue';
const PRIORITY_JOB_TTL_SECONDS = 6 * 60 * 60;
const PRIORITY_CONCURRENCY = clampInt(process.env.BRIDGE_PRIORITY_CONCURRENCY, 4, 1, 4);
const PRIORITY_MAX_TASKS_PER_WORKER = clampInt(
    process.env.BRIDGE_PRIORITY_MAX_TASKS_PER_WORKER || process.env.BRIDGE_PRIORITY_MAX_JOBS_PER_WORKER,
    96, 1, 500
);
const SAMPLE_COUNT = 72;
const CHECKPOINTS = [24, 48, 72];
const EMPTY_RETRIES = 16;
const EMPTY_RETRY_MS = 350;
const CLAIM_TTL_SECONDS = 300;
const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];

let StatisticalPar = null;
let calcDDTable = null;

function clampInt(raw, fallback, min, max) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(n)));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
        ok: true, mode: 'two-known-hands', knownSeats: knownSeats.slice(), humanSeats: knownSeats.slice(),
        actualHumanSeats: knownSeats.slice(), pendingSeats: [], reservedHumanSeats: knownSeats.slice(),
        randomizedSeats: randomizedSeats.slice(), botSeats: randomizedSeats.slice(), humanSide: normalized,
        botSide: normalized === 'NS' ? 'EW' : 'NS', diagnosticPerspective: 'optimal-contract-side'
    };
}
function normalizeHands(rawHands) {
    if (!rawHands || typeof rawHands !== 'object') return null;
    const hands = {}; const seen = new Set();
    for (const seat of SEATS) {
        const rawHand = rawHands[seat];
        if (!rawHand || typeof rawHand !== 'object') return null;
        hands[seat] = {}; let count = 0;
        for (const suit of SUITS) {
            const ranks = String(rawHand[suit] || '').toUpperCase();
            if (!/^[AKQJT98765432]*$/.test(ranks)) return null;
            hands[seat][suit] = ranks; count += ranks.length;
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

const PATCH_JOB_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local ok, rec = pcall(cjson.decode, raw)
if not ok then return nil end
local patchOk, patch = pcall(cjson.decode, ARGV[1])
if not patchOk then return nil end
for k,v in pairs(patch) do rec[k] = v end
rec['updatedAtMs'] = tonumber(ARGV[2])
rec['updatedAt'] = ARGV[3]
redis.call('SET', KEYS[1], cjson.encode(rec), 'EX', tonumber(ARGV[4]))
return cjson.encode(rec)
`;

async function patchJob(jobKey, patch) {
    const now = new Date();
    const raw = await redisCommand(['EVAL', PATCH_JOB_LUA, '1', jobKey, JSON.stringify(patch), String(now.getTime()), now.toISOString(), String(PRIORITY_JOB_TTL_SECONDS)]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}
async function getJob(jobKey) {
    const raw = await redisCommand(['GET', jobKey]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

function samplesKey(jobKey) { return `${jobKey}:sharded:samples`; }
function fanoutKey(jobKey) { return `${jobKey}:sharded:fanout`; }
function claimKey(jobKey, suffix) { return `${jobKey}:sharded:claim:${suffix}`; }
function checkpointKey(jobKey, n) { return `${jobKey}:sharded:checkpoint:${n}`; }
function taskToken(jobKey, kind, index) { return `${jobKey}::${kind}${index == null ? '' : `:${index}`}`; }
function parseTaskToken(token) {
    const text = String(token || '');
    const marker = text.lastIndexOf('::');
    if (marker < 0) return { kind: 'descriptor', jobKey: text };
    const jobKey = text.slice(0, marker);
    const tail = text.slice(marker + 2);
    if (tail === 'dd') return { kind: 'dd', jobKey };
    const m = tail.match(/^sample:(\d+)$/);
    if (m) return { kind: 'sample', jobKey, sampleIndex: Number(m[1]) };
    return { kind: 'invalid', jobKey };
}

async function acquireClaim(jobKey, suffix) {
    const result = await redisCommand(['SET', claimKey(jobKey, suffix), String(Date.now()), 'NX', 'EX', String(CLAIM_TTL_SECONDS)]);
    return String(result || '').toUpperCase() === 'OK';
}
async function releaseClaim(jobKey, suffix) {
    try { await redisCommand(['DEL', claimKey(jobKey, suffix)]); } catch (_) {}
}

async function fanoutDescriptor(jobKey, workerId) {
    const job = await getJob(jobKey);
    if (!job) return 0;
    const hands = normalizeHands(job.hands);
    const statisticalSeedId = String(job.statisticalSeedId || '').trim();
    if (!hands || !statisticalSeedId) {
        await patchJob(jobKey, { status: 'error', error: 'priority-job-invalide', workerId });
        return 0;
    }
    const won = await redisCommand(['SET', fanoutKey(jobKey), workerId, 'NX', 'EX', String(PRIORITY_JOB_TTL_SECONDS)]);
    if (String(won || '').toUpperCase() !== 'OK') return 0;
    await patchJob(jobKey, {
        status: 'processing', workerId, sampleCount: Number(job.sampleCount || 0),
        sharded: true, shardedTaskCount: SAMPLE_COUNT + 1,
        startedAtMs: Number(job.startedAtMs || Date.now())
    });
    const tasks = [taskToken(jobKey, 'dd')];
    for (let i = 0; i < SAMPLE_COUNT; i++) tasks.push(taskToken(jobKey, 'sample', i));
    // RPUSH en une seule commande : les descripteurs déjà présents dans la file restent
    // devant, donc plusieurs donnes sont rapidement fan-out avant que les samples arrivent.
    await redisCommand(['RPUSH', PRIORITY_QUEUE_KEY, ...tasks]);
    return tasks.length;
}

async function processDdTask(jobKey, workerId) {
    const job = await getJob(jobKey);
    if (!job) return false;
    if (job.ddTable && typeof job.ddTable === 'object') return true;
    if (!await acquireClaim(jobKey, 'dd')) {
        await redisCommand(['RPUSH', PRIORITY_QUEUE_KEY, taskToken(jobKey, 'dd')]);
        return false;
    }
    try {
        const hands = normalizeHands(job.hands);
        if (!hands) throw new Error('priority-job-invalide');
        const started = Date.now();
        const ddTable = solveTableForHands(hands);
        const latest = await patchJob(jobKey, { ddTable, workerId, ddMs: Date.now() - started, status: 'processing' });
        if (latest && Number(latest.sampleCount || 0) >= SAMPLE_COUNT) {
            await patchJob(jobKey, { status: 'done', completedAt: new Date().toISOString() });
        }
        parentPort && parentPort.postMessage({ type: 'dd', id: job.statisticalSeedId || '', ms: Date.now() - started });
        return true;
    } catch (err) {
        await patchJob(jobKey, { status: 'error', error: String(err && err.message || err).slice(0, 500), workerId });
        parentPort && parentPort.postMessage({ type: 'error', id: job.statisticalSeedId || '', error: String(err && err.message || err) });
        return false;
    } finally {
        await releaseClaim(jobKey, 'dd');
    }
}

async function loadCheckpointRows(jobKey, count) {
    const fields = Array.from({ length: count }, (_, i) => String(i));
    const result = await redisCommand(['HMGET', samplesKey(jobKey), ...fields]);
    if (!Array.isArray(result) || result.length !== count || result.some(x => !x)) return null;
    const rows = [];
    for (let i = 0; i < result.length; i++) {
        let parsed;
        try { parsed = JSON.parse(result[i]); } catch (_) { return null; }
        if (!parsed || !parsed.NS || !parsed.EW) return null;
        rows.push({ sampleIndex: i, NS: parsed.NS, EW: parsed.EW });
    }
    return rows;
}

async function tryPublishCheckpoints(jobKey, jobHint, workerId) {
    let published = 0;
    for (const count of CHECKPOINTS) {
        const lock = await redisCommand(['SET', checkpointKey(jobKey, count), workerId, 'NX', 'EX', '90']);
        if (String(lock || '').toUpperCase() !== 'OK') continue;
        const rows = await loadCheckpointRows(jobKey, count);
        if (!rows) {
            // Pas encore complet : rendre le lock immédiatement pour que le prochain sample
            // puisse retenter, au lieu d'attendre 90 s.
            await redisCommand(['DEL', checkpointKey(jobKey, count)]);
            continue;
        }
        const job = await getJob(jobKey);
        if (!job) continue;
        ensureDds();
        const precomputedStatV1 = {
            format: 'universal-dd-72',
            statisticalSeedId: String(job.statisticalSeedId || ''),
            samplingSeedVersion: StatisticalPar.STATISTICAL_PAR_SAMPLING_SEED_VERSION,
            sampleCount: count,
            sides: {
                NS: rows.map(row => ({ sampleIndex: row.sampleIndex, table: row.NS })),
                EW: rows.map(row => ({ sampleIndex: row.sampleIndex, table: row.EW }))
            }
        };
        const startedAtMs = Number(job.startedAtMs || job.createdAtMs || Date.now());
        const done = count >= SAMPLE_COUNT && !!job.ddTable;
        await patchJob(jobKey, {
            sampleCount: count,
            precomputedStatV1,
            precomputeMs: Math.max(0, Date.now() - startedAtMs),
            status: done ? 'done' : 'processing',
            ...(done ? { completedAt: new Date().toISOString() } : {})
        });
        published = Math.max(published, count);
        parentPort && parentPort.postMessage({ type: 'progress', id: job.statisticalSeedId || (jobHint && jobHint.statisticalSeedId) || '', sampleCount: count, status: done ? 'done' : 'processing', ms: Math.max(0, Date.now() - startedAtMs) });
    }
    return published;
}

async function processSampleTask(jobKey, sampleIndex, workerId) {
    if (!Number.isInteger(sampleIndex) || sampleIndex < 0 || sampleIndex >= SAMPLE_COUNT) return false;
    const existing = await redisCommand(['HGET', samplesKey(jobKey), String(sampleIndex)]);
    if (existing) {
        await tryPublishCheckpoints(jobKey, null, workerId);
        return true;
    }
    const suffix = `s${sampleIndex}`;
    if (!await acquireClaim(jobKey, suffix)) {
        await redisCommand(['RPUSH', PRIORITY_QUEUE_KEY, taskToken(jobKey, 'sample', sampleIndex)]);
        return false;
    }
    try {
        const job = await getJob(jobKey);
        if (!job) return false;
        const hands = normalizeHands(job.hands);
        const statisticalSeedId = String(job.statisticalSeedId || '').trim();
        if (!hands || !statisticalSeedId) throw new Error('priority-job-invalide');
        ensureDds();
        const deal = { hands, statisticalSeedId };
        const started = Date.now();
        const nsHands = StatisticalPar.sampleHandsDeterministic(deal, configForSide('NS'), sampleIndex);
        const nsTable = solveTableForHands(nsHands);
        const ewHands = StatisticalPar.sampleHandsDeterministic(deal, configForSide('EW'), sampleIndex);
        const ewTable = solveTableForHands(ewHands);
        await redisCommand(['HSET', samplesKey(jobKey), String(sampleIndex), JSON.stringify({ NS: nsTable, EW: ewTable, ms: Date.now() - started })]);
        await redisCommand(['EXPIRE', samplesKey(jobKey), String(PRIORITY_JOB_TTL_SECONDS)]);
        await tryPublishCheckpoints(jobKey, job, workerId);
        return true;
    } catch (err) {
        parentPort && parentPort.postMessage({ type: 'error', id: '', error: `sample ${sampleIndex}: ${String(err && err.message || err)}` });
        // Le sample reste récupérable : on le remet dans la file après libération du claim.
        await redisCommand(['RPUSH', PRIORITY_QUEUE_KEY, taskToken(jobKey, 'sample', sampleIndex)]);
        return false;
    } finally {
        await releaseClaim(jobKey, suffix);
    }
}

async function workerLoop(workerId) {
    let processed = 0;
    let emptyCount = 0;
    while (processed < PRIORITY_MAX_TASKS_PER_WORKER) {
        const token = await redisCommand(['LPOP', PRIORITY_QUEUE_KEY]);
        if (!token) {
            emptyCount++;
            if (emptyCount >= EMPTY_RETRIES) break;
            await sleep(EMPTY_RETRY_MS);
            continue;
        }
        emptyCount = 0;
        const task = parseTaskToken(token);
        try {
            if (task.kind === 'descriptor') {
                const count = await fanoutDescriptor(task.jobKey, workerId);
                processed++;
                parentPort && parentPort.postMessage({ type: 'fanout', count, jobKey: task.jobKey });
            } else if (task.kind === 'dd') {
                await processDdTask(task.jobKey, workerId); processed++;
            } else if (task.kind === 'sample') {
                await processSampleTask(task.jobKey, task.sampleIndex, workerId); processed++;
            }
        } catch (err) {
            parentPort && parentPort.postMessage({ type: 'error', id: '', error: String(err && err.stack || err) });
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
                console.log(`[priority-sharded] ${message.id} -> ${message.sampleCount}/72 (${message.status}, ${message.ms} ms)`);
            } else if (message.type === 'dd') {
                console.log(`[priority-sharded] ${message.id} -> DD exact (${message.ms} ms)`);
            } else if (message.type === 'fanout' && message.count) {
                console.log(`[priority-sharded] fanout ${message.count} tâches`);
            } else if (message.type === 'error') {
                console.error(`[priority-sharded] ECHEC: ${message.error}`);
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
    console.log(`[priority-sharded] file drainée sur ce runner — tâches traitées=${total}`);
}

if (isMainThread) {
    mainThread().catch(err => {
        console.error('[priority-sharded] ECHEC:', err && err.stack || err);
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
