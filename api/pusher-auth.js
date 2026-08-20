// api/pusher-auth.js — Autorisation des canaux Pusher privés de PLAY.
// Le code 4 chiffres n'est pas suffisant : la même clé de capacité que /api/session est
// exigée avant de signer l'abonnement private-session-XXXX.

const crypto = require('crypto');
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUSHER_KEY = process.env.PUSHER_KEY;
const PUSHER_SECRET = process.env.PUSHER_SECRET;
const ACCESS_KEY_HEADER = 'x-bridge-session-key';

const DEFAULT_ALLOWED_ORIGINS = ['https://capgui13.github.io'];
const EXTRA_ALLOWED_ORIGINS = String(process.env.BRIDGE_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]);

function accessKeyFor(code) { return `bridge-session-access:${String(code || '').toUpperCase().trim()}`; }
function reservationKeyFor(code) { return `bridge-room-reservation:${String(code || '').toUpperCase().trim()}`; }
function safeTextEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aa = Buffer.from(a, 'utf8'), bb = Buffer.from(b, 'utf8');
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
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
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
function parseBody(body) {
    if (body && typeof body === 'object') return body;
    if (typeof body !== 'string') return {};
    const out = {};
    for (const [k, v] of new URLSearchParams(body).entries()) out[k] = v;
    return out;
}

module.exports = async (req, res) => {
    if (!applyCors(req, res)) { res.status(403).json({ error: 'origin-not-allowed' }); return; }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non supportée.' }); return; }
    if (!UPSTASH_URL || !UPSTASH_TOKEN || !PUSHER_KEY || !PUSHER_SECRET) {
        res.status(500).json({ error: 'Configuration serveur Pusher/Redis incomplète.' }); return;
    }

    const body = parseBody(req.body);
    const socketId = String(body.socket_id || '').trim();
    const channelName = String(body.channel_name || '').trim();
    const match = /^private-session-([A-Za-z0-9]{3,12})$/.exec(channelName);
    if (!/^\d+\.\d+$/.test(socketId) || !match) {
        res.status(400).json({ error: 'Requête Pusher invalide.' }); return;
    }
    const code = match[1].toUpperCase();
    const provided = typeof req.headers[ACCESS_KEY_HEADER] === 'string' ? req.headers[ACCESS_KEY_HEADER].trim() : '';
    if (!provided) { res.status(401).json({ error: 'session-auth-required' }); return; }

    try {
        let stored = await redisCommand(['GET', accessKeyFor(code)]);
        if (!stored) stored = await redisCommand(['GET', reservationKeyFor(code)]);
        if (!stored || !safeTextEqual(String(stored), provided)) {
            res.status(403).json({ error: 'session-auth-invalid' }); return;
        }
        const signature = crypto.createHmac('sha256', PUSHER_SECRET)
            .update(`${socketId}:${channelName}`).digest('hex');
        res.status(200).json({ auth: `${PUSHER_KEY}:${signature}` });
    } catch (e) {
        res.status(500).json({ error: String((e && e.message) || e) });
    }
};
