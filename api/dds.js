// api/dds.js - Fonction serverless Vercel : calcule le double mort côté serveur.
//
// Réutilise TEL QUEL dds-lib.js (compilation Emscripten de libdds, Bo Haglund) : ce
// fichier détecte lui-même qu'il tourne sous Node et s'exporte via module.exports,
// aucune modification n'est nécessaire par rapport à la version utilisée dans le
// navigateur (dds-worker.js).
//
// Pourquoi côté serveur : sur un serveur Node, la mémoire (1024 Mo sur le plan Vercel
// Hobby) et le CPU ne sont pas contraints comme sur un téléphone, donc plus besoin de
// brider TOTAL_MEMORY ni le nombre de calculs en parallèle — le calcul est à la fois
// plus rapide et plus fiable qu'en local sur mobile.
//
// Requête attendue (POST, JSON) :
//   { "items": [ { "id": 0, "pbn": "N:..." }, { "id": 1, "pbn": "N:..." }, ... ] }
// Réponse :
//   { "results": [ { "id": 0, "table": {...} } | { "id": 0, "error": "..." }, ... ] }

global.Module = {};
require('./dds-lib.js');

const calcDDTable = global.Module.cwrap('generateDDTable', 'string', ['string']);

// À restreindre à ton domaine GitHub Pages une fois en prod (au lieu de '*'),
// ex: 'https://capgui13.github.io'
const ALLOWED_ORIGIN = '*';

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

    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'items[] requis (liste de {id, pbn})' });
        return;
    }
    if (items.length > 50) {
        res.status(400).json({ error: 'Trop de donnes dans une seule requête (max 50)' });
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
};
