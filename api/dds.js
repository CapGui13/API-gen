// api/dds.js — calcul double mort serveur avec validation d'entrée et rate-limit.

global.Module = {};
require('./dds-lib.js');

const crypto = require('crypto');
const calcDDTable = global.Module.cwrap('generateDDTable', 'string', ['string']);

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DDS_RATE_WINDOW_SECONDS = 60;
const DDS_RATE_DEALS_PER_CLIENT = 240;
const DDS_RATE_DEALS_GLOBAL = 3000;
const MAX_ITEMS = 50;
const MAX_PBN_LENGTH = 180;

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    return isAllowedOrigin(origin);
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
async function applyDdsRateLimit(req, cost) {
    return Number(await redisCommand([
        'EVAL', RATE_LUA, '2',
        `bridge-dds-rate:client:${rateSubject(req)}`,
        'bridge-dds-rate:global',
        String(DDS_RATE_WINDOW_SECONDS), String(DDS_RATE_DEALS_PER_CLIENT),
        String(DDS_RATE_DEALS_GLOBAL), String(cost)
    ]));
}

function validatePbnDeal(pbn) {
    if (typeof pbn !== 'string' || pbn.length === 0 || pbn.length > MAX_PBN_LENGTH) return false;
    const m = pbn.trim().match(/^([NESW]):(.+)$/);
    if (!m) return false;
    const hands = m[2].trim().split(/\s+/);
    if (hands.length !== 4) return false;
    const seen = new Set();
    for (const handText of hands) {
        const suits = handText.split('.');
        if (suits.length !== 4) return false;
        let cardCount = 0;
        for (let i = 0; i < 4; i++) {
            let ranks = suits[i].toUpperCase();
            if (ranks === '-') ranks = '';
            if (!/^[AKQJT98765432]*$/.test(ranks)) return false;
            cardCount += ranks.length;
            const suit = 'SHDC'[i];
            for (const rank of ranks) {
                const card = suit + rank;
                if (seen.has(card)) return false;
                seen.add(card);
            }
        }
        if (cardCount !== 13) return false;
    }
    return seen.size === 52;
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

    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'items[] requis (liste de {id, pbn})' });
        return;
    }
    if (items.length > MAX_ITEMS) {
        res.status(400).json({ error: `Trop de donnes dans une seule requête (max ${MAX_ITEMS})` });
        return;
    }
    for (const item of items) {
        if (!item || !validatePbnDeal(item.pbn)) {
            res.status(400).json({ error: 'Donne PBN DDS invalide.' });
            return;
        }
    }
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        res.status(503).json({ error: 'dds-rate-limit-storage-unavailable' });
        return;
    }

    try {
        const rate = await applyDdsRateLimit(req, items.length);
        if (rate < 0) {
            res.setHeader('Retry-After', String(DDS_RATE_WINDOW_SECONDS));
            res.status(429).json({ error: 'dds-rate-limited', scope: rate === -1 ? 'client' : 'global' });
            return;
        }

        const results = items.map(({ id, pbn }) => {
            try {
                const raw = calcDDTable(pbn);
                return { id, table: JSON.parse(raw) };
            } catch (err) {
                return { id, error: err && err.message ? err.message : String(err) };
            }
        });
        res.status(200).json({ results });
    } catch (err) {
        res.status(503).json({ error: (err && err.message) || String(err) });
    }
};
