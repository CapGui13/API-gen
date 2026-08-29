// api/turn-credentials.js — broker de credentials TURN temporaires pour PLAY.
//
// Les clés maîtres Metered / ExpressTURN restent UNIQUEMENT dans les variables Vercel.
// Le navigateur reçoit des credentials éphémères liés à une salle active. Une salle peut
// vivre des heures/jours : un client qui revient plus tard demande simplement un nouveau
// credential avant de recréer sa connexion WebRTC.
//
// Variables Vercel :
//   METERED_TURN_DOMAIN       ex. "monapp.metered.live"
//   METERED_TURN_SECRET_KEY   Dashboard Metered -> Developers -> Secret Key
// Optionnel (ExpressTURN Premium/shared-secret) :
//   EXPRESSTURN_SHARED_SECRET
//   EXPRESSTURN_URLS          liste séparée par virgules de turn:/turns:
// Optionnel :
//   TURN_CREDENTIAL_TTL_SECONDS (défaut 21600 = 6 h, borné 15 min..24 h)
// Déjà utilisés par API-gen :
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   BRIDGE_ALLOWED_ORIGINS

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const METERED_TURN_DOMAIN = normalizeMeteredDomain(process.env.METERED_TURN_DOMAIN || '');
const METERED_TURN_SECRET_KEY = String(process.env.METERED_TURN_SECRET_KEY || '').trim();
const EXPRESSTURN_SHARED_SECRET = String(process.env.EXPRESSTURN_SHARED_SECRET || '').trim();
const EXPRESSTURN_URLS = String(process.env.EXPRESSTURN_URLS || '')
    .split(',').map(s => s.trim()).filter(url => /^turns?:/i.test(url));
const TURN_TTL_SECONDS = clampInt(process.env.TURN_CREDENTIAL_TTL_SECONDS, 15 * 60, 24 * 60 * 60, 6 * 60 * 60);
const CACHE_REFRESH_SKEW_SECONDS = Math.min(30 * 60, Math.max(60, Math.floor(TURN_TTL_SECONDS / 4)));
const RATE_WINDOW_SECONDS = 60;
const RATE_PER_CLIENT = 30;
const RATE_GLOBAL = 600;

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeMeteredDomain(value) {
    let raw = String(value || '').trim().toLowerCase();
    raw = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return /^[a-z0-9.-]+\.metered\.live$/.test(raw) ? raw : '';
}

function normalizeCode(value) {
    return String(value || '').toUpperCase().trim();
}
function validCode(code) {
    return /^[A-Za-z0-9]{3,12}$/.test(code);
}
function sessionKeyFor(code) { return `bridge-session:${code}`; }
function reservationKeyFor(code) { return `bridge-room-reservation:${code}`; }
function accessKeyFor(code) { return `bridge-session-access:${code}`; }
function turnCacheKeyFor(code) { return `bridge-turn-temp:${code}`; }

function requestHeader(req, name) {
    const raw = req && req.headers && (req.headers[name] || req.headers[name.toLowerCase()]);
    return typeof raw === 'string' ? raw.trim() : '';
}
function rateSubject(req) {
    const forwarded = requestHeader(req, 'x-forwarded-for');
    const realIp = requestHeader(req, 'x-real-ip');
    const ip = String((forwarded && forwarded.split(',')[0]) || realIp || 'unknown').trim().slice(0, 128);
    const origin = String((req && req.headers && req.headers.origin) || 'no-origin').trim().slice(0, 256);
    return crypto.createHash('sha256').update(`${ip}|${origin}`, 'utf8').digest('hex').slice(0, 32);
}
function clientRateKey(req) { return `bridge-turn-rate:${rateSubject(req)}`; }
function globalRateKey() { return 'bridge-turn-rate:global'; }

