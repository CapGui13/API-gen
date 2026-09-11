#!/usr/bin/env node
'use strict';

// Générateur hors-Vercel du stock PLAY V3.
// Il tourne dans GitHub Actions, calcule complètement les donnes (DD exact + 72 tables
// statistiques brutes pour NS + 72 pour EW), puis ne publie la donne dans READY qu'une
// fois tous les calculs terminés.

const crypto = require('crypto');
const StatisticalPar = require('../lib/pool-statistical-sampler');

global.Module = global.Module || {};
require('../api/dds-lib.js');
const calcDDTable = global.Module.cwrap('generateDDTable', 'string', ['string']);

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const POOL_VERSION = 'play-deal-pool-v3-precomputed72';
const DATA_KEY = 'bridge-deal-pool:v3:data';
const READY_KEY = 'bridge-deal-pool:v3:ready';
const POOL_TARGET = clampInt(process.env.BRIDGE_DEAL_POOL_TARGET, 240, 40, 2000);
const BATCH_SIZE = clampInt(process.env.BRIDGE_DEAL_POOL_BUILD_BATCH, 8, 1, 40);
const SAMPLE_COUNT = 72;

const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = 'AKQJT98765432';
const HCP = { A: 4, K: 3, Q: 2, J: 1 };

function clampInt(raw, fallback, min, max) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

async function redisCommand(command) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('UPSTASH_REDIS_REST_URL/TOKEN manquants');
    const resp = await fetch(UPSTASH_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) throw new Error(data.error || `Upstash HTTP ${resp.status}`);
    return data.result;
}

function shuffledDeck() {
    const deck = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function dealFromDeck(deck) {
    const hands = {};
    for (let seatIndex = 0; seatIndex < 4; seatIndex++) {
        const seat = SEATS[seatIndex];
        const cards = deck.slice(seatIndex * 13, seatIndex * 13 + 13);
        hands[seat] = {};
        for (const suit of SUITS) {
            const rankSet = new Set(cards.filter(card => card.suit === suit).map(card => card.rank));
            hands[seat][suit] = Array.from(RANKS).filter(rank => rankSet.has(rank)).join('');
        }
    }
    return hands;
}

function handHcp(hand) {
    let total = 0;
    for (const suit of SUITS) for (const rank of String(hand && hand[suit] || '')) total += HCP[rank] || 0;
    return total;
}

function metadataForHands(hands) {
    const hcp = {};
    const lengths = {};
    for (const seat of SEATS) {
        hcp[seat] = handHcp(hands[seat]);
        lengths[seat] = {};
        for (const suit of SUITS) lengths[seat][suit] = String(hands[seat][suit] || '').length;
    }
    return {
        hcp,
        lineHcp: { NS: hcp.N + hcp.S, EW: hcp.E + hcp.W },
        lengths
    };
}

function handsToPbn(hands) {
    return 'N:' + SEATS.map(seat => SUITS.map(suit => String(hands[seat][suit] || '')).join('.')).join(' ');
}

function solveTableForHands(hands) {
    const raw = calcDDTable(handsToPbn(hands));
    const table = JSON.parse(raw);
    if (!table || typeof table !== 'object') throw new Error('DDS table invalide');
    return table;
}

function configForSide(side) {
    const normalized = side === 'EW' ? 'EW' : 'NS';
    const knownSeats = normalized === 'NS' ? ['N', 'S'] : ['E', 'W'];
    const randomizedSeats = normalized === 'NS' ? ['E', 'W'] : ['N', 'S'];
    return {
        ok: true,
        mode: 'two-known-hands',
        knownSeats: knownSeats.slice(),
        humanSeats: knownSeats.slice(),
        actualHumanSeats: knownSeats.slice(),
        pendingSeats: [],
        reservedHumanSeats: knownSeats.slice(),
        randomizedSeats: randomizedSeats.slice(),
        botSeats: randomizedSeats.slice(),
        humanSide: normalized,
        botSide: normalized === 'NS' ? 'EW' : 'NS',
        diagnosticPerspective: 'optimal-contract-side'
    };
}

function buildFullyPrecomputedRecord() {
    const started = Date.now();
    const hands = dealFromDeck(shuffledDeck());
    const statisticalSeedId = 'pool_' + crypto.randomBytes(18).toString('base64url');
    const ddTable = solveTableForHands(hands);
    const deal = { hands, statisticalSeedId };
    const sides = { NS: [], EW: [] };

    for (const side of ['NS', 'EW']) {
        const config = configForSide(side);
        for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex++) {
            const sampleHands = StatisticalPar.sampleHandsDeterministic(deal, config, sampleIndex);
            sides[side].push({ sampleIndex, table: solveTableForHands(sampleHands) });
        }
    }

    const now = new Date().toISOString();
    return {
        poolVersion: POOL_VERSION,
        statisticalSeedId,
        hands,
        ddTable,
        meta: metadataForHands(hands),
        precomputedStatV1: {
            format: 'universal-dd-72',
            statisticalSeedId,
            samplingSeedVersion: StatisticalPar.STATISTICAL_PAR_SAMPLING_SEED_VERSION,
            sampleCount: SAMPLE_COUNT,
            sides
        },
        createdAt: now,
        statEnrichedAt: now,
        precomputeMs: Date.now() - started
    };
}

async function publishRecord(record) {
    const id = 'd3_' + crypto.randomBytes(15).toString('base64url');
    // DATA d'abord, READY ensuite : une panne entre les deux crée au pire un orphelin,
    // jamais une entrée READY pointant vers une donnée incomplète.
    await redisCommand(['HSET', DATA_KEY, id, JSON.stringify(record)]);
    await redisCommand(['RPUSH', READY_KEY, id]);
    return id;
}

async function main() {
    const before = Number(await redisCommand(['LLEN', READY_KEY]) || 0);
    const missing = Math.max(0, POOL_TARGET - before);
    const toBuild = Math.min(BATCH_SIZE, missing);
    console.log(`[deal-pool] ready=${before}, target=${POOL_TARGET}, batch=${BATCH_SIZE}, toBuild=${toBuild}`);
    if (!toBuild) {
        console.log('[deal-pool] stock déjà au niveau cible, aucun calcul nécessaire.');
        return;
    }

    let built = 0;
    for (let i = 0; i < toBuild; i++) {
        const t0 = Date.now();
        const record = buildFullyPrecomputedRecord();
        const id = await publishRecord(record);
        built++;
        console.log(`[deal-pool] ${built}/${toBuild} publié ${id} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
    const after = Number(await redisCommand(['LLEN', READY_KEY]) || 0);
    console.log(`[deal-pool] terminé : before=${before}, after=${after}, added=${built}`);
}

main().catch(err => {
    console.error('[deal-pool] ECHEC:', err && err.stack || err);
    process.exitCode = 1;
});
