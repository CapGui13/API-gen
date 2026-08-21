// api/session.js — Persistance cloud sécurisée de l'état de partie.
//
// Sécurité : un code de salle 4 chiffres reste un identifiant humain, PAS un secret.
// Chaque salle possède désormais une clé de capacité aléatoire (32 octets) générée lors
// de la réservation. Cette clé n'est jamais stockée dans le snapshot de partie ; elle est
// transmise uniquement au navigateur légitime (réservation initiale, lien d'invitation,
// ou P2P) et exigée sur chaque GET/PUT. La migration non authentifiée `claim-legacy`
// est désactivée : un identifiant présent dans un snapshot n'est jamais une preuve d'accès.
//
// Variables d'environnement :
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   PUSHER_APP_ID / PUSHER_KEY / PUSHER_SECRET / PUSHER_CLUSTER
//   BRIDGE_ALLOWED_ORIGINS (optionnel, liste séparée par des virgules)
//
// Routes :
//   POST /api/session body { action:'reserve-code' }
//        -> { code, accessKey, reservationTtlSeconds }
//   GET  /api/session?code=XXXX + X-Bridge-Session-Key
//        -> { version, updatedAt, state } | 404
//   PUT  /api/session?code=XXXX + X-Bridge-Session-Key
//        body { state, expectedVersion } -> { version, updatedAt } | 409 { current }
//
// Le verrou expectedVersion reste atomique : authentification de la clé, comparaison de
// version, écriture de l'état, promotion de la réservation en clé durable et refresh des
// TTL sont exécutés dans UNE SEULE commande Redis EVAL.

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUSHER_APP_ID = process.env.PUSHER_APP_ID;
const PUSHER_KEY = process.env.PUSHER_KEY;
const PUSHER_SECRET = process.env.PUSHER_SECRET;
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER;

const TTL_SECONDS = 60 * 60 * 24 * 60;
const MAX_SESSION_STATE_BYTES = 512 * 1024;
const ROOM_CODE_RESERVATION_TTL_SECONDS = 120;
// Une fois PeerJS réellement ouvert, la réservation courte est promue en droit pré-partie
// pendant 6 h : assez pour rester longtemps au salon sans perdre la clé, mais sans bloquer
// un code pendant 60 jours si la partie est abandonnée avant le premier snapshot.
const PRESESSION_ACCESS_TTL_SECONDS = 6 * 60 * 60;
const ROOM_CODE_ALLOCATION_ATTEMPTS = 64;
const ACCESS_KEY_BYTES = 32;
const ACCESS_KEY_HEADER = 'x-bridge-session-key';

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

function keyFor(code) {
    return `bridge-session:${String(code || '').toUpperCase().trim()}`;
}
function reservationKeyFor(code) {
    return `bridge-room-reservation:${String(code || '').toUpperCase().trim()}`;
}
function accessKeyFor(code) {
    return `bridge-session-access:${String(code || '').toUpperCase().trim()}`;
}
function channelFor(code) {
    return `private-session-${String(code || '').toUpperCase().trim()}`;
}
function normalizeCode(code) {
    return String(code || '').toUpperCase().trim();
}
function validCode(code) {
    return /^[A-Za-z0-9]{3,12}$/.test(code);
}
function generateAccessKey() {
    return crypto.randomBytes(ACCESS_KEY_BYTES).toString('base64url');
}
function safeTextEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aa = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function requestAccessKey(req) {
    const raw = req && req.headers && (req.headers[ACCESS_KEY_HEADER] || req.headers[ACCESS_KEY_HEADER.toLowerCase()]);
    return typeof raw === 'string' ? raw.trim() : '';
}

