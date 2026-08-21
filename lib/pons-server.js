// api/pons-server.js — autorité PONS côté serveur pour le relais participant.
//
// Ce module charge EXACTEMENT la pile PONS embarquée dans PLAY (mêmes règles canoniques,
// même WASM, même Critic et même journal sémantique), mais uniquement à la demande.
// L'objectif n'est pas de remplacer le moteur du host live : il ferme le dernier trou du
// mode relais/différé, où un participant pouvait auparavant proposer lui-même une annonce
// robot différente tant qu'elle restait légalement valide au bridge.
//
// Les décisions PONS sont sérialisées dans un même processus Node. PonsSemanticLedger est
// volontairement global dans le runtime navigateur ; sans ce verrou, deux requêtes de salles
// différentes pourraient entrelacer clear()/recordDecision(). Chaque séquence repart donc
// d'un ledger vide puis rejoue les décisions robot déjà présentes sur la branche publique
// avant de calculer les nouveaux appels autoritaires.

'use strict';

let runtimePromise = null;
let authorityTail = Promise.resolve();

function serverFault(code, message, cause) {
    const err = new Error(message || code);
    err.code = code;
    err.serverPonsFault = true;
    if (cause) err.cause = cause;
    return err;
}

function installBrowserCompatRoot() {
    const root = globalThis;
    if (typeof root.window === 'undefined') root.window = root;
    if (typeof root.atob !== 'function') {
        root.atob = (value) => Buffer.from(String(value || ''), 'base64').toString('binary');
    }
    if (typeof root.performance === 'undefined') {
        try { root.performance = require('perf_hooks').performance; } catch (_) {}
    }
    return root;
}

async function ensurePonsRuntime() {
    if (runtimePromise) return runtimePromise;
    runtimePromise = (async () => {
        const root = installBrowserCompatRoot();

        // Ordre identique à index.html côté PLAY pour que pons-engine capture exactement
        // le même fallback canonique que le navigateur. Les require restent volontairement
        // LITTÉRAUX : Vercel/Node File Trace doit pouvoir embarquer ces assets dans la
        // fonction serverless sans dépendre de la résolution d'un chemin dynamique.
        require('./pons/canonical-rules-v1.js');
        require('./pons/bridge-engine-v1-browser.js');
        require('./pons/fiches-engine-v1-app.js');
        require('./pons/pons-semantic.js');
        require('./pons/pons-critic.js');
        require('./pons/pons-wasm-embedded.js');
        require('./pons/pons-engine.js');

        if (!root.PonsEngine || !root.PonsEngine.ready || typeof root.PonsEngine.decideRobotCallForApp !== 'function') {
            throw serverFault('server-pons-runtime-missing', 'Runtime PONS serveur incomplet.');
        }
        await root.PonsEngine.ready;
        if (!root.PonsEngine.loaded) {
            throw serverFault('server-pons-runtime-unavailable', 'Runtime PONS serveur non chargé.', root.PonsEngine.error);
        }
        return root.PonsEngine;
    })().catch((err) => {
        // Un échec d'initialisation reste fail-closed pour la durée du processus : ne jamais
        // accepter un appel robot fourni par le client comme repli silencieux.
        if (err && err.serverPonsFault) throw err;
        throw serverFault('server-pons-runtime-unavailable', 'Initialisation PONS serveur impossible.', err);
    });
    return runtimePromise;
}

async function withAuthorityLock(fn) {
    const previous = authorityTail;
    let release;
    authorityTail = new Promise(resolve => { release = resolve; });
    await previous.catch(() => {});
    try {
        return await fn();
    } finally {
        release();
    }
}

function cloneHistory(history) {
    return (Array.isArray(history) ? history : []).map(entry => ({
        seat: String(entry && entry.seat || '').toUpperCase(),
        call: String(entry && entry.call || '').toUpperCase(),
        ...(entry && typeof entry.explanation === 'string' ? { explanation: entry.explanation.slice(0, 500) } : {})
    }));
}

