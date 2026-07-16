// api/export-deal.js - Fonction serverless Vercel : exporte une donne jouée en PBN
// directement dans le dépôt GitHub (dossier donnes_export/), via l'API "Contents" de
// GitHub. À placer dans le même projet Vercel que api/dds.js.
//
// Pourquoi côté serveur et pas directement depuis le navigateur : un jeton d'écriture
// GitHub embarqué dans le JS de table-encheres (public, sur GitHub Pages) serait
// trivialement récupérable via "Afficher le code source" — n'importe qui pourrait alors
// écrire ce qu'il veut dans le dépôt, y compris modifier le site lui-même. Le jeton reste
// donc ici, dans une variable d'environnement Vercel, jamais exposé au client (voir
// échange avec Guillaume).
//
// Requête attendue (POST, JSON) :
//   { "filename": "donne-3-20260716-143012.pbn", "content": "[Event ...]\n[Board ...]\n..." }
// Réponse :
//   { "ok": true, "path": "donnes_export/donne-3-20260716-143012.pbn" } ou { "error": "..." }
//
// ===== Configuration requise (Vercel → Project → Settings → Environment Variables) =====
//   GITHUB_EXPORT_TOKEN : jeton d'accès personnel GitHub "fine-grained"
//                         (https://github.com/settings/tokens?type=beta), restreint à
//                         CE SEUL dépôt (table-encheres), permission "Contents" réglée
//                         sur "Read and write" — rien d'autre. Ne JAMAIS utiliser un
//                         jeton "classic" à portée large (accès à tous tes dépôts).
//   GITHUB_EXPORT_REPO  : "capgui13/table-encheres" (à adapter si le nom du dépôt diffère)
//
// Après avoir ajouté/modifié ces variables, un redéploiement est nécessaire pour qu'elles
// prennent effet (Vercel → Deployments → ⋯ → Redeploy).

const ALLOWED_ORIGIN = 'https://capgui13.github.io';
const EXPORT_FOLDER = 'donnes_export';

// Nom de fichier strictement contrôlé : lettres/chiffres/tirets/underscores + ".pbn"
// uniquement. Bloque toute tentative d'écrire ailleurs que dans EXPORT_FOLDER (ex. un nom
// contenant "../" pour remonter dans l'arborescence du dépôt).
const SAFE_FILENAME = /^[a-zA-Z0-9_-]+\.pbn$/;

const MAX_CONTENT_LENGTH = 20000; // largement suffisant pour une seule donne PBN

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    const { filename, content } = req.body || {};
    if (typeof filename !== 'string' || !SAFE_FILENAME.test(filename)) {
        res.status(400).json({ error: 'Nom de fichier invalide (lettres, chiffres, "-", "_" et extension .pbn uniquement).' });
        return;
    }
    if (typeof content !== 'string' || content.length === 0 || content.length > MAX_CONTENT_LENGTH) {
        res.status(400).json({ error: 'Contenu invalide ou trop volumineux.' });
        return;
    }

    const token = process.env.GITHUB_EXPORT_TOKEN;
    const repo = process.env.GITHUB_EXPORT_REPO;
    if (!token || !repo) {
        res.status(500).json({ error: 'Export non configuré côté serveur (GITHUB_EXPORT_TOKEN / GITHUB_EXPORT_REPO manquant(s) dans les variables d\'environnement Vercel).' });
        return;
    }

    const path = `${EXPORT_FOLDER}/${filename}`;
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;

    try {
        const ghResponse = await fetch(apiUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
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
