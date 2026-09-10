// api/deal-pool.js — réservoir caché de donnes aléatoires pré-calculées pour PLAY.
//
// V1 : chaque donne READY contient déjà sa table double-mort exacte.
// V2 : en tâche de réapprovisionnement, certaines donnes sont enrichies avec 24 tables
//      statistiques brutes pour chaque camp (NS / EW). Ces tables sont indépendantes du
//      numéro de board, du donneur et de la vulnérabilité ; le frontend n'en extrait que
//      les cellules nécessaires au PAR statistique.
//
// Stockage : réutilise l'Upstash Redis déjà configuré pour API-gen.
// Aucun secret ni contenu du stock n'est exposé : POST action=take ne renvoie que le lot
// effectivement consommé par la session.

const crypto = require('crypto');
const StatisticalPar = require('../lib/pool-statistical-sampler');

global.Module = global.Module || {};
require('./dds-lib.js');
const calcDDTable = global.Module.cwrap('generateDDTable', 'string', ['string']);

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const POOL_VERSION = 'play-deal-pool-v2';
const DATA_KEY = 'bridge-deal-pool:v2:data';
const READY_KEY = 'bridge-deal-pool:v2:ready';
const V2_QUEUE_KEY = 'bridge-deal-pool:v2:needs-stat';
const REFILL_LOCK_KEY = 'bridge-deal-pool:v2:refill-lock';

const POOL_TARGET = clampInt(process.env.BRIDGE_DEAL_POOL_TARGET, 240, 40, 4000);
const POOL_LOW_WATER = clampInt(process.env.BRIDGE_DEAL_POOL_LOW_WATER, 160, 0, POOL_TARGET);
const REFILL_BATCH = clampInt(process.env.BRIDGE_DEAL_POOL_REFILL_BATCH, 24, 1, 80);
const V2_PER_REFILL = clampInt(process.env.BRIDGE_DEAL_POOL_V2_PER_REFILL, 1, 0, 3);
const V2_SAMPLE_COUNT = 24;
const TAKE_MAX_COUNT = 40;
const TAKE_SCAN_CAP = 2000;
const REFILL_LOCK_SECONDS = 180;

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = 'AKQJT98765432';
const HCP = { A: 4, K: 3, Q: 2, J: 1 };

function clampInt(raw, fallback, min, max) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    if (process.env.VERCEL_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    return false;
}

function applyCors(req, res) {
    const origin = req && req.headers && req.headers.origin;
    if (origin && isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return isAllowedOrigin(origin);
}

async function redisCommand(command) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('deal-pool-storage-unavailable');
    const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error || `Upstash HTTP ${resp.status}`);
    return data.result;
}

function requestHeader(req, name) {
    const raw = req && req.headers && (req.headers[name] || req.headers[name.toLowerCase()]);
    return typeof raw === 'string' ? raw.trim() : '';
}

function rateSubject(req) {
    const forwarded = requestHeader(req, 'x-forwarded-for');
    const realIp = requestHeader(req, 'x-real-ip');
    const ip = String((forwarded && forwarded.split(',')[0]) || realIp || 'unknown').trim().slice(0, 128);
    return crypto.createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 32);
}

const RATE_LUA = `
local cost = tonumber(ARGV[4])
local clientCount = redis.call('INCRBY', KEYS[1], cost)
if clientCount == cost then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if clientCount > tonumber(ARGV[2]) then return -1 end
local globalCount = redis.call('INCRBY', KEYS[2], cost)
if globalCount == cost then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
if globalCount > tonumber(ARGV[3]) then return -2 end
return 1
`;

async function applyRateLimit(req, action, cost = 1) {
    const replenish = action === 'replenish';
    const clientLimit = replenish ? 8 : 120;
    const globalLimit = replenish ? 80 : 3000;
    return Number(await redisCommand([
        'EVAL', RATE_LUA, '2',
        `bridge-deal-pool-rate:${action}:client:${rateSubject(req)}`,
        `bridge-deal-pool-rate:${action}:global`,
        '60', String(clientLimit), String(globalLimit), String(cost)
    ]));
}

