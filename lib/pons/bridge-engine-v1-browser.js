// bridge-engine-v1-browser.js — runtime canonique sans interprétation de prose
(function(root){
'use strict';

// ===== src/notation.js =====
const SUIT_MAP = new Map([
  ['♣','C'], ['T','C'], ['C','C'], ['CLUB','C'], ['TREFLE','C'], ['TRÈFLE','C'],
  ['♦','D'], ['K','D'], ['D','D'], ['DIAMOND','D'], ['CARREAU','D'],
  ['♥','H'], ['H','H'], ['HEART','H'], ['COEUR','H'], ['CŒUR','H'],
  ['♠','S'], ['S','S'], ['SPADE','S'], ['PIQUE','S']
]);
const DENOM_ORDER = { C: 0, D: 1, H: 2, S: 3, N: 4 };

function normalizeSuit(suit) {
  if (!suit) return null;
  const s = String(suit).trim().toUpperCase();
  return SUIT_MAP.get(s) ?? null;
}

function normalizeBid(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replaceAll('*','').replace(/\s+/g,'');
  if (!s) return null;
  const u = s.toUpperCase();
  if (['P','PASS','PASSE'].includes(u)) return 'P';
  if (['X','CONTRE','DBL','DOUBLE'].includes(u)) return 'X';
  if (['XX','SURCONTRE','RDBL','REDOUBLE'].includes(u)) return 'XX';
  const m = u.match(/^([1-7])(SA|NT|N|♣|♦|♥|♠|T|K|C|D|H|S)$/);
  if (!m) return u;
  let denom = m[2];
  if (['SA','NT','N'].includes(denom)) denom = 'N';
  else denom = normalizeSuit(denom);
  return `${m[1]}${denom}`;
}

function displayBid(bid) {
  const b = normalizeBid(bid);
  if (b === 'P') return 'Passe';
  if (b === 'X' || b === 'XX') return b;
  const m = b?.match(/^([1-7])([CDHSN])$/);
  if (!m) return String(bid);
  return m[1] + ({C:'♣',D:'♦',H:'♥',S:'♠',N:'SA'}[m[2]]);
}

function normalizeAuction(auction = []) {
  return auction.map(normalizeBid).filter(Boolean);
}

function auctionKey(auction = []) {
  return normalizeAuction(auction).join('-');
}

function bidRank(bid) {
  const b = normalizeBid(bid);
  const m = b?.match(/^([1-7])([CDHSN])$/);
  if (!m) return null;
  return (Number(m[1]) - 1) * 5 + DENOM_ORDER[m[2]];
}

function bidSuit(bid) {
  const b = normalizeBid(bid);
  const m = b?.match(/^[1-7]([CDHS])$/);
  return m ? m[1] : null;
}

function isContractBid(bid) {
  return bidRank(bid) != null;
}

function isLegalBid(auction, rawBid) {
  const a = normalizeAuction(auction);
  const bid = normalizeBid(rawBid);
  if (!bid) return false;
  if (bid === 'P') return true;
  if (isContractBid(bid)) {
    const previous = a.filter(isContractBid).at(-1);
    return previous == null || bidRank(bid) > bidRank(previous);
  }
  // Seats: 0/2 partnership A, 1/3 partnership B. Current actor is a.length % 4.
  const actor = a.length % 4;
  let lastNonPassIndex = -1;
  for (let i=a.length-1; i>=0; i--) {
    if (a[i] !== 'P') { lastNonPassIndex = i; break; }
  }
  if (lastNonPassIndex < 0) return false;
  if (bid === 'X') {
    const last = a[lastNonPassIndex];
    if (!isContractBid(last)) return false;
    return (lastNonPassIndex % 2) !== (actor % 2);
  }
  if (bid === 'XX') {
    if (a[lastNonPassIndex] !== 'X') return false;
    let contractIndex = -1;
    for (let i=lastNonPassIndex-1; i>=0; i--) {
      if (isContractBid(a[i])) { contractIndex=i; break; }
      if (a[i] === 'XX') return false;
    }
    return contractIndex >= 0 && (contractIndex % 2) === (actor % 2);
  }
  return false;
}


// ===== src/hand.js =====

const HCP = { A:4, R:3, K:3, D:2, Q:2, V:1, J:1 };
const SUITS = ['S','H','D','C'];
const SYMBOLS = { '♠':'S', '♥':'H', '♦':'D', '♣':'C' };

function normalizeCards(cards='') {
  return String(cards)
    .toUpperCase()
    .replaceAll('10','T')
    .replace(/[\s.\-]/g,'')
    .replaceAll('K','R').replaceAll('Q','D').replaceAll('J','V');
}

function parseHand(input) {
  if (!input) throw new Error('Main absente');
  if (typeof input === 'string') {
    const suits = {S:'',H:'',D:'',C:''};
    const re = /([♠♥♦♣])\s*([^♠♥♦♣]*)/g;
    let m, found=0;
    while ((m=re.exec(input))) {
      suits[SYMBOLS[m[1]]] = normalizeCards(m[2]); found++;
    }
    if (found !== 4) throw new Error('Format attendu : ♠... ♥... ♦... ♣...');
    return analyzeHand(suits);
  }
  const suits = {S:'',H:'',D:'',C:''};
  for (const [k,v] of Object.entries(input)) {
    const suit = normalizeSuit(k);
    if (suit) suits[suit] = normalizeCards(v);
  }
  return analyzeHand(suits);
}

function analyzeHand(suitsInput) {
  const suits = Object.fromEntries(SUITS.map(s => [s, normalizeCards(suitsInput[s] ?? '')]));
  const lengths = Object.fromEntries(SUITS.map(s => [s, suits[s].length]));
  const totalCards = Object.values(lengths).reduce((a,b)=>a+b,0);
  if (totalCards !== 13) throw new Error(`Une main doit contenir 13 cartes (reçu : ${totalCards})`);
  let hcp=0, aces=0, kings=0;
  for (const cards of Object.values(suits)) {
    for (const r of cards) { hcp += HCP[r] ?? 0; if (r==='A') aces++; if (r==='R') kings++; }
  }
  const longPoints = Object.values(lengths).reduce((sum,n)=>sum+Math.max(0,n-4),0);
  const sorted = Object.values(lengths).sort((a,b)=>b-a);
  const shape = SUITS.map(s=>lengths[s]).join('-');
  const balancedShapes = new Set(['4-3-3-3','4-4-3-2','5-3-3-2']);
  const sortedShape = [...Object.values(lengths)].sort((a,b)=>b-a).join('-');
  return {
    suits, lengths, hcp, hl: hcp + longPoints, longPoints,
    aces, kings, shape,
    balanced: balancedShapes.has(sortedShape),
    semiBalanced: sorted[3] >= 2,
    maxSuitLength: sorted[0]
  };
}

function distributionPoints(hand, fitSuit=null, partnerTrumpMin=null) {
  if (!fitSuit) return 0;
  let d=0;
  for (const s of SUITS) {
    if (s===fitSuit) continue;
    const n=hand.lengths[s];
    if (n===0) d += 3;
    else if (n===1) d += 2;
    else if (n===2) d += 1;
  }
  // Points d'atouts only when the partnership actually KNOWS the combined
  // trump length. Chailley counts +2 for the known 9th trump, then +1 for each
  // additional trump. Do not assume that every major bid promises five cards
  // (Landy, doubles and several competitive conventions do not).
  if (partnerTrumpMin!=null) {
    if (partnerTrumpMin>0) {
      const totalKnown = hand.lengths[fitSuit] + partnerTrumpMin;
      if (totalKnown >= 9) d += 2 + Math.max(0,totalKnown-9);
    }
  } else {
    // Source-compilation / legacy fallback: when no partnership-state is
    // available, keep the historical major-fit assumption so source examples
    // are not reclassified merely because the runtime gained better knowledge.
    const n=hand.lengths[fitSuit];
    if ((fitSuit==='H'||fitSuit==='S') && n>=4) d += 2 + Math.max(0,n-4);
    else if (n>=5) d += n-4;
  }
  return d;
}

function hld(hand, fitSuit=null, partnerTrumpMin=null) {
  return hand.hl + distributionPoints(hand, fitSuit, partnerTrumpMin);
}

function hasStopper(hand, suit) {
  const cards=hand.suits[suit] || '';
  const n=cards.length;
  return cards.includes('A') || (cards.includes('R') && n>=2) || (cards.includes('D') && n>=3) || (cards.includes('V') && n>=4);
}

function hasStrongStopper(hand, suit) {
  const cards=hand.suits[suit] || '';
  const n=cards.length;
  return cards.includes('A') || (cards.includes('R') && n>=2 && /[ADV]/.test(cards.replace('R',''))) || (cards.includes('D') && n>=3 && (cards.includes('V') || cards.includes('T')));
}

function hasDoubleStopper(hand, suit) {
  const cards=hand.suits[suit] || '';
  const n=cards.length;
  if (n < 2) return false;
  if (cards.includes('A') && cards.includes('R')) return true;
  if (n >= 3 && cards.includes('A') && cards.includes('D') && cards.includes('V')) return true;
  if (n >= 3 && cards.includes('R') && cards.includes('D')) return true;
  return false;
}

function suitQuality(hand, suit) {
  const cards=hand.suits[suit] || '';
  const top = [...cards].reduce((n,r)=>n + ({A:4,R:3,D:2,V:1,T:0.5}[r] ?? 0),0);
  return top + Math.max(0,cards.length-4)*0.75;
}

function loserCountInSuit(hand, suit) {
  const c=hand.suits[suit] || '';
  const n=Math.min(c.length,3);
  if (n===0) return 0;
  let losers=n;
  if (c.includes('A')) losers--;
  if (c.length>=2 && c.includes('R')) losers--;
  if (c.length>=3 && c.includes('D')) losers--;
  return Math.max(0,losers);
}

function canonicalHandKey(hand) {
  return ['S','H','D','C'].map(s=>hand.suits[s]).join('|');
}


// ===== src/opening.js =====

function longestMinor(hand) {
  const c=hand.lengths.C, d=hand.lengths.D;
  if (c===d) return c===3 ? 'C' : 'D';
  return c>d ? 'C' : 'D';
}

function chooseOneLevelSuit(hand) {
  const h=hand.lengths.H, s=hand.lengths.S;
  if (h>=5 || s>=5) {
    if (h>=5 && s>=5) return h>s ? 'H' : 'S';
    return h>=5 ? 'H' : 'S';
  }
  return longestMinor(hand);
}

function chooseOpening(hand, context={}) {
  const seat=context.seat ?? 0;
  const passedHands=context.passedHands ?? seat;
  const reasons=[];

  // 2♦ forcing de manche : les fiches rappellent le seuil de 24HL quelle que soit la distribution.
  if (hand.hl >= 24) {
    return {bid:'2D', confidence:0.92, reason:[`24HL ou plus (${hand.hl}HL) : ouverture forcing de manche.`], source:'opening-baseline'};
  }

  // 2♣ fort indéterminé : super-SA 22-23HL ou main très forte non régulière.
  if ((hand.balanced && hand.hl>=22 && hand.hl<=23) || (hand.hl>=21 && hand.maxSuitLength>=6) || (hand.hl>=20 && hand.lengths.H>=5 && hand.lengths.S>=5)) {
    return {bid:'2C', confidence:0.82, reason:[`Main forte (${hand.hcp}H, ${hand.hl}HL) correspondant au 2♣ fort indéterminé.`], source:'opening-baseline'};
  }

  // 2SA : 20-21, main régulière. Les fiches mentionnent 4333/4432/5332 avec mineure 5e.
  if (hand.balanced && hand.hl>=20 && hand.hl<=21 && hand.lengths.H<5 && hand.lengths.S<5) {
    return {bid:'2N', confidence:0.95, reason:[`Main régulière ${hand.hl}HL : ouverture de 2SA.`], source:'opening-baseline'};
  }

  // Deux faible rigoureux, surtout en 1re/2e position : 6 cartes exactement, environ 6-10H, pas 4 cartes dans l'autre majeure.
  if (hand.hcp>=5 && hand.hcp<=10) {
    const weak=[];
    if (hand.lengths.H===6 && hand.lengths.S<=3) weak.push('H');
    if (hand.lengths.S===6 && hand.lengths.H<=3) weak.push('S');
    if (weak.length) {
      weak.sort((a,b)=>suitQuality(hand,b)-suitQuality(hand,a));
      return {bid:`2${weak[0]}`,confidence:0.82,reason:[`Deux faible : 6 cartes à ${weak[0]==='H'?'♥':'♠'}, ${hand.hcp}H.`],source:'opening-baseline'};
    }
  }

  // 1SA : 15-17, régulier, sans majeure 5e convenable dans ce profil.
  if (hand.balanced && hand.hcp>=15 && hand.hcp<=17 && hand.lengths.H<5 && hand.lengths.S<5) {
    return {bid:'1N',confidence:0.95,reason:[`Main régulière ${hand.hcp}H : ouverture de 1SA.`],source:'opening-baseline'};
  }

  // Barrage simple à 3 avec 7 cartes et force faible/modérée.
  if (hand.hcp<=10) {
    const seven=['S','H','D','C'].filter(s=>hand.lengths[s]>=7);
    if (seven.length) {
      seven.sort((a,b)=>suitQuality(hand,b)-suitQuality(hand,a));
      return {bid:`3${seven[0]}`,confidence:0.72,reason:[`Barrage : ${hand.lengths[seven[0]]} cartes dans la couleur et ${hand.hcp}H.`],source:'opening-baseline'};
    }
  }

  // Ouverture au palier de 1 : 12H ou 13HL, majeure cinquième puis meilleure mineure.
  if (hand.hcp>=12 || hand.hl>=13) {
    const suit=chooseOneLevelSuit(hand);
    return {bid:`1${suit}`,confidence:0.9,reason:[`${hand.hcp}H / ${hand.hl}HL : ouverture au palier de 1.`,`Priorité à la majeure 5e, sinon meilleure mineure.`],source:'opening-baseline'};
  }

  // En 3e position, une ouverture légère est possible : seuil volontairement prudent et configurable plus tard.
  if (passedHands>=2 && hand.hcp>=10 && Math.max(hand.lengths.H,hand.lengths.S)>=5) {
    const suit=hand.lengths.S>=hand.lengths.H?'S':'H';
    return {bid:`1${suit}`,confidence:0.55,reason:[`Ouverture légère de 3e position : ${hand.hcp}H et majeure longue.`],source:'opening-baseline'};
  }

  return {bid:'P',confidence:0.95,reason:[`${hand.hcp}H / ${hand.hl}HL : pas de valeur d'ouverture standard.`],source:'opening-baseline'};
}


// ===== src/universe.js =====

/**
 * Gold invariant encoded by the source corpus:
 *   S-* / fiche.type === direct       => silence adverse
 *   C-* / fiche.type === competitive  => enchères compétitives
 *
 * The engine must classify the live auction BEFORE looking up rules. There is
 * deliberately no S<->C fallback.
 */
function universeFromSource(sourceFile='', ficheType='') {
  const name=String(sourceFile || '');
  const prefix=name.startsWith('S') ? 'S' : name.startsWith('C-') ? 'C' : null;
  const byType=ficheType === 'direct' ? 'S' : ficheType === 'competitive' ? 'C' : null;
  if (prefix && byType && prefix !== byType) {
    throw new Error(`Incohérence préfixe/type: ${sourceFile} (${ficheType})`);
  }
  return prefix || byType;
}

function stripLeadingPassesBeforeOpening(auction=[]) {
  const a=normalizeAuction(auction);
  const i=a.findIndex(isContractBid);
  if (i < 0) return { leadingPasses:a.length, fromOpening:[] };
  return { leadingPasses:i, fromOpening:a.slice(i) };
}

/**
 * Classifies the CURRENT ACTOR'S decision from a real auction containing every
 * pass. We reason relative to the current actor's partnership, not merely to the
 * opening bid.
 *
 * Once the opponents of the current actor's partnership have made any non-pass
 * call, the position is competitive. If the current actor is on the side that
 * intervenes over the opening, the opening itself is already an opponent action,
 * so the universe is C immediately.
 */
function classifyAuction(auction=[]) {
  const full=normalizeAuction(auction);
  const {leadingPasses,fromOpening}=stripLeadingPassesBeforeOpening(full);
  if (!fromOpening.length) {
    return {
      universe:'O', mode:'opening', full, fromOpening:[], lookup:[],
      leadingPasses, actorRelativeSeat:full.length % 4,
      reason:'Aucun contrat n’a encore été annoncé.'
    };
  }

  // Index 0 = opener. The actor is the next relative index.
  const actorRelativeSeat=fromOpening.length % 4;
  const actorPartnershipParity=actorRelativeSeat % 2;
  const opponentActions=[];
  for (let i=0;i<fromOpening.length;i++) {
    if ((i % 2) === actorPartnershipParity) continue;
    if (fromOpening[i] !== 'P') opponentActions.push({index:i,call:fromOpening[i]});
  }

  if (opponentActions.length) {
    return {
      universe:'C', mode:'competitive', full, fromOpening,
      lookup:[...fromOpening], leadingPasses, actorRelativeSeat,
      actorPartnershipParity, opponentActions,
      reason:`Au moins une action non-Passe du camp adverse est présente (${opponentActions.map(x=>x.call).join(', ')}).`
    };
  }

  // In a genuine S position the actor is necessarily on opener's side, and the
  // odd calls are opponent passes. The compact source notation omits those passes.
  const lookup=fromOpening.filter((call,i)=>i % 2 === actorPartnershipParity && call !== 'P');
  return {
    universe:'S', mode:'direct', full, fromOpening, lookup,
    leadingPasses, actorRelativeSeat, actorPartnershipParity, opponentActions:[],
    reason:'Le camp adverse n’a produit que des Passes depuis l’ouverture.'
  };
}

function assertRuleUniverse(rule) {
  const expected=universeFromSource(rule.sourceFile,rule.type);
  if (!expected) return {ok:false,expected:null,actual:rule.universe ?? null,reason:'Source sans univers S/C.'};
  const actual=rule.universe || (rule.type==='direct'?'S':rule.type==='competitive'?'C':null);
  return {ok:actual===expected,expected,actual,reason:actual===expected?'ok':`attendu ${expected}, obtenu ${actual}`};
}


// ===== src/evaluator.js =====


const SYM={C:'♣',D:'♦',H:'♥',S:'♠',N:'SA'};

function inferPartnerSuit(auction) {
  const a=normalizeAuction(auction);
  const actor=a.length%4, partner=(actor+2)%4;
  for(let i=a.length-1;i>=0;i--) {
    if(i%4!==partner) continue;
    const s=bidSuit(a[i]); if(s) return s;
  }
  return null;
}

function inferFitSuit(rule,auction,context={}) {
  if(context.fitSuit) return context.fitSuit;
  if(rule.fitSuit) return rule.fitSuit;
  const text=rule.decisionText || '';
  const explicit=text.match(/(?:fit|soutien)[^♣♦♥♠]{0,30}([♣♦♥♠])/i);
  if(explicit) return {'♣':'C','♦':'D','♥':'H','♠':'S'}[explicit[1]];
  return inferPartnerSuit(auction);
}

function metricValue(metric,hand,fitSuit,context={}) {
  if(metric==='H') return hand.hcp;
  if(metric==='HL') return hand.hl;
  if(metric==='HLD') return fitSuit ? hld(hand,fitSuit,context?.partnerTrumpMin??null) : null;
  return null;
}

function evaluateCondition(c,hand,{fitSuit=null,context={}}={}) {
  if(c.kind==='always') return {pass:true,soft:Boolean(c.soft),unknown:false,label:c.source||'condition toujours vraie'};
  if(c.kind==='anyOf') {
    const cases=(c.cases||[]).map((conds,idx)=>{
      const checks=(conds||[]).map(x=>evaluateCondition(x,hand,{fitSuit,context}));
      const hard=checks.filter(x=>!x.soft);
      const hardFails=hard.filter(x=>!x.pass);
      const unknownHard=hard.filter(x=>x.unknown);
      return {index:idx,pass:hardFails.length===0,unknown:hard.length>0&&unknownHard.length===hard.length,checks};
    });
    const pass=cases.some(x=>x.pass);
    const unknown=!pass && cases.length>0 && cases.every(x=>x.unknown);
    return {pass,soft:Boolean(c.soft),unknown,label:`${pass?'alternative satisfaite':'aucune alternative satisfaite'} (${c.source||'OR'})`,cases};
  }
  if(c.kind==='suitTotal') {
    const v=(c.suits||[]).reduce((n,s)=>n+(hand.lengths[s]||0),0);
    const pass=(c.min==null||v>=c.min)&&(c.max==null||v<=c.max);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${(c.suits||[]).map(s=>SYM[s]||s).join('+')}=${v} (${c.source})`,value:v};
  }
  if(c.kind==='lengthCompare') {
    const left=hand.lengths[c.left], right=hand.lengths[c.right];
    const ops={'>=':(a,b)=>a>=b,'>':(a,b)=>a>b,'<=':(a,b)=>a<=b,'<':(a,b)=>a<b,'==':(a,b)=>a===b,'=':(a,b)=>a===b};
    const fn=ops[c.op]||ops['>='];
    const pass=fn(left,right);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${SYM[c.left]||c.left}=${left} ${c.op||'>='} ${SYM[c.right]||c.right}=${right} (${c.source})`,left,right};
  }
  if(c.kind==='pointsVsLength') {
    const v=metricValue(c.metric,hand,fitSuit,context);
    if(v==null) return {pass:false,unknown:true,soft:Boolean(c.soft),label:`${c.metric}: fit inconnu (${c.source})`};
    const threshold=Number(c.base||0)+(hand.lengths[c.suit]||0);
    const ops={'>=':(a,b)=>a>=b,'>':(a,b)=>a>b,'<=':(a,b)=>a<=b,'<':(a,b)=>a<b,'==':(a,b)=>a===b,'=':(a,b)=>a===b};
    const fn=ops[c.op]||ops['>='];
    const pass=fn(v,threshold);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${c.metric}=${v} ${c.op||'>='} ${c.base}+${SYM[c.suit]||c.suit}(${hand.lengths[c.suit]||0})=${threshold} (${c.source})`,value:v,threshold};
  }
  if(c.kind==='pointsByVulnerability') {
    const v=metricValue(c.metric,hand,fitSuit,context);
    if(v==null) return {pass:false,unknown:true,soft:Boolean(c.soft),label:`${c.metric}: valeur inconnue (${c.source})`};
    const vuln=Boolean(context?.vulnerable);
    const min=vuln ? c.vulnerableMin : c.nonVulnerableMin;
    const max=vuln ? c.vulnerableMax : c.nonVulnerableMax;
    const pass=(min==null||v>=min)&&(max==null||v<=max);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${c.metric}=${v} (${vuln?'V':'NV'}: ${min??'-'}-${max??'∞'} ; ${c.source})`,value:v,vulnerable:vuln};
  }
  if(c.kind==='points') {
    const v=metricValue(c.metric,hand,fitSuit,context);
    if(v==null) return {pass:false,unknown:true,soft:Boolean(c.soft),label:`${c.metric}: fit inconnu (${c.source})`};
    const pass=(c.min==null||v>=c.min)&&(c.max==null||v<=c.max);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${c.metric}=${v} (${c.source})`,value:v};
  }
  if(c.kind==='conditionalPointsByLength') {
    const n=hand.lengths[c.suit];
    if(n<c.minLength) return {pass:true,soft:Boolean(c.soft),unknown:false,label:`condition non déclenchée (${SYM[c.suit]}=${n} < ${c.minLength})`};
    const v=metricValue(c.metric,hand,fitSuit,context);
    if(v==null) return {pass:false,unknown:true,soft:Boolean(c.soft),label:`${c.metric}: fit inconnu (${c.source})`};
    const pass=(c.min==null||v>=c.min)&&(c.max==null||v<=c.max);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${SYM[c.suit]}=${n} ⇒ ${c.metric}=${v} (${c.min}-${c.max})`,value:v};
  }
  if(c.kind==='pointsAny') {
    const values=c.alternatives.map(a=>({a,v:metricValue(a.metric,hand,fitSuit,context)}));
    const pass=values.some(({a,v})=>v!=null&&(a.min==null||v>=a.min)&&(a.max==null||v<=a.max));
    const unknown=values.every(x=>x.v==null);
    return {pass,soft:Boolean(c.soft),unknown,label:`alternative points (${c.source})`,values:values.map(x=>({metric:x.a.metric,value:x.v}))};
  }
  if(c.kind==='length') {
    const v=hand.lengths[c.suit];
    const pass=(c.min==null||v>=c.min)&&(c.max==null||v<=c.max);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${SYM[c.suit]||c.suit}=${v} (${c.source})`,value:v};
  }
  if(c.kind==='shapeAny') {
    const sorted=Object.values(hand.lengths).sort((a,b)=>b-a).join('-');
    const pass=c.alternatives.some(x=>x.generic?sorted===x.pattern:hand.shape===x.pattern);
    return {pass,soft:Boolean(c.soft),unknown:false,label:`forme ${hand.shape} / triée ${sorted} (${c.source})`};
  }
  if(c.kind==='balanced') return {pass:hand.balanced===c.value,soft:Boolean(c.soft),unknown:false,label:`main ${hand.balanced?'régulière':'irrégulière'} (${c.source})`};
  if(c.kind==='aces') return {pass:hand.aces<=c.max,soft:Boolean(c.soft),unknown:false,label:`${hand.aces} As (${c.source})`};
  if(c.kind==='stopper') {
    const ok=c.strong?hasStrongStopper(hand,c.suit):hasStopper(hand,c.suit);
    return {pass:ok,soft:Boolean(c.soft),unknown:false,label:`${ok?'arrêt':'pas d’arrêt'} ${SYM[c.suit]} (${c.source})`};
  }
  if(c.kind==='doubleStopper') {
    const ok=hasDoubleStopper(hand,c.suit);
    return {pass:ok,soft:Boolean(c.soft),unknown:false,label:`${ok?'double arrêt':'pas de double arrêt'} ${SYM[c.suit]} (${c.source})`};
  }
  if(c.kind==='conditionalDoubleStopper') {
    const n=hand.lengths[c.lengthSuit];
    const triggered=n>=c.minLength;
    const ok=!triggered || hasDoubleStopper(hand,c.stopperSuit);
    return {pass:ok,soft:Boolean(c.soft),unknown:false,label:triggered?`${SYM[c.lengthSuit]}=${n} ⇒ ${ok?'double arrêt':'pas de double arrêt'} ${SYM[c.stopperSuit]} (${c.source})`:`condition non déclenchée (${SYM[c.lengthSuit]}=${n})`};
  }
  if(c.kind==='noStopper') {
    const ok=!hasStopper(hand,c.suit);
    return {pass:ok,soft:Boolean(c.soft),unknown:false,label:`${ok?'pas d’arrêt':'arrêt présent'} ${SYM[c.suit]} (${c.source})`};
  }
  if(c.kind==='noStrongStopper') {
    const ok=!hasStrongStopper(hand,c.suit);
    return {pass:ok,soft:Boolean(c.soft),unknown:false,label:`${ok?'pas de tenue renforcée':'tenue renforcée présente'} ${SYM[c.suit]} (${c.source})`};
  }
  if(c.kind==='losers') {
    const v=loserCountInSuit(hand,c.suit);
    return {pass:v<=c.max,soft:Boolean(c.soft),unknown:false,label:`${v} perdante(s) ${SYM[c.suit]} (${c.source})`,value:v};
  }
  if(c.kind==='suitQuality') {
    const v=suitQuality(hand,c.suit);
    return {pass:v>=c.min,soft:Boolean(c.soft),unknown:false,label:`qualité ${SYM[c.suit]}=${v.toFixed(1)} (${c.source})`,value:v};
  }
  if(c.kind==='topHonor') {
    const cards=hand.suits[c.suit]||'';
    const honors=['A','R','D'].filter(x=>cards.includes(x));
    const has=honors.length>0;
    const pass=c.value===false ? !has : has;
    return {pass,soft:Boolean(c.soft),unknown:false,label:`${pass?'condition honneur satisfaite':'condition honneur non satisfaite'} ${SYM[c.suit]} (${c.source})`,honors};
  }
  return {pass:true,soft:Boolean(c.soft),unknown:true,label:c.source||c.kind};
}

function evaluateRule(rule,hand,auction,context={}) {
  const fitSuit=inferFitSuit(rule,auction,context);
  const checks=(rule.conditions||[]).map(c=>evaluateCondition(c,hand,{fitSuit,context}));
  const hard=checks.filter(x=>!x.soft);
  const hardFails=hard.filter(x=>!x.pass);
  const unknownHard=hard.filter(x=>x.unknown);
  return {
    pass:hardFails.length===0,
    fitSuit,checks,hardFails,unknownHard,
    hardCount:hard.length,
    softCount:checks.length-hard.length
  };
}


// ===== src/v1/dsl.js =====


const CANONICAL_RULE_SCHEMA_VERSION = 1;

const ARTIFICIAL_RX=/(?:convention|conventionnel|cue-?bid|splinter|stayman|texas|landik|micha[eë]l|relais|appel aux majeures|contr[oô]le|4[eè]me\s+(?:couleur\s+)?(?:forcing|interrogative|économique|economique)|interrogative|super-?forcing|mixed\s+raise|rencontre|bicolore\s+majeur|spoutnik|contre|ni 4[^.]*ni 4)/i;

function sourceMeta(doc={}) {
  return {
    origin:doc.origine || null,
    sourcePdf:doc.source_pdf || null,
    sourceIndex:doc.source_index || null
  };
}

function isHardLengthConstraint(c,suit){
  if(!c || c.soft) return false;
  if(c.kind==='length' && c.suit===suit) return true;
  if(c.kind==='anyOf') {
    const cases=Array.isArray(c.cases)?c.cases:[];
    return cases.length>0 && cases.every(group=>{
      const items=Array.isArray(group)?group:[group];
      return items.some(x=>isHardLengthConstraint(x,suit));
    });
  }
  return false;
}

function legacyRuleToCanonical(rule,doc={}) {
  const bid=rule.bid;
  const suit=bidSuit(bid);
  const text=`${rule.decisionText||''} ${rule.description||''}`;
  const otherSuitPromise=Boolean(suit && (rule.conditions||[]).some(c=>!c.soft&&c.kind==='length'&&c.suit&&c.suit!==suit));
  const positiveBidSuitPromise=Boolean(suit && (rule.conditions||[]).some(c=>!c.soft&&c.kind==='length'&&c.suit===suit&&(c.min??0)>=3));
  const bidSuitMissingWhileOtherPromised=Boolean(suit && otherSuitPromise && !positiveBidSuitPromise);
  // A bid that explicitly promises 3+ cards in the named suit is natural for
  // partnership-knowledge purposes, even when its pedagogical description
  // contains words such as “rencontre” or mentions a contre. Conversely a
  // cue-bid/splinter/relay that promises only another suit remains artificial.
  const artificial=Boolean(suit && !positiveBidSuitPromise && (ARTIFICIAL_RX.test(text)||bidSuitMissingWhileOtherPromised));
  const naturalSuit=suit && !artificial ? suit : null;
  const meta=sourceMeta(doc);
  return {
    schemaVersion:CANONICAL_RULE_SCHEMA_VERSION,
    id:rule.id,
    position:{
      universe:rule.universe,
      lookup:normalizeAuction(rule.universe==='S'?(rule.sourceAuction||[]):(rule.auction||[])),
      fullAuction:normalizeAuction(rule.auction||[])
    },
    action:{bid,alert:Boolean(rule.alert)},
    semantics:{
      status:rule.status || null,
      forcing:['F','FM'].includes(rule.status),
      gameForcing:rule.status==='FM',
      artificial,
      naturalSuit,
      fallback:Boolean(rule.fallback),
      fitSuit:rule.fitSuit || null
    },
    constraints:Array.isArray(rule.conditions)?rule.conditions:[],
    ranking:{priority:Number(rule.priority||0),depth:Number(rule.depth||1)},
    safety:{
      selectable:Boolean(rule.selectionSafe && !rule.disabled && !rule.structuralInvalid),
      disabled:Boolean(rule.disabled),
      structuralInvalid:Boolean(rule.structuralInvalid),
      warnings:(rule.compilerWarnings||[]).map(w=>({kind:w.kind,severity:w.severity||'info'}))
    },
    provenance:{
      sourceFile:rule.sourceFile,
      sequence:rule.sequenceStr || null,
      type:rule.type || null,
      depth:Number(rule.depth||1),
      ...meta
    }
  };
}

function validateCanonicalRule(rule){
  const errors=[];
  if(rule?.schemaVersion!==CANONICAL_RULE_SCHEMA_VERSION) errors.push('schema-version');
  if(!rule?.id) errors.push('missing-id');
  if(!['S','C'].includes(rule?.position?.universe)) errors.push('invalid-universe');
  if(!rule?.action?.bid) errors.push('missing-bid');
  if(!Array.isArray(rule?.position?.lookup)) errors.push('missing-lookup');
  if(!Array.isArray(rule?.constraints)) errors.push('missing-constraints');
  if(!rule?.provenance?.sourceFile) errors.push('missing-source');
  const inv=assertRuleUniverse({universe:rule?.position?.universe,sourceFile:rule?.provenance?.sourceFile});
  if(!inv.ok) errors.push(`source-universe:${inv.reason}`);
  const ns=rule?.semantics?.naturalSuit;
  if(rule?.safety?.selectable && ns && !rule.constraints.some(c=>isHardLengthConstraint(c,ns))) errors.push('natural-suit-without-hard-length');
  return {ok:errors.length===0,errors};
}


// ===== src/v1/rule-index.js =====


class CanonicalRuleIndex {
  constructor(rules=[]) {
    this.rules=rules;
    this.byUniverse={S:new Map(),C:new Map()};
    this.byId=new Map();
    for(const r of rules){
      this.byId.set(r.id,r);
      const u=r?.position?.universe;
      if(!this.byUniverse[u]) continue;
      const key=auctionKey(r.position.lookup||[]);
      if(!this.byUniverse[u].has(key)) this.byUniverse[u].set(key,[]);
      this.byUniverse[u].get(key).push(r);
    }
  }
  lookup(auction){
    const classification=classifyAuction(auction);
    if(classification.universe==='O') return {classification,rules:[]};

    // Passed-hand conventions (Drury, réponses après Passe initial, etc.) are
    // distinct source positions such as S-P-1P-?.  The generic silence lookup
    // intentionally strips passes, so detect whether the CURRENT actor already
    // passed before the opening and prefer the passed-hand key when it exists.
    // This keeps the ordinary 1S-? rules from masking the dedicated
    // Passe-1S-? system.
    if(classification.universe==='S' && classification.leadingPasses>0){
      const full=classification.full||[];
      const actorSeat=full.length%4;
      const openingIndex=classification.leadingPasses;
      let actorPassedBeforeOpening=false;
      for(let i=0;i<openingIndex;i++){
        if(i%4===actorSeat && full[i]==='P'){ actorPassedBeforeOpening=true; break; }
      }
      if(actorPassedBeforeOpening){
        const passedKey=auctionKey(['P',...(classification.lookup||[])]);
        const passedRules=this.byUniverse.S.get(passedKey)||[];
        if(passedRules.length) return {classification:{...classification,passedHand:true,lookup:['P',...(classification.lookup||[])]},rules:passedRules};
      }
    }

    const key=auctionKey(classification.lookup);
    return {classification,rules:this.byUniverse[classification.universe].get(key)||[]};
  }
  get(id){return this.byId.get(id)||null;}
}


// ===== src/v1/knowledge.js =====

const KNOWLEDGE_SUITS=['S','H','D','C'];

function openingGuarantee(call){
  if(call==='1H') return {suits:{H:{min:5,max:null}},points:{H:{min:12,max:23}}};
  if(call==='1S') return {suits:{S:{min:5,max:null}},points:{H:{min:12,max:23}}};
  if(call==='1D') return {suits:{D:{min:3,max:null}},points:{H:{min:12,max:23}}};
  if(call==='1C') return {suits:{C:{min:3,max:null}},points:{H:{min:12,max:23}}};
  if(call==='1N') return {suits:{},points:{H:{min:15,max:17}}};
  return {suits:{},points:{}};
}

function guaranteedNaturalSuit(matching,call,universe){
  if(!matching.length) return universe==='O' ? bidSuit(call) : null;
  const vals=matching.map(r=>r.semantics?.artificial ? null : (r.semantics?.naturalSuit || bidSuit(call)));
  const first=vals[0]??null;
  return vals.every(v=>v===first)?first:null;
}

function mergeSuitMinimums(calls){
  const out={S:0,H:0,D:0,C:0};
  for(const x of calls){
    for(const s of KNOWLEDGE_SUITS){
      const m=x.guaranteed?.suits?.[s]?.min;
      if(m!=null) out[s]=Math.max(out[s],m);
    }
  }
  return out;
}

function hardConstraints(rule){return (rule.constraints||[]).filter(c=>!c.soft);}
function extractSimpleBounds(rule){
  const out={suits:{},points:{}};
  for(const c of hardConstraints(rule)){
    if(c.kind==='length' && KNOWLEDGE_SUITS.includes(c.suit)) out.suits[c.suit]={min:c.min??null,max:c.max??null};
    if(c.kind==='points' && ['H','HL'].includes(c.metric)) out.points[c.metric]={min:c.min??null,max:c.max??null};
  }
  return out;
}
function guaranteedAcross(bounds){
  if(!bounds.length) return {suits:{},points:{}};
  const out={suits:{},points:{}};
  for(const s of KNOWLEDGE_SUITS){
    if(bounds.every(b=>b.suits[s])){
      out.suits[s]={
        min:Math.min(...bounds.map(b=>b.suits[s].min??0)),
        max:bounds.every(b=>b.suits[s].max!=null)?Math.max(...bounds.map(b=>b.suits[s].max)):null
      };
    }
  }
  for(const m of ['H','HL']){
    if(bounds.every(b=>b.points[m])){
      out.points[m]={
        min:Math.min(...bounds.map(b=>b.points[m].min??0)),
        max:bounds.every(b=>b.points[m].max!=null)?Math.max(...bounds.map(b=>b.points[m].max)):null
      };
    }
  }
  return out;
}

function derivePartnershipState(index,auction){
  const a=normalizeAuction(auction);
  const actor=a.length%4;
  const partner=(actor+2)%4;
  const self=actor;
  const calls=[];
  for(let i=0;i<a.length;i++){
    const call=a[i];
    if(call==='P') continue;
    const seat=i%4;
    if(seat!==partner && seat!==self) continue;
    const prefix=a.slice(0,i);
    const {classification,rules}=index.lookup(prefix);
    const matching=rules.filter(r=>r.action.bid===call && r.safety.selectable);
    const role=seat===partner?'partner':'self';
    // Opening defaults are valid only for an actual opening call. Applying
    // them to an unmatched competitive call (e.g. 1♠ as an advance after a
    // double) invents 5 cards and opening strength. In competition, unknown
    // means unknown until a canonical rule formalises the call.
    const bounds=matching.length ? guaranteedAcross(matching.map(extractSimpleBounds)) : (classification.universe==='O' ? openingGuarantee(call) : {suits:{},points:{}});
    const naturalSuit=guaranteedNaturalSuit(matching,call,classification.universe);
    calls.push({role,seat,index:i,call,universe:classification.universe,candidateRules:matching.length,guaranteed:bounds,naturalSuit,forcing:matching.length>0&&matching.every(r=>r.semantics.forcing)});
  }
  const partnerCalls=calls.filter(x=>x.role==='partner');
  const selfCalls=calls.filter(x=>x.role==='self');
  const lastPartner=partnerCalls.at(-1)||null;
  const lastSelf=selfCalls.at(-1)||null;
  // A rebid in NT must not erase the natural suit(s) already shown by partner.
  // Walk backwards to the most recent natural-suit call instead of looking only
  // at the literal last call. This matters for HLD after e.g. 1D-1S-1NT or
  // 1H-1S-2NT.
  const lastPartnerNatural=partnerCalls.slice().reverse().find(x=>x.naturalSuit)||null;
  const lastSelfNatural=selfCalls.slice().reverse().find(x=>x.naturalSuit)||null;
  const partnerSuitMin=mergeSuitMinimums(partnerCalls);
  const selfSuitMin=mergeSuitMinimums(selfCalls);
  return {
    actorSeat:actor,partnerSeat:partner,
    calls,partnerCalls,selfCalls,lastPartner,lastSelf,lastPartnerNatural,lastSelfNatural,
    partnerLastNaturalSuit:lastPartnerNatural?.naturalSuit||null,
    selfLastNaturalSuit:lastSelfNatural?.naturalSuit||null,
    partnerSuitMin,selfSuitMin,
    partnerLastCallForcing:Boolean(lastPartner?.forcing)
  };
}


// ===== src/v1/resolver.js =====



function warningPenalty(rule){
  let p=0;
  for(const w of rule.safety?.warnings||[]){
    if(w.severity==='fatal') p+=1000; else if(w.severity==='warning') p+=8; else p+=1;
  }
  return p;
}
function metricSpecificity(c){
  if(c.kind==='points'||c.kind==='pointsByVulnerability'){
    if(c.min!=null&&c.max!=null) return Math.max(0,12-(c.max-c.min))*1.5+2;
    return 2;
  }
  if(c.kind==='length') return c.min!=null&&c.max!=null?9:5;
  if(['shapeAny','balanced','stopper','noStopper','losers','suitTotal','lengthCompare'].includes(c.kind)) return 7;
  if(c.kind==='anyOf') return 6;
  return 0;
}
function inferStructuredFitSuit(rule,knowledge,context){
  if(context?.fitSuit) return context.fitSuit;
  if(rule.semantics?.fitSuit) return rule.semantics.fitSuit;

  // HLD is evaluated in the prospective trump suit. If a rule itself bids a
  // suit and explicitly requires length in that same suit, that is stronger
  // evidence than a previous partner suit (e.g. 1C-1S-2NT-3S).
  const bidS=bidSuit(rule.action?.bid);
  const hasHld=(rule.constraints||[]).some(c=>
    (c.kind==='points' || c.kind==='pointsByVulnerability' || c.kind==='pointsAny') &&
    (c.metric==='HLD' || (c.alternatives||[]).some(a=>a.metric==='HLD'))
  );
  const partnerSuit=knowledge?.partnerLastNaturalSuit||null;
  const hardLengthMin=(c,suit)=>{
    if(!c || c.soft) return null;
    if(c.kind==='length' && c.suit===suit) return c.min??0;
    if(c.kind==='anyOf'){
      const mins=(c.cases||[]).map(group=>{
        const vals=(Array.isArray(group)?group:[group]).map(x=>hardLengthMin(x,suit)).filter(v=>v!=null);
        return vals.length?Math.max(...vals):null;
      });
      return mins.length && mins.every(v=>v!=null) ? Math.min(...mins) : null;
    }
    return null;
  };
  const explicitlyFitsPartner=partnerSuit && (rule.constraints||[]).some(c=>(hardLengthMin(c,partnerSuit)??0)>=3);
  if(hasHld && explicitlyFitsPartner) return partnerSuit;

  // A conventional partner call can guarantee a suit without being itself a
  // natural bid (Landy, Michaël, cue-bid bicolore...). In that case
  // partnerLastNaturalSuit is intentionally null, but partnerSuitMin still
  // contains the documentary guarantee. Use that information for HLD whenever
  // the current rule explicitly supports the same suit.
  if(hasHld && knowledge?.partnerSuitMin){
    const guaranteedFits=['S','H','D','C'].filter(s=>(knowledge.partnerSuitMin[s]||0)>0 && (rule.constraints||[]).some(c=>(hardLengthMin(c,s)??0)>=3));
    if(guaranteedFits.length===1) return guaranteedFits[0];
    if(guaranteedFits.length>1){
      guaranteedFits.sort((a,b)=>(knowledge.partnerSuitMin[b]||0)-(knowledge.partnerSuitMin[a]||0));
      return guaranteedFits[0];
    }
  }

  const promisesBidSuit=bidS && (rule.constraints||[]).some(c=>(hardLengthMin(c,bidS)??0)>=3);
  if(hasHld && promisesBidSuit) return bidS;

  return partnerSuit;
}
function evaluateCanonicalRule(rule,hand,knowledge,context){
  const fitSuit=inferStructuredFitSuit(rule,knowledge,context);
  const evalContext={...context,partnerTrumpMin:fitSuit ? (knowledge?.partnerSuitMin?.[fitSuit]||0) : null};
  const checks=(rule.constraints||[]).map(c=>evaluateCondition(c,hand,{fitSuit,context:evalContext}));
  const hard=checks.filter(x=>!x.soft);
  const hardFails=hard.filter(x=>!x.pass);
  const unknownHard=hard.filter(x=>x.unknown);
  return {pass:hardFails.length===0,fitSuit,checks,hardFails,unknownHard,hardCount:hard.length,softCount:checks.length-hard.length};
}
function scoreRule(rule,ev){
  let score=ev.hardCount*22+ev.softCount*2;
  for(const c of rule.constraints||[]) if(!c.soft) score+=metricSpecificity(c);
  score+=Number(rule.ranking?.priority||0);
  if(rule.semantics?.fallback) score-=45;
  if(rule.semantics?.status==='SU'||rule.semantics?.status==='?') score-=35;
  score-=warningPenalty(rule);
  return score;
}
function compactChecks(ev){return ev.checks.filter(x=>x.pass&&!x.soft).slice(0,6).map(x=>x.label);}

function resolveCanonicalRules({rules,hand,auction,classification,knowledge,context={},ambiguityMargin=8,traceData=null}){
  const candidates=[];
  for(const r of rules){
    const legal=Boolean(r.action?.bid)&&isLegalBid(auction,r.action.bid);
    const selectable=Boolean(r.safety?.selectable);
    if(traceData) traceData.candidates.push({ruleId:r.id,bid:r.action?.bid,source:r.provenance?.sourceFile,legal,selectable});
    if(!legal||!selectable) continue;
    const ev=evaluateCanonicalRule(r,hand,knowledge,context);
    if(!ev.pass){if(traceData) traceData.rejected.push({ruleId:r.id,bid:r.action.bid,reason:'hard-condition',fails:ev.hardFails.slice(0,4).map(x=>x.label)});continue;}
    const score=scoreRule(r,ev);
    candidates.push({rule:r,ev,score});
    if(traceData) traceData.matches.push({ruleId:r.id,bid:r.action.bid,source:r.provenance.sourceFile,score:Number(score.toFixed(2)),fallback:r.semantics.fallback,priority:r.ranking.priority,checks:ev.checks.filter(x=>x.pass&&!x.soft).slice(0,6).map(x=>x.label)});
  }
  if(!candidates.length) return {kind:'none'};

  const bestByBid=new Map();
  for(const x of candidates){const prev=bestByBid.get(x.rule.action.bid);if(!prev||x.score>prev.score) bestByBid.set(x.rule.action.bid,x);}
  let distinct=[...bestByBid.values()].sort((a,b)=>b.score-a.score||b.ev.hardCount-a.ev.hardCount);
  if(distinct.some(x=>!x.rule.semantics.fallback)) distinct=distinct.filter(x=>!x.rule.semantics.fallback);
  const best=distinct[0],runner=distinct[1];
  if(runner && best.score-runner.score<ambiguityMargin && best.rule.action.bid!==runner.rule.action.bid){
    return {kind:'ambiguous',best,runner,all:distinct};
  }
  const margin=runner?best.score-runner.score:20;
  const confidence=Math.max(.3,Math.min(.94,.58+margin/80-warningPenalty(best.rule)/100));
  return {kind:'chosen',best,runner,confidence,reasons:compactChecks(best.ev),all:distinct};
}

function resultFromResolution(res,{classification,rawRuleCount,safeRuleCount}){
  if(res.kind==='ambiguous') return {
    bid:'P',display:'Passe',confidence:.05,resolution:'ambiguous',universe:classification.universe,source:null,
    reason:[`Décision ambiguë : ${displayBid(res.best.rule.action.bid)} et ${displayBid(res.runner.rule.action.bid)} satisfont des règles structurées de force comparable.`],
    diagnostics:{candidateCount:rawRuleCount,safeCandidateCount:safeRuleCount,matchedCount:res.all.length,ambiguous:[res.best.rule.action.bid,res.runner.rule.action.bid]}
  };
  if(res.kind!=='chosen') return null;
  const r=res.best.rule;
  const reasons=res.reasons.length?res.reasons:[`Règle canonique ${r.id}.`];
  return {
    bid:r.action.bid,display:displayBid(r.action.bid),confidence:res.confidence,resolution:'rule',universe:classification.universe,
    source:r.provenance.sourceFile,sequence:r.provenance.sequence,ruleId:r.id,status:r.semantics.status,alert:r.action.alert,
    reason:reasons,description:'',principles:'',
    diagnostics:{candidateCount:rawRuleCount,safeCandidateCount:safeRuleCount,matchedCount:res.all.length}
  };
}


// ===== src/v1/engine.js =====







class BiddingEngineV1 {
  constructor(rules,{ambiguityMargin=8}={}){
    this.rules=rules;
    this.index=new CanonicalRuleIndex(rules);
    this.ambiguityMargin=ambiguityMargin;
  }
  classify(auction){return classifyAuction(auction);}
  getRules(auction){return this.index.lookup(auction);}
  knowledge(auction){return derivePartnershipState(this.index,auction);}

  chooseBid({hand:handInput,auction=[],context={},trace=false}={}){
    const hand=handInput?.hcp!=null?handInput:parseHand(handInput);
    const full=normalizeAuction(auction);
    const classification=classifyAuction(full);
    const knowledge=derivePartnershipState(this.index,full);
    const traceData=trace?{engine:'canonical-v1.4-dev',classification,knowledge,candidates:[],rejected:[],matches:[]}:null;

    if(classification.universe==='O'){
      const opening=chooseOpening(hand,{...context,passedHands:context.passedHands??classification.leadingPasses});
      const legal=isLegalBid(full,opening.bid); const bid=legal?opening.bid:'P';
      return {...opening,bid,display:displayBid(bid),status:'opening',alert:false,description:opening.reason.join(' '),sequence:'?',principles:'Module ouverture séparé.',universe:'O',resolution:'opening',diagnostics:{candidateCount:1,matchedCount:1,classification,knowledge,trace:traceData}};
    }

    const {rules}=this.index.lookup(full);
    if(!rules.length) return {bid:'P',display:'Passe',confidence:0,reason:[`Aucune règle canonique ${classification.universe} pour cette position.`],source:null,universe:classification.universe,resolution:'position-uncovered',diagnostics:{candidateCount:0,matchedCount:0,classification,knowledge,trace:traceData}};
    const safeRules=rules.filter(r=>r.safety.selectable && isLegalBid(full,r.action.bid));
    if(!safeRules.length) return {bid:'P',display:'Passe',confidence:.05,reason:['La position existe, mais aucune règle canonique sûre n’est sélectionnable.'],source:null,universe:classification.universe,resolution:'only-unsafe-rules',diagnostics:{candidateCount:rules.length,safeCandidateCount:0,matchedCount:0,classification,knowledge,trace:traceData}};

    const resolution=resolveCanonicalRules({rules,hand,auction:full,classification,knowledge,context,ambiguityMargin:this.ambiguityMargin,traceData});
    if(resolution.kind==='none') return {bid:'P',display:'Passe',confidence:.12,reason:['La position existe, mais aucune règle canonique sûre ne correspond à la main.'],source:null,universe:classification.universe,resolution:'no-rule-match',diagnostics:{candidateCount:rules.length,safeCandidateCount:safeRules.length,matchedCount:0,classification,knowledge,trace:traceData}};
    const result=resultFromResolution(resolution,{classification,rawRuleCount:rules.length,safeRuleCount:safeRules.length});
    result.diagnostics={...result.diagnostics,classification,knowledge,trace:traceData};
    return result;
  }
}


root.BridgeBiddingV1={normalizeSuit,normalizeBid,displayBid,normalizeAuction,auctionKey,bidRank,bidSuit,isContractBid,isLegalBid,parseHand,analyzeHand,distributionPoints,hld,hasStopper,hasStrongStopper,hasDoubleStopper,suitQuality,loserCountInSuit,canonicalHandKey,chooseOpening,universeFromSource,stripLeadingPassesBeforeOpening,classifyAuction,assertRuleUniverse,evaluateCondition,CANONICAL_RULE_SCHEMA_VERSION,isHardLengthConstraint,CanonicalRuleIndex,derivePartnershipState,resolveCanonicalRules,BiddingEngineV1};
})(typeof window!=='undefined'?window:globalThis);