function isRobotSeat(seatAssignment, seat) {
    const occupant = seatAssignment && seatAssignment[seat];
    return occupant == null || occupant === '';
}

/**
 * Calcule, côté serveur, tous les appels robot consécutifs à partir d'un historique donné.
 *
 * Les fonctions de tour/légalité viennent de session.js : c'est volontaire, afin que le
 * moteur PONS et la frontière d'autorité utilisent strictement le même arbitre de légalité.
 */
async function advanceRobotAuction({
    deal,
    history,
    seatAssignment,
    currentTurnSeat,
    isCallLegal,
    isAuctionOver,
    maxCalls = 64
}) {
    if (!deal || typeof deal !== 'object') throw serverFault('server-pons-deal-invalid', 'Donne PONS serveur invalide.');
    if (typeof currentTurnSeat !== 'function' || typeof isCallLegal !== 'function' || typeof isAuctionOver !== 'function') {
        throw serverFault('server-pons-contract-invalid', 'Contrat interne PONS serveur invalide.');
    }

    return withAuthorityLock(async () => {
        const engine = await ensurePonsRuntime();
        const root = globalThis;
        // PonsEngine consulte root.isCallLegal dynamiquement. On branche l'arbitre serveur
        // pour éviter toute divergence entre « décision PONS » et « acceptation session ».
        root.isCallLegal = isCallLegal;
        if (root.PonsSemanticLedger && typeof root.PonsSemanticLedger.clear === 'function') {
            root.PonsSemanticLedger.clear();
        }

        const original = cloneHistory(history);
        const replay = [];

        // Reconstruit la mémoire sémantique publique des appels robot déjà présents. Si un
        // ancien appel robot (pré-patch, mode pass-only, etc.) ne correspond pas au PONS
        // actuel, l'entrée calculée vit sur une autre branche et n'influence donc pas la
        // suite réelle. On conserve toujours l'historique serveur comme vérité historique.
        for (const entry of original) {
            const expected = currentTurnSeat(deal.dealer, replay);
            if (entry.seat !== expected || !isCallLegal(replay, entry.call, entry.seat)) {
                throw serverFault('server-pons-history-invalid', 'Historique serveur invalide pendant la reconstruction PONS.');
            }
            if (isRobotSeat(seatAssignment, entry.seat)) {
                try {
                    await engine.decideRobotCallForApp(entry.seat, deal, replay, []);
                } catch (err) {
                    throw serverFault('server-pons-replay-failed', 'Reconstruction sémantique PONS impossible.', err);
                }
            }
            replay.push(entry);
        }

        const out = cloneHistory(original);
        let added = 0;
        while (!isAuctionOver(out)) {
            const seat = currentTurnSeat(deal.dealer, out);
            if (!seat || !isRobotSeat(seatAssignment, seat)) break;
            if (added >= maxCalls) {
                throw serverFault('server-pons-loop-guard', `PONS serveur a dépassé ${maxCalls} appels robot consécutifs.`);
            }

            let decision;
            try {
                decision = await engine.decideRobotCallForApp(seat, deal, out, []);
            } catch (err) {
                throw serverFault('server-pons-decision-failed', `PONS serveur n'a pas pu décider pour ${seat}.`, err);
            }
            const call = String(decision && decision.call || '').toUpperCase();
            if (!call || !isCallLegal(out, call, seat)) {
                throw serverFault('server-pons-illegal-decision', `PONS serveur a produit une annonce invalide pour ${seat}: ${call || '(vide)'}.`);
            }
            out.push({
                seat,
                call,
                ...(decision && typeof decision.explanation === 'string'
                    ? { explanation: decision.explanation.slice(0, 500) }
                    : {})
            });
            added++;
        }

        return { history: out, added };
    });
}

module.exports = {
    advanceRobotAuction,
    ensurePonsRuntime,
    isRobotSeat,
    serverFault
};
