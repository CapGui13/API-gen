// api/export-deal.js — export PBN GitHub authentifié par les capacités de salle.
//
// Un appel d'export doit venir d'un joueur réellement autorisé dans une salle active :
// - hôte : accessKey + hostWriteKey ;
// - invité assis : accessKey + participantId + reconnectSecret enregistré côté serveur.
// Le simple Origin/CORS n'est jamais considéré comme une authentification.

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const EXPORT_FOLDER = 'donnes_export';
const SAFE_FILENAME = /^[a-zA-Z0-9_-]+\.pbn$/;
const MAX_CONTENT_LENGTH = 20000;
const CAPABILITY_RE = /^[A-Za-z0-9_-]{43,128}$/;
const MODERN_GUEST_ID_RE = /^p_[A-Za-z0-9_-]{24,96}$/;
const RECONNECT_SECRET_RE = /^s_[A-Za-z0-9_-]{32,160}$/;

const EXPORT_RATE_WINDOW_SECONDS = 60;
const EXPORT_RATE_PER_CLIENT = 15;
const EXPORT_RATE_PER_ROOM = 30;
const EXPORT_RATE_GLOBAL = 300;

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
    if (origin && isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Session-Key, X-Bridge-Host-Write-Key, X-Bridge-Participant-Id, X-Bridge-Reconnect-Secret');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return isAllowedOrigin(origin);
}
function normalizeCode(code) { return String(code || '').toUpperCase().trim(); }
function validCode(code) { return /^[A-Za-z0-9]{3,12}$/.test(code); }
function accessKeyFor(code) { return `bridge-session-access:${code}`; }
function reservationKeyFor(code) { return `bridge-room-reservation:${code}`; }
function hostWriteKeyFor(code) { return `bridge-session-host-write:${code}`; }
function writeReservationKeyFor(code) { return `bridge-room-write-reservation:${code}`; }
function participantAuthKeyFor(code, participantId) { return `bridge-session-participant-auth:${code}:${participantId}`; }
function safeTextEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aa = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function hashReconnectSecret(secret) {
    return crypto.createHash('sha256').update(String(secret || ''), 'utf8').digest('hex');
}
function rateSubject(req) {
    const forwarded = requestHeader(req, 'x-forwarded-for');
    const realIp = requestHeader(req, 'x-real-ip');
    const ip = String((forwarded && forwarded.split(',')[0]) || realIp || 'unknown').trim().slice(0, 128);
    return crypto.createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 32);
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
async function readStoredCapability(primaryKey, reservationKey) {
    const durable = await redisCommand(['GET', primaryKey]);
    if (durable) return String(durable);
    const reserved = await redisCommand(['GET', reservationKey]);
    return reserved ? String(reserved) : null;
}
async function authorizeRoomExport(req, code) {
    const access = requestHeader(req, 'x-bridge-session-key');
    if (!CAPABILITY_RE.test(access)) return { ok: false, status: 401, error: 'session-auth-required' };
    const storedAccess = await readStoredCapability(accessKeyFor(code), reservationKeyFor(code));
    if (!storedAccess || !safeTextEqual(storedAccess, access)) return { ok: false, status: 403, error: 'session-auth-invalid' };

    const hostWrite = requestHeader(req, 'x-bridge-host-write-key');
    if (hostWrite) {
        if (!CAPABILITY_RE.test(hostWrite)) return { ok: false, status: 403, error: 'session-host-write-invalid' };
        const storedWrite = await readStoredCapability(hostWriteKeyFor(code), writeReservationKeyFor(code));
        if (storedWrite && safeTextEqual(storedWrite, hostWrite)) return { ok: true, kind: 'host' };
        return { ok: false, status: 403, error: 'session-host-write-invalid' };
    }

    const participantId = requestHeader(req, 'x-bridge-participant-id');
    const reconnectSecret = requestHeader(req, 'x-bridge-reconnect-secret');
    if (!MODERN_GUEST_ID_RE.test(participantId) || !RECONNECT_SECRET_RE.test(reconnectSecret)) {
        return { ok: false, status: 403, error: 'participant-auth-invalid' };
    }
    const storedHash = await redisCommand(['GET', participantAuthKeyFor(code, participantId)]);
    const presentedHash = hashReconnectSecret(reconnectSecret);
    if (!storedHash || !safeTextEqual(String(storedHash), presentedHash)) {
        return { ok: false, status: 403, error: 'participant-auth-invalid' };
    }
    return { ok: true, kind: 'participant' };
}