function isAllowedOrigin(origin) {
    if (!origin) return true; // tests/curl serveur-à-serveur
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
    if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Redis non configuré');
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

async function roomExists(code) {
    const count = Number(await redisCommand(['EXISTS', sessionKeyFor(code), reservationKeyFor(code), accessKeyFor(code)]));
    return count > 0;
}

async function checkRateLimit(req) {
    const clientKey = clientRateKey(req);
    const [clientCount, globalCount] = await Promise.all([
        redisCommand(['INCR', clientKey]),
        redisCommand(['INCR', globalRateKey()])
    ]);
    if (Number(clientCount) === 1) await redisCommand(['EXPIRE', clientKey, RATE_WINDOW_SECONDS]);
    if (Number(globalCount) === 1) await redisCommand(['EXPIRE', globalRateKey(), RATE_WINDOW_SECONDS]);
    return {
        allowed: Number(clientCount) <= RATE_PER_CLIENT && Number(globalCount) <= RATE_GLOBAL,
        retryAfter: RATE_WINDOW_SECONDS
    };
}

function normalizeIceServers(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const urlsRaw = Array.isArray(raw.urls) ? raw.urls : [raw.urls || raw.url];
        const urls = urlsRaw
            .filter(url => typeof url === 'string' && /^(?:stun|turn|turns):/i.test(url.trim()))
            .map(url => url.trim());
        if (!urls.length) continue;
        const isTurn = urls.some(url => /^turns?:/i.test(url));
        const username = typeof raw.username === 'string' ? raw.username.trim() : '';
        const credential = typeof raw.credential === 'string'
            ? raw.credential
            : (typeof raw.password === 'string' ? raw.password : '');
        if (isTurn && (!username || !credential)) continue;
        const key = JSON.stringify([urls, username, credential]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
            urls: urls.length === 1 ? urls[0] : urls,
            ...(username ? { username } : {}),
            ...(credential ? { credential } : {})
        });
    }
    return out;
}

function hasTurn(rows) {
    return rows.some(row => {
        const urls = Array.isArray(row.urls) ? row.urls : [row.urls];
        return urls.some(url => /^turns?:/i.test(String(url || '')));
    });
}

async function createMeteredIce(code) {
    if (!METERED_TURN_DOMAIN || !METERED_TURN_SECRET_KEY) return null;
    const base = `https://${METERED_TURN_DOMAIN}`;
    const label = `play-${code}-${Date.now().toString(36)}`.slice(0, 80);
    const createUrl = `${base}/api/v1/turn/credential?secretKey=${encodeURIComponent(METERED_TURN_SECRET_KEY)}`;
    const createResp = await fetch(createUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiryInSeconds: TURN_TTL_SECONDS, label })
    });
    const created = await createResp.json().catch(() => ({}));
    if (!createResp.ok || !created || typeof created.apiKey !== 'string' || !created.apiKey) {
        throw new Error(`Metered create HTTP ${createResp.status}: ${String(created && created.message || 'réponse invalide').slice(0, 160)}`);
    }
    const getUrl = `${base}/api/v1/turn/credentials?apiKey=${encodeURIComponent(created.apiKey)}`;
    const getResp = await fetch(getUrl, { method: 'GET', cache: 'no-store' });
    const ice = await getResp.json().catch(() => null);
    if (!getResp.ok) throw new Error(`Metered ICE HTTP ${getResp.status}`);
    const rows = normalizeIceServers(ice);
    if (!hasTurn(rows)) throw new Error('Metered n’a renvoyé aucun serveur TURN exploitable');
    return { provider: 'metered', iceServers: rows };
}

function createExpressTurnIce(code) {
    if (!EXPRESSTURN_SHARED_SECRET || !EXPRESSTURN_URLS.length) return null;
    const expiryEpoch = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
    const suffix = crypto.randomBytes(6).toString('hex');
    const username = `${expiryEpoch}:play-${code}-${suffix}`;
    const credential = crypto.createHmac('sha1', EXPRESSTURN_SHARED_SECRET)
        .update(username, 'utf8').digest('base64');
    return {
        provider: 'expressturn',
        iceServers: EXPRESSTURN_URLS.map(url => ({ urls: url, username, credential }))
    };
}

