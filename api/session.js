// api/session.js — Persistance cloud de l'état de partie, pour les sessions "asynchrones"
// (deux joueurs qui enchérissent chacun à son rythme, jamais forcément connectés en même
// temps), ET désormais aussi comme relais de secours en mode live par siège déconnecté
// (voir ARCHITECTURE-P2P-SERVEUR.md côté repo `play`). Backé par Upstash Redis (API REST
// générique, un simple fetch — aucune dépendance npm requise), à l'identique de ce que
// fait déjà saveHostGameStateToStorage() côté client avec localStorage, mais accessible
// depuis N'IMPORTE QUEL appareil.
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
// recharge et réapplique plutôt que d'écraser à l'aveugle.
//
// Voir échange avec Guillaume ("j'aimerais que ce soit quasi instantané" / "pourrait-on
// améliorer la latence ?") : deux changements par rapport à la version précédente.
//
// 1) pusherTrigger est maintenant ATTENDU (await) avant de répondre au client — sans ça,
//    l'exécution de la fonction pouvait être coupée par le runtime Vercel dès que sa
//    propre promesse se résolvait, avant que cet appel fire-and-forget n'ait eu le temps
//    de vraiment partir : la notification "temps réel" se perdait alors silencieusement
//    (le sondage de secours côté client rattrape toujours le coup, mais avec un délai
//    bien plus grand que prévu — jusqu'à DEFERRED_POLL_INTERVAL_MS, pas juste "manqué de
//    peu"). Léger coût : celui qui écrit attend un peu plus longtemps sa propre réponse
//    (le temps de cet appel Pusher), mais la fiabilité de la notification aux AUTRES
//    prime ici sur ce petit surcoût pour l'auteur de l'écriture.
//
// 2) L'événement Pusher embarque maintenant l'état LUI-MÊME (pas seulement le numéro de
//    version) quand il est assez petit pour tenir dans la limite de Pusher (10 Ko par
//    événement, voir PUSHER_EVENT_MAX_BYTES) — le client applique alors directement,
//    sans repasser par un second aller-retour GET (voir applyCloudUpdate côté app.js,
//    déjà prêt à recevoir ceci directement). Au-delà de cette taille (session avec
//    beaucoup de donnes chargées), on retombe sur l'ancien comportement (version seule,
//    le client relit via GET) — c'est déjà ce qu'il sait faire, aucun changement requis
//    côté client pour ce cas de repli.

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

// Marge sous la vraie limite Pusher (10 Ko par événement, corps entier compris) — voir
// point 2) du commentaire d'en-tête. Comparée à la taille de l'événement FINAL (avec son
// enveloppe JSON), pas seulement à l'état brut.
const PUSHER_EVENT_MAX_BYTES = 9000;

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
// qu'un simple trigger. Désormais ATTENDUE par l'appelant (voir commentaire d'en-tête,
// point 1) — plus un simple fire-and-forget : un échec ici est intercepté par l'appelant,
// jamais laissé remonter et casser la réponse HTTP déjà en cours de construction.
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

            // Voir commentaire d'en-tête, point 2 : embarque l'état complet si l'événement
            // final tient sous PUSHER_EVENT_MAX_BYTES, sinon repli sur la version seule
            // (le client relit alors via GET, comportement inchangé pour ce cas-là).
            const fullEventPayload = { version: payload.version, updatedAt: payload.updatedAt, state: payload.state };
            const versionOnlyPayload = { version: payload.version, updatedAt: payload.updatedAt };
            const eventPayload = JSON.stringify(fullEventPayload).length <= PUSHER_EVENT_MAX_BYTES
                ? fullEventPayload
                : versionOnlyPayload;

            // Voir commentaire d'en-tête, point 1 : attendu maintenant, mais toujours
            // encapsulé dans son propre try/catch — un échec Pusher (pas encore
            // configuré, panne passagère) ne doit jamais faire échouer l'écriture
            // elle-même, qui a déjà réussi dans Redis à ce stade.
            try {
                await pusherTrigger(channelFor(code), 'update', eventPayload);
            } catch (e) {
                // Tant pis pour cette notification en direct — le sondage de secours
                // côté client la rattrapera.
            }

            res.status(200).json({ version: payload.version, updatedAt: payload.updatedAt });
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }

    res.status(405).json({ error: 'Méthode non supportée.' });
};