const RATE_LUA = `
local clientCount = redis.call('INCR', KEYS[1])
if clientCount == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if clientCount > tonumber(ARGV[2]) then return -1 end
local roomCount = redis.call('INCR', KEYS[2])
if roomCount == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
if roomCount > tonumber(ARGV[3]) then return -2 end
local globalCount = redis.call('INCR', KEYS[3])
if globalCount == 1 then redis.call('EXPIRE', KEYS[3], ARGV[1]) end
if globalCount > tonumber(ARGV[4]) then return -3 end
return 1
`;
async function applyExportRateLimit(req, code) {
    const subject = rateSubject(req);
    const result = Number(await redisCommand([
        'EVAL', RATE_LUA, '3',
        `bridge-export-rate:client:${subject}`,
        `bridge-export-rate:room:${code}`,
        'bridge-export-rate:global',
        String(EXPORT_RATE_WINDOW_SECONDS), String(EXPORT_RATE_PER_CLIENT),
        String(EXPORT_RATE_PER_ROOM), String(EXPORT_RATE_GLOBAL)
    ]));
    return result;
}

function validateDealPbnString(pbn) {
    const text = String(pbn || '').trim();
    const m = text.match(/^([NESW]):(.+)$/);
    if (!m) return false;
    const firstSeat = m[1];
    const handStrings = m[2].trim().split(/\s+/);
    if (handStrings.length !== 4 || !'NESW'.includes(firstSeat)) return false;
    const seen = new Set();
    for (const handText of handStrings) {
        const suits = handText.split('.');
        if (suits.length !== 4) return false;
        let count = 0;
        for (let si = 0; si < 4; si++) {
            let ranks = suits[si].toUpperCase();
            if (ranks === '-') ranks = '';
            if (!/^[AKQJT98765432]*$/.test(ranks)) return false;
            count += ranks.length;
            const suit = 'SHDC'[si];
            for (const rank of ranks) {
                const card = suit + rank;
                if (seen.has(card)) return false;
                seen.add(card);
            }
        }
        if (count !== 13) return false;
    }
    return seen.size === 52;
}
function validateExportContent(content) {
    if (typeof content !== 'string' || content.length === 0 || content.length > MAX_CONTENT_LENGTH) return false;
    const dealTags = [...content.matchAll(/\[Deal\s+"([^"]+)"\]/gi)];
    if (dealTags.length !== 1 || !validateDealPbnString(dealTags[0][1])) return false;
    const dealer = content.match(/\[Dealer\s+"([^"]+)"\]/i);
    if (!dealer || !/^[NESW]$/i.test(dealer[1].trim())) return false;
    const vuln = content.match(/\[Vulnerable\s+"([^"]+)"\]/i);
    if (!vuln || !/^(?:None|NS|EW|Both|All)$/i.test(vuln[1].trim())) return false;
    return true;
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
        res.status(503).json({ error: 'session-auth-storage-unavailable' });
        return;
    }

    const { roomCode, filename, content } = req.body || {};
    const code = normalizeCode(roomCode);
    if (!validCode(code)) {
        res.status(400).json({ error: 'Code de salle invalide.' });
        return;
    }
    if (typeof filename !== 'string' || !SAFE_FILENAME.test(filename)) {
        res.status(400).json({ error: 'Nom de fichier invalide.' });
        return;
    }
    if (!validateExportContent(content)) {
        res.status(400).json({ error: 'Contenu PBN invalide.' });
        return;
    }

    try {
        const auth = await authorizeRoomExport(req, code);
        if (!auth.ok) {
            res.status(auth.status).json({ error: auth.error });
            return;
        }
        const rate = await applyExportRateLimit(req, code);
        if (rate < 0) {
            res.setHeader('Retry-After', String(EXPORT_RATE_WINDOW_SECONDS));
            res.status(429).json({ error: 'export-rate-limited', scope: rate === -1 ? 'client' : rate === -2 ? 'room' : 'global' });
            return;
        }

        const token = process.env.GITHUB_EXPORT_TOKEN;
        const repo = process.env.GITHUB_EXPORT_REPO;
        if (!token || !repo) {
            res.status(500).json({ error: 'Export GitHub non configuré côté serveur.' });
            return;
        }

        const path = `${EXPORT_FOLDER}/${filename}`;
        const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
        const ghResponse = await fetch(apiUrl, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'table-encheres-export'
            },
            body: JSON.stringify({
                message: `Export donne : ${filename}`,
                content: Buffer.from(content, 'utf-8').toString('base64')
            })
        });
        if (!ghResponse.ok) {
            const errText = await ghResponse.text().catch(() => '');
            throw new Error(`GitHub API a répondu ${ghResponse.status} : ${errText.slice(0, 200)}`);
        }
        res.status(200).json({ ok: true, path });
    } catch (err) {
        res.status(502).json({ error: (err && err.message) || String(err) });
    }
};