function shuffledDeck() {
    const deck = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function dealFromDeck(deck) {
    const hands = {};
    for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
        const seat = SEATS[seatIndex];
        const cards = deck.slice(seatIndex * 13, seatIndex * 13 + 13);
        hands[seat] = {};
        for (const suit of SUITS) {
            const rankSet = new Set(cards.filter(card => card.suit === suit).map(card => card.rank));
            hands[seat][suit] = Array.from(RANKS).filter(rank => rankSet.has(rank)).join('');
        }
    }
    return hands;
}

function handHcp(hand) {
    let total = 0;
    for (const suit of SUITS) for (const rank of String(hand && hand[suit] || '')) total += HCP[rank] || 0;
    return total;
}

function metadataForHands(hands) {
    const hcp = {};
    const lengths = {};
    for (const seat of SEATS) {
        hcp[seat] = handHcp(hands[seat]);
        lengths[seat] = {};
        for (const suit of SUITS) lengths[seat][suit] = String(hands[seat][suit] || '').length;
    }
    return {
        hcp,
        lineHcp: { NS: hcp.N + hcp.S, EW: hcp.E + hcp.W },
        lengths
    };
}

function handsToPbn(hands) {
    return 'N:' + SEATS.map(seat => SUITS.map(suit => String(hands[seat][suit] || '')).join('.')).join(' ');
}

function solveTableForHands(hands) {
    const raw = calcDDTable(handsToPbn(hands));
    const table = JSON.parse(raw);
    if (!table || typeof table !== 'object') throw new Error('DDS table invalide');
    return table;
}