async function loadCached(code) {
    const raw = await redisCommand(['GET', turnCacheKeyFor(code)]);
    if (typeof raw !== 'string' || !raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== 1 || !Number.isFinite(Number(parsed.expiresAt))) return null;
        if (Number(parsed.expiresAt) - Date.now() <= CACHE_REFRESH_SKEW_SECONDS * 1000) return null;
        const rows = normalizeIceServers(parsed.iceServers);
        if (!hasTurn(rows)) return null;
        return { version: 1, expiresAt: Number(parsed.expiresAt), iceServers: rows, providers: Array.isArray(parsed.providers) ? parsed.providers : [] };
    } catch (_) {
        return null;
    }
}

async function saveCached(code, payload) {
    const secondsLeft = Math.max(60, Math.floor((payload.expiresAt - Date.now()) / 1000));
    await redisCommand(['SET', turnCacheKeyFor(code), JSON.stringify(payload), 'EX', secondsLeft]);
}

async function issueTemporaryConfig(code) {
    const providers = [];
    const iceServers = [];
    const errors = [];

    if (METERED_TURN_DOMAIN && METERED_TURN_SECRET_KEY) {
        try {
            const metered = await createMeteredIce(code);
            if (metered) {
                providers.push(metered.provider);
                iceServers.push(...metered.iceServers);
            }
        } catch (err) {
            errors.push(`metered: ${(err && err.message) || String(err)}`);
        }
    }
    try {
        const express = createExpressTurnIce(code);
        if (express) {
            providers.push(express.provider);
            iceServers.push(...express.iceServers);
        }
    } catch (err) {
        errors.push(`expressturn: ${(err && err.message) || String(err)}`);
    }

    const normalized = normalizeIceServers(iceServers);
    if (!hasTurn(normalized)) {
        const configured = !!(METERED_TURN_DOMAIN && METERED_TURN_SECRET_KEY) || !!(EXPRESSTURN_SHARED_SECRET && EXPRESSTURN_URLS.length);
        const err = new Error(configured
            ? `Aucun fournisseur TURN temporaire disponible${errors.length ? ` (${errors.join('; ')})` : ''}`
            : 'Aucun fournisseur TURN temporaire configuré');
        err.statusCode = configured ? 502 : 503;
        throw err;
    }
    return {
        version: 1,
        expiresAt: Date.now() + TURN_TTL_SECONDS * 1000,
        iceServers: normalized,
        providers
    };
}

async function handler(req, res) {
    const originAllowed = applyCors(req, res);
    if (!originAllowed) return res.status(403).json({ error: 'Origin not allowed' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const code = normalizeCode(req.query && req.query.code);
    if (!validCode(code)) return res.status(400).json({ error: 'Invalid room code' });

    try {
        if (!await roomExists(code)) return res.status(404).json({ error: 'Room not active' });
        const rate = await checkRateLimit(req);
        if (!rate.allowed) {
            res.setHeader('Retry-After', String(rate.retryAfter));
            return res.status(429).json({ error: 'Too many TURN credential requests' });
        }

        const cached = await loadCached(code);
        if (cached) return res.status(200).json(cached);

        const payload = await issueTemporaryConfig(code);
        await saveCached(code, payload);
        return res.status(200).json(payload);
    } catch (err) {
        console.error('[turn-credentials]', err && err.message || err);
        const status = Number(err && err.statusCode) || 500;
        return res.status(status).json({ error: status >= 500 ? 'TURN credentials temporarily unavailable' : 'TURN request failed' });
    }
}

module.exports = handler;
module.exports._test = {
    normalizeMeteredDomain,
    normalizeIceServers,
    createExpressTurnIce,
    hasTurn,
    issueTemporaryConfig,
    TURN_TTL_SECONDS
};
