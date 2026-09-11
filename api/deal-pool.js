// api/deal-pool.js — PLAY Deal Pool V3.
//
// V3 sépare le calcul lourd du service en production :
// - GitHub Actions fabrique des donnes complètement pré-calculées et les range dans Upstash.
// - Vercel ne fait ici que filtrer/consommer atomiquement le stock et répondre à PLAY.
//
// Une donne V3 READY contient :
// - les 52 cartes ;
// - la table double-mort exacte ;
// - 72 redistributions statistiques brutes + tables DD pour NS ;
// - 72 redistributions statistiques brutes + tables DD pour EW.
//
// Le PAR conditionné par l'enchère PONS reste volontairement calculé côté PLAY, car son
// échantillon dépend d'une enchère qui n'existe pas encore au moment du pré-calcul.

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const POOL_VERSION = 'play-deal-pool-v3-precomputed72';
const DATA_KEY = 'bridge-deal-pool:v3:data';
const READY_KEY = 'bridge-deal-pool:v3:ready';
const TAKE_MAX_COUNT = 40;
const TAKE_SCAN_CAP = 4000;

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];

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
    const lightweight = action === 'replenish' || action === 'status';
    const clientLimit = lightweight ? 120 : 120;
    const globalLimit = lightweight ? 3000 : 3000;
    return Number(await redisCommand([
        'EVAL', RATE_LUA, '2',
        `bridge-deal-pool-rate:v3:${action}:client:${rateSubject(req)}`,
        `bridge-deal-pool-rate:v3:${action}:global`,
        '60', String(clientLimit), String(globalLimit), String(cost)
    ]));
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
    const scanCap = Math.min(TAKE_SCAN_CAP, Math.max(120, Number(count) * 80));
    const result = await redisCommand([
        'EVAL', TAKE_LUA, '2', DATA_KEY, READY_KEY,
        String(count), String(scanCap),
        JSON.stringify(seatAssignment || {}),
        JSON.stringify(constraints || {})
    ]);
    if (!Array.isArray(result) || result.length !== count) return [];
    return result.map(raw => JSON.parse(raw));
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

async function stockStatus() {
    const ready = Number(await redisCommand(['LLEN', READY_KEY]) || 0);
    const records = Number(await redisCommand(['HLEN', DATA_KEY]) || 0);
    return { poolVersion: POOL_VERSION, ready, records, maintenance: 'github-actions' };
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
    if (!['take', 'replenish', 'status'].includes(action)) {
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

        // Compatibilité avec le PLAY déjà déployé : il appelle replenish après un take.
        // En V3, ce POST est volontairement léger ; le remplissage lourd est fait par
        // GitHub Actions et non par Vercel.
        if (action === 'replenish' || action === 'status') {
            res.status(200).json({ ok: true, ...(await stockStatus()) });
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
            // Stock/contraintes insuffisants : PLAY bascule immédiatement sur son générateur
            // local historique, sans consommation partielle du stock.
            res.status(204).end();
            return;
        }
        res.status(200).json({ poolVersion: POOL_VERSION, deals });
    } catch (err) {
        res.status(503).json({ error: (err && err.message) || String(err) });
    }
};
