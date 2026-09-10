'use strict';

// Sous-ensemble strict du sampler R66 de PLAY utilisé uniquement pour enrichir le
// réservoir serveur. representativeSourceIndex() est volontairement l'identité dans PLAY
// (R68) : aucun code de stratification rejeté n'est nécessaire ici.

const SEATS = ['N', 'E', 'S', 'W'];
const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = 'AKQJT98765432';
const STATISTICAL_PAR_SAMPLING_SEED_VERSION = 'r66-par-distribution-precision-v12-sync-lineage-conditioning-epoch-seat-perspective-stability-auction-lineage-dealerpar-adaptive-public';

function xmur3(text) {
    let h = 1779033703 ^ String(text).length;
    for (let i = 0; i < String(text).length; i++) {
        h = Math.imul(h ^ String(text).charCodeAt(i), 3432918353);
        h = h << 13 | h >>> 19;
    }
    return function () {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return (h ^= h >>> 16) >>> 0;
    };
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function canonicalKnownCards(deal, config) {
    const seats = ((config && (config.knownSeats || config.humanSeats)) || []).slice().sort();
    return seats.map(seat => seat + ':' + SUITS.map(suit => String(deal && deal.hands && deal.hands[seat] && deal.hands[seat][suit] || '')).join('.')).join('|');
}

function deterministicSeedMaterial(deal, config, sampleIndex) {
    const poolSeedId = String(deal && deal.statisticalSeedId || '').trim();
    if (!poolSeedId) throw new Error('statisticalSeedId requis pour le sampler de pool');
    return [
        STATISTICAL_PAR_SAMPLING_SEED_VERSION,
        'pool',
        poolSeedId,
        String(config && config.mode || ''),
        canonicalKnownCards(deal, config),
        String(sampleIndex)
    ].join('~');
}

function deterministicRngForSample(deal, config, sampleIndex) {
    return mulberry32(xmur3(deterministicSeedMaterial(deal, config, sampleIndex))());
}

function standardDeck() {
    const deck = [];
    for (const suit of SUITS) for (const rank of RANKS) deck.push(suit + rank);
    return deck;
}

function cardsFromHand(hand) {
    const cards = [];
    for (const suit of SUITS) {
        for (const rank of String(hand && hand[suit] || '')) cards.push(suit + rank);
    }
    return cards;
}

function remainingDeckFromHumanHands(deal, knownSeats) {
    if (!deal || !deal.hands) throw new Error('Donne invalide : mains absentes.');
    if (!Array.isArray(knownSeats) || (knownSeats.length !== 1 && knownSeats.length !== 2)) {
        throw new Error('Une ou deux mains connues sont requises.');
    }
    const seen = new Set();
    for (const seat of knownSeats) {
        const cards = cardsFromHand(deal.hands[seat]);
        if (cards.length !== 13) throw new Error(`Main connue ${seat} invalide : ${cards.length} cartes.`);
        for (const card of cards) {
            if (seen.has(card)) throw new Error(`Carte connue dupliquée : ${card}.`);
            seen.add(card);
        }
    }
    const remaining = standardDeck().filter(card => !seen.has(card));
    const expected = 52 - 13 * knownSeats.length;
    if (remaining.length !== expected) throw new Error(`Paquet résiduel invalide : ${remaining.length} cartes.`);
    return remaining;
}

function shuffledCopy(cards, rng) {
    const out = cards.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const r = Number(rng());
        const bounded = Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.9999999999999999) : 0;
        const j = Math.floor(bounded * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function handFromCards(cards) {
    const bySuit = { S: '', H: '', D: '', C: '' };
    const rankIndex = Object.fromEntries(Array.from(RANKS).map((r, i) => [r, i]));
    for (const card of cards) {
        const suit = card[0];
        const rank = card.slice(1);
        if (!SUITS.includes(suit) || rankIndex[rank] == null) throw new Error(`Carte invalide : ${card}`);
        bySuit[suit] += rank;
    }
    for (const suit of SUITS) {
        bySuit[suit] = Array.from(bySuit[suit]).sort((a, b) => rankIndex[a] - rankIndex[b]).join('');
    }
    return bySuit;
}

function sampleHandsDeterministic(deal, config, sampleIndex) {
    if (!config || !config.ok) throw new Error('Configuration PAR statistique invalide.');
    const knownSeats = Array.isArray(config.knownSeats) ? config.knownSeats : config.humanSeats;
    const randomizedSeats = Array.isArray(config.randomizedSeats)
        ? config.randomizedSeats
        : SEATS.filter(seat => !knownSeats.includes(seat));
    const pool = shuffledCopy(remainingDeckFromHumanHands(deal, knownSeats), deterministicRngForSample(deal, config, sampleIndex));
    if (pool.length !== randomizedSeats.length * 13) {
        throw new Error('Répartition statistique incompatible avec le nombre de sièges inconnus.');
    }
    const hands = {};
    for (const seat of knownSeats) hands[seat] = { ...deal.hands[seat] };
    randomizedSeats.forEach((seat, index) => {
        hands[seat] = handFromCards(pool.slice(index * 13, (index + 1) * 13));
    });
    return hands;
}

module.exports = {
    STATISTICAL_PAR_SAMPLING_SEED_VERSION,
    deterministicSeedMaterial,
    sampleHandsDeterministic
};
