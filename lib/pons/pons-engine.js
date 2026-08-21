// pons-engine.js — adaptateur navigateur PLAY -> Pons 0.11.0-dev compilé en WebAssembly.
//
// Aucun serveur local, aucun WBridge5 : Pons tourne directement dans l'onglet de l'hôte.
// L'API historique de PLAY est conservée via window.decideRobotCallForApp(...).
(function(root){
  'use strict';

  const VERSION = 'PONS BIG v2.61 — RÉOUVERTURE APRÈS BARRAGE 2♥ FAIBLE PERFORMANCE';
  const USE_EXTERNAL_COHERENCE = false;
  const USE_PONS_CRITIC = true;
  const USE_SEMANTIC_LEDGER = true;
  // Les hulls PONS ne pilotent plus aucune décision depuis semantic-v0.4 : ils servent
  // uniquement à l'audit diagnostique. Leur calcul est coûteux sur certaines longues
  // enchères ; on le coupe donc dans le PLAY utilisateur tout en gardant la possibilité
  // de le réactiver dans les scripts d'audit dédiés.
  const USE_PONS_HULL_AUDIT = false;
  const PUBLIC_PLAY_URL = 'https://capgui13.github.io/play/';

  // Le moteur canonique présent dans PLAY reste un filet de sécurité si Pons ne sait pas
  // traiter une séquence ou si le module WASM ne peut pas être chargé.
  const localFallback = root.decideRobotCall;

  let moduleApi = null;
  let engineLabel = 'Pons 0.11.0-dev';
  let loadError = null;

  function renderStatus(kind, text){
    if(typeof document === 'undefined') return;
    const el = document.getElementById('ponsEngineStatus');
    if(!el) return;
    el.className = `wbridge-status ${kind === 'ok' ? 'is-online' : 'is-offline'}`;
    el.textContent = text;
  }

  const readyPromise = (async () => {
    try {
      renderStatus('wait', '🧠 PONS : chargement du moteur WebAssembly…');
      // Version portable : pons-wasm-embedded.js est chargé juste avant ce fichier et
      // initialise EXACTEMENT les mêmes octets WASM que PONS v2.61(9). Cela évite le
      // blocage des import()/fetch() sous file:// tout en restant identique sur GitHub Pages.
      const mod = root.PonsWasmModule;
      if(!mod || typeof mod.pons_bid !== 'function') throw new Error('module PONS embarqué absent');
      moduleApi = mod;
      engineLabel = typeof mod.pons_engine === 'function' ? mod.pons_engine() : 'Pons WASM';
      loadError = null;
      renderStatus('ok', '🧠 MOTEUR ACTIF : PONS BIG v2.61 — RÉOUVERTURE APRÈS BARRAGE 2♥ FAIBLE PERFORMANCE · prêt');
      console.info(`[${VERSION}] ${engineLabel} chargé.`);
      return mod;
    } catch (err) {
      loadError = err;
      console.error(`[${VERSION}] chargement WASM impossible`, err);
      renderStatus('error', '❌ PONS v2.61 WASM NON CHARGÉ — robots PONS bloqués (aucun fallback silencieux)');
      return null;
    }
  })();


  function hcpOfHand(deal, seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{};
    const pts={A:4,K:3,Q:2,J:1,R:3,D:2,V:1};
    let n=0;
    for(const s of ['S','H','D','C']) for(const r of String(h[s]||'')) n+=pts[r]||0;
    return n;
  }
  function lensOfHand(deal, seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{};
    return {S:String(h.S||'').length,H:String(h.H||'').length,D:String(h.D||'').length,C:String(h.C||'').length};
  }
  function prettyCall(call){
    const c=String(call||'').toUpperCase();
    if(c==='PASS') return 'Passe'; if(c==='X') return 'Contre'; if(c==='XX') return 'Surcontre';
    const m=c.match(/^([1-7])(C|D|H|S|NT)$/); if(!m) return c;
    return `${m[1]}${({C:'♣',D:'♦',H:'♥',S:'♠',NT:'SA'})[m[2]]}`;
  }
  function forcingLabel(v){
    const x=String(v||'').toLowerCase();
    if(!x||x==='unknown') return '';
    if(x.includes('game')) return 'forcing de manche';
    if(x.includes('one_round')) return 'forcing un tour';
    if(x.includes('nonforcing')) return 'non forcing';
    return x.replaceAll('_',' ');
  }
  function semanticSummary(sem){
    if(!sem) return [];
    const out=[];
    if(sem.convention) out.push(`Convention : ${String(sem.convention).replaceAll('-',' ')}`);
    const f=forcingLabel(sem.forcing); if(f) out.push(`Statut : ${f}`);
    if(sem.hcp && (sem.hcp.min!=null || sem.hcp.max!=null)){
      const a=sem.hcp.min, b=sem.hcp.max;
      out.push(`Force promise : ${a!=null?a:'?'}${b!=null&&b!==a?'–'+b:''} H`);
    }
    const suitNames={S:'♠',H:'♥',D:'♦',C:'♣'};
    const suits=[];
    for(const s of ['S','H','D','C']){
      const r=sem.suits?.[s]; if(!r) continue;
      if(r.min!=null && r.min>0) suits.push(`${suitNames[s]} ${r.min}+`);
    }
    if(suits.length) out.push(`Longueurs promises : ${suits.join(', ')}`);
    if(sem.natural===true) out.push('Nature : naturelle');
    else if(sem.natural===false) out.push('Nature : artificielle');
    return out;
  }
  function buildHumanExplanation({call,rawCall,score,reviewed,semGuard,deal,seat}){
    const lines=[];
    // Une revue Critic verte signifie précisément « ne rien changer » : son motif
    // interne (ex. « aucun veto général certain ») est du diagnostic DEV, pas une
    // explication d'enchère destinée au joueur. On n'affiche donc un motif de garde
    // que lorsqu'une couche a réellement modifié la décision.
    const criticChanged = !!reviewed?.changed && rawCall !== call;
    const semanticChanged = !!semGuard?.changed;
    const mainReason = criticChanged ? (reviewed?.reason || '') : (semanticChanged ? (semGuard?.reason || '') : '');
    if(mainReason) lines.push(mainReason);
    if(criticChanged && reviewed?.semantic) lines.push(...semanticSummary(reviewed.semantic));
    if(!mainReason && !criticChanged){
      const L=lensOfHand(deal,seat), H=hcpOfHand(deal,seat), c=String(call||'').toUpperCase();
      const b=c.match(/^([1-7])(C|D|H|S|NT)$/);
      if(c==='PASS') lines.push(`Passe retenu par PONS avec ${H} H et une distribution ${L.S}-${L.H}-${L.D}-${L.C}.`);
      else if(c==='X') lines.push(`Contre retenu par PONS avec ${H} H et une distribution ${L.S}-${L.H}-${L.D}-${L.C}.`);
      else if(c==='XX') lines.push(`Surcontre retenu par PONS avec ${H} H et une distribution ${L.S}-${L.H}-${L.D}-${L.C}.`);
      else if(b){
        const strain=b[2];
        if(strain==='NT') lines.push(`${prettyCall(c)} retenu par PONS avec ${H} H et une distribution ${L.S}-${L.H}-${L.D}-${L.C}.`);
        else lines.push(`${prettyCall(c)} retenu par PONS : ${L[strain]} carte${L[strain]>1?'s':''} dans la couleur, ${H} H, distribution ${L.S}-${L.H}-${L.D}-${L.C}.`);
      }
    }
    if(rawCall && rawCall!==call) lines.push(`Correction du choix brut ${prettyCall(rawCall)} → ${prettyCall(call)}.`);
    if(score!=null) lines.push(`Score PONS : ${Number(score).toFixed(3)}.`);
    return lines.filter(Boolean).join(' · ');
  }

  function handToPons(deal, seat){
    const h = deal?.hands?.[String(seat).toUpperCase()];
    if(!h) throw new Error(`main ${seat} absente`);
    return [h.S || '', h.H || '', h.D || '', h.C || ''].join('.');
  }

  function callToPons(call){
    const c = String(call || '').toUpperCase();
    if(c === 'PASS') return 'P';
    if(c === 'X' || c === 'XX') return c;
    if(/^([1-7])(C|D|H|S|NT)$/.test(c)) return c;
    throw new Error(`annonce PLAY non reconnue: ${call}`);
  }

  function auctionToPons(history){
    return (history || [])
      .map(x => callToPons(typeof x === 'string' ? x : x?.call))
      .join(' ');
  }

  function debugCallToPlay(raw){
    const s = String(raw || '').trim();
    const direct = s.toUpperCase();
    if(direct === 'P' || direct === 'PASS') return 'PASS';
    if(direct === 'X' || direct === 'DOUBLE') return 'X';
    if(direct === 'XX' || direct === 'REDOUBLE') return 'XX';
    if(/^([1-7])(C|D|H|S|NT)$/.test(direct)) return direct;

    if(s === 'Pass') return 'PASS';
    if(s === 'Double') return 'X';
    if(s === 'Redouble') return 'XX';

    const m = s.match(/level:\s*Level\((\d)\).*?strain:\s*(Clubs|Diamonds|Hearts|Spades|Notrump)/i);
    if(!m) throw new Error(`réponse Pons inconnue: ${s}`);
    const strain = {
      clubs:'C', diamonds:'D', hearts:'H', spades:'S', notrump:'NT'
    }[m[2].toLowerCase()];
    return `${m[1]}${strain}`;
  }

  function parsePonsResult(text){
    const raw = String(text || '');
    const cut = raw.lastIndexOf('|');
    const bidPart = cut >= 0 ? raw.slice(0, cut) : raw;
    const scorePart = cut >= 0 ? raw.slice(cut + 1) : '';
    const score = Number.parseFloat(scorePart);
    return {
      call: debugCallToPlay(bidPart),
      rawBid: bidPart,
      score: Number.isFinite(score) ? score : null,
      raw
    };
  }

  function engineBid(mod, hand, auction, deal){
    const dealer = String(deal?.dealer || 'N').toUpperCase();
    const vulnerability = String(deal?.vulnerable || 'None');
    if(typeof mod.pons_bid_v2 === 'function'){
      return mod.pons_bid_v2(hand, auction, dealer, vulnerability);
    }
    return mod.pons_bid(hand, auction);
  }

  function engineDiagnose(mod, hand, auction, deal){
    if(!mod || typeof mod.pons_diagnose !== 'function') return null;
    const dealer = String(deal?.dealer || 'N').toUpperCase();
    const vulnerability = String(deal?.vulnerable || 'None');
    try { return JSON.parse(mod.pons_diagnose(hand, auction, dealer, vulnerability)); }
    catch (_) { return null; }
  }

  function engineInfer(mod, auction, deal){
    if(!mod || typeof mod.pons_infer_hulls !== 'function') return null;
    const dealer = String(deal?.dealer || 'N').toUpperCase();
    const vulnerability = String(deal?.vulnerable || 'None');
    try { return JSON.parse(mod.pons_infer_hulls(auction, dealer, vulnerability)); }
    catch (_) { return null; }
  }

  function isLegal(history, call, seat){
    return typeof root.isCallLegal !== 'function' || root.isCallLegal(history || [], call, seat);
  }

  function fallbackDecision(seat, deal, history, reason){
    if(typeof localFallback === 'function'){
      const fallback = localFallback(seat, deal, history) || {call:'PASS'};
      return {
        ...fallback,
        explanation: `${fallback.explanation || 'Moteur canonique'} · repli PONS (${reason})`
      };
    }
    return {call:'PASS', explanation:`Passe de sécurité · PONS indisponible (${reason})`};
  }

  async function decideRobotCallForApp(seat, deal, history, _robotSeats){
    try {
      const mod = moduleApi || await readyPromise;
      if(!mod || typeof mod.pons_bid !== 'function'){
        throw loadError || new Error('module Pons non chargé');
      }
      const hand = handToPons(deal, seat);
      const auction = auctionToPons(history);
      const started = performance.now();
      const parsed = parsePonsResult(engineBid(mod, hand, auction, deal));
      const elapsed = performance.now() - started;

      if(!isLegal(history, parsed.call, seat)){
        return fallbackDecision(seat, deal, history, `annonce ${parsed.call} illégale rejetée par PLAY`);
      }

      let finalCall = parsed.call;
      let guardReason = '';
      let decisionSource = 'pons';
      // Le diagnostic complet n'est recalculé que lorsque PASS est réellement envisagé.
      // C'est alors qu'il sert à la fois au Critic et au contrôle d'un éventuel forcing.
      const diagnosis = parsed.call === 'PASS' ? engineDiagnose(mod, hand, auction, deal) : null;
      let semanticContext = null;
      if(USE_SEMANTIC_LEDGER && root.PonsSemanticLedger && typeof root.PonsSemanticLedger.beforeDecision === 'function'){
        semanticContext = root.PonsSemanticLedger.beforeDecision({
          seat, deal, history, diagnosis,
          infer: USE_PONS_HULL_AUDIT ? (h) => engineInfer(mod, auctionToPons(h), deal) : null
        });
      }

      // Le Critic ne remplace pas le système PONS : il ne s'active que lorsqu'une
      // décision franchit un seuil de plausibilité très fort. La v0.2 reçoit aussi la
      // signification publique conservée par le journal sémantique du partenaire.
      // La v0.3 ne substitue automatiquement que dans les contextes explicitement couverts.
      let reviewed = null;
      let semanticGuardReview = null;
      if(USE_PONS_CRITIC && root.PonsCritic && typeof root.PonsCritic.review === 'function'){
        reviewed = root.PonsCritic.review({
          seat, deal, history, call: parsed.call, diagnosis, semanticContext,
          isLegal: (h,c,s) => isLegal(h,c,s)
        });
        if(reviewed?.changed && reviewed.call && isLegal(history, reviewed.call, seat)){
          finalCall = reviewed.call;
          decisionSource = 'critic';
          guardReason = ` · CRITIC RED: ${reviewed.reason}`;
          console.warn(`[${VERSION}] ${seat}: ${parsed.call} -> ${finalCall}`, reviewed);
        } else if(reviewed?.level === 'orange') {
          console.info(`[${VERSION}] CRITIC ORANGE ${seat}: ${parsed.call}`, reviewed);
        }
      }

      // Si une enchère produite par le Critic a explicitement été enregistrée comme
      // forcing un tour, le partenaire partage ce sens même si les tables PONS ne savent
      // pas reconstruire la convention. On ne substitue que le meilleur candidat PONS
      // non-PASS déjà disponible : pas d'invention d'une nouvelle convention ici.
      if(USE_SEMANTIC_LEDGER && root.PonsSemanticLedger && typeof root.PonsSemanticLedger.guardDecision === 'function'){
        const semGuard = root.PonsSemanticLedger.guardDecision({
          seat, deal, history, call: finalCall, diagnosis, semanticContext,
          isLegal: (h,c,s) => isLegal(h,c,s)
        });
        semanticGuardReview = semGuard || null;
        if(semGuard?.changed && semGuard.call && isLegal(history,semGuard.call,seat)){
          const beforeSem=finalCall;
          finalCall=semGuard.call;
          decisionSource='semantic';
          guardReason += ` · SEMANTIC RED: ${semGuard.reason}`;
          console.warn(`[${VERSION}] semantic ${seat}: ${beforeSem} -> ${finalCall}`,semGuard);
        }
      }

      if(USE_EXTERNAL_COHERENCE && root.PonsCoherence && typeof root.PonsCoherence.validate === 'function'){
        const checked = root.PonsCoherence.validate({
          seat, deal, history, call: parsed.call,
          isLegal: (h,c,s) => isLegal(h,c,s),
          fallback: (why) => fallbackDecision(seat, deal, history, why)
        });
        if(checked && checked.changed){
          finalCall = checked.call;
          guardReason = ` · correction structurelle: ${checked.reason}`;
          console.info(`[${VERSION}] ${seat}: ${parsed.call} -> ${finalCall} (${checked.reason})`);
        }
      }

      if(USE_SEMANTIC_LEDGER && root.PonsSemanticLedger && typeof root.PonsSemanticLedger.recordDecision === 'function'){
        try{
          root.PonsSemanticLedger.recordDecision({
            seat, deal, history, call: finalCall, originalCall: parsed.call,
            source: decisionSource, criticReview: reviewed,
            infer: USE_PONS_HULL_AUDIT ? (h) => engineInfer(mod, auctionToPons(h), deal) : null
          });
        }catch(semErr){ console.warn(`[${VERSION}] journal sémantique: enregistrement impossible`,semErr); }
      }

      return {
        call: finalCall,
        explanation: buildHumanExplanation({call:finalCall,rawCall:parsed.call,score:parsed.score,reviewed,semGuard:semanticGuardReview,deal,seat})
      };
    } catch (err) {
      // Intégration PLAY stricte : si le WASM n'a pas pu s'initialiser, ne jamais masquer
      // l'échec en produisant des enchères avec un autre moteur. Le PONS direct peut utiliser
      // son fallback pour une séquence sans candidat APRÈS chargement réussi ; ce comportement
      // reste intact. Seul l'échec d'initialisation du moteur est bloquant ici.
      if(!moduleApi && loadError){
        renderStatus('error', '❌ PONS v2.61 WASM NON CHARGÉ — robots PONS bloqués (aucun fallback silencieux)');
        console.error(`[${VERSION}] décision annulée : WASM indisponible`, loadError);
        throw loadError;
      }
      console.warn(`[${VERSION}] Pons sans décision`, err);
      // Certaines conventions explicites ajoutées par le Critic (Multi-Landy/Rubensohl/Drury)
      // mènent ponctuellement PONS dans une position qu'il n'a aucune table native pour classer.
      // Avant de basculer vers le moteur canonique générique, on donne donc au Critic la
      // possibilité de fournir UNIQUEMENT une continuation qu'il connaît explicitement.
      if(USE_PONS_CRITIC && root.PonsCritic && typeof root.PonsCritic.review === 'function'){
        try{
          const repaired=root.PonsCritic.review({
            seat, deal, history, call:'PASS', diagnosis:null, semanticContext:null,
            isLegal:(h,c,s)=>isLegal(h,c,s)
          });
          if(repaired?.call && repaired?.semantic?.source && isLegal(history,repaired.call,seat)){
            if(USE_SEMANTIC_LEDGER && root.PonsSemanticLedger && typeof root.PonsSemanticLedger.recordDecision === 'function'){
              try{root.PonsSemanticLedger.recordDecision({seat,deal,history,call:repaired.call,originalCall:'NO_CANDIDATE',source:'critic',criticReview:repaired,infer:null});}catch(_){}
            }
            console.info(`[${VERSION}] ${seat}: no-candidate PONS -> ${repaired.call} (${repaired.reason})`);
            return {call:repaired.call,explanation:buildHumanExplanation({call:repaired.call,rawCall:'PASS',score:null,reviewed:repaired,semGuard:null,deal,seat})};
          }
        }catch(criticErr){console.warn(`[${VERSION}] réparation Critic no-candidate impossible`,criticErr);}
      }
      if(USE_EXTERNAL_COHERENCE && root.PonsCoherence && typeof root.PonsCoherence.repairNoDecision === 'function'){
        try {
          const repaired = root.PonsCoherence.repairNoDecision({
            seat, deal, history,
            isLegal: (h,c,s) => isLegal(h,c,s),
            reclassify: (rewrittenHistory) => {
              if(!moduleApi || typeof moduleApi.pons_bid !== 'function') return null;
              const raw = engineBid(moduleApi, handToPons(deal, seat), auctionToPons(rewrittenHistory), deal);
              return parsePonsResult(raw).call;
            }
          });
          if(repaired?.call && isLegal(history,repaired.call,seat)){
            console.info(`[${VERSION}] ${seat}: no-candidate -> ${repaired.call} (${repaired.reason})`);
            return {
              call: repaired.call,
              explanation: `Réparation structurelle : ${repaired.reason}`
            };
          }
        } catch (repairErr) {
          console.warn(`[${VERSION}] réparation no-candidate impossible`, repairErr);
        }
      }
      return fallbackDecision(seat, deal, history, err?.message || String(err));
    }
  }

  function publicRoomUrl(currentUrl, roomCode){
    try{
      const here = new URL(currentUrl);
      const isLocal = ['127.0.0.1','localhost'].includes(here.hostname);
      const u = isLocal ? new URL(PUBLIC_PLAY_URL) : here;
      u.searchParams.set('room', roomCode);
      return u.toString();
    }catch(_){
      return currentUrl;
    }
  }

  // Exposé immédiatement (avant même que le WASM ait fini de charger) afin que app.js
  // sache que Pons est le moteur actif et n'effectue pas de pré-calcul avec l'ancien moteur.
  root.PonsEngine = {
    VERSION,
    PUBLIC_PLAY_URL,
    ready: readyPromise,
    decideRobotCallForApp,
    publicRoomUrl,
    handToPons,
    auctionToPons,
    parsePonsResult,
    diagnose(seat, deal, history){
      if(!moduleApi) return null;
      return engineDiagnose(moduleApi, handToPons(deal, seat), auctionToPons(history), deal);
    },
    infer(deal, history){
      if(!moduleApi) return null;
      return engineInfer(moduleApi, auctionToPons(history), deal);
    },
    semanticReport(deal){
      return root.PonsSemanticLedger?.report?.(deal) || null;
    },
    localFallback,
    integrationMode: 'STRICT_WASM_STARTUP',
    get engineLabel(){ return engineLabel; },
    get loaded(){ return !!moduleApi; },
    get error(){ return loadError; }
  };
  root.decideRobotCallForApp = decideRobotCallForApp;
})(typeof window !== 'undefined' ? window : globalThis);
