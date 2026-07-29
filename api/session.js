// api/session.js — Persistance cloud de l'état de partie, pour les sessions "asynchrones"
// (deux joueurs qui enchérissent chacun à son rythme, jamais forcément connectés en même
// temps). Backé par Upstash Redis (API REST générique, un simple fetch — aucune dépendance
// npm requise), à l'identique de ce que fait déjà saveHostGameStateToStorage() côté client
// avec localStorage, mais accessible depuis N'IMPORTE QUEL appareil.
//
// Variables d'environnement attendues (Vercel → Settings → Environment Variables) :
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   PUSHER_APP_ID / PUSHER_KEY / PUSHER_SECRET / PUSHER_CLUSTER
//
// Routes :
//   GET  /api/session?code=XXXX            -> { version, updatedAt, state } | 404
//   PUT  /api/session?code=XXXX             body: { state, expectedVersion? }
//                                            -> { version, updatedAt } | 409 { current }
//
// `expectedVersion` (optionnel) sert de verrou optimiste : si quelqu'un d'autre a écrit
// entre-temps, la réponse 409 renvoie l'état courant (`current`) pour que le client
// recharge et réapplique plutôt que d'écraser à l'aveugle. En pratique, avec un seul
// joueur actif à la fois par construction, ce cas doit rester rare — mais coûte peu à
// sécuriser.
//
// Voir échange avec Guillaume ("j'aimerais que ce soit quasi instantané") : chaque écriture
// réussie diffuse aussi un petit événement Pusher sur le canal de la salle, pour que
// l'autre appareil soit prévenu EN DIRECT plutôt que d'attendre son prochain sondage
// périodique (voir pollCloudForUpdates côté client, qui reste un filet de secours au cas
// où cet événement se perdrait). L'événement ne transporte que le numéro de version — le
// client relit l'état complet via GET (déjà anti-cache), jamais dupliqué ici.

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PUSHER_APP_ID = process.env.PUSHER_APP_ID;
const PUSHER_KEY = process.env.PUSHER_KEY;
const PUSHER_SECRET = process.env.PUSHER_SECRET;
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER;

// Une session abandonnée (personne ne revient jamais) ne doit pas rester pour toujours
// dans la base gratuite : 60 jours est largement suffisant pour ce cas d'usage (parties de
// club, pas un tournoi permanent), et on repousse ce délai à chaque écriture (voir SET ...
// EX ci-dessous), donc une partie active ne s'éteint jamais toute seule en cours de route.
const TTL_SECONDS = 60 * 60 * 24 * 60;

function keyFor(code) {
    return `bridge-session:${String(code || '').toUpperCase().trim()}`;
}

function channelFor(code) {
    return `session-${String(code || '').toUpperCase().trim()}`;
}

// Upstash expose un point d'entrée REST générique : on POSTe le tableau de la commande
// Redis telle qu'on l'écrirait en CLI (ex. ["SET", "clef", "valeur", "EX", "3600"]), et il
// renvoie { result: ... }. Évite toute dépendance npm (@upstash/redis) pour un besoin aussi
// simple que GET/SET avec expiration.
async function redisCommand(command) {
    const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${UPSTASH_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(command)
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    return data.result;
}

// Implémente à la main la signature REST de Pusher (HMAC-SHA256 + MD5 du corps), telle que
// documentée par Pusher — évite la dépendance npm "pusher" pour un besoin aussi ponctuel
// qu'un simple trigger. Toujours en tâche de fond (fire-and-forget, voir l'appelant) : un
// échec ici ne doit jamais faire échouer l'écriture elle-même, le sondage de secours
// prendra le relais.
async function pusherTrigger(channel, eventName, data) {
    if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) return; // pas encore configuré : no-op silencieux

    const body = JSON.stringify({ name: eventName, channels: [channel], data: JSON.stringify(data) });
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

    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

module.exports = async (req, res) => {
    // Autorise les appels depuis GitHub Pages (n'importe quelle origine — ce n'est pas une
    // API sensible : le "secret", si on peut dire, est le code de salon lui-même, comme
    // pour PeerJS déjà). À resserrer plus tard si besoin (Access-Control-Allow-Origin
    // fixé sur ton domaine GitHub Pages précis) une fois que ça tourne.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Voir échange avec Guillaume ("A a récupéré une version périmée") : sans ça, rien
    // n'empêche le navigateur (ou un cache intermédiaire) de réutiliser une ancienne
    // réponse à cette même URL — exactement ce qui a dû se produire après plusieurs tests
    // manuels de cette URL dans des onglets pendant le débogage. Cette route change à
    // chaque enchère, elle ne doit jamais être mise en cache.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN manquantes côté serveur.' });
        return;
    }

    const code = (req.query.code || '').toString().trim();
    if (!code || !/^[A-Za-z0-9]{3,12}$/.test(code)) {
        res.status(400).json({ error: 'Paramètre "code" manquant ou invalide.' });
        return;
    }

    if (req.method === 'GET') {
        try {
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
        if (!state || typeof state !== 'object') {
            res.status(400).json({ error: '"state" manquant ou invalide dans le corps de la requête.' });
            return;
        }
        try {
            const existingRaw = await redisCommand(['GET', keyFor(code)]);
            const existing = existingRaw ? JSON.parse(existingRaw) : null;
            const currentVersion = existing ? existing.version : 0;

            if (typeof expectedVersion === 'number' && expectedVersion !== currentVersion) {
                res.status(409).json({ error: 'version-conflict', current: existing });
                return;
            }

            const payload = { version: currentVersion + 1, updatedAt: Date.now(), state };
            await redisCommand(['SET', keyFor(code), JSON.stringify(payload), 'EX', String(TTL_SECONDS)]);
            res.status(200).json({ version: payload.version, updatedAt: payload.updatedAt });
            // Fire-and-forget, APRÈS avoir répondu au client : ne fait jamais attendre
            // l'appelant, et un échec ici (Pusher pas encore configuré, panne passagère)
            // n'affecte jamais le succès de l'écriture elle-même.
            pusherTrigger(channelFor(code), 'update', { version: payload.version, updatedAt: payload.updatedAt }).catch(() => {});
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }

    res.status(405).json({ error: 'Méthode non supportée.' });
};