function isAllowedOrigin(origin) {
    if (!origin) return true; // curl / tests / serveur-à-serveur
    if (ALLOWED_ORIGINS.has(origin)) return true;
    if (process.env.VERCEL_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    return false;
}
function applyCors(req, res) {
    const origin = req && req.headers && req.headers.origin;
    if (origin && isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Session-Key');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return isAllowedOrigin(origin);
}

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

async function readStoredAccessKey(code) {
    const durable = await redisCommand(['GET', accessKeyFor(code)]);
    if (durable) return String(durable);
    const reserved = await redisCommand(['GET', reservationKeyFor(code)]);
    return reserved ? String(reserved) : null;
}

async function authorizeReadRequest(req, res, code) {
    const provided = requestAccessKey(req);
    if (!provided) {
        res.status(401).json({ error: 'session-auth-required' });
        return false;
    }
    const stored = await readStoredAccessKey(code);
    if (!stored || !safeTextEqual(stored, provided)) {
        res.status(403).json({ error: 'session-auth-invalid' });
        return false;
    }
    return true;
}

// Le script valide aussi la clé d'accès. Pour une nouvelle salle, la clé courte de
// réservation est promue atomiquement en clé durable lors du tout premier PUT.
const SESSION_CAS_LUA = `
local raw = redis.call('GET', KEYS[1])
local durableKey = redis.call('GET', KEYS[3])
local reservationKey = redis.call('GET', KEYS[2])
local providedKey = ARGV[5]

if raw then
  if not durableKey or durableKey ~= providedKey then
    return {-2, ''}
  end
else
  if durableKey then
    if durableKey ~= providedKey then return {-2, ''} end
  else
    if not reservationKey or reservationKey ~= providedKey then return {-2, ''} end
    redis.call('SET', KEYS[3], providedKey, 'EX', ARGV[4])
  end
end

local currentVersion = 0
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if not ok or type(decoded) ~= 'table' or type(decoded.version) ~= 'number' then
    return {-1, raw}
  end
  currentVersion = decoded.version
end

local expectedVersion = tonumber(ARGV[1])
if expectedVersion ~= currentVersion then
  return {0, raw or ''}
end

local newVersion = currentVersion + 1
local updatedAt = ARGV[2]
local stateJson = ARGV[3]
local ttl = ARGV[4]
local payload = '{"version":' .. tostring(newVersion)
  .. ',"updatedAt":' .. updatedAt
  .. ',"state":' .. stateJson .. '}'
redis.call('SET', KEYS[1], payload, 'EX', ttl)
redis.call('SET', KEYS[3], providedKey, 'EX', ttl)
redis.call('DEL', KEYS[2])
return {1, tostring(newVersion), updatedAt, payload}
`;

async function atomicWriteSession(code, state, expectedVersion, updatedAt, accessKey) {
    const stateJson = JSON.stringify(state);
    const result = await redisCommand([
        'EVAL', SESSION_CAS_LUA, '3', keyFor(code), reservationKeyFor(code), accessKeyFor(code),
        String(expectedVersion), String(updatedAt), stateJson, String(TTL_SECONDS), accessKey
    ]);
    if (!Array.isArray(result) || result.length === 0) throw new Error('Réponse Redis CAS invalide.');
    const status = Number(result[0]);
    if (status === -2) return { unauthorized: true };
    if (status === -1) throw new Error('État de session Redis corrompu : version illisible.');
    if (status === 0) {
        let current = null;
        if (result[1]) {
            try { current = JSON.parse(result[1]); }
            catch (e) { throw new Error('État de session Redis corrompu : JSON illisible.'); }
        }
        return { conflict: true, current };
    }
    if (status !== 1) throw new Error(`Statut Redis CAS inattendu: ${status}`);
    let payload;
    try { payload = JSON.parse(result[3]); }
    catch (e) { throw new Error('Payload Redis CAS invalide.'); }
    return { conflict: false, payload };
}

// Allocation atomique : aucune ancienne session, aucune clé durable et aucune autre
// réservation ne doivent exister. La valeur de réservation EST la clé de capacité.
const ROOM_CODE_RESERVE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
`;

async function reserveFreshRoomCode() {
    for (let i = 0; i < ROOM_CODE_ALLOCATION_ATTEMPTS; i++) {
        const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
        const accessKey = generateAccessKey();
        const result = await redisCommand([
            'EVAL', ROOM_CODE_RESERVE_LUA, '3', keyFor(code), reservationKeyFor(code), accessKeyFor(code),
            accessKey, String(ROOM_CODE_RESERVATION_TTL_SECONDS)
        ]);
        if (Number(result) === 1) return { code, accessKey };
    }
    throw new Error('Impossible de réserver un code de salle libre après plusieurs tentatives.');
}


const ACTIVATE_ROOM_LUA = `
local rawSession = redis.call('GET', KEYS[1])
local durable = redis.call('GET', KEYS[3])
local reservation = redis.call('GET', KEYS[2])
local provided = ARGV[1]
if durable then
  if durable ~= provided then return 0 end
  if rawSession then redis.call('EXPIRE', KEYS[3], ARGV[3])
  else redis.call('EXPIRE', KEYS[3], ARGV[2]) end
  return 1
end
if not reservation or reservation ~= provided then return 0 end
redis.call('SET', KEYS[3], provided, 'EX', ARGV[2])
redis.call('DEL', KEYS[2])
return 1
`;

async function activateRoomAccess(code, providedKey) {
    const result = await redisCommand([
        'EVAL', ACTIVATE_ROOM_LUA, '3', keyFor(code), reservationKeyFor(code), accessKeyFor(code),
        providedKey, String(PRESESSION_ACCESS_TTL_SECONDS), String(TTL_SECONDS)
    ]);
    return Number(result) === 1;
}

// `claim-legacy` supprimé pour raison de sécurité : aucune route non authentifiée ne
// peut convertir un identifiant de participant en capacité durable de salle.

// Trigger serveur vers un CANAL PRIVÉ. L'événement ne transporte volontairement plus le
// snapshot : seulement version/updatedAt. Le contenu de partie reste exclusivement dans
// Redis derrière l'authentification de capacité ; le client fait un GET authentifié à la
// réception (ou le polling de secours le fera plus tard).
function pusherRequestBody(channel, eventName, data) {
    return JSON.stringify({ name: eventName, channels: [channel], data: JSON.stringify(data) });
}
async function pusherTrigger(channel, eventName, data) {
    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) return;
    const body = pusherRequestBody(channel, eventName, data);
    const bodyMd5 = crypto.createHash('md5').update(body).digest('hex');
    const path = `/apps/${PUSHER_APP_ID}/events`;
    const params = {
        auth_key: PUSHER_KEY,
        auth_timestamp: String(Math.floor(Date.now() / 1000)),
        auth_version: '1.0',
        body_md5: bodyMd5
    };
    const sortedQuery = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
    const stringToSign = `POST\n${path}\n${sortedQuery}`;
    const authSignature = crypto.createHmac('sha256', PUSHER_SECRET).update(stringToSign).digest('hex');
    const url = `https://api-${PUSHER_CLUSTER}.pusher.com${path}?${sortedQuery}&auth_signature=${authSignature}`;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        throw new Error(`Pusher HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
}

module.exports = async (req, res) => {
    if (!applyCors(req, res)) {
        res.status(403).json({ error: 'origin-not-allowed' });
        return;
    }
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN manquantes côté serveur.' });
        return;
    }

    if (req.method === 'POST') {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        if (body && body.action === 'reserve-code') {
            try {
                const reserved = await reserveFreshRoomCode();
                res.status(201).json({
                    code: reserved.code,
                    accessKey: reserved.accessKey,
                    reservationTtlSeconds: ROOM_CODE_RESERVATION_TTL_SECONDS
                });
            } catch (e) {
                res.status(503).json({ error: String((e && e.message) || e) });
            }
            return;
        }
        if (body && body.action === 'activate-room') {
            const code = normalizeCode(body.code);
            const providedKey = requestAccessKey(req);
            if (!validCode(code) || !providedKey) {
                res.status(400).json({ error: 'Paramètres activation invalides.' });
                return;
            }
            try {
                const ok = await activateRoomAccess(code, providedKey);
                if (!ok) { res.status(403).json({ error: 'session-auth-invalid' }); return; }
                res.status(200).json({ ok: true });
            } catch (e) {
                res.status(500).json({ error: String((e && e.message) || e) });
            }
            return;
        }
        if (body && body.action === 'claim-legacy') {
            // Compatibilité fail-closed avec d'anciens clients : la route existe encore
            // nominalement mais ne rend JAMAIS de clé et ne consulte aucun token de snapshot.
            res.status(410).json({ error: 'legacy-claim-disabled' });
            return;
        }
        res.status(400).json({ error: 'Action POST inconnue.' });
        return;
    }

    const code = normalizeCode(req.query && req.query.code);
    if (!validCode(code)) {
        res.status(400).json({ error: 'Paramètre "code" manquant ou invalide.' });
        return;
    }

    if (req.method === 'GET') {
        try {
            if (!await authorizeReadRequest(req, res, code)) return;
            const raw = await redisCommand(['GET', keyFor(code)]);
            if (!raw) {
                res.status(404).json({ error: 'Aucune session trouvée pour ce code.' });
                return;
            }
            res.status(200).json(JSON.parse(raw));
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }

    if (req.method === 'PUT') {
        let body = req.body;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { body = {}; }
        }
        const { state, expectedVersion } = body || {};
        if (!state || typeof state !== 'object' || Array.isArray(state)) {
            res.status(400).json({ error: '"state" manquant ou invalide dans le corps de la requête.' });
            return;
        }
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
            res.status(400).json({ error: '"expectedVersion" est obligatoire et doit être un entier >= 0.' });
            return;
        }
        const stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
        if (stateBytes > MAX_SESSION_STATE_BYTES) {
            res.status(413).json({ error: 'session-state-too-large', maxBytes: MAX_SESSION_STATE_BYTES, actualBytes: stateBytes });
            return;
        }
        const providedKey = requestAccessKey(req);
        if (!providedKey) {
            res.status(401).json({ error: 'session-auth-required' });
            return;
        }
        try {
            const write = await atomicWriteSession(code, state, expectedVersion, Date.now(), providedKey);
            if (write.unauthorized) {
                res.status(403).json({ error: 'session-auth-invalid' });
                return;
            }
            if (write.conflict) {
                res.status(409).json({ error: 'version-conflict', current: write.current });
                return;
            }
            const payload = write.payload;
            try {
                await pusherTrigger(channelFor(code), 'update', { version: payload.version, updatedAt: payload.updatedAt });
            } catch (e) {
                console.warn('[session] notification Pusher échouée :', String((e && e.message) || e));
            }
            res.status(200).json({ version: payload.version, updatedAt: payload.updatedAt });
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }

    res.status(405).json({ error: 'Méthode non supportée.' });
};