function newPoolRecord() {
    const hands = dealFromDeck(shuffledDeck());
    const statisticalSeedId = 'pool_' + crypto.randomBytes(18).toString('base64url');
    return {
        poolVersion: POOL_VERSION,
        statisticalSeedId,
        hands,
        ddTable: solveTableForHands(hands),
        meta: metadataForHands(hands),
        precomputedStatV1: null,
        createdAt: new Date().toISOString()
    };
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

function enrichRecordV2(record) {
    if (!record || !record.hands || !record.statisticalSeedId) return record;
    if (record.precomputedStatV1
        && record.precomputedStatV1.samplingSeedVersion === StatisticalPar.STATISTICAL_PAR_SAMPLING_SEED_VERSION) return record;

    // dealer/vulnerable/board sont volontairement absents : pour une donne du pool,
    // deterministicSeedMaterial utilise statisticalSeedId et ne dépend plus de ces champs.
    const deal = { hands: record.hands, statisticalSeedId: record.statisticalSeedId };
    const sides = { NS: [], EW: [] };
    for (const side of ['NS', 'EW']) {
        const config = configForSide(side);
        for (let sampleIndex = 0; sampleIndex < V2_SAMPLE_COUNT; sampleIndex++) {
            const sampleHands = StatisticalPar.sampleHandsDeterministic(deal, config, sampleIndex);
            sides[side].push({ sampleIndex, table: solveTableForHands(sampleHands) });
        }
    }
    record.precomputedStatV1 = {
        format: 'universal-dd-24',
        statisticalSeedId: record.statisticalSeedId,
        samplingSeedVersion: StatisticalPar.STATISTICAL_PAR_SAMPLING_SEED_VERSION,
        sampleCount: V2_SAMPLE_COUNT,
        sides
    };
    record.statEnrichedAt = new Date().toISOString();
    return record;
}

async function addFreshRecords(count) {
    const n = Math.max(0, Number(count || 0));
    if (!n) return 0;
    const pairs = [];
    const ids = [];
    for (let i = 0; i < n; i++) {
        const id = 'd_' + crypto.randomBytes(15).toString('base64url');
        const record = newPoolRecord();
        pairs.push(id, JSON.stringify(record));
        ids.push(id);
    }
    if (!ids.length) return 0;
    await redisCommand(['HSET', DATA_KEY, ...pairs]);
    await redisCommand(['RPUSH', READY_KEY, ...ids]);
    await redisCommand(['RPUSH', V2_QUEUE_KEY, ...ids]);
    return ids.length;
}

async function enrichNextRecordV2() {
    for (let attempt = 0; attempt < 8; attempt++) {
        const id = await redisCommand(['LPOP', V2_QUEUE_KEY]);
        if (!id) return false;
        const raw = await redisCommand(['HGET', DATA_KEY, id]);
        if (!raw) continue; // déjà consommée avant l'enrichissement
        try {
            const record = enrichRecordV2(JSON.parse(raw));
            await redisCommand(['HSET', DATA_KEY, id, JSON.stringify(record)]);
            return true;
        } catch (err) {
            // Une panne DDS ponctuelle ne condamne pas la donne : elle retourne en fin de
            // file pour une future tentative, tout en restant utilisable immédiatement V1.
            await redisCommand(['RPUSH', V2_QUEUE_KEY, id]);
            throw err;
        }
    }
    return false;
}

const TAKE_LUA = `
local dataKey = KEYS[1]
local readyKey = KEYS[2]
local wanted = tonumber(ARGV[1])
local scanCap = tonumber(ARGV[2])
local seatAssignment = cjson.decode(ARGV[3])
local constraints = cjson.decode(ARGV[4])
local initialLen = tonumber(redis.call('LLEN', readyKey))
local scanLimit = math.min(initialLen, scanCap)
local acceptedIds = {}
local acceptedRaw = {}

local function bothHuman(a, b)
  return seatAssignment[a] == true and seatAssignment[b] == true
end

local function matches(rec)
  local meta = rec['meta'] or {}
  local hcp = meta['hcp'] or {}
  local lengths = meta['lengths'] or {}
  local lineHcp = meta['lineHcp'] or {}

  if bothHuman('N','S') and tonumber(hcp['N'] or 0) < 12 and tonumber(hcp['S'] or 0) < 12 then return false end
  if bothHuman('E','W') and tonumber(hcp['E'] or 0) < 12 and tonumber(hcp['W'] or 0) < 12 then return false end

  local seats = constraints['seats'] or {}
  for _, seat in ipairs({'N','E','S','W'}) do
    local c = seats[seat]
    if c then
      local points = tonumber(hcp[seat] or 0)
      if c['hcpMin'] ~= nil and points < tonumber(c['hcpMin']) then return false end
      if c['hcpMax'] ~= nil and points > tonumber(c['hcpMax']) then return false end
      if c['suit'] ~= nil and c['suitMinLength'] ~= nil then
        local seatLengths = lengths[seat] or {}
        if tonumber(seatLengths[tostring(c['suit'])] or 0) < tonumber(c['suitMinLength']) then return false end
      end
    end
  end

  local lines = constraints['lines'] or {}
  for _, line in ipairs({'NS','EW'}) do
    local c = lines[line]
    if c then
      local points = tonumber(lineHcp[line] or 0)
      if c['hcpMin'] ~= nil and points < tonumber(c['hcpMin']) then return false end
      if c['hcpMax'] ~= nil and points > tonumber(c['hcpMax']) then return false end
    end
  end
  return true
end

for i = 1, scanLimit do
  if #acceptedIds >= wanted then break end
  local id = redis.call('LPOP', readyKey)
  if not id then break end
  local raw = redis.call('HGET', dataKey, id)
  if raw then
    local ok, rec = pcall(cjson.decode, raw)
    if ok and matches(rec) then
      table.insert(acceptedIds, id)
      table.insert(acceptedRaw, raw)
    else
      redis.call('RPUSH', readyKey, id)
    end
  end
end

if #acceptedIds < wanted then
  for _, id in ipairs(acceptedIds) do redis.call('RPUSH', readyKey, id) end
  return {}
end
for _, id in ipairs(acceptedIds) do redis.call('HDEL', dataKey, id) end
return acceptedRaw
`;

async function takeDeals(count, seatAssignment, constraints) {
    const scanCap = Math.min(TAKE_SCAN_CAP, Math.max(80, Number(count) * 50));
    const result = await redisCommand([
        'EVAL', TAKE_LUA, '2', DATA_KEY, READY_KEY,
        String(count), String(scanCap),
        JSON.stringify(seatAssignment || {}),
        JSON.stringify(constraints || {})
    ]);
    if (!Array.isArray(result) || result.length !== count) return [];
    return result.map(raw => JSON.parse(raw));
}

async function withRefillLock(fn) {
    const token = crypto.randomBytes(16).toString('hex');
    const acquired = await redisCommand(['SET', REFILL_LOCK_KEY, token, 'NX', 'EX', String(REFILL_LOCK_SECONDS)]);
    if (acquired !== 'OK') return { locked: true };
    try {
        return await fn();
    } finally {
        const releaseLua = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
        await redisCommand(['EVAL', releaseLua, '1', REFILL_LOCK_KEY, token]).catch(() => {});
    }
}

async function replenishPool() {
    return withRefillLock(async () => {
        const before = Number(await redisCommand(['LLEN', READY_KEY]) || 0);
        let added = 0;
        if (before < POOL_LOW_WATER || before < POOL_TARGET) {
            added = await addFreshRecords(Math.min(REFILL_BATCH, Math.max(0, POOL_TARGET - before)));
        }
        let enriched = 0;
        for (let i = 0; i < V2_PER_REFILL; i++) {
            if (await enrichNextRecordV2()) enriched++;
            else break;
        }
        const after = Number(await redisCommand(['LLEN', READY_KEY]) || 0);
        return { locked: false, before, after, added, enriched };
    });
}

function validCount(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= TAKE_MAX_COUNT ? n : 0;
}

function sanitizeSeatAssignment(raw) {
    const out = {};
    for (const seat of SEATS) out[seat] = !!(raw && raw[seat]);
    return out;
}

function sanitizeConstraints(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = { seats: {}, lines: {} };
    for (const seat of SEATS) {
        const c = raw.seats && raw.seats[seat];
        if (!c || typeof c !== 'object') continue;
        const clean = {};
        for (const key of ['hcpMin', 'hcpMax', 'suitMinLength']) {
            if (c[key] != null && Number.isFinite(Number(c[key]))) clean[key] = Number(c[key]);
        }
        if (SUITS.includes(String(c.suit || '').toUpperCase())) clean.suit = String(c.suit).toUpperCase();
        if (Object.keys(clean).length) out.seats[seat] = clean;
    }
    for (const line of ['NS', 'EW']) {
        const c = raw.lines && raw.lines[line];
        if (!c || typeof c !== 'object') continue;
        const clean = {};
        for (const key of ['hcpMin', 'hcpMax']) {
            if (c[key] != null && Number.isFinite(Number(c[key]))) clean[key] = Number(c[key]);
        }
        if (Object.keys(clean).length) out.lines[line] = clean;
    }
    return out;
}

module.exports = async function handler(req, res) {
    if (!applyCors(req, res)) {
        res.status(403).json({ error: 'origin-forbidden' });
        return;
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS');
        res.status(405).json({ error: 'method-not-allowed' });
        return;
    }
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        res.status(503).json({ error: 'deal-pool-storage-unavailable' });
        return;
    }

    const action = String(req.body && req.body.action || 'take').toLowerCase();
    if (action !== 'take' && action !== 'replenish') {
        res.status(400).json({ error: 'action-invalid' });
        return;
    }

    try {
        const rate = await applyRateLimit(req, action, 1);
        if (rate < 0) {
            res.setHeader('Retry-After', '60');
            res.status(429).json({ error: 'deal-pool-rate-limited' });
            return;
        }

        if (action === 'replenish') {
            const result = await replenishPool();
            res.status(result && result.locked ? 202 : 200).json({ ok: true, ...result });
            return;
        }

        const count = validCount(req.body && req.body.count);
        if (!count) {
            res.status(400).json({ error: `count doit être compris entre 1 et ${TAKE_MAX_COUNT}` });
            return;
        }
        const deals = await takeDeals(
            count,
            sanitizeSeatAssignment(req.body && req.body.seatAssignment),
            sanitizeConstraints(req.body && req.body.constraints)
        );
        if (deals.length !== count) {
            // Le frontend comprend 204 comme « stock insuffisant » et reprend immédiatement
            // sa génération locale historique. Rien n'est partiellement consommé côté Redis.
            res.status(204).end();
            return;
        }
        res.status(200).json({ poolVersion: POOL_VERSION, deals });
    } catch (err) {
        res.status(503).json({ error: (err && err.message) || String(err) });
    }
};
