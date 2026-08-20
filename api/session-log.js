// api/session-log.js — Journal de diagnostic partagé et authentifié par la même clé de
// capacité que /api/session. Un simple code 4 chiffres ne permet plus de lire/écrire le
// journal d'une salle.

const crypto = require('crypto');
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL_SECONDS = 60 * 60 * 24 * 3;
const MAX_LOG_ENTRIES = 800;
const MAX_LOG_BATCH_BYTES = 512 * 1024;
const ACCESS_KEY_HEADER = 'x-bridge-session-key';

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

function keyFor(code) { return `bridge-debuglog:${String(code || '').toUpperCase().trim()}`; }
function accessKeyFor(code) { return `bridge-session-access:${String(code || '').toUpperCase().trim()}`; }
function reservationKeyFor(code) { return `bridge-room-reservation:${String(code || '').toUpperCase().trim()}`; }
function normalizeCode(code) { return String(code || '').toUpperCase().trim(); }
function safeTextEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aa = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requestAccessKey(req) {
    const raw = req && req.headers && req.headers[ACCESS_KEY_HEADER];
    return typeof raw === 'string' ? raw.trim() : '';
}
function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    return process.env.VERCEL_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function applyCors(req, res) {
    const origin = req && req.headers && req.headers.origin;
    if (origin && isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Session-Key');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return isAllowedOrigin(origin);
}
async function redisCommand(command) {
    const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error || `Upstash HTTP ${resp.status}`);
    return data.result;
}
async function authorize(req, res, code) {
    const provided = requestAccessKey(req);
    if (!provided) { res.status(401).json({ error: 'session-auth-required' }); return false; }
    let stored = await redisCommand(['GET', accessKeyFor(code)]);
    if (!stored) stored = await redisCommand(['GET', reservationKeyFor(code)]);
    if (!stored || !safeTextEqual(String(stored), provided)) {
        res.status(403).json({ error: 'session-auth-invalid' });
        return false;
    }
    return true;
}

const APPEND_LOG_LUA = `
local raw = redis.call('GET', KEYS[1])
local entries = {}
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' then return {-1, raw} end
  entries = decoded
end
local okIncoming, incoming = pcall(cjson.decode, ARGV[1])
if not okIncoming or type(incoming) ~= 'table' then return {-2, ''} end
for i = 1, #incoming do entries[#entries + 1] = incoming[i] end
local maxEntries = tonumber(ARGV[2])
if #entries > maxEntries then
  local trimmed = {}
  local startIndex = #entries - maxEntries + 1
  for i = startIndex, #entries do trimmed[#trimmed + 1] = entries[i] end
  entries = trimmed
end
local encoded = cjson.encode(entries)
redis.call('SET', KEYS[1], encoded, 'EX', ARGV[3])
return {#entries, encoded}
`;
async function atomicAppendLog(code, newEntries) {
    const result = await redisCommand([
        'EVAL', APPEND_LOG_LUA, '1', keyFor(code),
        JSON.stringify(newEntries), String(MAX_LOG_ENTRIES), String(TTL_SECONDS)
    ]);
    if (!Array.isArray(result) || result.length === 0) throw new Error('Réponse Redis journal invalide.');
    const count = Number(result[0]);
    if (count === -1) throw new Error('Journal Redis corrompu : JSON existant illisible.');
    if (count === -2) throw new Error('Journal entrant invalide.');
    if (!Number.isInteger(count) || count < 0) throw new Error(`Compteur journal Redis invalide: ${result[0]}`);
    return count;
}

module.exports = async (req, res) => {
    if (!applyCors(req, res)) { res.status(403).json({ error: 'origin-not-allowed' }); return; }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN manquantes côté serveur.' });
        return;
    }
    const code = normalizeCode(req.query && req.query.code);
    if (!code || !/^[A-Za-z0-9]{3,12}$/.test(code)) {
        res.status(400).json({ error: 'Paramètre "code" manquant ou invalide.' });
        return;
    }
    try {
        if (!await authorize(req, res, code)) return;
    } catch (e) {
        res.status(500).json({ error: String((e && e.message) || e) });
        return;
    }

    if (req.method === 'GET') {
        try {
            const raw = await redisCommand(['GET', keyFor(code)]);
            const entries = raw ? JSON.parse(raw) : [];
            res.status(200).json({ entries });
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }
    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        const newEntries = Array.isArray(body && body.entries) ? body.entries : [];
        if (newEntries.length === 0) { res.status(200).json({ ok: true, count: 0 }); return; }
        if (newEntries.length > MAX_LOG_ENTRIES) {
            res.status(413).json({ error: 'too-many-log-entries', maxEntries: MAX_LOG_ENTRIES }); return;
        }
        const batchBytes = Buffer.byteLength(JSON.stringify(newEntries), 'utf8');
        if (batchBytes > MAX_LOG_BATCH_BYTES) {
            res.status(413).json({ error: 'log-batch-too-large', maxBytes: MAX_LOG_BATCH_BYTES, actualBytes: batchBytes }); return;
        }
        try {
            const count = await atomicAppendLog(code, newEntries);
            res.status(200).json({ ok: true, count });
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }
    res.status(405).json({ error: 'Méthode non supportée.' });
};
