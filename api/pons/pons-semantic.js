// pons-semantic.js — journal sémantique partagé entre les bots PLAY.
//
// Objectif : conserver non seulement l'enchère produite, mais aussi ce qu'elle est
// censée communiquer. À chaque tour du partenaire, on compare cette intention avec
// ce que PONS reconstruit réellement de l'historique. Les contraintes sûres issues
// du Critic peuvent ensuite servir de garde-fou (notamment une enchère forcing).
(function(root){
  'use strict';

  const VERSION = 'semantic-v0.5-game-force-safe';
  const SEATS = ['N','E','S','W'];
  const SUITS = ['C','D','H','S']; // ordre des hulls PONS
  const boards = new Map();

  function seatIndex(s){ return SEATS.indexOf(String(s||'').toUpperCase()); }
  function partnerOf(s){ const i=seatIndex(s); return i<0?'':SEATS[(i+2)%4]; }
  function nextSeat(s){ const i=seatIndex(s); return i<0?'':SEATS[(i+1)%4]; }
  function sideOf(s){ return (s==='N'||s==='S')?'NS':'EW'; }
  function normCall(c){
    const x=String(c||'').trim().toUpperCase();
    if(x==='P'||x==='PASS'||x==='PASSE') return 'PASS';
    if(x==='DBL'||x==='DOUBLE'||x==='CONTRE') return 'X';
    if(x==='RDBL'||x==='REDOUBLE'||x==='SURCONTRE') return 'XX';
    return x.replace(/SA$/,'NT');
  }
  function parseBid(call){
    const m=normCall(call).match(/^([1-7])(NT|[CDHS])$/);
    return m ? {level:+m[1],strain:m[2]} : null;
  }
  function hcp(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{}; let n=0;
    for(const s of ['S','H','D','C']) for(const r of String(h[s]||'')) n+=r==='A'?4:r==='K'?3:r==='Q'?2:r==='J'?1:0;
    return n;
  }
  function lengths(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{};
    return Object.fromEntries(['C','D','H','S'].map(s=>[s,String(h[s]||'').length]));
  }
  function boardKey(deal){
    const hands=SEATS.map(s=>{
      const h=deal?.hands?.[s]||{};
      return `${s}:${h.S||''}.${h.H||''}.${h.D||''}.${h.C||''}`;
    }).join('|');
    return `${String(deal?.dealer||'N').toUpperCase()}|${String(deal?.vulnerable||'None')}|${hands}`;
  }
  function normHistory(history,deal){
    const dealer=seatIndex(String(deal?.dealer||'N').toUpperCase());
    return (history||[]).map((x,i)=>({
      seat:String((typeof x==='object'&&x?.seat)||SEATS[(dealer+i+4)%4]).toUpperCase(),
      call:normCall(typeof x==='string'?x:x?.call)
    }));
  }
  function signature(history,deal){ return normHistory(history,deal).map(x=>x.call).join(' '); }
  function getBoard(deal){
    const key=boardKey(deal);
    if(!boards.has(key)) boards.set(key,{key,entries:[],checks:[],createdAt:Date.now()});
    return boards.get(key);
  }
  function safeJson(v){ try{return typeof v==='string'?JSON.parse(v):v;}catch(_){return null;} }
  function range(r, fallbackMin=0, fallbackMax=37){
    if(Array.isArray(r)) return {min:Number(r[0]),max:Number(r[1])};
    if(r&&Number.isFinite(Number(r.min))&&Number.isFinite(Number(r.max))) return {min:Number(r.min),max:Number(r.max)};
    return {min:fallbackMin,max:fallbackMax};
  }
  function neutralMeaning(){
    return {suits:Object.fromEntries(SUITS.map(s=>[s,{min:0,max:13}])),hcp:{min:0,max:37},points:{min:0,max:37},forcing:'unknown',sources:[]};
  }
  function clone(v){ return v==null?v:JSON.parse(JSON.stringify(v)); }
  function validRange(r){ return r&&Number.isFinite(Number(r.min))&&Number.isFinite(Number(r.max))&&Number(r.min)<=Number(r.max); }
  function hullFromPons(env){
    if(!env) return null;
    const out={suits:{},hcp:range(env.hcp),points:range(env.points)};
    const a=Array.isArray(env.lengths)?env.lengths:[];
    SUITS.forEach((s,i)=>out.suits[s]=range(a[i],0,13));
    return out;
  }
  // pons_infer_hulls est utile mais n'est pas parfaitement sound sur les longues chaînes.
  // Au moment où un bot vient de parler, il connaît sa propre main : on peut diagnostiquer
  // qu'une borne d'inférence l'exclut. La version relâchée renvoyée par cette fonction sert
  // uniquement aux tests/diagnostics : elle ne doit JAMAIS être partagée au partenaire, car
  // le fait de relâcher conditionnellement une borne pourrait créer un canal d'information cachée.
  function sanitizeMeaningAgainstOwnHand(meaning,deal,seat){
    if(!meaning) return {meaning:null,diagnostics:[]};
    const out=clone(meaning), diagnostics=[], H=hcp(deal,seat), L=lengths(deal,seat);
    for(const s of SUITS){
      const r=out.suits?.[s]; if(!validRange(r)) continue;
      if(L[s]<r.min){ diagnostics.push({severity:'orange',type:'self_unsound_min_length',suit:s,inferred:clone(r)}); r.min=0; }
      if(L[s]>r.max){ diagnostics.push({severity:'orange',type:'self_unsound_max_length',suit:s,inferred:clone(r)}); r.max=13; }
    }
    if(validRange(out.hcp)){
      if(H<out.hcp.min){ diagnostics.push({severity:'orange',type:'self_unsound_min_hcp',inferred:clone(out.hcp)}); out.hcp.min=0; }
      if(H>out.hcp.max){ diagnostics.push({severity:'orange',type:'self_unsound_max_hcp',inferred:clone(out.hcp)}); out.hcp.max=37; }
    }
    // `points` dans PONS peut changer d'échelle avec le fit/distribution. Il reste stocké
    // dans rawPublicMeaning pour diagnostic, mais n'est pas partagé comme contrainte dure.
    out.points={min:0,max:37};
    return {meaning:out,diagnostics};
  }
  function intersectRangeSafe(a,b,label,conflicts,prefer='union'){
    a=validRange(a)?{min:Number(a.min),max:Number(a.max)}:null;
    b=validRange(b)?{min:Number(b.min),max:Number(b.max)}:null;
    if(!a) return b||null; if(!b) return a;
    const lo=Math.max(a.min,b.min), hi=Math.min(a.max,b.max);
    if(lo<=hi) return {min:lo,max:hi};
    conflicts.push({severity:'orange',type:'incompatible_ranges',dimension:label,left:a,right:b,policy:prefer});
    if(prefer==='right') return b;
    // En cas de contradiction entre deux lectures publiques, ne jamais créer min > max.
    // Le hull union est volontairement conservateur : il perd de la précision mais n'invente rien.
    return {min:Math.min(a.min,b.min),max:Math.max(a.max,b.max)};
  }
  function publicMeaningFromInference(inf,relativeIndex){
    const data=safeJson(inf); if(!data) return null;
    const arr=Array.isArray(data.announced)?data.announced:data.players;
    return hullFromPons(arr?.[relativeIndex]);
  }
  function partnerEntriesAlongBranch(board,seat,currentHistory,deal){
    const p=partnerOf(seat), hist=normHistory(currentHistory,deal), calls=hist.map(x=>x.call);
    return board.entries.filter(e=>{
      if(e.seat!==p||e.afterCalls.length>calls.length) return false;
      for(let i=0;i<e.afterCalls.length;i++) if(e.afterCalls[i]!==calls[i]) return false;
      return true;
    }).sort((a,b)=>a.afterCalls.length-b.afterCalls.length);
  }
  function latestPendingPartnerEntry(entries,seat,currentHistory,deal){
    const p=partnerOf(seat), hist=normHistory(currentHistory,deal);
    for(let j=entries.length-1;j>=0;j--){
      const e=entries[j], after=hist.slice(e.afterCalls.length);
      if(!after.some(x=>x.seat===p)) return e;
    }
    return null;
  }
  function mergeMeanings(meanings){
    const out=neutralMeaning(), conflicts=[];
    for(const m of meanings.filter(Boolean)){
      for(const s of SUITS) out.suits[s]=intersectRangeSafe(out.suits[s],m.suits?.[s],`length_${s}`,conflicts,'union')||out.suits[s];
      out.hcp=intersectRangeSafe(out.hcp,m.hcp,'hcp',conflicts,'union')||out.hcp;
      // points volontairement non utilisés comme contrainte inter-bots (voir sanitize).
      if(m.source) out.sources.push(m.source);
    }
    out.mergeConflicts=conflicts;
    return out;
  }
  function compareMeaning(intended,receiver){
    const issues=[];
    if(!intended||!receiver) return issues;
    for(const s of SUITS){
      const a=intended.suits?.[s], b=receiver.suits?.[s]; if(!a||!b) continue;
      if(a.min>0){
        if(b.max<a.min) issues.push({severity:'red',type:'contradiction_length',suit:s,intended:a,receiver:b});
        else if(b.min<a.min) issues.push({severity:'orange',type:'lost_length',suit:s,intended:a,receiver:b});
      }
      if(a.max<13 && b.min>a.max) issues.push({severity:'red',type:'invented_length',suit:s,intended:a,receiver:b});
    }
    const a=intended.hcp, b=receiver.hcp;
    if(a&&b){
      if(a.min>0){
        if(b.max<a.min) issues.push({severity:'red',type:'contradiction_hcp',intended:a,receiver:b});
        else if(b.min<a.min) issues.push({severity:'orange',type:'lost_hcp',intended:a,receiver:b});
      }
      if(a.max<37 && b.min>a.max) issues.push({severity:'red',type:'invented_hcp',intended:a,receiver:b});
    }
    return issues;
  }
  function opponentNonPassSince(entry,currentHistory,deal,seat){
    const h=normHistory(currentHistory,deal).slice(entry.afterCalls.length);
    return h.some(x=>sideOf(x.seat)!==sideOf(seat) && x.call!=='PASS');
  }
  function gameBidForSide(call){
    const b=parseBid(call); if(!b) return false;
    if(b.strain==='NT') return b.level>=3;
    if(b.strain==='H'||b.strain==='S') return b.level>=4;
    return b.level>=5;
  }
  function sideReachedGame(currentHistory,deal,seat){
    const side=sideOf(String(seat).toUpperCase());
    return normHistory(currentHistory,deal).some(x=>sideOf(x.seat)===side && gameBidForSide(x.call));
  }
  function sideEntriesAlongBranch(board,seat,currentHistory,deal){
    const side=sideOf(String(seat).toUpperCase()), hist=normHistory(currentHistory,deal), calls=hist.map(x=>x.call);
    return board.entries.filter(e=>{
      if(sideOf(e.seat)!==side||e.afterCalls.length>calls.length) return false;
      for(let i=0;i<e.afterCalls.length;i++) if(e.afterCalls[i]!==calls[i]) return false;
      return true;
    }).sort((a,b)=>a.afterCalls.length-b.afterCalls.length);
  }
  function callWasNewNaturalSuit(history,seat,call){
    const b=parseBid(call); if(!b||b.strain==='NT') return false;
    const side=sideOf(seat);
    const h=normHistory(history,{dealer:'N'}); // seats supplied by caller in PLAY; dealer irrelevant when present.
    const oppSuit=h.some(x=>sideOf(x.seat)!==side && parseBid(x.call)?.strain===b.strain);
    if(oppSuit) return false;
    const ownSuit=h.some(x=>sideOf(x.seat)===side && parseBid(x.call)?.strain===b.strain);
    return !ownSuit;
  }
  function criticMeaning({criticReview}){
    const sem=criticReview?.semantic;
    if(!sem) return null;
    const m=neutralMeaning();
    m.source=String(sem.source||'critic-explicit');
    m.sources=[m.source];
    m.natural=sem.natural===true?true:sem.natural===false?false:null;
    m.forcing=sem.forcing||'unknown';
    m.convention=sem.convention||null;
    if(sem.hcp) m.hcp=range(sem.hcp,0,37);
    for(const s of SUITS) if(sem.suits?.[s]) m.suits[s]=range(sem.suits[s],0,13);
    return m;
  }
  function mergePublicAndMeta(publicMeaning,meta){
    const out=publicMeaning?clone(publicMeaning):neutralMeaning(), conflicts=[];
    if(meta){
      for(const s of SUITS){
        const b=meta.suits?.[s];
        if(b && (b.min>0||b.max<13)) out.suits[s]=intersectRangeSafe(out.suits?.[s],b,`length_${s}`,conflicts,'right')||b;
      }
      if(meta.hcp && (meta.hcp.min>0||meta.hcp.max<37)) out.hcp=intersectRangeSafe(out.hcp,meta.hcp,'hcp',conflicts,'right')||meta.hcp;
      out.forcing=meta.forcing||'unknown'; out.natural=meta.natural; out.source=meta.source; out.sources=[...(out.sources||[]),...(meta.sources||[])]; out.convention=meta.convention||null;
    }
    return {meaning:out,conflicts};
  }
  function recordDecision(ctx){
    const {seat,deal,history,call,source,criticReview,infer}=ctx;
    const board=getBoard(deal); const before=normHistory(history,deal); const after=[...before,{seat:String(seat).toUpperCase(),call:normCall(call)}];
    let rawPublicMeaning=null;
    try { rawPublicMeaning=publicMeaningFromInference(infer?.(after),3); } catch(_) {}
    const selfAudit=sanitizeMeaningAgainstOwnHand(rawPublicMeaning,deal,seat);
    // Important : ne jamais partager la version conditionnellement relâchée à partir de la
    // main privée du bot. Le sens public natif reste exactement l'inférence PONS obtenue à
    // partir de l'enchère publique. Seule une sémantique Critic explicitement définie peut
    // ajouter/remplacer des contraintes partagées.
    const publicMeaning=clone(rawPublicMeaning);
    // Les hulls natifs PONS restent audit-only. Une sémantique supplémentaire n'est publiée
    // que si le Critic a réellement créé l'enchère dans une famille qu'il sait définir.
    // Cela évite de requalifier les annonces PONS natives (ex. un jump-shift faible) avec une
    // signification conventionnelle qui n'est pas la leur.
    // Une règle Critic peut exceptionnellement publier une signification même si
    // PONS avait déjà choisi exactement la même enchère. Ce droit est opt-in : il sert
    // aux conventions dont le contexte et la main rendent le sens certain (ex. réponses
    // à l'ouverture forcing de 2D). Les annonces PONS natives ordinaires restent audit-only.
    const publishNative=criticReview?.semantic?.publishWhenNative===true;
    const meta=(source==='critic'||publishNative)?criticMeaning(ctx):null;
    const merged=mergePublicAndMeta(publicMeaning,meta);
    const intended=merged.meaning;
    const diagnostics=[...selfAudit.diagnostics,...merged.conflicts];
    const key=after.map(x=>x.call).join(' ');
    const entry={
      id:`${board.entries.length+1}:${key}`,
      seat:String(seat).toUpperCase(), call:normCall(call), originalCall:normCall(ctx.originalCall||call), source:source||'pons',
      beforeCalls:before.map(x=>x.call), afterCalls:after.map(x=>x.call), intended, publicMeaning, rawPublicMeaning,
      explicitMeaning:meta?clone(meta):null,
      diagnostics, criticReason:source==='critic'&&meta?'substitution Critic à sémantique explicite':null, createdAt:Date.now(), receiverChecks:[]
    };
    // Remplace l'entrée si la même branche est rejouée (navigation entre donnes).
    const idx=board.entries.findIndex(e=>e.seat===entry.seat&&e.afterCalls.join(' ')===key);
    if(idx>=0) board.entries[idx]=entry; else board.entries.push(entry);
    return entry;
  }
  function beforeDecision(ctx){
    const {seat,deal,history,infer,diagnosis}=ctx;
    const board=getBoard(deal), entries=partnerEntriesAlongBranch(board,String(seat).toUpperCase(),history,deal);
    if(!entries.length) return {partnerMeaning:null,issues:[],forcingActive:false,entry:null,entries:[]};
    const entry=latestPendingPartnerEntry(entries,String(seat).toUpperCase(),history,deal);
    const cumulative=mergeMeanings(entries.map(e=>e.intended));
    const explicitList=entries.map(e=>e.explicitMeaning).filter(Boolean);
    const explicitCumulative=explicitList.length?mergeMeanings(explicitList):null;
    let receiver=null;
    try { receiver=publicMeaningFromInference(infer?.(history),2); } catch(_) {}
    const issues=compareMeaning(cumulative,receiver);
    for(const c of cumulative.mergeConflicts||[]) issues.push({...c,type:'semantic_merge_conflict'});
    let forcingActive=false, forcingMismatch=false, forcingKind=null, forcingEntry=null;
    if(entry?.explicitMeaning?.forcing==='one_round_if_uncontested' && !opponentNonPassSince(entry,history,deal,seat)){
      forcingActive=true; forcingKind='one_round'; forcingEntry=entry;
    }
    // Le 2D fort du SEF est forcing de manche, pas seulement forcing un tour. Le
    // ledger conserve donc le drapeau sur toute la ligne tant que le camp n'a pas
    // atteint un contrat de manche. Par prudence, l'automatisme s'éteint dès qu'un
    // adversaire se manifeste : les décisions compétitives exigent alors du jugement.
    const sideEntries=sideEntriesAlongBranch(board,String(seat).toUpperCase(),history,deal);
    const gf=[...sideEntries].reverse().find(e=>e.explicitMeaning?.forcing==='game_if_uncontested');
    if(gf && !opponentNonPassSince(gf,history,deal,seat) && !sideReachedGame(history,deal,seat)){
      forcingActive=true; forcingKind='game'; forcingEntry=gf;
    }
    if(forcingActive){
      // `diagnosis` n'est calculé que lorsque PONS envisage effectivement PASS dans PLAY.
      // On ne signale donc plus la simple présence théorique de PASS parmi des candidats :
      // ici un diagnostic présent signifie que le choix brut était bien PASS.
      const receiverPassChosen=!!diagnosis;
      forcingMismatch=receiverPassChosen;
      if(forcingMismatch) issues.push({severity:'red',type:'forcing_lost',intended:forcingKind==='game'?'forcing de manche':'forcing one round',receiver:'PASS choisi par PONS'});
    }
    const check={atCalls:normHistory(history,deal).map(x=>x.call),seat:String(seat).toUpperCase(),entryId:entry?.id||entries.at(-1)?.id,entryIds:entries.map(e=>e.id),receiver,intended:cumulative,explicitIntended:explicitCumulative,issues,forcingActive,forcingMismatch,forcingKind,forcingEntryId:forcingEntry?.id||null,time:Date.now()};
    for(const e of entries) e.receiverChecks.push(check); board.checks.push(check);
    if(issues.length){
      const reds=issues.filter(x=>x.severity==='red').length, last=entries.at(-1);
      console[reds?'warn':'info'](`[${VERSION}] semantic ${reds?'RED':'ORANGE'} ${partnerOf(seat)} -> ${seat}`,issues,{intended:cumulative,receiver,lastCall:last?.call});
    }
    // `partnerMeaning` est volontairement limité aux significations explicites : les hulls
    // PONS natifs restent un audit et ne peuvent pas influencer le Critic/les décisions.
    return {partnerMeaning:explicitCumulative,auditPartnerMeaning:cumulative,receiverMeaning:receiver,issues,forcingActive,forcingMismatch,forcingKind,forcingEntry,entry,entries};
  }
  function guardDecision(ctx){
    const call=normCall(ctx.call); const sem=ctx.semanticContext;
    if(call!=='PASS'||!sem?.forcingActive) return {changed:false,call,reason:'aucun forcing sémantique actif'};
    // Le système du partenaire a explicitement enregistré un forcing un tour. Si PONS
    // propose PASS malgré cela, choisir d'abord son meilleur candidat légal non-PASS.
    const top=Array.isArray(ctx.diagnosis?.top)?ctx.diagnosis.top:[];
    for(const c of top){
      const candidate=normCall(c.call);
      if(candidate==='PASS') continue;
      if(!ctx.isLegal || ctx.isLegal(ctx.history,candidate,ctx.seat)){
        return {changed:true,call:candidate,level:'red',reason:`forcing sémantique ${sem.forcingKind==='game'?'de manche':'un tour'} de ${sem.forcingEntry?.seat||sem.entry?.seat||'partenaire'} (${sem.forcingEntry?.call||sem.entry?.call||''}) : PASS interdit; meilleur candidat PONS non-PASS`};
      }
    }
    return {changed:false,call,level:'orange',reason:'forcing sémantique actif mais aucun candidat PONS non-PASS sûr'};
  }
  function report(deal){
    if(deal){ const b=getBoard(deal); return JSON.parse(JSON.stringify(b)); }
    const all=[...boards.values()];
    const checks=all.flatMap(b=>b.checks); const entries=all.flatMap(b=>b.entries);
    const issues=checks.flatMap(x=>x.issues||[]), diagnostics=entries.flatMap(e=>e.diagnostics||[]);
    const countByType=(xs)=>Object.fromEntries([...xs.reduce((m,x)=>m.set(String(x.type||'unknown'),(m.get(String(x.type||'unknown'))||0)+1),new Map())].sort((a,b)=>b[1]-a[1]));
    return {
      version:VERSION,boards:all.length,entries:entries.length,checks:checks.length,
      redIssues:issues.filter(x=>x.severity==='red').length,
      orangeIssues:issues.filter(x=>x.severity==='orange').length,
      forcingMismatches:checks.filter(x=>x.forcingMismatch).length,
      selfUnsoundInferenceBounds:diagnostics.filter(x=>String(x.type||'').startsWith('self_unsound_')).length,
      mergeConflicts:diagnostics.filter(x=>x.type==='incompatible_ranges').length + issues.filter(x=>x.type==='semantic_merge_conflict').length,
      issueCounts:countByType(issues), diagnosticCounts:countByType(diagnostics),
      data:JSON.parse(JSON.stringify(all))
    };
  }
  function clear(){ boards.clear(); }

  const api={VERSION,recordDecision,beforeDecision,guardDecision,report,clear,partnerOf,hcp,lengths,compareMeaning,sanitizeMeaningAgainstOwnHand,mergeMeanings,mergePublicAndMeta,criticMeaning};
  root.PonsSemanticLedger=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
