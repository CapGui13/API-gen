// api/reserve-code.js — allocation légère d'un code de salle pour l'écran « Créer ».
//
// Cette route existe séparément de /api/session pour une raison de performance :
// /api/session trace aussi toute la pile PONS serveur (~15 Mo de runtime) afin d'être
// autoritaire sur les enchères robot en relais. Une réservation de code n'a besoin de
// rien de tout cela. La séparer garde le cold-start de création très petit, tout en
// conservant /api/session?action=reserve-code pour les anciens clients.

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ROOM_CODE_RESERVATION_TTL_SECONDS = 120;
const ROOM_CODE_ALLOCATION_ATTEMPTS = 64;
const RESERVE_RATE_WINDOW_SECONDS = 60;
const RESERVE_RATE_PER_CLIENT = 20;
const RESERVE_RATE_GLOBAL = 300;
const ACCESS_KEY_BYTES = 32;

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

function requestHeader(req, name) {
    const raw = req && req.headers && (req.headers[name] || req.headers[name.toLowerCase()]);
    return typeof raw === 'string' ? raw.trim() : '';
}
function isAllowedOrigin(origin) {
    if (!origin) return true;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    if (process.env.VERCEL_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    return false;
}
function applyCors(req, res) {
    const origin = req && req.headers && req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Timing-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return isAllowedOrigin(origin);
}
function normalizeCode(code) { return String(code || '').toUpperCase().trim(); }
function keyFor(code) { return `bridge-session:${normalizeCode(code)}`; }
function reservationKeyFor(code) { return `bridge-room-reservation:${normalizeCode(code)}`; }
function accessKeyFor(code) { return `bridge-session-access:${normalizeCode(code)}`; }
function writeReservationKeyFor(code) { return `bridge-room-write-reservation:${normalizeCode(code)}`; }
function hostWriteKeyFor(code) { return `bridge-session-host-write:${normalizeCode(code)}`; }
function reserveRateSubject(req) {
    const forwarded = requestHeader(req, 'x-forwarded-for');
    const realIp = requestHeader(req, 'x-real-ip');
    const ip = String((forwarded && forwarded.split(',')[0]) || realIp || 'unknown').trim().slice(0, 128);
    const origin = String((req && req.headers && req.headers.origin) || 'no-origin').trim().slice(0, 256);
    return crypto.createHash('sha256').update(`${ip}|${origin}`, 'utf8').digest('hex').slice(0, 32);
}
function reserveRateKeyFor(req) { return `bridge-reserve-rate:${reserveRateSubject(req)}`; }
function reserveGlobalRateKey() { return 'bridge-reserve-rate:global'; }
function generateAccessKey() { return crypto.randomBytes(ACCESS_KEY_BYTES).toString('base64url'); }

async function redisCommand(command) {
    const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error || `Upstash HTTP ${resp.status}`);
    return data.result;
}

// Cas normal = UNE seule commande Upstash : rate-limit + test d'occupation + réservation.
// L'ancien /api/session faisait ces deux étapes dans deux aller-retours Redis successifs.
const RATE_AND_RESERVE_LUA = `
local clientCount = redis.call('INCR', KEYS[1])
if clientCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if clientCount > tonumber(ARGV[2]) then return {-1, clientCount, 0} end
local globalCount = redis.call('INCR', KEYS[2])
if globalCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
if globalCount > tonumber(ARGV[3]) then return {-2, clientCount, globalCount} end
for i=3,7 do if redis.call('EXISTS', KEYS[i]) == 1 then return {0, clientCount, globalCount} end end
redis.call('SET', KEYS[4], ARGV[4], 'EX', ARGV[6])
redis.call('SET', KEYS[6], ARGV[5], 'EX', ARGV[6])
return {1, clientCount, globalCount}
`;

const ROOM_CODE_RESERVE_LUA = `
for i=1,5 do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[4], ARGV[2], 'EX', ARGV[3])
return 1
`;

function candidate() {
    return {
        code: String(crypto.randomInt(0, 10000)).padStart(4, '0'),
        accessKey: generateAccessKey(),
        hostWriteKey: generateAccessKey()
    };
}
function reservationKeys(code) {
    return [keyFor(code), reservationKeyFor(code), accessKeyFor(code), writeReservationKeyFor(code), hostWriteKeyFor(code)];
}

async function reserveWithRateLimit(req) {
    let c = candidate();
    const first = await redisCommand([
        'EVAL', RATE_AND_RESERVE_LUA, '7',
        reserveRateKeyFor(req), reserveGlobalRateKey(), ...reservationKeys(c.code),
        String(RESERVE_RATE_WINDOW_SECONDS), String(RESERVE_RATE_PER_CLIENT), String(RESERVE_RATE_GLOBAL),
        c.accessKey, c.hostWriteKey, String(ROOM_CODE_RESERVATION_TTL_SECONDS)
    ]);
    const status = Array.isArray(first) ? Number(first[0]) : Number(first);
    if (status === -1 || status === -2) {
        return { rateLimited: true, reason: status === -1 ? 'client' : 'global' };
    }
    if (status === 1) return { ...c, rateLimited: false };

    // Collision du tout premier code : le rate-limit a déjà été compté une seule fois.
    // Les tentatives suivantes ne ré-incrémentent donc pas le compteur.
    for (let i = 1; i < ROOM_CODE_ALLOCATION_ATTEMPTS; i++) {
        c = candidate();
        const result = await redisCommand([
            'EVAL', ROOM_CODE_RESERVE_LUA, '5', ...reservationKeys(c.code),
            c.accessKey, c.hostWriteKey, String(ROOM_CODE_RESERVATION_TTL_SECONDS)
        ]);
        if (Number(result) === 1) return { ...c, rateLimited: false };
    }
    throw new Error('Impossible de réserver un code de salle libre après plusieurs tentatives.');
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
        res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN manquantes côté serveur.' });
        return;
    }

    try {
        const startedAt = Date.now();
        const reserved = await reserveWithRateLimit(req);
        res.setHeader('Server-Timing', `reserve;dur=${Math.max(0, Date.now() - startedAt)}`);
        if (reserved.rateLimited) {
            res.setHeader('Retry-After', String(RESERVE_RATE_WINDOW_SECONDS));
            res.status(429).json({
                error: 'reserve-code-rate-limited',
                scope: reserved.reason,
                retryAfterSeconds: RESERVE_RATE_WINDOW_SECONDS
            });
            return;
        }
        res.status(201).json({
            code: reserved.code,
            accessKey: reserved.accessKey,
            hostWriteKey: reserved.hostWriteKey,
            reservationTtlSeconds: ROOM_CODE_RESERVATION_TTL_SECONDS
        });
    } catch (e) {
        res.status(503).json({ error: String((e && e.message) || e) });
    }
};
