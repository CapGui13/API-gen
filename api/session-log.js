// api/session-log.js — Journal de diagnostic PARTAGÉ entre tous les participants d'une
// salle (voir échange avec Guillaume — "je voudrais pouvoir tout te transmettre en un
// clic, sans avoir besoin du journal d'un joueur spécifique"). Chaque appareil pousse
// discrètement ses propres lignes au fil de la partie (voir flushRemoteLogQueue côté
// app.js) ; n'importe qui peut ensuite relire le journal COMBINÉ de toute la salle, trié
// par heure, en un seul appel — plus besoin de récupérer et recouper le journal de
// chaque joueur séparément après un test.
//
// Backé par le même Upstash Redis que session.js, avec sa propre clé et son propre TTL
// (plus court — un journal de diagnostic n'a pas besoin de survivre aussi longtemps
// qu'une partie active).
//
// Variables d'environnement : les mêmes que session.js (UPSTASH_REDIS_REST_URL/TOKEN).
//
// Routes :
//   GET  /api/session-log?code=XXXX   -> { entries: [{ from, text, ts }, ...] }
//   POST /api/session-log?code=XXXX   body: { entries: [{ from, text, ts }, ...] }
//                                      -> { ok: true, count }
//
// Journal plafonné (voir MAX_LOG_ENTRIES) pour éviter une dérive de taille sur une
// session qui s'étale sur des heures — les entrées les plus ANCIENNES sont perdues au-delà
// de ce plafond, jamais les plus récentes (les plus utiles pour diagnostiquer un souci qui
// vient d'arriver).

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// 3 jours : largement assez pour diagnostiquer après coup, pas la peine de le garder
// aussi longtemps qu'une partie elle-même (60 jours, voir TTL_SECONDS dans session.js) —
// c'est un journal de débogage, pas une donnée de partie à faire revivre plus tard.
const TTL_SECONDS = 60 * 60 * 24 * 3;
const MAX_LOG_ENTRIES = 800;

function keyFor(code) {
    return `bridge-debuglog:${String(code || '').toUpperCase().trim()}`;
}

// Même helper que session.js (dupliqué plutôt que partagé : chaque fonction serverless
// Vercel est un fichier autonome, pas de module partagé simple sans configuration de
// build supplémentaire pour un besoin aussi ponctuel).
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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
        if (newEntries.length === 0) {
            res.status(200).json({ ok: true, count: 0 });
            return;
        }
        try {
            const raw = await redisCommand(['GET', keyFor(code)]);
            let entries = raw ? JSON.parse(raw) : [];
            entries = entries.concat(newEntries);
            // Voir MAX_LOG_ENTRIES en en-tête : garde la FIN (les plus récentes), pas le
            // début, en cas de dépassement.
            if (entries.length > MAX_LOG_ENTRIES) entries = entries.slice(entries.length - MAX_LOG_ENTRIES);

            await redisCommand(['SET', keyFor(code), JSON.stringify(entries), 'EX', String(TTL_SECONDS)]);
            res.status(200).json({ ok: true, count: entries.length });
        } catch (e) {
            res.status(500).json({ error: String((e && e.message) || e) });
        }
        return;
    }

    res.status(405).json({ error: 'Méthode non supportée.' });
};
