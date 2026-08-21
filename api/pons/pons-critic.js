// pons-critic.js — couche de jugement généraliste autour de PONS.
//
// Objectif : ne pas enseigner une table de conventions supplémentaire, mais détecter
// qu'une décision est très difficile à justifier avec les informations publiques.
// Le Critic n'intervient automatiquement qu'en niveau RED. Les cas ORANGE sont
// journalisés mais la décision PONS est conservée.
(function(root){
  'use strict';

  const VERSION = 'critic-v2.61-weak-jump-reopening-context-performance';
  const SEATS = ['N','E','S','W'];
  const SUITS = ['S','H','D','C'];
  const RANK = {C:0,D:1,H:2,S:3,NT:4};

  function partnerOf(seat){ return SEATS[(SEATS.indexOf(seat)+2)%4]; }
  function sideOf(seat){ return (seat==='N'||seat==='S') ? 'NS' : 'EW'; }
  function normHistory(history,deal){
    const dealer=SEATS.indexOf(String(deal?.dealer||'N').toUpperCase());
    return (history||[]).map((x,i)=>({
      seat:String((typeof x==='object'&&x?.seat)||SEATS[(dealer+i+4)%4]||'').toUpperCase(),
      call:String(typeof x==='string'?x:x?.call||'').toUpperCase()
    }));
  }
  function parseBid(call){
    const m=String(call||'').toUpperCase().match(/^([1-7])(NT|[CDHS])$/);
    return m ? {level:+m[1],strain:m[2]} : null;
  }
  function hcp(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{}; let n=0;
    for(const s of SUITS) for(const r of String(h[s]||'')) n += r==='A'?4:r==='K'?3:r==='Q'?2:r==='J'?1:0;
    return n;
  }
  function lengths(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{};
    return Object.fromEntries(SUITS.map(s=>[s,String(h[s]||'').length]));
  }
  function suitHcp(deal,seat,suit){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{}; let n=0;
    for(const r of String(h[suit]||'')) n += r==='A'?4:r==='K'?3:r==='Q'?2:r==='J'?1:0;
    return n;
  }
  function balanced(L){
    const a=SUITS.map(s=>L[s]).sort((x,y)=>x-y);
    // Le Critic emploie ici une notion volontairement souple de main régulière/semi-régulière :
    // les 5-4-2-2 peuvent parfois se traiter à Sans-Atout dans les cours PONS.
    return a[0]>=2 && a[3]<=5;
  }
  function strictBalanced(L){
    const a=SUITS.map(s=>L[s]).sort((x,y)=>x-y).join('-');
    return a==='3-3-3-4' || a==='2-3-4-4' || a==='2-3-3-5';
  }
  function lengthPoints(L){
    return SUITS.reduce((n,s)=>n+Math.max(0,(L[s]||0)-4),0);
  }
  function hlPoints(deal,seat){
    const L=lengths(deal,seat);
    return hcp(deal,seat)+lengthPoints(L);
  }
  function strongNtShape(L){
    if(strictBalanced(L)) return true;
    const a=SUITS.map(s=>L[s]).sort((x,y)=>x-y).join('-');
    // Le cours 27 assimile explicitement les 6-3-2-2 à une main semi-régulière
    // lorsque la couleur sixième est mineure. On ne généralise pas aux 5-4-2-2 ici,
    // car leur traitement dépend beaucoup de la qualité/localisation des honneurs.
    return a==='2-2-3-6' && (L.C===6||L.D===6);
  }
  function course30NtRebidShape(L){
    if(strongNtShape(L)) return true;
    const a=SUITS.map(s=>L[s]).sort((x,y)=>x-y).join('-');
    // Cours 30 : après 2D-2H/2S, l'ouvreur utilise beaucoup 2SA pour conserver
    // de l'espace. La majorité des 5-4-3-1 et 5-4-2-2 de la zone forte y passent,
    // sauf les mains avec cinq Piques qui disposent de la redemande économique 2S.
    return (a==='1-3-4-5'||a==='2-2-4-5') && L.S<5;
  }
  function losingTricks(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{}; let n=0;
    for(const s of SUITS){
      const cards=String(h[s]||''), len=cards.length;
      if(len>=1 && !cards.includes('A')) n++;
      if(len>=2 && !cards.includes('K')) n++;
      if(len>=3 && !cards.includes('Q')) n++;
    }
    return n;
  }
  // Estimation prudente des levées de jeu décrites dans le cours 27.
  // Elle n'est utilisée que pour les unicolores exactement septièmes, zone où la
  // règle du cours est explicite et où le noyau PONS ouvre presque toujours au palier 1.
  function playingTricksEstimate(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{}; let total=0;
    for(const s of SUITS){
      const c=String(h[s]||''), n=c.length;
      if(n===4) total+=0.5;
      else if(n===5) total+=1.5;
      else if(n>=6) total+=n-3;
      const A=c.includes('A'),K=c.includes('K'),Q=c.includes('Q'),J=c.includes('J');
      if(A) total+=1;
      if(K) total+=A?1:0.5;
      if(Q) total+=(A&&K)?1:(A||K||J)?0.5:0.25;
      if(J) total+=(A&&K&&Q)?1:Q?0.25:(A&&K)?0.5:0;
    }
    return Math.round(total*4)/4;
  }
  function defensiveTricksEstimate(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{}; let total=0;
    for(const s of SUITS){
      const c=String(h[s]||'');
      if(c.includes('A')) total+=1;
      if(c.includes('K')) total+=c.includes('A')?1:(c.length>=2?0.5:0.25);
    }
    return total;
  }
  function goodMajorFive(deal,seat,suit){
    const cards=String(deal?.hands?.[String(seat).toUpperCase()]?.[suit]||'');
    if(cards.length!==5) return false;
    const top=['A','K','Q'].filter(r=>cards.includes(r)).length;
    const support=['J','T','9'].filter(r=>cards.includes(r)).length;
    return top>=2 && support>=1;
  }
  function majorPreference(deal,seat,openerHearts=5,openerSpades=5){
    const L=lengths(deal,seat);
    const totalH=openerHearts+(L.H||0), totalS=openerSpades+(L.S||0);
    if(totalH!==totalS) return totalH>totalS?'H':'S';
    const qH=suitHcp(deal,seat,'H'), qS=suitHcp(deal,seat,'S');
    if(qH!==qS) return qH>qS?'H':'S';
    // A égalité complète, le palier de 4 à Pique rapporte davantage et la couleur
    // la plus chère est traditionnellement privilégiée dans un choix 5-5 équivalent.
    return 'S';
  }
  function hasBigHonor(deal,seat,suit){
    const cards=String(deal?.hands?.[String(seat).toUpperCase()]?.[suit]||'');
    return /[AKQ]/.test(cards);
  }
  function goodMinorSlamSupport(deal,seat,suit){
    const cards=String(deal?.hands?.[String(seat).toUpperCase()]?.[suit]||'');
    const honors=['A','K','Q','J'].filter(r=>cards.includes(r)).length;
    return honors>=2 || (cards.length>=3 && /[AKQ]/.test(cards));
  }
  function hasKingAndQueen(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{};
    const cards=SUITS.map(s=>String(h[s]||'')).join('');
    return cards.includes('K') && cards.includes('Q');
  }
  function aceSuits(deal,seat){
    const h=deal?.hands?.[String(seat).toUpperCase()]||{};
    return SUITS.filter(s=>String(h[s]||'').includes('A'));
  }
  function course30AceResponse(deal,seat){
    const A=aceSuits(deal,seat), H=hcp(deal,seat), L=lengths(deal,seat);
    if(A.length===0){
      // Réponse traditionnelle : 2SA avec 8+ H et au moins deux cartes partout,
      // sinon 2Cœur. Une courte autorise donc 2Cœur sans limite supérieure.
      if(H>=8 && SUITS.every(s=>L[s]>=2)) return '2NT';
      return '2H';
    }
    if(A.length===1){
      if(A[0]==='H'||A[0]==='S') return '2S';
      return A[0]==='C'?'3C':'3D';
    }
    if(A.length===2){
      const key=[...A].sort().join('');
      if(key==='DH'||key==='CS') return '3H'; // même couleur : rouges / noirs
      if(key==='HS'||key==='CD') return '3S'; // même rang : majeurs / mineurs
      return '3NT';                           // mélangés
    }
    return '4NT'; // trois As (et cas théorique des quatre As)
  }
  // Evaluation HLD utilisée uniquement dans le cas très précis du soutien de Cœur
  // après 1m-(1P)-X. Elle reproduit le comptage illustré dans le cours 12 :
  // points H + points de longueur au-delà de la 4e carte + points de courte dans
  // les couleurs latérales (doubleton 1, singleton 2, chicane 3).
  function supportHld(deal,seat,trump){
    const H=hcp(deal,seat), L=lengths(deal,seat); let v=H;
    for(const s of SUITS){
      const n=L[s];
      if(s!==trump){
        if(n>4) v += n-4;
        if(n===2) v += 1;
        else if(n===1) v += 2;
        else if(n===0) v += 3;
      }
    }
    return v;
  }
  // Evaluation HLD dédiée aux fits majeurs selon la doctrine Chailley/SEF :
  // les points L restent comptés dans toutes les couleurs, puis on ajoute les points D
  // hors atout ainsi que la plus-value du 9e atout (+2) et des suivants (+1 chacun).
  // `partnerKnownTrumps` est le minimum promis par les enchères, jamais une information
  // cachée sur la main du partenaire.
  function chailleyFitHld(deal,seat,trump,partnerKnownTrumps){
    const L=lengths(deal,seat); let v=hcp(deal,seat);
    for(const s of SUITS) v += Math.max(0,(L[s]||0)-4); // points L, atout compris
    for(const s of SUITS){
      if(s===trump) continue;
      const n=L[s]||0;
      if(n===2) v+=1; else if(n===1) v+=2; else if(n===0) v+=3;
    }
    const known=(L[trump]||0)+Math.max(0,partnerKnownTrumps||0);
    if(known>=9) v+=2+Math.max(0,known-9);
    return v;
  }
  function suitLosers(deal,seat,suit){
    const cards=String(deal?.hands?.[String(seat).toUpperCase()]?.[suit]||'');
    let n=0;
    if(cards.length>=1&&!cards.includes('A')) n++;
    if(cards.length>=2&&!cards.includes('K')) n++;
    if(cards.length>=3&&!cards.includes('Q')) n++;
    return n;
  }
  function trialComplement(deal,seat,suit){
    const cards=String(deal?.hands?.[String(seat).toUpperCase()]?.[suit]||'');
    const n=cards.length, honors=['A','K','Q','J'].filter(r=>cards.includes(r)).length;
    if(n<=1) return 'strong'; // coupe rapide
    if((cards.includes('A')||cards.includes('K'))&&n===2) return 'strong'; // Ax / Rx
    if(honors>=2||n>=5) return 'strong';
    if(n===2||/[AKQJ]/.test(cards)) return 'medium';
    return 'none';
  }
  function lastActualBid(history){
    for(let i=history.length-1;i>=0;i--){ if(parseBid(history[i].call)) return history[i]; }
    return null;
  }
  function firstContractBy(history,seat){
    return history.find(x=>x.seat===seat && !!parseBid(x.call)) || null;
  }
  function ownMeaningfulCalls(history,seat){
    return history.filter(x=>x.seat===seat && x.call!=='PASS');
  }
  function openingMinimum(call){
    const b=parseBid(call); if(!b) return 0;
    if(call==='1NT') return 15;
    if(call==='2NT') return 20;
    if(call==='2C') return 20;
    if(b.level===1) return 11; // volontairement prudent : ne pas sur-vétoter les 11 H possibles.
    if(b.level===2 && (b.strain==='H'||b.strain==='S')) return 5;
    return 0;
  }
  function openingEvent(history){
    return (history||[]).find(x=>!!parseBid(x.call)) || null;
  }
  function partnerRole(history,seat){
    const partner=partnerOf(seat), first=openingEvent(history), pFirst=firstContractBy(history,partner);
    return {partner,first,pFirst,isOpener:Boolean(first&&first.seat===partner&&pFirst===first)};
  }
  // Contexte volontairement étroit pour une substitution automatique : le partenaire
  // a ouvert de 1M, le répondant n'avait pas encore parlé, et l'adversaire de droite
  // intervient immédiatement naturellement à la couleur. C'est la famille réellement
  // validée par le cas utilisateur 1S-(2D)-3C ; ailleurs le Critic diagnostique mais
  // n'invente pas une signification naturelle/conventionnelle.
  function knownFreeBidContext(ctx){
    const history=normHistory(ctx.history,ctx.deal), seat=String(ctx.seat||'').toUpperCase(), partner=partnerOf(seat);
    const open=openingEvent(history), ob=parseBid(open?.call);
    if(!open||open.seat!==partner||!ob||ob.level!==1||!(ob.strain==='H'||ob.strain==='S')) return null;
    const openIdx=history.indexOf(open);
    if(history.slice(0,openIdx).some(x=>x.seat===seat&&x.call==='PASS')) return null; // répondant déjà passé
    if(history.some(x=>x.seat===seat&&x.call!=='PASS')) return null;
    const after=history.slice(openIdx+1);
    if(after.length!==1) return null;
    const over=after[0], ib=parseBid(over.call);
    if(!ib||ib.strain==='NT'||sideOf(over.seat)===sideOf(seat)) return null;
    // Ne pas présumer naturel un cue-bid de la couleur d'ouverture (Michaels, etc.)
    // ni une intervention à saut : ces familles ont leurs propres développements.
    if(ib.strain===ob.strain) return null;
    if(bidRank(over.call)-bidRank(open.call)>5) return null;
    return {opening:open,openingBid:ob,overcall:over,overcallBid:ib};
  }
  function cheapestSuitBidAfter(history,call){
    const b=parseBid(call); if(!b||b.strain==='NT') return false;
    const last=lastActualBid(history), lastRank=bidRank(last?.call);
    for(let level=1;level<=7;level++){
      const c=`${level}${b.strain}`;
      if(bidRank(c)>lastRank) return c===String(call||'').toUpperCase();
    }
    return false;
  }
  function cheapestSuitCallAfter(history,suit){
    const s=String(suit||'').toUpperCase();
    if(!SUITS.includes(s)) return null;
    const last=lastActualBid(history), lastRank=bidRank(last?.call);
    for(let level=1;level<=7;level++){
      const c=`${level}${s}`;
      if(bidRank(c)>lastRank) return c;
    }
    return null;
  }
  function knownSemanticForSubstitution(ctx,passInfo,choice){
    const family=knownFreeBidContext(ctx); if(!family) return null;
    const b=parseBid(choice?.call); if(!b||b.strain==='NT'||b.level!==3) return null;
    if(b.strain===family.openingBid.strain||b.strain===family.overcallBid.strain) return null;
    // Le cas validé est une nouvelle couleur au palier minimal disponible. Ne surtout pas
    // confondre avec un jump-shift : ex. 1H-(2C)-3D peut être une enchère faible dans PONS,
    // puisque 2D était disponible. 1S-(2D)-3C, lui, est bien le premier palier légal à C.
    if(!cheapestSuitBidAfter(ctx.history,choice.call)) return null;
    const H=passInfo.H ?? hcp(ctx.deal,ctx.seat), L=passInfo.L ?? lengths(ctx.deal,ctx.seat);
    // Si le répondant possède déjà un fit de 3+ cartes dans la majeure d'ouverture, le choix
    // entre soutien/cue-bid/nouvelle couleur dépend trop du système pour une substitution sûre.
    if(H<12||L[b.strain]<5||L[family.openingBid.strain]>=3||(choice?.confidence||0)<3) return null;
    return {
      natural:true,
      source:'critic-known-free-bid-cheapest',
      suits:{[b.strain]:{min:5,max:13}},
      hcp:{min:12,max:37},
      forcing:'one_round_if_uncontested',
      convention:'new-suit-free-bid-after-1M-overcall-cheapest'
    };
  }

  // Règles compétitives adossées directement aux cours PONS/Maury utilisés comme source
  // du système. Elles ne s'appliquent qu'à un PASS brut et à des séquences très étroites.
  // L'objectif est de combler des trous de couverture observés sans généraliser à d'autres
  // familles où le choix entre enchère naturelle, contre et cue-bid dépend du système.
  function knownCoursePassSubstitution(ctx){
    const history=normHistory(ctx.history,ctx.deal), seat=String(ctx.seat||'').toUpperCase(), partner=partnerOf(seat);
    if(history.some(x=>x.seat===seat&&x.call!=='PASS')) return null;
    const open=openingEvent(history); if(!open||open.seat!==partner) return null;
    const openIdx=history.indexOf(open), after=history.slice(openIdx+1);
    if(after.length!==1) return null; // intervention directe, répondant encore silencieux
    const over=after[0], ob=parseBid(open.call), ib=parseBid(over.call);
    if(!ob||!ib||sideOf(over.seat)===sideOf(seat)) return null;
    const H=hcp(ctx.deal,seat), L=lengths(ctx.deal,seat);

    // Cours 24 (mise au point plus récente du cours 12) : Spoutnik simple après 1m-(1P).
    // Pour une substitution automatique, on retient la formulation récente et non ambiguë :
    // exactement 4 Cœurs à partir de 8 H, ou 5 Cœurs avec 8-10 H. Les anciennes notes
    // autorisant des contres plus faibles avec 5/6 Cœurs restent à PONS au lieu d'être
    // imposées par l'overlay. Il n'est pas prioritaire lorsqu'une nouvelle mineure naturelle au palier de 2
    // est disponible ; on écarte donc ces mains de la substitution automatique.
    if((open.call==='1C'||open.call==='1D') && over.call==='1S'){
      const otherMinor=open.call==='1C'?'D':'C';
      const naturalMinor=(L[otherMinor]===5&&H>=11)||(L[otherMinor]>=6&&H>=9);
      const hlen=L.H;
      const spoutnik=(hlen===4&&H>=8)||(hlen===5&&H>=8&&H<=10);
      if(spoutnik && !naturalMinor && (!ctx.isLegal||ctx.isLegal(history,'X',seat))){
        return {
          call:'X',
          semantic:{
            natural:false,
            source:'course24-simple-spoutnik-after-1m-1S',
            suits:{H:{min:4,max:13}},
            // Borne commune à la formulation retenue du cours 24.
            hcp:{min:8,max:37},
            // Le contre négatif peut être transformé en pénalité par l'ouvreur dans
            // certaines mains : ne pas activer le veto PASS générique du ledger.
            forcing:'unknown',
            convention:'course24-simple-spoutnik'
          },
          reason:`cours 24 : contre Spoutnik simple après ${open.call}-(1S) avec ${hlen} Cœurs et ${H} H`
        };
      }
    }


    // Cours 24 : lorsque l'intervention laisse encore la place aux majeures au palier de 1,
    // le contre peut servir de « Spoutnik sans majeure » / demande d'arrêt. Pour garder une
    // substitution automatique très sûre, on ne couvre ici que les mains fortes (12+ H)
    // sans majeure quatrième annonçable, sans couleur naturelle 5e, sans fit mineur clair
    // et sans longueur de quatre cartes dans la couleur adverse (où un passe-piège peut être
    // intentionnel). Dans cette poche résiduelle, PASS contredit directement le cours.
    const noMajorSpoutnikFamily =
      (open.call==='1C' && (over.call==='1D'||over.call==='1H')) ||
      (open.call==='1D' && over.call==='1H');
    if(noMajorSpoutnikFamily && H>=8 && L[ib.strain]<=3 && L[ob.strain]<=4){
      const level1MajorAvailable=['H','S'].some(s=>L[s]>=4 && cheapestSuitBidAfter(history,`1${s}`));
      // Une couleur cinquième au palier de 2 n'est naturelle que si la force le permet.
      // C'est précisément l'un des usages du Spoutnik faible du cours 24 : avec 8-10 H
      // et seulement cinq cartes dans la nouvelle mineure, 2m serait trop fort.
      const naturalNewSuit=SUITS.some(s=>{
        if(s===ob.strain||s===ib.strain||L[s]<5) return false;
        if(cheapestSuitBidAfter(history,`1${s}`)) return true;
        if(!cheapestSuitBidAfter(history,`2${s}`)) return false;
        return (L[s]===5&&H>=11)||(L[s]>=6&&H>=9);
      });
      const naturalOneNT = H<=10 && balanced(L) && stopperScore(ctx.deal,seat,ib.strain)>=0.7;
      if(!level1MajorAvailable && !naturalNewSuit && !naturalOneNT && (!ctx.isLegal||ctx.isLegal(history,'X',seat))){
        const suitCaps={};
        for(const s of ['H','S']) if(cheapestSuitBidAfter(history,`1${s}`)) suitCaps[s]={min:0,max:3};
        return {
          call:'X',
          semantic:{
            natural:false,
            source:'course24-no-major-spoutnik-after-minor',
            suits:suitCaps,
            hcp:{min:8,max:37},
            forcing:'unknown',
            convention:'course24-spoutnik-stopper-ask'
          },
          reason:`cours 24 : contre Spoutnik sans majeure / demande d'arrêt après ${open.call}-(${over.call}), ${H} H sans enchère naturelle satisfaisante`
        };
      }
    }

    // Cours 12 : après 1♣-(1♦), une majeure au palier de 1 reste naturelle 4+ et
    // n'a pas de limite supérieure. Les mains faibles peuvent parfois passer selon
    // distribution/vulnérabilité ; l'overlay ne corrige donc que les mains 12+ H,
    // où PASS n'est plus défendable. Pour éviter d'inventer un choix 4-4 spécifique,
    // on n'agit que lorsqu'une seule majeure est disponible avec 4+ cartes.
    if(open.call==='1C'&&over.call==='1D'&&H>=12){
      const majors=['H','S'].filter(s=>L[s]>=4 && (!ctx.isLegal||ctx.isLegal(history,`1${s}`,seat)));
      if(majors.length===1){
        const s=majors[0], call=`1${s}`;
        return {
          call,
          semantic:{
            natural:true,
            source:'course12-major-level1-after-minor-overcall',
            suits:{[s]:{min:4,max:13}},
            hcp:{min:5,max:37},
            forcing:'unknown',
            convention:'course12-major-level1-after-1C-1D'
          },
          reason:`cours 12 : majeure ${s} naturelle au palier de 1 avec 4+ cartes; ${H} H rendent PASS injustifiable`
        };
      }
    }

    // Cours 12 : après 1♦-(2♣), le changement de majeure au palier de 2 sans saut
    // promet 5+ cartes ; seuil conservateur en H : 11+ avec cinq cartes, 8+ avec six.
    // Avec deux majeures de même longueur, la plus chère (♠) est prioritaire.
    if(open.call==='1D'&&over.call==='2C'){
      const eligible=['S','H'].filter(s=>{
        const len=L[s];
        if(len<5) return false;
        if(!((len>=6&&H>=8)||(len===5&&H>=11))) return false;
        const call=`2${s}`;
        return cheapestSuitBidAfter(history,call) && (!ctx.isLegal||ctx.isLegal(history,call,seat));
      }).sort((a,b)=>(L[b]-L[a]) || (a==='S'?-1:1));
      if(eligible.length){
        const s=eligible[0], call=`2${s}`;
        return {
          call,
          semantic:{
            natural:true,
            source:'course12-major-level2-after-minor-overcall',
            suits:{[s]:{min:5,max:13}},
            // La vraie borne est conditionnelle à la longueur (11+ avec 5, 8+ avec 6+).
            // On publie seulement la borne dure commune, donc 8+ H.
            hcp:{min:8,max:37},
            forcing:'one_round_if_uncontested',
            convention:'course12-major-level2-after-1D-2C'
          },
          reason:`cours 12 : ${call} naturel sans saut (${L[s]} cartes, ${H} H) doit remplacer PASS`
        };
      }
    }


    // Cours 23 (+ cours 12 pour les majeures après ouverture mineure) : une nouvelle
    // couleur au palier de 2 sans saut reste naturelle. Le seuil dépend de la longueur.
    // On ne couvre ici que les cas sans ambiguïté : une seule couleur candidate, aucune
    // majeure de quatre cartes encore annonçable au palier de 1, et pas de fit 3+ dans
    // une majeure d'ouverture. Cela évite de court-circuiter les Spoutnik et soutiens.
    const nonJumpDirect = ob.level===1 && ib.strain!=='NT' && ib.strain!==ob.strain &&
      bidRank(over.call)>bidRank(open.call) && (bidRank(over.call)-bidRank(open.call)<=5);
    if(nonJumpDirect){
      const level1MajorAvailable=['H','S'].some(s=>L[s]>=4 && cheapestSuitBidAfter(history,`1${s}`));
      const openerMajor=(ob.strain==='H'||ob.strain==='S');
      if(!level1MajorAvailable && !(openerMajor && L[ob.strain]>=3)){
        const eligible=SUITS.filter(s=>{
          if(s===ob.strain||s===ib.strain) return false;
          const call=`2${s}`, pb=parseBid(call);
          if(!pb || pb.level!==2 || !cheapestSuitBidAfter(history,call)) return false;
          if(ctx.isLegal && !ctx.isLegal(history,call,seat)) return false;
          const len=L[s]; if(len<5) return false;
          let min5=11, min6;
          if(s==='H'||s==='S') min6 = openerMajor ? 10 : 8;
          else min6 = 9;
          return (len===5&&H>=min5) || (len>=6&&H>=min6);
        });
        if(eligible.length===1){
          const s=eligible[0], call=`2${s}`, isMajor=(s==='H'||s==='S');
          const floor6=isMajor ? (openerMajor?10:8) : 9;
          return {
            call,
            semantic:{
              natural:true,
              source:'course23-natural-new-suit-level2-after-overcall',
              suits:{[s]:{min:5,max:13}},
              hcp:{min:floor6,max:37},
              forcing:'one_round_if_uncontested',
              convention:'course23-new-suit-level2-nonjump'
            },
            reason:`cours 23 : ${call} naturel sans saut (${L[s]} cartes, ${H} H) doit remplacer PASS`
          };
        }
      }
    }
    return null;
  }


  // v2.19 — dernière signification explicite publiée par le partenaire.
  // On scanne tout le ledger : après une action adverse, l'entrée pertinente n'est
  // pas nécessairement semanticContext.entry.
  function latestPartnerExplicitMeaning(ctx,predicate=null){
    const seat=String(ctx.seat||'').toUpperCase(), partner=partnerOf(seat);
    const entries=Array.isArray(ctx.semanticContext?.entries)?ctx.semanticContext.entries:[];
    for(let i=entries.length-1;i>=0;i--){
      const e=entries[i], x=e?.explicitMeaning;
      if(e?.seat!==partner || !x) continue;
      if(!predicate || predicate(x,e)) return x;
    }
    // Regression/unit tests and a few adapter paths expose only `entry` rather
    // than the complete `entries` array. Accept it as a compatibility fallback;
    // production auctions still use the partner-filtered scan above.
    const fallback=ctx.semanticContext?.entry?.explicitMeaning;
    if(fallback && (!predicate||predicate(fallback,ctx.semanticContext?.entry))) return fallback;
    return null;
  }

  // v1.9 — bloc de système prioritaire demandé pour PONS :
  // 1) Multi-Landy/Woolsey sur l'ouverture adverse de 1SA, avec X = mineure 5e + majeure 4e ;
  // 2) défense Rubensohl du camp de l'ouvreur de 1SA ;
  // 3) Drury fitté SEF 2024 après passe ;
  // 4) 1M-1SA forcing (accord utilisateur), en réactivant puis sécurisant le système natif PONS.
  //
  // Ces règles sont volontairement contextuelles : elles ne changent aucune autre famille PONS.
  function prioritySystemCorrection(ctx){
    const history=normHistory(ctx.history,ctx.deal), seat=String(ctx.seat||'').toUpperCase();
    const raw=String(ctx.call||'').toUpperCase(), partner=partnerOf(seat);
    const H=hcp(ctx.deal,seat), L=lengths(ctx.deal,seat), HL=hlPoints(ctx.deal,seat);
    const legal=(c)=>!ctx.isLegal||ctx.isLegal(history,c,seat);


    const vuln=(()=>{const v=String(ctx.deal?.vulnerable||'None');const side=sideOf(seat);return v==='Both'||v===side;})();
    const shortOutside=(trump)=>SUITS.some(s=>s!==trump&&L[s]<=1);
    const firstBidIndex=history.findIndex(x=>parseBid(x.call));
    // Relative auction from the actual opening bid. This keeps the convention active
    // in 2nd/3rd/4th seat after one or more initial passes.
    const ntHistory=(firstBidIndex>=0&&history[firstBidIndex]?.call==='1NT')?history.slice(firstBidIndex):[];
    const bids=history.filter(x=>parseBid(x.call));
    const previousPassBy=(who,until=history.length)=>history.slice(0,until).some(x=>x.seat===who&&x.call==='PASS');
    const sameSide=(a,b)=>sideOf(a)===sideOf(b);
    const sem=(source,convention,natural,forcing='nonforcing',extra={})=>({natural,source,forcing,publishWhenNative:true,convention,...extra});
    const out=(call,semantic,reason)=> legal(call)?{call,changed:raw!==call,semantic,reason}:null;

    // -------------------------------------------------------------------------
    // v2.22 — DEFENSE CONTRE LES BICOLORES MICHAEL SEF 2024.
    // Sources de reference: SEF 2024 / Bridge-Chailley. Les deux cue-bids sont FM:
    // le plus economique montre le fit dans la couleur d'ouverture; le second
    // promet cinq cartes dans la quatrieme couleur. Les soutiens faibles restent
    // competitifs; la quatrieme couleur a saut est une enchere de rencontre.
    function michaelFrame(){
      if(firstBidIndex<0) return null;
      const h=history.slice(firstBidIndex);
      if(h.length<2) return null;
      const open=h[0], over=h[1], ob=parseBid(open.call);
      if(!ob||ob.level!==1||sameSide(open.seat,over.seat)||!sameSide(open.seat,seat)) return null;
      let shown=null;
      if((ob.strain==='C'||ob.strain==='D') && over.call==='2D') shown=['H','S'];
      else if((ob.strain==='C'||ob.strain==='D') && over.call==='2NT') {
        const rem=SUITS.filter(x=>x!==ob.strain).sort((a,b)=>RANK[a]-RANK[b]); shown=rem.slice(0,2);
      } else if((ob.strain==='H'||ob.strain==='S') && over.call===`2${ob.strain}`) shown=[ob.strain==='H'?'S':'H','C'];
      else if((ob.strain==='H'||ob.strain==='S') && over.call==='2NT') shown=['C','D'];
      else if((ob.strain==='H'||ob.strain==='S') && over.call==='3C') shown=[ob.strain==='H'?'S':'H','D'];
      if(!shown) return null;
      const remaining=SUITS.find(x=>x!==ob.strain&&!shown.includes(x))||null;
      const cues=shown.map(s=>cheapestSuitCallAfter(h.slice(0,2),s)).filter(Boolean).sort((a,b)=>bidRank(a)-bidRank(b));
      return {h,open,over,ob,shown,remaining,cues};
    }
    const mf=michaelFrame();
    if(mf && mf.h.length===2 && mf.open.seat===partner){
      const tr=mf.ob.strain, fit=L[tr], hld=supportHld(ctx.deal,seat,tr);
      const minorOpen=(tr==='C'||tr==='D');
      const doubleStop=mf.shown.every(s=>stopperScore(ctx.deal,seat,s)>=0.7);
      const regular=strictBalanced(L);
      const cheapCue=mf.cues[0]||null, expensiveCue=mf.cues[1]||null;

      // v2.48 — défense SEF 2024 contre Michaël précisé.
      // Le Contre DIRECT est d'appel ; Passe puis Contre seulement devient punitif.

      // Rencontre : fit de l'ouverture + 5 cartes dans la dernière couleur.
      if(mf.remaining&&fit>=4&&L[mf.remaining]>=5&&HL>=13){
        const natural=cheapestSuitCallAfter(history,mf.remaining);
        const jump=natural?`${Math.min(7,+natural[0]+1)}${mf.remaining}`:null;
        if(jump&&legal(jump)) return out(jump,sem('sef2024-michaels-fit-jump','michaels-defense',true,'one_round_if_uncontested',{suits:{[tr]:{min:4,max:13},[mf.remaining]:{min:5,max:13}}}),`SEF 2024: rencontre après Michaël, fit ${tr} et 5+ ${mf.remaining}`);
      }

      // Cue-bid économique = fit de l'ouverture, forcing manche.
      const fitMin = tr==='C'?5 : tr==='D'?4 : 3;
      const fitForce = tr==='D'?14 : 12;
      if(cheapCue && fit>=fitMin && hld>=fitForce && legal(cheapCue))
        return out(cheapCue,sem('sef2024-michaels-cheap-cue-fit','michaels-defense',false,'game_if_uncontested',{suits:{[tr]:{min:fitMin,max:13}}}),`SEF 2024: cue-bid économique = fit ${tr}, forcing manche (${hld} HLD)`);

      // Cue-bid cher = 5+ cartes dans la quatrième couleur, forcing manche.
      if(expensiveCue && mf.remaining && L[mf.remaining]>=5 && HL>=13 && legal(expensiveCue))
        return out(expensiveCue,sem('sef2024-michaels-expensive-cue-fourth-suit','michaels-defense',false,'game_if_uncontested',{suits:{[mf.remaining]:{min:5,max:13}}}),`SEF 2024: second cue-bid = 5+ ${mf.remaining}, forcing manche`);

      // Soutien compétitif : uniquement 8-10 HLD.
      const weakFitMin = minorOpen?5:3;
      if(fit>=weakFitMin && hld>=8 && hld<=10){
        const t=cheapestSuitCallAfter(history,tr);
        if(t&&legal(t)) return out(t,sem('sef2024-michaels-weak-direct-fit','michaels-defense',true,'nonforcing',{suits:{[tr]:{min:weakFitMin,max:13}}}),`SEF 2024: soutien compétitif après Michaël (${hld} HLD)`);
      }

      // Après ouverture majeure, 2SA disponible = fit troisième, 11-12 HLD.
      if(!minorOpen && fit===3 && hld>=11 && hld<=12 && legal('2NT'))
        return out('2NT',sem('v248-michaels-major-2nt-fit-invite','michaels-defense',false,'nonforcing',{suits:{[tr]:{min:3,max:3}},points:{min:11,max:12}}),`SEF 2024: 2SA artificiel = fit ${tr} troisième, 11-12 HLD`);

      // Dernière couleur naturelle faible : 6+ cartes, 8-10 H, non forcing.
      if(mf.remaining && L[mf.remaining]>=6 && H>=8 && H<=10){
        const t=cheapestSuitCallAfter(history,mf.remaining);
        if(t&&+t[0]<=3&&legal(t)) return out(t,sem('sef2024-michaels-natural-fourth-suit-weak','michaels-defense',true,'nonforcing',{suits:{[mf.remaining]:{min:6,max:13}}}),`SEF 2024: dernière couleur naturelle 6+ (${H} H), non forcing`);
      }

      // SA naturels avec les deux arrêts. Après mineure : 2SA 11-12, 3SA 13-16.
      // Après majeure : 3SA naturel SEF, max 2 cartes dans la majeure.
      if(doubleStop && regular){
        if(minorOpen && HL>=11 && HL<=12 && legal('2NT'))
          return out('2NT',sem('v248-michaels-minor-2nt-natural','michaels-defense',true,'nonforcing',{points:{min:11,max:12}}),`SEF 2024: 2SA naturel, 11-12 HL, deux arrêts`);
        if(HL>=13 && HL<=16 && (!minorOpen?fit<=2:true) && legal('3NT'))
          return out('3NT',sem('v248-michaels-3nt-natural','michaels-defense',true,'nonforcing',{points:{min:13,max:16}}),`SEF 2024: 3SA naturel, 13-16 HL, deux arrêts`);
      }

      // Barrages/attaque-défense très distributionnels : ne pas transformer les mains
      // faibles avec énormément d'atouts en Passe mécanique.
      if(!minorOpen && fit>=5 && H<=8 && hld<=11){
        const game=`4${tr}`;
        if(legal(game)) return out(game,sem('v248-michaels-major-fit-barrage','michaels-defense',true,'nonforcing',{suits:{[tr]:{min:5,max:13}},points:{min:0,max:8}}),`SEF 2024: barrage/attaque-défense à ${game} avec fit cinquième et main faible`);
      }
      if(minorOpen && fit>=6 && H<=6){
        const pre=`4${tr}`;
        if(legal(pre)) return out(pre,sem('v248-michaels-minor-fit-barrage','michaels-defense',true,'nonforcing',{suits:{[tr]:{min:6,max:13}},points:{min:0,max:6}}),`SEF 2024: barrage compétitif à ${pre} avec longue mineure fittée`);
      }
      if(mf.remaining && (mf.remaining==='H'||mf.remaining==='S') && L[mf.remaining]>=7 && HL<=12){
        const pre=`4${mf.remaining}`;
        if(legal(pre)) return out(pre,sem('v248-michaels-fourth-major-barrage','michaels-defense',true,'nonforcing',{suits:{[mf.remaining]:{min:7,max:13}}}),`SEF 2024: barrage dans la quatrième majeure longue (${L[mf.remaining]} cartes)`);
      }

      // Contre DIRECT = d'appel, 10+ HL, sans meilleure enchère.
      if(HL>=10 && legal('X'))
        return out('X',sem('v248-michaels-takeout-double','michaels-defense',false,'one_round_if_uncontested',{points:{min:10,max:37}}),`SEF 2024: Contre direct d'appel après Michaël (${HL} HL)`);

      // Sans meilleure enchère : Passe.
      return out('PASS',sem('v248-michaels-pass-no-better','michaels-defense',true,'nonforcing'),'SEF 2024: aucune meilleure enchère après Michaël => Passe');
    }
    // Passe puis Contre : punitif. Le SEF 2024 distingue explicitement ce cas
    // du Contre direct, qui est d'appel. On ne force la pénalité qu'avec une tenue
    // vraiment exploitable dans la couleur choisie par l'adversaire.
    if(mf && mf.h.length===6 && mf.open.seat===partner && mf.h[2].seat===seat && mf.h[2].call==='PASS'){
      const chosen=parseBid(mf.h[3].call)?.strain;
      if(chosen && mf.shown.includes(chosen) && mf.h[4].seat===partner && mf.h[4].call==='PASS' &&
         sameSide(mf.h[5].seat,mf.over.seat) && mf.h[5].call==='PASS'){
        if(H>=8 && L[chosen]>=4 && suitHcp(ctx.deal,seat,chosen)>=4 && legal('X'))
          return out('X',sem('v248-michaels-pass-then-penalty-double','michaels-defense',false,'nonforcing',{suits:{[chosen]:{min:4,max:13}}}),`SEF 2024: Passe puis Contre = punitif ; ${L[chosen]} cartes et honneurs en ${chosen}`);
      }
    }

    // Après un Contre direct d'appel, un Contre ultérieur reste d'appel (sauf si
    // le répondant avait d'abord passé). Quand PONS choisit déjà X, publier le
    // bon sens évite qu'un tour suivant le relise comme pénalité.
    if(mf && mf.h.length>=4 && mf.h[2]?.seat===seat && mf.h[2]?.call==='X' && raw==='X'){
      return out('X',sem('v248-michaels-later-takeout-double','michaels-defense',false,'unknown',{points:{min:10,max:37}}),'SEF 2024: après Contre direct, les Contres ultérieurs restent d’appel (conversion pénale possible, pas de forcing automatique)');
    }

    // 2SA naturel après ouverture mineure = 11-12 HL avec arrêts dans les deux
    // couleurs. L'ouvreur accepte l'invitation avec une vraie zone de manche et les
    // arrêts nécessaires, au lieu de s'égarer dans une redemande mineure sous la manche.
    if(mf && mf.h.length===4 && mf.open.seat===seat && mf.h[2].seat===partner && mf.h[2].call==='2NT' &&
       (mf.ob.strain==='C'||mf.ob.strain==='D') && sameSide(mf.h[3].seat,mf.over.seat)){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='v248-michaels-minor-2nt-natural');
      if(pm && H>=14 && mf.shown.every(s=>stopperScore(ctx.deal,seat,s)>=0.7) && legal('3NT'))
        return out('3NT',sem('v248-michaels-opener-accepts-2nt','michaels-defense',true,'nonforcing',{points:{min:14,max:23}}),`SEF 2024: 2SA naturel 11-12 ; ${H} H chez l'ouvreur et deux arrêts => 3SA`);
      if(pm && H<=13 && mf.h[3].call==='PASS' && legal('PASS'))
        return out('PASS',sem('v248-michaels-opener-declines-2nt','michaels-defense',true,'nonforcing',{points:{min:12,max:13}}),`SEF 2024: 2SA naturel 11-12 ; ouverture minimale (${H} H) => Passe`);
    }

    // Fermeture du cue-bid de fit FM: l'ouvreur ne peut pas passer sous la manche.
    if(mf && mf.h.length===4 && mf.open.seat===seat && mf.h[2].seat===partner && sameSide(mf.h[3].seat,mf.over.seat)){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='sef2024-michaels-cheap-cue-fit');
      if(pm){const tr=mf.ob.strain; const game=(tr==='H'||tr==='S')?`4${tr}`:`5${tr}`; if(legal(game)) return out(game,sem('sef2024-michaels-opener-closes-fit-game','michaels-defense',true,'nonforcing',{suits:{[tr]:{min:3,max:13}}}),`SEF 2024: cue-bid de fit et manche forcee => ${game}`);}
    }
    // Second cue-bid apres Michael : cinq cartes dans la quatrieme couleur et
    // forcing de manche. Si l'ouvreur possede au moins trois cartes dans cette
    // couleur et que PONS voudrait passer, le fit 5-3 permet de fermer directement
    // la manche (4M / 5m) sans laisser un garde generique inventer une etape.
    if(mf && mf.h.length===4 && mf.open.seat===seat && mf.h[2].seat===partner && sameSide(mf.h[3].seat,mf.over.seat) && mf.remaining){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='sef2024-michaels-expensive-cue-fourth-suit');
      if(pm && L[mf.remaining]>=3){
        const game=(mf.remaining==='H'||mf.remaining==='S')?`4${mf.remaining}`:`5${mf.remaining}`;
        if(raw!=='PASS'&&bidRank(raw)>=bidRank(game)&&legal(raw)) return out(raw,sem('sef2024-michaels-opener-after-expensive-cue-preserve','michaels-defense',true,'nonforcing',{suits:{[mf.remaining]:{min:3,max:13}}}),`SEF 2024: second cue-bid FM; action PONS de manche ${raw} conservee avec le fit ${mf.remaining}`);
        if(legal(game)) return out(game,sem('sef2024-michaels-opener-closes-fourth-suit-game','michaels-defense',true,'nonforcing',{suits:{[mf.remaining]:{min:3,max:13}}}),`SEF 2024: second cue-bid = 5+ ${mf.remaining} FM; fit 3+ => ${game}`);
      }
      // Sans fit dans la quatrieme couleur, 3SA est la conclusion de manche
      // objective lorsque l'ouvreur tient les deux couleurs montrees par Michael.
      if(pm && raw==='PASS' && L[mf.remaining]<3 && mf.shown.every(s=>stopperScore(ctx.deal,seat,s)>=0.7) && legal('3NT'))
        return out('3NT',sem('sef2024-michaels-opener-3nt-after-expensive-cue','michaels-defense',true,'nonforcing'),`SEF 2024: second cue-bid FM sans fit ${mf.remaining}, arrets dans les deux couleurs du bicolore => 3SA`);
      // Sans fit dans la quatrieme couleur et sans les deux arrets, l'ouvreur
      // d'une majeure peut encore se decrire naturellement. Le second cue-bid
      // reste forcing de manche : avec une majeure d'ouverture au moins cinquieme,
      // sa repetition au palier disponible est une continuation sure.
      if(pm && raw==='PASS' && L[mf.remaining]<3 && (mf.ob.strain==='H'||mf.ob.strain==='S') && L[mf.ob.strain]>=5){
        const repeat=cheapestSuitCallAfter(history,mf.ob.strain);
        if(repeat && legal(repeat)) return out(repeat,sem('sef2024-michaels-opener-major-repeat-after-expensive-cue','michaels-defense',true,'game_if_uncontested',{suits:{[mf.ob.strain]:{min:5,max:13}}}),`SEF 2024: second cue-bid FM sans fit ${mf.remaining} ni double arret ; repetition naturelle ${repeat}`);
      }
      // Même logique après une ouverture mineure : sans fit dans la quatrième couleur
      // ni double arrêt, l'ouvreur conserve la manche forcing en répétant naturellement
      // sa mineure longue plutôt que de laisser le Semantic Guard inventer une majeure.
      if(pm && raw==='PASS' && L[mf.remaining]<3 && (mf.ob.strain==='C'||mf.ob.strain==='D') && L[mf.ob.strain]>=5){
        const repeat=cheapestSuitCallAfter(history,mf.ob.strain);
        if(repeat && legal(repeat)) return out(repeat,sem('sef2024-michaels-opener-minor-repeat-after-expensive-cue','michaels-defense',true,'game_if_uncontested',{suits:{[mf.ob.strain]:{min:5,max:13}}}),`SEF 2024: second cue-bid FM sans fit ${mf.remaining} ni double arrêt ; répétition naturelle de la mineure ${repeat}`);
      }
    }

    // Second cue-bid Michael — si l'ouvreur soutient directement la quatrième
    // couleur promise (5+), le fit est établi et le répondant ne peut pas passer sous
    // la manche. Sur une mineure, 5m est la fermeture minimale sans présumer d'un chelem.
    if(mf && mf.h.length===6 && mf.open.seat===partnerOf(seat) && mf.remaining && mf.cues[1] && raw==='PASS' &&
       mf.h[2].seat===seat && mf.h[2].call===mf.cues[1] && sameSide(mf.h[3].seat,mf.over.seat) &&
       mf.h[4].seat===partnerOf(seat) && parseBid(mf.h[4].call)?.strain===mf.remaining && sameSide(mf.h[5].seat,mf.over.seat)){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='sef2024-michaels-opener-closes-fourth-suit-game'||m?.source==='sef2024-michaels-opener-after-expensive-cue-preserve');
      const game=(mf.remaining==='H'||mf.remaining==='S')?`4${mf.remaining}`:`5${mf.remaining}`;
      if((pm||L[mf.remaining]>=5) && legal(game)) return out(game,sem('sef2024-michaels-responder-closes-after-opener-fourth-suit-fit','michaels-defense',true,'nonforcing',{suits:{[mf.remaining]:{min:5,max:13}}}),`SEF 2024: second cue-bid = 5+ ${mf.remaining}; soutien de l'ouvreur => manche ${game}`);
    }

    // Second cue-bid Michael — tour suivant du répondant. Après une
    // répétition naturelle de la majeure d'ouverture, le forcing de manche reste
    // actif. Avec les deux couleurs du bicolore adverse arrêtées, 3SA est la
    // conclusion objective et évite un PASS natif sous forcing.
    if(mf && mf.h.length===6 && mf.open.seat===partnerOf(seat) && mf.remaining && mf.cues[1] &&
       mf.h[2].seat===seat && mf.h[2].call===mf.cues[1] && sameSide(mf.h[3].seat,mf.over.seat) &&
       mf.h[4].seat===partnerOf(seat) && parseBid(mf.h[4].call)?.strain===mf.ob.strain && sameSide(mf.h[5].seat,mf.over.seat) && raw==='PASS'){
      if(mf.shown.every(s=>stopperScore(ctx.deal,seat,s)>=0.7) && legal('3NT'))
        return out('3NT',sem('sef2024-michaels-responder-3nt-after-opener-major-repeat','michaels-defense',true,'nonforcing',{suits:{[mf.remaining]:{min:5,max:13}}}),`SEF 2024: second cue-bid FM puis répétition ${mf.h[4].call}; deux arrêts adverses => 3SA`);
      if(L[mf.remaining]>=6){
        const repeat=cheapestSuitCallAfter(history,mf.remaining);
        if(repeat && legal(repeat)) return out(repeat,sem('sef2024-michaels-responder-sixth-fourth-suit-after-major-repeat','michaels-defense',true,'game_if_uncontested',{suits:{[mf.remaining]:{min:6,max:13}}}),`SEF 2024: second cue-bid FM puis ${mf.h[4].call}; sans double arrêt, ${L[mf.remaining]} cartes ${mf.remaining} => ${repeat}`);
      }
      // Le second cue-bid a déjà promis 5+ cartes dans la quatrième couleur et
      // imposé la manche. Si le répondant n'a ni les deux arrêts pour 3SA ni une
      // sixième carte à montrer, il peut au minimum répéter naturellement cette
      // couleur au palier disponible : on maintient ainsi le forcing sans inventer
      // une longueur ou un arrêt supplémentaire.
      if(L[mf.remaining]>=5){
        const repeat=cheapestSuitCallAfter(history,mf.remaining);
        if(repeat && legal(repeat)) return out(repeat,sem('sef2024-michaels-responder-five-fourth-suit-continuation','michaels-defense',true,'game_if_uncontested',{suits:{[mf.remaining]:{min:5,max:13}}}),`SEF 2024: second cue-bid = 5+ ${mf.remaining} FM ; sans double arrêt ni sixième carte, continuation naturelle ${repeat}`);
      }
    }

    // Second cue-bid Michael — si l'ouvreur poursuit par un cue-bid/contrôle
    // dans l'une des couleurs montrées par l'adversaire, le répondant reste forcing
    // de manche. Sa couleur restante 5+ avait déjà été promise : il la répète au
    // palier le plus économique plutôt que de laisser le garde sémantique inventer
    // un contrat dans la couleur adverse.
    if(mf && mf.h.length===6 && mf.open.seat===partnerOf(seat) && mf.remaining && mf.cues[1] &&
       mf.h[2].seat===seat && mf.h[2].call===mf.cues[1] && sameSide(mf.h[3].seat,mf.over.seat) &&
       mf.h[4].seat===partnerOf(seat) && mf.shown.includes(parseBid(mf.h[4].call)?.strain) && sameSide(mf.h[5].seat,mf.over.seat) && raw==='PASS' && L[mf.remaining]>=5){
      const repeat=cheapestSuitCallAfter(history,mf.remaining);
      if(repeat && legal(repeat)) return out(repeat,sem('sef2024-michaels-responder-repeats-fourth-suit-after-opener-control','michaels-defense',true,'game_if_uncontested',{suits:{[mf.remaining]:{min:5,max:13}}}),`SEF 2024: second cue-bid = 5+ ${mf.remaining} FM ; après contrôle ${mf.h[4].call}, continuation descriptive ${repeat}`);
    }

    // Après la répétition de la quatrième couleur au tour suivant, le forcing de
    // manche subsiste. Six cartes chez le répondant et deux cartes chez l'ouvreur
    // suffisent à établir le fit huitième et à fermer la manche mineure/majeure.
    if(mf && mf.h.length===8 && mf.open.seat===seat && mf.remaining && mf.h[2].call===mf.cues[1] &&
       parseBid(mf.h[4].call)?.strain===mf.ob.strain && mf.h[6].seat===partnerOf(seat) && parseBid(mf.h[6].call)?.strain===mf.remaining && sameSide(mf.h[7].seat,mf.over.seat) && raw==='PASS'){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='sef2024-michaels-responder-sixth-fourth-suit-after-major-repeat');
      if((pm || L[mf.remaining]>=2) && L[mf.remaining]>=2){
        const game=(mf.remaining==='H'||mf.remaining==='S')?`4${mf.remaining}`:`5${mf.remaining}`;
        if(legal(game)) return out(game,sem('sef2024-michaels-opener-closes-after-sixth-fourth-suit','michaels-defense',true,'nonforcing',{suits:{[mf.remaining]:{min:2,max:13}}}),`SEF 2024: six cartes ${mf.remaining} chez le répondant, ${L[mf.remaining]} chez l'ouvreur => fit huitième, ${game}`);
      }
    }

    // Enchere de rencontre apres Michael : elle promet le fit et reste forcing un tour.
    // PONS natif peut parfois PASS avec une longue d'ouverture; on ferme alors explicitement
    // a la manche dans la couleur d'ouverture plutot que de laisser le garde semantique deviner.
    if(mf && mf.h.length===4 && mf.open.seat===seat && mf.h[2].seat===partner && sameSide(mf.h[3].seat,mf.over.seat) && mf.remaining){
      const natural=cheapestSuitCallAfter(mf.h.slice(0,2),mf.remaining);
      const jump=natural?`${Math.min(7,+natural[0]+1)}${mf.remaining}`:null;
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='sef2024-michaels-fit-jump');
      // Le carton lui-meme suffit a identifier la rencontre dans CE contexte conventionnel;
      // ne pas dependre exclusivement d'une source du ledger qui peut avoir ete fusionnee.
      if(pm){
        const tr=mf.ob.strain, game=(tr==='H'||tr==='S')?`4${tr}`:`5${tr}`;
        if(raw!=='PASS'&&legal(raw)) return out(raw,sem('sef2024-michaels-opener-after-fit-jump-preserve','michaels-defense',true,'nonforcing',{suits:{[tr]:{min:3,max:13}}}),`SEF 2024: rencontre forcing, action PONS ${raw} conservee`);
        if(legal(game)) return out(game,sem('sef2024-michaels-opener-after-fit-jump-game','michaels-defense',true,'nonforcing',{suits:{[tr]:{min:3,max:13}}}),`SEF 2024: rencontre forcing et PASS natif => ${game}`);
        // Si l'enchere de rencontre a deja depasse la manche dans la couleur
        // d'ouverture (cas typique 1H-(2NT)-4S), PASS reste interdit. Avec la
        // majeure d'ouverture agreee par la rencontre, 4SA est le relais RKCB
        // naturel du systeme et garde la sequence sous controle explicite.
        if((tr==='H'||tr==='S') && bidRank(mf.h[2].call)>bidRank(game) && legal('4NT'))
          return out('4NT',sem('sef2024-michaels-opener-rkcb-after-high-fit-jump','michaels-defense',false,'one_round_if_uncontested',{suits:{[tr]:{min:5,max:13}}}),`SEF 2024: rencontre forcing au-dessus de ${game}; PASS interdit => 4SA RKCB`);
      }
    }

    // -------------------------------------------------------------------------
    // v2.22 — BLACKWOOD 5 CLES 30-41.
    function agreedTrump(){
      const sideCalls=history.filter(x=>sameSide(x.seat,seat)&&parseBid(x.call));
      for(const m of ['S','H','D','C']){
        const me=sideCalls.some(x=>x.seat===seat&&parseBid(x.call)?.strain===m);
        const pa=sideCalls.some(x=>x.seat===partner&&parseBid(x.call)?.strain===m);
        if(me&&pa) return m;
      }
      const op=sideCalls.find(x=>['1H','1S'].includes(x.call));
      if(op) return op.call.slice(1); // 1M-4SA: fit implicite, Blackwood selon le cours FFB.
      return null;
    }
    const trump=agreedTrump();
    const last=history[history.length-1];
    if(last?.seat===partner&&last.call==='4NT'&&trump){
      const hand=ctx.deal?.hands?.[seat]||{};
      const aces=SUITS.filter(s=>String(hand[s]||'').includes('A')).length;
      const kTrump=String(hand[trump]||'').includes('K')?1:0;
      const qTrump=String(hand[trump]||'').includes('Q');
      const keys=aces+kTrump;
      const voids=SUITS.filter(s=>s!==trump&&L[s]===0);
      if(voids.length&&keys>0){
        if(keys%2===0&&legal('5NT')) return out('5NT',sem('ffb-rkcb30-41-void-even','rkcb30-41',false,'one_round_if_uncontested',{keys}),`Blackwood 30-41: ${keys} cles et chicane utile => 5SA`);
        if(keys%2===1){const v=voids[0]; if(RANK[v]<RANK[trump]&&legal(`6${v}`)) return out(`6${v}`,sem('ffb-rkcb30-41-void-odd','rkcb30-41',false,'one_round_if_uncontested',{keys,void:v}),`Blackwood 30-41: nombre impair de cles et chicane ${v}`); const t=`6${trump}`; if(legal(t))return out(t,sem('ffb-rkcb30-41-void-higher','rkcb30-41',false,'nonforcing',{keys}),`Blackwood 30-41: chicane plus chere que l atout => saut a 6${trump}`);}
      }
      const t=(keys===0||keys===3)?'5C':(keys===1||keys===4)?'5D':qTrump?'5S':'5H';
      return out(t,sem('ffb-rkcb30-41-response','rkcb30-41',false,'one_round_if_uncontested',{keys,trump,queen:qTrump}),`Blackwood 5 cles 30-41: ${keys} cle(s), Dame d atout ${qTrump?'oui':'non'} => ${t}`);
    }
    // Question a la Dame: apres 5C/5D, premiere couleur disponible hors atout et 5SA.
    if(history.length>=3&&trump&&last?.seat===partner){
      const mine=history[history.length-2], prev=history[history.length-3];
      if(mine?.seat===seat&&['5C','5D'].includes(mine.call)&&prev?.seat===partner&&prev.call==='4NT'){
        const qcall=last.call, qb=parseBid(qcall);
        if(qb&&qb.level>=5&&qb.strain!==trump&&qcall!=='5NT'){
          const q=String(ctx.deal?.hands?.[seat]?.[trump]||'').includes('Q');
          if(!q){const t=cheapestSuitCallAfter(history,trump);if(t)return out(t,sem('ffb-rkcb30-41-queen-deny','rkcb30-41',true,'nonforcing',{trump,queen:false}),`Blackwood: retour a l atout = Dame niee`);}
          const kings=SUITS.filter(s=>s!==trump&&String(ctx.deal?.hands?.[seat]?.[s]||'').includes('K'));
          for(const k of kings.sort((a,b)=>RANK[a]-RANK[b])){const t=cheapestSuitCallAfter(history,k);if(t&&legal(t))return out(t,sem('ffb-rkcb30-41-queen-yes-king','rkcb30-41',false,'one_round_if_uncontested',{trump,queen:true,king:k}),`Blackwood: Dame d atout + Roi ${k}`);}
          if(legal('5NT')) return out('5NT',sem('ffb-rkcb30-41-queen-yes-no-king','rkcb30-41',false,'one_round_if_uncontested',{trump,queen:true}),'Blackwood: Dame d atout, aucun Roi annexe economique');
        }
      }
    }
    // 5SA du capitaine apres reponse: proposition de grand chelem / question aux Rois.
    if(last?.seat===partner&&last.call==='5NT'&&trump&&history.some(x=>x.seat===seat&&['5C','5D','5H','5S'].includes(x.call))){
      const kings=SUITS.filter(s=>s!==trump&&String(ctx.deal?.hands?.[seat]?.[s]||'').includes('K')).sort((a,b)=>RANK[a]-RANK[b]);
      for(const k of kings){const t=cheapestSuitCallAfter(history,k);if(t&&legal(t))return out(t,sem('ffb-rkcb30-41-king-show','rkcb30-41',true,'one_round_if_uncontested',{king:k,trump}),`Blackwood 5SA: Roi ${k} annonce economiquement`);}
      const t=`6${trump}`;if(legal(t))return out(t,sem('ffb-rkcb30-41-no-side-king','rkcb30-41',true,'nonforcing',{trump}),'Blackwood 5SA: aucun Roi annexe, retour a 6 dans l atout');
    }

    // -------------------------------------------------------------------------
    // A0. REPONSES DIRECTES A 1SA — frontières documentées.
    //
    // Le noyau PONS contient une variante où 4C/4D sont des transferts de manche.
    // Ce n'est pas notre système cible :
    //   - 4D direct = bicolore majeur 5-5 (ou mieux) avec certitude de manche ;
    //   - 4H/4S directs = naturels, pour jouer, notamment avec une majeure 6e de manche ;
    //   - les autres mains à majeure longue passent par le Texas normal.
    //
    // Cette poche est volontairement étroite : elle corrige surtout les collisions de
    // conventions natives sans prétendre reconstruire ici tout le système 1SA.
    if(ntHistory.length===2 && ntHistory[0].seat===partner && ntHistory[0].call==='1NT' && ntHistory[1].call==='PASS') {
      const lt=losingTricks(ctx.deal,seat), hldH=supportHld(ctx.deal,seat,'H'), hldS=supportHld(ctx.deal,seat,'S');
      const major55=L.H>=5&&L.S>=5;
      // v2.34 — qualité du contrat : ne pas laisser PONS passer une invitation claire
      // face à 1SA 15-17. Avec 8-9 H et une majeure exactement quatrième, Stayman ;
      // sans majeure quatrième et main régulière, 2SA quantitatif. Les Texas 5e+
      // restent entièrement hors de cette poche.
      if(raw==='PASS' && L.H<=4 && L.S<=4 && H>=8 && H<=9){
        if((L.H===4 || L.S===4) && legal('2C'))
          return out('2C',sem('v234-1NT-invite-stayman','nt-direct-responses',false,'one_round_if_uncontested',{hcp:{min:8,max:9}}),`qualité contrat : ${H} H et majeure quatrième sur 1SA => Stayman 2C`);
        if(balanced(L) && legal('2NT'))
          return out('2NT',sem('v234-1NT-invite-2NT','nt-direct-responses',true,'nonforcing',{hcp:{min:8,max:9}}),`qualité contrat : ${H} H réguliers sur 1SA => proposition 2SA`);
      }
      if(raw==='PASS' && L.H<=4 && L.S<=4 && (L.H===4 || L.S===4) && H>=10 && H<=15 && legal('2C'))
        return out('2C',sem('v234-1NT-game-stayman','nt-direct-responses',false,'one_round_if_uncontested',{hcp:{min:10,max:15}}),`qualité contrat : ${H} H et majeure quatrième sur 1SA => Stayman avant la manche`);
      // Cours 06 : le 5-5 majeur de manche, typiquement 6/7 perdantes, se décrit par 4D.
      if(major55 && lt>=6 && lt<=7 && HL>=8 && HL<=16) {
        return out('4D',sem('course06-direct-4D-major55-game','nt-direct-responses',false,'one_round_if_uncontested',{suits:{H:{min:5,max:13},S:{min:5,max:13}}}),`Cours 06 : 5-5 majeur de manche (${lt} perdantes) => 4D « choisis ta majeure »`);
      }
      // Avec une majeure sixième et la force de manche sans ambition de chelem, conclusion directe.
      if(L.H>=6 && L.S<=4 && hldH>=11 && hldH<=15 && H<=11) {
        return out('4H',sem('course06-direct-4H-six-hearts-game','nt-direct-responses',true,'nonforcing',{suits:{H:{min:6,max:13}}}),`Cours 06 : ${L.H} Coeurs, ${hldH} HLD => 4H naturel`);
      }
      if(L.S>=6 && L.H<=4 && hldS>=11 && hldS<=15 && H<=11) {
        return out('4S',sem('course06-direct-4S-six-spades-game','nt-direct-responses',true,'nonforcing',{suits:{S:{min:6,max:13}}}),`Cours 06 : ${L.S} Piques, ${hldS} HLD => 4S naturel`);
      }
      // Neutraliser les transferts de manche propres au noyau PONS. Un 4C/4D natif
      // qui ne correspond pas à nos deux poches documentées revient au Texas ordinaire.
      if(raw==='4C' || raw==='4D') {
        if(L.H>=5 && L.S<5) return out('2D',sem('sef-normal-heart-texas-instead-of-pons-4C','nt-direct-responses',false,'one_round_if_uncontested',{suits:{H:{min:5,max:13}}}),'SEF : suppression du transfert de manche PONS ; Texas Coeur normal à 2D');
        if(L.S>=5 && L.H<5) return out('2H',sem('sef-normal-spade-texas-instead-of-pons-4D','nt-direct-responses',false,'one_round_if_uncontested',{suits:{S:{min:5,max:13}}}),'SEF : suppression du transfert de manche PONS ; Texas Pique normal à 2H');
        if(major55) return out('2H',sem('course06-major55-nongame-fallback-texas-spades','nt-direct-responses',false,'one_round_if_uncontested',{suits:{H:{min:5,max:13},S:{min:5,max:13}}}),'Cours 06 : 5-5 majeur hors poche 4D de manche => retour au développement par Texas');
        return out('PASS',sem('user-nt-direct-suppress-pons-4x-transfer','nt-direct-responses',true,'nonforcing'),`Suppression du ${raw} transfert de manche natif PONS, non prévu dans notre système`);
      }
    }

    // v2.34 — 4SA quantitatif direct sur 1SA : avec 16-17 H, un PASS natif
    // est trop pessimiste. Dans cette zone l'ouvreur accepte à 6SA ; à 15 H il refuse.
    if(ntHistory.length===4 && ntHistory[0].seat===seat && ntHistory[0].call==='1NT' &&
       ntHistory[1].call==='PASS' && ntHistory[2].seat===partner && ntHistory[2].call==='4NT' && ntHistory[3].call==='PASS' && raw==='PASS'){
      if(H>=16 && legal('6NT')) return out('6NT',sem('v234-1NT-quant-accept-6NT','nt-direct-responses',true,'nonforcing',{hcp:{min:16,max:17}}),'qualité contrat : 4SA quantitatif face à 1SA, 16-17 H => acceptation 6SA');
      if(H<=15) return out('PASS',sem('v234-1NT-quant-decline','nt-direct-responses',true,'nonforcing',{hcp:{min:15,max:15}}),'qualité contrat : 4SA quantitatif face à 1SA, 15 H => refus');
    }

    // 1SA-4D (5-5 majeur) reste une demande de choix même si le n°4
    // contre/surenchérit. La compétition ne doit jamais faire réapparaître le
    // sens natif PONS du 4D.
    if(ntHistory.length===4&&ntHistory[0].seat===seat&&ntHistory[0].call==='1NT'&&ntHistory[1].call==='PASS'&&ntHistory[2].seat===partner&&ntHistory[2].call==='4D'&&ntHistory[3].call!=='PASS'){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='course06-direct-4D-major55-game');
      if(pm){const target=majorPreference(ctx.deal,seat,5,5)==='H'?'4H':'4S';if(legal(target))return out(target,sem('course06-opener-chooses-major55-after-competition','nt-direct-responses',true,'nonforcing',{suits:{H:{min:0,max:13},S:{min:0,max:13}}}),`Cours 06 : 4D montre 5-5 majeur même après l'action adverse ; choix ${target}`);}
    }

    // A0bis. DEUXIEME TOUR APRES LES REPONSES DIRECTES A 1SA.
    // 4D est artificiel et impose a l'ouvreur de choisir la manche majeure ; 4H/4S
    // directs sont des conclusions absolues. Ce bloc ferme explicitement le deuxieme tour
    // afin qu'une convention native PONS differente ne reprenne pas la main.
    if(ntHistory.length===4 && ntHistory[0].seat===seat && ntHistory[0].call==='1NT' &&
       ntHistory[1].call==='PASS' && ntHistory[2].seat===partner && ntHistory[3].call==='PASS') {
      const r=ntHistory[2].call;
      if(r==='4D'){
        let pref='S';
        if(L.H!==L.S) pref=L.H>L.S?'H':'S';
        else { const qH=suitHcp(ctx.deal,seat,'H'), qS=suitHcp(ctx.deal,seat,'S'); if(qH!==qS) pref=qH>qS?'H':'S'; }
        const target=`4${pref}`;
        return out(target,sem('course06-opener-major55-preference','nt-direct-responses',true,'nonforcing',{suits:{[pref]:{min:0,max:13}}}),`Cours 06 : sur 4D bicolore majeur 5-5, l'ouvreur choisit ${target}`);
      }
      if(r==='4H'||r==='4S'){
        return out('PASS',sem('course06-opener-respects-direct-major-stop','nt-direct-responses',true,'nonforcing'),`Cours 06 : ${r} direct est une conclusion, l'ouvreur passe`);
      }
    }

    // -------------------------------------------------------------------------
    // A. MULTI-LANDY / WOOLSEY — intervention directe derrière 1SA adverse.
    // Accord utilisateur : X = exactement une majeure 4e + une mineure 5e ou plus,
    // la mineure étant plus longue. Les deux majeures passent par 2C.
    // -------------------------------------------------------------------------
    if(history.length>=1 && history.at(-1)?.call==='1NT' && !sameSide(history.at(-1).seat,seat) && bids.length===1){
      const bothMaj54=(L.H>=5&&L.S>=4)||(L.S>=5&&L.H>=4);
      const minorLong=Math.max(L.C,L.D), majorLong=Math.max(L.H,L.S);
      let target=null, semantic=null, reason='';
      // 2C = deux majeures, au moins 5-4. Une 4-4 majeure (4432/4441 compris)
      // n'est PAS un Landy dans l'accord utilisateur.
      if(bothMaj54 && HL>=(vuln?10:8)){
        target='2C';
        semantic=sem('user-multilandy-both-majors','multi-landy',false,'unknown',{suits:{H:{min:4,max:13},S:{min:4,max:13}}});
        reason=`Multi-Landy : ${L.H}-${L.S} majeures (5-4+) => 2C`;
      // 2NT = les deux mineures, au moins 5-5.
      } else if(L.C>=5&&L.D>=5&&L.H<=3&&L.S<=3&&HL>=(vuln?14:12)){
        target='2NT';
        semantic=sem('user-multilandy-both-minors','multi-landy',false,'one_round_if_uncontested',{suits:{C:{min:5,max:13},D:{min:5,max:13}}});
        reason='Multi-Landy : bicolore mineur 5-5+ => 2SA';
      // X = mineure plus longue + exactement une majeure quatrième.
      } else {
        const fourMaj=['H','S'].filter(m=>L[m]===4), longMin=['C','D'].filter(m=>L[m]>=5&&L[m]>4);
        if(fourMaj.length===1 && longMin.length>=1 && Math.max(...longMin.map(m=>L[m]))>4 && H>=9 && HL>=10){
          const m=fourMaj[0], mi=longMin.sort((a,b)=>L[b]-L[a]||suitHcp(ctx.deal,seat,b)-suitHcp(ctx.deal,seat,a))[0];
          target='X';
          semantic=sem('user-multilandy-minor-major-double','multi-landy',false,'unknown',{suits:{[m]:{min:4,max:4},[mi]:{min:5,max:13}},hcp:{min:9,max:37}});
          reason=`Multi-Landy utilisateur : X = ${L[mi]}${mi} + exactement 4${m}`;
        }
      }
      // 2M = 5+ dans la majeure + une mineure au moins quatrième, la majeure n'étant
      // pas plus courte. Cette famille vient avant l'unicolore majeur à 2D.
      if(!target){
        const cand=[];
        for(const m of ['H','S']) if(L[m]>=5){
          const mi=['C','D'].sort((a,b)=>L[b]-L[a])[0];
          if(L[mi]>=4&&L[m]>=L[mi]&&L[m==='H'?'S':'H']<=3&&HL>=(vuln?12:10)) cand.push({m,mi});
        }
        if(cand.length===1){
          const {m,mi}=cand[0]; target=`2${m}`;
          semantic=sem('user-multilandy-major-minor','multi-landy',false,'unknown',{suits:{[m]:{min:5,max:13},[mi]:{min:4,max:13}}});
          reason=`Multi-Landy : ${L[m]}${m} + ${L[mi]}${mi} => 2${m}`;
        }
      }
      // 2D = unicolore majeur sixième ou plus, majeure inconnue.
      if(!target){
        const longMaj=['H','S'].filter(m=>L[m]>=6&&L[m==='H'?'S':'H']<=3&&L.C<=3&&L.D<=3);
        if(longMaj.length===1&&HL>=(vuln?12:10)){
          const m=longMaj[0]; target='2D';
          semantic=sem('user-multilandy-unknown-major','multi-landy',false,'unknown',{suits:{[m]:{min:6,max:13}}});
          reason=`Multi-Landy : unicolore majeur ${L[m]}e => 2D multi`;
        }
      }
      if(target) return out(target,semantic,reason);
      // Le système Multi-Landy doit aussi neutraliser les significations natives de PONS :
      // si la main ne rentre dans aucune famille convenue, un X/2C/2D/2H/2S/2SA
      // natif ne doit pas survivre avec une signification incompatible.
      if(['X','2C','2D','2H','2S','2NT'].includes(raw)) return out('PASS',sem('user-multilandy-suppress-native-incompatible','multi-landy',true,'nonforcing'),`Multi-Landy : ${raw} natif PONS incompatible avec les formes convenues => Passe`);
    }

    // A2. Avancer après X mineure-majeure : 2C demande la mineure, 2D la majeure,
    // 2H/2S sont naturels pour jouer. Le Passe punitif reste réservé aux mains très fortes.
    if(ntHistory.length===3 && ntHistory[0].call==='1NT' && ntHistory[1].seat===partner && ntHistory[1].call==='X' && ntHistory[2].call==='PASS'){
      if(L.H>=6&&H<=9) return out('2H',sem('user-multilandy-x-advance-natural-H','multi-landy',true,'nonforcing',{suits:{H:{min:6,max:13}}}),'Multi-Landy : 2H naturel de repli après X');
      if(L.S>=6&&H<=9) return out('2S',sem('user-multilandy-x-advance-natural-S','multi-landy',true,'nonforcing',{suits:{S:{min:6,max:13}}}),'Multi-Landy : 2S naturel de repli après X');
      if(H>=13&&strictBalanced(L)) return out('PASS',sem('user-multilandy-x-penalty-conversion','multi-landy',true),'Multi-Landy : transformation punitive exceptionnelle avec 13H+ réguliers');
      if((L.H>=3&&L.S>=3)||(Math.max(L.H,L.S)>=4&&H>=5)) return out('2D',sem('user-multilandy-x-ask-major','multi-landy',false,'one_round_if_uncontested'),'Multi-Landy : 2D demande la majeure quatrième du contreur');
      return out('2C',sem('user-multilandy-x-ask-minor','multi-landy',false,'nonforcing'),'Multi-Landy : 2C demande la mineure (passe ou corrige)');
    }
    // Réponse du contreur à la demande de mineure.
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ntHistory[1].call==='X' && ntHistory[2].call==='PASS' && ntHistory[3].seat===partner && ntHistory[3].call==='2C' && ntHistory[4].call==='PASS'){
      const target=L.C>=5?'PASS':'2D';
      return out(target,sem('user-multilandy-x-show-minor','multi-landy',target==='PASS', 'nonforcing',target==='2D'?{suits:{D:{min:5,max:13}}}:{}),target==='PASS'?'Multi-Landy : 2C trouve les Trèfles du contreur, Passe':'Multi-Landy : 2C demande la mineure, correction à 2D');
    }
    // Réponse du contreur à la demande de majeure.
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ntHistory[1].call==='X' && ntHistory[2].call==='PASS' && ntHistory[3].seat===partner && ntHistory[3].call==='2D' && ntHistory[4].call==='PASS'){
      const m=L.H===4?'H':'S', target=`2${m}`;
      return out(target,sem('user-multilandy-x-show-major','multi-landy',true,'nonforcing',{suits:{[m]:{min:4,max:4}}}),`Multi-Landy : réponse à 2D, majeure quatrième = ${target}`);
    }
    // Les contrats naturels 2H/2S choisis directement par l'avancer sont des arrêts.
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ntHistory[1].call==='X' && ntHistory[2].call==='PASS' && ntHistory[3].seat===partner && ['2H','2S'].includes(ntHistory[3].call) && ntHistory[4].call==='PASS'){
      return out('PASS',sem('user-multilandy-x-respect-natural-stop','multi-landy',true),'Multi-Landy : 2M direct de l’avancer est naturel et non forcing');
    }
    // Après découverte de la majeure, l'avancer peut inviter/conclure avec le fit.
    if(ntHistory.length===7 && ntHistory[0].call==='1NT' && ntHistory[1].call==='X' && ntHistory[2].call==='PASS' && ntHistory[3].seat===seat && ntHistory[3].call==='2D' && ntHistory[4].call==='PASS' && ['2H','2S'].includes(ntHistory[5].call) && ntHistory[6].call==='PASS'){
      const m=ntHistory[5].call.slice(1), fit=L[m], hld=supportHld(ctx.deal,seat,m);
      if(fit>=4){
        if(hld>=13) return out(`4${m}`,sem('user-multilandy-x-major-game','multi-landy',true,'nonforcing',{suits:{[m]:{min:4,max:13}}}),`Multi-Landy : fit ${m}, ${hld} HLD => manche`);
        if(hld>=10) return out(`3${m}`,sem('user-multilandy-x-major-invite','multi-landy',true,'nonforcing',{suits:{[m]:{min:4,max:13}}}),`Multi-Landy : fit ${m}, ${hld} HLD => proposition`);
      }
      if(m==='H'&&L.S>=5&&L.H<=2) return out('2S',sem('user-multilandy-x-try-own-spades','multi-landy',true,'nonforcing',{suits:{S:{min:5,max:13}}}),'Multi-Landy : majeure du contreur = Cœur mais l’avancer propose ses Piques cinquièmes');
      return out('PASS',sem('user-multilandy-x-major-stop','multi-landy',true),'Multi-Landy : majeure révélée, pas d’effort supplémentaire');
    }

    // Après 1SA-X-P-2D-P-2H-P-2S : 2S est naturel chez l'avancer.
    // Le contreur passe avec 2+ Piques, sinon revient dans sa mineure longue.
    if(ntHistory.length===9 && ntHistory[0].call==='1NT'&&ntHistory[1].seat===seat&&ntHistory[1].call==='X'&&ntHistory[2].call==='PASS'&&ntHistory[3].seat===partner&&ntHistory[3].call==='2D'&&ntHistory[4].call==='PASS'&&ntHistory[5].seat===seat&&ntHistory[5].call==='2H'&&ntHistory[6].call==='PASS'&&ntHistory[7].seat===partner&&ntHistory[7].call==='2S'&&ntHistory[8].call==='PASS'){
      const target=L.S>=2?'PASS':(L.C>=5?'3C':'3D');
      return out(target,sem('user-multilandy-x-after-own-spades','multi-landy',target==='PASS','nonforcing'),target==='PASS'?'Multi-Landy : 2S naturel de l’avancer, deux Piques suffisent pour passer':'Multi-Landy : pas de soutien Pique, retour dans la mineure longue');
    }

    // A3. Landy 2C = les deux majeures. Développements issus de la fiche
    // Multi-Landy : préférences faibles, relais 2D, relais FM 2SA et essais 3C/3D.
    if(ntHistory.length===3 && ntHistory[0].call==='1NT' && ntHistory[1].seat===partner && ntHistory[1].call==='2C' && ntHistory[2].call==='PASS'){
      const totalMaj=L.H+L.S, hldH=supportHld(ctx.deal,seat,'H'), hldS=supportHld(ctx.deal,seat,'S');
      if(L.C>=7&&L.H<=2&&L.S<=2) return out('PASS',sem('user-multilandy-2C-club-conversion','multi-landy',true),'Multi-Landy : 7 Trèfles liés sans fit majeur, conversion exceptionnelle de 2C');
      // Conclusions/propositions naturelles avec un vrai fit.
      if(L.H>=4&&hldH>=13&&L.H>=L.S) return out('4H',sem('user-multilandy-2C-heart-game','multi-landy',true,'nonforcing',{suits:{H:{min:4,max:13}}}),'Multi-Landy/Landy : fit Cœur et valeurs de manche => 4H');
      if(L.S>=4&&hldS>=13&&L.S>L.H) return out('4S',sem('user-multilandy-2C-spade-game','multi-landy',true,'nonforcing',{suits:{S:{min:4,max:13}}}),'Multi-Landy/Landy : fit Pique et valeurs de manche => 4S');
      if(L.H===4&&hldH>=11&&hldH<=12&&L.H>=L.S) return out('3H',sem('user-multilandy-2C-heart-invite','multi-landy',true,'nonforcing',{suits:{H:{min:4,max:4}}}),'Multi-Landy/Landy : quatre Cœurs, 11-12 HLD => 3H proposition');
      if(L.S===4&&hldS>=11&&hldS<=12&&L.S>L.H) return out('3S',sem('user-multilandy-2C-spade-invite','multi-landy',true,'nonforcing',{suits:{S:{min:4,max:4}}}),'Multi-Landy/Landy : quatre Piques, 11-12 HLD => 3S proposition');
      if(H>=11&&totalMaj>=7) return out('2NT',sem('user-multilandy-2C-game-relay','multi-landy',false,'game_if_uncontested'),'Multi-Landy/Landy : double soutien majeur et valeurs de manche => relais 2SA');
      // 3C/3D sont des essais de manche orientés vers une seule majeure.
      if(L.H>=4&&L.H<=5&&L.S<=2&&H>=9) return out('3C',sem('user-multilandy-2C-heart-game-try','multi-landy',false,'one_round_if_uncontested',{suits:{H:{min:4,max:5}}}),'Multi-Landy/Landy : 3C = essai de manche à Cœur');
      if(L.S>=4&&L.S<=5&&L.H<=2&&H>=9) return out('3D',sem('user-multilandy-2C-spade-game-try','multi-landy',false,'one_round_if_uncontested',{suits:{S:{min:4,max:5}}}),'Multi-Landy/Landy : 3D = essai de manche à Pique');
      if(L.H>L.S) return out('2H',sem('user-multilandy-2C-heart-preference','multi-landy',true,'nonforcing',{suits:{H:{min:2,max:13}}}),'Multi-Landy/Landy : préférence Cœur');
      if(L.S>L.H) return out('2S',sem('user-multilandy-2C-spade-preference','multi-landy',true,'nonforcing',{suits:{S:{min:2,max:13}}}),'Multi-Landy/Landy : préférence Pique');
      return out('2D',sem('user-multilandy-2C-ask-longer-major','multi-landy',false,'one_round_if_uncontested'),'Multi-Landy/Landy : longueurs majeures égales => 2D demande la majeure la plus longue/meilleure');
    }
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ntHistory[1].call==='2C' && ntHistory[2].call==='PASS' && ntHistory[3].seat===partner && ntHistory[4].call==='PASS'){
      const adv=ntHistory[3].call;
      if(adv==='2D'){
        let m;if(L.H>L.S)m='H';else if(L.S>L.H)m='S';else if(L.H>=5&&L.S>=5)m='H';else m=suitHcp(ctx.deal,seat,'H')>=suitHcp(ctx.deal,seat,'S')?'H':'S';
        return out(`2${m}`,sem('user-multilandy-2C-show-major','multi-landy',true,'nonforcing',{suits:{[m]:{min:4,max:13}}}),`Multi-Landy/Landy : relais 2D, majeure choisie = ${m}`);
      }
      if(['2H','2S'].includes(adv)){if(HL<=14) return out('PASS',sem('user-multilandy-2C-respect-preference','multi-landy',true),'Multi-Landy/Landy : préférence directe de l’avancer, arrêt avec intervention non maximale');}
      if(adv==='2NT'){
        const m=L.H>=L.S?'H':'S';
        return out(`3${m}`,sem('user-multilandy-2C-gf-show-major','multi-landy',true,'game_if_uncontested',{suits:{[m]:{min:4,max:13}}}),`Multi-Landy/Landy : 2SA forcing de manche, meilleure majeure = 3${m}`);
      }
      if(adv==='3C') return out(HL>=13?'4H':'3H',sem('user-multilandy-2C-heart-game-try-answer','multi-landy',true,'nonforcing',{suits:{H:{min:4,max:13}}}),`Multi-Landy/Landy : réponse à l'essai 3C, ${HL>=13?'acceptation 4H':'refus 3H'}`);
      if(adv==='3D') return out(HL>=13?'4S':'3S',sem('user-multilandy-2C-spade-game-try-answer','multi-landy',true,'nonforcing',{suits:{S:{min:4,max:13}}}),`Multi-Landy/Landy : réponse à l'essai 3D, ${HL>=13?'acceptation 4S':'refus 3S'}`);
      if(adv==='3H'||adv==='3S'||adv==='4H'||adv==='4S') return out('PASS',sem('user-multilandy-2C-respect-major-level','multi-landy',true),'Multi-Landy/Landy : soutien direct propositionnel/de manche, arrêt');
    }
    // Après un soutien propositionnel 3M du partenaire sur notre Landy 2C,
    // l'adversaire peut surenchérir avant que l'intervenant ne reparle. Le sens public
    // du 3M reste exactement quatre cartes dans cette branche ; ne jamais laisser
    // PONS le relire comme une couleur sixième. Avec une intervention minimum, PASS
    // est une décision compétitive licite ; avec des valeurs de manche, 4M reste naturel.
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ntHistory[1].call==='2C' && ntHistory[2].call==='PASS' &&
       ntHistory[3].seat===partner && (ntHistory[3].call==='3H'||ntHistory[3].call==='3S') && sideOf(ntHistory[4].seat)!==sideOf(seat) && parseBid(ntHistory[4].call)){
      const m=ntHistory[3].call.slice(1), hld=supportHld(ctx.deal,seat,m);
      const pm=latestPartnerExplicitMeaning(ctx,x=>x.source===`user-multilandy-2C-${m==='H'?'heart':'spade'}-invite`);
      if((pm || L[m]>=4) && hld>=13){
        const game=`4${m}`;
        if(legal(game)) return out(game,sem('user-multilandy-2C-accept-invite-after-competition','multi-landy',true,'nonforcing',{suits:{[m]:{min:4,max:13}}}),`Multi-Landy/Landy : soutien propositionnel 3${m}, compétition adverse et ${hld} HLD => ${game}`);
      }
      if((pm || L[m]>=4) && raw==='PASS' && hld<=12)
        return out('PASS',sem('user-multilandy-2C-minimum-pass-after-competition','multi-landy',false,'nonforcing',{suits:{H:{min:L.H,max:L.H},S:{min:L.S,max:L.S}}}),`Multi-Landy/Landy : 3${m} partenaire promet quatre cartes ; intervention minimum (${hld} HLD), PASS compétitif validé sans inventer une sixième carte`);
    }

    // Le relais 2SA est forcing de manche : après la description 3M, le partenaire
    // place au minimum la manche dans la majeure connue.
    if(ntHistory.length===7 && ntHistory[0].call==='1NT'&&ntHistory[1].call==='2C'&&ntHistory[2].call==='PASS'&&ntHistory[3].seat===seat&&ntHistory[3].call==='2NT'&&ntHistory[4].call==='PASS'&&['3H','3S'].includes(ntHistory[5].call)&&ntHistory[6].call==='PASS'){
      const m=ntHistory[5].call.slice(1);return out(`4${m}`,sem('user-multilandy-2C-gf-close','multi-landy',true,'nonforcing',{suits:{[m]:{min:3,max:13}}}),`Multi-Landy/Landy : relais 2SA FM, conclusion minimale à 4${m}`);
    }

    // A4. 2D = unicolore majeur indéterminé. Les réponses suivent la structure
    // pass-or-correct / relais positif documentée dans le corpus antérieur.
    if(ntHistory.length===3 && ntHistory[0].call==='1NT' && ntHistory[1].seat===partner && ntHistory[1].call==='2D' && ntHistory[2].call==='PASS'){
      if(L.D>=6&&L.H<=2&&L.S<=2) return out('PASS',sem('user-multilandy-2D-diamond-conversion','multi-landy',true),'Multi-Landy : longue Carreau autonome, Passe sur 2D');
      if(H>=10&&L.H>=3&&L.S>=3) return out('2NT',sem('user-multilandy-2D-positive-relay','multi-landy',false,'one_round_if_uncontested'),'Multi-Landy : relais positif 2SA, demande majeure et force');
      if(L.H>=3&&L.S>=3&&H<=9) return out('3H',sem('user-multilandy-2D-double-major-support','multi-landy',false,'nonforcing'),'Multi-Landy : soutien des deux majeures sans ambition réelle de manche');
      if(L.H>=3&&L.S<=1&&H>=7) return out('2S',sem('user-multilandy-2D-heart-oriented','multi-landy',false,'nonforcing'),'Multi-Landy : 2S pass-or-correct orienté Cœur');
      return out('2H',sem('user-multilandy-2D-pass-correct','multi-landy',false,'nonforcing'),'Multi-Landy : 2H passe ou corrige à 2S');
    }
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ntHistory[1].call==='2D' && ntHistory[2].call==='PASS' && ntHistory[3].seat===partner && ntHistory[4].call==='PASS'){
      const adv=ntHistory[3].call;
      if(adv==='2H') return out(L.H>=6?'PASS':'2S',sem('user-multilandy-2D-pass-correct-answer','multi-landy',true),'Multi-Landy : réponse au 2H passe-ou-corrige');
      if(adv==='2S') return out(L.S>=6?'PASS':(HL>=13?'4H':'3H'),sem('user-multilandy-2D-oriented-answer','multi-landy',true,'nonforcing'),'Multi-Landy : 2S orienté, Pique passe ou Cœur se décrit');
      if(adv==='2NT'){
        const max=HL>=13;
        const target=L.H>=6?(max?'3S':'3C'):(max?'3H':'3D');
        return out(target,sem('user-multilandy-2D-positive-relay-answer','multi-landy',false,'one_round_if_uncontested'),`Multi-Landy : relais 2SA => majeure + ${max?'maximum':'minimum'} par ${target}`);
      }
      if(adv==='3H') return out(L.H>=6?'PASS':'3S',sem('user-multilandy-2D-double-support-answer','multi-landy',true),'Multi-Landy : double soutien, choix de la majeure');
    }
    // Après le relais positif 2SA et la réponse codée, l'avancer place le contrat majeur.
    if(ntHistory.length===7 && ntHistory[0].call==='1NT' && ntHistory[1].call==='2D' && ntHistory[2].call==='PASS' && ntHistory[3].seat===seat && ntHistory[3].call==='2NT' && ntHistory[4].call==='PASS' && ['3C','3D','3H','3S'].includes(ntHistory[5].call) && ntHistory[6].call==='PASS'){
      const a=ntHistory[5].call; const m=(a==='3C'||a==='3S')?'H':'S'; const max=(a==='3H'||a==='3S');
      const hld=supportHld(ctx.deal,seat,m); const target=(max||hld>=13)?`4${m}`:`3${m}`;
      return out(target,sem('user-multilandy-2D-positive-relay-close','multi-landy',true,'nonforcing',{suits:{[m]:{min:3,max:13}}}),`Multi-Landy : majeure ${m} révélée, ${max?'intervention maximum':'intervention minimum'} => ${target}`);
    }

    // A5. 2H/2S = majeure cinquième + mineure. Structure source :
    // Passe/3M/4M avec fit ; 2SA relais demandant simplement la mineure ; 3C
    // pass-or-correct avec les deux mineures ; 3D naturel très long ; sur 2H,
    // 2S peut être une longue couleur propre de l'avancer.
    if(ntHistory.length===3 && ntHistory[0].call==='1NT' && ntHistory[1].seat===partner && ['2H','2S'].includes(ntHistory[1].call) && ntHistory[2].call==='PASS'){
      const m=ntHistory[1].call.slice(1), hld=supportHld(ctx.deal,seat,m);
      if(L[m]>=3){
        if(hld>=13) return out(`4${m}`,sem('user-multilandy-2M-game','multi-landy',true,'nonforcing',{suits:{[m]:{min:3,max:13}}}),`Multi-Landy : fit ${m} et valeurs de manche`);
        if(hld>=10) return out(`3${m}`,sem('user-multilandy-2M-invite','multi-landy',true,'nonforcing',{suits:{[m]:{min:3,max:13}}}),`Multi-Landy : fit ${m} propositionnel`);
        return out('PASS',sem('user-multilandy-2M-fit-stop','multi-landy',true),'Multi-Landy : fit faible dans la majeure connue, Passe');
      }
      if(m==='H'&&L.S>=6&&L.H<=1&&H<=9) return out('2S',sem('user-multilandy-2H-own-spades','multi-landy',true,'nonforcing',{suits:{S:{min:6,max:13}}}),'Multi-Landy : sur 2H, longue Pique autonome de repli => 2S');
      if(L.D>=7&&H<=9) return out('3D',sem('user-multilandy-2M-own-long-diamonds','multi-landy',true,'nonforcing',{suits:{D:{min:7,max:13}}}),'Multi-Landy : longue Carreau 7e autonome => 3D');
      if(H>=9) return out('2NT',sem('user-multilandy-2M-ask-minor','multi-landy',false,'one_round_if_uncontested'),'Multi-Landy : 2SA relais, demande simplement la mineure');
      if(L.C>=4&&L.D>=4) return out('3C',sem('user-multilandy-2M-minor-pass-correct','multi-landy',false,'nonforcing',{suits:{C:{min:4,max:13},D:{min:4,max:13}}}),'Multi-Landy : 3C faible, soutien des deux mineures, passe ou corrige');
      return out('PASS',sem('user-multilandy-2M-misfit-weak-pass','multi-landy',true),'Multi-Landy : misfit faible sans repli sûr, Passe');
    }
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ['2H','2S'].includes(ntHistory[1].call) && ntHistory[2].call==='PASS' && ntHistory[3].seat===partner && ntHistory[4].call==='PASS'){
      const adv=ntHistory[3].call;
      if(adv==='2NT'){
        const mi=L.C>=4?'C':'D';
        const target=`3${mi}`;
        return out(target,sem('user-multilandy-2M-show-minor','multi-landy',true,'nonforcing',{suits:{[mi]:{min:4,max:13}}}),`Multi-Landy : relais 2SA, nomination naturelle de la mineure => ${target}`);
      }
      if(adv==='3C') return out(L.C>=4?'PASS':'3D',sem('user-multilandy-2M-minor-pass-correct-answer','multi-landy',true),'Multi-Landy : réponse au 3C passe-ou-corrige mineur');
      if(adv==='2S'&&ntHistory[1].call==='2H') return out(L.S>=2?'PASS':(L.C>=4?'3C':'3D'),sem('user-multilandy-2H-own-spades-answer','multi-landy',true,'nonforcing'),'Multi-Landy : 2S naturel de l’avancer ; Passe avec 2+ Piques, sinon retour dans la mineure');
      if(adv==='3D') return out('PASS',sem('user-multilandy-2M-respect-long-diamonds','multi-landy',true),'Multi-Landy : 3D naturel très long de l’avancer, arrêt');
      if(adv===ntHistory[1].call||adv===`4${ntHistory[1].call.slice(1)}`) return out('PASS',sem('user-multilandy-2M-respect-fit','multi-landy',true),'Multi-Landy : soutien direct de la majeure, arrêt');
    }

    // A6. 2SA = les deux mineures : l'avancer choisit la meilleure mineure au palier de 3.
    if(ntHistory.length===3 && ntHistory[0].call==='1NT' && ntHistory[1].seat===partner && ntHistory[1].call==='2NT' && ntHistory[2].call==='PASS'){
      const mi=L.C>L.D?'C':L.D>L.C?'D':(suitHcp(ctx.deal,seat,'C')>=suitHcp(ctx.deal,seat,'D')?'C':'D');
      return out(`3${mi}`,sem('user-multilandy-2NT-minor-choice','multi-landy',true,'nonforcing',{suits:{[mi]:{min:2,max:13}}}),`Multi-Landy : 2SA bicolore mineur, préférence ${mi}`);
    }
    if(ntHistory.length===5 && ntHistory[0].call==='1NT' && ntHistory[1].seat===seat && ntHistory[1].call==='2NT' && ntHistory[2].call==='PASS' && ntHistory[3].seat===partner && ['3C','3D'].includes(ntHistory[3].call) && ntHistory[4].call==='PASS'){
      return out('PASS',sem('user-multilandy-2NT-respect-minor-choice','multi-landy',true),'Multi-Landy : choix de mineure de l’avancer, arrêt');
    }

    // -------------------------------------------------------------------------
    // B. RUBENSOHL / défense du camp 1SA contre NOTRE Multi-Landy.
    // Le X mineure-majeure est ignoré : système 1SA normal (Stayman/Texas) conservé.
    // Sur 2H/2S, la majeure annoncée sert de couleur d'ancrage Rubensohl.
    // Sur 2D multi (majeure inconnue), on conserve le cœur du Rubensohl : 2NT-3H Texas.
    // -------------------------------------------------------------------------
    if(ntHistory.length===2 && ntHistory[0].seat===partner && ntHistory[0].call==='1NT' && !sameSide(ntHistory[1].seat,seat)){
      const ov=ntHistory[1].call;
      // B1. X conventionnel mineure-majeure : on l'ignore et on joue le système 1SA.
      if(ov==='X'){
        let target=null, semantic=null, reason='';
        if(L.H>=5){target='2D';semantic=sem('user-rubensohl-ignore-x-texas-H','rubensohl-vs-multilandy',false,'one_round_if_uncontested',{suits:{H:{min:5,max:13}}});reason='X Multi-Landy ignoré : Texas Cœur';}
        else if(L.S>=5){target='2H';semantic=sem('user-rubensohl-ignore-x-texas-S','rubensohl-vs-multilandy',false,'one_round_if_uncontested',{suits:{S:{min:5,max:13}}});reason='X Multi-Landy ignoré : Texas Pique';}
        else if((L.H>=4||L.S>=4)&&H>=7){target='2C';semantic=sem('user-rubensohl-ignore-x-stayman','rubensohl-vs-multilandy',false,'one_round_if_uncontested');reason='X Multi-Landy ignoré : Stayman';}
        else if(H>=10){target='3NT';semantic=sem('user-rubensohl-ignore-x-3NT','rubensohl-vs-multilandy',true);reason='X Multi-Landy ignoré : conclusion 3SA';}
        else if(H>=8){target='2NT';semantic=sem('user-rubensohl-ignore-x-2NT','rubensohl-vs-multilandy',true);reason='X Multi-Landy ignoré : proposition 2SA';}
        else target='PASS',semantic=sem('user-rubensohl-ignore-x-pass','rubensohl-vs-multilandy',true),reason='X Multi-Landy ignoré : pas de raison de quitter 1SA';
        return out(target,semantic,reason);
      }
      // B2. 2C Landy = les deux majeures. Défense de type Rubensohl/Landy :
      // 2D naturel faible ; X proposition de punition avec au moins une majeure 4e ;
      // 2SA Texas C, 3C Texas D ; 2H/2S décrivent la majeure et la courte dans l'autre.
      if(ov==='2C'){
        const short=SUITS.some(s=>L[s]<=1);
        if(L.D>=5&&H<=7) return out('2D',sem('user-rubensohl-vs-landy-weak-diamonds','rubensohl-vs-landy',true,'nonforcing',{suits:{D:{min:5,max:13}}}),'Défense Rubensohl/Landy : 2D naturel compétitif faible');
        if(L.H>=4&&L.S<=1&&H>=8) return out('2H',sem('user-rubensohl-vs-landy-heart-short-spade','rubensohl-vs-landy',false,'one_round_if_uncontested',{suits:{H:{min:4,max:13},S:{min:0,max:1}}}),'Défense Landy : 2H décrit la majeure Cœur avec courte Pique');
        if(L.S>=4&&L.H<=1&&H>=8) return out('2S',sem('user-rubensohl-vs-landy-spade-short-heart','rubensohl-vs-landy',false,'one_round_if_uncontested',{suits:{S:{min:4,max:13},H:{min:0,max:1}}}),'Défense Landy : 2S décrit la majeure Pique avec courte Cœur');
        if((L.C>=6||(L.C>=5&&L.D>=4))&&short) return out('2NT',sem('user-rubensohl-vs-landy-club-transfer','rubensohl-vs-landy',false,'one_round_if_uncontested',{suits:{C:{min:5,max:13}}}),'Défense Rubensohl/Landy : 2SA Texas Trèfle, main irrégulière');
        if(L.D>=6&&short&&HL>=9) return out('3C',sem('user-rubensohl-vs-landy-diamond-transfer','rubensohl-vs-landy',false,'one_round_if_uncontested',{suits:{D:{min:6,max:13}}}),'Défense Rubensohl/Landy : 3C Texas Carreau');
        if(L.C>=5&&L.D>=4&&short&&HL>=10) return out('3H',sem('user-rubensohl-vs-landy-minor-54-clubs','rubensohl-vs-landy',false,'game_if_uncontested',{suits:{C:{min:5,max:13},D:{min:4,max:13}}}),'Défense Landy : 3H décrit 5C-4D avec courte majeure');
        if(L.D>=5&&L.C>=4&&short&&HL>=10) return out('3S',sem('user-rubensohl-vs-landy-minor-54-diamonds','rubensohl-vs-landy',false,'game_if_uncontested',{suits:{D:{min:5,max:13},C:{min:4,max:13}}}),'Défense Landy : 3S décrit 5D-4C avec courte majeure');
        if(H>=10&&strictBalanced(L)) return out('3NT',sem('user-rubensohl-vs-landy-3NT','rubensohl-vs-landy',true,'nonforcing'),'Défense Landy : main régulière de manche => 3SA, même sans arrêt parfait');
        if(H>=7&&(L.H>=4||L.S>=4)) return out('X',sem('user-rubensohl-vs-landy-values-double','rubensohl-vs-landy',false,'unknown'),'Défense Landy : contre de proposition punitive / valeurs avec majeure quatrième');
        return out('PASS',sem('user-rubensohl-vs-landy-weak-pass','rubensohl-vs-landy',true),'Défense Landy : main faible sans enchère adaptée => Passe');
      }
      // B3. 2D multi = majeure inconnue : enchères au palier de 2 naturelles faibles,
      // puis Texas en chaîne à partir de 2SA. Pas de "Texas impossible" puisqu'aucune
      // couleur adverse n'est encore identifiée.
      if(ov==='2D'){
        if(L.H>=5&&H<=7) return out('2H',sem('user-rubensohl-vs-multi-weak-H','rubensohl-vs-multilandy',true,'nonforcing',{suits:{H:{min:5,max:13}}}),'Rubensohl vs 2D multi : 2H naturel faible');
        if(L.S>=5&&H<=7) return out('2S',sem('user-rubensohl-vs-multi-weak-S','rubensohl-vs-multilandy',true,'nonforcing',{suits:{S:{min:5,max:13}}}),'Rubensohl vs 2D multi : 2S naturel faible');
        if(L.C>=5) return out('2NT',sem('user-rubensohl-vs-multi-transfer-C','rubensohl-vs-multilandy',false,'one_round_if_uncontested',{suits:{C:{min:5,max:13}}}),'Rubensohl vs 2D multi : 2SA Texas Trèfle');
        if(L.D>=5) return out('3C',sem('user-rubensohl-vs-multi-transfer-D','rubensohl-vs-multilandy',false,'one_round_if_uncontested',{suits:{D:{min:5,max:13}}}),'Rubensohl vs 2D multi : 3C Texas Carreau');
        if(L.H>=5&&H>=8) return out('3D',sem('user-rubensohl-vs-multi-transfer-H','rubensohl-vs-multilandy',false,'one_round_if_uncontested',{suits:{H:{min:5,max:13}}}),'Rubensohl vs 2D multi : 3D Texas Cœur');
        if(L.S>=5&&H>=8) return out('3H',sem('user-rubensohl-vs-multi-transfer-S','rubensohl-vs-multilandy',false,'one_round_if_uncontested',{suits:{S:{min:5,max:13}}}),'Rubensohl vs 2D multi : 3H Texas Pique');
        if(H>=8) return out('X',sem('user-rubensohl-vs-multi-values-double','rubensohl-vs-multilandy',false,'unknown'),`Rubensohl vs 2D multi : contre de valeurs/appel, sans obligation immédiate sur l'ouverture artificielle`);
        return out('PASS',sem('user-rubensohl-vs-multi-weak-pass','rubensohl-vs-multilandy',true),'Rubensohl vs 2D multi : main faible sans couleur naturelle => Passe');
      }
      // B4. 2H = Cœurs + mineure. On traite la couleur connue H comme ancre Rubensohl.
      if(ov==='2H'){
        const stop=stopperScore(ctx.deal,seat,'H')>=0.7;
        if(L.S>=5&&H<=8) return out('2S',sem('user-rubensohl-weak-S-over-2H','rubensohl',true,'nonforcing',{suits:{S:{min:5,max:13}}}),'Rubensohl : 2S naturel faible sur 2H');
        // SEF/Rubensohl : à partir de 2SA tout est Texas. Les Texas mineurs peuvent
        // être purement compétitifs : pas de singleton obligatoire, pas de plancher 9 HL.
        if(L.C>=6&&H>=4) return out('2NT',sem('user-rubensohl-transfer-C-over-2H','rubensohl',false,'one_round_if_uncontested',{suits:{C:{min:6,max:13}}}),'Rubensohl : 2SA Texas Trèfle, longue 6e compétitive');
        if(L.D>=6&&H>=4) return out('3C',sem('user-rubensohl-transfer-D-over-2H','rubensohl',false,'one_round_if_uncontested',{suits:{D:{min:6,max:13}}}),'Rubensohl : 3C Texas Carreau, longue 6e compétitive');
        if(L.S>=5&&H>=8) return out('3H',sem('user-rubensohl-transfer-S-over-2H','rubensohl',false,'one_round_if_uncontested',{suits:{S:{min:5,max:13}}}),'Rubensohl : 3H Texas Pique constructif');
        if(L.C>=5&&L.S<=4&&L.C>=L.D&&H>=4) return out('2NT',sem('user-rubensohl-transfer-C-over-2H','rubensohl',false,'one_round_if_uncontested',{suits:{C:{min:5,max:13}}}),'Rubensohl : 2SA Texas Trèfle (force inconnue)');
        if(L.D>=5&&L.S<=4&&L.D>L.C&&H>=4) return out('3C',sem('user-rubensohl-transfer-D-over-2H','rubensohl',false,'one_round_if_uncontested',{suits:{D:{min:5,max:13}}}),'Rubensohl : 3C Texas Carreau (force inconnue)');
        if(L.S===4&&H>=10) return out('3D',sem('user-rubensohl-impossible-transfer-stayman-over-2H','rubensohl',false,'game_if_uncontested',{suits:{S:{min:4,max:4}}}),'Rubensohl : Texas impossible 3D = Stayman');
        if(H>=10&&stop) return out('3NT',sem('user-rubensohl-3NT-stopper-over-2H','rubensohl',true,'nonforcing'),'Rubensohl : 3SA naturel avec arrêt Cœur');
        if(H>=10&&!stop&&L.S<=3&&SUITS.map(s=>L[s]).sort((a,b)=>a-b).join('-')!=='3-3-3-4') return out('3S',sem('user-rubensohl-stopper-ask-over-2H','rubensohl',false,'one_round_if_uncontested',{suits:{S:{min:0,max:3}}}),'Rubensohl : 3S demande l’arrêt Cœur pour jouer 3SA');
        if(H>=10&&SUITS.map(s=>L[s]).sort((a,b)=>a-b).join('-')==='3-3-3-4') return out('3NT',sem('user-rubensohl-3NT-4333-over-2H','rubensohl',true,'nonforcing'),'Rubensohl : 4333 de manche => 3SA même sans arrêt parfait');
        if(H>=8||(H>=6&&L.S>=4)) return out('X',sem('user-rubensohl-double-over-2H','rubensohl',false,'unknown'),'Rubensohl : contre d’appel ; 8H+ sans enchère plus descriptive, ou plus léger avec quatre Piques');
        return out('PASS',sem('user-rubensohl-weak-pass-over-2H','rubensohl',true),'Rubensohl : main faible sans enchère naturelle sur 2H => Passe');
      }
      // B5. 2S = Piques + mineure. Ancre Rubensohl = Pique.
      if(ov==='2S'){
        const stop=stopperScore(ctx.deal,seat,'S')>=0.7;
        // Après 2S, 2SA/3C/3D sont respectivement Texas T/K/C. Ils peuvent être
        // compétitifs : une longue sixième faible doit pouvoir quitter 2S.
        if(L.C>=6&&H>=4) return out('2NT',sem('user-rubensohl-transfer-C-over-2S','rubensohl',false,'one_round_if_uncontested',{suits:{C:{min:6,max:13}}}),'Rubensohl : 2SA Texas Trèfle, longue 6e compétitive');
        if(L.D>=6&&H>=4) return out('3C',sem('user-rubensohl-transfer-D-over-2S','rubensohl',false,'one_round_if_uncontested',{suits:{D:{min:6,max:13}}}),'Rubensohl : 3C Texas Carreau, longue 6e compétitive');
        if(L.H>=5&&H>=4) return out('3D',sem('user-rubensohl-transfer-H-over-2S','rubensohl',false,'one_round_if_uncontested',{suits:{H:{min:5,max:13}}}),'Rubensohl : 3D Texas Cœur (force inconnue)');
        if(L.C>=5&&L.H<=4&&L.C>=L.D&&H>=4) return out('2NT',sem('user-rubensohl-transfer-C-over-2S','rubensohl',false,'one_round_if_uncontested',{suits:{C:{min:5,max:13}}}),'Rubensohl : 2SA Texas Trèfle (force inconnue)');
        if(L.D>=5&&L.H<=4&&L.D>L.C&&H>=4) return out('3C',sem('user-rubensohl-transfer-D-over-2S','rubensohl',false,'one_round_if_uncontested',{suits:{D:{min:5,max:13}}}),'Rubensohl : 3C Texas Carreau (force inconnue)');
        if(L.H===4&&H>=10) return out('3H',sem('user-rubensohl-impossible-transfer-stayman-over-2S','rubensohl',false,'game_if_uncontested',{suits:{H:{min:4,max:4}}}),'Rubensohl : Texas impossible 3H = Stayman');
        if(H>=10&&stop) return out('3NT',sem('user-rubensohl-3NT-stopper-over-2S','rubensohl',true,'nonforcing'),'Rubensohl : 3SA naturel avec arrêt Pique');
        if(H>=10&&!stop&&L.H<=3&&SUITS.map(s=>L[s]).sort((a,b)=>a-b).join('-')!=='3-3-3-4') return out('3S',sem('user-rubensohl-stopper-ask-over-2S','rubensohl',false,'one_round_if_uncontested',{suits:{H:{min:0,max:3}}}),'Rubensohl : 3S demande l’arrêt Pique pour jouer 3SA');
        if(H>=10&&SUITS.map(s=>L[s]).sort((a,b)=>a-b).join('-')==='3-3-3-4') return out('3NT',sem('user-rubensohl-3NT-4333-over-2S','rubensohl',true,'nonforcing'),'Rubensohl : 4333 de manche => 3SA même sans arrêt parfait');
        if(H>=8||(H>=6&&L.H>=4)) return out('X',sem('user-rubensohl-double-over-2S','rubensohl',false,'unknown'),'Rubensohl : contre d’appel ; 8H+ sans enchère plus descriptive, ou plus léger avec quatre Cœurs');
        return out('PASS',sem('user-rubensohl-weak-pass-over-2S','rubensohl',true),'Rubensohl : main faible sans enchère naturelle sur 2S => Passe');
      }
    }
    // B5bis. Après 2C Landy, les enchères forcing 2H/2S du répondant demandent
    // une description simple de l'ouvreur : fit 4e au palier de 3, sinon 2SA.
    if(ntHistory.length===4 && ntHistory[0].seat===seat && ntHistory[0].call==='1NT' && ntHistory[1].call==='2C' && ntHistory[2].seat===partner && ['2H','2S'].includes(ntHistory[2].call) && ntHistory[3].call==='PASS'){
      const m=ntHistory[2].call.slice(1);
      if(L[m]>=4) return out(`3${m}`,sem('user-rubensohl-vs-landy-opener-fit','rubensohl-vs-landy',true,'nonforcing',{suits:{[m]:{min:4,max:13}}}),`Défense Landy : fit 4-4 en ${m} => 3${m}`);
      return out('2NT',sem('user-rubensohl-vs-landy-opener-no-fit','rubensohl-vs-landy',true,'nonforcing'),`Défense Landy : pas de fit 4-4 en ${m} => 2SA`);
    }
    if(ntHistory.length===6 && ntHistory[0].seat===partner && ntHistory[0].call==='1NT' && ntHistory[1].call==='2C' && ntHistory[2].seat===seat && ['2H','2S'].includes(ntHistory[2].call) && ntHistory[3].call==='PASS' && ntHistory[4].seat===partner && ntHistory[5].call==='PASS'){
      const m=ntHistory[2].call.slice(1), rebid=ntHistory[4].call;
      if(rebid===`3${m}`) return out(H>=10?`4${m}`:'PASS',sem('user-rubensohl-vs-landy-responder-after-fit','rubensohl-vs-landy',true,'nonforcing'),H>=10?`Défense Landy : valeurs de manche après fit ${m} => 4${m}`:`Défense Landy : fit trouvé, valeurs limitées => arrêt à 3${m}`);
      if(rebid==='2NT') return out(H>=10?'3NT':'PASS',sem('user-rubensohl-vs-landy-responder-after-2NT','rubensohl-vs-landy',true,'nonforcing'),H>=10?'Défense Landy : pas de fit majeur, valeurs de manche => 3SA':'Défense Landy : pas de fit majeur, valeurs limitées => Passe');
    }

    // B6. L'ouvreur de 1SA rectifie obligatoirement les Texas Rubensohl.
    if(ntHistory.length===4 && ntHistory[0].seat===seat && ntHistory[0].call==='1NT' && !sameSide(ntHistory[1].seat,seat) && ntHistory[2].seat===partner && ntHistory[3].call==='PASS'){
      const ov=ntHistory[1].call, r=ntHistory[2].call;
      const transferMap={
        '2C':{'2NT':'3C','3C':'3D'},
        '2D':{'2NT':'3C','3C':'3D','3D':'3H','3H':'3S'},
        '2H':{'2NT':'3C','3C':'3D','3H':'3S'},
        '2S':{'2NT':'3C','3C':'3D','3D':'3H'}
      };
      const t=transferMap[ov]?.[r];
      if(t){
        const targetSuit=t.slice(1);
        // Les Texas majeurs à hauteur de 3 sont au moins propositionnels :
        // avec 17 H et un vrai fit 5-3, l'ouvreur accepte directement la manche.
        if((targetSuit==='H'||targetSuit==='S')&&H>=17&&L[targetSuit]>=3){
          return out(`4${targetSuit}`,sem('user-rubensohl-opener-accepts-major-transfer','rubensohl-vs-multilandy',true,'nonforcing',{suits:{[targetSuit]:{min:3,max:13}},hcp:{min:17,max:17}}),`Rubensohl : maximum 17 H + fit ${targetSuit} => acceptation à 4${targetSuit}`);
        }
        return out(t,sem('user-rubensohl-opener-completes-transfer','rubensohl-vs-multilandy',true,'nonforcing'),`Rubensohl : rectification ${r} -> ${t}`);
      }
      // 3S est la demande d'arrêt de la majeure adverse dans les fiches Rubensohl
      // naturelles. Avec l'arrêt, l'ouvreur conclut immédiatement à 3SA.
      if(r==='3S'&&ov==='2H'&&stopperScore(ctx.deal,seat,'H')>=0.7) return out('3NT',sem('user-rubensohl-opener-answers-stopper-ask','rubensohl',true,'nonforcing'),'Rubensohl : demande d’arrêt Cœur, arrêt présent => 3SA');
      if(r==='3S'&&ov==='2S'&&stopperScore(ctx.deal,seat,'S')>=0.7) return out('3NT',sem('user-rubensohl-opener-answers-stopper-ask','rubensohl',true,'nonforcing'),'Rubensohl : demande d’arrêt Pique, arrêt présent => 3SA');
      // Stayman après Texas impossible sur 2H/2S.
      if(ov==='2H'&&r==='3D'){
        if(L.S>=4) return out('3S',sem('user-rubensohl-opener-stayman-spades','rubensohl',true,'game_if_uncontested',{suits:{S:{min:4,max:13}}}),'Rubensohl : Stayman sur 2H, quatre Piques => 3S');
        if(stopperScore(ctx.deal,seat,'H')>=0.7) return out('3NT',sem('user-rubensohl-opener-stayman-nt','rubensohl',true),'Rubensohl : pas quatre Piques, arrêt Cœur => 3SA');
        return out('3H',sem('user-rubensohl-opener-stayman-no-stopper','rubensohl',false,'game_if_uncontested'),'Rubensohl : pas quatre Piques et pas d’arrêt Cœur => cue-bid 3H');
      }
      if(ov==='2S'&&r==='3H'){
        if(L.H>=4) return out('4H',sem('user-rubensohl-opener-stayman-hearts','rubensohl',true,'nonforcing',{suits:{H:{min:4,max:13}}}),'Rubensohl : Stayman sur 2S, quatre Cœurs => 4H');
        if(stopperScore(ctx.deal,seat,'S')>=0.7) return out('3NT',sem('user-rubensohl-opener-stayman-nt','rubensohl',true),'Rubensohl : pas quatre Cœurs, arrêt Pique => 3SA');
        return out('3S',sem('user-rubensohl-opener-stayman-no-stopper','rubensohl',false,'game_if_uncontested'),'Rubensohl : pas quatre Cœurs et pas d’arrêt Pique => cue-bid 3S');
      }
      // Après le X de valeurs, priorité à l'autre majeure puis aux SA avec arrêt.
      if(r==='X'&&(ov==='2H'||ov==='2S')){
        const opp=ov.slice(1), other=opp==='H'?'S':'H';
        // Le Contre Rubensohl est d'appel, mais l'ouvreur peut le transformer avec
        // une vraie longueur liée dans la couleur adverse. Avec cinq atouts et au
        // moins une séquence/honneur utile, la conversion punitive est prioritaire.
        const oppCards=String(ctx.deal?.hands?.[seat]?.[opp]||'');
        const linkedFour=(L[opp]>=4 && oppCards.includes('Q') && oppCards.includes('J') && (oppCards.includes('T')||oppCards.includes('9')));
        const penaltyHolding=(L[opp]>=5 && /[AKQJ]/.test(oppCards)) || linkedFour;
        if(penaltyHolding) return out('PASS',sem('user-rubensohl-opener-converts-double-penalty','rubensohl',true,'nonforcing',{suits:{[opp]:{min:4,max:13}}}),`Rubensohl : X d'appel transformé en punitif avec ${oppCards} dans la couleur adverse`);
        // Sinon, priorité à l'autre majeure lorsqu'elle est quatrième.
        if(opp==='H'&&L.S>=4) return out('2S',sem('user-rubensohl-opener-after-double-other-major','rubensohl',true,'nonforcing',{suits:{S:{min:4,max:13}}}),'Rubensohl : sur X, priorité aux quatre Piques');
        if(opp==='S'&&L.H>=4) return out('3H',sem('user-rubensohl-opener-after-double-other-major','rubensohl',true,'nonforcing',{suits:{H:{min:4,max:13}}}),'Rubensohl : sur X, priorité aux quatre Cœurs');
        const stop=stopperScore(ctx.deal,seat,opp)>=0.7;
        if(stop) return out(H>=16?'3NT':'2NT',sem('user-rubensohl-opener-after-double-nt','rubensohl',true,'nonforcing'),`Rubensohl : X de valeurs, arrêt ${opp} => SA`);
        // Sans arrêt et sans autre majeure quatrième, une mineure quatrième naturelle
        // est préférable. Le répondant limité peut s'y arrêter.
        const minors=['C','D'].filter(mi=>L[mi]>=4).sort((a,b)=>L[b]-L[a]||suitHcp(ctx.deal,seat,b)-suitHcp(ctx.deal,seat,a));
        if(minors.length){const mi=minors[0];return out(`3${mi}`,sem('user-rubensohl-opener-after-double-minor','rubensohl',true,'nonforcing',{suits:{[mi]:{min:4,max:13}}}),`Rubensohl : X, sans arrêt ${opp} ni autre majeure quatrième => 3${mi} naturel`);}
        // Le cue-bid est une action de maximum, pas un refuge automatique de toute
        // main sans arrêt. À 15-16 H, on laisse le choix natif PONS survivre.
        if(H>=17) return out(`3${opp}`,sem('user-rubensohl-opener-after-double-cuebid','rubensohl',false,'one_round_if_uncontested',{hcp:{min:17,max:17}}),`Rubensohl : ouvreur maximum sans arrêt ${opp} ni enchère naturelle => cue-bid`);
      }
    }
    // B6.1. Après le Texas impossible (= Stayman) sur 2H, la réponse 3S de
    // l'ouvreur établit explicitement le fit 4-4 à Pique. Le répondant avait déjà
    // promis une main de manche en utilisant 3D : il conclut donc à 4S et ne peut
    // ni passer, ni revenir à 3SA.
    if(ntHistory.length===6 && ntHistory[0].seat===partner && ntHistory[0].call==='1NT' && ntHistory[1].call==='2H' && ntHistory[2].seat===seat && ntHistory[2].call==='3D' && ntHistory[3].call==='PASS' && ntHistory[4].seat===partner && ntHistory[4].call==='3S' && ntHistory[5].call==='PASS'){
      if(L.S>=4) return out('4S',sem('user-rubensohl-responder-closes-stayman-spade-fit','rubensohl',true,'nonforcing',{suits:{S:{min:4,max:13}},hcp:{min:10,max:37}}),'Rubensohl : Texas impossible/Stayman, fit Pique trouvé => 4S');
    }

    // B6a. Après rectification d'un Texas mineur Rubensohl, une main faible/compétitive
    // peut s'arrêter. Cela protège précisément les mains 6m faibles qui utilisent le transfert
    // pour ne pas laisser jouer l'adversaire au palier de 2.
    if(ntHistory.length===6 && ntHistory[0].seat===partner && ntHistory[0].call==='1NT' && !sameSide(ntHistory[1].seat,seat) && ntHistory[2].seat===seat && ntHistory[3].call==='PASS' && ntHistory[4].seat===partner && ntHistory[5].call==='PASS'){
      const ov=ntHistory[1].call, r=ntHistory[2].call, completed=ntHistory[4].call;
      const clubTransfer=(r==='2NT'&&completed==='3C'&&['2C','2D','2H','2S'].includes(ov));
      const diamondTransfer=(r==='3C'&&completed==='3D'&&['2C','2D','2H','2S'].includes(ov));
      if(clubTransfer&&L.C>=5&&H<=8) return out('PASS',sem('user-rubensohl-weak-club-transfer-stop','rubensohl',true,'nonforcing',{suits:{C:{min:5,max:13}},hcp:{min:0,max:8}}),'Rubensohl : Texas Trèfle compétitif rectifié, arrêt');
      if(diamondTransfer&&L.D>=5&&H<=8) return out('PASS',sem('user-rubensohl-weak-diamond-transfer-stop','rubensohl',true,'nonforcing',{suits:{D:{min:5,max:13}},hcp:{min:0,max:8}}),'Rubensohl : Texas Carreau compétitif rectifié, arrêt');
    }

    // B6bis. Après une simple rectification d'un Texas majeur propositionnel,
    // 10 H+ chez le répondant suffisent pour conclure la manche ; 8/9 peuvent s'arrêter.
    if(ntHistory.length===6 && ntHistory[0].seat===partner && ntHistory[0].call==='1NT' && !sameSide(ntHistory[1].seat,seat) && ntHistory[2].seat===seat && ntHistory[3].call==='PASS' && ntHistory[4].seat===partner && ntHistory[5].call==='PASS'){
      const ov=ntHistory[1].call, r=ntHistory[2].call, completed=ntHistory[4].call;
      const major=(completed==='3H'?'H':completed==='3S'?'S':null);
      const isMajorTransfer=(ov==='2D'&&(r==='3D'||r==='3H'))||(ov==='2H'&&r==='3H')||(ov==='2S'&&r==='3D');
      if(isMajorTransfer&&major){
        if(H>=10) return out(`4${major}`,sem('user-rubensohl-responder-closes-major-game','rubensohl-vs-multilandy',true,'nonforcing',{suits:{[major]:{min:5,max:13}},hcp:{min:10,max:37}}),`Rubensohl : après rectification du Texas ${major}, ${H} H => manche`);
        return out('PASS',sem('user-rubensohl-responder-respects-declined-invite','rubensohl-vs-multilandy',true,'nonforcing'),`Rubensohl : Texas majeur propositionnel, ${H} H => arrêt après rectification minimale`);
      }
    }

    // B7. Après X conventionnel ignoré, l'ouvreur complète Stayman/Texas comme sans intervention.
    if(ntHistory.length===4 && ntHistory[0].seat===seat && ntHistory[0].call==='1NT' && ntHistory[1].call==='X' && ntHistory[2].seat===partner && ntHistory[3].call==='PASS'){
      const r=ntHistory[2].call;
      if(r==='2D') return out('2H',sem('user-rubensohl-ignore-x-complete-H','rubensohl-vs-multilandy',true),'X Multi-Landy ignoré : rectification du Texas Cœur');
      if(r==='2H') return out('2S',sem('user-rubensohl-ignore-x-complete-S','rubensohl-vs-multilandy',true),'X Multi-Landy ignoré : rectification du Texas Pique');
      if(r==='2C'){
        const target=L.H>=4?'2H':L.S>=4?'2S':'2D';
        return out(target,sem('user-rubensohl-ignore-x-stayman-answer','rubensohl-vs-multilandy',true,'nonforcing'),`X Multi-Landy ignoré : réponse Stayman ${target}`);
      }
    }

    // -------------------------------------------------------------------------
    // B8. 1M-(X)-? — SEF 2024 + accords Jess non ambigus.
    //
    // Périmètre volontairement séparé du Drury : le répondant n'a pas passé d'entrée.
    // Le Contre adverse est un contre d'appel. On impose ici les significations
    // structurelles qui doivent survivre aux tours suivants :
    //   - 1S sur 1H : naturel 4+, forcing ;
    //   - 1SA : 8-10 HL, sans fit, régulier/semi-régulier ;
    //   - nouvelles couleurs au palier de 2 : naturelles, non forcing, longues ;
    //   - 2M : soutien constructif ; 3M/4M : barrages selon la Loi des atouts ;
    //   - saut dans l'autre majeure : Mixed Raise Jess (4 atouts, 8-10 HLD) ;
    //   - saut en mineure : enchère de rencontre SEF 2024 (4 atouts, belle mineure 5e, 11+ HLD) ;
    //   - 2SA : Truscott 4 atouts, 11-12 HLD ;
    //   - 3SA : Super-Truscott 4 atouts, 13-15 HLD, main sans courte ;
    //   - double saut dans une nouvelle couleur : Splinter SEF 2024 ;
    //   - XX : 10+ H sans fit ou 11+ HLD avec exactement 3 atouts ;
    //     il ouvre un processus punitif : les Contres ultérieurs sont punitifs et
    //     les Passes de l'ouvreur après un dégagement adverse sont forcing.
    //
    // Les anciennes variantes Texas de la fiche 101a ne sont pas activées ici : les
    // documents utilisateur les marquent contradictoires / à arbitrer, tandis que le
    // chantier demandé est explicitement ancré dans le standard français.
    const mxHistory=(firstBidIndex>=0&&['1H','1S'].includes(history[firstBidIndex]?.call))?history.slice(firstBidIndex):[];
    const passedBeforeMx=(who)=>firstBidIndex>0&&history.slice(0,firstBidIndex).some(x=>x.seat===who&&x.call==='PASS');
    const goodFive=(s)=>{
      const cards=String(ctx.deal?.hands?.[seat]?.[s]||'');
      if(cards.length<5) return false;
      const top=['A','K','Q'].filter(r=>cards.includes(r)).length;
      const support=['J','T','9'].filter(r=>cards.includes(r)).length;
      return top>=2 || (top>=1&&support>=2);
    };
    const firstLegalMajorLevel=(m)=>{
      const last=lastActualBid(history), lr=bidRank(last?.call);
      for(let lev=2;lev<=7;lev++){
        const c=`${lev}${m}`;
        if(bidRank(c)>lr&&legal(c)) return c;
      }
      return null;
    };
    const ownExplicit=(predicate=null)=>{
      const entries=Array.isArray(ctx.semanticContext?.entries)?ctx.semanticContext.entries:[];
      for(let i=entries.length-1;i>=0;i--){
        const e=entries[i], x=e?.explicitMeaning;
        if(e?.seat!==seat||!x) continue;
        if(!predicate||predicate(x,e)) return x;
      }
      const e=ctx.semanticContext?.entry, x=e?.explicitMeaning;
      if(e?.seat===seat&&x&&(!predicate||predicate(x,e))) return x;
      return null;
    };

    // B8.1 — première réponse après 1M-(X), répondant non passé.
    if(mxHistory.length===2 && mxHistory[0].seat===partner && mxHistory[1].call==='X' &&
       !sameSide(mxHistory[1].seat,seat) && !passedBeforeMx(seat)){
      const m=mxHistory[0].call.slice(1), other=m==='H'?'S':'H';
      const fit=L[m], hld=supportHld(ctx.deal,seat,m);
      const shorts=SUITS.filter(s=>s!==m&&L[s]<=1);

      // Splinter : double saut dans une nouvelle couleur, 4+ atouts, courte et valeurs de manche.
      if(fit>=4 && hld>=13 && hld<=15 && shorts.length){
        const splinterCalls=[];
        for(const s of shorts){
          let c=null;
          if(m==='H') c=s==='S'?'3S':(s==='C'||s==='D')?`4${s}`:null;
          else c=(s==='C'||s==='D'||s==='H')?`4${s}`:null;
          if(c&&legal(c)) splinterCalls.push({s,c});
        }
        if(splinterCalls.length){
          const x=splinterCalls[0];
          return out(x.c,sem('sef2024-1M-X-splinter','sef2024-1M-X',false,'game_if_uncontested',{suits:{[m]:{min:4,max:13},[x.s]:{min:0,max:1}},points:{min:13,max:15}}),`SEF 2024 : après 1${m}-(X), ${x.c} est Splinter (${fit} atouts, courte ${x.s}, ${hld} HLD)`);
        }
      }

      // Enchère de rencontre : saut en mineure, 5 belles cartes + 4 atouts, 11+ HLD.
      if(fit>=4 && hld>=11){
        const minors=['C','D'].filter(mi=>L[mi]>=5&&goodFive(mi)).sort((a,b)=>L[b]-L[a]||suitHcp(ctx.deal,seat,b)-suitHcp(ctx.deal,seat,a));
        if(minors.length){
          const mi=minors[0], c=`3${mi}`;
          if(legal(c)) return out(c,sem('sef2024-1M-X-fit-jump','sef2024-1M-X',true,'one_round_if_uncontested',{suits:{[m]:{min:4,max:13},[mi]:{min:5,max:13}},points:{min:11,max:37}}),`SEF 2024 : enchère de rencontre ${c}, 4+ atouts et belle mineure 5e`);
        }
      }

      // Mixed Raise spécifique Jess dans l'autre majeure.
      const mixedCall=m==='H'?'2S':'3H';
      if(fit>=4 && hld>=8 && hld<=10 && legal(mixedCall))
        return out(mixedCall,sem('jess-1M-X-mixed-raise','jess-mixed-raise',false,'one_round_if_uncontested',{suits:{[m]:{min:4,max:13}},points:{min:8,max:10}}),`Accord Jess : ${mixedCall} = Mixed Raise, ${fit} atouts et ${hld} HLD`);

      // Truscott et Super-Truscott.
      if(fit>=4 && hld>=13 && hld<=15 && shorts.length===0 && legal('3NT'))
        return out('3NT',sem('sef2024-1M-X-super-truscott','sef2024-1M-X',false,'one_round_if_uncontested',{suits:{[m]:{min:4,max:13}},points:{min:13,max:15}}),`SEF 2024 : 3SA Super-Truscott, fit 4e et ${hld} HLD sans courte`);
      if(fit>=4 && hld>=11 && hld<=12 && legal('2NT'))
        return out('2NT',sem('sef2024-1M-X-truscott','sef2024-1M-X',false,'one_round_if_uncontested',{suits:{[m]:{min:4,max:13}},points:{min:11,max:12}}),`SEF 2024 : 2SA Truscott, fit 4e et ${hld} HLD`);

      // Barrages fondés sur le nombre d'atouts : 4M avec fit dixième, 3M avec fit neuvième.
      if(fit>=5 && H<=10 && legal(`4${m}`))
        return out(`4${m}`,sem('sef2024-1M-X-four-major-preempt','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:5,max:13}},hcp:{min:0,max:10}}),`SEF 2024 / Loi des atouts : fit 10e, barrage à 4${m}`);
      if(fit>=4 && H<=7 && legal(`3${m}`))
        return out(`3${m}`,sem('sef2024-1M-X-three-major-preempt','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:4,max:13}},hcp:{min:0,max:7}}),`SEF 2024 / Loi des atouts : fit 9e, barrage à 3${m}`);

      // Soutien simple constructif. Avec quatre atouts 8-10 HLD, le Mixed Raise a déjà priorité.
      if(fit>=3 && hld>=6 && hld<=10 && legal(`2${m}`))
        return out(`2${m}`,sem('sef2024-1M-X-simple-raise','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:3,max:13}},points:{min:6,max:10}}),`SEF 2024 : soutien simple ${fit} atouts, ${hld} HLD`);

      // La majeure au palier de 1 reste naturelle et forcing.
      if(m==='H' && L.S>=4 && HL>=7 && legal('1S'))
        return out('1S',sem('sef2024-1H-X-1S-natural','sef2024-1M-X',true,'one_round_if_uncontested',{suits:{S:{min:4,max:13}},points:{min:7,max:37}}),`SEF 2024 : 1P naturel 4+ et forcing après 1C-(X)`);

      // Surcontre : main forte sans fit ou exactement trois atouts avec 11+ HLD.
      // Une couleur naturelle au palier de 1 garde la priorité ; au palier de 2, on
      // conserve une belle longue limitée plutôt que de transformer toute main en XX.
      const naturalLowCandidates=SUITS.filter(s=>s!==m&&L[s]>=5&&goodFive(s)&&H<=11)
        .map(s=>({s,call:cheapestSuitCallAfter(history,s)}))
        .filter(x=>x.call&&x.call.startsWith('2')&&legal(x.call))
        .sort((a,b)=>(L[b.s]-L[a.s]) || (suitHcp(ctx.deal,seat,b.s)-suitHcp(ctx.deal,seat,a.s)) || (bidRank(a.call)-bidRank(b.call)));
      const naturalLow=naturalLowCandidates.length>0;
      // Anti-régression v2.31 : PONS peut parfois PASSER dans cette poche alors que
      // notre système a précisément réservé le changement de couleur au palier de 2
      // aux longues naturelles limitées. Dans ce cas, ne pas laisser la main mourir :
      // choisir la meilleure longue documentée plutôt que XX ou PASS.
      if(raw==='PASS' && naturalLow){
        const x=naturalLowCandidates[0];
        return out(x.call,sem('sef2024-1M-X-new-suit-level2','sef2024-1M-X',true,'nonforcing',{suits:{[x.s]:{min:5,max:13}},hcp:{min:0,max:11}}),`SEF 2024 : ${x.call} naturel long, non forcing après le Contre ; PASS brut corrigé avec ${L[x.s]} cartes ${x.s}`);
      }
      if(((fit===3&&hld>=11)||(fit<=2&&H>=10)) && !naturalLow && legal('XX'))
        return out('XX',sem('sef2024-1M-X-redouble-strong','sef2024-1M-X',false,'unknown',{suits:{[m]:{min:0,max:fit===3?3:2}},hcp:{min:fit===3?0:10,max:37},points:{min:fit===3?11:0,max:37}}),fit===3?`SEF 2024 : XX puis fit, exactement 3 atouts et ${hld} HLD`:`SEF 2024 : XX fort à orientation punitive (${H} H), sans fit`);

      // 1SA naturel 8-10 HL, sans fit, main régulière/semi-régulière.
      if(fit<=2 && HL>=8 && HL<=10 && balanced(L) && legal('1NT'))
        return out('1NT',sem('sef2024-1M-X-1NT-natural','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:0,max:2}},points:{min:8,max:10}}),`SEF 2024 : 1SA naturel 8-10 HL sans fit`);

      // Changement de couleur au palier de 2 : naturel, long, non forcing, limité.
      const rawBid=parseBid(raw);
      if(rawBid?.level===2 && rawBid.strain!=='NT' && rawBid.strain!==m && L[rawBid.strain]>=5 && H<=11)
        return out(raw,sem('sef2024-1M-X-new-suit-level2','sef2024-1M-X',true,'nonforcing',{suits:{[rawBid.strain]:{min:5,max:13}},hcp:{min:0,max:11}}),`SEF 2024 : ${raw} naturel long, non forcing après le Contre`);
    }

    // B8.1bis — redemandes minimales de l'ouvreur sur les soutiens conventionnels.
    // Ces enchères ne sont jamais des contrats à jouer dans la couleur artificielle :
    // un Passe natif PONS doit donc être remplacé explicitement, sans laisser le garde
    // sémantique deviner la destination.
    if(mxHistory.length===4 && mxHistory[0].seat===seat && mxHistory[1].call==='X' &&
       mxHistory[2].seat===partner && mxHistory[3].call==='PASS' && !passedBeforeMx(partner)){
      const m=mxHistory[0].call.slice(1), resp=mxHistory[2].call;
      const pm=latestPartnerExplicitMeaning(ctx,x=>[
        'jess-1M-X-mixed-raise','sef2024-1M-X-truscott','sef2024-1M-X-super-truscott',
        'sef2024-1M-X-fit-jump','sef2024-1M-X-splinter'
      ].includes(x.source));
      if(pm && raw==='PASS'){
        const src=pm.source;
        // Les splinters et le Super-Truscott ont déjà imposé la manche.
        if(src==='sef2024-1M-X-splinter'||src==='sef2024-1M-X-super-truscott'){
          const target=`4${m}`;
          if(legal(target)) return out(target,sem('sef2024-1M-X-opener-signoff-game-after-strong-fit','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:5,max:13}}}),`SEF 2024 : ${resp} montre un fit fort ; PASS interdit, conclusion minimale à ${target}`);
        }
        // Truscott : proposition. L'ouvreur minimum revient à 3M ; avec une vraie
        // réserve il accepte la manche. Le seuil est volontairement simple et HLD/HL.
        if(src==='sef2024-1M-X-truscott'){
          const target=(HL>=15||supportHld(ctx.deal,seat,m)>=16)?`4${m}`:`3${m}`;
          if(legal(target)) return out(target,sem('sef2024-1M-X-opener-after-truscott','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:5,max:13}}}),`SEF 2024 : réponse au Truscott, ${HL} HL => ${target}`);
        }
        // Mixed Raise : soutien compétitif 8-10 HLD. Minimum = 3M, réserve = 4M.
        if(src==='jess-1M-X-mixed-raise'){
          const target=(HL>=16||supportHld(ctx.deal,seat,m)>=17)?`4${m}`:`3${m}`;
          if(legal(target)) return out(target,sem('jess-1M-X-opener-after-mixed-raise','jess-mixed-raise',true,'nonforcing',{suits:{[m]:{min:5,max:13}}}),`Mixed Raise : retour dans l'atout convenu, ${HL} HL => ${target}`);
        }
        // Enchère de rencontre : au minimum, l'ouvreur peut refuser la manche en
        // revenant à 3M ; avec réserve, il accepte 4M. Si 3M n'est plus légal, on
        // prend le premier palier légal dans l'atout.
        if(src==='sef2024-1M-X-fit-jump'){
          let target=(HL>=15||supportHld(ctx.deal,seat,m)>=16)?`4${m}`:`3${m}`;
          if(!legal(target)) target=firstLegalMajorLevel(m);
          if(target) return out(target,sem('sef2024-1M-X-opener-after-fit-jump','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:5,max:13}}}),`SEF 2024 : enchère de rencontre ${resp}, PASS interdit ; retour ${target}`);
        }
      }
    }

    // B8.2 — l'ouvreur après XX et un dégagement du n°4 : son Passe est forcing.
    // On conserve les actions naturelles/punitives PONS lorsqu'elles existent, mais on
    // publie leur vrai statut pour que le répondant ne puisse pas lâcher la séquence.
    if(mxHistory.length===4 && mxHistory[0].seat===seat && mxHistory[1].call==='X' &&
       mxHistory[2].seat===partner && mxHistory[2].call==='XX' && !sameSide(mxHistory[3].seat,seat) &&
       mxHistory[3].call!=='PASS'){
      const m=mxHistory[0].call.slice(1), esc=parseBid(mxHistory[3].call);
      const pm=latestPartnerExplicitMeaning(ctx,x=>x.source==='sef2024-1M-X-redouble-strong'||x.convention==='sef2024-1M-X');
      if(pm){
        if(raw==='PASS') return out('PASS',sem('sef2024-1M-X-opener-forcing-pass-after-redouble','sef2024-1M-X',true,'one_round_if_uncontested',{suits:{[m]:{min:5,max:13}}}),`SEF 2024 : après XX et dégagement adverse, Passe de l'ouvreur est forcing`);
        if(raw==='X' && esc?.strain && L[esc.strain]>=3) return out('X',sem('sef2024-1M-X-opener-penalty-double','sef2024-1M-X',false,'nonforcing',{suits:{[esc.strain]:{min:3,max:13}}}),`SEF 2024 : après XX, tout Contre ultérieur est punitif`);
        const rb=parseBid(raw);
        if(rb) return out(raw,sem('sef2024-1M-X-opener-natural-after-redouble','sef2024-1M-X',rb.strain!=='NT','nonforcing',{suits:rb.strain!=='NT'?{[rb.strain]:{min:rb.strain===m?5:4,max:13}}:undefined}),`SEF 2024 : action naturelle de l'ouvreur après le processus de Surcontre`);
      }
    }

    // B8.3 — répondant après XX, dégagement adverse, Passe forcing de l'ouvreur,
    // puis Passe du contreur. On se sert volontairement de l'historique lui-même pour
    // retrouver le XX : cela reste robuste même si un adaptateur ne fournit qu'une partie
    // du ledger sémantique.
    if(mxHistory.length===6 && mxHistory[0].seat===partner && mxHistory[1].call==='X' &&
       mxHistory[2].seat===seat && mxHistory[2].call==='XX' && !sameSide(mxHistory[3].seat,seat) &&
       mxHistory[3].call!=='PASS' && mxHistory[4].seat===partner && mxHistory[4].call==='PASS' &&
       mxHistory[5].call==='PASS'){
      const m=mxHistory[0].call.slice(1), esc=parseBid(mxHistory[3].call), hld=supportHld(ctx.deal,seat,m);
      // XX puis fit : exactement trois atouts et valeurs de manche/proposition. On revient
      // dans la majeure au premier palier légal, y compris 5M après un barrage à 4 de l'adversaire.
      if(L[m]===3 && hld>=11){
        const target=firstLegalMajorLevel(m);
        if(target) return out(target,sem('sef2024-1M-X-redouble-then-fit','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:3,max:3}},points:{min:11,max:37}}),`SEF 2024 : XX puis fit exactement 3e ; retour à ${target} au premier palier légal`);
      }
      // Sans fit, le processus punitif est prioritaire avec une vraie opposition.
      if(esc?.strain){
        const cards=String(ctx.deal?.hands?.[seat]?.[esc.strain]||'');
        const linked=(L[esc.strain]>=4 && /[AKQJ]/.test(cards)) || (L[esc.strain]>=3 && suitHcp(ctx.deal,seat,esc.strain)>=4);
        if(linked && legal('X')) return out('X',sem('sef2024-1M-X-responder-penalty-double','sef2024-1M-X',false,'nonforcing',{suits:{[esc.strain]:{min:3,max:13}}}),`SEF 2024 : processus punitif du XX, opposition ${cards} => Contre`);
      }
      // Si la pénalité n'est pas claire, préserver une action PONS non-PASS légale en
      // la republiant avec notre sens plutôt que de laisser un PASS casser le processus.
      if(raw!=='PASS'){
        if(raw==='X') return out('X',sem('sef2024-1M-X-responder-penalty-double','sef2024-1M-X',false,'nonforcing'),`SEF 2024 : Contre ultérieur après XX = punitif`);
        const rb=parseBid(raw);
        if(rb) return out(raw,sem('sef2024-1M-X-responder-natural-after-forcing-pass','sef2024-1M-X',rb.strain!=='NT','nonforcing',{suits:rb.strain!=='NT'?{[rb.strain]:{min:4,max:13}}:undefined}),`SEF 2024 : action naturelle après le Passe forcing de l'ouvreur`);
      }
      // Dernier repli sûr : avec une majeure d'ouverture au moins doubleton chez le
      // répondant, revenir au premier palier légal évite de laisser jouer un Passe interdit.
      if(L[m]>=2){
        const target=firstLegalMajorLevel(m);
        if(target) return out(target,sem('sef2024-1M-X-responder-forcing-pass-fallback-major','sef2024-1M-X',true,'nonforcing',{suits:{[m]:{min:2,max:13}}}),`SEF 2024 : Passe interdit après XX ; repli sûr à ${target}`);
      }
    }

    // -------------------------------------------------------------------------
    // C. DRURY FITTÉ — SEF 2024, après Passe puis ouverture majeure en 3e/4e.
    // On travaille sur la sous-séquence qui commence à la première vraie enchère :
    // cela évite de confondre un 2C ultérieur avec un Drury dans une enchère compétitive.
    // -------------------------------------------------------------------------
    const majorHistory=(firstBidIndex>=0&&['1H','1S'].includes(history[firstBidIndex]?.call))?history.slice(firstBidIndex):[];
    const passedBeforeMajor=(who)=>firstBidIndex>0&&history.slice(0,firstBidIndex).some(x=>x.seat===who&&x.call==='PASS');

    // Réponse du joueur déjà passé : 2C Drury fitté ; 2SA avec 4+ atouts + courte.
    if(majorHistory.length===2 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && passedBeforeMajor(seat)){
      const m=majorHistory[0].call.slice(1), hld=supportHld(ctx.deal,seat,m), fit=L[m];
      if(fit>=4&&hld>=11&&shortOutside(m)) return out('2NT',sem('sef2024-drury-four-fit-shortness','drury-sef2024',false,'one_round_if_uncontested',{suits:{[m]:{min:4,max:13}}}),`SEF 2024 : après Passe, fit 4e + courte et ${hld} HLD => 2SA`);
      if((fit===3&&hld>=11)||(fit>=4&&hld>=11&&!shortOutside(m))) return out('2C',sem('sef2024-drury-fitted','drury-sef2024',false,'one_round_if_uncontested',{suits:{[m]:{min:3,max:13}}}),`SEF 2024 : Drury 2C toujours fitté, ${fit} atouts et ${hld} HLD`);
      if(fit>=4&&hld<=10&&legal(`3${m}`)) return out(`3${m}`,sem('sef2024-drury-weak-jump-fit','drury-sef2024',true,'nonforcing',{suits:{[m]:{min:4,max:13}}}),`SEF 2024 : après Passe, soutien à saut barrage avec ${fit} atouts et ${hld} HLD`);
    }
    // Réponse de l'ouvreur : uniquement la vraie séquence 1M-P-2C-P.
    // Priorités SEF 2024 : 2M = ouverture faible ; 2SA = 15-17 H régulier ;
    // 2H sur 1S = bicolore économique 15-19 HL ; 2S sur 1H = bicolore cher 18+ HL ;
    // 3M = ambition de chelem ; sinon 2D relais ambigu mais garantissant l'ouverture.
    if(majorHistory.length===4 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='2C' && majorHistory[3].call==='PASS' && passedBeforeMajor(partner)){
      const m=majorHistory[0].call.slice(1), hld=supportHld(ctx.deal,seat,m);
      if(HL<=12) return out(`2${m}`,sem('sef2024-drury-opener-weak','drury-sef2024',true,'nonforcing',{suits:{[m]:{min:4,max:13}}}),`SEF 2024 : réponse au Drury, ouverture faible (${HL} HL) => 2${m} arrêt`);
      if(H>=15&&H<=17&&strictBalanced(L)) return out('2NT',sem('sef2024-drury-opener-2NT-balanced','drury-sef2024',true,'one_round_if_uncontested',{hcp:{min:15,max:17}}),'SEF 2024 : sur Drury, 2SA décrit 15-17 H réguliers');
      if(L[m]>=6&&hld>=18) return out(`3${m}`,sem('sef2024-drury-opener-slam-try','drury-sef2024',true,'game_if_uncontested',{suits:{[m]:{min:6,max:13}}}),`SEF 2024 : réponse 3${m} au Drury = ambition de chelem`);
      const other=m==='H'?'S':'H';
      if(m==='S'&&L.H>=4&&HL>=15&&HL<=19) return out('2H',sem('sef2024-drury-opener-economic-bicolor','drury-sef2024',true,'one_round_if_uncontested',{suits:{H:{min:4,max:13},S:{min:5,max:13}}}),'SEF 2024 : 2H sur Drury après 1S = bicolore économique 15-19 HL');
      if(m==='H'&&L.S>=4&&HL>=18) return out('2S',sem('sef2024-drury-opener-reverse-spades','drury-sef2024',true,'game_if_uncontested',{suits:{S:{min:4,max:13},H:{min:5,max:13}}}),'SEF 2024 : 2S sur Drury après 1H = bicolore cher 18+ HL');
      return out('2D',sem('sef2024-drury-opener-game-try','drury-sef2024',false,'one_round_if_uncontested'),'SEF 2024 : 2D ambigu sur Drury, ouverture réelle avec espoir de manche');
    }
    // Drury direct 2SA : quatre atouts + courte. 3C demande la couleur de la courte.
    if(majorHistory.length===4 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='2NT' && majorHistory[3].call==='PASS' && passedBeforeMajor(partner)){
      return out('3C',sem('sef2024-drury-shortness-relay','drury-sef2024',false,'one_round_if_uncontested'),'SEF 2024 : après 2SA fitté avec courte, 3C demande la couleur du singleton/chicane');
    }
    if(majorHistory.length===6 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && majorHistory[2].seat===seat && majorHistory[2].call==='2NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===partner && majorHistory[4].call==='3C' && majorHistory[5].call==='PASS' && passedBeforeMajor(seat)){
      const m=majorHistory[0].call.slice(1);
      let target=null, short=null;
      if(m==='S'){
        if(L.D<=1){target='3D';short='D';}
        else if(L.H<=1){target='3H';short='H';}
        else if(L.C<=1){target='3S';short='C';}
      }else{
        if(L.D<=1){target='3D';short='D';}
        else if(L.C<=1){target='3H';short='C';}
        else if(L.S<=1){target='3S';short='S';}
      }
      if(target) return out(target,sem('sef2024-drury-shortness-answer','drury-sef2024',true,'nonforcing',{suits:{[m]:{min:4,max:13},[short]:{min:0,max:1}}}),`SEF 2024 : réponse au relais de courte, courte ${short} => ${target}`);
    }


    // Anti-régression v2.33 — Drury 2SA (fit 4e + courte), relais 3C, réponse de courte.
    // Une ouverture de 17+ H face à 11+ HLD et quatre atouts conserve une vraie voie de
    // chelem. Le Drury lui-même reste inchangé ; seule la conclusion trop basse est corrigée.
    if(majorHistory.length===8 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='2NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===seat && majorHistory[4].call==='3C' && majorHistory[5].call==='PASS' && majorHistory[6].seat===partner && /^3[HSD]$/.test(majorHistory[6].call) && majorHistory[7].call==='PASS'){
      const m=majorHistory[0].call.slice(1);
      if(H>=17 && legal('4NT')) return out('4NT',sem('v233-drury-shortness-rkcb','drury-sef2024',false,'one_round_if_uncontested',{suits:{[m]:{min:5,max:13}},hcp:{min:17,max:37}}),`anti-régression v2.3 : Drury 2SA + courte, ouvreur ${H} H => 4SA`);
    }

    // Répondant après 2D : 2M avec trois atouts, 3M avec quatre ; l'autre majeure
    // peut être nommée avec quatre cartes et une vraie force de manche.
    if(majorHistory.length===6 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && majorHistory[2].seat===seat && majorHistory[2].call==='2C' && majorHistory[3].call==='PASS' && majorHistory[4].seat===partner && majorHistory[4].call==='2D' && majorHistory[5].call==='PASS' && passedBeforeMajor(seat)){
      const m=majorHistory[0].call.slice(1), other=m==='H'?'S':'H', hld=supportHld(ctx.deal,seat,m);
      if(L[other]>=4&&hld>=13&&legal(`2${other}`)) return out(`2${other}`,sem('sef2024-drury-responder-other-major','drury-sef2024',true,'one_round_if_uncontested',{suits:{[other]:{min:4,max:13},[m]:{min:3,max:13}}}),`Drury : fit ${m} + quatre ${other}, recherche du fit 4-4`);
      return out(L[m]>=4?`3${m}`:`2${m}`,sem('sef2024-drury-responder-limit','drury-sef2024',true,'nonforcing',{suits:{[m]:{min:L[m]>=4?4:3,max:13}}}),`Drury : après 2D, ${L[m]} atouts => ${L[m]>=4?'3':'2'}${m}`);
    }
    // Décision de l'ouvreur après le retour propositionnel du répondant.
    if(majorHistory.length===8 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='2C' && majorHistory[3].call==='PASS' && majorHistory[4].seat===seat && majorHistory[4].call==='2D' && majorHistory[5].call==='PASS' && majorHistory[6].seat===partner && /^([23])[HS]$/.test(majorHistory[6].call) && majorHistory[7].call==='PASS' && passedBeforeMajor(partner)){
      const m=majorHistory[6].call.slice(1);
      // Anti-régression v2.3 : le Drury lui-même reste inchangé, mais une ouverture
      // exceptionnellement forte ne doit pas être écrasée par une conclusion automatique à 4M.
      // Avec 20+ HL et le fit confirmé par le Drury, 4SA conserve l'exploration de chelem.
      if(HL>=18 && legal('4NT')) return out('4NT',sem('sef2024-drury-opener-very-strong-rkcb','drury-sef2024',false,'one_round_if_uncontested',{suits:{[m]:{min:5,max:13}},points:{min:18,max:37}}),`Drury : ouverture très forte (${HL} HL) et fit confirmé => 4SA Blackwood, ne pas écraser l'ambition de chelem`);
      if(raw==='4H'||raw==='4S'){const rm=raw.slice(1);return out(raw,sem('sef2024-drury-opener-native-game-preserved','drury-sef2024',true,'nonforcing',{suits:{[rm]:{min:5,max:13}}}),`Drury existant : la manche native ${raw} n'est jamais dégradée en PASS par le chantier 1SA forcing`);}
      const target=HL>=14?`4${m}`:'PASS';
      return out(target,sem('sef2024-drury-opener-final-decision','drury-sef2024',true),HL>=14?`Drury : ouverture positive ${HL} HL, acceptation à 4${m}`:`Drury : ouverture ${HL} HL, refus de la proposition`);
    }
    // 2M faible de l'ouvreur sur Drury = arrêt.
    if(majorHistory.length===6 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && majorHistory[2].seat===seat && majorHistory[2].call==='2C' && majorHistory[3].call==='PASS' && majorHistory[4].seat===partner && majorHistory[4].call===`2${majorHistory[0].call.slice(1)}` && majorHistory[5].call==='PASS' && passedBeforeMajor(seat)){
      return out('PASS',sem('sef2024-drury-responder-respects-weak','drury-sef2024',true),'SEF 2024 : 2M sur Drury dénie l’ouverture et demande l’arrêt');
    }

    // -------------------------------------------------------------------------
    // D. 1M - 1SA FORCING — accord utilisateur / architecture native PONS.
    // IMPORTANT : ce bloc ne s'applique qu'à un répondant NON passé. Les mains passées
    // restent dans le chantier Drury, volontairement traité séparément et en dernier.
    // Accord : 1SA forcing ; 2M direct = 6+ ; 2C peut être le catch-all artificiel
    // avec seulement cinq cartes dans la majeure ; 2SA = artificiel, FM, 18+ toute forme.
    // -------------------------------------------------------------------------
    const latestPartnerExplicit=(predicate=null)=>{
      const entries=Array.isArray(ctx.semanticContext?.entries)?ctx.semanticContext.entries:[];
      for(let i=entries.length-1;i>=0;i--){
        const e=entries[i], x=e?.explicitMeaning;
        if(e?.seat!==partner || !x) continue;
        if(!predicate || predicate(x,e)) return x;
      }
      return null;
    };

    // Réponse initiale du répondant non passé.
    if(majorHistory.length===2 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && !passedBeforeMajor(seat)){
      const m=majorHistory[0].call.slice(1), hld=supportHld(ctx.deal,seat,m);
      // Sur 1Cœur, quatre Piques restent prioritaires au palier de 1.
      if(m==='H' && L.S>=4 && H>=6 && (L.H<=2 || raw==='1NT') && legal('1S'))
        return out('1S',sem('user-forcing-1NT-one-spade-priority','user-1M-1NT-forcing',true,'one_round_if_uncontested',{suits:{S:{min:4,max:13}},hcp:{min:6,max:37}}),'1SA forcing : quatre Piques sur 1Cœur se nomment d’abord à 1Pique');

      // Le 2-sur-1 fort reste forcing de manche : on conserve le carton PONS mais on
      // publie explicitement notre sens pour empêcher une réinterprétation au tour suivant.
      const twoOne=parseBid(raw);
      if(twoOne?.level===2 && twoOne.strain!=='NT' && twoOne.strain!==m && H>=11 && L[twoOne.strain]>=4 && legal(raw))
        return out(raw,sem('user-forcing-1NT-two-over-one-GF','user-1M-1NT-forcing',true,'game_if_uncontested',{suits:{[twoOne.strain]:{min:5,max:13}},hcp:{min:11,max:37}}),`1SA forcing : ${raw} est un 2-sur-1 naturel forcing de manche`);

      // Dans la zone 6-12 sans soutien direct, 1SA est le fourre-tout forcing : il
      // remplace aussi un mauvais carton brut PONS éventuel. Avec trois atouts, on laisse
      // le noyau choisir ses outils de fit, sauf lorsqu'il a lui-même retenu 1SA.
      if(H>=6 && H<=12 && (L[m]<=2 || raw==='1NT'))
        return out('1NT',sem('user-forcing-1NT-response','user-1M-1NT-forcing',false,'one_round_if_uncontested',{hcp:{min:6,max:12}}),'Accord utilisateur : 1SA sur 1M est forcing un tour (répondant non passé)');
      // Ne pas détourner les soutiens directs naturels choisis par PONS ; ils seront
      // audités séparément, mais ne relèvent pas du 1SA forcing proprement dit.
    }

    // Main déjà passée : on ne réécrit PAS Drury dans ce chantier. Sans fit Drury, on
    // conserve simplement l'ancien 1SA poubelle non forcing afin que le passage initial
    // ne déclenche pas artificiellement la convention forcing-NT.
    if(majorHistory.length===2 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && passedBeforeMajor(seat)){
      const m=majorHistory[0].call.slice(1);
      if(H>=6 && H<=11 && L[m]<=2 && !(m==='H'&&L.S>=4))
        return out('1NT',sem('passed-hand-1M-1NT-nonforcing','passed-hand-major-response',true,'nonforcing',{hcp:{min:6,max:11}}),'Main passée : 1SA reste non forcing ; le chantier Drury est volontairement inchangé');
    }

    // Redemande de l'ouvreur après 1M-P-1SA*-P (répondant non passé).
    if(majorHistory.length===4 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && !passedBeforeMajor(partner)){
      const m=majorHistory[0].call.slice(1);
      // 18+ : 2SA artificiel, forcing de manche, sans condition de distribution.
      if((H>=18 || raw==='2NT') && legal('2NT')) return out('2NT',sem('user-forcing-1NT-opener-2NT-18plus','user-1M-1NT-forcing',false,'game_if_uncontested',{suits:{[m]:{min:5,max:13}},points:{min:18,max:37}}),`Accord utilisateur / PONS : la règle native 18+ points a choisi 2SA ; on publie explicitement son caractère artificiel forcing de manche`);

      // Pour les redemandes inférieures à 18 HL, PONS possède déjà une zonation
      // authored (répétition simple/à saut, seconde couleur simple/à saut, reverse).
      // On PRESERVE donc son carton lorsqu'il respecte les longueurs de notre accord,
      // au lieu d'aplatir artificiellement toute la famille au palier de 2.
      const rb=parseBid(raw);

      // Filet de robustesse : si le carton brut contredit une propriété dure de la
      // convention, corriger la propriété — sans réordonner les bons cartons PONS.
      // Une majeure sixième ne peut jamais être décrite comme le catch-all 2C.
      if(raw==='2C' && L[m]>=6 && legal(`2${m}`))
        return out(`2${m}`,sem('user-forcing-1NT-opener-six-major-repeat','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:6,max:13}},points:{min:0,max:17}}),`1SA forcing : 2C catch-all incompatible avec ${L[m]} cartes dans la majeure ; correction à 2${m}`);

      // Avec exactement cinq cartes dans M et une vraie seconde couleur économique,
      // un 2C brut court ne doit pas masquer cette couleur. On ne touche pas à 2C si
      // l'ouvreur possède réellement 4+ Trèfles : le même carton reste alors publiquement
      // ambigu (naturel OU catch-all).
      if(raw==='2C' && L[m]===5 && L.C<4){
        const econ=[];
        if(m==='S' && L.H>=4 && legal('2H')) econ.push({call:'2H',s:'H',n:L.H});
        if(L.D>=4 && legal('2D')) econ.push({call:'2D',s:'D',n:L.D});
        econ.sort((a,b)=>b.n-a.n||RANK[a.s]-RANK[b.s]);
        if(econ.length){const e=econ[0];return out(e.call,sem('user-forcing-1NT-opener-natural-second-suit','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:5,max:13},[e.s]:{min:4,max:13}},points:{min:0,max:17}}),`1SA forcing : ${e.n} cartes ${e.s} réelles ; 2C court corrigé en ${e.call}`);}
      }

      // Une répétition 2M avec seulement cinq cartes est une collision dure : retour au
      // 2C ambigu/catch-all, qui est précisément prévu pour cette forme.
      if(raw===`2${m}` && L[m]===5 && legal('2C'))
        return out('2C',sem('user-forcing-1NT-opener-2C-catchall','user-1M-1NT-forcing',false,'nonforcing',{suits:{[m]:{min:5,max:5}},points:{min:0,max:17}}),`1SA forcing : ${raw} promettrait six cartes ; avec cinq seulement => 2C catch-all`);

      // 2C est le seul carton intrinsèquement ambigu du forcing-NT : PONS peut l'avoir
      // sélectionné via sa règle naturelle 4+T ou via le catch-all court. Le partenaire
      // ne peut pas distinguer ces deux chemins ; le sens public doit donc rester
      // "Trèfles non garantis" avec exactement cinq cartes dans la majeure d'ouverture.
      if(raw==='2C' && L[m]===5 && legal('2C'))
        return out('2C',sem('user-forcing-1NT-opener-2C-catchall','user-1M-1NT-forcing',false,'nonforcing',{suits:{[m]:{min:5,max:5}},points:{min:0,max:17}}),'1SA forcing : 2C est le carton ambigu/catch-all ; les Trèfles ne sont jamais garantis au partenaire');

      // Répétition simple : six cartes réellement promises.
      if(raw===`2${m}` && L[m]>=6 && legal(raw))
        return out(raw,sem('user-forcing-1NT-opener-six-major-repeat','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:6,max:13}},points:{min:0,max:17}}),`1SA forcing : ${raw} naturel garantit 6+ cartes`);

      // Reverse 2Pique après 1Cœur : 5+ Cœurs, 4+ Piques, zone native 15-17 HL.
      if(m==='H' && raw==='2S' && L.S>=4 && legal('2S'))
        return out('2S',sem('user-forcing-1NT-opener-natural-reverse-spades','user-1M-1NT-forcing',true,'one_round_if_uncontested',{suits:{H:{min:5,max:13},S:{min:4,max:13}},points:{min:15,max:17}}),'1SA forcing : reverse naturel 2Pique, 5+ Cœurs / 4+ Piques / 15-17 HL');

      // Seconde couleur économique autre que 2C : vraie longueur quatrième.
      if(rb?.level===2 && rb.strain!=='NT' && rb.strain!==m && raw!=='2C' && L[rb.strain]>=4 && legal(raw))
        return out(raw,sem('user-forcing-1NT-opener-natural-second-suit','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:5,max:13},[rb.strain]:{min:4,max:13}},points:{min:0,max:17}}),`1SA forcing : ${raw} conserve la seconde couleur naturelle PONS (${L[rb.strain]} cartes)`);

      // Répétition à saut : 6+ cartes et zone native 16-17 HL (18+ passe par 2SA*).
      if(raw===`3${m}` && L[m]>=6 && legal(raw))
        return out(raw,sem('user-forcing-1NT-opener-strong-major-jump-repeat','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:6,max:13}},points:{min:16,max:17}}),`1SA forcing : ${raw} conserve la répétition à saut PONS, 6+ ${m} et 16-17 HL`);

      // Seconde couleur à saut : vraie 5-5, zone native 15-17 HL. Elle reste
      // propositionnelle/non forcing : le répondant faible peut préférer ou passer.
      if(rb?.level===3 && rb.strain!=='NT' && rb.strain!==m && L[rb.strain]>=5 && legal(raw))
        return out(raw,sem('user-forcing-1NT-opener-jump-second-suit','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:5,max:13},[rb.strain]:{min:5,max:13}},points:{min:15,max:17}}),`1SA forcing : ${raw} conserve le bicolore à saut PONS, 5-5 et 15-17 HL`);

      // Si PONS fournit exceptionnellement un autre carton naturel légal, on ne le
      // réécrit pas sans preuve ; seules les violations certaines des invariants tombent
      // ensuite dans le filet de sécurité PASS/2C/2M.
      // Un PASS brut n'est jamais permis immédiatement après le 1SA forcing.
      if(raw==='PASS'){
        if(L[m]>=6 && legal(`2${m}`)) return out(`2${m}`,sem('user-forcing-1NT-opener-six-major-repeat','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:6,max:13}},points:{min:0,max:17}}),`1SA forcing : PASS interdit ; ${L[m]} cartes dans la majeure => 2${m}`);
        // Anti-régression v2.3 : avant de tomber sur le 2C artificiel, décrire une
        // vraie deuxième couleur quatrième économique. C'est essentiel avec les 5-4 :
        // 1S-1SA puis 2H/2D (ou 1H-1SA puis 2D) reste naturel et prioritaire.
        if(L[m]===5){
          const econ=[];
          if(m==='S' && L.H>=4 && legal('2H')) econ.push({call:'2H',s:'H',n:L.H});
          if(L.D>=4 && legal('2D')) econ.push({call:'2D',s:'D',n:L.D});
          econ.sort((a,b)=>b.n-a.n||RANK[a.s]-RANK[b.s]);
          if(econ.length){const e=econ[0];return out(e.call,sem('user-forcing-1NT-opener-natural-second-suit','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:5,max:13},[e.s]:{min:4,max:13}},points:{min:0,max:17}}),`1SA forcing : PASS interdit ; vraie seconde couleur ${e.s} ${e.n}e => ${e.call}`);}
        }
        if(legal('2C')) return out('2C',sem('user-forcing-1NT-opener-2C-catchall','user-1M-1NT-forcing',false,'nonforcing',{suits:{[m]:{min:5,max:5}},points:{min:0,max:17}}),'1SA forcing : PASS interdit ; aucune seconde couleur économique => repli sur 2C catch-all artificiel');
      }
    }

    // Répondant au tour suivant de la séquence forte 2SA-3C-description. On ferme ici
    // explicitement la manche afin qu'aucune lecture native différente du relais ne puisse
    // faire mourir la convention à 3D/3M.
    if(majorHistory.length===10 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && majorHistory[2].seat===seat && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===partner && majorHistory[4].call==='2NT' && majorHistory[5].call==='PASS' && majorHistory[6].seat===seat && majorHistory[6].call==='3C' && majorHistory[7].call==='PASS' && majorHistory[8].seat===partner && majorHistory[9].call==='PASS' && !passedBeforeMajor(seat)){
      const described=latestPartnerExplicit(x=>x.source==='user-forcing-1NT-opener-after-2NT-relay'||x.source==='user-forcing-1NT-opener-3D-default-after-relay');
      if(described){
        const m=majorHistory[0].call.slice(1), dcall=majorHistory[8].call, db=parseBid(dcall);
        if(raw==='PASS'){
          if(db?.strain===m && L[m]>=2 && legal(`4${m}`)) return out(`4${m}`,sem('user-forcing-1NT-responder-closes-game-after-relay','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:2,max:13}}}),`1SA forcing : la description ${dcall} confirme la majeure ; fermeture à 4${m}`);
          if(db && (db.strain==='H'||db.strain==='S') && db.strain!==m && L[db.strain]>=4 && legal(`4${db.strain}`)) return out(`4${db.strain}`,sem('user-forcing-1NT-responder-closes-side-major-game-after-relay','user-1M-1NT-forcing',true,'nonforcing',{suits:{[db.strain]:{min:4,max:13}}}),`1SA forcing : fit 4-4 dans la majeure secondaire ${db.strain} => manche`);
          if(legal('3NT')) return out('3NT',sem('user-forcing-1NT-responder-closes-3NT-after-relay','user-1M-1NT-forcing',true,'nonforcing'),'1SA forcing : 2SA 18+ avait imposé la manche ; sans fit majeur révélé => 3SA');
        }
        if(raw==='3NT') return out('3NT',sem('user-forcing-1NT-responder-closes-3NT-after-relay','user-1M-1NT-forcing',true,'nonforcing'),'1SA forcing : conclusion 3SA après le relais de 2SA 18+');
        if(/^4[HS]$/.test(raw)) return out(raw,sem('user-forcing-1NT-responder-closes-major-game-after-relay','user-1M-1NT-forcing',true,'nonforcing',{suits:{[raw.slice(1)]:{min:0,max:13}}}),'1SA forcing : conclusion à la manche majeure après description de 2SA 18+');
        // Les séquences de chelem (4SA RKCB, contrôles...) sont laissées à leur convention
        // propre ; elles ont déjà dépassé le seuil de manche et ne doivent pas être
        // requalifiées dans ce chantier.
      }
    }

    // Redemande après 1M-1SA d'une main déjà passée : préserver l'ancien traitement
    // non forcing, sans l'étendre ni modifier Drury.
    if(majorHistory.length===4 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && passedBeforeMajor(partner)){
      const m=majorHistory[0].call.slice(1), rb=parseBid(raw);

      // Anti-régression v2.3 : 1SA est NON forcing après Passe. Dans cette famille,
      // le noyau PONS possède déjà une zonation utile (2SA/3SA, répétition simple ou
      // à saut, seconde couleur simple ou à saut). Ne pas l'aplatir au palier de 2.
      // On conserve donc un carton naturel cohérent avant d'appliquer les filets PASS.
      if(raw==='2NT' && H>=15 && legal(raw))
        return out(raw,sem('passed-hand-opener-preserve-2NT-after-1M-1NT','passed-hand-major-response',true,'nonforcing',{hcp:{min:15,max:37}}),'Main passée en face : conservation de la redemande naturelle PONS à 2SA');
      if(raw==='3NT' && H>=18 && legal(raw))
        return out(raw,sem('passed-hand-opener-preserve-3NT-after-1M-1NT','passed-hand-major-response',true,'nonforcing',{hcp:{min:18,max:37}}),'Main passée en face : conservation de la redemande naturelle PONS à 3SA');
      if(rb && rb.strain===m && (rb.level===2||rb.level===3) && L[m]>=6 && legal(raw))
        return out(raw,sem('passed-hand-opener-preserve-major-repeat-after-1M-1NT','passed-hand-major-response',true,'nonforcing',{suits:{[m]:{min:6,max:13}}}),`Main passée en face : conservation de ${raw}, répétition naturelle zonée par PONS`);
      if(rb && rb.strain!=='NT' && rb.strain!==m && ((rb.level===2&&L[rb.strain]>=4)||(rb.level===3&&L[rb.strain]>=5)) && legal(raw))
        return out(raw,sem('passed-hand-opener-preserve-second-suit-after-1M-1NT','passed-hand-major-response',true,'nonforcing',{suits:{[m]:{min:5,max:13},[rb.strain]:{min:rb.level===3?5:4,max:13}}}),`Main passée en face : conservation de ${raw}, seconde couleur naturelle zonée par PONS`);

      // Si PONS veut réellement passer, 1SA non forcing autorise le contrat seulement
      // avec une main minimale sans redemande distributionnelle évidente.
      if(raw==='PASS'){
        if(L[m]>=6&&legal(`2${m}`)) return out(`2${m}`,sem('passed-hand-opener-repeat-major-after-1M-1NT','passed-hand-major-response',true,'nonforcing',{suits:{[m]:{min:6,max:13}}}),'Main passée en face : PASS corrigé, répétition naturelle de la majeure sixième');
        if(L[m]===5){
          const econ=[];
          if(m==='S'&&L.H>=4&&legal('2H')) econ.push({call:'2H',s:'H',n:L.H});
          if(L.D>=4&&legal('2D')) econ.push({call:'2D',s:'D',n:L.D});
          if(L.C>=4&&legal('2C')) econ.push({call:'2C',s:'C',n:L.C});
          econ.sort((a,b)=>b.n-a.n||RANK[b.s]-RANK[a.s]);
          if(econ.length){const e=econ[0];return out(e.call,sem('passed-hand-opener-natural-second-suit-after-1M-1NT','passed-hand-major-response',true,'nonforcing',{suits:{[m]:{min:5,max:5},[e.s]:{min:4,max:13}}}),`Main passée en face : PASS corrigé ; seconde couleur ${e.s} (${e.n} cartes) => ${e.call}`);}
        }
        if(H<=14) return out('PASS',sem('passed-hand-opener-pass-after-1M-1NT','passed-hand-major-response',true,'nonforcing'),'Main passée en face : 1SA non forcing, ouverture minimale sans redemande naturelle prioritaire => Passe');
      }
    }

    // Répondant après le 2C CATCH-ALL explicitement publié. L'historique seul ne permet
    // pas à PONS de savoir si 2C était naturel ou artificiel ; on utilise donc la provenance
    // sémantique de l'enchère réellement produite, sans inventer quatre Trèfles chez l'ouvreur.
    if(majorHistory.length===6 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && majorHistory[2].seat===seat && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===partner && majorHistory[4].call==='2C' && majorHistory[5].call==='PASS' && !passedBeforeMajor(seat)){
      const m=majorHistory[0].call.slice(1);
      const catchall=latestPartnerExplicit(x=>x.source==='user-forcing-1NT-opener-2C-catchall');
      if(catchall){
        // Les actions constructives authored par PONS restent utilisables ; on les republie
        // avec le vrai contexte du catch-all.
        if(raw==='2NT' && H>=11) return out('2NT',sem('user-forcing-1NT-responder-2NT-invite-after-catchall','user-1M-1NT-forcing',true,'nonforcing',{hcp:{min:11,max:12}}),'1SA forcing : 2SA propositionnel après le 2C catch-all');
        if(raw===`3${m}` && L[m]>=3 && H>=10) return out(raw,sem('user-forcing-1NT-responder-three-card-limit-raise','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:3,max:13}},hcp:{min:10,max:12}}),`1SA forcing : soutien différé ${raw} avec 3+ atouts et 10-12 H`);
        if(raw!=='PASS' && legal(raw)){
          const b=parseBid(raw);
          if(b?.level===2 && b.strain!=='NT'){
            const extra=b.strain===m?{suits:{[m]:{min:2,max:13}}}:L[b.strain]>=4?{suits:{[b.strain]:{min:4,max:13}}}:{};
            return out(raw,sem('user-forcing-1NT-responder-natural-continuation-after-catchall','user-1M-1NT-forcing',true,'nonforcing',extra),'1SA forcing : continuation naturelle après 2C catch-all, sans attribuer de Trèfles à l’ouvreur');
          }
        }
        // PASS n'est toléré que si le répondant possède lui-même une vraie longue à Trèfle :
        // il choisit alors de jouer 2C en sachant que la couleur de l'ouvreur peut être courte.
        if(raw==='PASS' && L.C>=6) return out('PASS',sem('user-forcing-1NT-responder-plays-catchall-clubs','user-1M-1NT-forcing',true,'nonforcing',{suits:{C:{min:6,max:13}}}),'1SA forcing : six Trèfles chez le répondant permettent de jouer 2C malgré le catch-all court en face');
        if(raw==='PASS'){
          // Priorité aux longues réelles, puis à la préférence de deux cartes dans M.
          const candidates=[];
          if(m==='S' && L.H>=5 && legal('2H')) candidates.push({call:'2H',s:'H',n:L.H});
          if(L.D>=5 && legal('2D')) candidates.push({call:'2D',s:'D',n:L.D});
          candidates.sort((a,b)=>b.n-a.n||RANK[a.s]-RANK[b.s]);
          if(candidates.length){const c=candidates[0];return out(c.call,sem('user-forcing-1NT-responder-long-suit-after-catchall','user-1M-1NT-forcing',true,'nonforcing',{suits:{[c.s]:{min:5,max:13}}}),`1SA forcing : 2C était artificiel ; ${L[c.s]} cartes ${c.s} => ${c.call}`);}
          if(L[m]>=2 && legal(`2${m}`)) return out(`2${m}`,sem('user-forcing-1NT-responder-major-preference-after-catchall','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:2,max:13}}}),`1SA forcing : 2C était artificiel ; préférence à 2${m} avec ${L[m]} cartes`);
          // Cas de misfit extrême : une couleur latérale quatrième vaut mieux qu'un Passe
          // dans un 2C pouvant être seulement doubleton. C'est un filet de sécurité rare.
          const four=[];
          if(m==='S' && L.H>=4 && legal('2H')) four.push({call:'2H',s:'H',n:L.H});
          if(L.D>=4 && legal('2D')) four.push({call:'2D',s:'D',n:L.D});
          four.sort((a,b)=>b.n-a.n||RANK[a.s]-RANK[b.s]);
          if(four.length){const c=four[0];return out(c.call,sem('user-forcing-1NT-responder-four-card-escape-after-catchall','user-1M-1NT-forcing',true,'nonforcing',{suits:{[c.s]:{min:4,max:13}}}),`1SA forcing : misfit extrême après 2C catch-all ; repli dans ${c.call}`);}
        }
      }
    }

    // Répondant après 2SA artificiel 18+ : les développements natifs PONS (relais 3C,
    // soutien 3M, 3SA descriptif...) sont conservés, mais le forcing de manche reste inscrit.
    if(majorHistory.length===6 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && majorHistory[2].seat===seat && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===partner && majorHistory[4].call==='2NT' && majorHistory[5].call==='PASS' && !passedBeforeMajor(seat)){
      const strong=latestPartnerExplicit(x=>x.source==='user-forcing-1NT-opener-2NT-18plus');
      if(strong && raw!=='PASS' && legal(raw)){
        let extra={hcp:{min:0,max:12}}, natural=true;
        if(raw==='3C'){natural=false;extra={};}
        else if(raw===`3${majorHistory[0].call.slice(1)}`) extra={suits:{[majorHistory[0].call.slice(1)]:{min:3,max:13}},hcp:{min:10,max:12}};
        return out(raw,sem(raw==='3C'?'user-forcing-1NT-responder-3C-relay-after-2NT':'user-forcing-1NT-responder-development-after-2NT','user-1M-1NT-forcing',natural,'game_if_uncontested',extra),raw==='3C'?'1SA forcing : 3C relais sur 2SA artificiel 18+':'1SA forcing : développement naturel/descriptif sur 2SA 18+, le camp reste forcing de manche');
      }
      if(strong && raw==='PASS' && legal('3C')) return out('3C',sem('user-forcing-1NT-responder-3C-relay-after-2NT','user-1M-1NT-forcing',false,'game_if_uncontested'),'1SA forcing : 2SA 18+ est forcing de manche ; PASS interdit, relais 3C');
    }

    // Ouvreur après une réponse naturelle/descriptive à 2SA 18+ (3D/3H/3S...).
    // Le 2SA initial a imposé la manche : une réponse naturelle du répondant ne libère
    // donc jamais l'ouvreur sous 3SA/4M. On republie ici le carton natif avec NOTRE
    // provenance afin que le tour suivant ne puisse pas être réinterprété par PONS.
    if(majorHistory.length===8 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===seat && majorHistory[4].call==='2NT' && majorHistory[5].call==='PASS' && majorHistory[6].seat===partner && majorHistory[6].call!=='3C' && majorHistory[7].call==='PASS' && !passedBeforeMajor(partner)){
      const naturalResponse=latestPartnerExplicit(x=>x.source==='user-forcing-1NT-responder-development-after-2NT');
      if(naturalResponse){
        const m=majorHistory[0].call.slice(1), rcall=majorHistory[6].call, rb=parseBid(rcall);
        // Si PONS veut passer avant la manche, choisir la conclusion la plus naturelle :
        // fit majeur 5-3 lorsqu'il est certain, sinon 3SA.
        if(raw==='PASS'){
          if(rb && (rb.strain==='H'||rb.strain==='S') && L[rb.strain]>=3 && legal(`4${rb.strain}`))
            return out(`4${rb.strain}`,sem('user-forcing-1NT-opener-closes-major-after-natural-2NT-response','user-1M-1NT-forcing',true,'nonforcing',{suits:{[rb.strain]:{min:3,max:13}},points:{min:18,max:37}}),`1SA forcing : 2SA 18+ imposait la manche ; fit 5-3 sur ${rcall} => 4${rb.strain}`);
          if(legal('3NT'))
            return out('3NT',sem('user-forcing-1NT-opener-closes-3NT-after-natural-2NT-response','user-1M-1NT-forcing',true,'nonforcing',{points:{min:18,max:37}}),'1SA forcing : 2SA 18+ imposait la manche ; PASS interdit => 3SA');
        }
        if(raw!=='PASS' && legal(raw)){
          const b=parseBid(raw), atGame=(raw==='3NT'||/^4[HS]$/.test(raw)||/^([4-7])/.test(raw));
          let extra={points:{min:18,max:37}}, natural=true;
          if(b && b.strain!=='NT'){
            const min=(b.strain===m && L[b.strain]>=6)?6:(L[b.strain]>=4?4:0);
            if(min) extra={suits:{[b.strain]:{min,max:13}},points:{min:18,max:37}};
          }
          return out(raw,sem('user-forcing-1NT-opener-after-natural-2NT-response','user-1M-1NT-forcing',natural,atGame?'nonforcing':'game_if_uncontested',extra),'1SA forcing : continuation de l’ouvreur après réponse naturelle à 2SA 18+ ; sous la manche le camp reste forcing de manche');
        }
      }
    }

    // Répondant après une réponse naturelle à 2SA 18+ puis une description de l'ouvreur.
    // C'est la branche sœur du chemin 2SA-3C-relay : si l'ouvreur reste sous la manche,
    // PASS est interdit. On choisit 4M seulement avec un fit public plausible ; sinon 3SA.
    if(majorHistory.length===10 && majorHistory[0].seat===partner && majorHistory[1].call==='PASS' && majorHistory[2].seat===seat && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===partner && majorHistory[4].call==='2NT' && majorHistory[5].call==='PASS' && majorHistory[6].seat===seat && majorHistory[6].call!=='3C' && majorHistory[7].call==='PASS' && majorHistory[8].seat===partner && majorHistory[9].call==='PASS' && !passedBeforeMajor(seat)){
      const described=latestPartnerExplicit(x=>x.source==='user-forcing-1NT-opener-after-natural-2NT-response');
      if(described){
        const m=majorHistory[0].call.slice(1), dcall=majorHistory[8].call, db=parseBid(dcall);
        if(raw==='PASS'){
          if(db?.strain===m && L[m]>=2 && legal(`4${m}`))
            return out(`4${m}`,sem('user-forcing-1NT-responder-closes-game-after-natural-2NT-response','user-1M-1NT-forcing',true,'nonforcing',{suits:{[m]:{min:2,max:13}}}),`1SA forcing : ${dcall} décrit la majeure d’ouverture ; ${L[m]} cartes en face => 4${m}`);
          if(db && (db.strain==='H'||db.strain==='S') && db.strain!==m && L[db.strain]>=4 && legal(`4${db.strain}`))
            return out(`4${db.strain}`,sem('user-forcing-1NT-responder-closes-side-major-after-natural-2NT-response','user-1M-1NT-forcing',true,'nonforcing',{suits:{[db.strain]:{min:4,max:13}}}),`1SA forcing : fit dans la majeure secondaire ${db.strain} => 4${db.strain}`);
          if(legal('3NT'))
            return out('3NT',sem('user-forcing-1NT-responder-closes-3NT-after-natural-2NT-response','user-1M-1NT-forcing',true,'nonforcing'),'1SA forcing : 2SA 18+ imposait la manche ; sans fit majeur suffisant => 3SA');
        }
        if(raw==='3NT')
          return out('3NT',sem('user-forcing-1NT-responder-closes-3NT-after-natural-2NT-response','user-1M-1NT-forcing',true,'nonforcing'),'1SA forcing : conclusion naturelle à 3SA après 2SA 18+');
        if(/^4[HS]$/.test(raw))
          return out(raw,sem('user-forcing-1NT-responder-closes-major-after-natural-2NT-response','user-1M-1NT-forcing',true,'nonforcing',{suits:{[raw.slice(1)]:{min:0,max:13}}}),'1SA forcing : conclusion à la manche majeure après 2SA 18+');
        // Une enchère descriptive encore sous la manche reste forcing de manche.
        const b=parseBid(raw);
        if(raw!=='PASS' && legal(raw) && b && (b.level<3 || (b.level===3 && b.strain!=='NT'))){
          const extra=b.strain!=='NT'&&L[b.strain]>=4?{suits:{[b.strain]:{min:4,max:13}}}:{};
          return out(raw,sem('user-forcing-1NT-responder-continues-after-natural-2NT-description','user-1M-1NT-forcing',b.strain!=='NT','game_if_uncontested',extra),'1SA forcing : continuation sous la manche après 2SA 18+ ; le forcing de manche subsiste');
        }
      }
    }

    // Ouvreur après le relais 3C sur 2SA 18+ : conserver les réponses authored par PONS
    // (3D défaut, 3M descriptif), mais avec notre forcing de manche explicitement partagé.
    if(majorHistory.length===8 && majorHistory[0].seat===seat && majorHistory[1].call==='PASS' && majorHistory[2].seat===partner && majorHistory[2].call==='1NT' && majorHistory[3].call==='PASS' && majorHistory[4].seat===seat && majorHistory[4].call==='2NT' && majorHistory[5].call==='PASS' && majorHistory[6].seat===partner && majorHistory[6].call==='3C' && majorHistory[7].call==='PASS' && !passedBeforeMajor(partner)){
      const relay=latestPartnerExplicit(x=>x.source==='user-forcing-1NT-responder-3C-relay-after-2NT');
      if(relay && raw!=='PASS' && legal(raw)){
        const b=parseBid(raw), extra=b&&b.strain!=='NT'&&L[b.strain]>=4?{suits:{[b.strain]:{min:b.strain===majorHistory[0].call.slice(1)&&L[b.strain]>=6?6:4,max:13}},points:{min:18,max:37}}:{points:{min:18,max:37}};
        return out(raw,sem('user-forcing-1NT-opener-after-2NT-relay','user-1M-1NT-forcing',raw!=='3D','game_if_uncontested',extra),'1SA forcing : réponse descriptive de l’ouvreur au relais 3C ; le camp reste forcing de manche');
      }
      if(relay && raw==='PASS' && legal('3D')) return out('3D',sem('user-forcing-1NT-opener-3D-default-after-relay','user-1M-1NT-forcing',false,'game_if_uncontested',{points:{min:18,max:37}}),'1SA forcing : réponse défaut 3D au relais 3C ; PASS interdit');
    }
    return null;
  }

  // Corrections de continuations explicitement zonées par les cours. Contrairement à
  // knownCoursePassSubstitution, cette fonction peut corriger une enchère PONS non-PASS,
  // mais uniquement dans deux séquences Spoutnik extrêmement étroites.
  function highPriorityGameTryCorrection(ctx){
    const history=normHistory(ctx.history,ctx.deal), seat=String(ctx.seat||'').toUpperCase();
    const raw=String(ctx.call||'').toUpperCase(), partner=partnerOf(seat);
    const firstBidIndex=history.findIndex(x=>parseBid(x.call));
    const relHistory=firstBidIndex>=0?history.slice(firstBidIndex):history;
    const legal=(c)=>!ctx.isLegal||ctx.isLegal(history,c,seat);

    // Une fois le soutien simple donné, 3M est un barrage et 4M une conclusion.
    // Le répondant limité ne doit pas les "réévaluer" en remontant encore.
    if(relHistory.length===6){
      const [open,p1,raise,p2,close,p3]=relHistory;
      const ob=parseBid(open.call), rb=parseBid(raise.call), cb=parseBid(close.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && raise.seat===seat && rb?.level===2 && rb.strain===ob.strain &&
        p2.call==='PASS' && close.seat===partner && cb && cb.strain===ob.strain &&
        (cb.level===3||cb.level===4) && p3.call==='PASS' && openingEvent(history)===open;
      if(frame && legal('PASS')) return {
        call:'PASS',changed:raw!=='PASS',
        semantic:{natural:true,source:cb.level===3?'v249-priority-pass-after-barrage':'v249-priority-pass-after-direct-game',
          suits:{[ob.strain]:{min:3,max:13}},points:{min:6,max:10},forcing:'nonforcing',
          publishWhenNative:true,convention:'sef2024-major-game-tries'},
        reason:cb.level===3
          ? `Chailley/SEF : 3${ob.strain} est un barrage, le répondant limité passe`
          : `Chailley/SEF : 4${ob.strain} direct est une enchère d'arrêt, le répondant limité passe`
      };
    }

    // Après 2SA d'essai, une enchère de 4 dans une autre couleur est une courte.
    // Si l'adversaire la contre, l'ouvreur ne peut évidemment pas la laisser devenir contrat.
    if(relHistory.length===8){
      const [open,p1,raise,p2,trial,p3,shortBid,opp]=relHistory;
      const ob=parseBid(open.call), rb=parseBid(raise.call), sb=parseBid(shortBid.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && raise.seat===partner && rb?.level===2 && rb.strain===ob.strain &&
        p2.call==='PASS' && trial.seat===seat && trial.call==='2NT' && p3.call==='PASS' &&
        shortBid.seat===partner && sb?.level===4 && sb.strain!==ob.strain && sb.strain!=='NT' &&
        bidRank(shortBid.call)<bidRank(`4${ob.strain}`) && opp.call==='X' && openingEvent(history)===open;
      const game=ob?`4${ob.strain}`:null;
      if(frame&&game&&legal(game)) return {
        call:game,changed:raw!==game,
        semantic:{natural:true,source:'v249-priority-escape-artificial-shortness-double',
          suits:{[ob.strain]:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,
          convention:'sef2024-major-game-tries'},
        reason:`Chailley/SEF : ${shortBid.call} montre une courte après 2SA ; sur Contre, retour au contrat naturel ${game}`
      };
    }
    return null;
  }

  function knownCourseCallCorrection(ctx){
    const trialPriority=highPriorityGameTryCorrection(ctx);
    if(trialPriority) return trialPriority;
    const priority=prioritySystemCorrection(ctx);
    if(priority) return priority;
    const history=normHistory(ctx.history,ctx.deal), seat=String(ctx.seat||'').toUpperCase();
    const raw=String(ctx.call||'').toUpperCase();
    const H=hcp(ctx.deal,seat), L=lengths(ctx.deal,seat), partner=partnerOf(seat);
    const firstBidIndex=history.findIndex(x=>parseBid(x.call));
    const relHistory=firstBidIndex>=0?history.slice(firstBidIndex):history;
    const legal=(c)=>!ctx.isLegal||ctx.isLegal(history,c,seat);

    // v2.51 — Deuxième enchère de l'intervenant après le cue-bid de force de l'advancer.
    // Séquence Chailley documentée : 1D-(1H)-1S-2D-P-?. Le cue-bid 2D demande
    // explicitement si l'intervention était faible (8-12HL) ou d'ouverture (13-18HL).
    // En zone faible, le retour obligatoire est 2H : ne jamais transformer la demande
    // de force en saut spontané à 3H/4H.
    if(relHistory.length===5){
      const [open,over,resp,cue,p]=relHistory;
      const frame=open.call==='1D' && over.seat===seat && over.call==='1H' &&
        resp.call==='1S' && cue.seat===partner && cue.call==='2D' && p.call==='PASS' &&
        openingEvent(history)===open;
      if(frame){
        const HL=hlPoints(ctx.deal,seat);
        if(HL>=8 && HL<=12 && L.H>=5 && legal('2H')) return {
          call:'2H',changed:raw!=='2H',
          semantic:{natural:true,source:'v251-overcaller-weak-after-advancer-cue',suits:{H:{min:5,max:13}},points:{min:8,max:12},forcing:'nonforcing',publishWhenNative:true,convention:'advancer-force-cuebid-strength-ask'},
          reason:`Chailley : le cue-bid 2D demande la force de l'intervention ; ${HL} HL = zone 8-12, retour obligatoire à 2Cœur`
        };
      }
    }

    // v2.49 — Enchères d'essai après soutien simple d'une majeure.
    // Chailley / SEF : 3M n'est jamais une proposition de manche.
    // 13-16 HLD => Passe hors vrai barrage ; 17-20 HLD => essai 2SA ou naturel.
    if(relHistory.length===4){
      const [open,p1,raise,p2]=relHistory, ob=parseBid(open.call), rb=parseBid(raise.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && raise.seat===partner && rb?.level===2 && rb.strain===ob.strain &&
        p2.call==='PASS' && openingEvent(history)===open;
      if(frame){
        const tr=ob.strain, other=tr==='S'?'H':'S', hld=chailleyFitHld(ctx.deal,seat,tr,3);
        const partscore=`3${tr}`, game=`4${tr}`;
        const sideLong=SUITS.some(s=>s!==tr && (L[s]||0)>=5);
        const trueBarrage=(L[other]||0)<=1 && ((L[tr]||0)>=6 || sideLong);

        if(hld<=16){
          const target=trueBarrage&&legal(partscore)?partscore:'PASS';
          if(legal(target)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:target==='PASS'?'v249-major-fit-pass':'v249-major-fit-real-barrage',
              suits:{[tr]:{min:5,max:13}},points:{min:0,max:16},forcing:'nonforcing',
              publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:target==='PASS'
              ? `Chailley/SEF : ${hld} HLD sans vrai barrage => Passe ; ${partscore} n'est pas une proposition`
              : `Chailley/SEF : ${partscore} réservé au barrage ; profil distributionnel réel`
          };
        }

        if(hld>=17 && hld<=20){
          // La fiche Chailley autorise aussi 3SA avec une vraie 5332 forte et des arrêts :
          // si PONS l'a déjà choisie dans une main strictement régulière de 18H+, on la conserve.
          if(raw==='3NT' && H>=18 && strictBalanced(L) && legal('3NT')) return {
            call:'3NT',changed:false,
            semantic:{natural:true,source:'v249-major-fit-3NT-choice',suits:{[tr]:{min:5,max:5}},
              hcp:{min:18,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:`Chailley/SEF : main 5332 forte, 3SA reste un choix de manche documenté`
          };
          if(hld===20 && raw===game && legal(game)) return {
            call:game,changed:false,
            semantic:{natural:true,source:'v249-major-fit-direct-game-20',suits:{[tr]:{min:5,max:13}},
              points:{min:20,max:20},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:`Chailley/SEF : 20 HLD, ${game} direct reste légitime`
          };
          const tries=[];
          for(const su of SUITS){
            if(su===tr) continue;
            const c=cheapestSuitCallAfter(history,su);
            if(!c||!legal(c)||bidRank(c)>=bidRank(partscore)) continue;
            const n=L[su]||0, losers=suitLosers(ctx.deal,seat,su);
            if(n>=4 && losers>=2) tries.push({su,c,n,losers,q:suitHcp(ctx.deal,seat,su)});
          }
          tries.sort((a,b)=>b.n-a.n||b.losers-a.losers||a.q-b.q||bidRank(a.c)-bidRank(b.c));
          const target=tries[0]?.c || (legal('2NT')?'2NT':null);
          if(target) return {
            call:target,changed:raw!==target,
            semantic:{natural:target!=='2NT',source:target==='2NT'?'v249-generalized-game-try':'v249-natural-game-try',
              suits:{[tr]:{min:5,max:13}},points:{min:17,max:20},forcing:'one_round_if_uncontested',
              publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:target==='2NT'
              ? `Chailley/SEF : ${hld} HLD, essai généralisé 2SA`
              : `Chailley/SEF : ${hld} HLD, essai naturel ${target} (${tries[0].n} cartes, ${tries[0].losers} perdantes)`
          };
        }

        if(hld>=21 && hld<=22 && raw===partscore && legal(game)) return {
          call:game,changed:true,
          semantic:{natural:true,source:'v249-major-fit-game-zone',suits:{[tr]:{min:5,max:13}},
            points:{min:21,max:22},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
          reason:`Chailley/SEF : ${hld} HLD => ${game}; ${partscore} ne peut pas servir de proposition`
        };
      }
    }

    // Après 1M-2M-3M sans intervention, 3M est un barrage et non une proposition.
    // Le répondant, déjà limité à 6-10 HLD, ne le transforme pas mécaniquement en manche.
    if(relHistory.length===6){
      const [open,p1,raise,p2,barrage,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(raise.call), bb=parseBid(barrage.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && raise.seat===seat && rb?.level===2 && rb.strain===ob.strain &&
        p2.call==='PASS' && barrage.seat===partner && bb?.level===3 && bb.strain===ob.strain &&
        p3.call==='PASS' && openingEvent(history)===open;
      if(frame) return {
        call:'PASS',changed:raw!=='PASS',
        semantic:{natural:true,source:'v249-major-fit-barrage-responder-pass',suits:{[ob.strain]:{min:3,max:13}},
          points:{min:6,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
        reason:`Chailley/SEF : 3${ob.strain} après soutien simple est un barrage, pas une proposition => Passe`
      };
    }

    // Réponses à l'essai généralisé 2SA : 6-7 / 8 / 9-10 HLD.
    if(relHistory.length===6){
      const [open,p1,raise,p2,trial,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(raise.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && raise.seat===seat && rb?.level===2 && rb.strain===ob.strain &&
        p2.call==='PASS' && trial.seat===partner && trial.call==='2NT' && p3.call==='PASS' &&
        openingEvent(history)===open;
      if(frame){
        const tr=ob.strain, hld=chailleyFitHld(ctx.deal,seat,tr,5), signoff=`3${tr}`, game=`4${tr}`;
        const side=SUITS.filter(s=>s!==tr);
        const forces=side.map(s=>({s,c:cheapestSuitCallAfter(history,s)}))
          .filter(x=>x.c&&bidRank(x.c)<bidRank(signoff)&&legal(x.c)&&suitHcp(ctx.deal,seat,x.s)>=3)
          .sort((a,b)=>bidRank(a.c)-bidRank(b.c));

        if(hld<=7 && legal(signoff)) return {
          call:signoff,changed:raw!==signoff,
          semantic:{natural:true,source:'v249-2NT-try-minimum',suits:{[tr]:{min:3,max:13}},
            points:{min:0,max:7},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
          reason:`Chailley/SEF : ${hld} HLD minimum => ${signoff}`
        };

        if(hld===8){
          const target=forces[0]?.c || signoff;
          if(legal(target)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:target===signoff?'v249-2NT-try-8-negative':'v249-2NT-try-8-force',
              suits:{[tr]:{min:3,max:13}},points:{min:8,max:8},
              forcing:target===signoff?'nonforcing':'one_round_if_uncontested',
              publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:target===signoff ? `Chailley/SEF : 8 HLD sans plus-value => ${signoff}`
              : `Chailley/SEF : 8 HLD avec force utile à ${forces[0].s} => ${target}`
          };
        }

        if(hld>=9){
          const shorts=side.map(s=>({s,c:`4${s}`,n:L[s]||0}))
            .filter(x=>x.n<=1&&bidRank(x.c)<bidRank(game)&&legal(x.c))
            .sort((a,b)=>a.n-b.n||bidRank(a.c)-bidRank(b.c));
          let target=shorts[0]?.c || forces[0]?.c || null;
          if(!target&&strictBalanced(L)&&legal('3NT')) target='3NT';
          if(!target&&legal(game)) target=game;
          if(target) return {
            call:target,changed:raw!==target,
            semantic:{natural:target==='3NT'||target===game||!!forces.find(x=>x.c===target),
              source:'v249-2NT-try-positive',suits:{[tr]:{min:3,max:13}},points:{min:9,max:37},
              forcing:(target===game||target==='3NT')?'nonforcing':'one_round_if_uncontested',
              publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:`Chailley/SEF : réponse positive ${hld} HLD à 2SA => ${target}`
          };
        }
      }
    }

    // Réponses à un essai naturel dans une couleur annexe : logique des couvrantes.
    if(relHistory.length===6){
      const [open,p1,raise,p2,trial,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(raise.call), tb=parseBid(trial.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && raise.seat===seat && rb?.level===2 && rb.strain===ob.strain &&
        p2.call==='PASS' && trial.seat===partner && tb && tb.strain!=='NT' && tb.strain!==ob.strain &&
        bidRank(trial.call)<bidRank(`3${ob.strain}`) && p3.call==='PASS' && openingEvent(history)===open;
      if(frame){
        const tr=ob.strain, ts=tb.strain, hld=chailleyFitHld(ctx.deal,seat,tr,5);
        const signoff=`3${tr}`, game=`4${tr}`, comp=trialComplement(ctx.deal,seat,ts);

        if(comp==='strong' && legal(game)) return {
          call:game,changed:raw!==game,
          semantic:{natural:true,source:'v249-natural-try-strong-complement',suits:{[tr]:{min:3,max:13}},
            points:{min:6,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
          reason:`Chailley/SEF : excellent complément à ${ts} => ${game}, même minimum`
        };

        if((comp==='none'&&hld<=8)||(comp==='medium'&&hld<=7)){
          if(legal(signoff)) return {
            call:signoff,changed:raw!==signoff,
            semantic:{natural:true,source:'v249-natural-try-negative',suits:{[tr]:{min:3,max:13}},
              points:{min:0,max:8},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:`Chailley/SEF : complément ${comp} et ${hld} HLD => ${signoff}`
          };
        }

        if(hld>=9){
          const forces=SUITS.filter(s=>s!==tr&&s!==ts).map(s=>({s,c:cheapestSuitCallAfter(history,s)}))
            .filter(x=>x.c&&bidRank(x.c)<bidRank(signoff)&&legal(x.c)&&suitHcp(ctx.deal,seat,x.s)>=3)
            .sort((a,b)=>bidRank(a.c)-bidRank(b.c));
          const target=forces[0]?.c || (legal(game)?game:null);
          if(target) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'v249-natural-try-positive',suits:{[tr]:{min:3,max:13}},
              points:{min:9,max:37},forcing:target===game?'nonforcing':'one_round_if_uncontested',
              publishWhenNative:true,convention:'sef2024-major-game-tries'},
            reason:`Chailley/SEF : ${hld} HLD après essai ${trial.call} => ${target}`
          };
        }

        if(raw==='PASS'&&legal(signoff)) return {
          call:signoff,changed:true,
          semantic:{natural:true,source:'v249-natural-try-forcing-safety',suits:{[tr]:{min:3,max:13}},
            forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
          reason:`Chailley/SEF : ${trial.call} est forcing ; Passe interdit => ${signoff}`
        };
      }
    }

    // Suite de l'essai lorsque le répondant a montré une force ou une courte.
    // Ces enchères sont forcing : l'ouvreur doit choisir entre arrêt à 3M et manche 4M
    // (ou, dans une logique de chelem non traitée ici, poursuivre au-delà).
    if(relHistory.length===8){
      const [open,p1,raise,p2,trial,p3,feature,p4]=relHistory;
      const ob=parseBid(open.call), rb=parseBid(raise.call), tb=parseBid(trial.call), fb=parseBid(feature.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && raise.seat===partner && rb?.level===2 && rb.strain===ob.strain &&
        p2.call==='PASS' && trial.seat===seat && tb && p3.call==='PASS' &&
        feature.seat===partner && fb && p4.call==='PASS' && openingEvent(history)===open;
      if(frame){
        const tr=ob.strain, signoff=`3${tr}`, game=`4${tr}`, ohld=chailleyFitHld(ctx.deal,seat,tr,3);
        const generalized=trial.call==='2NT';
        const naturalTry=tb.strain!=='NT' && tb.strain!==tr && bidRank(trial.call)<bidRank(signoff);
        if(generalized||naturalTry){
          // Retour négatif à 3M : fin de l'essai de manche. Seule l'utilisation de 2SA
          // comme recherche de chelem (4 perdantes) justifie de poursuivre jusqu'à 4M.
          if(feature.call===signoff){
            const target=(generalized && losingTricks(ctx.deal,seat)<=4 && legal(game))?game:'PASS';
            if(legal(target)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'v249-game-try-opener-after-negative',suits:{[tr]:{min:5,max:13}},
                points:{min:17,max:20},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
              reason:target==='PASS'
                ? `Chailley/SEF : réponse négative ${signoff} à l'essai => arrêt`
                : `Chailley/SEF : 2SA avec seulement ${losingTricks(ctx.deal,seat)} perdantes visait le chelem ; après refus => manche ${game}`
            };
          }
          // Force de palier 3 : elle est utile si elle couvre une zone réellement perdante
          // de l'ouvreur. Avec une main haute de la zone d'essai, on accepte également.
          if(fb.level===3 && fb.strain!==tr && fb.strain!=='NT' && bidRank(feature.call)<bidRank(signoff)){
            const useful=suitLosers(ctx.deal,seat,fb.strain)>=2;
            const target=(useful||ohld>=19)?game:signoff;
            if(legal(target)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'v249-game-try-opener-after-feature',suits:{[tr]:{min:5,max:13}},
                points:{min:17,max:20},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
              reason:`Chailley/SEF : force ${feature.call} ${useful?'utile':'peu utile'} pour l'ouvreur (${ohld} HLD) => ${target}`
            };
          }
          // Courte montrée au palier de 4 après 2SA : le répondant est maximum ;
          // la manche est acquise dans la zone d'essai de manche.
          if(generalized && fb.level===4 && fb.strain!==tr && bidRank(feature.call)<bidRank(game) && legal(game)){
            return {
              call:game,changed:raw!==game,
              semantic:{natural:true,source:'v249-game-try-opener-after-shortness',suits:{[tr]:{min:5,max:13}},
                points:{min:17,max:20},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-major-game-tries'},
              reason:`Chailley/SEF : courte ${feature.call} et réponse maximale à 2SA => ${game}`
            };
          }
        }
      }
    }

    // v2.51 — défense CONTRE le 2 faible : suite du mini-cue-bid 2SA.
    // Fiche Chailley révisée mars 2026 / SEF 2024 : le contreur minimum (13-15HL)
    // nomme sa meilleure mineure, non forcing. A partir de 16HL, toute autre
    // enchère est forte : autre majeure cinquième, 3SA naturel avec arrêt, ou cue-bid.
    if(relHistory.length===5){
      const [open,dbl,p1,mini,p2]=relHistory, ob=parseBid(open.call);
      const frame=ob?.level===2 && (ob.strain==='H'||ob.strain==='S') && dbl.seat===seat && dbl.call==='X' &&
        p1.call==='PASS' && mini.seat===partner && mini.call==='2NT' && p2.call==='PASS' && openingEvent(history)===open;
      if(frame){
        const om=ob.strain, other=om==='H'?'S':'H', HL=hlPoints(ctx.deal,seat);
        const pm=latestPartnerExplicitMeaning(ctx,m=>m?.convention==='sef2024-weak2-mini-cuebid');
        // En production le ledger confirme le sens ; en test un historique exact suffit.
        if(pm || mini.call==='2NT'){
          if(HL<=15){
            const minors=['C','D'].filter(s=>L[s]>=4).sort((a,b)=>(L[b]-L[a])||(suitHcp(ctx.deal,seat,b)-suitHcp(ctx.deal,seat,a))||(a==='C'?-1:1));
            const m=minors[0] || (L.C>=L.D?'C':'D'), target=`3${m}`;
            if(HL>=13 && legal(target)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'v251-weak2-minicue-doubler-minor',suits:{[m]:{min:Math.min(4,L[m]),max:13}},points:{min:13,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
              reason:`Chailley/SEF 2024 : contreur minimum ${HL} HL après mini-cue => meilleure mineure ${target}, non forcing`
            };
          }
          if(HL>=16){
            if(L[other]>=5 && legal(`3${other}`)) return {
              call:`3${other}`,changed:raw!==`3${other}`,
              semantic:{natural:true,source:'v251-weak2-minicue-doubler-strong-major',suits:{[other]:{min:5,max:13}},points:{min:16,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
              reason:`Chailley/SEF 2024 : contreur 16+HL, ${other} cinquième => 3${other} forcing de manche`
            };
            const stopOpp=stopperScore(ctx.deal,seat,om)>=0.7;
            if(stopOpp && L[other]>=4 && HL<=20 && legal('3NT')) return {
              call:'3NT',changed:raw!=='3NT',
              semantic:{natural:true,source:'v251-weak2-minicue-doubler-strong-3NT',suits:{[other]:{min:4,max:13}},points:{min:16,max:20},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
              reason:`Chailley/SEF 2024 : contreur ${HL} HL avec arrêt ${om} et 4+ ${other} => 3SA naturel`
            };
            const cue=`3${om}`;
            if(legal(cue)) return {
              call:cue,changed:raw!==cue,
              semantic:{natural:false,source:'v251-weak2-minicue-doubler-strong-cuebid',points:{min:16,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
              reason:`Chailley/SEF 2024 : contreur fort ${HL} HL sans meilleure description => cue-bid ${cue}, forcing de manche`
            };
          }
        }
      }
    }

    // Après la réponse minimum 3m du contreur au mini-cue, le n°4 peut s'arrêter
    // dans une couleur au palier de 3. Les mains fortes 11+HL avec 4 cartes dans
    // l'autre majeure poursuivent selon la fiche SEF 2024 : 3SA avec arrêt de la
    // majeure d'ouverture, sinon cue-bid direct de cette majeure (seule enchère forcing).
    if(relHistory.length===7){
      const [open,dbl,p1,mini,p2,rebid,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(rebid.call);
      const frame=ob?.level===2 && (ob.strain==='H'||ob.strain==='S') && dbl.seat===partner && dbl.call==='X' &&
        p1.call==='PASS' && mini.seat===seat && mini.call==='2NT' && p2.call==='PASS' && rebid.seat===partner &&
        rb?.level===3 && (rb.strain==='C'||rb.strain==='D') && p3.call==='PASS' && openingEvent(history)===open;
      if(frame){
        const om=ob.strain, other=om==='H'?'S':'H', HL=hlPoints(ctx.deal,seat);
        if(HL>=11 && L[other]===4){
          const stopOpp=stopperScore(ctx.deal,seat,om)>=0.7;
          if(stopOpp && legal('3NT')) return {
            call:'3NT',changed:raw!=='3NT',
            semantic:{natural:true,source:'v251-weak2-minicue-strong-advancer-3NT',suits:{[other]:{min:4,max:13}},points:{min:11,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
            reason:`SEF 2024 : après mini-cue et réponse minimum, 11+HL + 4 ${other} + arrêt ${om} => 3SA`
          };
          const cue=`3${om}`;
          if(legal(cue)) return {
            call:cue,changed:raw!==cue,
            semantic:{natural:false,source:'v251-weak2-minicue-strong-advancer-cuebid',suits:{[other]:{min:4,max:13}},points:{min:11,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
            reason:`SEF 2024 : main forte du mini-cue avec 4+ ${other} sans arrêt ${om} => cue-bid ${cue}, seule enchère forcing`
          };
        }
      }
    }

    // v2.52 — mini-cue-bid : réponses au cue-bid fort du contreur.
    // Après 2M-X-P-2SA-P-3M-P, 3M est le cue-bid fort (16+HL), forcing
    // de manche. Chailley donne quatre familles de réponses : 3SA avec arrêt,
    // l'autre majeure au palier le plus économique avec quatre cartes (3S sur 2H,
    // 4H sur 2S), sinon 4C/4D par défaut selon
    // la meilleure mineure. Publier ce sens évite de laisser PONS improviser
    // une couleur sans fit sur une séquence artificielle qu'il ne comprend pas.
    if(relHistory.length===7){
      const [open,dbl,p1,mini,p2,strongCue,p3]=relHistory, ob=parseBid(open.call), cb=parseBid(strongCue.call);
      const frame=ob?.level===2 && (ob.strain==='H'||ob.strain==='S') && dbl.seat===partner && dbl.call==='X' &&
        p1.call==='PASS' && mini.seat===seat && mini.call==='2NT' && p2.call==='PASS' && strongCue.seat===partner &&
        cb?.level===3 && cb.strain===ob.strain && p3.call==='PASS' && openingEvent(history)===open;
      if(frame){
        const om=ob.strain, other=om==='H'?'S':'H';
        const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='v251-weak2-minicue-doubler-strong-cuebid');
        if(pm || strongCue.call===`3${om}`){
          const stopOpp=stopperScore(ctx.deal,seat,om)>=0.7;
          // Avec quatre cartes dans l'autre majeure, priorité au fit majeur sauf
          // main vraiment régulière avec arrêt adverse, où 3SA reste naturel.
          const otherCall=cheapestSuitCallAfter(relHistory,other);
          if(L[other]>=4 && !(strictBalanced(L)&&stopOpp&&suitHcp(ctx.deal,seat,other)<3) && otherCall && legal(otherCall)) return {
            call:otherCall,changed:raw!==otherCall,
            semantic:{natural:true,source:'v252-weak2-strongcue-advancer-major',suits:{[other]:{min:4,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
            reason:`Chailley/SEF : après le cue-bid fort 3${om}, priorité à ${otherCall} avec ${L[other]} cartes`
          };
          if(stopOpp && legal('3NT')) return {
            call:'3NT',changed:raw!=='3NT',
            semantic:{natural:true,source:'v252-weak2-strongcue-advancer-3NT',forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
            reason:`Chailley/SEF : après le cue-bid fort 3${om}, arrêt ${om} => 3SA`
          };
          const minors=['C','D'].sort((a,b)=>(L[b]-L[a])||(suitHcp(ctx.deal,seat,b)-suitHcp(ctx.deal,seat,a))||(a==='C'?-1:1));
          const m=minors[0], target=`4${m}`;
          if(legal(target)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'v252-weak2-strongcue-advancer-default-minor',suits:{[m]:{min:Math.max(3,L[m]),max:13}},forcing:'game_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
            reason:`Chailley/SEF : sans arrêt ${om} ni fit majeur, meilleure mineure de repli => ${target}`
          };
        }
      }
    }

    // v2.52 — fermeture de sécurité après une manche mineure atteinte dans la
    // branche précédente. Une fois 5m déclaré par le partenaire, PONS ne doit pas
    // inventer au palier de 5 une nouvelle majeure avec seulement 0-4 cartes et
    // aucun fit majeur publiquement établi. C'est exactement le type d'emballement
    // détecté par le gate v1 (ex. 5D -> 5H sur un fit total de cinq cartes).
    if(relHistory.length>=11 && (raw==='5H'||raw==='5S')){
      const open=relHistory[0], ob=parseBid(open?.call);
      const weak2MiniFrame=ob?.level===2 && (ob.strain==='H'||ob.strain==='S') &&
        relHistory[1]?.call==='X' && relHistory[2]?.call==='PASS' && relHistory[3]?.call==='2NT' && relHistory[4]?.call==='PASS' &&
        relHistory[5]?.call===`3${ob.strain}`;
      const last=relHistory[relHistory.length-1], prev=relHistory[relHistory.length-2], lb=parseBid(prev?.call);
      if(weak2MiniFrame && last?.call==='PASS' && prev?.seat===partner && lb?.level===5 && (lb.strain==='C'||lb.strain==='D')){
        const maj=raw.slice(1), pm=latestPartnerExplicitMeaning(ctx,m=>m?.suits?.[maj]?.min>0);
        const known=pm?.suits?.[maj]?.min||0;
        if(L[maj]<5 && L[maj]+known<8 && legal('PASS')) return {
          call:'PASS',changed:true,
          semantic:{natural:true,source:'v252-no-late-major-without-fit',forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'},
          reason:`gate réel : dans la branche mini-cue, ${raw} au palier de 5 sans fit ${maj} établi après ${prev.call} => Passe`
        };
      }
    }

    // v2.43 — 2 faible : relais 2SA fitté et description mini/maxi de l'ouvreur.
    // Référence SEF 2024 / Bessis : sur 2H/2S faible, 2SA est un relais fitté
    // (2+ atouts) à partir de 15 HLD. Après ce relais, 3M décrit toujours la
    // zone minimale ; une autre redemande montre une main maximale. Au palier
    // de 3, l'ouvreur annonce en priorité une force annexe (au moins le Roi) ;
    // sans force, un singleton est montré au palier de 4.
    if(relHistory.length===2){
      const [open,opp]=relHistory, ob=parseBid(open.call);
      if(open.seat===partner && ob?.level===2 && (ob.strain==='H'||ob.strain==='S') &&
         opp.call==='PASS' && openingEvent(history)===open){
        const tr=ob.strain, fit=L[tr]||0, hld=supportHld(ctx.deal,seat,tr);
        if(fit>=2 && fit<=3 && hld>=15 && legal('2NT')) return {
          call:'2NT',changed:raw!=='2NT',
          semantic:{natural:false,source:'v243-weak2-fitted-2NT-relay',suits:{[tr]:{min:2,max:13}},points:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
          reason:`SEF 2024 : sur 2${tr} faible, fit ${fit}e et ${hld} HLD => relais fitté 2SA`
        };
      }
    }

    if(relHistory.length===4){
      const [open,p1,relay,p2]=relHistory, ob=parseBid(open.call);
      const frame=open.seat===seat && ob?.level===2 && (ob.strain==='H'||ob.strain==='S') &&
        p1.call==='PASS' && relay.seat===partner && relay.call==='2NT' && p2.call==='PASS' && openingEvent(history)===open;
      if(frame){
        const tr=ob.strain, hld=supportHld(ctx.deal,seat,tr);
        if(hld<=10){
          const target=`3${tr}`;
          if(legal(target)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'v243-weak2-minimum-after-2NT',suits:{[tr]:{min:6,max:6}},points:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
            reason:`SEF 2024 : relais 2SA sur 2${tr} faible ; ${hld} HLD = zone minimale => ${target} obligatoire`
          };
        }
        if(hld>=11){
          const forceCandidates=SUITS.filter(s=>s!==tr && L[s]>=2 && /[AK]/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')))
            .map(s=>({s,call:cheapestSuitCallAfter(history,s)})).filter(x=>x.call&&+x.call[0]===3&&legal(x.call))
            .sort((a,b)=>bidRank(a.call)-bidRank(b.call));
          if(forceCandidates.length){
            const x=forceCandidates[0];
            return {
              call:x.call,changed:raw!==x.call,
              semantic:{natural:false,source:'v243-weak2-maximum-side-force',suits:{[tr]:{min:6,max:6},[x.s]:{min:2,max:13}},points:{min:11,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
              reason:`SEF 2024 : relais 2SA ; main maximale (${hld} HLD), priorité à la force ${x.s} => ${x.call}`
            };
          }
          // v2.44 : cas spécial documenté après 2H-2SA. Un singleton Pique
          // ne peut pas être codé par 4S, car le camp ne pourrait plus revenir à 4H.
          // Il est donc montré conventionnellement par 4H.
          if(tr==='H' && L.S===1 && legal('4H')) return {
            call:'4H',changed:raw!=='4H',
            semantic:{natural:false,source:'v244-weak2-heart-maximum-spade-singleton',suits:{H:{min:6,max:6},S:{min:0,max:1}},points:{min:11,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
            reason:`SEF : relais 2SA sur 2H ; ouverture maximale sans force annexe et singleton Pique => 4H conventionnel (jamais 4S)`
          };
          const singletons=SUITS.filter(s=>s!==tr && L[s]===1)
            .map(s=>({s,call:`4${s}`})).filter(x=>legal(x.call)).sort((a,b)=>bidRank(a.call)-bidRank(b.call));
          if(singletons.length){
            const x=singletons[0];
            return {
              call:x.call,changed:raw!==x.call,
              semantic:{natural:false,source:'v243-weak2-maximum-singleton',suits:{[tr]:{min:6,max:6},[x.s]:{min:0,max:1}},points:{min:11,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
              reason:`SEF 2024 : relais 2SA ; main maximale sans force annexe, singleton ${x.s} => ${x.call}`
            };
          }
          // 3M serait mensonger (il promet la zone minimale). Sans force ni courte,
          // 3SA est la description maximale documentée la plus neutre. On ne remplace
          // pas un éventuel 4M natif, lui aussi admis dans cette famille.
          if((raw==='PASS'||raw===`3${tr}`||(/^3[CDHS]$/.test(raw)&&raw!==`3${tr}`)) && legal('3NT')) return {
            call:'3NT',changed:raw!=='3NT',
            semantic:{natural:false,source:'v243-weak2-maximum-no-force-no-shortness',suits:{[tr]:{min:6,max:6}},points:{min:11,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
            reason:`SEF 2024 : relais 2SA ; main maximale (${hld} HLD) sans force ni singleton => 3SA, jamais 3${tr}`
          };
        }
      }
    }

    // Après 3M minimum, le répondant dans la zone limite du relais peut s'arrêter.
    // La fiche 2M-2SA-? prévoit explicitement Passe sur 3M minimum ; les mains
    // 15-16 HLD sont précisément la zone où l'information mini/maxi décide la manche.
    if(relHistory.length===6){
      const [open,p1,relay,p2,minimum,p3]=relHistory, ob=parseBid(open.call), mb=parseBid(minimum.call);
      const frame=open.seat===partner && ob?.level===2 && (ob.strain==='H'||ob.strain==='S') && p1.call==='PASS' &&
        relay.seat===seat && relay.call==='2NT' && p2.call==='PASS' && minimum.seat===partner &&
        mb?.level===3 && mb.strain===ob.strain && p3.call==='PASS';
      if(frame){
        const hld=supportHld(ctx.deal,seat,ob.strain);
        if(hld<=16 && legal('PASS')) return {
          call:'PASS',changed:raw!=='PASS',
          semantic:{natural:false,source:'v243-weak2-stop-after-minimum',suits:{[ob.strain]:{min:2,max:3}},points:{min:0,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
          reason:`SEF 2024 : après relais 2SA, 3${ob.strain} montre l'ouverture minimale ; ${hld} HLD => arrêt à 3${ob.strain}`
        };
      }
    }

    // Une réponse 4x de l'ouvreur au relais 2SA montre une main maximale et un
    // singleton. Elle est forcing : le répondant ne doit jamais abandonner à 4C/4D
    // sous la manche majeure. Si PONS brut passe, on revient au moins à 4M.
    if(relHistory.length===6 && raw==='PASS'){
      const [open,p1,relay,p2,short,p3]=relHistory, ob=parseBid(open.call), sb=parseBid(short.call);
      const frame=open.seat===partner && ob?.level===2 && (ob.strain==='H'||ob.strain==='S') && p1.call==='PASS' &&
        relay.seat===seat && relay.call==='2NT' && p2.call==='PASS' && short.seat===partner &&
        sb?.level===4 && sb.strain!=='NT' && sb.strain!==ob.strain && p3.call==='PASS';
      if(frame){
        const game=`4${ob.strain}`;
        if(legal(game)) return {
          call:game,changed:true,
          semantic:{natural:true,source:'v243-weak2-continue-after-maximum-singleton',suits:{[ob.strain]:{min:2,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
          reason:`SEF 2024 : ${short.call} montre un singleton et une ouverture maximale ; Passe interdit sous la manche => ${game}`
        };
      }
    }

    // Après une force au palier de 3, 3SA du répondant est un second relais
    // chelemisant qui demande le singleton. L'ouvreur le nomme au palier de 4,
    // ou revient à 4M s'il n'en possède pas.
    if(relHistory.length===8){
      const [open,p1,relay,p2,force,p3,ask,p4]=relHistory, ob=parseBid(open.call), fb=parseBid(force.call);
      const frame=open.seat===seat && ob?.level===2 && (ob.strain==='H'||ob.strain==='S') && p1.call==='PASS' &&
        relay.seat===partner && relay.call==='2NT' && p2.call==='PASS' && force.seat===seat && fb?.level===3 &&
        fb.strain!=='NT' && fb.strain!==ob.strain && p3.call==='PASS' && ask.seat===partner && ask.call==='3NT' && p4.call==='PASS';
      if(frame){
        const tr=ob.strain;
        const singletons=SUITS.filter(s=>s!==tr && L[s]===1).map(s=>({s,call:`4${s}`})).filter(x=>legal(x.call)).sort((a,b)=>bidRank(a.call)-bidRank(b.call));
        const target=singletons.length?singletons[0].call:`4${tr}`;
        if(legal(target)) return {
          call:target,changed:raw!==target,
          semantic:{natural:false,source:'v243-weak2-singleton-answer-after-3NT-relay',suits:{[tr]:{min:6,max:6}},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-weak2-2NT-relay'},
          reason:singletons.length?`SEF 2024 : 3SA après annonce d'une force demande le singleton => ${target}`:`SEF 2024 : 3SA après annonce d'une force demande le singleton ; aucun singleton => 4${tr}`
        };
      }
    }

    // v2.37 — CONTRACT QUALITY PHASE 2.
    // All frames below use relHistory (auction from the first actual bid), so
    // initial Passes can never change the meaning of an otherwise identical sequence.

    // CQ1 — 1m-1M-1NT: after a Roudi denial (2D), a balanced responder with
    // genuine game values must not stop at 2NT. 19+ HL is quantitative for slam.
    if(relHistory.length===10){
      const [open,p1,resp,p2,nt,p3,roudi,p4,ans,p5]=relHistory, ob=parseBid(open.call), rb=parseBid(resp.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        nt.seat===partner && nt.call==='1NT' && p3.call==='PASS' && roudi.seat===seat && roudi.call==='2C' &&
        p4.call==='PASS' && ans.seat===partner && ans.call==='2D' && p5.call==='PASS';
      if(frame && balanced(L)){
        const HL=hlPoints(ctx.deal,seat);
        const target=HL>=19?'4NT':HL>=12?'3NT':null;
        if(target && ['PASS','2NT','3NT','4NT'].includes(raw) && legal(target)) return {
          call:target,changed:raw!==target,
          semantic:{natural:true,source:'v237-roudi-no-fit-quantitative-capitanat',hcp:{min:12,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-development'},
          reason:target==='4NT'?`qualité contrat : Roudi sans fit, ${HL} HL réguliers => 4SA quantitatif`:`qualité contrat : Roudi sans fit, ${HL} HL réguliers => manche 3SA`
        };
      }
    }

    // v2.44 — après la deuxième mineure forte publiée forcing de manche,
    // l'ouvreur régulier ne peut pas laisser mourir la séquence à 3m.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,p1,resp,p2,nt,p3,side,p4]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), sb=parseBid(side.call);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='v239-1m1M1NT-strong-side-minor-publish-native');
      const frame=open.seat===seat&&ob?.level===1&&(ob.strain==='C'||ob.strain==='D')&&p1.call==='PASS'&&resp.seat===partner&&rb?.level===1&&(rb.strain==='H'||rb.strain==='S')&&p2.call==='PASS'&&nt.seat===seat&&nt.call==='1NT'&&p3.call==='PASS'&&side.seat===partner&&sb?.level===3&&(sb.strain==='C'||sb.strain==='D')&&p4.call==='PASS'&&pm;
      if(frame&&balanced(L)&&legal('3NT')) return {call:'3NT',changed:true,semantic:{natural:true,source:'v244-opener-3NT-after-strong-side-minor',hcp:{min:12,max:14},forcing:'nonforcing',publishWhenNative:true,convention:'course19-after-1NT'},reason:'qualité contrat : la deuxième mineure du répondant est forcing de manche ; avec la redemande régulière 1SA, Passe est interdit => 3SA'};
    }

    // CQ1b — 1m-1M-1NT: a strong irregular responder with a genuine side minor
    // must keep the auction forcing instead of collapsing into a low partscore.
    if(relHistory.length===6){
      const [open,p1,resp,p2,nt,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(resp.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        nt.seat===partner && nt.call==='1NT' && p3.call==='PASS';
      if(frame && H>=12 && !balanced(L)){
        const sideMinor=['C','D'].filter(mi=>mi!==ob.strain && L[mi]>=5).sort((a,b)=>L[b]-L[a])[0];
        if(sideMinor){
          const target=`3${sideMinor}`;
          if((['PASS',`2${ob.strain}`,`2${sideMinor}`,'2NT'].includes(raw) || raw===target) && legal(target)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'v239-1m1M1NT-strong-side-minor-publish-native',suits:{[rb.strain]:{min:4,max:13},[sideMinor]:{min:5,max:13}},hcp:{min:12,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-after-1NT'},
            reason:raw===target?`qualité contrat : ${target} natif est correct mais doit rester forcing de manche (${H} H, ${L[sideMinor]} cartes)`:`qualité contrat : après 1m-1M-1SA, ${L[sideMinor]} cartes à ${sideMinor} et ${H} H => ${target} naturel forcing de manche`
          };
        }
      }
    }


    // CQ1c — 1m-1M-1NT: a game-forcing responder must not sign off below game.
    // With a 5+ card major we use Roudi to look for the 5-3 fit; without a fifth
    // major or a genuine 5-card side minor, 13+ H is enough to close at 3NT.
    if(relHistory.length===6){
      const [open,p1,resp,p2,nt,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(resp.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        nt.seat===partner && nt.call==='1NT' && p3.call==='PASS';
      if(frame && H>=13){
        const lowRaw=raw==='PASS'||raw===`2${ob.strain}`||raw==='2NT';
        if(lowRaw && L[rb.strain]>=5 && legal('2C')) return {
          call:'2C',changed:raw!=='2C',
          semantic:{natural:false,source:'v237-1m1M1NT-strong-roudi',suits:{[rb.strain]:{min:5,max:13}},hcp:{min:13,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course18-roudi'},
          reason:`qualité contrat : ${H} H et ${L[rb.strain]} cartes à ${rb.strain} après 1SA => Roudi 2C, arrêt sous la manche interdit`
        };
        const sideMinor=['C','D'].find(mi=>mi!==ob.strain && L[mi]>=5);
        if(lowRaw && !sideMinor && legal('3NT')) return {
          call:'3NT',changed:raw!=='3NT',
          semantic:{natural:true,source:'v237-1m1M1NT-strong-game',hcp:{min:13,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-after-1NT'},
          reason:`qualité contrat : ${H} H après 1m-1M-1SA, sans majeure cinquième ni deuxième mineure longue => 3SA`
        };
      }
    }

    // CQ3c — after an 18-19-ish 2NT rebid, a responder with a five-card major
    // should offer the 5-3 major game instead of closing blindly in 3NT.
    if(relHistory.length===6 && raw==='3NT'){
      const [open,p1,resp,p2,nt,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(resp.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        nt.seat===partner && nt.call==='2NT' && p3.call==='PASS';
      if(frame && L[rb.strain]>=5 && legal(`3${rb.strain}`)) return {
        call:`3${rb.strain}`,changed:true,
        semantic:{natural:true,source:'v237-1m1M2NT-five-major-choice',suits:{[rb.strain]:{min:5,max:13}},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course15-notrump'},
        reason:`qualité contrat : après 1m-1M-2SA, ${L[rb.strain]} cartes à ${rb.strain} => 3${rb.strain} pour proposer la manche 5-3 plutôt que fermer à 3SA`
      };
    }
    // CQ3d — opener answers that 5-card-major choice: three cards means 4M,
    // otherwise return to 3NT.
    if(relHistory.length===8){
      const [open,p1,resp,p2,nt,p3,check,p4]=relHistory, ob=parseBid(open.call), rb=parseBid(resp.call), cb=parseBid(check.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        nt.seat===seat && nt.call==='2NT' && p3.call==='PASS' && check.seat===partner && cb?.level===3 && cb.strain===rb.strain && p4.call==='PASS';
      if(frame){
        const target=L[rb.strain]>=3?`4${rb.strain}`:'3NT';
        if(legal(target)) return {
          call:target,changed:raw!==target,
          semantic:{natural:true,source:'v237-1m1M2NT-opener-major-choice',suits:{[rb.strain]:{min:L[rb.strain]>=3?3:0,max:L[rb.strain]>=3?13:2}},forcing:'nonforcing',publishWhenNative:true,convention:'course15-notrump'},
          reason:L[rb.strain]>=3?`qualité contrat : 3 cartes à ${rb.strain} face aux 5+ du répondant => 4${rb.strain}`:`qualité contrat : pas de fit 5-3 en ${rb.strain} => retour à 3SA`
        };
      }
    }

    // CQ3 — once an opener has explicitly raised the responder's major, do not
    // abandon a known 4-4+ major fit for 3NT with game-going values.
    if(relHistory.length===6 && raw==='3NT'){
      const [open,p1,resp,p2,raise,p3]=relHistory, ob=parseBid(open.call), rb=parseBid(resp.call), rr=parseBid(raise.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        raise.seat===partner && rr?.level===2 && rr.strain===rb.strain && p3.call==='PASS';
      if(frame && L[rb.strain]>=4 && supportHld(ctx.deal,seat,rb.strain)>=13){
        const target=`4${rb.strain}`;
        if(legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'v237-major-fit-before-3NT',suits:{[rb.strain]:{min:4,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'major-fit-quality'},reason:`qualité contrat : fit majeur explicite ${rb.strain} 4-4+ et valeurs de manche => ${target}, priorité au fit sur 3SA`};
      }
    }

    // CQ3b — after a Texas on 1NT, responder's 3NT offers a choice of games.
    // With three or more cards in the transferred major, opener chooses 4M.
    if(relHistory.length===8){
      const [open,p1,tr,p2,rect,p3,choice,p4]=relHistory;
      const frame=open.seat===seat && open.call==='1NT' && p1.call==='PASS' && tr.seat===partner &&
        (tr.call==='2D'||tr.call==='2H') && p2.call==='PASS' && rect.seat===seat &&
        rect.call===(tr.call==='2D'?'2H':'2S') && p3.call==='PASS' && choice.seat===partner && choice.call==='3NT' && p4.call==='PASS';
      if(frame){
        const m=tr.call==='2D'?'H':'S';
        if(L[m]>=3 && legal(`4${m}`)) return {call:`4${m}`,changed:raw!==`4${m}`,semantic:{natural:true,source:'v237-1NT-texas-3NT-major-choice',suits:{[m]:{min:3,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'nt-texas-game-choice'},reason:`qualité contrat : après Texas puis 3SA, ${L[m]} cartes chez l'ouvreur => choix de la manche 4${m}`};
      }
    }

    // v2.19 restored transversal semantic/native guards. These are existing
    // agreements only; they protect their continuations from a native PONS
    // reinterpretation before the family-specific legacy rules run.

    // v2.33 — ouverture mineure, intervention à la couleur, réponse majeure au palier de 1.
    // La fiche compétitive Chailley 1C-1H-1S-P-? rappelle que 1M est forcing et
    // qu'un ouvreur avec un fit majeur et 18-19 HLD ne doit pas se contenter du
    // soutien simple (12-16 HLD). Avec une vraie main forte et au moins trois
    // atouts, on place directement la manche majeure au lieu de laisser PONS
    // sous-zoner la main à 2M. Le cadre est généralisé uniquement aux ouvertures
    // mineures + intervention naturelle + réponse majeure au palier de 1.
    if(relHistory.length===4){
      const [open,over,resp,p1]=relHistory, ob=parseBid(open.call), ib=parseBid(over.call), rb=parseBid(resp.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') &&
        ib?.level===1 && ib.strain!=='NT' && sideOf(over.seat)!==sideOf(seat) &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        rb.strain!==ib.strain && p1.call==='PASS';
      if(frame && L[rb.strain]>=3){
        const hld=supportHld(ctx.deal,seat,rb.strain);
        // La fiche distingue 4M attaque-défense (18-19 HLD) du cue-bid
        // forcing réservé aux fits trop forts. On ne doit donc surtout pas
        // fermer la porte au chelem avec une main qui dépasse cette zone.
        if(H>=18 && hld>=20){
          const cue=cheapestSuitCallAfter(history,ib.strain);
          if(cue&&legal(cue)) return {
            call:cue,changed:raw!==cue,
            semantic:{natural:false,source:'course-competitive-minor-opener-strong-major-fit-cuebid',suits:{[rb.strain]:{min:3,max:13}},hcp:{min:18,max:23},forcing:'forcing',publishWhenNative:true,convention:'minor-open-overcall-major-response'},
            reason:`Enchères compétitives : réponse 1${rb.strain} forcing, fit ${L[rb.strain]}e et ${hld} HLD très forts => cue-bid ${cue} forcing ; préserver l'exploration de manche/chelem au lieu de ${raw}`
          };
        }
        const game=`4${rb.strain}`;
        if(H>=18 && hld>=18 && hld<=19 && legal(game)) return {
          call:game,changed:raw!==game,
          semantic:{natural:true,source:'course-competitive-minor-opener-strong-major-fit-game',suits:{[rb.strain]:{min:3,max:13}},hcp:{min:18,max:23},forcing:'nonforcing',publishWhenNative:true,convention:'minor-open-overcall-major-response'},
          reason:`Enchères compétitives : réponse 1${rb.strain} forcing, fit ${L[rb.strain]}e et ${hld} HLD => manche attaque-défense 4${rb.strain} ; ne pas sous-zoner à ${raw}`
        };
      }
    }

    // v2.33 — continuation du cue-bid fort fitté après ouverture mineure.
    // Une fois le cue-bid forcing émis par l'ouvreur, le retour minimum du
    // répondant dans sa majeure ne peut pas être laissé au palier de 2.
    // Le noyau PONS ne connaît pas ce sens artificiel et peut proposer PASS ;
    // on ferme alors au moins à la manche majeure.
    if(raw==='PASS' && relHistory.length===8){
      const [open,over,resp,p1,cue,p2,ret,p3]=relHistory;
      const ob=parseBid(open.call),ib=parseBid(over.call),rb=parseBid(resp.call),cb=parseBid(cue.call),tb=parseBid(ret.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') &&
        ib?.level===1 && ib.strain!=='NT' && sideOf(over.seat)!==sideOf(seat) &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        p1.call==='PASS' && cue.seat===seat && cb?.strain===ib.strain && cb.level===2 &&
        p2.call==='PASS' && ret.seat===partner && tb?.strain===rb.strain && tb.level===2 && p3.call==='PASS';
      if(frame && L[rb.strain]>=3 && H>=18){
        const game=`4${rb.strain}`;
        if(legal(game)) return {
          call:game,changed:true,
          semantic:{natural:true,source:'course-competitive-minor-opener-strong-fit-cuebid-close-game',suits:{[rb.strain]:{min:3,max:13}},hcp:{min:18,max:23},forcing:'nonforcing',publishWhenNative:true,convention:'minor-open-overcall-major-response'},
          reason:`Après le cue-bid fort fitté ${cue.call}, le retour ${ret.call} du répondant ne permet pas de passer sous la manche : ${game}`
        };
      }
    }

    // Cours 23 — une nouvelle couleur libre au premier palier disponible
    // après 1M-(intervention) est forcing un tour. Le partenaire a publié cette
    // signification explicitement ; l'ouvreur doit donc fournir une redemande
    // naturelle au lieu de laisser le Semantic Guard choisir à sa place.
    if(relHistory.length===4&&raw==='PASS'){
      const [open,over,free,p1]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='critic-known-free-bid-cheapest'||m.convention==='new-suit-free-bid-after-1M-overcall-cheapest');
      const ob=parseBid(open.call),fb=parseBid(free.call);
      const frame=open.seat===seat&&ob?.level===1&&(ob.strain==='H'||ob.strain==='S')&&free.seat===partner&&fb&&fb.strain!=='NT'&&p1.call==='PASS'&&pm;
      if(frame){
        let target=null,semantic=null;
        if(L[fb.strain]>=3){target=cheapestSuitCallAfter(history,fb.strain);if(target)semantic={natural:true,source:'course23-opener-support-after-forcing-free-bid',suits:{[fb.strain]:{min:3,max:13}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'new-suit-free-bid-after-1M-overcall-cheapest'};}
        if(!target&&L[ob.strain]>=6){target=cheapestSuitCallAfter(history,ob.strain);if(target)semantic={natural:true,source:'course23-opener-repeat-after-forcing-free-bid',suits:{[ob.strain]:{min:6,max:13}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'new-suit-free-bid-after-1M-overcall-cheapest'};}
        if(!target){const ib=parseBid(over.call);if(ib?.strain&&stopperScore(ctx.deal,seat,ib.strain)>=0.7){const last=lastActualBid(history),rank=bidRank(last?.call);for(const c of ['2NT','3NT'])if(bidRank(c)>rank&&legal(c)){target=c;semantic={natural:true,source:'course23-opener-nt-after-forcing-free-bid',hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'new-suit-free-bid-after-1M-overcall-cheapest'};break;}}}
        if(!target&&L[ob.strain]>=5){target=cheapestSuitCallAfter(history,ob.strain);if(target)semantic={natural:true,source:'course23-opener-fallback-after-forcing-free-bid',suits:{[ob.strain]:{min:5,max:13}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'new-suit-free-bid-after-1M-overcall-cheapest'};}
        if(target&&semantic&&legal(target))return{call:target,changed:true,semantic,reason:`cours 23 : ${free.call} libre est forcing un tour ; redemande naturelle obligatoire ${target}`};
      }
    }

    // Cours 11/24 — after a strong Spoutnik major rebid, responder completes
    // the known fit or chooses 3NT with the stopper.
    if(relHistory.length===6){
      const [open,over,dbl,p1,strongMajor,p2]=relHistory, partner=partnerOf(seat);
      const mb=parseBid(strongMajor.call);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course11-generalized-spoutnik-opener-support'||m.convention==='course24-1D-2C-opener-one-major-jump');
      const frame=dbl.seat===seat && p1.call==='PASS' && strongMajor.seat===partner && p2.call==='PASS' && mb?.level===3 && (mb.strain==='H'||mb.strain==='S') && pm;
      if(frame && L[mb.strain]>=4 && legal(`4${mb.strain}`)) return {
        call:`4${mb.strain}`,changed:raw!==`4${mb.strain}`,
        semantic:{natural:true,source:'course11-24-responder-completes-strong-spoutnik-major',suits:{[mb.strain]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:pm.convention},
        reason:`cours 11/24 : redemande forte ${strongMajor.call} après Spoutnik ; avec le fit, conclusion à 4${mb.strain}`
      };
      if(frame && L[mb.strain]<4){
        const ib=parseBid(over.call);
        if(ib?.strain&&ib.strain!=='NT'&&stopperScore(ctx.deal,seat,ib.strain)>=0.7&&legal('3NT')) return {
          call:'3NT',changed:raw!=='3NT',semantic:{natural:true,source:'course11-24-responder-3NT-after-strong-spoutnik-major-no-fit',hcp:{min:8,max:37},forcing:'nonforcing',publishWhenNative:true,convention:pm.convention},
          reason:`cours 11/24 : pas de fit ${mb.strain}, mais arrêt ${ib.strain} => 3SA`
        };
      }
    }

    // v2.45 — jump-shift fort du répondant après 1m-1M-1SA : lorsque
    // l'ouvreur confirme ensuite le fit mineur au palier de 4, le forcing de
    // manche ne peut pas mourir à 4m. Le contrat minimal sûr est 5m.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,nt,p3,jump,p4,fit,p5]=relHistory, partner=partnerOf(seat);
      const jb=parseBid(jump.call), fb=parseBid(fit.call);
      const frame=open.seat===partner&&p1.call==='PASS'&&resp.seat===seat&&(resp.call==='1H'||resp.call==='1S')&&p2.call==='PASS'&&nt.seat===partner&&nt.call==='1NT'&&p3.call==='PASS'&&jump.seat===seat&&jb?.level===3&&(jb.strain==='C'||jb.strain==='D')&&p4.call==='PASS'&&fit.seat===partner&&fb?.level===4&&fb.strain===jb.strain&&p5.call==='PASS';
      if(frame && L[jb.strain]>=5){
        const target=`5${jb.strain}`;
        if(legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'v245-responder-minor-game-after-forcing-jumpshift-fit',suits:{[jb.strain]:{min:5,max:13}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'jumpshift-fit-game'},reason:`audit 100K v2.45 : ${jump.call} a engagé le camp à la manche et ${fit.call} confirme le fit ; Passe interdit => ${target}`};
      }
    }

    // v2.45 — audit autonome 100K : le Spoutnik « sans majeure » ne promet
    // surtout PAS quatre Piques. Quand le n°4 passe, le noyau PONS confondait pourtant
    // systématiquement les quatre Piques propres de l'ouvreur avec un fit partenaire et
    // sautait à 4S. Sur les 106 cas observés, l'ouvreur avait exactement 4S et le
    // contreur 0-2S. On conserve donc la description naturelle économique à 1S, sans
    // inventer un fit ni une manche.
    if(relHistory.length===4){
      const [open,over,dbl,oppPass]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), ib=parseBid(over.call), rb=parseBid(raw);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='v245-sef-spoutnik-no-four-spades'||m.source==='course24-no-major-spoutnik-after-minor');
      const frame=open.seat===seat && (open.call==='1C'||open.call==='1D') && over.seat!==seat && over.call==='1H' &&
        dbl.seat===partner && dbl.call==='X' && oppPass.call==='PASS' && pm;
      if(frame && rb?.strain==='S' && rb.level>=3 && L.S===4 && legal('1S')) return {
        call:'1S',changed:true,
        semantic:{natural:true,source:'v245-course24-opener-own-four-spades-after-no-major-spoutnik',suits:{S:{min:4,max:4}},hcp:{min:10,max:21},forcing:'unknown',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},
        reason:'audit 100K v2.45 : le Contre sans majeure dénie le fit Pique ; quatre Piques propres chez l’ouvreur se décrivent à 1S, pas par un saut à 4S'
      };
    }

    // Cours 24 — après un Spoutnik « sans majeure » / demande d'arrêt, si
    // l'adversaire de droite nomme 1P, un 2P/3P de l'ouvreur est un cue-bid : il
    // ne promet évidemment pas quatre Piques. On conserve l'enchère PONS mais on
    // publie son vrai sens artificiel afin d'éviter la collision de longueur.
    if(relHistory.length===4){
      const [open,over,dbl,oppBid]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), ib=parseBid(over.call), cb=parseBid(oppBid.call);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course24-spoutnik-stopper-ask');
      const rb=parseBid(raw);
      const frame=open.seat===seat && (open.call==='1C'||open.call==='1D') && over.seat!==seat && ib?.level===1 &&
        dbl.seat===partner && dbl.call==='X' && oppBid.seat!==seat && cb?.level===1 && cb.strain==='S' && pm;
      if(frame && rb && rb.strain==='S' && (rb.level===2||rb.level===3) && legal(raw)) return {call:raw,changed:false,semantic:{natural:false,source:'course24-opener-spade-cuebid-after-stopper-double-competition',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask',hcp:{min:rb.level===3?14:10,max:21}},reason:`cours 24 : après le Spoutnik sans majeure et 1P adverse, ${raw} est un cue-bid artificiel, pas quatre Piques`};
    }


    // Anti-régression v2.33 — deuxième tour après soutien de l'ouvreur sur Spoutnik simple.
    // 1m-(1S)-X-P-2H-P : le contreur avec quatre Cœurs et une zone limite ne doit
    // pas passer automatiquement. 3H invite ; l'ouvreur maximum de la zone 2H accepte.
    if(relHistory.length===6){
      const [open,over,dbl,p1,fit,p2]=relHistory, partner=partnerOf(seat);
      const frame=(open.call==='1C'||open.call==='1D')&&over.call==='1S'&&dbl.seat===seat&&dbl.call==='X'&&p1.call==='PASS'&&fit.seat===partner&&fit.call==='2H'&&p2.call==='PASS';
      if(frame && L.H>=4){
        const hld=supportHld(ctx.deal,seat,'H');
        if(hld>=11 && hld<=12 && legal('3H')) return {call:'3H',changed:raw!=='3H',semantic:{natural:true,source:'v233-spoutnik-heart-fit-invite',suits:{H:{min:4,max:13}},points:{min:11,max:12},forcing:'nonforcing',publishWhenNative:true,convention:'course12-spoutnik'},reason:`anti-régression v2.3 : fit Cœur après Spoutnik, ${hld} HLD => proposition 3H`};
        if(hld>=13 && legal('4H')) return {call:'4H',changed:raw!=='4H',semantic:{natural:true,source:'v233-spoutnik-heart-fit-game',suits:{H:{min:4,max:13}},points:{min:13,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course12-spoutnik'},reason:`anti-régression v2.3 : fit Cœur après Spoutnik, ${hld} HLD => 4H`};
      }
    }
    if(relHistory.length===8){
      const [open,over,dbl,p1,fit,p2,invite,p3]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat&&(open.call==='1C'||open.call==='1D')&&over.call==='1S'&&dbl.seat===partner&&dbl.call==='X'&&p1.call==='PASS'&&fit.seat===seat&&fit.call==='2H'&&p2.call==='PASS'&&invite.seat===partner&&invite.call==='3H'&&p3.call==='PASS';
      if(frame){
        const hld=supportHld(ctx.deal,seat,'H');
        const target=hld>=14?'4H':'PASS';
        if(legal(target)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'v233-spoutnik-opener-after-heart-invite',suits:{H:{min:4,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'course12-spoutnik'},reason:hld>=14?`anti-régression v2.3 : soutien Spoutnik ${hld} HLD, acceptation de 3H => 4H`:`anti-régression v2.3 : soutien Spoutnik minimum ${hld} HLD, refus de 3H`};
      }
    }

    // Anti-régression v2.33 — 2D forcing de manche, réponse à l'As, fit mineur.
    // Avec 22+ H et un As montré en face, arrêter 5m est trop bas lorsque l'ouvreur
    // possède lui-même une vraie couleur cinquième ou plus : le minimum est 6m.
    if(history.length===8 && raw==='PASS'){
      const [open,p1,ace,p2,rebid,p3,game,p4]=history, partner=partnerOf(seat), rb=parseBid(rebid.call);
      const m=rb?.strain;
      const frame=open.seat===seat&&open.call==='2D'&&p1.call==='PASS'&&ace.seat===partner&&(ace.call==='3C'||ace.call==='3D')&&p2.call==='PASS'&&rebid.seat===seat&&rb?.level===4&&(m==='C'||m==='D')&&p3.call==='PASS'&&game.seat===partner&&game.call===`5${m}`&&p4.call==='PASS';
      if(frame && H>=22 && L[m]>=5 && legal(`6${m}`)) return {call:`6${m}`,changed:raw!==`6${m}`,semantic:{natural:true,source:'v233-2D-ace-fit-minor-slam',suits:{[m]:{min:5,max:13}},hcp:{min:22,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D'},reason:`anti-régression v2.3 : 2D forcing, As montré et fit ${m}; ${H} H => 6${m}`};
    }


    // Anti-régression v2.33 — réponse majeure naturelle après intervention, puis fit simple.
    // Si le répondant possède 13+ H et quatre atouts dans le fit 1M-2M, la manche est
    // certaine face à une ouverture : ne pas s'arrêter à une simple proposition 3M.
    if(relHistory.length===6){
      const [open,over,resp,oppAct,fit,p2]=relHistory, partner=partnerOf(seat), rb=parseBid(resp.call), fb=parseBid(fit.call);
      const frame=(open.call==='1C'||open.call==='1D')&&parseBid(over.call)?.level===1&&resp.seat===seat&&rb?.level===1&&(rb.strain==='H'||rb.strain==='S')&&fit.seat===partner&&fb?.level===2&&fb.strain===rb.strain&&p2.call==='PASS';
      if(frame && L[rb.strain]>=4 && H>=13 && legal(`4${rb.strain}`)) return {call:`4${rb.strain}`,changed:raw!==`4${rb.strain}`,semantic:{natural:true,source:'v233-natural-major-response-game-after-fit',suits:{[rb.strain]:{min:4,max:13}},hcp:{min:13,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'natural-competitive-major-fit'},reason:`anti-régression v2.3 : réponse naturelle 1${rb.strain}, fit confirmé et ${H} H => 4${rb.strain}`};
    }

    // Cours 24 — forcing minor bicolor after 1D-(1S)-X.
    if(relHistory.length===6){
      const [open,over,dbl,p1,bicolor,p2]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course24-1D-spoutnik-minor-bicolor');
      const frame=open.call==='1D'&&over.call==='1S'&&dbl.seat===seat&&dbl.call==='X'&&p1.call==='PASS'&&bicolor.seat===partner&&bicolor.call==='3C'&&p2.call==='PASS'&&pm;
      if(frame && stopperScore(ctx.deal,seat,'S')>=0.7 && legal('3NT')) return {
        call:'3NT',changed:raw!=='3NT',semantic:{natural:true,source:'course24-responder-3NT-after-forcing-minor-bicolor',hcp:{min:8,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor'},reason:'cours 24 : 3C bicolore à saut est forcing de manche ; avec arrêt Pique => 3SA'
      };
      if(frame && stopperScore(ctx.deal,seat,'S')<0.7 && L.D>=3 && legal('4D')) return {
        call:'4D',changed:raw!=='4D',semantic:{natural:true,source:'course24-responder-diamond-fit-after-forcing-minor-bicolor-no-stopper',suits:{D:{min:3,max:13}},hcp:{min:8,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor'},reason:'cours 24 : 3C forcing de manche, pas d’arrêt Pique ; soutien naturel des Carreaux à 4D'
      };
      if(frame && stopperScore(ctx.deal,seat,'S')<0.7 && L.H>=5 && legal('3H')) return {
        call:'3H',changed:raw!=='3H',semantic:{natural:true,source:'course24-responder-hearts-after-forcing-minor-bicolor',suits:{H:{min:5,max:13}},hcp:{min:8,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor'},reason:'cours 24 : 3C forcing de manche ; sans arrêt Pique mais avec cinq Cœurs, 3H naturel'
      };
      if(frame && stopperScore(ctx.deal,seat,'S')<0.7 && L.C>=4 && legal('4C')) return {
        call:'4C',changed:raw!=='4C',semantic:{natural:true,source:'course24-responder-club-fit-after-forcing-minor-bicolor-no-stopper',suits:{C:{min:4,max:13}},hcp:{min:8,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor'},reason:'cours 24 : 3C bicolore fort promet 4+ Trèfles ; sans arrêt Pique ni meilleur fit Carreau/Cœur, soutien naturel à 4C sous forcing de manche'
      };
    }

    // Cours 24 — après 1D-(2C)-X-P-3C*, le cue-bid de l'ouvreur
    // montre 18-19 H réguliers et exactement une majeure quatrième. Le répondant
    // qui possède au moins quatre cartes dans cette majeure connaît un fit 5-4/4-4
    // et doit conclure à la manche, jamais laisser jouer 3C artificiel.
    if(relHistory.length===6){
      const [open,over,dbl,p1,cue,p2]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='course24-1D-2C-opener-one-major-regular-strong'||m.convention==='course24-1D-2C-opener-cuebid');
      const frame=open.call==='1D'&&over.call==='2C'&&dbl.seat===seat&&dbl.call==='X'&&p1.call==='PASS'&&cue.seat===partner&&cue.call==='3C'&&p2.call==='PASS'&&pm;
      if(frame){
        const major=pm?.suits?.S?.min>=4?'S':pm?.suits?.H?.min>=4?'H':null;
        if(major&&L[major]>=4&&legal(`4${major}`)) return {
          call:`4${major}`,changed:raw!==`4${major}`,
          semantic:{natural:true,source:'course24-responder-major-fit-after-one-major-regular-strong',suits:{[major]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-2C-opener-cuebid'},
          reason:`cours 24 : 3C cue-bid = 18-19 H réguliers avec exactement 4${major}; avec ${L[major]} cartes en face, fit établi => 4${major}`
        };
      }
    }

    // Cours 24 — après le soutien naturel 4C du répondant sur le bicolore
    // fort 5D-4C de l'ouvreur, la manche à Trèfle est le minimum imposé. Un PASS
    // brut ne peut arrêter la séquence au palier de 4 dans une mineure.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,over,dbl,p1,bicolor,p2,fit,p3]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='course24-responder-club-fit-after-forcing-minor-bicolor-no-stopper');
      const frame=open.seat===seat&&open.call==='1D'&&over.call==='1S'&&dbl.seat===partner&&dbl.call==='X'&&p1.call==='PASS'&&bicolor.seat===seat&&bicolor.call==='3C'&&p2.call==='PASS'&&fit.seat===partner&&fit.call==='4C'&&p3.call==='PASS'&&pm;
      if(frame&&L.C>=4&&legal('5C')) return {
        call:'5C',changed:true,
        semantic:{natural:true,source:'course24-opener-closes-club-game-after-forcing-minor-bicolor',suits:{C:{min:4,max:13}},hcp:{min:16,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor'},
        reason:'cours 24 : 3C bicolore fort puis soutien 4C sous forcing de manche ; PASS interdit => 5C minimum'
      };
    }

    // Cours 24 / contrôles — après le fit Carreau forcing 4D sur le bicolore
    // fort 5D-4C, 4H de l'ouvreur est une tentative de chelem. Si le répondant
    // poursuit à 5C (contrôle) mais a sauté 4S, le contrôle Pique manque chez lui.
    // Sans Blackwood économique disponible, l'ouvreur revient à 5D : on ne saute
    // pas arbitrairement au chelem.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,over,dbl,p1,bicolor,p2,fitD,p3,cueH,p4,cueC,p5]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat&&open.call==='1D'&&over.call==='1S'&&dbl.seat===partner&&dbl.call==='X'&&p1.call==='PASS'&&
        bicolor.seat===seat&&bicolor.call==='3C'&&p2.call==='PASS'&&fitD.seat===partner&&fitD.call==='4D'&&p3.call==='PASS'&&
        cueH.seat===seat&&cueH.call==='4H'&&p4.call==='PASS'&&cueC.seat===partner&&cueC.call==='5C'&&p5.call==='PASS';
      if(frame&&legal('5D')) return {call:'5D',changed:true,semantic:{natural:true,source:'course24-opener-diamond-signoff-after-controls',forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor',suits:{D:{min:5,max:13}}},reason:'cours 24 : fit Carreau forcing, contrôles 4H-5C mais contrôle Pique sauté ; retour prudent à 5D'};
    }

    // Cours 24 — responder's natural heart continuation after the 1C-(1S)-X-2D reverse.
    if(relHistory.length===6){
      const [open,over,dbl,p1,reverse,p2]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course24-1C-spoutnik-reverse');
      const frame=open.call==='1C'&&over.call==='1S'&&dbl.seat===seat&&dbl.call==='X'&&p1.call==='PASS'&&reverse.seat===partner&&reverse.call==='2D'&&p2.call==='PASS'&&pm;
      if(frame&&L.H>=4&&legal('2H')) return {call:'2H',changed:raw!=='2H',semantic:{natural:true,source:'course24-responder-hearts-after-spoutnik-reverse',suits:{H:{min:4,max:13}},hcp:{min:8,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1C-spoutnik-reverse'},reason:'cours 24 : 2D est auto-forcing ; le répondant rappelle naturellement les Cœurs promis par le Spoutnik'};
    }

    // Cours 15/16 — fourth forcing has already committed the partnership to game.
    // Une fois qu'une mineure de l'ouvreur est fittée au palier de 4, PASS ne peut
    // pas arrêter le camp sous la manche. La v2.22 couvrait seulement le cas 4C ;
    // la même propriété dure vaut pour 4D après 1D-1H-2C-2S-3D-4D.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5,fit,p6]=relHistory, partner=partnerOf(seat);
      const core=open.seat===seat&&open.call==='1D'&&p1.call==='PASS'&&resp.seat===partner&&resp.call==='1H'&&p2.call==='PASS'&&rebid.seat===seat&&rebid.call==='2C'&&p3.call==='PASS'&&fourth.seat===partner&&fourth.call==='2S'&&p4.call==='PASS'&&cont.seat===seat&&p5.call==='PASS'&&fit.seat===partner&&p6.call==='PASS';
      if(core&&cont.call==='3C'&&fit.call==='4C'&&L.C>=4&&legal('5C')) return {call:'5C',changed:true,semantic:{natural:true,source:'course15-opener-completes-club-game-force-after-fourth',suits:{C:{min:4,max:13}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},reason:'cours 15/16 : quatrième forcing puis fit 4C ; PASS interdit => 5C'};
      if(core&&cont.call==='3D'&&fit.call==='4D'&&L.D>=5&&legal('5D')) return {call:'5D',changed:true,semantic:{natural:true,source:'course16-opener-completes-diamond-game-force-after-fourth',suits:{D:{min:5,max:13}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},reason:'cours 16 : quatrième forcing de manche puis fit 4D ; PASS interdit => 5D'};
    }

    // Cours 17 — exact two-card preference after third forcing. Preserve the
    // actual 6/7-card suit, never let PONS invent a third trump.
    if(relHistory.length===10){
      const [open,p1,resp,p2,rebid,p3,third,p4,pref,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), reb=parseBid(rebid.call);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-two-card-preference-after-third');
      const frame=open.seat===partner&&ob?.level===1&&(ob.strain==='C'||ob.strain==='D')&&p1.call==='PASS'&&resp.seat===seat&&resp.call==='1S'&&p2.call==='PASS'&&rebid.seat===partner&&reb?.level===2&&reb.strain===ob.strain&&p3.call==='PASS'&&third.seat===seat&&p4.call==='PASS'&&pref.seat===partner&&pref.call==='2S'&&p5.call==='PASS'&&pm;
      if(frame&&raw==='7S'&&L.S>=7&&H>=16&&legal('6S')) return {call:'6S',changed:true,semantic:{natural:true,source:'course17-responder-caps-grand-after-two-card-preference',suits:{S:{min:7,max:13}},hcp:{min:16,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-continuation'},reason:'cours 17 : 2S est une préférence à exactement deux cartes ; le grand chelem natif fondé sur un faux fit est ramené à 6S'};
      if(frame&&raw==='6S'&&L.S>=7&&legal('6S')) return {call:'6S',changed:false,semantic:{natural:true,source:'course17-responder-small-slam-after-two-card-preference',suits:{S:{min:7,max:13}},hcp:{min:14,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-continuation'},reason:'cours 17 : sept Piques créent un vrai fit 7-2 ; 6S est validé sans inventer un troisième atout'};
      if(frame&&raw==='6S'&&L.S===6&&((H>=16)||(H>=15&&losingTricks(ctx.deal,seat)<=4))&&legal('6S')) return {call:'6S',changed:false,semantic:{natural:true,source:'course17-responder-small-slam-six-card-after-two-card-preference',suits:{S:{min:6,max:6}},hcp:{min:15,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-continuation'},reason:`cours 17 : préférence 2S à deux cartes dans cette branche ; avec six Piques et une main très forte (${losingTricks(ctx.deal,seat)} perdantes), 6S repose sur le vrai fit 6-2, sans inventer un troisième atout`};
      if(frame&&raw==='4NT'&&L.S>=6&&H>=16&&legal('4NT')) return {call:'4NT',changed:false,semantic:{natural:false,source:'course17-responder-slam-continue-after-two-card-preference',suits:{S:{min:6,max:13}},hcp:{min:16,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-continuation'},reason:'cours 17 : préférence 2S = exactement deux cartes ; 4SA poursuit l’exploration avec la vraie longueur Pique'};
    }

    // Cours 17 — validation générique de la manche après une préférence
    // explicitement limitée à exactement deux cartes. Une longue de six cartes
    // chez le répondant crée bien un fit 6-2 ; on garde 4M sans laisser PONS
    // réinventer trois ou quatre atouts chez l'ouvreur.
    if(relHistory.length===10){
      const [open,p1,resp,p2,rebid,p3,third,p4,pref,p5]=relHistory;
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-two-card-preference-after-third');
      const rb=parseBid(resp.call), pb=parseBid(pref.call);
      const frame=resp.seat===seat&&rb?.level===1&&(rb.strain==='H'||rb.strain==='S')&&pref.seat===partner&&pb?.level===2&&pb.strain===rb.strain&&p5.call==='PASS'&&pm;
      if(frame&&raw===`4${rb.strain}`&&L[rb.strain]>=6&&legal(raw)) return {call:raw,changed:false,semantic:{natural:true,source:'course17-responder-game-after-two-card-preference',suits:{[rb.strain]:{min:6,max:13}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-continuation'},reason:`cours 17 : préférence 2${rb.strain} = exactement deux cartes ; avec ${L[rb.strain]} cartes, la manche 4${rb.strain} repose sur le vrai fit 6-2`};
    }

    // Cours 16 — réponse de l'ouvreur à la quatrième forcing particulière au
    // palier de 1 : 1C-1D-1H-1S. Le cours impose une description ; PASS est
    // impossible. 1SA couvre la main régulière 12-14 sans exiger l'arrêt Pique.
    if(relHistory.length===8&&raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4]=relHistory;
      const frame=open.seat===seat&&open.call==='1C'&&p1.call==='PASS'&&resp.seat===partner&&resp.call==='1D'&&p2.call==='PASS'&&rebid.seat===seat&&rebid.call==='1H'&&p3.call==='PASS'&&fourth.seat===partner&&fourth.call==='1S'&&p4.call==='PASS';
      if(frame){
        let target=null,semantic=null;
        if(L.S>=4){target='2S';semantic={natural:true,source:'course16-opener-four-spades-after-level1-fourth',suits:{S:{min:4,max:13}},hcp:{min:12,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-level1-fourth-forcing'};}
        else if(strictBalanced(L)&&H>=12&&H<=14){target='1NT';semantic={natural:true,source:'course16-opener-1NT-after-level1-fourth',hcp:{min:12,max:14},forcing:'nonforcing',publishWhenNative:true,convention:'course16-level1-fourth-forcing'};}
        else if(H>=15&&H<=17&&L.D<=1){target='2NT';semantic={natural:true,source:'course16-opener-2NT-after-level1-fourth',hcp:{min:15,max:17},forcing:'nonforcing',publishWhenNative:true,convention:'course16-level1-fourth-forcing'};}
        else if(H>=18&&H<=19&&strictBalanced(L)&&stopperScore(ctx.deal,seat,'S')>=0.7){target='3NT';semantic={natural:true,source:'course16-opener-3NT-after-level1-fourth',hcp:{min:18,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-level1-fourth-forcing'};}
        else if(L.D>=3){target=H>=15?'3D':'2D';semantic={natural:true,source:'course16-opener-diamond-fit-after-level1-fourth',suits:{D:{min:3,max:13}},hcp:{min:H>=15?15:12,max:H>=15?19:14},forcing:'nonforcing',publishWhenNative:true,convention:'course16-level1-fourth-forcing'};}
        else if(L.C>=5){target=H>=15&&L.C>=6?'3C':'2C';semantic={natural:true,source:'course16-opener-club-repeat-after-level1-fourth',suits:{C:{min:5,max:13}},hcp:{min:12,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-level1-fourth-forcing'};}
        if(target&&semantic&&legal(target)) return {call:target,changed:true,semantic,reason:`cours 16 : 1S quatrième forcing au palier de 1 ; PASS interdit, description ${target}`};
      }
    }

    // Cours 19 — weak canapé after 1H-1S-1NT.
    if(relHistory.length===8){
      const [open,p1,resp,p2,nt,p3,canape,p4]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course19-1H-1S-1NT-canape');
      const frame=open.seat===seat&&open.call==='1H'&&p1.call==='PASS'&&resp.seat===partner&&resp.call==='1S'&&p2.call==='PASS'&&nt.seat===seat&&nt.call==='1NT'&&p3.call==='PASS'&&canape.seat===partner&&canape.call==='2D'&&p4.call==='PASS'&&pm;
      if(frame){
        const target=L.D>=2?'PASS':L.S>=3?'2S':null;
        if(target&&legal(target)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course19-opener-after-weak-diamond-canape',suits:target==='PASS'?{D:{min:2,max:13}}:{S:{min:3,max:13}},hcp:{min:11,max:14},forcing:'nonforcing',publishWhenNative:true,convention:'course19-1H-1S-1NT-canape'},reason:target==='PASS'?'cours 19 : canapé faible, deux Carreaux suffisent pour jouer 2D':'cours 19 : misfit Carreau, retour à 2S avec trois Piques'};
      }
    }

    // Cours 30/28 — after 2D forcing to game, 2NT and Stayman, 3NT means
    // both majors; responder transfers to the chosen major and opener rectifies.
    if(relHistory.length===10){
      const [open,p1,ace,p2,nt,p3,stay,p4,ans,p5]=relHistory;
      if(open.seat===partner&&open.call==='2D'&&nt.seat===partner&&nt.call==='2NT'&&stay.seat===seat&&stay.call==='3C'&&ans.seat===partner&&ans.call==='3NT'&&p5.call==='PASS'){
        let target=null;
        if(L.H>=4&&L.S<4)target='4C'; else if(L.S>=4&&L.H<4)target='4D'; else if(L.H>=4&&L.S>=4)target=majorPreference(ctx.deal,seat,4,4)==='H'?'4C':'4D';
        if(target&&legal(target)) return {call:target,changed:raw!==target,semantic:{natural:false,source:'course30-responder-transfer-after-both-majors',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-2NT-both-majors-transfer'},reason:`cours 30/28 : 3SA montre les deux majeures ; ${target} transfère vers la majeure choisie`};
      }
    }
    if(relHistory.length===12){
      const [open,p1,ace,p2,nt,p3,stay,p4,ans,p5,tr,p6]=relHistory;
      if(open.seat===seat&&open.call==='2D'&&nt.seat===seat&&nt.call==='2NT'&&stay.call==='3C'&&ans.seat===seat&&ans.call==='3NT'&&p6.call==='PASS'){
        const pm=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course30-2D-2NT-both-majors-transfer');
        const target=pm?(tr.call==='4C'?'4H':tr.call==='4D'?'4S':null):null;
        if(target&&legal(target)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course30-opener-rectify-both-majors-transfer',forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-2NT-both-majors-transfer'},reason:`cours 30/28 : rectification automatique vers ${target}`};
      }
    }

    // Cours 16 — after an expensive fourth forcing and opener fallback, a
    // five-card responder major must be repeated; the partnership is game-forcing.
    if(relHistory.length===10&&raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call),rb=parseBid(resp.call),r2=parseBid(rebid.call),f4=parseBid(fourth.call),cb=parseBid(cont.call);
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set(), missing=SUITS.find(x=>!named.has(x));
      const expensive=rb&&f4&&missing&&f4.strain===missing&&bidRank(fourth.call)>=bidRank(`2${rb.strain}`);
      const fallbackMeaning=latestPartnerExplicitMeaning(ctx,m=>m.source==='course16-opener-fallback-after-fourth');
      const frame=open.seat===partner&&ob?.level===1&&p1.call==='PASS'&&resp.seat===seat&&rb?.level===1&&(rb.strain==='H'||rb.strain==='S')&&p2.call==='PASS'&&rebid.seat===partner&&r2&&r2.strain!=='NT'&&r2.strain!==rb.strain&&p3.call==='PASS'&&fourth.seat===seat&&f4&&p4.call==='PASS'&&cont.seat===partner&&cb&&p5.call==='PASS'&&expensive&&fallbackMeaning;
      if(frame&&L[rb.strain]>=5){
        const target=cheapestSuitCallAfter(history,rb.strain);
        if(target&&bidRank(target)<bidRank(`4${rb.strain}`)&&legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'course16-responder-five-major-after-fourth-fallback',suits:{[rb.strain]:{min:5,max:13}},hcp:{min:12,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},reason:`cours 16 : quatrième forcing chère ; après ${cont.call}, cinq ${rb.strain} => ${target} forcing`};
      }
    }

    // v2.44 — continuations manquantes après les réponses fortes de l'ouvreur
    // à la troisième forcing. Le journal sémantique a montré que PONS brut pouvait
    // encore PASSER sur ces enchères explicitement forcing.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,repeat,p3,third,p4,support,p5]=relHistory, partner=partnerOf(seat);
      const rb=parseBid(resp.call), sb=parseBid(support.call);
      const baseFrame=open.seat===partner&&p1.call==='PASS'&&resp.seat===seat&&rb?.level===1&&(rb.strain==='H'||rb.strain==='S')&&p2.call==='PASS'&&repeat.seat===partner&&p3.call==='PASS'&&third.seat===seat&&p4.call==='PASS'&&support.seat===partner&&p5.call==='PASS';
      if(baseFrame){
        const majorFit=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-major-support-after-third');
        if(majorFit && sb?.level===3 && sb.strain===rb.strain){
          const target=`4${rb.strain}`;
          if(legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'v244-course17-responder-game-after-strong-major-support',suits:{[rb.strain]:{min:4,max:13}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:`cours 17 : ${support.call} montre exactement trois atouts en zone forte ; le fit majeur est établi => ${target}`};
        }
        const diamondFit=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-strong-diamond-support-after-third');
        if(diamondFit && support.call==='3D' && L.D>=4 && legal('4D')) return {call:'4D',changed:true,semantic:{natural:true,source:'v244-course17-responder-diamond-fit-continuation',suits:{D:{min:4,max:13}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'cours 17 : 3D en zone forte est forcing ; avec quatre vrais Carreaux chez le répondant, 4D confirme le fit sans fermer artificiellement à 5D'};
        const otherMajor=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-other-major-after-third');
        if(otherMajor && L[rb.strain]>=5){
          const target=cheapestSuitCallAfter(history,rb.strain);
          if(target&&legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'v244-course17-responder-repeat-major-after-other-major',suits:{[rb.strain]:{min:5,max:13}},hcp:{min:10,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:`cours 17 : la nouvelle majeure de l'ouvreur est forcing ; cinq cartes dans la majeure du répondant => ${target}`};
        }
        // v2.45 — 1D-1S-2D-2H (3e forcing) puis 3C artificiel de l'ouvreur :
        // 3C est la quatrième couleur forcing de manche. Sur les cas 100K où PONS
        // voulait passer, cinq Piques se répètent économiquement à 3S ; avec quatre
        // Piques seulement mais un vrai arrêt Trèfle, 3SA est la conclusion naturelle.
        const lastSuitForce=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-last-suit-after-third' && m.forcing==='game_if_uncontested');
        const exactThirdFrame=open.call==='1D'&&resp.call==='1S'&&repeat.call==='2D'&&third.call==='2H'&&support.call==='3C';
        if(lastSuitForce && exactThirdFrame){
          if(L.S>=5 && legal('3S')) return {call:'3S',changed:true,semantic:{natural:true,source:'v245-course17-responder-3S-after-last-suit-force',suits:{S:{min:5,max:13}},hcp:{min:10,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'audit 100K v2.45 : 3C est la 4e couleur forcing après la 3e forcing ; cinq Piques => 3S'};
          if(L.S===4 && stopperScore(ctx.deal,seat,'C')>=0.7 && legal('3NT')) return {call:'3NT',changed:true,semantic:{natural:true,source:'v245-course17-responder-3NT-after-last-suit-force',suits:{S:{min:4,max:4}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'audit 100K v2.45 : 3C demande la tenue de la dernière couleur ; arrêt Trèfle présent => 3SA'};
        }
        const hiddenMinor=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-hidden-minor-bicolor-after-third' && m.forcing==='game_if_uncontested');
        if(hiddenMinor){
          // La réponse forte 3C après 1D-1S-2D-2H a engagé le camp à la manche.
          // Avec cinq Piques, la répétition est la continuation descriptive la plus
          // économique. Avec seulement quatre Piques mais un vrai fit Trèfle 4e,
          // 4C confirme le fit sans inventer un contrat à SA.
          if(L[rb.strain]>=5){
            const target=cheapestSuitCallAfter(history,rb.strain);
            if(target&&legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'v245-course17-responder-major-after-strong-hidden-minor',suits:{[rb.strain]:{min:5,max:13}},hcp:{min:10,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:`audit 100K v2.45 : 3C de l’ouvreur est une réponse forte forcing de manche ; ${L[rb.strain]} cartes ${rb.strain} => ${target}`};
          }
          if(L.C>=4 && legal('4C')) return {call:'4C',changed:true,semantic:{natural:true,source:'v245-course17-responder-club-fit-after-strong-hidden-minor',suits:{C:{min:4,max:13}},hcp:{min:10,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'audit 100K v2.45 : réponse forte 3C à la troisième forcing ; quatre Trèfles chez le répondant => fit 4C, le forcing de manche subsiste'};
        }
      }
    }

    // v2.45 — après 3C (4e couleur forcing) puis 3S du répondant avec 5+ S,
    // l'ouvreur ne peut pas passer : avec trois Piques il conclut à 4S ; sans fit,
    // un arrêt Trèfle permet 3SA. Sans arrêt, on laisse la séquence ouverte plutôt
    // que d'inventer un contrat final.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,repeat,p3,third,p4,last,p5,show,p6]=relHistory, partner=partnerOf(seat);
      const shown=latestPartnerExplicitMeaning(ctx,m=>m.source==='v245-course17-responder-3S-after-last-suit-force');
      const frame=open.seat===seat&&open.call==='1D'&&p1.call==='PASS'&&resp.seat===partner&&resp.call==='1S'&&p2.call==='PASS'&&repeat.seat===seat&&repeat.call==='2D'&&p3.call==='PASS'&&third.seat===partner&&third.call==='2H'&&p4.call==='PASS'&&last.seat===seat&&last.call==='3C'&&p5.call==='PASS'&&show.seat===partner&&show.call==='3S'&&p6.call==='PASS'&&shown;
      if(frame&&L.S>=3&&legal('4S')) return {call:'4S',changed:true,semantic:{natural:true,source:'v245-course17-opener-4S-after-3S',suits:{S:{min:3,max:13}},hcp:{min:14,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'audit 100K v2.45 : 3S montre 5+ Piques sous forcing de manche ; trois cartes chez l’ouvreur => 4S'};
      if(frame&&L.S<=2&&stopperScore(ctx.deal,seat,'C')>=0.7&&legal('3NT')) return {call:'3NT',changed:true,semantic:{natural:true,source:'v245-course17-opener-3NT-after-3S',suits:{S:{min:0,max:2}},hcp:{min:14,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'audit 100K v2.45 : pas de fit Pique, mais arrêt Trèfle après la 4e couleur forcing => 3SA'};
    }

    // Cours 17 — responder after opener's 3H support to third forcing.
    if(relHistory.length===10){
      const [open,p1,resp,p2,repeat,p3,third,p4,support,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call),rb=parseBid(resp.call),rep=parseBid(repeat.call),tf=parseBid(third.call),sb=parseBid(support.call);
      const supportMeaning=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-opener-heart-support-after-third');
      const frame=open.seat===partner&&ob?.level===1&&(ob.strain==='C'||ob.strain==='D')&&p1.call==='PASS'&&resp.seat===seat&&rb?.level===1&&(rb.strain==='H'||rb.strain==='S')&&p2.call==='PASS'&&repeat.seat===partner&&rep?.level===2&&rep.strain===ob.strain&&p3.call==='PASS'&&third.seat===seat&&tf?.level===2&&p4.call==='PASS'&&support.seat===partner&&sb?.level===3&&sb.strain==='H'&&p5.call==='PASS'&&supportMeaning;
      if(frame&&L.H<4&&L[rb.strain]>=5){const target=cheapestSuitCallAfter(history,rb.strain);if(target&&legal(target))return {call:target,changed:true,semantic:{natural:true,source:'v244-course17-responder-five-major-after-heart-support-third',suits:{[rb.strain]:{min:5,max:13},H:{min:0,max:3}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'cours 17 : 3H forcing ne crée pas un fit si le répondant n’a que trois Cœurs ; avec cinq cartes dans sa majeure, il la répète sous forcing'};}
      if(frame&&L.H<4&&L[rb.strain]===4&&balanced(L)&&legal('3NT'))return {call:'3NT',changed:raw!=='3NT',semantic:{natural:true,source:'v244-course17-responder-3NT-after-heart-support-third',suits:{H:{min:0,max:3},[rb.strain]:{min:4,max:4}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'cours 17 : 3H est forcing mais ne garantit pas le fit ; avec 4-3 dans les majeures et une main régulière, 3SA est la manche de repli'};
      if(frame&&L.H>=4&&legal('4H'))return {call:'4H',changed:true,semantic:{natural:true,source:'course17-responder-heart-game-after-heart-support-third',suits:{H:{min:4,max:13}},hcp:{min:10,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:'cours 17 : 3H après troisième forcing montre quatre Cœurs ; avec le fit, 4H'};
    }

    // Cours 17 — après 3H forcing de l'ouvreur puis répétition de la
    // majeure sixième du répondant, l'ouvreur doit atteindre la manche. Avec
    // deux cartes dans la majeure répétée, le fit 6-2 suffit pour conclure à 4M.
    if(relHistory.length===12&&raw==='PASS'){
      const [open,p1,resp,p2,repeat,p3,third,p4,support,p5,longMajor,p6]=relHistory, partner=partnerOf(seat);
      const lm=parseBid(longMajor.call);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='course17-responder-six-major-after-heart-support-third');
      const frame=open.seat===seat&&p1.call==='PASS'&&resp.seat===partner&&p2.call==='PASS'&&repeat.seat===seat&&p3.call==='PASS'&&third.seat===partner&&p4.call==='PASS'&&support.seat===seat&&support.call==='3H'&&p5.call==='PASS'&&longMajor.seat===partner&&lm?.level===3&&(lm.strain==='H'||lm.strain==='S')&&p6.call==='PASS'&&pm;
      if(frame&&L[lm.strain]>=2&&legal(`4${lm.strain}`)) return {call:`4${lm.strain}`,changed:true,semantic:{natural:true,source:'course17-opener-completes-six-major-after-third',suits:{[lm.strain]:{min:2,max:13}},hcp:{min:11,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:`cours 17 : ${longMajor.call} montre six cartes sous forcing de manche ; avec ${L[lm.strain]} cartes, conclusion à 4${lm.strain}`};
      // Si l'ouvreur n'a qu'un singleton dans la majeure sixième répétée, le camp est
      // néanmoins déjà forcing de manche : le fit 6-1 est le contrat majeur de repli
      // le plus sûr lorsque PONS voudrait s'arrêter à 3M. On ne généralise pas aux
      // chicanes, qui nécessitent une décision de contrat différente.
      if(frame&&L[lm.strain]===1&&legal(`4${lm.strain}`)) return {call:`4${lm.strain}`,changed:true,semantic:{natural:true,source:'course17-opener-seven-trump-major-game-after-third',suits:{[lm.strain]:{min:1,max:1}},hcp:{min:11,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:`cours 17 : ${longMajor.call} montre six cartes et la manche est forcée ; avec un singleton ${lm.strain}, repli à 4${lm.strain} plutôt que PASS`};
      // Avec une chicane dans la majeure sixieme, ne pas fabriquer un fit 6-0.
      // Lorsque l'ouvreur a repete une mineure au moins sixieme, le contrat de
      // manche naturel de repli est 5m.
      const openingBid=parseBid(open.call);
      if(frame&&L[lm.strain]===0&&openingBid&&(openingBid.strain==='C'||openingBid.strain==='D')&&L[openingBid.strain]>=6){
        const target=`5${openingBid.strain}`;
        if(legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'course17-opener-minor-game-with-void-major-after-third',suits:{[openingBid.strain]:{min:6,max:13},[lm.strain]:{min:0,max:0}},hcp:{min:11,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:`cours 17 : majeure sixieme du repondant mais chicane chez l'ouvreur ; forcing de manche => ${target} avec la mineure 6e`};
      }
    }

    // Cours 24 — diamond fit and controls after the forcing 3C minor bicolor.
    if(relHistory.length===8){
      const [open,over,dbl,p1,bicolor,p2,fit,p3]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course24-responder-diamond-fit-after-forcing-minor-bicolor-no-stopper');
      const frame=open.seat===seat&&open.call==='1D'&&over.call==='1S'&&dbl.seat===partner&&dbl.call==='X'&&p1.call==='PASS'&&bicolor.seat===seat&&bicolor.call==='3C'&&p2.call==='PASS'&&fit.seat===partner&&fit.call==='4D'&&p3.call==='PASS'&&pm;
      if(frame){
        let target='5D',forcing='nonforcing',source='course24-opener-diamond-game-after-forcing-minor-bicolor';
        if(H>=17){const hc=String(ctx.deal?.hands?.[seat]?.H||''),sc=String(ctx.deal?.hands?.[seat]?.S||'');const hCtl=hc.length<=1||/[AK]/.test(hc),sCtl=sc.length<=1||/[AK]/.test(sc);if(hCtl){target='4H';forcing='one_round_if_uncontested';source='course24-opener-control-after-diamond-fit';}else if(sCtl){target='4S';forcing='one_round_if_uncontested';source='course24-opener-control-after-diamond-fit';}}
        if(legal(target))return {call:target,changed:raw!==target,semantic:{natural:target==='5D',source,suits:{D:{min:5,max:13}},hcp:{min:16,max:37},forcing,publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor'},reason:target==='5D'?'cours 24 : fit Carreau établi sous forcing de manche => 5D minimum':`cours 24 : fit Carreau et main forte => contrôle ${target}`};
      }
    }
    if(relHistory.length===10){
      const [open,over,dbl,p1,bicolor,p2,fit,p3,cue,p4]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course24-opener-control-after-diamond-fit');
      const frame=open.seat===partner&&open.call==='1D'&&over.call==='1S'&&dbl.seat===seat&&dbl.call==='X'&&p1.call==='PASS'&&bicolor.seat===partner&&bicolor.call==='3C'&&p2.call==='PASS'&&fit.seat===seat&&fit.call==='4D'&&p3.call==='PASS'&&cue.seat===partner&&(cue.call==='4H'||cue.call==='4S')&&p4.call==='PASS'&&pm;
      if(frame){let target='5D',isCue=false;const candidates=cue.call==='4H'?[['S','4S'],['C','5C']]:[['C','5C']];for(const [suit,call] of candidates){const cards=String(ctx.deal?.hands?.[seat]?.[suit]||'');const ctl=cards.length<=1||/[AK]/.test(cards);if(ctl&&legal(call)){target=call;isCue=true;break;}}if(legal(target))return {call:target,changed:raw!==target,semantic:{natural:!isCue,source:isCue?'course24-responder-next-control-after-diamond-fit':'course24-responder-diamond-signoff-after-controls',suits:{D:{min:3,max:13}},hcp:{min:8,max:37},forcing:isCue?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course24-1D-spoutnik-minor-bicolor'},reason:isCue?`cours 24 : contrôle suivant ${target}`:'cours 24 : aucun contrôle suivant utile => 5D'};}
    }

    // Cours 17 — extreme club length is enough to make the natural low-zone
    // repeat after third forcing; don't invent a game force with the last suit.
    if(relHistory.length===8&&raw==='PASS'&&H>=11&&H<=13&&L.C>=8){
      const [open,p1,resp,p2,rebid,p3,third,p4]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat&&open.call==='1C'&&p1.call==='PASS'&&resp.seat===partner&&(resp.call==='1H'||resp.call==='1S')&&p2.call==='PASS'&&rebid.seat===seat&&rebid.call==='2C'&&p3.call==='PASS'&&third.seat===partner&&third.call==='2D'&&p4.call==='PASS';
      if(frame&&legal('3C'))return {call:'3C',changed:true,semantic:{natural:true,source:'course17-opener-eight-card-club-repeat-after-third',suits:{C:{min:8,max:13}},hcp:{min:11,max:13},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},reason:`cours 17 : zone 11/13 H et ${L.C} Trèfles => 3C naturel non forcing`};
    }

    // Cours 15 — troisième enchère du répondant après acceptation de 2SA.
    if(relHistory.length===10){
      const [open,p1,resp,p2,rebid,p3,cont,p4,fitTry,p5]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call);
      const clean=open.seat===partner && p1.call==='PASS' && resp.seat===seat && p2.call==='PASS' && rebid.seat===partner && p3.call==='PASS' && cont.seat===seat && p4.call==='PASS' && fitTry.seat===partner && p5.call==='PASS' &&
        ob?.level===1 && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && r2?.level===2 && (r2.strain==='C'||r2.strain==='D');
      const economic=clean && ((ob.strain==='H'&&rb.strain==='S')||(ob.strain==='D'&&r2.strain==='C'));
      if(economic && cont.call==='2NT' && fitTry.call===`3${rb.strain}`){
        const target=L[rb.strain]>=5?`4${rb.strain}`:'3NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:raw!==target,
          semantic:{natural:true,source:L[rb.strain]>=5?'course15-responder-accepts-5-3-major-after-2NT':'course15-responder-returns-3NT-after-2NT-fit-check',suits:L[rb.strain]>=5?{[rb.strain]:{min:5,max:13}}:{[rb.strain]:{min:4,max:4}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course15-notrump'},
          reason:L[rb.strain]>=5?`cours 15 : 3${rb.strain} de l'ouvreur accepte la manche et montre trois cartes ; cinq cartes chez le répondant => 4${rb.strain}`:`cours 15 : 3${rb.strain} vérifie un éventuel fit 5-3 ; avec seulement quatre cartes, retour à 3SA`
        };
      }
    }

    // Cours 18/19 — cadre après une redemande de l'ouvreur à 1SA.
    // Le cours donne ici des zones et des enchères extrêmement structurées :
    // - le Roudi 2C avec une majeure cinquième et au moins un espoir de manche ;
    // - les arrêts directs à 2M / 4M avec une majeure longue ;
    // - les zones quantitatives à Sans-Atout quand aucun fit majeur ne reste à rechercher.
    // On ne couvre volontairement que les séquences non compétitives 1m-1M-1SA
    // et le cas particulier 1H-1S-1SA documenté dans le cours 19.
    if(relHistory.length===6){
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call);
      const clean=p1.call==='PASS'&&p2.call==='PASS'&&p3.call==='PASS' && open.seat===partner && resp.seat===seat && rebid.seat===partner;
      const minorFrame=clean && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && rebid.call==='1NT';
      const heartSpadeFrame=clean && open.call==='1H' && resp.call==='1S' && rebid.call==='1NT';
      if(minorFrame || heartSpadeFrame){
        const major=rb.strain, otherMajor=major==='H'?'S':'H', HL=hlPoints(ctx.deal,seat), HLD=supportHld(ctx.deal,seat,major);
        let target=null, semantic=null, reason='';

        // Cours 19 : après 1H-1S-1SA, la réponse initiale de 1S avec un vrai
        // fit quatrième à Cœur provient d'une main forte. Une fois l'ouvreur limité à
        // 12-14 H, 4H conclut la manche ; avec une vraie zone de chelem, 3H est forcing.
        if(heartSpadeFrame && L.S>=4 && L.H>=4){
          const heartFitHld=supportHld(ctx.deal,seat,'H');
          if(heartFitHld>=18){
            target='3H';
            semantic={natural:true,source:'course19-direct-strong-heart-support-after-1H-1S-1NT',suits:{S:{min:4,max:13},H:{min:4,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-delayed-heart-fit'};
            reason=`cours 19 : après 1H-1S-1SA, fit quatrième à Cœur et ${heartFitHld} HLD => 3H forcing, ambition de chelem`;
          } else if(heartFitHld>=13){
            target='4H';
            semantic={natural:true,source:'course19-direct-heart-game-after-1H-1S-1NT',suits:{S:{min:4,max:13},H:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course19-delayed-heart-fit'};
            reason=`cours 19 : après 1H-1S-1SA, fit quatrième à Cœur et ouvreur limité => conclusion à 4H`;
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
        target=null; semantic=null; reason='';
        // Cours 19 : cas particulier 1H-1S-1SA. Avec une main faible et
        // exactement deux Cœurs, le retour à 2H est une préférence d'arrêt ;
        // l'enchère canapé 2D avec quatre Piques et six Carreaux reste prioritaire.
        if(heartSpadeFrame && L.S>=4 && L.S<=5 && L.H===2 && HL<=10 && L.D<6){
          target='2H';
          semantic={natural:true,source:'course19-direct-heart-preference-after-1H-1S-1NT',suits:{S:{min:4,max:5},H:{min:2,max:2}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course19-heart-preference'};
          reason=`cours 19 : après 1H-1S-1SA, deux Cœurs et ${HL} HL => préférence d'arrêt à 2H`;
        // Cours 19 : après 1H-1S-1SA, 2D peut être une enchère canapé de faiblesse,
        // montrant quatre Piques seulement et de très longs Carreaux.
        } else if(heartSpadeFrame && L.S===4 && L.D>=6 && HL<=10){
          target='2D';
          semantic={natural:true,source:'course19-canape-diamonds-after-1H-1S-1NT',suits:{S:{min:4,max:4},D:{min:6,max:13}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course19-1H-1S-1NT-canape'};
          reason=`cours 19 : quatre Piques mais ${L.D} Carreaux et ${HL} HL => 2D canapé, contrat de repli`;
        // Cours 19 — après 1m-1S-1SA, le bicolore majeur faible doit chercher
        // le meilleur contrat partiel : 2H montre au moins cinq Piques et quatre
        // Cœurs, sans ambition de manche. Cette règle est prioritaire sur le STOP 2S.
        } else if(minorFrame && major==='S' && L.S>=5 && L.H>=4 && HL<=10){
          target='2H';
          semantic={natural:true,source:'course19-weak-major-bicolor-after-1NT',suits:{S:{min:5,max:13},H:{min:4,max:13}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course19-major-bicolor'};
          reason=`cours 19 : ${L.S} Piques et ${L.H} Cœurs, ${HL} HL sans ambition de manche => 2H, recherche du meilleur partiel`;
        // Cours 19, tableau après 1D-1S-1SA : 3C décrit cinq Piques et
        // cinq Trèfles forcing de manche. 3D décrit quatre Piques et au moins cinq
        // Carreaux dans une main forte où la mineure mérite d'être mise en avant.
        // Pour 3D on ne couvre que les distributions clairement irrégulières/fortes.
        } else if(minorFrame && ob.strain==='D' && major==='S' && L.S>=5 && L.C>=5 && L.H<=3 && HL>=12){
          target='3C';
          semantic={natural:true,source:'course19-direct-spade-club-game-force-after-1NT',suits:{S:{min:5,max:13},C:{min:5,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-after-1NT'};
          reason=`cours 19 : après 1D-1S-1SA, ${L.S} Piques et ${L.C} Trèfles avec valeurs de manche => 3C forcing de manche`;
        } else if(minorFrame && ob.strain==='D' && major==='S' && L.S===4 && L.D>=5 && HL>=12 && (Math.min(L.H,L.C)<=1 || HL>=15)){
          target='3D';
          semantic={natural:true,source:'course19-direct-diamond-game-force-after-1NT',suits:{S:{min:4,max:4},D:{min:5,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-after-1NT'};
          reason=`cours 19 : après 1D-1S-1SA, quatre Piques et ${L.D} Carreaux dans une main forte/irrégulière => 3D forcing de manche`;
        // Avec un 5-5 majeur, le cours raisonne en perdantes : six perdantes
        // environ imposent la manche par 4H ; cinq perdantes ou moins justifient
        // l'essai de chelem à 3H. Avec sept perdantes, on passe par le Roudi.
        } else if(minorFrame && major==='S' && L.S>=5 && L.H>=5 && HL>10){
          const losers=losingTricks(ctx.deal,seat);
          if(losers<=5){
            target='3H';
            semantic={natural:true,source:'course19-major-55-slam-try',suits:{S:{min:5,max:13},H:{min:5,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-major-bicolor'};
            reason=`cours 19 : bicolore majeur 5-5, ${losers} perdantes => 3H, ambition de chelem`;
          } else if(losers<=6){
            target='4H';
            semantic={natural:true,source:'course19-major-55-game-choice',suits:{S:{min:5,max:13},H:{min:5,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course19-major-bicolor'};
            reason=`cours 19 : bicolore majeur 5-5, ${losers} perdantes => 4H, choix de manche sans ambition de chelem`;
          } else {
            target='2C';
            semantic={natural:false,source:'course19-major-55-invite-via-roudi',suits:{S:{min:5,max:13},H:{min:5,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course18-roudi'};
            reason=`cours 19 : bicolore majeur 5-5 avec environ ${losers} perdantes => Roudi avant de proposer la manche`;
          }
        // Les replis mineurs documentés ont également priorité sur 2S : soutien
        // faible à Carreau après 1D, ou 5-5 Pique-Carreau faible après 1C.
        } else if(minorFrame && major==='S' && ob.strain==='D' && L.D>=4 && HL<=10 && !balanced(L)){
          target='2D';
          semantic={natural:true,source:'course19-weak-diamond-support-after-1NT',suits:{D:{min:4,max:13},S:{min:4,max:13}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course19-minor-partscore'};
          reason=`cours 19 : quatre Carreaux ou plus, main faible irrégulière => soutien différé 2D plutôt que 1SA`;
        } else if(minorFrame && major==='S' && ob.strain==='C' && L.S>=5 && L.D>=5 && HL<=10){
          target='2D';
          semantic={natural:true,source:'course19-weak-spade-diamond-55-after-1C',suits:{S:{min:5,max:13},D:{min:5,max:13}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course19-minor-partscore'};
          reason=`cours 19 : 5-5 Pique-Carreau faible après 1C-1S-1SA => 2D, meilleur contrat partiel`;
        } else if(L[major]>=6 && HL>=17){
          target=`3${major}`;
          semantic={natural:true,source:'course18-six-major-slam-try-after-1NT',suits:{[major]:{min:6,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course18-major-slam-try'};
          reason=`cours 18 : majeure ${major} sixième et ${HL} HL => répétition à saut forcing, ambition de chelem`;
        } else if(L[major]>=6 && HL>=13 && HL<=16){
          target=`4${major}`;
          semantic={natural:true,source:'course18-six-major-direct-game-after-1NT',suits:{[major]:{min:6,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-major-game-stop'};
          reason=`cours 18 : majeure ${major} sixième, ${HL} HL sans ambition de chelem => conclusion à 4${major}`;
        } else if(L[major]>=5 && HLD<11){
          target=`2${major}`;
          semantic={natural:true,source:'course18-major-partscore-stop-after-1NT',suits:{[major]:{min:5,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-major-partscore-stop'};
          reason=`cours 18 : ${L[major]} cartes à ${major} et moins de 11 HLD => 2${major} STOP`;
        } else {
          const sideLong=SUITS.some(s=>s!==major && L[s]>=5);
          const roudiPlus=(HL>=11) || (H>=9 && H<=10 && ob && L[ob.strain]>=4 && !balanced(L));
          if(L[major]>=5 && roudiPlus && !sideLong){
            target='2C';
            semantic={natural:false,source:'course18-roudi-after-opener-1NT',suits:{[major]:{min:5,max:13}},hcp:{min:9,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course18-roudi'};
            reason=`cours 18 : majeure ${major} au moins cinquième avec espoir de manche => Roudi 2C`;
          } else {
            // Anti-régression v2.33 : après 1H-1S-1SA, un répondant de manche avec
            // trois Cœurs connaît le fit 5-3. La branche quantitative ne doit pas
            // l'envoyer mécaniquement à 3SA en oubliant le fit majeur.
            if(open.call==='1H' && major==='S' && L.H>=3 && HL>=12 && legal('4H')){
              target='4H';
              semantic={natural:true,source:'v233-delayed-heart-fit-after-1H-1S-1NT',suits:{H:{min:3,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-delayed-major-fit'};
              reason=`anti-régression v2.3 : après 1H-1S-1SA, ${L.H} Cœurs et ${HL} HL => priorité au fit 5-3, 4H`;
            }
            const noFiveMajor=L.H<=4&&L.S<=4;
            const noOtherMajorSearch=L[otherMajor]<=3;
            const strongMinorFit=minorFrame && L[ob.strain]>=5 && HL>=12;
            if(!target && noFiveMajor && noOtherMajorSearch && balanced(L) && !strongMinorFit){
              if(HL<=10){
                target='PASS';
                semantic={natural:true,source:'course18-1NT-responder-quant-pass',hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course18-1NT-quantitative'};
                reason=`cours 18 : main régulière/semi-régulière sans majeure cinquième, ${HL} HL => passe sur 1SA`;
              } else if(HL===11){
                target='2NT';
                semantic={natural:true,source:'course18-1NT-responder-quant-2NT',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-1NT-quantitative'};
                reason='cours 18 : 11 HL réguliers => proposition quantitative à 2SA';
              } else if(HL>=12 && HL<=18){
                target='3NT';
                semantic={natural:true,source:'course18-1NT-responder-quant-3NT',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-1NT-quantitative'};
                reason=`cours 18 : ${HL} HL réguliers sans majeure cinquième => conclusion à 3SA`;
              } else if(HL>=19 && HL<=20){
                target='4NT';
                semantic={natural:true,source:'course18-1NT-responder-quant-4NT',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-1NT-quantitative'};
                reason=`cours 18 : ${HL} HL réguliers => proposition quantitative de chelem à 4SA`;
              } else if(HL>=21 && HL<=23){
                target='6NT';
                semantic={natural:true,source:'course18-1NT-responder-quant-6NT',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-1NT-quantitative'};
                reason=`cours 18 : ${HL} HL réguliers => conclusion à 6SA`;
              }
            }
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }

    // Cours 18 — réponse de l'ouvreur au Roudi. 2D dénie trois cartes dans la
    // majeure ; avec trois cartes, 2H montre le minimum et 2S le maximum.
    if(relHistory.length===8){
      const [open,p1,resp,p2,rebid,p3,roudi,p4]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D'||open.call==='1H') && p1.call==='PASS' &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
        p3.call==='PASS' && roudi.seat===partner && roudi.call==='2C' && p4.call==='PASS';
      if(frame){
        const major=rb.strain; let target='2D';
        if(L[major]>=3) target=H>=14?'2S':'2H';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
          return {
            call:target,changed:raw!==target,
            semantic:{natural:false,source:'course18-roudi-opener-answer',suits:{[major]:{min:L[major]>=3?3:0,max:L[major]>=3?13:2}},hcp:{min:12,max:14},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-answer'},
            reason:L[major]>=3?`cours 18 : Roudi, fit ${major} troisième et ${H} H => ${target} (${H>=14?'maximum':'minimum'})`:`cours 18 : Roudi, pas de fit troisième à ${major} => 2D`
          };
        }
      }

      // Cours 18 : lorsqu'un répondant faible a conclu à 2M sur la redemande 1SA,
      // l'enchère est un arrêt absolu ; l'ouvreur doit passer même avec trois cartes.
      const weakStop=open.seat===seat && p1.call==='PASS' && resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call===`2${rb.strain}` && p4.call==='PASS';
      if(weakStop){
        return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course18-opener-respects-2M-stop',forcing:'nonforcing',publishWhenNative:true,convention:'course18-major-partscore-stop'},reason:`cours 18 : 2${rb.strain} après 1SA est un STOP ; l'ouvreur doit passer`};
      }
      // Cours 19 : les enchères directes 3C/3D après 1D-1S-1SA sont
      // forcing de manche. PONS brut peut pourtant vouloir passer immédiatement.
      // On répond d'abord au fit majeur si 3C a montré 5 Piques, sinon on soutient
      // la mineure au palier de 4 quand le fit est certain, et 3SA reste le refuge.
      const directMinorGF=open.seat===seat && open.call==='1D' && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && (roudi.call==='3C'||roudi.call==='3D') && p4.call==='PASS';
      if(directMinorGF && raw==='PASS'){
        let target=null;
        if(roudi.call==='3C') target=L.S>=3?'4S':(L.C>=3?'4C':'3NT');
        else target=L.S>=4?'4S':'4D';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          const shown=target==='4S'?{S:{min:roudi.call==='3C'?3:4,max:13}}:target==='4C'?{C:{min:3,max:13}}:target==='4D'?{D:{min:4,max:13}}:{};
          return {call:target,changed:true,semantic:{natural:true,source:'course19-opener-after-direct-minor-game-force',suits:shown,hcp:{min:0,max:37},forcing:(target==='3NT'||target==='4S')?'nonforcing':'game_if_uncontested',publishWhenNative:true,convention:'course19-after-1NT'},reason:`cours 19 : ${roudi.call} est forcing de manche ; PASS interdit => ${target}`};
        }
      }

      const heartPreference=open.seat===seat && open.call==='1H' && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' &&
        p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call==='2H' && p4.call==='PASS';
      if(heartPreference){
        return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course19-opener-respects-heart-preference',forcing:'nonforcing',publishWhenNative:true,convention:'course19-heart-preference'},reason:'cours 19 : 2H après 1H-1S-1SA est une préférence d’arrêt ; l’ouvreur doit passer'};
      }
      const directHeartGame=open.seat===seat && open.call==='1H' && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call==='4H' && p4.call==='PASS';
      if(directHeartGame) return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course19-opener-respects-direct-heart-game',forcing:'nonforcing',publishWhenNative:true,convention:'course19-delayed-heart-fit'},reason:'cours 19 : 4H après 1H-1S-1SA est une conclusion de manche ; l’ouvreur passe'};
      const directHeartSlamTry=open.seat===seat && open.call==='1H' && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call==='3H' && p4.call==='PASS';
      if(directHeartSlamTry && raw==='PASS' && (!ctx.isLegal||ctx.isLegal(history,'4H',seat))) return {call:'4H',changed:true,semantic:{natural:true,source:'course19-opener-minimum-after-direct-heart-slam-try',suits:{H:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'course19-delayed-heart-fit'},reason:'cours 19 : 3H différé est forcing et orienté chelem ; PASS interdit, minimum 4H'};

      // Cours 19 — réaction de l'ouvreur aux enchères directes du répondant après
      // 1m-1S-1SA. Sur 2H faible il passe avec quatre Cœurs et revient sinon à 2S.
      // Les replis faibles à 2D sont des choix de contrat et doivent être respectés.
      // Sur 4H avec un 5-5 majeur, il choisit simplement entre les deux manches.
      const direct19=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && p4.call==='PASS';
      if(direct19 && roudi.call==='2H'){
        const target=L.H>=4?'PASS':'2S';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course19-opener-after-weak-2H',suits:{H:{min:L.H>=4?4:0,max:L.H>=4?13:3}},forcing:'nonforcing',publishWhenNative:true,convention:'course19-major-bicolor'},reason:L.H>=4?'cours 19 : sur 2H faible avec quatre Cœurs, l’ouvreur passe':'cours 19 : sur 2H faible sans quatre Cœurs, retour obligatoire à 2S'};
      }
      if(direct19 && roudi.call==='2D'){
        return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course19-opener-respects-weak-2D',forcing:'nonforcing',publishWhenNative:true,convention:'course19-minor-partscore'},reason:'cours 19 : 2D faible après 1m-1S-1SA est un choix de contrat ; l’ouvreur respecte le repli'};
      }
      if(direct19 && roudi.call==='4H'){
        const target=L.H>=3?'PASS':'4S';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course19-opener-chooses-major-game',forcing:'nonforcing',publishWhenNative:true,convention:'course19-major-bicolor'},reason:L.H>=3?'cours 19 : 4H propose le choix de manche et l’ouvreur est fitté Cœur':'cours 19 : 4H propose le choix ; sans fit Cœur, l’ouvreur rectifie à 4S'};
      }
      // 3H est une ambition de chelem et ne peut être passée sous la manche. On ne
      // remplace aucune enchère PONS non-PASS ; si PONS veut passer, on choisit la
      // manche dans la meilleure des deux majeures connues cinquièmes du répondant.
      if(direct19 && roudi.call==='3H' && raw==='PASS'){
        const target=L.H>=3?'4H':'4S';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:true,semantic:{natural:true,source:'course19-opener-minimum-after-3H-slam-try',forcing:'nonforcing',publishWhenNative:true,convention:'course19-major-bicolor'},reason:`cours 19 : 3H avec un 5-5 majeur est forcing jusqu’à la manche ; PASS interdit, minimum ${target}`};
      }
    }

    // Cours 19 — après Roudi-2D puis 3m naturel forcing de manche, l'ouvreur
    // ne peut pas passer. Avec un vrai fit mineur, il le confirme au palier de 4 ;
    // sinon 3SA reste le contrat économique lorsqu'il est légal. Le palier de 4
    // reste forcing par héritage de l'enchère 3m.
    if(relHistory.length===12 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,side,p6]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), sm=parseBid(side.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D'||open.call==='1H') && p1.call==='PASS' &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
        p3.call==='PASS' && roudi.seat===partner && roudi.call==='2C' && p4.call==='PASS' && answer.seat===seat && answer.call==='2D' &&
        p5.call==='PASS' && side.seat===partner && sm?.level===3 && (sm.strain==='C'||sm.strain==='D') && p6.call==='PASS';
      if(frame){
        let target=null;
        if(L[sm.strain]>=3) target=`4${sm.strain}`;
        else if(!ctx.isLegal||ctx.isLegal(history,'3NT',seat)) target='3NT';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course19-opener-continues-side-minor-game-force',suits:target==='3NT'?{}:{[sm.strain]:{min:3,max:13}},hcp:{min:11,max:14},forcing:target==='3NT'?'nonforcing':'unknown',publishWhenNative:true,convention:'course19-roudi-development'},
          reason:`cours 19 : 3${sm.strain} après Roudi-2D est forcing de manche ; PASS interdit => ${target}`
        };
      }
    }

    // Cours 19 — après Roudi-2D puis saut forcing de manche dans l'autre majeure
    // (5 cartes dans la majeure initiale, 4+ dans l'autre), l'ouvreur doit choisir
    // la manche : 4M' avec quatre cartes, sinon 3SA. Ce garde ferme un PASS natif
    // sans modifier une action PONS non-PASS.
    if(relHistory.length===12 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,side,p6]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), sb=parseBid(side.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D'||open.call==='1H') && p1.call==='PASS' &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
        p3.call==='PASS' && roudi.seat===partner && roudi.call==='2C' && p4.call==='PASS' && answer.seat===seat && answer.call==='2D' &&
        p5.call==='PASS' && side.seat===partner && sb?.level===3 && rb.strain==='H' && sb.strain==='S' && p6.call==='PASS';
      if(frame){
        const target=L[sb.strain]>=4?`4${sb.strain}`:'3NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:true,semantic:{natural:true,source:'course19-opener-closes-other-major-game-force',suits:target==='3NT'?{}:{[sb.strain]:{min:4,max:13}},hcp:{min:11,max:14},forcing:'nonforcing',publishWhenNative:true,convention:'course19-roudi-development'},reason:`cours 19 : 3${sb.strain} après Roudi-2D est forcing de manche ; PASS interdit => ${target}`};
      }
    }

    // Si l'ouvreur a confirmé le fit à 4m dans la branche précédente et que PONS
    // voudrait ensuite s'arrêter, la manche mineure est le minimum du processus FM.
    if(relHistory.length===14 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,side,p6,fit,p7]=relHistory, partner=partnerOf(seat);
      const rb=parseBid(resp.call), sm=parseBid(side.call), fb=parseBid(fit.call);
      const frame=open.seat===partner && p1.call==='PASS' && resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        rebid.seat===partner && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===seat && roudi.call==='2C' && p4.call==='PASS' &&
        answer.seat===partner && answer.call==='2D' && p5.call==='PASS' && side.seat===seat && sm?.level===3 && (sm.strain==='C'||sm.strain==='D') &&
        p6.call==='PASS' && fit.seat===partner && fb?.level===4 && fb.strain===sm.strain && p7.call==='PASS';
      if(frame){
        const target=`5${sm.strain}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course19-responder-completes-side-minor-game-force',suits:{[sm.strain]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course19-roudi-development'},
          reason:`cours 19 : 3${sm.strain} était forcing de manche ; après 4${sm.strain}, PASS interdit => 5${sm.strain} minimum`
        };
      }
    }

    // Cours 15 : après le soutien forcing de manche à 3D, un retour de
    // l'ouvreur à 4D n'est qu'une étape. Si le répondant brut veut passer, la
    // manche mineure à 5D constitue le minimum du processus forcing.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,gf,p4,support,p5]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner && open.call==='1D' && p1.call==='PASS' && resp.seat===seat && (resp.call==='1H'||resp.call==='1S') && p2.call==='PASS' && rebid.seat===partner && rebid.call==='2C' && p3.call==='PASS' && gf.seat===seat && gf.call==='3D' && p4.call==='PASS' && support.seat===partner && support.call==='4D' && p5.call==='PASS';
      if(frame && (!ctx.isLegal||ctx.isLegal(history,'5D',seat))) return {call:'5D',changed:true,semantic:{natural:true,source:'course15-responder-completes-diamond-game-force',suits:{D:{min:3,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course15-minor-fit'},reason:'cours 15 : 3D était forcing de manche ; après 4D, PASS interdit => 5D minimum'};
    }

    // Cours 19 : si l'ouvreur a soutenu au palier de 4 la mineure montrée
    // par une enchère directe forcing de manche, le répondant ne peut s'arrêter là.
    // En cas de PASS brut, le minimum naturel est la manche dans la mineure.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,gf,p4,support,p5]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner && open.call==='1D' && p1.call==='PASS' && resp.seat===seat && resp.call==='1S' && p2.call==='PASS' && rebid.seat===partner && rebid.call==='1NT' && p3.call==='PASS' && gf.seat===seat && (gf.call==='3C'||gf.call==='3D') && p4.call==='PASS' && support.seat===partner && support.call===`4${gf.call.slice(1)}` && p5.call==='PASS';
      if(frame){const target=`5${gf.call.slice(1)}`; if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:true,semantic:{natural:true,source:'course19-responder-completes-minor-game-force',suits:{[gf.call.slice(1)]:{min:5,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course19-after-1NT'},reason:`cours 19 : soutien de ${gf.call} forcing de manche au palier de 4 ; PASS interdit => ${target}`};}
    }

    // Cours 18/19 — réponse de l'ouvreur à la répétition à saut 3M après 1SA.
    // Le cours définit 3M comme une exploration de chelem à partir de 17 HL. Cela
    // vaut aussi pour le cas particulier 1H-1S-1SA. Avec un bon fit (honneur second
    // ou troisième), l'ouvreur montre un contrôle disponible avant 4M ; sinon 4M
    // constitue le minimum sûr.
    if(relHistory.length===8 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3,slam,p4]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), sb=parseBid(slam.call);
      const openingFrame=ob?.level===1 && ((ob.strain==='C'||ob.strain==='D') || (ob.strain==='H'&&rb?.strain==='S'));
      const frame=open.seat===seat && openingFrame && p1.call==='PASS' &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && slam.seat===partner &&
        sb?.level===3 && sb.strain===rb.strain && p4.call==='PASS';
      if(frame){
        const trumpCards=String(ctx.deal?.hands?.[seat]?.[rb.strain]||'');
        const goodFit=L[rb.strain]>=2 && /[AKQJ]/.test(trumpCards);
        let target=`4${rb.strain}`, source='course18-opener-minimum-after-major-slam-try', forcing='nonforcing';
        if(goodFit){
          const controls=SUITS.filter(suit=>suit!==rb.strain).map(suit=>{
            const cards=String(ctx.deal?.hands?.[seat]?.[suit]||'');
            const control=cards.length<=1 || /[AK]/.test(cards);
            return {suit,control,call:`4${suit}`};
          }).filter(x=>x.control && bidRank(x.call)>bidRank(slam.call) && bidRank(x.call)<bidRank(`4${rb.strain}`)).sort((a,b)=>bidRank(a.call)-bidRank(b.call));
          if(controls.length){target=controls[0].call;source='course18-opener-control-after-major-slam-try';forcing='one_round_if_uncontested';}
        }
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:target===`4${rb.strain}`,source,suits:{[rb.strain]:{min:goodFit?2:0,max:13}},hcp:{min:11,max:17},forcing,publishWhenNative:true,convention:'course18-major-slam-try-response'},
          reason:target===`4${rb.strain}`?`cours 18 : 3${rb.strain} après 1SA est forcing ; sans contrôle positif à montrer => 4${rb.strain}`:`cours 18 : bon fit à ${rb.strain} (honneur second/troisième) => contrôle ${target}`
        };
      }
    }

    // Cours 18 — continuation des contrôles après 3M fort. Une enchère de contrôle
    // positive de l'ouvreur oblige le répondant à reparler. On poursuit dans l'ordre
    // économique des contrôles ; si un contrôle nécessaire manque, retour à 4M.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,slam,p4,control,p5]=relHistory, partner=partnerOf(seat);
      const rb=parseBid(resp.call), sb=parseBid(slam.call), cb=parseBid(control.call);
      const frame=open.seat===partner && p1.call==='PASS' && resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        rebid.seat===partner && rebid.call==='1NT' && p3.call==='PASS' && slam.seat===seat && sb?.level===3 && sb.strain===rb.strain && p4.call==='PASS' &&
        control.seat===partner && cb?.level===4 && cb.strain!==rb.strain && p5.call==='PASS';
      if(frame){
        const controlOrder=rb.strain==='H'?['C','D','S']:['C','D','H'];
        const idx=controlOrder.indexOf(cb.strain);
        let target=`4${rb.strain}`, isCue=false;
        if(idx>=0){
          for(const suit of controlOrder.slice(idx+1)){
            const cards=String(ctx.deal?.hands?.[seat]?.[suit]||'');
            const has=cards.length<=1 || /[AK]/.test(cards);
            const call=`4${suit}`;
            if(has && bidRank(call)>bidRank(control.call) && bidRank(call)<bidRank(`4${rb.strain}`)+(rb.strain==='H'&&suit==='S'?5:0)){
              // Pour un fit Cœur, 4S est aussi un contrôle au-delà de la manche.
              if(rb.strain==='H' && suit==='S'){ target='4S'; isCue=true; break; }
              if(bidRank(call)<bidRank(`4${rb.strain}`)){ target=call; isCue=true; break; }
            }
          }
        }
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:!isCue,source:isCue?'course18-responder-next-control-after-slam-try':'course18-responder-signoff-after-control-gap',suits:{[rb.strain]:{min:6,max:13}},hcp:{min:0,max:37},forcing:isCue?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course18-major-slam-try-response'},
          reason:isCue?`cours 18 : contrôle ${control.call} reçu ; contrôle suivant ${target}`:`cours 18 : aucun contrôle suivant utile après ${control.call} => retour à 4${rb.strain}`
        };
      }
    }

    // Cours 18 — à l'atout Pique, si l'ouvreur a commencé les contrôles par 4D,
    // il a sauté 4C et donc dénié le contrôle Trèfle. Si le répondant poursuit par 4H
    // au lieu de signer 4S, il ne peut le faire qu'en contrôlant lui-même les Trèfles ;
    // il montre en plus le contrôle Cœur. Tous les contrôles latéraux sont alors connus :
    // l'ouvreur peut poser le Blackwood aux clés, et ne doit jamais passer sur 4H.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,slam,p4,c1,p5,c2,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
        p3.call==='PASS' && slam.seat===partner && slam.call==='3S' && p4.call==='PASS' && c1.seat===seat && c1.call==='4D' && p5.call==='PASS' &&
        c2.seat===partner && c2.call==='4H' && p6.call==='PASS';
      if(frame && (!ctx.isLegal||ctx.isLegal(history,'4NT',seat))) return {
        call:'4NT',changed:true,
        semantic:{natural:false,source:'course18-opener-rkcb-after-diamond-heart-controls',suits:{S:{min:2,max:13}},hcp:{min:11,max:17},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'rkcb'},
        reason:'cours 3/18 : 4D a dénié le contrôle Trèfle chez l’ouvreur ; la poursuite 4H implique que le répondant couvre Trèfle et montre Cœur => tous les contrôles connus, 4SA RKCB'
      };
    }

    // Cours 18 — après 4C-4D dans une exploration de chelem à Cœur, l'ouvreur
    // montre 4S s'il contrôle les Piques ; à défaut il revient à 4H.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,slam,p4,c1,p5,c2,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && p1.call==='PASS' && resp.seat===partner && resp.call==='1H' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
        p3.call==='PASS' && slam.seat===partner && slam.call==='3H' && p4.call==='PASS' && c1.seat===seat && c1.call==='4C' && p5.call==='PASS' &&
        c2.seat===partner && c2.call==='4D' && p6.call==='PASS';
      if(frame){
        const sp=String(ctx.deal?.hands?.[seat]?.S||''), spControl=sp.length<=1 || /[AK]/.test(sp);
        const target=spControl?'4S':'4H';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:target==='4H',source:spControl?'course18-opener-spade-control-after-heart-slam-try':'course18-opener-heart-signoff-after-control-gap',suits:{H:{min:2,max:13}},hcp:{min:11,max:17},forcing:spControl?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course18-major-slam-try-response'},
          reason:spControl?'cours 18 : après contrôles 4C-4D, contrôle Pique => 4S':'cours 18 : pas de contrôle Pique après 4C-4D => 4H arrêt'
        };
      }
    }

    // Cours 18 — à l'atout Pique, si le répondant saute de 4C à 4H,
    // il montre le contrôle Cœur mais a sauté Carreau. L'ouvreur sait donc que
    // le contrôle Carreau manque au camp s'il ne le possède pas lui-même : 4S
    // est alors l'arrêt. S'il contrôle Carreau, tous les contrôles latéraux sont
    // connus et 4SA peut lancer le Blackwood aux clés.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,slam,p4,c1,p5,c2,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
        p3.call==='PASS' && slam.seat===partner && slam.call==='3S' && p4.call==='PASS' && c1.seat===seat && c1.call==='4C' && p5.call==='PASS' &&
        c2.seat===partner && c2.call==='4H' && p6.call==='PASS';
      if(frame){
        const di=String(ctx.deal?.hands?.[seat]?.D||''), dControl=di.length<=1 || /[AK]/.test(di);
        const target=dControl?'4NT':'4S';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:target==='4S',source:dControl?'course18-opener-rkcb-after-partner-heart-control':'course18-opener-spade-signoff-after-diamond-control-gap',suits:{S:{min:2,max:13}},hcp:{min:11,max:17},forcing:dControl?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:dControl?'rkcb':'course18-major-slam-try-response'},
          reason:dControl?'cours 18 : 4C puis 4H, contrôle Carreau chez l’ouvreur => tous les contrôles connus, 4SA RKCB':'cours 18 : 4H a sauté le contrôle Carreau et l’ouvreur ne le possède pas => arrêt à 4S'
        };
      }
    }

    // Cours 18 — symétrique à l'atout Pique : après 4C-4D, l'ouvreur
    // montre 4H s'il contrôle les Cœurs ; sinon il revient à 4S pour arrêter.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,slam,p4,c1,p5,c2,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
        p3.call==='PASS' && slam.seat===partner && slam.call==='3S' && p4.call==='PASS' && c1.seat===seat && c1.call==='4C' && p5.call==='PASS' &&
        c2.seat===partner && c2.call==='4D' && p6.call==='PASS';
      if(frame){
        const he=String(ctx.deal?.hands?.[seat]?.H||''), hControl=he.length<=1 || /[AK]/.test(he);
        const target=hControl?'4H':'4S';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:target==='4S',source:hControl?'course18-opener-heart-control-after-spade-slam-try':'course18-opener-spade-signoff-after-control-gap',suits:{S:{min:2,max:13}},hcp:{min:11,max:17},forcing:hControl?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course18-major-slam-try-response'},
          reason:hControl?'cours 18 : après contrôles 4C-4D à l’atout Pique, contrôle Cœur => 4H':'cours 18 : pas de contrôle Cœur après 4C-4D => 4S arrêt'
        };
      }
    }

    // Après 4C-4D-4H à l'atout Pique, les trois contrôles latéraux ont été
    // échangés. Le répondant qui avait déclenché l'essai de chelem par 3S peut
    // alors poser le Blackwood aux clés à 4SA.
    if(relHistory.length===14 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,slam,p4,c1,p5,c2,p6,c3,p7]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner && p1.call==='PASS' && resp.seat===seat && resp.call==='1S' && p2.call==='PASS' && rebid.seat===partner && rebid.call==='1NT' &&
        p3.call==='PASS' && slam.seat===seat && slam.call==='3S' && p4.call==='PASS' && c1.seat===partner && c1.call==='4C' && p5.call==='PASS' &&
        c2.seat===seat && c2.call==='4D' && p6.call==='PASS' && c3.seat===partner && c3.call==='4H' && p7.call==='PASS';
      if(frame && (!ctx.isLegal||ctx.isLegal(history,'4NT',seat))) return {
        call:'4NT',changed:true,
        semantic:{natural:false,source:'course18-responder-rkcb-after-complete-controls-spades',suits:{S:{min:6,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'rkcb'},
        reason:'cours 18 : contrôles C/D/H échangés avec fit Pique et ambition de chelem => 4SA Blackwood aux clés'
      };
    }

    // Cours 18 — après la chaîne de contrôles 4C-4D-4S à l'atout Cœur,
    // tous les contrôles latéraux nécessaires ont été échangés. Avec la main de
    // chelem qui a déclenché 3H, 4SA devient le Blackwood aux clés ; PONS sait
    // ensuite répondre nativement à cette demande.
    if(relHistory.length===14 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,slam,p4,c1,p5,c2,p6,c3,p7]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner && p1.call==='PASS' && resp.seat===seat && resp.call==='1H' && p2.call==='PASS' && rebid.seat===partner && rebid.call==='1NT' &&
        p3.call==='PASS' && slam.seat===seat && slam.call==='3H' && p4.call==='PASS' && c1.seat===partner && c1.call==='4C' && p5.call==='PASS' &&
        c2.seat===seat && c2.call==='4D' && p6.call==='PASS' && c3.seat===partner && c3.call==='4S' && p7.call==='PASS';
      if(frame && (!ctx.isLegal||ctx.isLegal(history,'4NT',seat))) return {
        call:'4NT',changed:true,
        semantic:{natural:false,source:'course18-responder-rkcb-after-complete-controls',suits:{H:{min:6,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'rkcb'},
        reason:'cours 18 : contrôles C/D/S échangés avec fit Cœur et ambition de chelem => 4SA Blackwood aux clés'
      };
    }

    // Cours 18/19 — deuxième action du répondant après la réponse au Roudi.
    if(relHistory.length===10){
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='C'||ob.strain==='D'||open.call==='1H') && p1.call==='PASS' &&
        resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' && rebid.seat===partner && rebid.call==='1NT' &&
        p3.call==='PASS' && roudi.seat===seat && roudi.call==='2C' && p4.call==='PASS' && answer.seat===partner && ['2D','2H','2S'].includes(answer.call) && p5.call==='PASS';
      if(frame){
        const major=rb.strain, other=major==='H'?'S':'H', HL=hlPoints(ctx.deal,seat), fit=answer.call!=='2D';
        let target=null, semantic=null, reason='';
        if(!fit){
          if(L[major]>=5 && L[other]>=4){
            if(HL>=12){
              target=`3${other}`;
              semantic={natural:true,source:'course19-roudi-other-major-game-force',suits:{[major]:{min:5,max:13},[other]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-roudi-development'};
              reason=`cours 19 : après 2D du Roudi, ${L[major]}-${L[other]} majeur et ${HL} HL => 3${other} forcing de manche`;
            } else if(H>=9 || HL>=10){
              target=`2${other}`;
              semantic={natural:true,source:'course19-roudi-other-major-invite',suits:{[major]:{min:5,max:13},[other]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course19-roudi-development'};
              reason=`cours 19 : après 2D du Roudi, recherche de l'autre majeure au palier de 2, non forcing`;
            }
          }
          // Cours 19, tableau récapitulatif : après la réponse 2D du Roudi,
          // une mineure latérale au palier de 3 est naturelle et forcing de manche
          // (5+ cartes dans la majeure de réponse, au moins quatre dans la mineure).
          // En cas de deux mineures quatrièmes simultanées, on laisse PONS choisir :
          // le cours ne fixe pas ici de priorité suffisamment nette pour une substitution.
          if(!target && L[major]>=5 && HL>=12){
            const sideMinors=['C','D'].filter(s=>L[s]>=4);
            if(sideMinors.length===1){
              const sm=sideMinors[0], cand=`3${sm}`;
              if(!ctx.isLegal||ctx.isLegal(history,cand,seat)){
                target=cand;
                semantic={natural:true,source:'course19-roudi-side-minor-game-force',suits:{[major]:{min:5,max:13},[sm]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-roudi-development'};
                reason=`cours 19 : après 2D du Roudi, ${L[major]} ${major} et ${L[sm]} ${sm} avec valeurs de manche => ${cand} naturel forcing de manche`;
              }
            }
          }
          // Cas particulier du cours 19 après 1H-1S-1SA-Roudi-2D : avec environ
          // dix points et seulement deux Cœurs, 2H est une maxi-préférence d'arrêt.
          if(!target && open.call==='1H' && major==='S' && L.H===2 && L.S>=5 && H>=9 && H<=10){
            target='2H';
            semantic={natural:true,source:'course19-roudi-heart-maxi-preference',suits:{S:{min:5,max:13},H:{min:2,max:2}},hcp:{min:9,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course19-heart-preference'};
            reason='cours 19 : après échec du Roudi à Pique, environ 10 H et deux Cœurs => maxi-préférence 2H, arrêt';
          }
          if(!target && L[major]>=6 && HL>=11 && HL<=12){
            const cards=String(ctx.deal?.hands?.[seat]?.[major]||''), top=['A','K','Q','J','T'].filter(r=>cards.includes(r)).length;
            target=top>=3?`3${major}`:`2${major}`;
            semantic={natural:true,source:'course18-roudi-six-major-after-no-fit',suits:{[major]:{min:6,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-development'};
            reason=`cours 18 : six cartes à ${major}, 11/12 HL et pas de fit troisième => ${target} (${top>=3?'proposition':'dévalorisation'})`;
          }
          if(!target && L[major]>=5 && H===11 && balanced(L)){
            target='2NT';
            semantic={natural:true,source:'course18-roudi-2NT-after-no-fit',suits:{[major]:{min:5,max:13}},hcp:{min:11,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-development'};
            reason='cours 18 : après 2D du Roudi, 11 H réguliers => 2SA propositionnel';
          }
          if(!target && L[major]>=5 && H<=10){
            target=`2${major}`;
            semantic={natural:true,source:'course18-roudi-return-major-after-no-fit',suits:{[major]:{min:5,max:13}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-development'};
            reason=`cours 18 : Roudi d'essai, pas de fit troisième => retour à 2${major}`;
          }
        } else {
          // 2H = fit minimum, 2S = fit maximum, indépendamment de la majeure du répondant.
          const maxFit=answer.call==='2S';
          // Cours 19 : même si le Roudi a trouvé le fit à Pique, un répondant 5P-4C
          // de manche ou plus recherche le fit 4-4 à Cœur par 3H avant de conclure.
          if(major==='S' && L.S>=5 && L.H>=4 && HL>=12){
            target='3H';
            semantic={natural:true,source:'course19-roudi-fitted-spades-search-hearts',suits:{S:{min:5,max:13},H:{min:4,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course19-roudi-development'};
            reason='cours 19 : Roudi fitté à Pique mais quatre Cœurs et valeurs de manche => 3H, recherche du meilleur fit majeur';
          // Le cours 18 traite explicitement le cas des 11 H réguliers/semi-réguliers :
          // manche sur la réponse maximale (2S), arrêt au palier de 2 sur la minimale (2H).
          // Il faut tester ce cas AVANT HL>=12, car une majeure cinquième ajoute un point L
          // et ferait sinon monter artificiellement une main de 11 H à 12 HL.
          } else if(H===11 && balanced(L)){
            if(maxFit){
              target=`4${major}`;
              reason='cours 18 : 11 H réguliers et ouvreur maximum fitté => manche';
            } else {
              target=(major==='H' && answer.call==='2H')?'PASS':`2${major}`;
              reason='cours 18 : 11 H réguliers et ouvreur minimum fitté => arrêt au palier de 2';
            }
            semantic={natural:true,source:'course18-roudi-balanced-11-after-fit',suits:{[major]:{min:5,max:13}},hcp:{min:11,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-development'};
          } else if(HL>=17){
            target=`3${major}`;
            semantic={natural:true,source:'course18-roudi-major-slam-try-after-fit',suits:{[major]:{min:5,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course18-roudi-development'};
            reason=`cours 18 : fit trouvé par le Roudi et ${HL} HL => soutien au palier de 3, ambition de chelem`;
          } else if(HL>=12 || (H>=9 && !balanced(L)) || L[major]>=6){
            target=`4${major}`;
            semantic={natural:true,source:'course18-roudi-major-game-after-fit',suits:{[major]:{min:5,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-development'};
            reason=`cours 18 : le Roudi a trouvé le fit troisième ; les valeurs du répondant justifient la manche à 4${major}`;
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }


    // Anti-régression v2.33 — continuation d'une vraie tentative de chelem au Roudi.
    // Après 1m-1M-1SA-2C-2H/2S-3M, le soutien au palier de 3 a été publié comme
    // ambition de chelem. Un ouvreur non minimum absolu ne doit pas rabattre cette
    // séquence automatiquement à 4M : avec 13+ H, 4SA conserve le Blackwood.
    if(relHistory.length===12){
      const [open,p1,resp,p2,nt,p3,roudi,p4,ans,p5,slamTry,p6]=relHistory, partner=partnerOf(seat);
      const rb=parseBid(resp.call), sb=parseBid(slamTry.call);
      const frame=open.seat===seat&&(open.call==='1C'||open.call==='1D')&&p1.call==='PASS'&&resp.seat===partner&&rb?.level===1&&(rb.strain==='H'||rb.strain==='S')&&p2.call==='PASS'&&nt.seat===seat&&nt.call==='1NT'&&p3.call==='PASS'&&roudi.seat===partner&&roudi.call==='2C'&&p4.call==='PASS'&&ans.seat===seat&&(ans.call==='2H'||ans.call==='2S')&&p5.call==='PASS'&&slamTry.seat===partner&&sb?.level===3&&sb.strain===rb.strain&&p6.call==='PASS';
      if(frame && H>=13 && legal('4NT')) return {call:'4NT',changed:raw!=='4NT',semantic:{natural:false,source:'v233-roudi-opener-rkcb-after-slam-try',suits:{[rb.strain]:{min:3,max:13}},hcp:{min:13,max:14},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course18-roudi'},reason:`anti-régression v2.3 : 3${rb.strain} est une tentative de chelem au Roudi ; ouvreur ${H} H => 4SA`};
    }

    // Cours 17 — troisième couleur forcing après répétition simple de la mineure
    // d'ouverture. On couvre ici le cas le plus certain : une majeure sixième forte du
    // répondant, trop forte pour une répétition directe qui serait non forcing.
    // Les trois séquences conventionnelles du cours sont 1C-1H-2C-2D,
    // 1C-1S-2C-2D et 1D-1S-2D-2H.
    if(relHistory.length===6){
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat), rb=parseBid(resp.call);
      const clean=open.seat===partner && p1.call==='PASS' && resp.seat===seat && p2.call==='PASS' && rebid.seat===partner && p3.call==='PASS';
      let third=null;
      if(clean && open.call==='1C' && (resp.call==='1H'||resp.call==='1S') && rebid.call==='2C') third='2D';
      if(clean && open.call==='1D' && resp.call==='1S' && rebid.call==='2D') third='2H';
      // Une troisième couleur forcing ne doit jamais laisser passer une main constructive/forte
      // simplement parce que la majeure du répondant n'est que quatrième ou cinquième.
      // On l'emploie dès ~10 H quand PONS brut voudrait passer ; la branche suivante
      // conserve le cas historique de la majeure sixième forte, même si le brut n'est pas PASS.
      if(third && rb && raw==='PASS' && H>=10 && (!ctx.isLegal||ctx.isLegal(history,third,seat))){
        return {
          call:third,changed:true,
          semantic:{natural:false,source:'v237-third-forcing-no-pass',suits:{[rb.strain]:{min:4,max:13}},hcp:{min:10,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing'},
          reason:`cours 17 : ${H} H après répétition simple de la mineure ; Passe trop faible => troisième forcing ${third}`
        };
      }
      if(third && rb && L[rb.strain]>=6 && H>=12 && (!ctx.isLegal||ctx.isLegal(history,third,seat))){
        return {
          call:third,changed:raw!==third,
          semantic:{natural:false,source:'course17-third-forcing-before-strong-repeat',suits:{[rb.strain]:{min:6,max:13}},hcp:{min:12,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing'},
          reason:`cours 17 : six ${rb.strain} et ${H} H, trop fort pour une répétition non forcing => troisième forcing ${third}`
        };
      }
    }

    // Cours 17 — réponses objectives de l'ouvreur à la troisième forcing.
    // La zone faible de l'ouvreur est 11/13 H, la forte 14/16 H. Priorité au fit
    // troisième dans la majeure du répondant ; à défaut, Sans-Atout exige les arrêts
    // dans les deux couleurs encore incertaines. Dans 1D-1S-2D-2H, quatre Cœurs
    // réels doivent être soutenus à 3H (forcing), sans supposer que le répondant en a quatre.
    if(relHistory.length===8){
      const [open,p1,resp,p2,rebid,p3,third,p4]=relHistory, partner=partnerOf(seat), rb=parseBid(resp.call);
      const clean=open.seat===seat && p1.call==='PASS' && resp.seat===partner && p2.call==='PASS' && rebid.seat===seat && p3.call==='PASS' && third.seat===partner && p4.call==='PASS';
      const frameC=clean && open.call==='1C' && (resp.call==='1H'||resp.call==='1S') && rebid.call==='2C' && third.call==='2D';
      const frameD=clean && open.call==='1D' && resp.call==='1S' && rebid.call==='2D' && third.call==='2H';
      if((frameC||frameD) && rb && H>=11 && H<=16){
        if(L[rb.strain]===3){
          const target=H<=13?`2${rb.strain}`:`3${rb.strain}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course17-opener-major-support-after-third',suits:{[rb.strain]:{min:3,max:3}},hcp:{min:H<=13?11:14,max:H<=13?13:16},forcing:H<=13?'nonforcing':'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17 : fit troisième à ${rb.strain}, ${H} H => ${target}`
          };
        }
        if(frameD && L.S<=2 && L.H>=4){
          const target='3H';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course17-opener-heart-support-after-third',suits:{H:{min:4,max:13}},hcp:{min:11,max:16},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:'cours 17 : après 1D-1S-2D-2H troisième forcing, quatre Cœurs chez l’ouvreur => soutien forcing à 3H'
          };
        }
        if(frameC && L[rb.strain]<=2){
          const other=rb.strain==='H'?'S':'H';
          if(L[other]>=4){
            const target=cheapestSuitCallAfter(history,other);
            if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course17-opener-other-major-after-third',suits:{[other]:{min:4,max:13}},hcp:{min:H<=13?11:14,max:H<=13?13:16},forcing:H<=13?'nonforcing':'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},
              reason:`cours 17 : après troisième forcing, quatre cartes dans l'autre majeure ${other} => ${target}, en zonant ${H<=13?'11/13':'14/16'} H`
            };
          }
        }
        if(frameD && L.S<=2 && L.H<=3 && L.C>=5){
          // Par analogie avec les priorités de la 4e forcing, une vraie structure
          // 6-4 / 5-5 doit être décrite avant Sans-Atout. Cette règle récupère aussi
          // les cas où PONS avait malencontreusement répété 2D au tour précédent.
          const target='3C';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course17-opener-hidden-minor-bicolor-after-third',suits:{D:{min:5,max:13},C:{min:4,max:13}},hcp:{min:H<=13?11:14,max:H<=13?13:16},forcing:H<=13?'nonforcing':'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17/16 : troisième forcing, distribution ${L.D}-${L.C} mineure à préciser => 3C avant Sans-Atout`
          };
        }
        if(L[rb.strain]<=2){
          const uncertain=frameC ? (rb.strain==='H'?['S','D']:['H','D']) : ['H','C'];
          if(uncertain.every(suit=>stopperScore(ctx.deal,seat,suit)>=0.7)){
            const target=H<=13?'2NT':'3NT';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course17-opener-NT-after-third',suits:{[rb.strain]:{min:0,max:2}},hcp:{min:H<=13?11:14,max:H<=13?13:16},forcing:H<=13?'nonforcing':'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},
              reason:`cours 17 : pas de fit majeur, arrêts dans ${uncertain.join('/')} et ${H} H => ${target}`
            };
          }
        }
        // Cours 17, réponse de l'ouvreur quand aucune des priorités précédentes ne
        // convient : en zone faible, une belle couleur d'ouverture sixième peut être
        // répétée au palier de 3. Cette enchère est non forcing et plafonnée à 13 H.
        // On exige ici au moins trois cartes parmi A/K/Q/J/T pour ne pas transformer
        // toute répétition sixième médiocre en enchère automatique.
        if(H<=13 && L[open.call.slice(1)]>=6){
          const os=open.call.slice(1), cards=String(ctx.deal?.hands?.[seat]?.[os]||''), top=['A','K','Q','J','T'].filter(r=>cards.includes(r)).length;
          const target=`3${os}`;
          if(top>=3 && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course17-opener-good-six-repeat-after-third',suits:{[os]:{min:6,max:13}},hcp:{min:11,max:13},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17 : zone 11/13 H, belle couleur d'ouverture sixième (${top} gros/intermédiaires) => ${target} non forcing`
          };
        }
        if(frameD && H<=13 && L.S<=2 && L.H<=3 && L.D>=6 && L.C>=4){
          const target='3C';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course17-opener-hidden-minor-bicolor-after-third',suits:{D:{min:6,max:13},C:{min:4,max:13}},hcp:{min:11,max:13},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17/16 : pas d'autre réponse en zone 11/13 et structure ${L.D}-${L.C} mineure => 3C descriptif`
          };
        }
        // Cours 17 : après la troisième forcing 2D des cadres à Trèfle,
        // quatre vrais Carreaux dans la zone forte doivent être annoncés à 3D avant
        // de recourir à la dernière couleur artificielle. Le cours précise que ce
        // soutien ne promet pas que le répondant avait réellement des Carreaux : il
        // décrit quatre cartes et la zone 14/16 H, et oblige le répondant à juger la manche.
        if(frameC && H>=14 && H<=16 && L.D>=4){
          const target='3D';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course17-opener-strong-diamond-support-after-third',suits:{D:{min:4,max:13}},hcp:{min:14,max:16},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17 : troisième forcing 2D et quatre vrais Carreaux en zone 14/16 H => 3D avant toute dernière couleur artificielle`
          };
        }

        // Derniers recours explicitement décrits par le cours 17 : dans la zone
        // faible, une préférence à deux cartes dans la majeure du répondant permet de
        // s'arrêter ; dans la zone 14/16, l'annonce de la dernière couleur traduit
        // l'absence d'enchère naturelle satisfaisante et rend la séquence forcing de manche.
        if(H<=13 && L[rb.strain]===2){
          const target=`2${rb.strain}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course17-opener-two-card-preference-after-third',suits:{[rb.strain]:{min:2,max:2}},hcp:{min:11,max:13},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17 : aucune enchère naturelle en zone 11/13 H => préférence à deux cartes ${target}`
          };
        }
        if(H>=14 && H<=16){
          const named=new Set([parseBid(open.call)?.strain,rb.strain,parseBid(rebid.call)?.strain,parseBid(third.call)?.strain].filter(Boolean));
          const last=SUITS.find(suit=>!named.has(suit));
          const target=last?cheapestSuitCallAfter(history,last):null;
          if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
            call:target,changed:raw!==target,
            semantic:{natural:false,source:'course17-opener-last-suit-after-third',hcp:{min:14,max:16},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17 : zone 14/16 H sans enchère naturelle acceptable => dernière couleur ${target}, forcing de manche`
          };
        }
      }
    }

    // Garde-fou analogue dans le cadre à Trèfle : PONS ouvre parfois à 10 H
    // une main très distributionnelle. La troisième forcing reste forcing un tour.
    // Avec quatre cartes dans l'autre majeure, la réponse naturelle conserve la
    // priorité descriptive du cours au lieu d'autoriser un PASS impossible.
    if(relHistory.length===8 && raw==='PASS' && H<11){
      const [open,p1,resp,p2,rebid,p3,third,p4]=relHistory, partner=partnerOf(seat), rb=parseBid(resp.call);
      const frame=open.seat===seat && open.call==='1C' && p1.call==='PASS' && resp.seat===partner && (resp.call==='1H'||resp.call==='1S') && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='2C' && p3.call==='PASS' && third.seat===partner && third.call==='2D' && p4.call==='PASS';
      if(frame && rb){
        const other=rb.strain==='H'?'S':'H';
        const clubCards=String(ctx.deal?.hands?.[seat]?.C||''), clubTop=['A','K','Q','J','T'].filter(r=>clubCards.includes(r)).length;
        const goodClubRepeat=L.C>=6 && (clubTop>=3 || (L.C>=7 && clubTop>=2 && (clubCards.includes('A')||clubCards.includes('K'))));
        // Une vraie longue de Trèfle suffisamment solide reste prioritaire : le
        // filet historique course17-low-hcp-emergency-after-third-clubs la traite
        // juste après. Sinon, quatre cartes dans l'autre majeure sont l'information
        // naturelle la plus utile à fournir.
        if(!goodClubRepeat && L[rb.strain]<=2 && L[other]>=4){
          const target=cheapestSuitCallAfter(history,other);
          if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
            call:target,changed:true,
            semantic:{natural:true,source:'course17-opener-low-h-other-major-after-third',suits:{[other]:{min:4,max:13}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},
            reason:`cours 17 : troisième forcing oblige à répondre ; ouverture PONS sous 11 H mais quatre cartes ${other} => ${target} naturel`
          };
        }
      }
    }

    // Garde-fou de robustesse : PONS peut ouvrir certaines mains 6-5 très
    // distributionnelles avec seulement 10 H. Le cours zone normalement la répétition
    // de mineure à partir de 11 H, mais une troisième forcing reste malgré tout forcing
    // un tour. Avec 6D-5C, 3C est la description naturelle et évite un PASS impossible.
    if(relHistory.length===8 && raw==='PASS' && H<11){
      const [open,p1,resp,p2,rebid,p3,third,p4]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && open.call==='1D' && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='2D' && p3.call==='PASS' && third.seat===partner && third.call==='2H' && p4.call==='PASS';
      if(frame && L.D>=6){
        // Le cours autorise la répétition à 3 de la couleur d'ouverture avec six
        // cartes de bonne qualité et précise que la troisième forcing oblige
        // l'ouvreur à répondre. Sur les rares ouvertures PONS sous 11 H, on garde
        // donc la description naturelle plutôt qu'un PASS impossible.
        const cards=String(ctx.deal?.hands?.[seat]?.D||''), top=['A','K','Q','J','T'].filter(r=>cards.includes(r)).length;
        const target=(L.C>=5 && top<3)?'3C':'3D';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course17-low-hcp-emergency-after-third',suits:target==='3C'?{D:{min:6,max:13},C:{min:5,max:13}}:{D:{min:6,max:13}},hcp:{min:H,max:H},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},
          reason:`cours 17 : troisième forcing = PASS interdit ; ${L.D} Carreaux${target==='3D'?' de qualité':''} avec ${H} H => ${target} descriptif`
        };
      }
    }


    // Cours 17 — même filet de sécurité pour les deux cadres à Trèfle :
    // 1C-1H/1S-2C-2D. PONS peut ouvrir très exceptionnellement avec 10 H et
    // une mineure septième. La troisième forcing oblige néanmoins l'ouvreur à
    // répondre ; le cours autorise la répétition à 3 de la couleur d'ouverture
    // avec six belles cartes, enchère non forcing.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,third,p4]=relHistory;
      const partner=partnerOf(seat);
      const frame=open.seat===seat && open.call==='1C' && p1.call==='PASS' && resp.seat===partner && (resp.call==='1H'||resp.call==='1S') && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='2C' && p3.call==='PASS' && third.seat===partner && third.call==='2D' && p4.call==='PASS';
      if(frame && L.C>=6){
        const cards=String(ctx.deal?.hands?.[seat]?.C||''), top=['A','K','Q','J','T'].filter(r=>cards.includes(r)).length;
        const good=top>=3 || (L.C>=7 && top>=2 && (cards.includes('A')||cards.includes('K')));
        if(good && (!ctx.isLegal||ctx.isLegal(history,'3C',seat))) return {
          call:'3C',changed:true,
          semantic:{natural:true,source:'course17-low-hcp-emergency-after-third-clubs',suits:{C:{min:6,max:13}},hcp:{min:H,max:H},forcing:'nonforcing',publishWhenNative:true,convention:'course17-third-forcing-response'},
          reason:`cours 17 : troisième forcing = PASS interdit ; ${L.C} Trèfles de qualité (${top} gros/intermédiaires) avec ${H} H => 3C descriptif`
        };
      }
    }

    // Cours 15 — développements structurés après un bicolore économique.
    // Cadres couverts : 1H-1S-2m et 1D-1M-2C, sans intervention adverse.
    // On privilégie les enchères dont le cours donne une définition ferme : soutien
    // différé majeur, fits mineurs, 2SA/3SA avec arrêt et quatrième forcing.
    if(relHistory.length===6){
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call);
      const clean=open.seat===partner && p1.call==='PASS' && resp.seat===seat && p2.call==='PASS' && rebid.seat===partner && p3.call==='PASS' &&
        ob?.level===1 && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && r2?.level===2 && (r2.strain==='C'||r2.strain==='D');
      const economic=clean && ((ob.strain==='H' && rb.strain==='S' && r2.strain!==ob.strain) || (ob.strain==='D' && r2.strain==='C'));
      if(economic){
        const HL=hlPoints(ctx.deal,seat), fourth=SUITS.find(s=>![ob.strain,rb.strain,r2.strain].includes(s));
        const fourthCall=fourth?cheapestSuitCallAfter(history,fourth):null;
        const fourthEconomic=fourthCall ? bidRank(fourthCall)<bidRank(`2${rb.strain}`) : false;
        const fourthStop=fourth?stopperScore(ctx.deal,seat,fourth):0;

        // Unicolore du répondant : les règles de répétition (cours 13/15) restent
        // prioritaires et sont déjà traitées plus bas ; ne pas les masquer ici.
        if(L[rb.strain]<6){
          // Soutien différé à Cœur après 1H-1S-2C (cours 15 / Chailley) :
          // 13-15 HLD => 4H de manche ; 16-17 HLD => 3H forcing ; 18+ HLD =>
          // commencer par la 4e couleur forcing à 2D, puis fitter H. La version
          // précédente écrasait à tort les mains 18+ dans 3H/4H et consommait
          // l'espace nécessaire à l'exploration du chelem.
          if(ob.strain==='H' && rb.strain==='S' && L.H>=3 && L.S<=5){
            const fitHld=supportHld(ctx.deal,seat,'H');
            let target=null,forcing='nonforcing',source='course15-delayed-heart-support';
            if(fitHld>=18 && fourthCall && fourth==='D'){
              target=fourthCall; forcing='game_if_uncontested'; source='course15-delayed-heart-fit-via-fourth-forcing';
            } else if(fitHld>=16){
              target='3H'; forcing='game_if_uncontested';
            } else if(fitHld>=13){
              target='4H';
            }
            if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
              call:target,changed:raw!==target,
              semantic:{natural:target==='2D'?false:true,source,suits:{H:{min:3,max:13},S:{min:4,max:5}},hcp:{min:0,max:37},forcing,publishWhenNative:true,convention:'course15-delayed-major-fit'},
              reason:`cours 15 : soutien différé à Cœur, ${fitHld} HLD => ${target}${target==='2D'?' quatrième forcing avant fit chelemisant':target==='3H'?' forcing, espoir de chelem':' conclusion de manche'}`
            };
          }

          // Soutien de la deuxième mineure de l'ouvreur : 9-12 HL, non forcing.
          if(L[r2.strain]>=4 && HL>=9 && HL<=12){
            const target=`3${r2.strain}`;
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course15-second-suit-minor-fit',suits:{[r2.strain]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course15-minor-fit'},
              reason:`cours 15 : fit d'au moins quatre cartes dans la deuxième mineure, ${HL} HL => ${target} propositionnel non forcing`
            };
          }

          // Soutien à saut des Carreaux : forcing de manche, irrégulier, et dénie
          // cinq cartes dans la majeure de réponse.
          if(ob.strain==='D' && r2.strain==='C' && L.D>=3 && L[rb.strain]===4 && HL>=12 && !balanced(L)){
            const target='3D';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course15-opening-diamond-fit-jump',suits:{D:{min:3,max:13},[rb.strain]:{min:4,max:4}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course15-minor-fit'},
              reason:`cours 15 : fit Carreau irrégulier de manche sans majeure cinquième => 3D forcing de manche`
            };
          }

          // 3SA : 12-15 H, arrêt dans la dernière couleur, plutôt régulier et
          // sans majeure cinquième. Les mains plus fortes transitent par la 4e forcing.
          if(H>=12 && H<=15 && L[rb.strain]===4 && fourth && fourthStop>=0.7 && balanced(L)){
            const target='3NT';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course15-3NT-after-economic-bicolor',suits:{[rb.strain]:{min:4,max:4}},hcp:{min:12,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'course15-notrump'},
              reason:`cours 15 : ${H} H, jeu régulier, arrêt ${fourth} et pas de majeure cinquième => 3SA`
            };
          }

          // Fit dans les Carreaux d'ouverture après 1D-1M-2C. Le soutien simple
          // couvre une zone très large et ne dénie pas une majeure cinquième.
          if(ob.strain==='D' && r2.strain==='C' && L.D>=3 && HL>=6 && HL<=12 && !(L[rb.strain]>=5 && H>=12)){
            const target='2D';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course15-opening-diamond-fit-simple',suits:{D:{min:3,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course15-minor-fit'},
              reason:`cours 15 : soutien simple des Carreaux d'ouverture, ${HL} HL => 2D non forcing`
            };
          }

          // 2SA : environ 11/12 HL (10 beaux laissés à PONS), arrêt dans la
          // quatrième couleur. Ne dénie pas cinq cartes dans la majeure de réponse.
          if(HL>=11 && HL<=12 && fourth && fourthStop>=0.7){
            const target='2NT';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course15-2NT-after-economic-bicolor',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course15-notrump'},
              reason:`cours 15 : ${HL} HL et arrêt ${fourth} après bicolore économique => 2SA propositionnel`
            };
          }

          // Quatrième forcing : priorité si une majeure cinquième reste à fitter,
          // si l'arrêt fait défaut ou si la main est trop forte pour 3SA. La version
          // économique peut être utilisée dès 11 H ; la version chère exige la manche.
          if(fourthCall && (L[rb.strain]>=5 || fourthStop<0.7 || H>=16)){
            const minH=fourthEconomic?11:12;
            if(H>=minH && (!ctx.isLegal||ctx.isLegal(history,fourthCall,seat))) return {
              call:fourthCall,changed:raw!==fourthCall,
              semantic:{natural:false,source:'course15-fourth-forcing-after-economic-bicolor',suits:{[rb.strain]:{min:L[rb.strain]>=5?5:4,max:13}},hcp:{min:minH,max:37},forcing:fourthEconomic?'one_round_if_uncontested':'game_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},
              reason:`cours 15/16 : besoin d'informations après bicolore économique => quatrième forcing ${fourthCall}${fourthEconomic?' (économique, un tour)':' (forcing de manche)'}`
            };
          }
        }
      }
    }

    // Cours 15 — réaction de l'ouvreur après 2SA propositionnel du répondant.
    // Une main faible passe ; avec des réserves, la recherche d'un fit 5-3 dans la
    // majeure du répondant est prioritaire avant la conclusion à 3SA.
    if(relHistory.length===8){
      const [open,p1,resp,p2,rebid,p3,cont,p4]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call);
      const clean=open.seat===seat && p1.call==='PASS' && resp.seat===partner && p2.call==='PASS' && rebid.seat===seat && p3.call==='PASS' && cont.seat===partner && p4.call==='PASS' &&
        ob?.level===1 && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && r2?.level===2 && (r2.strain==='C'||r2.strain==='D');
      const economic=clean && ((ob.strain==='H'&&rb.strain==='S')||(ob.strain==='D'&&r2.strain==='C'));
      if(economic && cont.call==='2NT'){
        if(H<=12) return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course15-opener-declines-2NT',hcp:{min:0,max:12},forcing:'nonforcing',publishWhenNative:true,convention:'course15-notrump'},reason:`cours 15 : 2SA est propositionnel et l'ouvreur n'a que ${H} H => passe`};
        if(H>=14 && L[rb.strain]===3){
          const target=`3${rb.strain}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course15-opener-shows-three-card-major-after-2NT',suits:{[rb.strain]:{min:3,max:3}},hcp:{min:14,max:19},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course15-notrump'},reason:`cours 15 : ouvreur positif avec trois cartes dans la majeure du répondant => ${target} avant 3SA`};
        }
        if(H>=14 && (!ctx.isLegal||ctx.isLegal(history,'3NT',seat))) return {call:'3NT',changed:raw!=='3NT',semantic:{natural:true,source:'course15-opener-accepts-2NT',hcp:{min:14,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course15-notrump'},reason:`cours 15 : ouvreur positif (${H} H) après 2SA propositionnel => 3SA`};
      }

      // Cours 15 : quand l'ouvreur accepte le 2SA propositionnel et montre
      // trois cartes dans la majeure de réponse à 3M, le répondant doit conclure la
      // manche. Avec cinq cartes dans sa majeure, 4M concrétise le fit 5-3 ; avec
      // seulement quatre cartes, 3SA reste l'objectif naturel du 2SA propositionnel.
      // Cette branche corrige les PASS natifs de PONS après un 3M qui signifiait déjà
      // que l'ouvreur avait accepté de jouer la manche.
      // (La séquence complète comporte dix appels ; ce bloc est traité plus bas.)

      // Cours 15 : après un 3SA de conclusion du répondant, une vraie bonne
      // majeure d'ouverture sixième reste prioritaire. Le cours demande alors de
      // revenir automatiquement à 4H. On exige trois cartes parmi A/K/Q/J/T pour ne
      // pas transformer toute majeure sixième médiocre en correction automatique.
      if(economic && ob.strain==='H' && cont.call==='3NT' && L.H>=6){
        const cards=String(ctx.deal?.hands?.[seat]?.H||''), top=['A','K','Q','J','T'].filter(r=>cards.includes(r)).length;
        if(top>=3 && (!ctx.isLegal||ctx.isLegal(history,'4H',seat))) return {call:'4H',changed:raw!=='4H',semantic:{natural:true,source:'course15-opener-pulls-3NT-to-good-six-heart-major',suits:{H:{min:6,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course15-notrump'},reason:'cours 15 : six bons Cœurs chez l’ouvreur après 3SA => retour automatique à 4H'};
      }

      // Après le soutien propositionnel de la deuxième mineure au palier de 3 :
      // passe sans réserves ; avec 14/15+, montrer d'abord trois cartes dans la
      // majeure du répondant, sinon conclure à 3SA si la quatrième couleur est tenue.
      if(economic && r2 && cont.call===`3${r2.strain}`){
        if(H<=12) return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course15-opener-passes-second-minor-fit',hcp:{min:0,max:12},forcing:'nonforcing',publishWhenNative:true,convention:'course15-minor-fit'},reason:`cours 15 : soutien mineur propositionnel et ouvreur sans réserves (${H} H) => passe`};
        if(H>=14 && L[rb.strain]===3){
          const target=`3${rb.strain}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course15-opener-delayed-major-fit-after-minor-support',suits:{[rb.strain]:{min:3,max:3}},hcp:{min:14,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course15-minor-fit'},reason:`cours 15 : ouvreur positif, soutien mineur propositionnel et trois cartes dans la majeure du répondant => ${target} (essai non forcing)`};
        }
        const fourth=SUITS.find(s=>![ob.strain,rb.strain,r2.strain].includes(s));
        if(H>=14 && fourth && stopperScore(ctx.deal,seat,fourth)>=0.7 && (!ctx.isLegal||ctx.isLegal(history,'3NT',seat))) return {call:'3NT',changed:raw!=='3NT',semantic:{natural:true,source:'course15-opener-3NT-after-minor-support',hcp:{min:14,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course15-minor-fit'},reason:`cours 15 : ouvreur positif avec arrêt ${fourth} après soutien mineur => 3SA`};
      }

      // Après la répétition simple de la majeure sixième du répondant, un ouvreur
      // qui possède trois cartes ne passe jamais. 3M propose ; 4M conclut avec une
      // évaluation HLD suffisante.
      const repeat=parseBid(cont.call);
      if(economic && repeat?.level===2 && repeat.strain===rb.strain && L[rb.strain]>=3 && raw==='PASS'){
        const fitHld=supportHld(ctx.deal,seat,rb.strain), target=fitHld>=19?`4${rb.strain}`:`3${rb.strain}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:true,semantic:{natural:true,source:'course15-opener-never-passes-six-card-major-fit',suits:{[rb.strain]:{min:3,max:13}},hcp:{min:0,max:37},forcing:target[0]==='3'?'nonforcing':'nonforcing',publishWhenNative:true,convention:'course15-major-repeat'},reason:`cours 15 : fit de trois cartes face à la majeure répétée => PASS interdit ; ${fitHld} HLD => ${target}`};
      }

      // Soutien différé fort à 3H : forcing au moins jusqu'à la manche. Si PONS
      // veut passer, le minimum est de conclure à 4H. A contrario 4H est un arrêt.
      if(economic && ob.strain==='H' && rb.strain==='S' && cont.call==='3H' && raw==='PASS' && (!ctx.isLegal||ctx.isLegal(history,'4H',seat))) return {call:'4H',changed:true,semantic:{natural:true,source:'course15-opener-minimum-after-delayed-heart-slam-try',suits:{H:{min:5,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course15-delayed-major-fit'},reason:'cours 15 : 3H différé est forcing et montre un espoir de chelem ; PASS interdit, minimum 4H'};
      if(economic && ob.strain==='H' && rb.strain==='S' && cont.call==='4H'){
        const openerHL=hlPoints(ctx.deal,seat);
        // 4H décrit 13-15 HLD chez le répondant mais n'interdit pas à un ouvreur
        // maximum de poursuivre. Seuil volontairement conservateur : avec moins de
        // 18 H, on garde l'arrêt de manche ; à 18 H+ on laisse vivre une continuation
        // naturelle/chelemisante proposée par le moteur.
        if(H<=17) return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course15-opener-respects-delayed-heart-game',forcing:'nonforcing',publishWhenNative:true,convention:'course15-delayed-major-fit'},reason:`cours 15 : 4H différé limite le répondant ; ouvreur ${H} H / ${openerHL} HL sans réserve suffisante => arrêt`};
        if(raw!=='PASS') return {call:raw,changed:false,semantic:{natural:true,source:'course15-opener-maximum-may-continue-over-delayed-heart-game',forcing:'unknown',publishWhenNative:true,convention:'course15-delayed-major-fit'},reason:`cours 15 : 4H limite le répondant mais l'ouvreur maximum (${H} H / ${openerHL} HL) peut poursuivre vers le chelem`};
      }

      // Soutien à saut de la mineure d'ouverture (3D) = forcing de manche. On ne
      // tente pas de construire toute la suite : si PONS passe, 3SA avec l'arrêt de
      // la dernière couleur, sinon 4D comme minimum naturel.
      if(economic && ob.strain==='D' && cont.call==='3D' && raw==='PASS'){
        const fourth=SUITS.find(s=>![ob.strain,rb.strain,r2.strain].includes(s));
        const target=fourth&&stopperScore(ctx.deal,seat,fourth)>=0.7?'3NT':'4D';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:true,semantic:{natural:true,source:'course15-opener-after-game-force-diamond-fit',suits:{D:{min:5,max:13}},hcp:{min:0,max:37},forcing:target==='3NT'?'nonforcing':'game_if_uncontested',publishWhenNative:true,convention:'course15-minor-fit'},reason:`cours 15 : 3D est forcing de manche ; PASS interdit => ${target}`};
      }
    }

    // Cours 15 — enchère de préférence après un bicolore économique de l'ouvreur.
    // En majeure, le retour à 2M dénie le vrai fit (exactement deux cartes) et permet
    // au répondant faible de maintenir le dialogue sans promettre six cartes dans sa
    // propre majeure. Après 1D-...-2C, 2D joue le même rôle, mais peut aussi être un fit.
    if(relHistory.length===6){
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call);
      const clean=open.seat===partner && p1.call==='PASS' && resp.seat===seat && p2.call==='PASS' && rebid.seat===partner && p3.call==='PASS' &&
        ob?.level===1 && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && r2?.level===2 && r2.strain!=='NT' && r2.strain!==ob.strain && r2.strain!==rb.strain;
      if(clean && H<=10 && L[rb.strain]<=5 && L[r2.strain]<=3){
        const fourthSuit=SUITS.find(suit=>![ob.strain,rb.strain,r2.strain].includes(suit));
        if(ob.strain==='H' && rb.strain==='S' && L.H===2 && (!fourthSuit || L[fourthSuit]<=4)){
          const target='2H';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
            call:target,changed:raw!==target,
            semantic:{natural:true,source:'course15-major-preference',suits:{H:{min:2,max:2},S:{min:0,max:5}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course15-preference'},
            reason:`cours 15 : après le bicolore économique, exactement deux Cœurs et ${H} H sans autre enchère => préférence à 2H`
          };
        }
        if(ob.strain==='D' && r2.strain==='C' && L.D>=2){
          const other=rb.strain==='H'?'S':'H';
          if(L[other]<=3){
            const target='2D';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course15-diamond-preference',suits:{D:{min:2,max:13},[rb.strain]:{min:0,max:5}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course15-preference'},
              reason:`cours 15 : après 1D-${resp.call}-2C, main faible sans autre enchère => préférence à 2D`
            };
          }
        }
      }
    }

    // Cours 15 — l'ouvreur respecte une préférence faible : avec 13 H ou moins,
    // il n'essaie pas d'améliorer le contrat partiel. On laisse volontairement les
    // mains de 14 H à PONS, le cours autorisant alors une action avec espoir de fit majeur.
    if(relHistory.length===8){
      const [open,p1,resp,p2,rebid,p3,pref,p4]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call);
      const clean=open.seat===seat && p1.call==='PASS' && resp.seat===partner && p2.call==='PASS' && rebid.seat===seat && p3.call==='PASS' && pref.seat===partner && p4.call==='PASS' &&
        ob?.level===1 && rb?.level===1 && r2?.level===2 && H<=13;
      const majorPref=clean && ob.strain==='H' && rb.strain==='S' && (r2.strain==='C'||r2.strain==='D') && pref.call==='2H';
      const diamondPref=clean && ob.strain==='D' && r2.strain==='C' && (rb.strain==='H'||rb.strain==='S') && pref.call==='2D';
      if(majorPref||diamondPref){
        return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course15-opener-respects-preference',hcp:{min:0,max:13},forcing:'nonforcing',publishWhenNative:true,convention:'course15-preference'},reason:`cours 15 : préférence faible du répondant et ouvreur limité à ${H} H => passe`};
      }
    }


    // Cours 19 — cas rare 1H-1S-1SA-2C-2D-2H : après l'échec de la
    // recherche de fit Pique, 2H est une maxi-préférence et constitue un arrêt.
    if(relHistory.length===12){
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,pref,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && open.call==='1H' && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call==='2C' && p4.call==='PASS' &&
        answer.seat===seat && answer.call==='2D' && p5.call==='PASS' && pref.seat===partner && pref.call==='2H' && p6.call==='PASS';
      if(frame) return {call:'PASS',changed:raw!=='PASS',semantic:{natural:true,source:'course19-opener-respects-roudi-heart-maxi-preference',forcing:'nonforcing',publishWhenNative:true,convention:'course19-heart-preference'},reason:'cours 19 : après Roudi sans fit Pique, 2H est une maxi-préférence d’arrêt ; l’ouvreur passe'};
    }

    // Cours 19 — après un Roudi fitté à Pique, 3H recherche encore le fit 4-4
    // à Cœur et reste forcing de manche. Si PONS envisage PASS, l'ouvreur choisit
    // la manche à Cœur avec quatre cartes, sinon la manche dans le fit Pique déjà connu.
    if(raw==='PASS' && relHistory.length===12){
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,search,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && (open.call==='1C'||open.call==='1D'||open.call==='1H') && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call==='2C' && p4.call==='PASS' && answer.seat===seat && (answer.call==='2H'||answer.call==='2S') && p5.call==='PASS' && search.seat===partner && search.call==='3H' && p6.call==='PASS';
      if(frame){const target=L.H>=4?'4H':'4S'; if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:true,semantic:{natural:true,source:'course19-opener-after-fitted-roudi-heart-search',forcing:'nonforcing',publishWhenNative:true,convention:'course19-roudi-development'},reason:`cours 19 : après Roudi fitté Pique puis 3H forcing, choix de manche => ${target}`};}
    }

    // Cours 18 — après un Roudi qui a trouvé le fit, la répétition de la majeure
    // au palier de 3 avec 17 HL+ est forcing et constitue un essai de chelem. Si PONS
    // envisage PASS, on garantit au minimum la manche dans la majeure connue fittée.
    // On ne remplace aucune enchère PONS non-PASS : les contrôles/cue-bids restent au moteur.
    if(raw==='PASS' && relHistory.length===12){
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,slamTry,p6]=relHistory, partner=partnerOf(seat), rb=parseBid(resp.call);
      const fitAnswer=answer.call==='2H'||answer.call==='2S';
      const frame=open.seat===seat && p1.call==='PASS' && resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call==='2C' && p4.call==='PASS' &&
        answer.seat===seat && fitAnswer && p5.call==='PASS' && slamTry.seat===partner && slamTry.call===`3${rb.strain}` && p6.call==='PASS';
      if(frame){
        const target=`4${rb.strain}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course18-opener-rejects-slam-try-at-game',suits:{[rb.strain]:{min:3,max:13}},hcp:{min:12,max:14},forcing:'nonforcing',publishWhenNative:true,convention:'course18-roudi-development'},
          reason:`cours 18 : 3${rb.strain} après Roudi fitté est forcing ; PASS interdit, rejet minimal du chelem à 4${rb.strain}`
        };
      }
    }

    // Cours 19 — après Roudi, réponse 2D (pas de fit Pique), puis 3H du
    // répondant : l'enchère est forcing de manche. Si PONS veut passer, l'ouvreur
    // montre le fit Cœur à 4H ; sans fit, il choisit 3SA avec l'arrêt de la dernière
    // couleur, ou 3S sans cet arrêt. Ce dernier relais reste forcing de manche.
    if(raw==='PASS' && relHistory.length===12){
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,hearts,p6]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call);
      const frame=open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' && resp.seat===partner && resp.call==='1S' && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===partner && roudi.call==='2C' && p4.call==='PASS' &&
        answer.seat===seat && answer.call==='2D' && p5.call==='PASS' && hearts.seat===partner && hearts.call==='3H' && p6.call==='PASS';
      if(frame){
        let target,forcing='nonforcing';
        if(L.H>=4) target='4H';
        else {
          const last=ob.strain==='C'?'D':'C';
          if(stopperScore(ctx.deal,seat,last)>=0.7) target='3NT';
          else {target='3S';forcing='game_if_uncontested';}
        }
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:target!=='3S',source:'course19-opener-after-roudi-3H-game-force',suits:{H:{min:L.H>=4?4:0,max:L.H>=4?13:3}},hcp:{min:12,max:19},forcing,publishWhenNative:true,convention:'course19-roudi-development'},
          reason:`cours 19 : 3H après Roudi sans fit Pique est forcing de manche ; PASS interdit => ${target}`
        };
      }
    }

    // Si l'ouvreur a dû dire 3S faute d'arrêt pour 3SA, cette enchère reste sous
    // la manche et forcing. Un PASS brut du répondant est remplacé par le minimum 4S.
    if(raw==='PASS' && relHistory.length===14){
      const [open,p1,resp,p2,rebid,p3,roudi,p4,answer,p5,hearts,p6,openerRelay,p7]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call);
      const frame=open.seat===partner && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' && resp.seat===seat && resp.call==='1S' && p2.call==='PASS' &&
        rebid.seat===partner && rebid.call==='1NT' && p3.call==='PASS' && roudi.seat===seat && roudi.call==='2C' && p4.call==='PASS' && answer.seat===partner && answer.call==='2D' && p5.call==='PASS' &&
        hearts.seat===seat && hearts.call==='3H' && p6.call==='PASS' && openerRelay.seat===partner && openerRelay.call==='3S' && p7.call==='PASS';
      if(frame){
        const target='4S';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:true,semantic:{natural:true,source:'course19-responder-completes-game-after-3S-relay',suits:{S:{min:5,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course19-roudi-development'},reason:'cours 19 : 3S de l’ouvreur après 3H reste forcing de manche ; conclusion minimale à 4S'};
      }
    }

    // Cours 13/14 — deuxième enchère du répondant après une réponse au palier de 1.
    // Une répétition naturelle promet normalement six cartes et n'est jamais forcing.
    // Avec une main forte (12 H+), répéter serait dangereux : lorsque trois couleurs ont
    // été nommées, on transite par la quatrième couleur forcing avant de répéter.
    if(relHistory.length===6){
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call);
      const clean=open.seat===partner && ob?.level===1 && p1.call==='PASS' && resp.seat===seat && rb?.level===1 && rb.strain!=='NT' &&
        p2.call==='PASS' && rebid.seat===partner && r2 && r2.strain!=='NT' && r2.strain!==rb.strain && r2.level<=2 && p3.call==='PASS';
      if(clean && L[rb.strain]>=6){
        const HL=hlPoints(ctx.deal,seat), low=`2${rb.strain}`, high=`3${rb.strain}`;
        const threeSuits=new Set([ob.strain,rb.strain,r2.strain]).size===3;
        if(H>=12 && threeSuits){
          const fourth=SUITS.find(s=>![ob.strain,rb.strain,r2.strain].includes(s));
          const target=fourth?cheapestSuitCallAfter(history,fourth):null;
          if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
            const economic=bidRank(target)<bidRank(`2${rb.strain}`);
            return {
              call:target,changed:raw!==target,
              semantic:{natural:false,source:'course16-fourth-forcing-before-strong-repeat',suits:{[rb.strain]:{min:6,max:13}},hcp:{min:12,max:37},forcing:economic?'one_round_if_uncontested':'game_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},
              reason:`cours 14/16 : ${H} H et six ${rb.strain} => trop fort pour une répétition non forcing ; passage par la quatrième forcing ${target}`
            };
          }
        }
        if(H<12 && bidRank(low)>bidRank(rebid.call) && (!ctx.isLegal||ctx.isLegal(history,low,seat))){
          if(HL<=10){
            return {call:low,changed:raw!==low,semantic:{natural:true,source:'course13-simple-repeat-six',suits:{[rb.strain]:{min:6,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course13-responder-repeat'},reason:`cours 13 : six ${rb.strain}, ${HL} HL => répétition simple non forcing ${low}`};
          }
          if(HL>=11 && HL<=12 && (!ctx.isLegal||ctx.isLegal(history,high,seat))){
            const cards=String(ctx.deal?.hands?.[seat]?.[rb.strain]||''), top=['A','K','Q','J','T'].filter(r=>cards.includes(r)).length;
            if(top>=3){
              return {call:high,changed:raw!==high,semantic:{natural:true,source:'course13-jump-repeat-six',suits:{[rb.strain]:{min:6,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course13-responder-repeat'},reason:`cours 13 : six ${rb.strain} de bonne qualité, ${HL} HL => répétition à saut ${high}, non forcing`};
            }
          }
        }
      }
    }

    // Cours 16 — réponse de l'ouvreur à une quatrième forcing économique.
    // Priorité absolue : montrer trois cartes dans la majeure du répondant. A défaut,
    // une enchère à SA garantit l'arrêt dans la quatrième couleur et zone la main.
    if(relHistory.length===8){
      const [open,p1,resp,p2,rebid,p3,fourth,p4]=relHistory, partner=partnerOf(seat), ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call);
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set();
      const missing=SUITS.find(s=>!named.has(s));
      const clean=open.seat===seat && ob?.level===1 && p1.call==='PASS' && resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        p2.call==='PASS' && rebid.seat===seat && r2 && r2.strain!=='NT' && r2.strain!==rb.strain && p3.call==='PASS' && fourth.seat===partner &&
        f4 && missing===f4.strain && p4.call==='PASS' && named.size===3;
      if(clean){
        const economic=bidRank(fourth.call)<bidRank(`2${rb.strain}`);
        {
          // Les mêmes priorités descriptives s'appliquent aussi à la quatrième
          // forcing chère. La différence porte sur le statut (FM), pas sur le droit
          // de l'ouvreur à passer : dans les deux cas, PASS est interdit.
          let target=null, semantic=null, reason='';
          if(L[rb.strain]===3){
            // Le palier dépend de l'espace consommé par la 4e forcing : 2M après
            // une 4e économique, mais 3M si 2M est déjà dépassé.
            target=cheapestSuitCallAfter(history,rb.strain);
            if(H>=15 && H<=17 && !strictBalanced(L)){
              const tb=parseBid(target);
              if(tb && tb.level===2){
                const jump=`3${rb.strain}`;
                if(!ctx.isLegal||ctx.isLegal(history,jump,seat)) target=jump;
              }
            }
            if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
              semantic={natural:true,source:'course16-opener-three-card-support-after-fourth',suits:{[rb.strain]:{min:3,max:3}},hcp:{min:H>=15&&H<=17?15:12,max:H>=15&&H<=17?17:19},forcing:'unknown',publishWhenNative:true,convention:'course16-fourth-forcing-response'};
              reason=`cours 16 : priorité n°1 après quatrième forcing = montrer trois cartes à ${rb.strain}; ${H} H => ${target}`;
              return {call:target,changed:raw!==target,semantic,reason};
            }
          }

          // Priorité n°2 du cours 16 : avant de nommer les Sans-Atout, décrire une
          // distribution nettement plus irrégulière que celle déjà connue (6-4 ou 5-5).
          // Une répétition à saut de la couleur d'ouverture, lorsqu'un palier simple est
          // encore disponible, zone la main à 15/17 H ; la répétition simple reste la
          // description de première zone. Répéter la deuxième couleur la rallonge à cinq.
          if(L[rb.strain]<=2){
            const openRepeat=cheapestSuitCallAfter(history,ob.strain);
            if(L[ob.strain]>=6 && openRepeat){
              let distTarget=openRepeat;
              const opb=parseBid(openRepeat);
              if(H>=15&&H<=17&&opb?.level===2){
                const jump=`3${ob.strain}`;
                if(!ctx.isLegal||ctx.isLegal(history,jump,seat)) distTarget=jump;
              }
              if(!ctx.isLegal||ctx.isLegal(history,distTarget,seat)){
                return {
                  call:distTarget,changed:raw!==distTarget,
                  semantic:{natural:true,source:'course16-opener-long-opening-suit-after-fourth',suits:{[ob.strain]:{min:6,max:13}},hcp:{min:H>=15&&H<=17?15:12,max:H>=15&&H<=17?17:19},forcing:'unknown',publishWhenNative:true,convention:'course16-fourth-forcing-response'},
                  reason:`cours 16 : priorité à la distribution après quatrième forcing ; ${L[ob.strain]} ${ob.strain} et ${H} H => ${distTarget}`
                };
              }
            }
            if(L[r2.strain]>=5){
              const distTarget=cheapestSuitCallAfter(history,r2.strain);
              if(distTarget && (!ctx.isLegal||ctx.isLegal(history,distTarget,seat))){
                return {
                  call:distTarget,changed:raw!==distTarget,
                  semantic:{natural:true,source:'course16-opener-long-second-suit-after-fourth',suits:{[r2.strain]:{min:5,max:13}},hcp:{min:12,max:19},forcing:'unknown',publishWhenNative:true,convention:'course16-fourth-forcing-response'},
                  reason:`cours 16 : la deuxième couleur est réellement cinquième ; priorité à sa répétition ${distTarget}`
                };
              }
            }
          }

          if(L[rb.strain]<=2 && stopperScore(ctx.deal,seat,f4.strain)>=0.7){
            if(H>=15 && H<=17) target='3NT';
            else if((H>=11&&H<=14)||(H>=18&&H<=19)) target='2NT';
            // Une 4e forcing chère peut avoir déjà dépassé 2SA. Dans ce cas,
            // 3SA est la traduction légale de la même priorité à Sans-Atout.
            if(target==='2NT' && ctx.isLegal && !ctx.isLegal(history,target,seat) && ctx.isLegal(history,'3NT',seat)) target='3NT';
            if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
              semantic={natural:true,source:'course16-opener-NT-after-fourth',hcp:{min:H>=15&&H<=17?15:12,max:H>=15&&H<=17?17:19},forcing:'unknown',publishWhenNative:true,convention:'course16-fourth-forcing-response'};
              reason=`cours 16 : pas de fit troisième mais arrêt ${f4.strain}; ${H} H => ${target}`;
              return {call:target,changed:raw!==target,semantic,reason};
            }
          }

          // Si les deux priorités positives échouent (pas de fit troisième, pas de
          // distribution à allonger, pas d'arrêt dans la quatrième couleur), le cours
          // impose une enchère de pis-aller. Après un 1-sur-1, le « ni-ni » consiste à
          // répéter la deuxième couleur de l'ouvreur ; après un bicolore économique,
          // on peut être contraint de répéter la couleur d'ouverture. Sur ouverture
          // majeure, la répétition au palier de 2 est explicitement une enchère poubelle.
          if(L[rb.strain]<=2 && stopperScore(ctx.deal,seat,f4.strain)<0.7){
            let fallback=null, fbSuit=null;
            if(ob.strain==='H'||ob.strain==='S'){
              fbSuit=ob.strain; fallback=cheapestSuitCallAfter(history,fbSuit);
            } else if(r2.level===1){
              fbSuit=r2.strain; fallback=cheapestSuitCallAfter(history,fbSuit); // ni-ni
            } else {
              fbSuit=ob.strain; fallback=cheapestSuitCallAfter(history,fbSuit);
            }
            if(fallback && (!ctx.isLegal||ctx.isLegal(history,fallback,seat))){
              return {
                call:fallback,changed:raw!==fallback,
                semantic:{natural:true,source:'course16-opener-fallback-after-fourth',suits:{[fbSuit]:{min:ob.strain===fbSuit?Math.min(5,L[fbSuit]):Math.min(4,L[fbSuit]),max:13}},hcp:{min:12,max:19},forcing:'unknown',publishWhenNative:true,convention:'course16-fourth-forcing-response'},
                reason:`cours 16 : ni fit troisième, ni arrêt ${f4.strain}, ni distribution plus précise à montrer => enchère de pis-aller ${fallback}`
              };
            }
          }
        }
      }
    }

    // Cours 16 — quatrième forcing après une réponse initiale mineure, par ex.
    // 1C-1D-1S-2H. Le bloc principal ci-dessus est centré sur la recherche du fit
    // majeur 5-3 ; cette famille demande surtout une enchère descriptive de l'ouvreur.
    // PASS reste interdit. On privilégie SA avec l'arrêt de la quatrième couleur, puis
    // la répétition naturelle de l'ouverture si aucune enchère à SA n'est disponible.
    if(history.length===8 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3,fourth,p4]=history, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call);
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set();
      const missing=SUITS.find(x=>!named.has(x));
      const frame=open.seat===seat && open.call==='1C' && p1.call==='PASS' && resp.seat===partner && resp.call==='1D' && p2.call==='PASS' &&
        rebid.seat===seat && r2?.level===1 && (r2.strain==='H'||r2.strain==='S') && p3.call==='PASS' && fourth.seat===partner &&
        f4 && f4.strain===missing && p4.call==='PASS';
      if(frame){
        let target=null;
        if(stopperScore(ctx.deal,seat,f4.strain)>=0.7){
          target=H>=18?'3NT':'2NT';
          if(ctx.isLegal && !ctx.isLegal(history,target,seat)) target=null;
        }
        if(!target && L.C>=5) target=cheapestSuitCallAfter(history,'C');
        if(!target && L[r2.strain]>=5) target=cheapestSuitCallAfter(history,r2.strain);
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course16-opener-minor-first-response-after-fourth',suits:target.endsWith('C')?{C:{min:5,max:13}}:{},hcp:{min:H,max:19},forcing:'unknown',publishWhenNative:true,convention:'course16-fourth-forcing-response'},
          reason:`cours 16 : quatrième forcing ${fourth.call}, PASS interdit ; réponse descriptive ${target}`
        };
      }
    }

    // Cours 27 : cadrage des ouvertures fortes du SEF. Le noyau PONS utilise encore
    // un 2D faible à six cartes ; dans le système des fiches, 2D est au contraire forcing
    // de manche. On neutralise donc uniquement cette collision certaine, et on recale les
    // zones régulières/semi-régulières les plus objectives. Les distributions de jugement
    // (5-4-2-2, unicolores évalués en levées de jeu, bicolores en perdantes) restent à PONS.
    // v2.44 — même collision après un ou plusieurs Passe initiaux : le noyau
    // peut encore produire son ancien 2D faible naturel. Sur 20 000 donnes auditées,
    // tous les 2D d'ouverture apparus après Passe(s) étaient précisément des mains
    // <=10 H avec six Carreaux. On neutralise uniquement ce cas, sans recadrer les
    // ouvertures fortes après Passe (expérience rejetée en v2.42).
    if(history.length>0 && history.every(x=>x.call==='PASS') && raw==='2D' && H<=10 && L.D===6){
      return {call:'PASS',changed:true,semantic:{natural:false,source:'v244-disable-weak-2D-after-initial-passes',hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'course27-no-weak-two-diamonds'},reason:`cours 27 : après Passe(s) initial(aux), le 2D faible natif PONS (${H} H, six Carreaux) reste incompatible avec le 2D forcing de manche => Passe`};
    }

    if(history.length===0){
      const HL=hlPoints(ctx.deal,seat), ntShape=strongNtShape(L);
      let target=null, semantic=null, reason='';
      if(raw==='2D' && H<=10 && L.D===6){
        target='PASS';
        semantic={natural:false,source:'course27-disable-weak-2D',hcp:{min:0,max:10},forcing:'nonforcing',convention:'course27-no-weak-two-diamonds'};
        reason=`cours 27 : 2D est forcing de manche dans le SEF ; le 2D faible PONS (${H} H, six Carreaux) est supprimé`;
      } else if(H>=24){
        target='2D';
        semantic={natural:false,source:'course27-2D-forcing-game',hcp:{min:24,max:37},forcing:'game_if_uncontested',convention:'course27-2D-forcing-game'};
        reason=`cours 27 : ${H} H garantissent au moins 24 HL => ouverture forcing de manche 2D`;
      } else if(ntShape && HL>=24){
        target='2D';
        semantic={natural:false,source:'course27-2D-strong-NT-zone',hcp:{min:0,max:37},forcing:'game_if_uncontested',convention:'course27-2D-forcing-game'};
        reason=`cours 27 : main régulière/semi-régulière ${HL} HL => 2D puis redemande à SA`;
      } else if(ntShape && HL>=22 && HL<=23){
        target='2C';
        semantic={natural:false,source:'course27-2C-strong-NT-zone',hcp:{min:0,max:37},forcing:'one_round_if_uncontested',convention:'course27-2C-strong-indeterminate'};
        reason=`cours 27 : main régulière/semi-régulière ${HL} HL => 2C fort indéterminé`;
      } else if(ntShape && HL>=20 && HL<=21){
        target='2NT';
        semantic={natural:true,source:'course27-2NT-strong-NT-zone',hcp:{min:0,max:37},forcing:'nonforcing',convention:'course27-2NT-20-21-HL'};
        reason=`cours 27 : main régulière/semi-régulière ${HL} HL => ouverture de 2SA`;
      } else {
        // Cours 27, conclusion sur les unicolores sixièmes : avec une seule
        // couleur longue exactement sixième, 18-21 H se traitent par 2C si la
        // couleur est majeure, mais par une ouverture au palier de 1 si elle est
        // mineure ; à partir de 22 H, l'ouverture forcing de manche 2D s'impose.
        // On exige ici une vraie structure unicolore (aucune couleur latérale 4e)
        // afin de ne pas empiéter sur les bicolores forts, traités différemment.
        // Cours 27 : les bicolores majeurs au moins 5-5 sont une exception
        // importante. A trois perdantes ils relèvent de 2C fort indéterminé ; avec
        // deux perdantes au plus, ils sont assez puissants pour 2D forcing de manche.
        // On exige aussi le minimum moderne de 15 H mentionné par le cours.
        const majorBicolor=(L.H>=5 && L.S>=5 && L.H+L.S>=10);
        if(majorBicolor && H>=15){
          const losers=losingTricks(ctx.deal,seat);
          if(losers<=2){
            target='2D';
            semantic={natural:false,source:'course27-2D-major-bicolor-two-losers',suits:{H:{min:5,max:13},S:{min:5,max:13}},hcp:{min:15,max:37},forcing:'game_if_uncontested',convention:'course27-2D-forcing-game'};
            reason=`cours 27 : bicolore majeur ${L.H}-${L.S} de ${losers} perdantes => 2D forcing de manche`;
          } else if(losers===3){
            target='2C';
            semantic={natural:false,source:'course27-2C-major-bicolor-three-losers',suits:{H:{min:5,max:13},S:{min:5,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',convention:'course27-2C-strong-indeterminate'};
            reason=`cours 27 : bicolore majeur ${L.H}-${L.S} de trois perdantes => 2C fort indéterminé`;
          }
        }

        // Cours 27 : 21-23 HL avec une belle majeure cinquième et une
        // deuxième couleur quatrième peuvent également passer par 2C. Pour éviter
        // les cas de jugement, on exige exactement cinq cartes, deux gros honneurs
        // (A/R/D) et au moins un appui J/10/9 dans la majeure.
        const fiveMajor=['H','S'].find(m=>L[m]===5 && goodMajorFive(ctx.deal,seat,m) &&
          SUITS.some(s=>s!==m && L[s]===4));
        if(!target && fiveMajor && HL>=21 && HL<=23){
          target='2C';
          semantic={natural:false,source:'course27-2C-good-five-major-side-four',suits:{[fiveMajor]:{min:5,max:5}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',convention:'course27-2C-strong-indeterminate'};
          reason=`cours 27 : ${HL} HL, belle majeure cinquième ${fiveMajor} et seconde couleur quatrième => 2C fort indéterminé`;
        }

        const six=SUITS.filter(s=>L[s]===6);
        if(!target && six.length===1 && SUITS.filter(s=>s!==six[0]).every(s=>L[s]<=3)){
          const s=six[0], isMajor=(s==='H'||s==='S');
          if(H>=22){
            target='2D';
            semantic={natural:false,source:'course27-2D-six-card-unicolor-22plus',suits:{[s]:{min:6,max:6}},hcp:{min:22,max:37},forcing:'game_if_uncontested',convention:'course27-2D-forcing-game'};
            reason=`cours 27 : unicolore sixième ${s} de ${H} H => 2D forcing de manche`;
          } else if(isMajor && H>=18 && H<=21){
            target='2C';
            semantic={natural:false,source:'course27-2C-six-card-major-18-21',suits:{[s]:{min:6,max:6}},hcp:{min:18,max:21},forcing:'one_round_if_uncontested',convention:'course27-2C-strong-indeterminate'};
            reason=`cours 27 : unicolore majeur sixième de ${H} H => 2C fort indéterminé`;
          } else if(!isMajor && H>=18 && H<=21){
            target=`1${s}`;
            semantic={natural:true,source:'course27-one-minor-six-card-18-21',suits:{[s]:{min:6,max:6}},hcp:{min:18,max:21},forcing:'nonforcing',convention:'course27-strong-six-card-minor-open-one'};
            reason=`cours 27 : unicolore mineur sixième de ${H} H => ouverture naturelle de 1${s}, puis redemande forcing`;
          }
        }
        const seven=SUITS.filter(s=>L[s]===7);
        if(!target && seven.length===1 && SUITS.filter(s=>s!==seven[0]).every(s=>L[s]<=3) && H>=15 && defensiveTricksEstimate(ctx.deal,seat)>=2){
          const s=seven[0], isMajor=(s==='H'||s==='S'), pt=playingTricksEstimate(ctx.deal,seat);
          const gameForce=isMajor?pt>=9:pt>=10;
          const strongTwoC=isMajor?(pt>=8&&pt<9):(pt>=8.5&&pt<10);
          if(gameForce){
            target='2D';
            semantic={natural:false,source:'course27-2D-seven-card-unicolor-playing-tricks',suits:{[s]:{min:7,max:7}},hcp:{min:15,max:37},forcing:'game_if_uncontested',convention:'course27-2D-forcing-game'};
            reason=`cours 27 : unicolore septième ${s}, ${pt} levées de jeu estimées => 2D forcing de manche`;
          } else if(strongTwoC){
            target='2C';
            semantic={natural:false,source:'course27-2C-seven-card-unicolor-playing-tricks',suits:{[s]:{min:7,max:7}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',convention:'course27-2C-strong-indeterminate'};
            reason=`cours 27 : unicolore septième ${s}, ${pt} levées de jeu estimées => 2C fort indéterminé`;
          }
        }
      }
      if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
        return {call:target,changed:raw!==target,semantic,reason};
      }
    }

    // Cours 29 : sur l'ouverture de 2C fort indéterminé et sans intervention,
    // le répondant utilise toujours le relais 2D. Cette règle ne s'applique jamais à
    // une intervention adverse à 2C : on exige que 2C soit le tout premier contrat.
    if(relHistory.length===2){
      const [open,opp]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2C' && opp.call==='PASS' &&
         openingEvent(history)===open && (!ctx.isLegal||ctx.isLegal(history,'2D',seat))){
        return {
          call:'2D',changed:raw!=='2D',
          semantic:{natural:false,source:'course29-2C-mandatory-2D-relay',hcp:{min:0,max:37},forcing:'one_round_if_uncontested',convention:'course29-2C-2D-relay'},
          reason:'cours 29 : après l’ouverture de 2C fort indéterminé, le répondant annonce toujours 2D'
        };
      }

      // Cours 28 : première réponse à l'ouverture de 2SA (20-21 HL).
      // Le cadre est très précis : 0-3 HL = passe ; dès 4 HL la manche est
      // systématiquement atteinte. Le Stayman est prioritaire avec une majeure
      // quatrième ; sans majeure quatrième, Texas avec une majeure cinquième.
      // Une majeure exactement sixième, sans autre majeure quatrième et sans
      // ambition de chelem (4-10 HL), se conclut directement à 4M : le cours
      // précise que cette enchère interdit à l'ouvreur de reparler.
      if(open.seat===partner && open.call==='2NT' && opp.call==='PASS' && openingEvent(history)===open){
        const HL=hlPoints(ctx.deal,seat);
        let target=null, semantic=null, reason='';
        if(HL<=3){
          target='PASS';
          semantic={natural:false,source:'course28-responder-pass-0-3-HL',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-responder-frame'};
          reason=`cours 28 : sur 2SA, ${HL} HL (0-3) => passe obligatoire`;
        } else {
          const sixMajor=['H','S'].find(m=>L[m]===6 && L[m==='H'?'S':'H']<4);
          const major55=L.H===5 && L.S===5;
          if(sixMajor && HL<=10){
            target=`4${sixMajor}`;
            semantic={natural:true,source:'course28-responder-direct-game-six-major',suits:{[sixMajor]:{min:6,max:6}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-six-major-stop'};
            reason=`cours 28 : majeure sixième et ambitions limitées à la manche (${HL} HL) => ${target} direct, enchère d'arrêt`;
          } else if(major55){
            // Le cours réserve 4D à deux extrêmes du 5-5 majeur : les jeux sans
            // ambition de chelem et ceux où le chelem est presque certain. La zone
            // intermédiaire commence par un Texas Pique (3H) puis nomme les Cœurs.
            if(HL<=8 || HL>=13){
              target='4D';
              semantic={natural:false,source:'course28-responder-major-55-direct-4D',suits:{H:{min:5,max:5},S:{min:5,max:5}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-major-55'};
              reason=`cours 28 : bicolore majeur 5-5 en zone ${HL<=8?'sans ambition de chelem':'de chelem fort'} => réponse spécifique 4D`;
            } else {
              target='3H';
              semantic={natural:false,source:'course28-responder-major-55-intermediate-texas-spades',suits:{H:{min:5,max:5},S:{min:5,max:5}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-major-55-intermediate'};
              reason=`cours 28 : bicolore majeur 5-5 intermédiaire (${HL} HL) => Texas Pique 3H, Cœurs au tour suivant`;
            }
          } else if(!sixMajor || HL<=10){
            // Le Stayman est prioritaire avec une majeure exactement quatrième,
            // notamment dans les 5-4/6-4. Une majeure seulement cinquième, sans
            // autre majeure quatrième, se traite en revanche par Texas.
            if(L.H===4 || L.S===4){
              target='3C';
              semantic={natural:false,source:'course28-responder-stayman-first',hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-stayman'};
              reason='cours 28 : avec une majeure quatrième, le Stayman est prioritaire sur 2SA';
            } else if(L.H>=5){
              target='3D';
              semantic={natural:false,source:'course28-responder-texas-hearts-first',suits:{H:{min:5,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-texas-hearts'};
              reason='cours 28 : sans majeure quatrième annexe, cinq Cœurs ou plus => Texas 3D';
            } else if(L.S>=5){
              target='3H';
              semantic={natural:false,source:'course28-responder-texas-spades-first',suits:{S:{min:5,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-texas-spades'};
              reason='cours 28 : sans majeure quatrième annexe, cinq Piques ou plus => Texas 3H';
            } else if(HL>=11 && L.C>=5 && L.D>=5){
              target='3S';
              semantic={natural:false,source:'course28-responder-minor-55-texas-clubs',suits:{C:{min:5,max:13},D:{min:5,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-minor-slam-try'};
              reason=`cours 28 : bicolore mineur 5-5 avec ambition de chelem (${HL} HL) => commencer par le Texas Trèfle 3S`;
            } else if(HL>=11 && L.C>=6){
              target='3S';
              semantic={natural:false,source:'course28-responder-texas-clubs',suits:{C:{min:6,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-texas-clubs'};
              reason=`cours 28 : six Trèfles et au moins 11 HL => Texas facultatif 3S`;
            } else if(HL>=11 && L.D>=6){
              target='4C';
              semantic={natural:false,source:'course28-responder-texas-diamonds',suits:{D:{min:6,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-texas-diamonds'};
              reason=`cours 28 : six Carreaux et au moins 11 HL => Texas Carreau 4C`;
            } else if(HL>=13 && HL<=15){
              target='6NT';
              semantic={natural:true,source:'course28-responder-direct-small-slam',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-quantitative-frame'};
              reason=`cours 28 : sans fit apparent, ${HL} HL (13-15) => petit chelem 6SA`;
            } else if(HL>=11 && HL<=12){
              target='4NT';
              semantic={natural:true,source:'course28-responder-quantitative-4NT',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-quantitative-frame'};
              reason=`cours 28 : sans fit apparent, ${HL} HL (11-12) => 4SA quantitatif`;
            } else if(HL>=4 && HL<=10){
              target='3NT';
              semantic={natural:true,source:'course28-responder-direct-3NT',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-responder-frame'};
              reason=`cours 28 : sans majeure à rechercher, ${HL} HL => manche directe à 3SA`;
            }
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }

      // Cours 30 : réponses à l'As sur une ouverture de 2D explicitement créée/qualifiée
      // comme forcing de manche par le ledger. Ce garde-fou est essentiel : un ancien 2D
      // PONS faible ou une intervention à 2D ne doit jamais être interprété ainsi.
      // Dans cette branche, toute ouverture EFFECTIVE de 2D au premier tour est notre
      // 2D forcing de manche : les faibles 2D natifs du noyau sont supprimés en amont.
      // Le ledger reste la source préférée, mais on ne dépend plus de sa présence pour
      // empêcher un PASS catastrophique du répondant.
      const partnerConvention=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course27-2D-forcing-game')?.convention ||
        ((open.seat===partner && open.call==='2D' && openingEvent(history)===open)?'course27-2D-forcing-game':null);

      // Cours 30 : si l'adversaire intervient sur le 2D forcing de manche, le
      // système change. Sur contre, les réponses à l'As sont conservées mais PASS
      // et XX permettent de distinguer les mains sans As. Sur une intervention à
      // la couleur, les réponses à l'As disparaissent : les enchères redeviennent
      // naturelles, X montrant une main positive sans enchère naturelle.
      if(open.seat===partner && open.call==='2D' && openingEvent(history)===open &&
         partnerConvention==='course27-2D-forcing-game' && opp.call!=='PASS'){
        let target=null, semantic=null, reason='';
        if(opp.call==='X'){
          const A=aceSuits(ctx.deal,seat);
          if(A.length===0){
            target=hasKingAndQueen(ctx.deal,seat)?'XX':'PASS';
            semantic={natural:false,source:'course30-2D-response-after-double-no-ace',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-response-after-double'};
            reason=target==='XX'?'cours 30 : sur le contre de 2D, XX = pas d’As mais main positive (au moins un Roi et une Dame)':'cours 30 : sur le contre de 2D, PASS = pas d’As et pas de jeu positif';
          } else {
            target=course30AceResponse(ctx.deal,seat);
            semantic={natural:false,source:'course30-2D-ace-response-after-double',hcp:{min:0,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-response-after-double'};
            reason=`cours 30 : le contre adverse conserve les réponses à l’As (${A.join('/')}) => ${target}`;
          }
        } else {
          const ib=parseBid(opp.call);
          if(ib && ib.strain!=='NT'){
            const positive=hasKingAndQueen(ctx.deal,seat);
            const natural=SUITS.filter(s=>{
              if(s===ib.strain || L[s]<5 || H<7 || !hasBigHonor(ctx.deal,seat,s)) return false;
              const c=cheapestSuitCallAfter(history,s);
              return c && (!ctx.isLegal||ctx.isLegal(history,c,seat));
            }).map(s=>cheapestSuitCallAfter(history,s));
            const unique=[...new Set(natural.filter(Boolean))];
            if(unique.length===1){
              target=unique[0]; const st=parseBid(target)?.strain;
              semantic={natural:true,source:'course30-2D-natural-response-after-overcall',suits:{[st]:{min:5,max:13}},hcp:{min:7,max:37},forcing:'unknown',publishWhenNative:true,convention:'course30-2D-response-after-overcall'};
              reason=`cours 30 : après intervention à la couleur sur 2D, ${target} est naturel positif, 5+ cartes avec gros honneur`;
            } else if(positive && balanced(L) && stopperScore(ctx.deal,seat,ib.strain)>=0.7 && (!ctx.isLegal||ctx.isLegal(history,'2NT',seat))){
              target='2NT';
              semantic={natural:true,source:'course30-2D-2NT-after-overcall',hcp:{min:0,max:37},forcing:'unknown',publishWhenNative:true,convention:'course30-2D-response-after-overcall'};
              reason=`cours 30 : 2SA naturel positif avec arrêt ${ib.strain} après intervention sur 2D`;
            } else if(positive && (!ctx.isLegal||ctx.isLegal(history,'X',seat))){
              target='X';
              semantic={natural:false,source:'course30-2D-positive-double-after-overcall',hcp:{min:0,max:37},forcing:'unknown',publishWhenNative:true,convention:'course30-2D-response-after-overcall'};
              reason='cours 30 : contre positif (au moins Roi+Dame) sans enchère naturelle après intervention à la couleur sur 2D';
            } else {
              target='PASS';
              semantic={natural:false,source:'course30-2D-weak-pass-after-overcall',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-response-after-overcall'};
              reason='cours 30 : après intervention à la couleur sur 2D, PASS avec jeu faible sans action positive sûre';
            }
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }

      if(open.seat===partner && open.call==='2D' && opp.call==='PASS' &&
         openingEvent(history)===open && partnerConvention==='course27-2D-forcing-game'){
        const target=course30AceResponse(ctx.deal,seat);
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
          const A=aceSuits(ctx.deal,seat);
          return {
            call:target,changed:raw!==target,
            semantic:{natural:false,source:'course30-2D-ace-response',hcp:{min:0,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-ace-response'},
            reason:`cours 30 : réponse à l’As sur 2D forcing de manche (${A.length} As : ${A.join('/')||'aucun'}) => ${target}`
          };
        }
      }
    }

    // Cours 29 : après 2C-passe-2D-passe, une ouverture régulière ou
    // semi-régulière de 22-23 HL se décrit obligatoirement par 2SA. Cette poche
    // est recalculée sur la main privée de l'ouvreur : elle reste donc sûre même
    // si l'ouverture de 2C était déjà native chez PONS et n'avait pas de méta Ledger.
    if(relHistory.length===4){
      const [open,opp,relay,opp2]=relHistory;
      if(open.seat===seat && open.call==='2C' && opp.call==='PASS' &&
         relay.call==='2D' && sideOf(relay.seat)===sideOf(seat) && relay.seat!==seat &&
         opp2.call==='PASS' && openingEvent(history)===open){
        const HL=hlPoints(ctx.deal,seat);
        const majorLosers=(L.H>=5&&L.S>=5)?losingTricks(ctx.deal,seat):99;
        if(H>=15 && majorLosers===3){
          let target=null;
          if(L.H===5 && L.S===5) target='3NT';
          else if(L.H===6 && L.S===5) target='4C';
          else if(L.S===6 && L.H===5) target='4D';
          if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
            return {
              call:target,changed:raw!==target,
              semantic:{natural:false,source:'course29-2C-major-bicolor-rebid',suits:{H:{min:L.H,max:L.H},S:{min:L.S,max:L.S}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-bicolor-rebid'},
              reason:`cours 29 : bicolore majeur ${L.H}-${L.S} de trois perdantes après 2C-2D => ${target}`
            };
          }
        }
        if(strongNtShape(L) && HL>=22 && HL<=23 && (!ctx.isLegal||ctx.isLegal(history,'2NT',seat))){
          return {
            call:'2NT', changed:raw!=='2NT',
            semantic:{natural:true,source:'course29-2C-rebid-2NT',hcp:{min:0,max:37},forcing:'nonforcing',convention:'course29-2C-2NT-22-23-HL'},
            reason:`cours 29 : 2C-2D, main régulière/semi-régulière ${HL} HL => redemande à 2SA`
          };
        }
        const seven=SUITS.filter(s=>L[s]===7 && SUITS.filter(z=>z!==s).every(z=>L[z]<=3));
        if(seven.length===1){
          const s0=seven[0], target=`3${s0}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course29-2C-rebid-seven-card-unicolor',suits:{[s0]:{min:7,max:7}},hcp:{min:15,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course29-2C-seven-card-unicolor-rebid'},
              reason:`cours 29 : après 2C-2D, unicolore septième ${s0} => ${target}`
            };
          }
        }
        const major=['S','H'].find(m=>L[m]>=5 && L[m]<=6 && HL>=20 && HL<=23 &&
          ((L[m]===6 && SUITS.filter(s=>s!==m).every(s=>L[s]<=3)) ||
           (L[m]===5 && goodMajorFive(ctx.deal,seat,m) && SUITS.some(s=>s!==m && L[s]===4))));
        if(major){
          const target=`2${major}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            return {
              call:target,changed:raw!==target,
              semantic:{natural:true,source:'course29-2C-rebid-major',suits:{[major]:{min:5,max:6}},hcp:{min:0,max:37},forcing:'nonforcing',convention:'course29-2C-major-rebid'},
              reason:`cours 29 : 2C-2D, ${L[major]} cartes à ${major} dans la zone 20-23 HL => ${target}`
            };
          }
        }
      }

      // Cours 30 : après une réponse à l'As explicitement créée par la couche
      // sémantique, quelques redemandes de l'ouvreur sont suffisamment objectives
      // pour être corrigées sans deviner. Le garde-fou sur la convention du partenaire
      // empêche d'interpréter un ancien 2D faible PONS comme ouverture forcing de manche.
      const partnerConvention=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course30-2D-ace-response')?.convention;
      if(open.seat===seat && open.call==='2D' && opp.call==='PASS' &&
         sideOf(relay.seat)===sideOf(seat) && relay.seat!==seat && opp2.call==='PASS' &&
         partnerConvention==='course30-2D-ace-response'){
        const HL=hlPoints(ctx.deal,seat);
        let target=null, semantic=null, reason='';

        if(relay.call==='2H'){
          // Convention explicite du cours : 3P montre quatre Piques et au moins
          // cinq Cœurs. On se limite au 5-4 exact côté Cœur pour éviter de masquer
          // une véritable couleur sixième qui doit être nommée naturellement.
          if(L.H===5 && L.S===4){
            target='3S';
            semantic={natural:false,source:'course30-opener-3S-five-hearts-four-spades',suits:{H:{min:5,max:5},S:{min:4,max:4}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-2H-3S-5H4S'};
            reason='cours 30 : après 2D-2H, 3S montre conventionnellement 5 Cœurs et 4 Piques';
          } else if(L.S>=5 && !strongNtShape(L)){
            target='2S';
            semantic={natural:true,source:'course30-opener-2S-after-2H',suits:{S:{min:5,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-spades'};
            reason=`cours 30 : après 2D-2H, ${L.S} Piques se décrivent économiquement par 2S`;
          } else {
            const sixes=SUITS.filter(s=>s!=='S' && L[s]>=6 && (!ctx.isLegal||ctx.isLegal(history,`3${s}`,seat)));
            if(sixes.length===1){
              const s=sixes[0]; target=`3${s}`;
              semantic={natural:true,source:'course30-opener-six-card-suit-level3',suits:{[s]:{min:6,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-six-card-suit'};
              reason=`cours 30 : après la réponse de 2H, une couleur annoncée au palier de 3 garantit six cartes (${L[s]} ${s})`;
            } else if(course30NtRebidShape(L)){
              target='2NT';
              semantic={natural:true,source:'course30-opener-2NT-after-2H',hcp:{min:24,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-2NT'};
              reason=`cours 30 : main régulière/semi-régulière ${HL} HL après 2D-2H => 2SA`;
            }
          }
        } else if(relay.call==='2S'){
          const sixes=SUITS.filter(s=>L[s]>=6 && (!ctx.isLegal||ctx.isLegal(history,`3${s}`,seat)));
          if(sixes.length===1){
            const s=sixes[0]; target=`3${s}`;
            semantic={natural:true,source:'course30-opener-six-card-suit-level3',suits:{[s]:{min:6,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-six-card-suit'};
            reason=`cours 30 : après la réponse de 2S, une couleur au palier de 3 garantit six cartes (${L[s]} ${s})`;
          } else if(course30NtRebidShape(L)){
            target='2NT';
            semantic={natural:true,source:'course30-opener-2NT-after-2S',hcp:{min:24,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-2NT'};
            reason=`cours 30 : main régulière/semi-régulière ${HL} HL après 2D-2S => 2SA`;
          }
        } else if(relay.call==='3C' || relay.call==='3D'){
          // Après une réponse d'As au palier de 3, l'espace est rare : le cours
          // demande de privilégier une majeure au palier de 3 dès qu'elle est
          // réellement descriptive. Une sixième majeure est certaine ; une belle
          // cinquième est admise si la main est irrégulière.
          if(L.H>=6){
            target='3H';
            semantic={natural:true,source:'course30-opener-major-after-level3-ace-response',suits:{H:{min:6,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-major-after-ace'};
            reason=`cours 30 : après ${relay.call}, six Cœurs => redemande économique à 3H`;
          } else if(L.S>=6 || (L.S===5 && goodMajorFive(ctx.deal,seat,'S') && !strongNtShape(L))){
            target='3S';
            semantic={natural:true,source:'course30-opener-major-after-level3-ace-response',suits:{S:{min:5,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-major-after-ace'};
            reason=`cours 30 : après ${relay.call}, belle longueur à Pique => 3S`;
          } else if(L.H===5 && goodMajorFive(ctx.deal,seat,'H') && !strongNtShape(L)){
            target='3H';
            semantic={natural:true,source:'course30-opener-major-after-level3-ace-response',suits:{H:{min:5,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-major-after-ace'};
            reason=`cours 30 : après ${relay.call}, belle longueur à Cœur => 3H`;
          } else {
            // Cours 30 : une mineure au palier de 4 est exceptionnelle et suppose une
            // couleur quasi autonome. Quand elle existe, il vaut mieux la nommer que
            // laisser subsister une enchère PONS arbitraire dans l'autre mineure.
            const autonomousSuit=['C','D'].find(s=>L[s]>=7 && /A/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')) && /K/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')) && /Q/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')));
            if(autonomousSuit){
              target=`4${autonomousSuit}`;
              semantic={natural:true,source:'course30-opener-autonomous-minor-after-level3-ace-response',suits:{[autonomousSuit]:{min:7,max:13}},hcp:{min:15,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-autonomous-minor-after-ace'};
              reason=`cours 30 : après ${relay.call}, mineure ${autonomousSuit} septième quasi autonome => ${target}`;
            } else if(strongNtShape(L) && HL>=24 && H<24){
              // Certaines mains semi-régulières atteignent le seuil forcing de 2D par
              // les points de longueur (24 HL) avec 23 H. Une fois l'As du partenaire
              // connu, 3SA est le contrat de manche économique ; on évite de laisser
              // PONS inventer une mineure au palier de 4.
              target='3NT';
              semantic={natural:true,source:'course30-opener-minimum-strong-NT-after-level3-ace-response',hcp:{min:H,max:H},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-opener-NT-zone-after-ace'};
              reason=`cours 27/30 : main régulière/semi-régulière ${HL} HL (${H} H) après ${relay.call} => 3SA minimum`;
            } else if(H>=24){
              // Tableau explicite : 3SA = 24-25 H, 4SA = 26-27 H, 5SA = 28+.
              target=H>=28?'5NT':H>=26?'4NT':'3NT';
              const lo=H>=28?28:H>=26?26:24, hi=H>=28?37:H>=26?27:25;
              semantic={natural:true,source:'course30-opener-nt-zone-after-level3-ace-response',hcp:{min:lo,max:hi},forcing:target==='5NT'?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course30-2D-opener-NT-zone-after-ace'};
              reason=`cours 30 : après ${relay.call}, sans majeure descriptive, ${H} H => ${target} (${lo}-${hi===37?'plus':hi} H)`;
            }
          }
        } else if(relay.call==='2NT' && strongNtShape(L)){
          // 2SA du répondant promet au moins 8 H ; le camp possède au moins 32 HL.
          // Le cours précise que 3SA est alors forcing et non limité.
          target='3NT';
          semantic={natural:true,source:'course30-opener-3NT-after-2NT-response',hcp:{min:24,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-opener-3NT-forcing'};
          reason='cours 30 : sur la réponse de 2SA (8+ H), une main régulière/semi-régulière ouvre la suite par 3SA forcing';
        }

        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          return {call:target,changed:raw!==target,semantic,reason};
        }
      }
    }


    // Cours 16 — « rendre forcing ce qui ne l'était pas » : avec une majeure
    // sixième trop forte pour une répétition directe, le répondant passe d'abord par
    // la quatrième couleur puis répète sa majeure au troisième tour. Après une 4e
    // chère, cette répétition conserve l'engagement de manche.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call), cb=parseBid(cont.call);
      const clean=open.seat===partner && p1.call==='PASS' && resp.seat===seat && p2.call==='PASS' && rebid.seat===partner && p3.call==='PASS' &&
        fourth.seat===seat && p4.call==='PASS' && cont.seat===partner && p5.call==='PASS' && ob?.level===1 && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        r2 && r2.strain!=='NT' && r2.strain!==rb.strain && f4;
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set();
      const missing=SUITS.find(x=>!named.has(x));
      const expensive=rb && f4 && f4.strain===missing && bidRank(fourth.call)>=bidRank(`2${rb.strain}`);
      const openerShowedFit=cb && rb && cb.strain===rb.strain;
      if(clean && expensive && !openerShowedFit && L[rb.strain]>=6){
        const target=cheapestSuitCallAfter(history,rb.strain);
        if(target && bidRank(target)<bidRank(`4${rb.strain}`) && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course16-responder-strong-major-repeat-after-fourth',suits:{[rb.strain]:{min:6,max:13}},hcp:{min:12,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},
          reason:`cours 16 : majeure sixième trop forte pour une répétition directe ; après la quatrième forcing chère, répétition ${target} forcing de manche`
        };
      }
    }

    // Cours 16 — suite de l'unicolore majeur rendu forcing par la 4e couleur.
    // Après la répétition de la majeure au troisième tour, l'ouvreur doit atteindre
    // la manche : avec au moins deux cartes, 4M concrétise le fit ; avec un singleton,
    // 3SA est prioritaire seulement si la quatrième couleur est tenue. Sans cet arrêt,
    // le cours admet la manche majeure à sept atouts : on conclut donc aussi à 4M.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5,majorRepeat,p6]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call), mr=parseBid(majorRepeat.call);
      const clean=open.seat===seat && p1.call==='PASS' && resp.seat===partner && p2.call==='PASS' && rebid.seat===seat && p3.call==='PASS' &&
        fourth.seat===partner && p4.call==='PASS' && cont.seat===seat && p5.call==='PASS' && majorRepeat.seat===partner && p6.call==='PASS' &&
        ob?.level===1 && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && r2 && r2.strain!=='NT' && r2.strain!==rb.strain && f4 && mr && mr.strain===rb.strain && L[rb.strain]>=1;
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set();
      const missing=SUITS.find(x=>!named.has(x));
      const expensive=rb && missing && f4 && f4.strain===missing && bidRank(fourth.call)>=bidRank(`2${rb.strain}`);
      if(clean && expensive){
        const canNT=L[rb.strain]===1 && missing && stopperScore(ctx.deal,seat,missing)>=0.7;
        const target=canNT?'3NT':`4${rb.strain}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:canNT?'course16-opener-3NT-after-strong-major-repeat':'course16-opener-completes-strong-major-repeat-game',suits:{[rb.strain]:{min:L[rb.strain],max:L[rb.strain]}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
          reason:canNT?`cours 16 : unicolore ${rb.strain} forcing de manche, singleton mais arrêt ${missing} => 3SA`:`cours 16 : unicolore ${rb.strain} rendu forcing ; pas de meilleure sortie à SA => manche 4${rb.strain}, au besoin à sept atouts`
        };
      }
    }

    // Cours 16 — cadre mineur 1C-1D-1S-2H : une longue du répondant trop forte
    // pour être répétée naturellement au deuxième tour passe par la quatrième forcing,
    // puis se répète au troisième tour. La quatrième chère conserve le forcing de manche.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner && open.call==='1C' && p1.call==='PASS' && resp.seat===seat && resp.call==='1D' && p2.call==='PASS' &&
        rebid.seat===partner && rebid.call==='1S' && p3.call==='PASS' && fourth.seat===seat && fourth.call==='2H' && p4.call==='PASS' &&
        cont.seat===partner && p5.call==='PASS';
      if(frame && L.D>=6 && bidRank(cont.call)<bidRank('3D') && (!ctx.isLegal||ctx.isLegal(history,'3D',seat))) return {
        call:'3D',changed:true,
        semantic:{natural:true,source:'course16-responder-strong-diamond-repeat-after-fourth',suits:{D:{min:6,max:13}},hcp:{min:12,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},
        reason:'cours 16 : longue à Carreau trop forte pour une répétition directe ; après la quatrième forcing, 3D devient forcing de manche'
      };
    }

    // Cours 16 — réponse immédiate de l'ouvreur à une quatrième forcing chère
    // après une redemande au palier de 1. Si PONS veut passer et qu'aucune
    // information prioritaire ne peut être donnée, la répétition économique de
    // la deuxième couleur sert de « ni-ni » : elle ne promet pas une cinquième
    // carte et maintient le forcing de manche.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call);
      if(open.seat===seat && ob?.level===1 && p1.call==='PASS' && resp.seat===partner && rb?.level===1 && rb.strain!=='NT' && p2.call==='PASS' &&
         rebid.seat===seat && r2?.level===1 && r2.strain!=='NT' && r2.strain!==ob.strain && r2.strain!==rb.strain && p3.call==='PASS' &&
         fourth.seat===partner && f4 && f4.strain!=='NT' && ![ob.strain,rb.strain,r2.strain].includes(f4.strain) && p4.call==='PASS' &&
         bidRank(fourth.call)>=bidRank(`2${rb.strain}`)){
        const target=cheapestSuitCallAfter(history,r2.strain);
        if(target && +target[0]===2 && legal(target)) return {
          call:target,changed:true,
          semantic:{natural:false,source:'course16-opener-ni-ni-after-expensive-fourth',suits:{[r2.strain]:{min:4,max:13}},hcp:{min:11,max:19},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},
          reason:`cours 16 : quatrième forcing chère = PASS interdit ; sans réponse prioritaire, ${target} est le ni-ni économique et ne rallonge pas ${r2.strain}`
        };
      }
    }

    // Cours 16 — meme principe si la reponse de l'ouvreur a deja depasse 3D
    // (ex. 1C-1D-1S-2H-3H). La longue de six Carreaux doit tout de meme etre
    // repetee au palier legal suivant ; le forcing de manche reste actif.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner&&open.call==='1C'&&p1.call==='PASS'&&resp.seat===seat&&resp.call==='1D'&&p2.call==='PASS'&&
        rebid.seat===partner&&rebid.call==='1S'&&p3.call==='PASS'&&fourth.seat===seat&&fourth.call==='2H'&&p4.call==='PASS'&&
        cont.seat===partner&&p5.call==='PASS';
      if(frame&&L.D>=6&&bidRank(cont.call)>=bidRank('3D')){
        const target=cheapestSuitCallAfter(history,'D');
        if(target&&legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'course16-responder-strong-diamond-repeat-high-after-fourth',suits:{D:{min:6,max:13}},hcp:{min:12,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},reason:`cours 16 : six Carreaux et quatrième forcing de manche ; ${cont.call} a dépassé 3D => répétition légale ${target}`};
      }
    }

    // Cours 16 — après cette répétition haute à 4D, l'ouvreur ne peut pas passer
    // sous la manche. Avec au moins deux Carreaux, le fit 6-2 suffit pour 5D.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5,diamond,p6]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course16-responder-strong-diamond-repeat-high-after-fourth');
      const frame=open.seat===seat&&open.call==='1C'&&p1.call==='PASS'&&resp.seat===partner&&resp.call==='1D'&&p2.call==='PASS'&&
        rebid.seat===seat&&rebid.call==='1S'&&p3.call==='PASS'&&fourth.seat===partner&&fourth.call==='2H'&&p4.call==='PASS'&&
        cont.seat===seat&&p5.call==='PASS'&&diamond.seat===partner&&diamond.call==='4D'&&p6.call==='PASS'&&pm;
      if(frame){
        // 4D a déjà promis six cartes et le forcing de manche. Avec 2+ Carreaux,
        // le fit huitième ferme naturellement à 5D. Avec un singleton, le cours 16
        // admet qu'une manche à sept atouts puisse constituer le moindre mal lorsque
        // la recherche n'a révélé aucune meilleure dénomination ; on évite surtout
        // d'inventer un fit majeur ou un arrêt à Sans-Atout.
        if(L.D>=1 && legal('5D')) return {call:'5D',changed:true,semantic:{natural:true,source:L.D>=2?'course16-opener-completes-high-diamond-repeat-game':'course16-opener-seven-trump-diamond-game-after-high-repeat',suits:{D:{min:L.D,max:L.D}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},reason:L.D>=2?'cours 16 : 4D reste forcing de manche après la quatrième forcing ; fit 6-2 => 5D':'cours 16 : 4D montre 6+ Carreaux sous forcing de manche ; sans meilleure dénomination connue, manche 5D au besoin à sept atouts'};
      }
    }

    // Cours 16 — suite de la répétition forcing à 3D : l'ouvreur ne peut passer.
    // Il conclut à 3SA avec l'arrêt Cœur ; à défaut, un vrai fit Carreau conduit à 5D.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5,third,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && open.call==='1C' && p1.call==='PASS' && resp.seat===partner && resp.call==='1D' && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='1S' && p3.call==='PASS' && fourth.seat===partner && fourth.call==='2H' && p4.call==='PASS' &&
        cont.seat===seat && p5.call==='PASS' && third.seat===partner && third.call==='3D' && p6.call==='PASS';
      if(frame){
        let target=null;
        if(stopperScore(ctx.deal,seat,'H')>=0.7) target='3NT';
        else if(L.D>=3) target='5D';
        else if(L.C>=6) target='5C';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course16-opener-completes-game-after-strong-diamond-repeat',suits:target==='5D'?{D:{min:3,max:13}}:target==='5C'?{C:{min:6,max:13}}:{D:{min:0,max:13}},hcp:{min:11,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
          reason:target==='3NT'?'cours 16 : après 3D forcing, arrêt Cœur => 3SA':target==='5D'?'cours 16 : après 3D forcing, pas d’arrêt Cœur mais fit Carreau => 5D':'cours 16 : après 3D forcing, pas d’arrêt Cœur ni fit Carreau => 5C'
        };
      }
    }

    // Cours 16 — après une quatrième forcing chère, le répondant doit reparler
    // tant que l'ouvreur n'a pas déclaré la manche. Si l'ouvreur répond à Sans-Atout
    // sous la manche et que PONS voudrait passer, 3SA est la conclusion naturelle
    // lorsque le fit majeur n'a pas été montré.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call), cb=parseBid(cont.call);
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set();
      const missing=SUITS.find(x=>!named.has(x));
      const expensive=rb && bidRank(fourth.call)>=bidRank(`2${rb.strain}`);
      const frame=open.seat===partner && ob?.level===1 && p1.call==='PASS' && resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        p2.call==='PASS' && rebid.seat===partner && r2 && r2.strain!=='NT' && r2.strain!==rb.strain && p3.call==='PASS' && fourth.seat===seat &&
        f4 && f4.strain===missing && p4.call==='PASS' && cont.seat===partner && cb?.strain==='NT' && cb.level<3 && p5.call==='PASS' && expensive;
      if(frame && (!ctx.isLegal||ctx.isLegal(history,'3NT',seat))) return {
        call:'3NT',changed:true,
        semantic:{natural:true,source:'course16-responder-completes-expensive-fourth-force-after-NT',suits:{[rb.strain]:{min:4,max:13}},hcp:{min:12,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
        reason:`cours 16 : quatrième forcing chère = forcing de manche ; après ${cont.call} sans fit majeur montré, PASS interdit => 3SA`
      };
    }


    // Cours 16 — troisième enchère du répondant après une quatrième forcing chère
    // et une répétition mineure de l'ouvreur au palier de 3. Le cours impose une
    // troisième enchère tant que la manche n'est pas atteinte. Si le répondant tient
    // la quatrième couleur, 3SA reste prioritaire ; sinon un vrai fit mineur sans
    // ambition de chelem doit aller directement à la manche (4m serait un essai de chelem).
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call), cb=parseBid(cont.call);
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set();
      const missing=SUITS.find(x=>!named.has(x));
      const expensive=rb && bidRank(fourth.call)>=bidRank(`2${rb.strain}`);
      const frame=open.seat===partner && ob?.level===1 && p1.call==='PASS' && resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        p2.call==='PASS' && rebid.seat===partner && r2 && r2.strain!=='NT' && r2.strain!==rb.strain && p3.call==='PASS' && fourth.seat===seat &&
        f4 && f4.strain===missing && p4.call==='PASS' && cont.seat===partner && cb?.level===3 && (cb.strain==='C'||cb.strain==='D') && p5.call==='PASS' && expensive;
      if(frame){
        let target=null, source=null, reason=null;
        if(stopperScore(ctx.deal,seat,f4.strain)>=0.7){
          target='3NT'; source='course16-responder-3NT-after-expensive-fourth-minor-repeat';
          reason=`cours 16 : troisième enchère obligatoire après quatrième forcing chère ; arrêt ${f4.strain} => 3SA`;
        } else if(L[cb.strain]>=3){
          target=`5${cb.strain}`; source='course16-responder-minor-game-after-expensive-fourth';
          reason=`cours 16 : pas d'arrêt ${f4.strain}, fit ${cb.strain} et aucune ambition de chelem => manche à 5${cb.strain}`;
        } else if((ob.strain==='C'||ob.strain==='D') && L[ob.strain]>=3){
          // Cours 15 : lorsqu'un soutien de la mineure d'ouverture ne pouvait pas être
          // donné directement de façon forcing, le répondant transite par la quatrième
          // couleur puis exprime ce fit au tour suivant si l'ouvreur répète sa seconde
          // mineure. La quatrième chère ayant déjà imposé la manche, un répondant
          // minimum conclut directement à 5m (4m conserverait une ambition de chelem).
          target=`5${ob.strain}`; source='course15-responder-opening-minor-game-after-expensive-fourth';
          reason=`cours 15 : quatrième forcing pour différer le fit ${ob.strain} ; après ${cont.call}, pas d'arrêt ${f4.strain} => manche à 5${ob.strain}`;
        } else {
          // Cours 16 : lorsque la première réponse de l'ouvreur n'a pas permis de
          // déterminer le contrat (pas d'arrêt, pas de fit, pas de longue à préciser),
          // le répondant répète la quatrième couleur pour « requestionner ».
          const request=cheapestSuitCallAfter(history,f4.strain);
          if(request && bidRank(request)<bidRank('4NT')){
            target=request; source='course16-responder-repeats-fourth-requestion';
            reason=`cours 16 : réponse ${cont.call} insuffisante, aucun contrat final déterminé => répétition ${request} de la quatrième forcing`;
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) {
          const suitTarget=target==='3NT'?{[rb.strain]:{min:4,max:13}}:{[target.slice(-1)]:{min:3,max:13}};
          return {
            call:target,changed:true,
            semantic:{natural:source!=='course16-responder-repeats-fourth-requestion',source,suits:source==='course16-responder-repeats-fourth-requestion'?{[rb.strain]:{min:4,max:13}}:suitTarget,hcp:{min:12,max:37},forcing:source==='course16-responder-repeats-fourth-requestion'?'game_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
            reason
          };
        }
      }
    }


    // Cours 16 — réponse de l'ouvreur à la « requestion » (répétition de la
    // quatrième couleur). La seconde demande signifie explicitement « j'ai besoin
    // d'en savoir plus pour conclure ». L'ouvreur montre d'abord l'arrêt, puis un
    // fit majeur ou une distribution supplémentaire. S'il ne possède rien de
    // nouveau dans le cadre 1D-1H-2C-2S-3D-3S, il ne peut pas passer : 4D
    // réaffirme la mineure d'ouverture comme dénomination de repli sans promettre
    // artificiellement une sixième carte.
    if(relHistory.length===12 && raw==='PASS'){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course16-responder-repeats-fourth-requestion');
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5,request,p6]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call), rq=parseBid(request.call);
      const frame=pm && open.seat===seat && ob?.level===1 && (ob.strain==='C'||ob.strain==='D') && p1.call==='PASS' &&
        resp.seat===partner && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') && p2.call==='PASS' &&
        rebid.seat===seat && r2 && r2.strain!=='NT' && r2.strain!==rb.strain && p3.call==='PASS' &&
        fourth.seat===partner && f4 && p4.call==='PASS' && cont.seat===seat && p5.call==='PASS' &&
        request.seat===partner && rq && rq.strain===f4.strain && p6.call==='PASS';
      if(frame){
        let target=null, source=null, suits=null, reason=null;
        if(stopperScore(ctx.deal,seat,rq.strain)>=0.7 && legal('3NT')){
          target='3NT'; source='course16-opener-3NT-after-fourth-requestion';
          reason=`cours 16 : répétition de la quatrième forcing = demande d'information ; arrêt ${rq.strain} => 3SA`;
        } else if(L[rb.strain]>=3){
          const game=`4${rb.strain}`;
          if(legal(game)){
            target=game; source='course16-opener-major-game-after-fourth-requestion'; suits={[rb.strain]:{min:3,max:13}};
            reason=`cours 16 : requestion sans arrêt ${rq.strain}, mais complément ${rb.strain} => manche majeure`;
          }
        } else if(L[r2.strain]>=5){
          const c=cheapestSuitCallAfter(history,r2.strain);
          if(c&&legal(c)){
            target=c; source='course16-opener-five-five-after-fourth-requestion'; suits={[r2.strain]:{min:5,max:13}};
            reason=`cours 16 : requestion sans arrêt ${rq.strain} ; répétition de la seconde couleur => 5-5`;
          }
        } else {
          const c=cheapestSuitCallAfter(history,ob.strain);
          if(c&&bidRank(c)<bidRank('5NT')&&legal(c)){
            target=c; source='course16-opener-opening-minor-fallback-after-fourth-requestion'; suits={[ob.strain]:{min:Math.max(5,Math.min(5,L[ob.strain])),max:13}};
            reason=`cours 16 : requestion sans arrêt ${rq.strain} ni fit majeur ni 5-5 ; PASS interdit => ${c}, mineure d'ouverture de repli`;
          }
        }
        if(target) return {
          call:target,changed:true,
          semantic:{natural:target!=='3NT',source,suits,hcp:{min:11,max:19},forcing:target.startsWith('4')&&target.slice(-1)!=='H'&&target.slice(-1)!=='S'?'game_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
          reason
        };
      }
    }

    // Cours 16 — après la requestion, si l'ouvreur a dû réaffirmer sa mineure
    // d'ouverture au palier de 4, le répondant reste engagé à la manche. Avec au
    // moins deux cartes dans cette mineure, 5m est le repli sûr (le cours accepte
    // explicitement des manches à sept atouts lorsque 3SA est exclu).
    if(relHistory.length===14 && raw==='PASS'){
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course16-opener-opening-minor-fallback-after-fourth-requestion');
      const last=parseBid(history[12]?.call), partner=partnerOf(seat);
      if(pm && history[12]?.seat===partner && last?.level===4 && (last.strain==='C'||last.strain==='D') && history[13]?.call==='PASS' && L[last.strain]>=2){
        const target=`5${last.strain}`;
        if(legal(target)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course16-responder-closes-minor-game-after-fourth-requestion',suits:{[last.strain]:{min:2,max:13}},hcp:{min:12,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
          reason:`cours 16 : requestion puis ${history[12].call} sans arrêt à SA ; manche imposée et ${L[last.strain]} cartes en face => ${target}`
        };
      }
    }

    // Cours 16 — dans le cadre 1C-1D-1S-2H, si l'ouvreur agrée ensuite les
    // Carreaux à 4D, le répondant minimum peut refuser le chelem en concluant à 5D.
    if(relHistory.length===14 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5,third,p6,fit,p7]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner && open.call==='1C' && p1.call==='PASS' && resp.seat===seat && resp.call==='1D' && p2.call==='PASS' &&
        rebid.seat===partner && rebid.call==='1S' && p3.call==='PASS' && fourth.seat===seat && fourth.call==='2H' && p4.call==='PASS' &&
        cont.seat===partner && p5.call==='PASS' && third.seat===seat && third.call==='3D' && p6.call==='PASS' && fit.seat===partner && fit.call==='4D' && p7.call==='PASS';
      if(frame && H<=13 && (!ctx.isLegal||ctx.isLegal(history,'5D',seat))) return {
        call:'5D',changed:true,
        semantic:{natural:true,source:'course16-responder-declines-diamond-slam-after-fourth',suits:{D:{min:6,max:13}},hcp:{min:12,max:13},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
        reason:`cours 16 : 4D agrée le fit après quatrième forcing ; avec ${H} H minimum, refus du chelem => 5D`
      };
      if(frame && H>=16 && (!ctx.isLegal||ctx.isLegal(history,'4NT',seat))) return {
        call:'4NT',changed:raw!=='4NT',
        semantic:{natural:false,source:'course16-responder-slam-continue-after-diamond-fit',suits:{D:{min:6,max:13}},hcp:{min:16,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course16-fourth-forcing'},
        reason:`cours 16 : 4D agrée le fit après quatrième forcing ; avec ${H} H et six Carreaux, 4SA poursuit l'exploration du chelem`
      };
    }

    // Cours 16 — une quatrième forcing chère est forcing de manche. Si l'ouvreur
    // répond 4m et que le répondant brut veut passer, on revient d'abord à sa majeure
    // cinquième/sixième lorsqu'elle existe ; sinon 5m ferme le minimum de manche.
    if(relHistory.length===10 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3,fourth,p4,cont,p5]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(open.call), rb=parseBid(resp.call), r2=parseBid(rebid.call), f4=parseBid(fourth.call), cb=parseBid(cont.call);
      const named=ob&&rb&&r2?new Set([ob.strain,rb.strain,r2.strain]):new Set();
      const missing=SUITS.find(x=>!named.has(x));
      const expensive=rb && bidRank(fourth.call)>=bidRank(`2${rb.strain}`);
      const frame=open.seat===partner && ob?.level===1 && p1.call==='PASS' && resp.seat===seat && rb?.level===1 && (rb.strain==='H'||rb.strain==='S') &&
        p2.call==='PASS' && rebid.seat===partner && r2 && r2.strain!=='NT' && r2.strain!==rb.strain && p3.call==='PASS' && fourth.seat===seat &&
        f4 && f4.strain===missing && p4.call==='PASS' && cont.seat===partner && cb?.level===4 && (cb.strain==='C'||cb.strain==='D') && p5.call==='PASS' && expensive;
      if(frame){
        let target=L[rb.strain]>=5?`4${rb.strain}`:`5${cb.strain}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course16-responder-completes-expensive-fourth-force',suits:{[target.slice(-1)]:{min:target.startsWith('4')?5:3,max:13}},hcp:{min:12,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course16-fourth-forcing'},
          reason:`cours 16 : quatrième forcing chère = forcing de manche ; après ${cont.call}, PASS interdit => ${target}`
        };
      }
    }

    // v2.30 — durcissement transversal du 2D forcing de manche après intervention.
    // Le répondant faible a le droit de PASSER sur une intervention (ou sur X selon
    // les réponses du cours 30), mais ce PASS ne rend jamais l'ouverture non forcing.
    // Si l'adversaire de droite passe à son tour, l'ouvreur fort ne peut donc pas
    // abandonner la séquence sous la manche. On n'intervient ici QUE si PONS brut
    // veut PASSER : tout carton naturel natif reste prioritaire.
    if(relHistory.length===4 && raw==='PASS'){
      const [open,over,responder,rho]=relHistory, partner=partnerOf(seat);
      const ob=parseBid(over.call);
      const frame=open.seat===seat && open.call==='2D' && openingEvent(history)===open &&
        over.seat!==seat && over.call!=='PASS' && responder.seat===partner &&
        (responder.call==='PASS'||responder.call==='XX') && rho.call==='PASS';
      if(frame){
        let target=null, semantic=null, reason='';
        // Après un contre, 2SA est une description sûre avec une main régulière ;
        // sinon on nomme la meilleure couleur naturelle disponible.
        if(over.call==='X' && strongNtShape(L) && legal('2NT')){
          target='2NT';
          semantic={natural:true,source:'course30-2D-opener-continues-after-double-pass',hcp:{min:22,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-forcing-game'};
          reason="v2.30 : 2D forcing de manche contré, réponse faible puis Passe adverse ; PASS de l'ouvreur interdit => 2SA descriptif";
        } else if(ob && ob.strain!=='NT' && strongNtShape(L) && stopperScore(ctx.deal,seat,ob.strain)>=0.7 && legal('3NT')){
          target='3NT';
          semantic={natural:true,source:'course30-2D-opener-3NT-after-overcall-pass',hcp:{min:22,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-forcing-game'};
          reason=`v2.30 : 2D forcing de manche, intervention ${over.call}, réponse faible ; main régulière avec arrêt => 3SA`;
        } else {
          const candidates=SUITS.map(s=>({s,n:L[s],call:cheapestSuitCallAfter(history,s)}))
            .filter(x=>x.n>=5 && x.call && legal(x.call))
            .sort((a,b)=>b.n-a.n || RANK[b.s]-RANK[a.s]);
          if(candidates.length){
            const x=candidates[0]; target=x.call;
            semantic={natural:true,source:'course30-2D-opener-natural-continuation-after-overcall-pass',suits:{[x.s]:{min:5,max:13}},hcp:{min:15,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-forcing-game'};
            reason=`v2.30 : 2D forcing de manche ne peut pas mourir après ${over.call}-PASS-PASS ; continuation naturelle ${target}`;
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:true,semantic,reason};
      }
    }

    // Cours 27/30 — l'ouverture de 2D est forcing de manche : après une
    // redemande naturelle à 3D et un soutien à 4D, PASS reste impossible.
    if(relHistory.length===8 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3,fit,p4]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && open.call==='2D' && p1.call==='PASS' && resp.seat===partner && resp.call==='2H' && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='3D' && p3.call==='PASS' && fit.seat===partner && fit.call==='4D' && p4.call==='PASS';
      if(frame && (!ctx.isLegal||ctx.isLegal(history,'5D',seat))) return {
        call:'5D',changed:true,
        semantic:{natural:true,source:'course27-opener-completes-diamond-game-force',suits:{D:{min:6,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course27-2D-forcing-game'},
        reason:'cours 27/30 : 2D est forcing de manche ; après 3D-4D, PASS interdit => 5D minimum'
      };
    }

    // Cours 30 — après 2D-2H-2SA, la séquence reste forcing de manche même si
    // le répondant passe par le Stayman. Si 4D apparaît ensuite sous la manche,
    // l'ouvreur ne peut pas passer ; avec au moins trois Carreaux il ferme au minimum à 5D.
    if(relHistory.length===12 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,stayman,p4,answer,p5,minor,p6]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===seat && open.call==='2D' && p1.call==='PASS' && resp.seat===partner && resp.call==='2H' && p2.call==='PASS' &&
        rebid.seat===seat && rebid.call==='2NT' && p3.call==='PASS' && stayman.seat===partner && stayman.call==='3C' && p4.call==='PASS' &&
        answer.seat===seat && answer.call==='3D' && p5.call==='PASS' && minor.seat===partner && minor.call==='4D' && p6.call==='PASS';
      if(frame && L.D>=3 && (!ctx.isLegal||ctx.isLegal(history,'5D',seat))) return {
        call:'5D',changed:true,
        semantic:{natural:true,source:'course30-opener-completes-diamond-game-force-after-stayman',suits:{D:{min:3,max:13}},hcp:{min:24,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-forcing-game'},
        reason:'cours 30 : ouverture 2D = forcing de manche ; après 2SA-Stayman puis 4D, PASS interdit avec fit => 5D minimum'
      };
    }


    // Cours 30 — après 2D-2SA-3SA, 3SA est explicitement forcing et non
    // limité. La réponse de 2SA ayant déjà promis 8+ H et une main sans singleton,
    // 4SA est la proposition quantitative naturelle lorsque PONS voudrait passer.
    if(relHistory.length===6 && raw==='PASS') {
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat);
      const frame=open.seat===partner && open.call==='2D' && p1.call==='PASS' && resp.seat===seat && resp.call==='2NT' &&
        p2.call==='PASS' && rebid.seat===partner && rebid.call==='3NT' && p3.call==='PASS';
      if(frame && (!ctx.isLegal||ctx.isLegal(history,'4NT',seat))) return {
        call:'4NT',changed:true,
        semantic:{natural:true,source:'course30-responder-4NT-after-forcing-3NT',hcp:{min:8,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-3NT-forcing-continuation'},
        reason:'cours 30 : après 2D-2SA, 3SA est forcing et non limité ; PASS interdit => 4SA quantitatif'
      };
    }

    // Cours 30 — une redemande exceptionnelle à 4m après une réponse d'As
    // reste dans une séquence forcing de manche. Si le répondant envisage PASS, il
    // soutient la mineure avec trois cartes ou revient à 4SA sans fit. On n'écrase
    // aucune autre continuation naturelle de PONS.
    if(relHistory.length===6 && raw==='PASS'){
      const [open,p1,ace,p2,rebid,p3]=relHistory, partner=partnerOf(seat), b=parseBid(rebid.call);
      const frame=open.seat===partner && open.call==='2D' && p1.call==='PASS' && ace.seat===seat && (ace.call==='3C'||ace.call==='3D') && p2.call==='PASS' &&
        rebid.seat===partner && b?.level===4 && (b.strain==='C'||b.strain==='D') && p3.call==='PASS';
      if(frame){
        const target=L[b.strain]>=3?`5${b.strain}`:'4NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course30-responder-after-autonomous-minor',suits:{[b.strain]:{min:L[b.strain]>=3?3:0,max:L[b.strain]>=3?13:2}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-autonomous-minor-continuation'},
          reason:L[b.strain]>=3?`cours 30 : 4${b.strain} sous la manche est forcing ; fit => 5${b.strain}`:`cours 30 : 4${b.strain} sous la manche est forcing ; sans fit, repli à 4SA`
        };
      }
    }

    // Cours 30 — une mineure quasi autonome annoncée à 4m après une réponse
    // d'As reste inscrite dans le forcing de manche de l'ouverture de 2D. Si le
    // répondant fournit ensuite un contrôle sous la manche, l'ouvreur ne peut pas
    // passer : avec sa couleur septième AKQ, le minimum sûr est de conclure à 5m.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,p1,ace,p2,rebid,p3,control,p4]=relHistory, partner=partnerOf(seat), b=parseBid(rebid.call), cb=parseBid(control.call);
      const cards=b && (b.strain==='C'||b.strain==='D') ? String(ctx.deal?.hands?.[seat]?.[b.strain]||'') : '';
      const autonomous=b?.level===4 && cards.length>=7 && cards.includes('A') && cards.includes('K') && cards.includes('Q');
      const controlBelowGame=cb && cb.level===4 && !((cb.strain==='H'||cb.strain==='S')&&cb.level>=4) && !(cb.strain==='NT'&&cb.level>=3);
      const frame=open.seat===seat && open.call==='2D' && p1.call==='PASS' && ace.seat===partner && (ace.call==='3C'||ace.call==='3D') && p2.call==='PASS' &&
        rebid.seat===seat && autonomous && p3.call==='PASS' && control.seat===partner && controlBelowGame && p4.call==='PASS';
      if(frame){
        const target=`5${b.strain}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course30-opener-completes-game-after-minor-control',suits:{[b.strain]:{min:7,max:13}},hcp:{min:15,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-autonomous-minor-continuation'},
          reason:`cours 30 : après 4${b.strain} quasi autonome et un contrôle sous la manche, PASS interdit ; conclusion minimale à 5${b.strain}`
        };
      }
    }

    // Cours 29 : 3SA / 4C / 4D après 2C-2D sont des descriptions artificielles
    // d'un bicolore majeur de trois perdantes. Elles ne sont jamais des contrats où
    // le répondant peut s'arrêter. Avec une main sans ambition de chelem (cas où
    // PONS voulait PASS), le cours demande simplement de choisir la manche majeure.
    if(relHistory.length===6 && raw==='PASS'){
      const [open,p1,relay,p2,rebid,p3]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2C' && p1.call==='PASS' && relay.seat===seat && relay.call==='2D' &&
         p2.call==='PASS' && rebid.seat===partner && p3.call==='PASS' &&
         (rebid.call==='3NT'||rebid.call==='4C'||rebid.call==='4D')){
        let h0=5,s0=5;
        if(rebid.call==='4C'){h0=6;s0=5;}
        else if(rebid.call==='4D'){h0=5;s0=6;}
        const pref=majorPreference(ctx.deal,seat,h0,s0), target=`4${pref}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
          return {
            call:target,changed:true,
            semantic:{natural:true,source:'course29-responder-game-after-major-bicolor',suits:{[pref]:{min:0,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',convention:'course29-2C-major-bicolor-game-choice'},
            reason:`cours 29 : ${rebid.call} est une description artificielle du bicolore majeur ; PASS interdit, choix de la manche ${target}`
          };
        }
      }
    }


    // Anti-régression : après 2C fort - 2D relais - 3M (unicolore septième),
    // le noyau natif ne connaît pas le sens de la séquence et peut sauter directement
    // à 6/7SA. On ne touche qu'aux sauts de chelem manifestement issus de cette collision.
    // Avec fit et quelques valeurs, on passe par 4SA ; avec fit faible on ferme à 4M ;
    // sans fit on revient à 3SA.
    if(relHistory.length===6){
      const [open,p1,relay,p2,rebid,p3]=relHistory, partner=partnerOf(seat), rb=parseBid(raw);
      const frame=open.seat===partner && open.call==='2C' && p1.call==='PASS' && relay.seat===seat && relay.call==='2D' &&
        p2.call==='PASS' && rebid.seat===partner && (rebid.call==='3H'||rebid.call==='3S') && p3.call==='PASS';
      if(frame && rb && rb.level>=6){
        const m=rebid.call.slice(1); let target='3NT';
        if(L[m]>=3) target=(H>=8 && legal('4NT'))?'4NT':`4${m}`;
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:raw!==target,
          semantic:{natural:target.endsWith(m),source:'course29-seven-major-slam-collision-guard',suits:{[m]:{min:L[m],max:13}},hcp:{min:H,max:H},forcing:target==='4NT'?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course29-2C-seven-major'},
          reason:target==='4NT'?`cours 29 anti-régression : saut natif ${raw} incompatible avec 2C-2D-3${m}; fit + ${H} H => 4SA pour explorer le chelem`:
          target===`4${m}`?`cours 29 anti-régression : saut natif ${raw} incompatible avec 2C-2D-3${m}; conclusion sûre à 4${m}`:
          `cours 29 anti-régression : saut natif ${raw} incompatible avec 2C-2D-3${m}; sans fit, repli à 3SA`
        };
      }
    }

    // Cours 29 : développements du répondant après 2C-2D-2M.
    // Le cours distingue explicitement : fit majeur, 2S économique sur 2H,
    // changement de couleur positif au palier de 3, et 2SA fourre-tout forcing
    // de manche à partir d'environ 4/5 H quand aucune enchère plus descriptive
    // n'est disponible. Les mains avec 4+ atouts ET une courte sont laissées à
    // PONS car les Splinters deviennent alors prioritaires.
    if(relHistory.length===6){
      const [open,p1,relay,p2,rebid,p3]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2C' && p1.call==='PASS' && relay.seat===seat && relay.call==='2D' &&
         p2.call==='PASS' && rebid.seat===partner && (rebid.call==='2H'||rebid.call==='2S') && p3.call==='PASS'){
        const major=rebid.call.slice(1), hld=supportHld(ctx.deal,seat,major);
        let target=null, semantic=null, reason='';
        const shortSides=SUITS.filter(s=>s!==major && L[s]<=1);
        if(L[major]>=3 && !(L[major]>=4 && shortSides.length)){
          if(hld<=10 && H<=7){
            target=`4${major}`;
            semantic={natural:true,source:'course29-responder-direct-major-game',suits:{[major]:{min:3,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',convention:'course29-2C-major-direct-game'};
            reason=`cours 29 : fit ${major} sans ambition de chelem (${hld} HLD) => conclusion directe à ${target}`;
          } else {
            const outsideControl=SUITS.some(s=>s!==major && /[AK]/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')));
            if(outsideControl){
              target=`3${major}`;
              semantic={natural:true,source:'course29-responder-strong-major-fit',suits:{[major]:{min:3,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-fit-slam-try'};
              reason=`cours 29 : soutien au palier de 3 = fit ${major} de chelem (${hld} HLD, contrôle extérieur)`;
            }
          }
        } else if(L[major]<=2){
          if(major==='H' && L.S>=5 && H>=3 && suitHcp(ctx.deal,seat,'S')>=2){
            target='2S';
            semantic={natural:true,source:'course29-responder-2S-over-2H',suits:{S:{min:5,max:13}},hcp:{min:3,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-new-suit'};
            reason=`cours 29 : sur 2H, cinq Piques convenables peuvent être annoncés économiquement par 2S`;
          } else {
            const positive=SUITS.filter(s=>{
              if(s===major || (major==='H'&&s==='S')) return false;
              const call=`3${s}`;
              return L[s]>=5 && H>=7 && hasBigHonor(ctx.deal,seat,s) && (!ctx.isLegal||ctx.isLegal(history,call,seat));
            });
            if(positive.length===1){
              target=`3${positive[0]}`;
              semantic={natural:true,source:'course29-responder-positive-new-suit-level3',suits:{[positive[0]]:{min:5,max:13}},hcp:{min:7,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-positive-new-suit'};
              reason=`cours 29 : changement de couleur positif au palier de 3 (${positive[0]}, ${L[positive[0]]} cartes, ${H} H) => forcing de manche`;
            } else if(H>=5){
              target='2NT';
              semantic={natural:false,source:'course29-responder-2NT-catchall-after-major',hcp:{min:5,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-2NT-catchall'};
              reason='cours 29 : sans fit ni couleur positive annonçable, 2SA est le relais fourre-tout forcing de manche';
            }
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }


    // Anti-régression v2.33 — 2C fort, fit majeur positif au palier de 3.
    // Avec 20+ H chez l'ouvreur et un répondant qui a montré un fit positif, le camp
    // possède la force de chelem : 4SA est l'exploration minimale, pas 4M sign-off.
    if(relHistory.length===8){
      const [open,p1,relay,p2,majorBid,p3,fit,p4]=relHistory, partner=partnerOf(seat), mb=parseBid(majorBid.call), fb=parseBid(fit.call);
      const frame=open.seat===seat&&open.call==='2C'&&p1.call==='PASS'&&relay.seat===partner&&relay.call==='2D'&&p2.call==='PASS'&&majorBid.seat===seat&&mb?.level===2&&(mb.strain==='H'||mb.strain==='S')&&p3.call==='PASS'&&fit.seat===partner&&fb?.level===3&&fb.strain===mb.strain&&p4.call==='PASS';
      if(frame && H>=20 && legal('4NT')) return {call:'4NT',changed:raw!=='4NT',semantic:{natural:false,source:'v233-2C-major-positive-fit-rkcb',suits:{[mb.strain]:{min:5,max:13}},hcp:{min:20,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-fit-slam-try'},reason:`anti-régression v2.3 : 2C fort + fit positif 3${mb.strain}, ${H} H => 4SA`};
    }

    // Après le relais 2SA du répondant sur une redemande majeure, l'ouvreur
    // précise : répétition avec six cartes, seconde couleur quatrième, ou 3SA
    // avec seulement cinq cartes dans une main régulière. Le relais a déjà placé
    // le camp en forcing de manche.
    if(relHistory.length===8){
      const [open,p1,relay,p2,majorBid,p3,wait,p4]=relHistory;
      if(open.seat===seat && open.call==='2C' && p1.call==='PASS' && relay.call==='2D' && p2.call==='PASS' &&
         majorBid.seat===seat && (majorBid.call==='2H'||majorBid.call==='2S') && p3.call==='PASS' &&
         sideOf(wait.seat)===sideOf(seat) && wait.seat!==seat && wait.call==='2NT' && p4.call==='PASS'){
        const major=majorBid.call.slice(1); let target=null, semantic=null, reason='';
        if(L[major]>=6){
          target=`3${major}`;
          semantic={natural:true,source:'course29-opener-repeat-six-major-after-2NT',suits:{[major]:{min:6,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-after-2NT'};
          reason=`cours 29 : après le relais 2SA, répétition de la majeure = six cartes (${L[major]} ${major})`;
        } else if(L[major]===5){
          const side4=SUITS.filter(s=>s!==major && L[s]===4 && (!ctx.isLegal||ctx.isLegal(history,`3${s}`,seat)));
          if(side4.length===1){
            target=`3${side4[0]}`;
            semantic={natural:true,source:'course29-opener-side-four-after-2NT',suits:{[side4[0]]:{min:4,max:4},[major]:{min:5,max:5}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course29-2C-major-after-2NT'};
            reason=`cours 29 : après le relais 2SA, l'ouvreur montre sa seconde couleur quatrième ${side4[0]}`;
          } else if(strictBalanced(L)){
            target='3NT';
            semantic={natural:true,source:'course29-opener-3NT-five-major-after-2NT',suits:{[major]:{min:5,max:5}},hcp:{min:0,max:37},forcing:'nonforcing',convention:'course29-2C-major-after-2NT'};
            reason='cours 29 : après le relais 2SA, 3SA montre le jeu régulier à cinq cartes dans la majeure';
          }
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }

    // Si l'ouvreur répète sa majeure sixième après le relais 2SA, le camp est
    // forcing de manche : avec deux cartes ou plus on choisit 4M, sinon 3SA.
    if(relHistory.length===10){
      const [open,p1,relay,p2,majorBid,p3,wait,p4,rebid,p5]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2C' && relay.seat===seat && relay.call==='2D' &&
         majorBid.seat===partner && (majorBid.call==='2H'||majorBid.call==='2S') && wait.seat===seat && wait.call==='2NT' &&
         rebid.seat===partner && rebid.call===`3${majorBid.call.slice(1)}` && p5.call==='PASS'){
        const major=majorBid.call.slice(1), target=L[major]>=2?`4${major}`:'3NT';
        if((raw==='PASS'||raw==='3NT'||raw===`4${major}`) && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course29-responder-game-after-six-major',forcing:'nonforcing',convention:'course29-2C-major-after-2NT-game'},reason:L[major]>=2?`cours 29 : majeure sixième confirmée et ${L[major]} cartes en face => fit huitième, priorité à ${target}`:'cours 29 : majeure sixième confirmée sans fit, repli de manche à 3SA'};
      }
    }

    // Cours 30 : développements précis du répondant après 2D-2H-2S.
    // PONS natif ne connaît pas la signification forcing de manche de 2D ; dans cette
    // branche artificielle, on restitue donc les cinq familles explicitement décrites
    // par le cours : relais 2SA avec trois petits atouts, soutien direct 4S avec un fit
    // faible mais correct, Splinter, soutien positif 3S, et fit différé via une belle
    // couleur cinquième. Sans fit, une belle couleur cinquième est naturelle ; sinon
    // 2SA reste l'enchère fourre-tout.
    if(relHistory.length===6){
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat);
      const latestConvention=ctx.semanticContext?.entry?.explicitMeaning?.convention;
      if(open.seat===partner && open.call==='2D' && p1.call==='PASS' && resp.seat===seat && resp.call==='2H' &&
         p2.call==='PASS' && rebid.seat===partner && rebid.call==='2S' && p3.call==='PASS' &&
         (latestConvention==='course30-2D-opener-spades' || latestConvention==='course30-2D-opener-2NT' || !latestConvention)){
        const sp=String(ctx.deal?.hands?.[seat]?.S||'');
        const outsideKing=SUITS.some(s=>s!=='S' && String(ctx.deal?.hands?.[seat]?.[s]||'').includes('K'));
        const shortSides=SUITS.filter(s=>s!=='S' && L[s]<=1);
        const fitDeferred=SUITS.filter(s=>s!=='S' && L[s]>=5 &&
          String(ctx.deal?.hands?.[seat]?.[s]||'').includes('K') && /[QJ]/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')) &&
          (!ctx.isLegal||ctx.isLegal(history,`3${s}`,seat)));
        const positiveSuit=SUITS.filter(s=>s!=='S' && L[s]>=5 && H>=3 && /[KQ]/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')) &&
          (!ctx.isLegal||ctx.isLegal(history,`3${s}`,seat)));
        let target=null, semantic=null, reason='';
        if(L.S>=3){
          if(fitDeferred.length===1){
            const s0=fitDeferred[0]; target=`3${s0}`;
            semantic={natural:true,source:'course30-responder-fit-deferred-after-2S',suits:{S:{min:3,max:13},[s0]:{min:5,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-2S-fit-deferred'};
            reason=`cours 30 : fit Pique + belle couleur ${s0} cinquième commandée par le Roi => fit différé par ${target}`;
          } else if(outsideKing){
            target='3S';
            semantic={natural:true,source:'course30-responder-positive-spade-fit',suits:{S:{min:3,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-2S-positive-fit'};
            reason='cours 30 : fit Pique avec contrôle extérieur => soutien positif forcing à 3S';
          } else if(shortSides.length===1 && L.S>=3){
            const sh=shortSides[0], c=`4${sh}`;
            if(!ctx.isLegal||ctx.isLegal(history,c,seat)){
              target=c;
              semantic={natural:false,source:'course30-responder-spade-splinter',suits:{S:{min:3,max:13},[sh]:{min:0,max:1}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-2S-splinter'};
              reason=`cours 30 : fit Pique faible avec courte ${sh} et sans contrôle d'honneur extérieur => Splinter ${target}`;
            }
          }
          if(!target && (L.S>=4 || /[KQJ]/.test(sp))){
            target='4S';
            semantic={natural:true,source:'course30-responder-direct-spade-game',suits:{S:{min:3,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-2S-direct-game-fit'};
            reason='cours 30 : fit Pique faible mais correct (4 atouts ou honneur troisième) => 4S direct';
          }
          if(!target){
            target='2NT';
            semantic={natural:false,source:'course30-responder-2NT-weak-three-small-spades',suits:{S:{min:3,max:3}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-2S-2NT-catchall'};
            reason='cours 30 : avec trois petits Piques et un jeu nul, passage par 2SA avant de fitter';
          }
        } else if(positiveSuit.length===1){
          const s0=positiveSuit[0]; target=`3${s0}`;
          semantic={natural:true,source:'course30-responder-positive-new-suit-after-2S',suits:{[s0]:{min:5,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-2S-positive-new-suit'};
          reason=`cours 30 : sans fit Pique, belle couleur ${s0} au moins cinquième => ${target}`;
        } else {
          target='2NT';
          semantic={natural:false,source:'course30-responder-2NT-catchall-after-2S',hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-2S-2NT-catchall'};
          reason='cours 30 : sans fit ni belle couleur cinquième, 2SA est l’enchère fourre-tout sur 2S';
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }

    // Cours 30 — après 2D-2H-2S, un Splinter 4x du répondant agrée les
    // Piques et maintient le forcing de manche. PASS de l'ouvreur est impossible ;
    // 4S est la conclusion minimale sûre lorsque PONS ne propose rien d'autre.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,p1,resp,p2,spade,p3,spl,p4]=relHistory, partner=partnerOf(seat), sb=parseBid(spl.call);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course30-responder-spade-splinter');
      const frame=open.seat===seat&&open.call==='2D'&&p1.call==='PASS'&&resp.seat===partner&&resp.call==='2H'&&p2.call==='PASS'&&
        spade.seat===seat&&spade.call==='2S'&&p3.call==='PASS'&&spl.seat===partner&&sb?.level===4&&['C','D','H'].includes(sb.strain)&&p4.call==='PASS'&&pm;
      if(frame&&L.S>=6&&legal('4S')) return {call:'4S',changed:true,semantic:{natural:true,source:'course30-opener-closes-spade-game-after-splinter',suits:{S:{min:6,max:13}},hcp:{min:20,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-2S-splinter'},reason:`cours 30 : Splinter ${spl.call} agrée les Piques sous forcing de manche ; PASS interdit => 4S minimum`};
    }

    // Cours 30 : après le passage par 2SA sur 2S, un répondant qui avait trois
    // petits atouts dévoile ensuite sa préférence. Sur 3SA il revient à 4S ; si
    // l'ouvreur décrit d'abord une couleur au palier de 3, le retour économique
    // à 3S peut cacher un jeu extrêmement faible. Le forcing de manche reste actif.
    if(relHistory.length===10){
      const [open,p1,resp,p2,spade,p3,wait,p4,rebid,p5]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2D' && resp.seat===seat && resp.call==='2H' && spade.seat===partner && spade.call==='2S' &&
         wait.seat===seat && wait.call==='2NT' && rebid.seat===partner && p5.call==='PASS' && L.S>=3){
        let target=null;
        if(rebid.call==='3NT') target='4S';
        else if(rebid.call==='3C'||rebid.call==='3D'||rebid.call==='3H') target='3S';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {
          call:target,changed:raw!==target,
          semantic:{natural:true,source:'course30-responder-spade-preference-after-2NT',suits:{S:{min:3,max:13}},hcp:{min:0,max:37},forcing:target==='4S'?'nonforcing':'game_if_uncontested',publishWhenNative:true,convention:'course30-2D-2S-2NT-spade-preference'},
          reason:target==='4S'?'cours 30 : 2SA puis 4S montre le fit Pique très faible':'cours 30 : après 2SA et une nouvelle couleur de l’ouvreur, 3S est une préférence pouvant cacher un jeu très faible'
        };
      }
    }

    // Cours 30 : l'ouverture de 2D est forcing de manche. Quand PONS tente de
    // passer sur la première redemande de l'ouvreur, on utilise les relais de sécurité
    // explicitement documentés par le cours plutôt qu'un candidat inventé.
    if(relHistory.length===6 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2D' && p1.call==='PASS' && resp.seat===seat && p2.call==='PASS' &&
         rebid.seat===partner && p3.call==='PASS'){
        let target=null, semantic=null, reason='';
        if(rebid.call==='2NT'){
          // Les développements sont les mêmes qu'après l'ouverture de 2SA.
          if(L.H===4 || L.S===4 || (L.H>=4&&L.S>=4)) target='3C';
          else if(L.H>=5) target='3D';
          else if(L.S>=5) target='3H';
          else target='3NT';
          semantic={natural:false,source:'course30-responder-after-opener-2NT',hcp:{min:0,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',convention:'course30-2D-2NT-development'};
          reason=`cours 30 : 2D forcing de manche, PASS interdit sur 2SA ; développement distributionnel => ${target}`;
        } else if(rebid.call==='2S'){
          // Sans couleur cinquième correcte, 2SA est explicitement l'enchère
          // fourre-tout, quelle que soit la force du répondant.
          const good=SUITS.filter(s=>s!=='S' && L[s]>=5 && suitHcp(ctx.deal,seat,s)>=2 && (!ctx.isLegal||ctx.isLegal(history,`3${s}`,seat)));
          target=good.length===1?`3${good[0]}`:'2NT';
          semantic={natural:target==='2NT',source:'course30-responder-after-opener-2S',hcp:{min:0,max:37},forcing:'one_round_if_uncontested',convention:'course30-2D-2S-responder-continuation'};
          reason=target==='2NT'?'cours 30 : après 2D-2H-2S, 2SA est le relais fourre-tout qui interdit de passer':`cours 30 : après 2S, belle couleur cinquième ${good[0]} => ${target}`;
        } else if(rebid.call==='3H' || rebid.call==='3S'){
          const m=rebid.call.slice(1);
          if(L[m]>=2){
            // Avec deux cartes utiles, le cours demande au répondant d'aider
            // activement à prospecter le chelem. Le cas le plus objectif est un
            // gros honneur d'atout accompagné d'un contrôle d'honneur extérieur :
            // le soutien direct au palier de 5 transmet alors ce supplément.
            const trumpCards=String(ctx.deal?.hands?.[seat]?.[m]||'');
            const trumpUseful=/[AKQ]/.test(trumpCards);
            const sideHonorControl=SUITS.some(s=>s!==m && /[AK]/.test(String(ctx.deal?.hands?.[seat]?.[s]||'')));
            target=(trumpUseful&&sideHonorControl)?`5${m}`:`4${m}`;
            semantic={natural:true,source:'course30-responder-fit-after-opener-major-level3',hcp:{min:0,max:37},forcing:'nonforcing',convention:'course30-2D-fit-after-major-rebid'};
            reason=target[0]==='5'?`cours 30 : redemande ${rebid.call}, fit avec deux cartes utiles (honneur d'atout + contrôle extérieur) => soutien constructif à ${target}`:`cours 30 : redemande majeure au palier de 3 et fit sans deux cartes utiles certaines => manche ${target}`;
          } else {
            // Sans fit, le cours distingue explicitement la force du répondant :
            // 4SA avec 7-9 H et 5SA forcing à partir de 10 H. En-dessous, 3SA
            // reste la conclusion minimale compatible avec l'ouverture forcing de manche.
            target=H>=10?'5NT':H>=7?'4NT':'3NT';
            semantic={natural:true,source:'course30-responder-nt-strength-after-opener-major-level3',hcp:{min:H>=10?10:H>=7?7:0,max:H>=10?37:H>=7?9:6},forcing:target==='5NT'?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'course30-2D-no-fit-after-major-rebid'};
            reason=target==='5NT'?'cours 30 : sans fit après redemande majeure, 10+ H => 5SA forcing':target==='4NT'?'cours 30 : sans fit après redemande majeure, 7-9 H => 4SA':'cours 30 : sans fit et moins de 7 H => conclusion minimale à 3SA';
          }
        } else if(rebid.call==='3C' || rebid.call==='3D'){
          target='3NT';
          semantic={natural:true,source:'course30-responder-3NT-after-opener-minor-level3',hcp:{min:0,max:37},forcing:'nonforcing',convention:'course30-2D-game-after-minor-rebid'};
          reason=`cours 30 : ouverture forcing de manche ; PASS impossible sur ${rebid.call}, repli naturel à 3SA`;
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:true,semantic,reason};
      }
    }

    // Cours 30 — après une redemande majeure au palier de 3, 5SA sans fit est
    // explicitement forcing à partir de 10 H. L'ouvreur choisit un chelem : sa
    // majeure si elle est au moins sixième et très solide, sinon 6SA.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,p1,resp,p2,rebid,p3,nt,p4]=relHistory, partner=partnerOf(seat), b=parseBid(rebid.call);
      const frame=open.seat===seat && open.call==='2D' && p1.call==='PASS' && resp.seat===partner && ['2H','2S','2NT','3C','3D'].includes(resp.call) && p2.call==='PASS' &&
        rebid.seat===seat && b?.level===3 && (b.strain==='H'||b.strain==='S') && p3.call==='PASS' && nt.seat===partner && nt.call==='5NT' && p4.call==='PASS';
      if(frame){
        const cards=String(ctx.deal?.hands?.[seat]?.[b.strain]||''), top=['A','K','Q','J','T'].filter(r=>cards.includes(r)).length;
        const target=L[b.strain]>=6 && top>=3?`6${b.strain}`:'6NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course30-opener-after-forcing-5NT-no-fit',suits:target==='6NT'?{}:{[b.strain]:{min:6,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course30-2D-no-fit-after-major-rebid'},
          reason:target==='6NT'?'cours 30 : 5SA sans fit est forcing à partir de 10 H => 6SA minimum':`cours 30 : 5SA sans fit est forcing ; majeure ${b.strain} très solide ${L[b.strain]}e => 6${b.strain}`
        };
      }
    }

    // Après une redemande à 2SA de l'ouvreur de 2D, les réponses Stayman/Texas
    // et leurs rectifications sont celles de l'ouverture de 2SA.
    if(relHistory.length===8){
      const [open,p1,ace,p2,nt,p3,ask,p4]=relHistory;
      if(open.seat===seat && open.call==='2D' && p1.call==='PASS' && p2.call==='PASS' && nt.seat===seat && nt.call==='2NT' &&
         p3.call==='PASS' && sideOf(ask.seat)===sideOf(seat) && ask.seat!==seat && p4.call==='PASS' && hcp(ctx.deal,seat)>=22){
        let target=null,semantic=null,reason='';
        if(ask.call==='3C'){
          const h4=L.H>=4,s4=L.S>=4;target=h4&&s4?'3NT':h4?'3H':s4?'3S':'3D';
          semantic={natural:false,source:'course30-2D-2NT-stayman-response',hcp:{min:24,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-2NT-stayman'};
          reason=`cours 30/28 : Stayman après la redemande à 2SA => ${target}`;
        } else if(ask.call==='3D'){
          target=L.H>=3?'3H':(L.H===2&&L.S===5?'3S':'3NT');
          semantic={natural:false,source:'course30-2D-2NT-texas-hearts-response',hcp:{min:24,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-2NT-texas-fit'};
          reason=`cours 30/28 : Texas Cœur après la redemande à 2SA => ${target}`;
        } else if(ask.call==='3H'){
          target=L.S>=3?'3S':'3NT';
          semantic={natural:false,source:'course30-2D-2NT-texas-spades-response',hcp:{min:24,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',publishWhenNative:true,convention:'course30-2D-2NT-texas-fit'};
          reason=`cours 30/28 : Texas Pique après la redemande à 2SA => ${target}`;
        }
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }

    // Après Stayman sans majeure sur 2D-...-2SA, le chassé-croisé est conservé ;
    // sans 5-4 majeur, 3SA est la conclusion minimale qui respecte le forcing de manche.
    if(relHistory.length===10){
      const [open,p1,ace,p2,nt,p3,stay,p4,ans,p5]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner&&open.call==='2D'&&nt.seat===partner&&nt.call==='2NT'&&stay.seat===seat&&stay.call==='3C'&&ans.seat===partner&&ans.call==='3D'&&p5.call==='PASS'){
        let target=null;if(L.S===5&&L.H===4)target='3H';else if(L.H===5&&L.S===4)target='3S';else if(raw==='PASS')target='3NT';
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:raw!==target,semantic:{natural:target==='3NT',source:'course30-2D-2NT-responder-after-stayman',hcp:{min:0,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',convention:'course30-2D-2NT-chasse-croise'},reason:`cours 30/28 : suite du Stayman après 2D forcing de manche => ${target}`};
      }
      // Si le Stayman trouve une majeure, le répondant choisit la manche dans
      // cette majeure avec quatre cartes, sinon 3SA. L'ouverture initiale étant
      // forcing de manche, PASS n'est jamais une conclusion possible ici.
      if(open.seat===partner&&open.call==='2D'&&nt.seat===partner&&nt.call==='2NT'&&stay.seat===seat&&stay.call==='3C'&&
         ans.seat===partner&&(ans.call==='3H'||ans.call==='3S')&&p5.call==='PASS'&&raw==='PASS'){
        const m=ans.call.slice(1),target=L[m]>=4?`4${m}`:'3NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat))return{call:target,changed:true,semantic:{natural:true,source:'course30-responder-game-after-stayman-major',forcing:'nonforcing',convention:'course30-2D-2NT-stayman-game'},reason:L[m]>=4?`cours 30/28 : Stayman trouve le fit ${m} => ${target}`:'cours 30/28 : Stayman sans fit dans la majeure répondue => 3SA'};
      }

      // Après un Texas rectifié avec fit, le répondant ne peut pas s'arrêter au palier 3.
      if(open.seat===partner&&open.call==='2D'&&nt.seat===partner&&nt.call==='2NT'&&p5.call==='PASS'&&raw==='PASS'){
        if(stay.call==='3D'&&ans.seat===partner&&ans.call==='3H'){
          const target='4H';if(!ctx.isLegal||ctx.isLegal(history,target,seat))return{call:target,changed:true,semantic:{natural:true,source:'course30-responder-game-after-texas-fit',forcing:'nonforcing',convention:'course30-2D-2NT-texas-game'},reason:'cours 30 : Texas Cœur rectifié avec fit, forcing de manche => 4H'};
        }
        if(stay.call==='3H'&&ans.seat===partner&&ans.call==='3S'){
          const target='4S';if(!ctx.isLegal||ctx.isLegal(history,target,seat))return{call:target,changed:true,semantic:{natural:true,source:'course30-responder-game-after-texas-fit',forcing:'nonforcing',convention:'course30-2D-2NT-texas-game'},reason:'cours 30 : Texas Pique rectifié avec fit, forcing de manche => 4S'};
        }
        // Exception du cours 28 : après Texas Cœur, 3S de l'ouvreur montre
        // exactement cinq Piques et seulement deux Cœurs. Le répondant choisit
        // alors 4S avec trois Piques ou plus, sinon revient à 3SA.
        if(stay.call==='3D'&&ans.seat===partner&&ans.call==='3S'){
          const target=L.S>=3?'4S':'3NT';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat))return{call:target,changed:raw!==target,semantic:{natural:true,source:'course30-responder-after-special-texas-spades',forcing:'nonforcing',convention:'course30-2D-2NT-special-3S-game'},reason:L.S>=3?'cours 30/28 : 3S montre cinq Piques/deux Cœurs et le répondant est fitté => 4S':'cours 30/28 : 3S montre cinq Piques/deux Cœurs ; sans fit Pique, retour à 3SA'};
        }
      }
    }

    // Cours 29 : après 2C-2D-2SA, les outils et développements Stayman/Texas
    // sont exactement ceux de l'ouverture de 2SA (seuils de force adaptés, mais
    // mêmes réponses distributionnelles). On applique donc les mêmes cibles sûres.
    if(relHistory.length===8){
      const [open,p1,relay,p2,nt,p3,ask,p4]=relHistory;
      if(open.seat===seat && open.call==='2C' && p1.call==='PASS' && relay.call==='2D' && p2.call==='PASS' &&
         nt.seat===seat && nt.call==='2NT' && p3.call==='PASS' && sideOf(ask.seat)===sideOf(seat) && ask.seat!==seat && p4.call==='PASS'){
        let target=null, semantic=null, reason='';
        if(ask.call==='3C'){
          const h4=L.H>=4,s4=L.S>=4; target=h4&&s4?'3NT':h4?'3H':s4?'3S':'3D';
          semantic={natural:false,source:'course29-2C-2NT-stayman-response',hcp:{min:22,max:23},forcing:'one_round_if_uncontested',convention:'course29-2C-2NT-stayman-response'};
          reason=`cours 29/28 : Stayman après 2C-2D-2SA, H${L.H}/S${L.S} => ${target}`;
        } else if(ask.call==='3D'){
          target=L.H>=3?'3H':(L.H===2&&L.S===5?'3S':'3NT');
          semantic={natural:false,source:'course29-2C-2NT-texas-hearts-response',hcp:{min:22,max:23},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',convention:'course29-2C-2NT-texas-fit-response'};
          reason=`cours 29/28 : Texas Cœur après 2C-2D-2SA => ${target}`;
        } else if(ask.call==='3H'){
          target=L.S>=3?'3S':'3NT';
          semantic={natural:false,source:'course29-2C-2NT-texas-spades-response',hcp:{min:22,max:23},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',convention:'course29-2C-2NT-texas-fit-response'};
          reason=`cours 29/28 : Texas Pique après 2C-2D-2SA => ${target}`;
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }

    if(relHistory.length===10){
      const [open,p1,relay,p2,nt,p3,stay,p4,ans,p5]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2C' && p1.call==='PASS' && relay.seat===seat && relay.call==='2D' && p2.call==='PASS' &&
         nt.seat===partner && nt.call==='2NT' && p3.call==='PASS' && stay.seat===seat && stay.call==='3C' && p4.call==='PASS' &&
         ans.seat===partner && ans.call==='3D' && p5.call==='PASS'){
        let target=null;if(L.S===5&&L.H===4)target='3H';else if(L.H===5&&L.S===4)target='3S';else if(raw==='PASS')target='3NT';
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:raw!==target,semantic:{natural:target==='3NT',source:'course29-2C-2NT-chasse-croise',suits:{S:{min:L.S,max:L.S},H:{min:L.H,max:L.H}},hcp:{min:0,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',convention:'course29-2C-2NT-chasse-croise'},reason:target==='3NT'?'cours 29/28 : Stayman sans majeure et sans 5-4 => conclusion à 3SA':`cours 29/28 : chassé-croisé après 2C-2D-2SA => ${target}`};
      }
    }

    if(relHistory.length===12){
      const [open,p1,relay,p2,nt,p3,stay,p4,ans,p5,cross,p6]=relHistory;
      if(open.seat===seat&&open.call==='2C'&&relay.call==='2D'&&nt.seat===seat&&nt.call==='2NT'&&stay.call==='3C'&&ans.seat===seat&&ans.call==='3D'&&p6.call==='PASS'){
        let target=null;if(cross.call==='3H')target=L.S>=3?'3S':'3NT';else if(cross.call==='3S')target=L.H>=3?(raw==='PASS'?'4H':null):'3NT';
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:raw!==target,semantic:{natural:target==='3NT'||target==='4H',source:'course29-2C-2NT-after-chasse-croise',hcp:{min:22,max:23},forcing:target==='3S'?'one_round_if_uncontested':'nonforcing',convention:'course29-2C-2NT-chasse-croise-fit'},reason:`cours 29/28 : suite du chassé-croisé après 2C-2D-2SA => ${target}`};
      }
    }


    // Cours 29/28 : après le Stayman de la séquence 2C-2D-2SA, une réponse
    // majeure trouvée conduit à la manche ; 3SA signifie les deux majeures et le
    // répondant utilise les mêmes transferts 4C/4D que sur l'ouverture de 2SA.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,relay,p2,nt,p3,stay,p4,ans,p5]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner&&open.call==='2C'&&relay.seat===seat&&relay.call==='2D'&&nt.seat===partner&&nt.call==='2NT'&&
         stay.seat===seat&&stay.call==='3C'&&ans.seat===partner&&p5.call==='PASS'){
        let target=null,semantic=null,reason='';
        if(ans.call==='3H'||ans.call==='3S'){
          const m=ans.call.slice(1);target=L[m]>=4?`4${m}`:'3NT';
          semantic={natural:true,source:'course29-responder-after-stayman-major',forcing:'nonforcing',convention:'course29-2C-2NT-stayman-game-choice'};
          reason=L[m]>=4?`cours 29/28 : Stayman trouve le fit ${m} => ${target}`:'cours 29/28 : pas de fit dans la majeure répondue => 3SA';
        } else if(ans.call==='3NT'){
          if(L.H>=4&&L.S<4)target='4C'; else if(L.S>=4&&L.H<4)target='4D';
          else if(L.H>=4&&L.S>=4){const pref=majorPreference(ctx.deal,seat,4,4);target=pref==='H'?'4C':'4D';}
          if(target){semantic={natural:false,source:'course29-responder-transfer-after-both-majors',forcing:'one_round_if_uncontested',convention:'course29-2C-2NT-both-majors-transfer'};reason=`cours 29/28 : 3SA montre les deux majeures ; transfert ${target} vers la majeure choisie`;}
        }
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:true,semantic,reason};
      }
    }

    if(relHistory.length===12){
      const [open,p1,relay,p2,nt,p3,stay,p4,ans,p5,tr,p6]=relHistory;
      if(open.seat===seat&&open.call==='2C'&&relay.call==='2D'&&nt.seat===seat&&nt.call==='2NT'&&stay.call==='3C'&&ans.seat===seat&&ans.call==='3NT'&&p6.call==='PASS'){
        const target=tr.call==='4C'?'4H':tr.call==='4D'?'4S':null;
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:raw!==target,semantic:{natural:true,source:'course29-opener-rectify-both-majors-transfer',forcing:'nonforcing',convention:'course29-2C-2NT-both-majors-transfer'},reason:`cours 29/28 : rectification automatique du transfert après réponse des deux majeures => ${target}`};
      }
    }

    // Après chassé-croisé 3H = cinq Piques, l'ouvreur fitté dit 3S pour
    // préserver l'espace de chelem ; avec une main faible, le répondant doit alors
    // fermer à 4S et ne peut pas passer au palier de 3.
    if(relHistory.length===14 && raw==='PASS'){
      const [open,p1,relay,p2,nt,p3,stay,p4,ans,p5,cross,p6,fit,p7]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner&&open.call==='2C'&&nt.seat===partner&&nt.call==='2NT'&&stay.seat===seat&&stay.call==='3C'&&
         ans.seat===partner&&ans.call==='3D'&&cross.seat===seat&&cross.call==='3H'&&fit.seat===partner&&fit.call==='3S'&&p7.call==='PASS'){
        if(!ctx.isLegal||ctx.isLegal(history,'4S',seat))return{call:'4S',changed:true,semantic:{natural:true,source:'course29-responder-close-spade-game-after-chasse',forcing:'nonforcing',convention:'course29-2C-2NT-chasse-croise-game'},reason:'cours 29/28 : 3S de l’ouvreur montre le fit dans les cinq Piques ; sans autre action PONS, conclusion à 4S'};
      }
    }

    // Cours 28 : développements déterministes après l'ouverture de 2SA.
    // Le Stayman et les Texas ont ici des réponses très codifiées. On corrige
    // uniquement les choix entièrement définis par la distribution, sans toucher
    // aux décisions de jugement de chelem ou de contrôles.
    if(relHistory.length===4){
      const [open,opp,resp,opp2]=relHistory;
      if(open.seat===seat && open.call==='2NT' && opp.call==='PASS' && opp2.call==='PASS' &&
         sideOf(resp.seat)===sideOf(seat) && resp.seat!==seat && openingEvent(history)===open){
        let target=null, semantic=null, reason='';
        if(resp.call==='3C'){
          const h4=L.H>=4, s4=L.S>=4;
          target=h4&&s4?'3NT':h4?'3H':s4?'3S':'3D';
          semantic={natural:false,source:'course28-2NT-stayman-response',suits:{H:{min:h4?4:0,max:h4?13:3},S:{min:s4?4:0,max:s4?13:3}},hcp:{min:20,max:37},forcing:'one_round_if_uncontested',convention:'course28-2NT-stayman-response'};
          reason=`cours 28 : réponse au Stayman sur 2SA (H${L.H}/S${L.S}) => ${target}`;
        } else if(resp.call==='3D'){
          // Texas Cœur : la rectification à 3H garantit le fit 3+. Sans fit,
          // 3SA ; exception documentée, cinq Piques et seulement deux Cœurs => 3S.
          if(L.H>=3) target='3H';
          else if(L.H===2 && L.S===5) target='3S';
          else target='3NT';
          semantic={natural:false,source:'course28-2NT-texas-hearts-response',suits:{H:{min:L.H>=3?3:0,max:L.H>=3?13:2}},hcp:{min:20,max:37},forcing:'nonforcing',convention:'course28-2NT-texas-fit-response'};
          reason=L.H>=3?'cours 28 : Texas Cœur, rectification fittée à 3H':(L.H===2&&L.S===5?'cours 28 : Texas Cœur sans fit, mais cinq Piques et deux Cœurs => 3S':'cours 28 : Texas Cœur sans fit => 3SA');
        } else if(resp.call==='3H'){
          // Texas Pique : rectification fittée, 3SA avec deux cartes ou moins.
          target=L.S>=3?'3S':'3NT';
          semantic={natural:false,source:'course28-2NT-texas-spades-response',suits:{S:{min:L.S>=3?3:0,max:L.S>=3?13:2}},hcp:{min:20,max:37},forcing:'nonforcing',convention:'course28-2NT-texas-fit-response'};
          reason=L.S>=3?'cours 28 : Texas Pique, rectification fittée à 3S':'cours 28 : Texas Pique sans fit => 3SA';
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }
    }

    // Cours 28 : deux réponses directes du répondant imposent une réaction
    // très précise de l'ouvreur. 4M direct avec une majeure sixième est une enchère
    // d'arrêt absolu : l'ouvreur doit passer. 4D décrit un 5-5 majeur dans deux zones
    // extrêmes ; l'ouvreur ne fait que choisir sa majeure préférée au palier de 4.
    if(relHistory.length===4){
      const [open,p1,resp,p2]=relHistory, latestConvention=ctx.semanticContext?.entry?.explicitMeaning?.convention;
      if(open.seat===seat && open.call==='2NT' && p1.call==='PASS' && p2.call==='PASS' && resp.seat!==seat && sideOf(resp.seat)===sideOf(seat)){
        if((resp.call==='4H'||resp.call==='4S') && latestConvention==='course28-2NT-six-major-stop'){
          return {call:'PASS',changed:raw!=='PASS',semantic:{natural:false,source:'course28-opener-respects-direct-major-stop',forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-six-major-stop'},reason:'cours 28 : 4M direct sur 2SA avec une majeure sixième est une enchère d’arrêt ; l’ouvreur ne reparle pas'};
        }
        if(resp.call==='4D' && latestConvention==='course28-2NT-major-55'){
          let pref='S';
          if(L.H!==L.S) pref=L.H>L.S?'H':'S';
          else {const qH=suitHcp(ctx.deal,seat,'H'),qS=suitHcp(ctx.deal,seat,'S'); if(qH!==qS)pref=qH>qS?'H':'S';}
          const target=`4${pref}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course28-opener-major55-preference',suits:{[pref]:{min:0,max:13}},hcp:{min:20,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-major-55-preference'},reason:`cours 28 : sur 4D bicolore majeur 5-5, l’ouvreur choisit simplement sa majeure préférée => ${target}`};
        }
        if(resp.call==='3S' && (latestConvention==='course28-2NT-texas-clubs'||latestConvention==='course28-2NT-minor-slam-try')){
          // Le Texas mineur est forcing un tour : l'ouvreur doit prendre position.
          // Seul un complément clairement favorable justifie la rectification ;
          // tous les autres cas reviennent au Sans-Atout économique.
          const target=goodMinorSlamSupport(ctx.deal,seat,'C')?'4C':'3NT';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:raw!==target,semantic:{natural:target==='4C',source:'course28-opener-after-club-texas',suits:{C:{min:L.C,max:L.C}},hcp:{min:20,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-texas-clubs-response'},reason:target==='3NT'?'cours 28 : Texas Trèfle, complément insuffisant pour le chelem => refus économique à 3SA':'cours 28 : Texas Trèfle, bon complément => rectification à 4C pour accepter l’exploration du chelem'};
        }
        if(resp.call==='4C' && latestConvention==='course28-2NT-texas-diamonds'){
          // Même principe sur le Texas Carreau : PASS est exclu puisque 4C est forcing.
          const target=goodMinorSlamSupport(ctx.deal,seat,'D')?'4D':'4NT';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)) return {call:target,changed:raw!==target,semantic:{natural:target==='4D',source:'course28-opener-after-diamond-texas',suits:{D:{min:L.D,max:L.D}},hcp:{min:20,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-texas-diamonds-response'},reason:target==='4NT'?'cours 28 : Texas Carreau, complément insuffisant pour le chelem => refus à 4SA':'cours 28 : Texas Carreau, bon complément => rectification simple à 4D'};
        }
      }
    }

    // Cours 28 : après un Texas majeur direct sur 2SA, une rectification fittée
    // ne peut pas devenir le contrat final au palier de 3 puisque toute action du
    // répondant sur 2SA engage le camp à la manche. L'exception 3S après Texas
    // Cœur (cinq Piques, deux Cœurs) conduit à 4S avec le fit, sinon à 3SA.
    if(relHistory.length===6 && raw==='PASS'){
      const [open,p1,tr,p2,ans,p3]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner&&open.call==='2NT'&&p1.call==='PASS'&&tr.seat===seat&&p2.call==='PASS'&&ans.seat===partner&&p3.call==='PASS'&&openingEvent(history)===open){
        let target=null,reason='';
        if(tr.call==='3D'&&ans.call==='3H'){target='4H';reason='cours 28 : Texas Cœur rectifié avec fit => conclusion minimale à 4H';}
        else if(tr.call==='3H'&&ans.call==='3S'){target='4S';reason='cours 28 : Texas Pique rectifié avec fit => conclusion minimale à 4S';}
        else if(tr.call==='3D'&&ans.call==='3S'){target=L.S>=3?'4S':'3NT';reason=L.S>=3?'cours 28 : 3S montre cinq Piques/deux Cœurs ; fit Pique => 4S':'cours 28 : 3S montre cinq Piques/deux Cœurs ; sans fit Pique => 3SA';}
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:true,semantic:{natural:true,source:'course28-responder-game-after-texas',forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-texas-game-closure'},reason};
      }
    }

    // Cours 28 : avec un bicolore mineur 5-5 suffisamment fort, le répondant
    // commence par le Texas Trèfle. Si l'ouvreur refuse à 3SA, 4D décrit alors
    // naturellement la deuxième mineure.
    if(relHistory.length===6){
      const [open,p1,tr,p2,ans,p3]=relHistory, partner=partnerOf(seat);
      const HL=hlPoints(ctx.deal,seat);
      if(open.seat===partner && open.call==='2NT' && p1.call==='PASS' && tr.seat===seat && tr.call==='3S' &&
         p2.call==='PASS' && ans.seat===partner && ans.call==='3NT' && p3.call==='PASS' &&
         L.C>=5 && L.D>=5 && HL>=11){
        if(!ctx.isLegal||ctx.isLegal(history,'4D',seat)) return {call:'4D',changed:raw!=='4D',semantic:{natural:true,source:'course28-responder-minor55-second-suit',suits:{C:{min:5,max:13},D:{min:5,max:13}},hcp:{min:0,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-minor-55'},reason:'cours 28 : après refus du Texas Trèfle à 3SA, 4D décrit naturellement le bicolore mineur 5-5'};
      }
    }

    // Cours 28 — après Texas Trèfle refusé à 3SA puis 4D = bicolore mineur
    // 5-5, les enchères de 4H/4S de l'ouvreur agréent l'atout Carreau. On choisit
    // le premier contrôle disponible avec un vrai fit Carreau ; sans fit, 4SA reste
    // le refus naturel de l'exploration.
    if(relHistory.length===8 && raw==='PASS'){
      const [open,p1,tr,p2,ans,p3,show55,p4]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course28-responder-minor55-second-suit');
      const frame=open.seat===seat&&open.call==='2NT'&&p1.call==='PASS'&&tr.seat===partner&&tr.call==='3S'&&p2.call==='PASS'&&
        ans.seat===seat&&ans.call==='3NT'&&p3.call==='PASS'&&show55.seat===partner&&show55.call==='4D'&&p4.call==='PASS'&&pm;
      if(frame){
        if(L.D>=3){
          const controls=['H','S']; let target='4H';
          for(const su of controls){const cards=String(ctx.deal?.hands?.[seat]?.[su]||''); if(cards.length<=1||/[AK]/.test(cards)){target=`4${su}`;break;}}
          if(legal(target)) return {call:target,changed:true,semantic:{natural:false,source:'course28-opener-agrees-diamonds-after-minor55',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-minor-55',suits:{D:{min:3,max:13}}},reason:`cours 28 : 4D décrit le 5-5 mineur ; fit Carreau => ${target} agrée l'atout et montre un contrôle`};
        }
        if(legal('4NT')) return {call:'4NT',changed:true,semantic:{natural:true,source:'course28-opener-declines-minor55-no-diamond-fit',forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-minor-55'},reason:'cours 28 : 4D décrit le 5-5 mineur ; sans fit Carreau, refus à 4SA'};
      }
    }

    // Cours 28 : dans la zone intermédiaire du 5-5 majeur, le répondant commence
    // par le Texas Pique 3H puis annonce systématiquement 4H, que l'ouvreur ait
    // rectifié à 3S ou refusé le fit par 3SA.
    if(relHistory.length===6){
      const [open,p1,tr,p2,ans,p3]=relHistory, partner=partnerOf(seat);
      const HL=hlPoints(ctx.deal,seat);
      if(open.seat===partner && open.call==='2NT' && p1.call==='PASS' && tr.seat===seat && tr.call==='3H' &&
         p2.call==='PASS' && ans.seat===partner && (ans.call==='3S'||ans.call==='3NT') && p3.call==='PASS' &&
         L.H===5 && L.S===5 && HL>=9 && HL<=12){
        if(!ctx.isLegal||ctx.isLegal(history,'4H',seat)) return {call:'4H',changed:raw!=='4H',semantic:{natural:true,source:'course28-responder-major55-intermediate-second-call',suits:{H:{min:5,max:5},S:{min:5,max:5}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-major-55-intermediate'},reason:'cours 28 : 5-5 majeur intermédiaire, après le Texas Pique le répondant nomme 4H quelle que soit la réaction de l’ouvreur'};
      }
    }

    // Cours 28 — l'ouvreur doit conserver le vrai sens du 4H intermédiaire :
    // exactement 5 Piques-5 Cœurs chez le répondant. En particulier, un chelem
    // natif à Pique ne peut pas être fondé sur une sixième carte imaginaire.
    if(relHistory.length===8){
      const [open,p1,tr,p2,ans,p3,show55,p4]=relHistory, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.source==='course28-responder-major55-intermediate-second-call');
      const frame=open.seat===seat&&open.call==='2NT'&&p1.call==='PASS'&&tr.seat===partner&&tr.call==='3H'&&p2.call==='PASS'&&ans.seat===seat&&(ans.call==='3S'||ans.call==='3NT')&&p3.call==='PASS'&&show55.seat===partner&&show55.call==='4H'&&p4.call==='PASS'&&pm;
      // Avec deux cartes (ou moins) dans chaque majeure, aucun fit huitième
      // n'est connu. Un saut natif direct au petit chelem qui suppose une sixième
      // carte chez le répondant contredit le 5-5 exact publié. On revient au choix
      // de manche ; une vraie poursuite de chelem passe par 4SA, traité juste après.
      if(frame&&(raw==='6H'||raw==='6S')&&L.H<=2&&L.S<=2){
        const pref=majorPreference(ctx.deal,seat,5,5), target=pref==='H'?'PASS':'4S';
        if(target==='PASS'||legal(target)) return {
          call:target,changed:true,semantic:{natural:false,source:'course28-opener-stops-no-fit-after-major55-intermediate',suits:{H:{min:L.H,max:L.H},S:{min:L.S,max:L.S}},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-major-55-intermediate'},reason:`cours 28 : 4H montre exactement 5-5 majeur ; sans fit huitième et sans passage par 4SA, ${raw} repose sur une longueur imaginaire => ${target==='PASS'?'arrêt à 4H':'préférence 4S'}`
        };
      }
      if(frame&&raw==='6S'&&L.H>=3&&L.S<=2&&legal('6H')) return {
        call:'6H',changed:true,semantic:{natural:true,source:'course28-opener-corrects-slam-strain-after-major55-intermediate',suits:{H:{min:3,max:13},S:{min:0,max:2}},hcp:{min:20,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'course28-2NT-major-55-intermediate'},reason:'cours 28 : 4H montre exactement 5-5 majeur ; avec trois Cœurs et seulement deux Piques, le vrai fit de chelem est Cœur, pas Pique'
      };
      if(frame&&raw==='4NT'&&legal('4NT')) return {
        call:'4NT',changed:false,semantic:{natural:false,source:'course28-opener-slam-continue-after-major55-intermediate',suits:{H:{min:L.H,max:L.H},S:{min:L.S,max:L.S}},hcp:{min:20,max:21},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'course28-2NT-major-55-intermediate'},reason:'cours 28 : 4SA poursuit le chelem en connaissant exactement le 5-5 majeur du répondant'
      };
    }

    // Après 2SA-3C-3D, le chassé-croisé décrit les 5-4 majeurs : 3H montre
    // cinq Piques et quatre Cœurs, 3S cinq Cœurs et quatre Piques.
    if(relHistory.length===6){
      const [open,p1,stay,p2,ans,p3]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner && open.call==='2NT' && p1.call==='PASS' && stay.seat===seat && stay.call==='3C' &&
         p2.call==='PASS' && ans.seat===partner && ans.call==='3D' && p3.call==='PASS' && openingEvent(history)===open){
        let target=null;
        if(L.S===5 && L.H===4) target='3H';
        else if(L.H===5 && L.S===4) target='3S';
        else if(raw==='PASS') target='3NT';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          return {
            call:target,changed:raw!==target,
            semantic:{natural:target==='3NT',source:'course28-stayman-crossed-major',suits:{S:{min:L.S,max:L.S},H:{min:L.H,max:L.H}},hcp:{min:0,max:37},forcing:target==='3NT'?'nonforcing':'one_round_if_uncontested',convention:'course28-stayman-chasse-croise'},
            reason:target==='3NT'?'cours 28 : Stayman sans majeure et sans 5-4 majeur => 3SA':`cours 28 : après 2SA-3C-3D, chassé-croisé ${L.S} Piques/${L.H} Cœurs => ${target}`
          };
        }
      }
    }

    // Après une réponse majeure (ou les deux majeures) au Stayman de 2SA,
    // le répondant ne peut pas s'arrêter au palier de 3 : avec le fit il conclut
    // à la manche, sans fit il revient à 3SA. Sur 3SA = deux majeures, les transferts
    // 4C->4H et 4D->4S font jouer le contrat de la main forte.
    if(relHistory.length===6 && ['PASS','3NT','4H','4S','4NT'].includes(raw)){
      const [open,p1,stay,p2,ans,p3]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner&&open.call==='2NT'&&p1.call==='PASS'&&stay.seat===seat&&stay.call==='3C'&&p2.call==='PASS'&&ans.seat===partner&&p3.call==='PASS'){
        let target=null,semantic=null,reason='';
        const HL=hlPoints(ctx.deal,seat);
        if(ans.call==='3H'||ans.call==='3S'){
          const m=ans.call.slice(1), fitted=L[m]>=4;
          target=fitted?(HL>=12?'4NT':`4${m}`):(HL>=12?'4NT':'3NT');
          semantic={natural:target==='3NT'||target===`4${m}`,source:HL>=12?'v237-course28-stayman-slam-path':'course28-responder-after-stayman-major',hcp:{min:0,max:37},forcing:HL>=12?'one_round_if_uncontested':'nonforcing',convention:HL>=12?(fitted?'rkcb30-41':'course28-2NT-quantitative-frame'):'course28-stayman-game-choice'};
          reason=HL>=12?(fitted?`qualité contrat : Stayman trouve le fit ${m}, ${HL} HL => 4SA RKCB au lieu de fermer à la manche`:`qualité contrat : Stayman sans fit dans la majeure répondue, ${HL} HL => 4SA quantitatif`):(fitted?`cours 28 : fit trouvé après Stayman => ${target}`:'cours 28 : pas de fit dans la majeure répondue => 3SA');
        } else if(ans.call==='3NT'){
          if(L.H>=4&&L.S<4)target='4C'; else if(L.S>=4&&L.H<4)target='4D';
          else if(L.H>=4&&L.S>=4){
            // Avec les deux majeures chez le répondant, choisir la plus longue ; à
            // égalité, le PASS est impossible puisque 3SA a promis les deux majeures.
            // On tranche alors sur la qualité des couleurs (puis Pique à égalité),
            // et on utilise le sous-Texas correspondant pour faire jouer la main forte.
            if(L.H>L.S)target='4C'; else if(L.S>L.H)target='4D';
            else target=majorPreference(ctx.deal,seat,4,4)==='H'?'4C':'4D';
          }
          if(target){
            semantic={natural:false,source:'course28-responder-transfer-after-both-majors',hcp:{min:0,max:37},forcing:'one_round_if_uncontested',convention:'course28-stayman-both-majors-transfer'};
            reason=`cours 28 : 3SA montre les deux majeures ; transfert ${target} pour faire jouer la manche par l'ouvreur`;
          }
        }
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:true,semantic,reason};
      }
    }

    // L'ouvreur rectifie automatiquement les transferts consécutifs à sa réponse
    // de 3SA (deux majeures) au Stayman.
    if(relHistory.length===8){
      const [open,p1,stay,p2,ans,p3,tr,p4]=relHistory;
      if(open.seat===seat&&open.call==='2NT'&&stay.call==='3C'&&ans.seat===seat&&ans.call==='3NT'&&p4.call==='PASS'){
        const target=tr.call==='4C'?'4H':tr.call==='4D'?'4S':null;
        if(target&&(!ctx.isLegal||ctx.isLegal(history,target,seat)))return{call:target,changed:raw!==target,semantic:{natural:true,source:'course28-opener-rectify-both-majors-transfer',forcing:'nonforcing',convention:'course28-stayman-both-majors-transfer'},reason:`cours 28 : transfert après réponse des deux majeures => ${target}`};
      }
    }

    // Suite du chassé-croisé : après 3H (cinq Piques), l'ouvreur montre
    // automatiquement le fit à 3S s'il en possède trois, sinon revient à 3SA.
    // Après 3S (cinq Cœurs), l'absence de trois Cœurs impose également 3SA ;
    // avec le fit, le cours laisse un choix entre 4H et un contrôle, donc PONS garde la main.
    if(relHistory.length===8){
      const [open,p1,stay,p2,ans,p3,cross,p4]=relHistory;
      if(open.seat===seat && open.call==='2NT' && p1.call==='PASS' && stay.call==='3C' && p2.call==='PASS' &&
         ans.seat===seat && ans.call==='3D' && p3.call==='PASS' && sideOf(cross.seat)===sideOf(seat) && cross.seat!==seat && p4.call==='PASS'){
        let target=null;
        if(cross.call==='3H') target=L.S>=3?'3S':'3NT';
        else if(cross.call==='3S') target=L.H>=3?(raw==='PASS'?'4H':null):'3NT';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          return {
            call:target,changed:raw!==target,
            semantic:{natural:target==='3NT'||target==='4H',source:'course28-opener-after-chasse-croise',hcp:{min:20,max:37},forcing:target==='3S'?'one_round_if_uncontested':'nonforcing',convention:'course28-stayman-chasse-croise-fit'},
            reason:`cours 28 : suite du chassé-croisé ${cross.call}, distribution H${L.H}/S${L.S} => ${target}`
          };
        }
      }
    }


    // Après le chassé-croisé direct de 2SA, 3S de l'ouvreur montre le fit dans
    // les cinq Piques du répondant. Le palier de 3 n'est qu'un espace de chelem :
    // si le répondant n'a rien d'autre à dire, il conclut à 4S.
    if(relHistory.length===10 && raw==='PASS'){
      const [open,p1,stay,p2,ans,p3,cross,p4,fit,p5]=relHistory, partner=partnerOf(seat);
      if(open.seat===partner&&open.call==='2NT'&&stay.seat===seat&&stay.call==='3C'&&ans.seat===partner&&ans.call==='3D'&&
         cross.seat===seat&&cross.call==='3H'&&fit.seat===partner&&fit.call==='3S'&&p5.call==='PASS'){
        if(!ctx.isLegal||ctx.isLegal(history,'4S',seat))return{call:'4S',changed:true,semantic:{natural:true,source:'course28-responder-close-spade-game-after-chasse',forcing:'nonforcing',convention:'course28-stayman-chasse-croise-game'},reason:'cours 28 : fit Pique trouvé par 3S après chassé-croisé => conclusion à 4S'};
      }
    }

    // Cours 11 : après 1M-(2m), le Spoutnik généralisé couvre notamment les mains
    // sans fit dans la majeure d'ouverture qui possèdent exactement cinq cartes dans
    // l'autre majeure mais seulement 8-10 H/HL. Avec 8-10 H et cinq cartes, la réponse
    // naturelle au palier de 2 surévalue la main : X est la voie documentée.
    // On exclut le cas où une mineure sixième peut être annoncée naturellement au palier 2.
    if(relHistory.length===2){
      const [open,over]=relHistory, ob=parseBid(open.call), ib=parseBid(over.call), partner=partnerOf(seat);
      if(open.seat===partner && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
         ib?.level===2 && (ib.strain==='C'||ib.strain==='D') && sideOf(over.seat)!==sideOf(seat)){
        const otherMajor=ob.strain==='H'?'S':'H';
        const otherMinor=ib.strain==='C'?'D':'C';
        const naturalMinorAtTwo=L[otherMinor]>=6 && H>=8 && cheapestSuitBidAfter(history,`2${otherMinor}`);
        if(L[ob.strain]<=2 && L[otherMajor]===5 && H>=8 && H<=10 && !naturalMinorAtTwo &&
           (!ctx.isLegal||ctx.isLegal(history,'X',seat))){
          const target='X';
          return {
            call:target,
            changed:raw!==target,
            semantic:{
              natural:false,
              source:'course11-generalized-spoutnik-five-card-major',
              suits:{[otherMajor]:{min:4,max:5},[ob.strain]:{min:0,max:2}},
              hcp:{min:8,max:37},
              forcing:'unknown',
              convention:'course11-generalized-spoutnik'
            },
            reason:`cours 11 : ${H} H avec cinq ${otherMajor}, sans fit dans ${ob.strain} => contre Spoutnik plutôt que ${raw}`
          };
        }
      }

      // Cours 24 : après 1M-(2m), le contre sert aussi à différer l'expression
      // d'un soutien fort de trois cartes (16+ HLD), car 2SA est réservé au fit de
      // 11-15 HLD. Une belle couleur cinquième naturelle reste prioritaire : dans ce
      // cas l'overlay laisse PONS annoncer la couleur avant de fitter.
      if(open.seat===partner && ob?.level===1 && (ob.strain==='H'||ob.strain==='S') &&
         ib?.level===2 && (ib.strain==='C'||ib.strain==='D') && sideOf(over.seat)!==sideOf(seat)){
        const otherMajor=ob.strain==='H'?'S':'H';
        const hld=supportHld(ctx.deal,seat,ob.strain);
        const sideFive=SUITS.some(s=>s!==ob.strain && s!==ib.strain && L[s]>=5);
        if(L[ob.strain]===3 && L[otherMajor]<=3 && hld>=16 && !sideFive &&
           (!ctx.isLegal||ctx.isLegal(history,'X',seat))){
          return {
            call:'X', changed:raw!=='X',
            semantic:{
              natural:false,
              source:'course24-major-spoutnik-strong-three-card-fit',
              suits:{[ob.strain]:{min:3,max:3}},
              hcp:{min:0,max:37},
              forcing:'unknown',
              convention:'course24-major-spoutnik-strong-3fit'
            },
            reason:`cours 24 : fit de trois cartes trop fort pour 2SA (${hld} HLD) => contre puis soutien différé`
          };
        }

        // Le même contre remplace ponctuellement une enchère naturelle de Sans-Atout
        // lorsque le répondant n'a ni fit, ni autre majeure, ni couleur cinquième à
        // annoncer et doit rechercher l'arrêt dans la couleur d'intervention. On garde
        // une fenêtre volontairement étroite (13-16 H, main régulière/semi-régulière,
        // arrêt insuffisant) afin de ne pas détourner des mains de jugement compétitif.
        if(L[ob.strain]<=2 && L[otherMajor]<=3 && H>=13 && H<=16 && balanced(L) &&
           !sideFive && stopperScore(ctx.deal,seat,ib.strain)<0.7 &&
           (!ctx.isLegal||ctx.isLegal(history,'X',seat))){
          return {
            call:'X', changed:raw!=='X',
            semantic:{
              natural:false,
              source:'course24-major-spoutnik-nt-stopper-search',
              hcp:{min:13,max:16},
              forcing:'unknown',
              convention:'course24-major-spoutnik-nt-route'
            },
            reason:`cours 24 : main orientée Sans-Atout ${H} H sans arrêt suffisant dans ${ib.strain} => contre avant de nommer SA`
          };
        }
      }

      // Cours 24 : séquence particulière 1D-(2C)-X. Le contre garantit au moins
      // une majeure quatrième, mais les mains de 8-11 H avec une seule majeure
      // doivent prévoir un terrain d'atterrissage. Pour l'overlay automatique on ne
      // retient que les poches explicitement décrites par le cours : deux majeures 4-4,
      // une majeure quatrième avec fit Carreau, une majeure quatrième avec 10-11 H
      // et arrêt Trèfle, cinq Piques faibles, ou cinq Cœurs faibles avec trois Piques.
      // À partir de 12 H, une majeure exactement quatrième suffit ; une majeure 5e
      // forte reste une enchère naturelle et n'est pas détournée vers le contre.
      if(open.seat===partner && open.call==='1D' && over.call==='2C' && sideOf(over.seat)!==sideOf(seat)){
        const both4=L.H===4 && L.S===4;
        const one4=(L.H===4&&L.S<=3)||(L.S===4&&L.H<=3);
        const weak5S=L.S===5&&L.H<=3&&H>=8&&H<=10;
        const weak5H=L.H===5&&L.S===3&&H>=8&&H<=10;
        const one4HasLanding=one4 && ((H>=12) || (H>=8&&L.D>=4) || (H>=10&&H<=11&&stopperScore(ctx.deal,seat,'C')>=0.7));
        const spoutnik2C=(both4&&H>=8) || one4HasLanding || weak5S || weak5H;
        if(spoutnik2C && (!ctx.isLegal||ctx.isLegal(history,'X',seat))){
          const target='X', suitInfo={};
          if(L.H>=4) suitInfo.H={min:4,max:L.H===5?5:4};
          if(L.S>=4) suitInfo.S={min:4,max:L.S===5?5:4};
          return {
            call:target,
            changed:raw!==target,
            semantic:{
              natural:false,
              source:'course24-1D-2C-spoutnik-safe',
              suits:suitInfo,
              hcp:{min:8,max:37},
              forcing:'unknown',
              convention:'course24-1D-2C-spoutnik'
            },
            reason:`cours 24 : 1D-(2C), contre Spoutnik documenté avec ${H} H et majeures H${L.H}/S${L.S}`
          };
        }
      }
      return null;
    }

    // v2.19 — le contre « sans majeure » conserve son sens même si le n°4
    // surenchérit. PONS natif peut alors le relire comme un Spoutnik promettant
    // quatre Piques ; on valide ou corrige la redemande de l'ouvreur avec notre
    // vraie signification, sans inventer un fit chez le partenaire.
    if(relHistory.length===4){
      const [open,over,dbl,oppAct]=relHistory;
      const pm=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course24-spoutnik-stopper-ask');
      const ib=parseBid(over.call), ab=parseBid(oppAct.call), ob=parseBid(open.call);
      const frame=open.seat===seat&&dbl.call==='X'&&pm&&oppAct.call!=='PASS'&&ib&&ob;
      if(frame){
        // Une enchère naturelle de notre propre main reste valable, mais elle ne
        // doit plus être justifiée par une longueur imaginaire du contreur.
        const rb=parseBid(raw);
        if(rb&&rb.strain!=='NT'&&ab&&rb.strain!==ab.strain&&L[rb.strain]>=4&&legal(raw)) return {
          call:raw,changed:false,semantic:{natural:true,source:'course24-opener-natural-after-stopper-double-competition',suits:{[rb.strain]:{min:4,max:13}},hcp:{min:10,max:19},forcing:'unknown',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},reason:'cours 24 : le Contre partenaire ne promet pas la majeure ; la redemande est validée uniquement par la longueur propre de l’ouvreur'
        };
        if(rb?.strain==='NT'&&ib?.strain&&stopperScore(ctx.deal,seat,ib.strain)>=0.7&&legal(raw)){
          const min=rb.level>=3?17:14;
          if(H>=min) return {call:raw,changed:false,semantic:{natural:true,source:'course24-opener-nt-after-stopper-double-competition',hcp:{min,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},reason:`cours 24 : le Contre ne promet pas quatre Piques ; ${raw} est validé par la force propre de l'ouvreur et l'arrêt ${ib.strain}`};
        }
        // Si PONS cue-bidde la couleur du n°4 parce qu'il croit à un fit majeur,
        // revenir d'abord à une vraie couleur d'ouverture cinquième.
        if(rb&&ab&&rb.strain===ab.strain&&L[ob.strain]>=5){
          const target=cheapestSuitCallAfter(history,ob.strain);
          if(target&&legal(target)) return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-opener-repeat-after-stopper-double-competition',suits:{[ob.strain]:{min:5,max:13}},hcp:{min:10,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},reason:`cours 24 : le Contre ne promet pas de fit ${ab.strain}; retour naturel à ${target}`};
        }
        // Même protection si PONS nomme une nouvelle couleur qu'il ne possède pas
        // réellement, simplement parce qu'il a relu le Contre comme promettant cette
        // couleur. Après compétition du n°4, une couleur propre <4e ne peut pas être
        // validée : avec une ouverture mineure 5e, on revient à sa répétition naturelle.
        if(rb&&rb.strain!=='NT'&&rb.strain!==ob.strain&&L[rb.strain]<4&&L[ob.strain]>=5){
          const target=cheapestSuitCallAfter(history,ob.strain);
          if(target&&legal(target)) return {call:target,changed:true,semantic:{natural:true,source:'course24-opener-repeat-after-stopper-double-competition',suits:{[ob.strain]:{min:5,max:13}},hcp:{min:10,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},reason:`cours 24 : ${raw} repose sur une longueur ${rb.strain} imaginaire (${L[rb.strain]} cartes seulement) ; retour naturel à ${target}`};
        }
        // Avec une main régulière/semi-régulière forte et l'arrêt dans la couleur
        // d'intervention, le second X natif de PONS provient typiquement de sa fausse
        // lecture « partenaire = 4 Piques ». Le vrai sens du premier Contre n'en promet
        // aucune : à 17-19 H, 3SA décrit directement la main et respecte la force du camp.
        if(raw==='X' && H>=17 && H<=19 && balanced(L) && ib?.strain && stopperScore(ctx.deal,seat,ib.strain)>=0.7 && legal('3NT')) return {
          call:'3NT',changed:true,
          semantic:{natural:true,source:'course24-opener-3nt-after-stopper-spoutnik-competition',hcp:{min:17,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},
          reason:`cours 24 : le premier Contre ne promet pas quatre Piques ; ${H} H réguliers avec arrêt ${ib.strain} => 3SA plutôt qu'un second X fondé sur un faux fit`
        };

        // Le re-Contre compétitif de l'ouvreur peut être d'appel : il décrit sa propre
        // courte dans la couleur adverse et de la tolérance pour les couleurs restantes.
        // Il ne doit surtout pas réimporter la lecture native « partenaire = 4 Piques »
        // alors que le premier Contre était précisément le Spoutnik sans majeure.
        if(raw==='X' && ib?.strain && L[ib.strain]<=1 && H>=12 && H<=19){
          const unbidMajor=ib.strain==='H'?'S':ib.strain==='S'?'H':null;
          const otherMinor=ob.strain==='C'?'D':ob.strain==='D'?'C':null;
          if((!unbidMajor||L[unbidMajor]>=3) && (!otherMinor||L[otherMinor]>=3)) return {
            call:'X',changed:false,
            semantic:{natural:false,source:'course24-opener-takeout-double-after-stopper-spoutnik-competition',hcp:{min:12,max:19},suits:{[ib.strain]:{min:0,max:1}},forcing:'unknown',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},
            reason:'cours 24 : après le Spoutnik sans majeure et la compétition adverse, le Contre de l’ouvreur est d’appel et ne promet pas quatre cartes dans la majeure non nommée'
          };
        }
        // Un PASS compétitif sans meilleure action est une vraie décision, pas une
        // acceptation de la fausse lecture PONS du Contre.
        if(raw==='PASS') return {call:'PASS',changed:false,semantic:{natural:true,source:'course24-opener-pass-after-stopper-double-competition',hcp:{min:10,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},reason:'cours 24 : compétition adverse après le Contre sans majeure ; PASS explicitement validé sans attribuer quatre cartes majeures au partenaire'};
      }
    }

    // Cours 24 — continuation du répondant après le saut forcing 3M de
    // l'ouvreur dans 1D-(2C)-X-P-3M. Sans quatre cartes dans la majeure,
    // il ne peut pas passer : 3SA avec l'arrêt Trèfle, soutien Carreau,
    // ou allongement de l'autre majeure.
    if(history.length===6 && raw==='PASS'){
      const [o,ov,dbl,op,majump,op2]=history, partner=partnerOf(seat), mb=parseBid(majump.call);
      const frame=o.call==='1D' && o.seat===partner && ov.call==='2C' && sideOf(ov.seat)!==sideOf(seat) && dbl.seat===seat && dbl.call==='X' && op.call==='PASS' &&
        majump.seat===partner && (majump.call==='3H'||majump.call==='3S') && op2.call==='PASS';
      if(frame){
        const m=mb.strain, other=m==='H'?'S':'H'; let target=null, semantic=null, reason='';
        if(L[m]>=4){
          target=`4${m}`;
          semantic={natural:true,source:'course24-responder-fits-strong-one-major-jump',suits:{[m]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-2C-opener-one-major-jump'};
          reason=`cours 24 : saut fort ${majump.call} et fit ${m} quatrième => ${target}`;
        } else if(stopperScore(ctx.deal,seat,'C')>=0.7 && legal('3NT')){
          target='3NT';
          semantic={natural:true,source:'course24-responder-3NT-after-strong-one-major-jump',hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-2C-opener-one-major-jump'};
          reason='cours 24 : sans fit dans la majeure forte, arrêt Trèfle => 3SA';
        } else {
          const otherCall=cheapestSuitCallAfter(history,other);
          if(L[other]>=5 && otherCall && legal(otherCall)){
            target=otherCall;
            semantic={natural:true,source:'course24-responder-other-major-after-strong-one-major-jump',suits:{[other]:{min:5,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course24-1D-2C-opener-one-major-jump'};
            reason=`cours 24 : sans fit ${m}, ${L[other]} cartes dans l'autre majeure => ${target}`;
          } else if(L.D>=4 && legal('4D')){
            target='4D';
            semantic={natural:true,source:'course24-responder-diamond-support-after-strong-one-major-jump',suits:{D:{min:4,max:13}},hcp:{min:0,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'course24-1D-2C-opener-one-major-jump'};
            reason='cours 24 : saut fort en majeure sans fit ni arrêt Trèfle ; retour au fit Carreau => 4D';
          }
        }
        if(target && legal(target)) return {call:target,changed:true,semantic,reason};
      }
    }


    // Cours 24 — une fois le retour forcing à 4D effectué après le saut
    // fort 3M, l'ouvreur ne peut plus passer. Le fit Carreau est explicite et la
    // manche mineure est la fermeture naturelle minimale.
    if(history.length===8 && raw==='PASS'){
      const [o,ov,dbl,op,majump,op2,fitD,op3]=history, partner=partnerOf(seat);
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course24-responder-diamond-support-after-strong-one-major-jump');
      const frame=o.seat===seat && o.call==='1D' && ov.call==='2C' && dbl.seat===partner && dbl.call==='X' && op.call==='PASS' &&
        majump.seat===seat && (majump.call==='3H'||majump.call==='3S') && op2.call==='PASS' && fitD.seat===partner && fitD.call==='4D' && op3.call==='PASS';
      if(frame && (pm || L.D>=4) && L.D>=4 && legal('5D')) return {
        call:'5D',changed:true,
        semantic:{natural:true,source:'course24-opener-closes-diamond-game-after-strong-major-jump',suits:{D:{min:4,max:13}},hcp:{min:15,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-2C-opener-one-major-jump'},
        reason:'cours 24 : après le saut fort en majeure puis le soutien forcing à 4D, PASS interdit => 5D'
      };
    }

    // Cours 24 : après le saut artificiel 4C de l'ouvreur montrant une
    // main forte irrégulière avec les deux majeures quatrièmes, le répondant
    // doit choisir la manche majeure. Ce 4C est forcing un tour : PASS n'existe
    // pas. Avec les deux fits, on tranche par la qualité des couleurs.
    if(relHistory.length===6 && raw==='PASS'){
      const [o,ov,dbl,op,jump,op2]=relHistory;
      const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='course24-1D-2C-opener-both-majors-irregular');
      const frame=pm && o.seat===partner && o.call==='1D' && ov.call==='2C' && dbl.seat===seat && dbl.call==='X' && op.call==='PASS' &&
        jump.seat===partner && jump.call==='4C' && op2.call==='PASS';
      if(frame && (L.H>=4||L.S>=4)){
        let m=null;
        if(L.H>=4&&L.S>=4) m=majorPreference(ctx.deal,seat,4,4);
        else m=L.H>=4?'H':'S';
        const target=`4${m}`;
        if(legal(target)) return {
          call:target,changed:true,
          semantic:{natural:true,source:'course24-responder-major-choice-after-both-majors-irregular',suits:{[m]:{min:4,max:13}},hcp:{min:0,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'course24-1D-2C-4C-both-majors-choice'},
          reason:`cours 24 : 4C fort irrégulier montre les deux majeures quatrièmes ; choix du fit ${m} => ${target}`
        };
      }
    }

    // Réponses de l'ouvreur après un contre Spoutnik simple/généralisé.
    // Utiliser l'historique relatif à l'ouverture : la convention doit rester
    // identique en 2e/3e/4e position après des Passes initiaux.
    if(relHistory.length===4){
      const [open,over,dbl,oppPass]=relHistory;
      if(open.seat!==seat || dbl.call!=='X' || oppPass.call!=='PASS') return null;
      const ob=parseBid(open.call), ib=parseBid(over.call);
      if(!ob||!ib||sideOf(over.seat)===sideOf(seat)||sideOf(dbl.seat)!==sideOf(seat)) return null;

      // Cours 24 : lorsque le Critic a lui-même créé un contre « sans majeure »
      // comme demande d'arrêt derrière une ouverture mineure, on peut zoner quelques
      // redemandes de l'ouvreur sans ambiguïté. Cette branche exige la sémantique
      // explicite du ledger : un contre PONS natif n'est jamais requalifié ici.
      const partnerConvention=latestPartnerExplicitMeaning(ctx,m=>m.convention==='course24-spoutnik-stopper-ask')?.convention;
      if(partnerConvention==='course24-spoutnik-stopper-ask' &&
         (open.call==='1C'||open.call==='1D') && ib.level===1 && ib.strain!=='NT'){
        const stop=stopperScore(ctx.deal,seat,ib.strain)>=0.7;
        let target=null, semantic=null, reason='';
        // Le Contre négatif peut être transformé en pénalité : avec quatre cartes
        // dans la couleur d'intervention et des valeurs d'ouverture, PASS est une
        // vraie décision. Il doit toutefois être publié sans inventer une majeure
        // quatrième chez le partenaire.
        if(raw==='PASS' && L[ib.strain]>=4 && H>=12){
          return {call:'PASS',changed:false,semantic:{natural:false,source:'course24-opener-penalty-conversion-after-stopper-double',suits:{[ib.strain]:{min:4,max:13}},hcp:{min:12,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'course24-spoutnik-stopper-ask'},reason:`cours 24 : Contre Spoutnik sans majeure transformé en pénalité avec ${L[ib.strain]} cartes ${ib.strain} et ${H} H`};
        }
        if(strictBalanced(L) && stop && H>=12 && H<=14 && (!ctx.isLegal||ctx.isLegal(history,'1NT',seat))){
          target='1NT';
          semantic={natural:true,source:'course24-opener-after-stopper-double-1NT',hcp:{min:12,max:14},forcing:'nonforcing',convention:'course24-stopper-double-opener-NT'};
          reason=`cours 24 : contre demande d'arrêt, main régulière ${H} H avec tenue ${ib.strain} => 1SA`;
        } else if(strictBalanced(L) && stop && H>=18 && H<=19 && (!ctx.isLegal||ctx.isLegal(history,'3NT',seat))){
          target='3NT';
          semantic={natural:true,source:'course24-opener-after-stopper-double-3NT',hcp:{min:18,max:19},forcing:'nonforcing',convention:'course24-stopper-double-opener-NT'};
          reason=`cours 24 : contre demande d'arrêt, main régulière ${H} H avec tenue ${ib.strain} => 3SA`;
        } else if(!stop || !strictBalanced(L)){
          const majors=['H','S'].filter(m=>L[m]===4 && (!ctx.isLegal||ctx.isLegal(history,`1${m}`,seat)))
            .sort((a,b)=>bidRank(`1${a}`)-bidRank(`1${b}`));
          if(majors.length>=1 && H>=10 && H<=21){
            target=`1${majors[0]}`;
            semantic={natural:true,source:'course24-opener-after-stopper-double-major',suits:{[majors[0]]:{min:4,max:4}},hcp:{min:10,max:21},forcing:'unknown',publishWhenNative:true,convention:'course24-stopper-double-opener-major'};
            reason=`cours 24 : contre demande d'arrêt ; sans priorité SA, description de la majeure quatrième ${majors[0]} au palier de 1`;
          }
        }
        if(!target && L[ob.strain]>=5){
          const repeat=cheapestSuitCallAfter(history,ob.strain);
          if(repeat && (!ctx.isLegal||ctx.isLegal(history,repeat,seat))){
            target=repeat;
            semantic={natural:true,source:'course24-opener-natural-repeat-after-stopper-double',suits:{[ob.strain]:{min:5,max:13}},hcp:{min:10,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'course24-stopper-double-opener-natural'};
            reason=`cours 24 : jeu irrégulier après le Contre sans majeure ; répétition naturelle ${repeat}`;
          }
        }
        if(!target && H>=12 && H<=14 && strictBalanced(L) && (!ctx.isLegal||ctx.isLegal(history,'1NT',seat))){
          target='1NT';
          semantic={natural:true,source:'course24-opener-last-resort-1NT-after-stopper-double',hcp:{min:12,max:14},forcing:'nonforcing',publishWhenNative:true,convention:'course24-stopper-double-opener-NT'};
          reason='cours 24 : main régulière 12-14 sans description naturelle ; 1SA reste la redemande de dernier ressort, même sans arrêt franc';
        }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))) return {call:target,changed:raw!==target,semantic,reason};
      }

      // Cours 24 : redemande de l'ouvreur après la séquence particulière 1D-(2C)-X-passe.
      // PONS brut surenchérissait très souvent directement à 4M dans cette famille.
      // Les règles ci-dessous restent volontairement limitées aux zones explicitement
      // décrites dans le cours : majeures quatrièmes, 2SA/2D de première zone,
      // répétition à saut 3D et quelques expressions fortes sans ambiguïté.
      if(open.call==='1D' && over.call==='2C'){
        const both4=L.H===4 && L.S===4;
        const oneH=L.H===4 && L.S<=3;
        const oneS=L.S===4 && L.H<=3;
        const no4Major=L.H<=3 && L.S<=3;
        let target=null, semantic=null, reason='';

        if(both4){
          if(H>=12&&H<=14){
            target='2H';
            semantic={natural:true,source:'course24-1D-2C-opener-both-majors-low',suits:{H:{min:4,max:4},S:{min:4,max:4}},hcp:{min:12,max:14},forcing:'nonforcing',convention:'course24-1D-2C-opener-both-majors'};
            reason=`cours 24 : deux majeures quatrièmes, ouverture minimale ${H} H => 2H (2H ne dénie pas 4S)`;
          } else if(H>=18&&H<=19&&strictBalanced(L)&&L.D===3){
            target='4H';
            semantic={natural:false,source:'course24-1D-2C-opener-both-majors-18-19',suits:{H:{min:4,max:4},S:{min:4,max:4}},hcp:{min:18,max:19},forcing:'nonforcing',convention:'course24-1D-2C-4H-both-majors'};
            reason='cours 24 : 18-19 H réguliers, deux majeures quatrièmes et trois Carreaux => saut conventionnel à 4H';
          } else if(H>=15&&!strictBalanced(L)&&L.D>=4&&L.C<=1){
            target='4C';
            semantic={natural:false,source:'course24-1D-2C-opener-both-majors-irregular',suits:{H:{min:4,max:4},S:{min:4,max:4},C:{min:0,max:1}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',convention:'course24-1D-2C-4C-splinter-like'};
            reason=`cours 24 : deux majeures quatrièmes, main irrégulière forte ${H} H et courte Trèfle => 4C`;
          }
        } else if(oneH||oneS){
          const m=oneH?'H':'S';
          if(H>=12&&H<=14){
            target=`2${m}`;
            semantic={natural:true,source:'course24-1D-2C-opener-one-major-low',suits:{[m]:{min:4,max:4}},hcp:{min:12,max:14},forcing:'nonforcing',convention:'course24-1D-2C-opener-one-major'};
            reason=`cours 24 : une seule majeure quatrième (${m}), ouverture minimale ${H} H => 2${m}`;
          } else if(H>=18&&H<=19&&strictBalanced(L)){
            target='3C';
            semantic={natural:false,source:'course24-1D-2C-opener-one-major-regular-strong',suits:{[m]:{min:4,max:4}},hcp:{min:18,max:19},forcing:'one_round_if_uncontested',convention:'course24-1D-2C-opener-cuebid'};
            reason=`cours 24 : 18-19 H réguliers avec une seule majeure quatrième (${m}) => cue-bid 3C forcing de manche`;
          } else if(H>=15&&!strictBalanced(L)){
            target=`3${m}`;
            semantic={natural:true,source:'course24-1D-2C-opener-one-major-strong',suits:{[m]:{min:4,max:4}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',convention:'course24-1D-2C-opener-one-major-jump'};
            reason=`cours 24 : une seule majeure quatrième (${m}), main irrégulière de deuxième zone ${H} H => 3${m} forcing`;
          }
        } else if(no4Major){
          const clubCards=String(ctx.deal?.hands?.[seat]?.C||'');
          const strongNonAceClubStop=(clubCards.includes('K')&&clubCards.length>=2)||(clubCards.includes('Q')&&clubCards.length>=3);
          if(H>=18&&H<=19&&strictBalanced(L)&&stopperScore(ctx.deal,seat,'C')>=0.7){
            target='3NT';
            semantic={natural:true,source:'course24-1D-2C-opener-3NT-18-19',hcp:{min:18,max:19},forcing:'nonforcing',convention:'course24-1D-2C-opener-3NT'};
            reason='cours 24 : 18-19 H réguliers sans majeure quatrième, arrêt Trèfle => 3SA';
          } else if(H>=14&&H<=15&&L.D>=6&&suitHcp(ctx.deal,seat,'D')>=5){
            target='3D';
            semantic={natural:true,source:'course24-1D-2C-opener-3D-good-six',suits:{D:{min:6,max:13}},hcp:{min:14,max:15},forcing:'nonforcing',convention:'course24-1D-2C-opener-3D'};
            reason=`cours 24 : ${H} H et ${L.D} beaux Carreaux => répétition à saut 3D non forcing`;
          } else if(H>=12&&H<=14&&strictBalanced(L)&&strongNonAceClubStop){
            target='2NT';
            semantic={natural:true,source:'course24-1D-2C-opener-2NT-low',hcp:{min:12,max:14},forcing:'nonforcing',convention:'course24-1D-2C-opener-2NT'};
            reason='cours 24 : main régulière 12-14 H sans majeure quatrième, arrêt Trèfle net => 2SA';
          } else if(H>=12&&H<=14&&strictBalanced(L)&&stopperScore(ctx.deal,seat,'C')===0){
            target='2D';
            semantic={natural:true,source:'course24-1D-2C-opener-2D-no-stopper',suits:{D:{min:4,max:13}},hcp:{min:12,max:14},forcing:'nonforcing',convention:'course24-1D-2C-opener-2D-fallback'};
            reason='cours 24 : main régulière 12-14 H sans majeure quatrième ni arrêt Trèfle => 2D, répétition qui ne garantit pas six cartes';
          }
        }

        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          return {call:target,changed:raw!==target,semantic,reason};
        }
      }

      // Cours 12 : après 1m-(1P)-X-passe, si l'ouvreur possède exactement quatre Cœurs,
      // il doit les annoncer. Les zones sont 2H = 12-15 HLD, 3H = 16-17 HLD,
      // 4H = 18-19 HLD. Dans la dernière zone on reste conservateur et on n'impose 4H
      // qu'avec au plus 15 H, afin de ne pas écraser un éventuel Splinter/cue-bid très fort.
      if((open.call==='1C'||open.call==='1D') && over.call==='1S' && L.H===4 && L.S<=4){
        const hld=supportHld(ctx.deal,seat,'H');
        let target=null;
        if(hld>=12&&hld<=15) target='2H';
        else if(hld>=16&&hld<=17) target='3H';
        else if(hld>=18&&hld<=19&&H<=15) target='4H';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          return {
            call:target,
            changed:raw!==target,
            semantic:{
              natural:true,
              source:'course12-opener-support-after-simple-spoutnik',
              suits:{H:{min:4,max:13}},
              forcing:'nonforcing',
              convention:'course12-spoutnik-opener-heart-support'
            },
            reason:`cours 12 : soutien de l'ouvreur après Spoutnik, ${hld} HLD => ${target}`,
            hld
          };
        }
      }

      // Cours 24 : si la recherche du fit Cœur échoue, une main régulière de 12-14 H
      // se redemande à 1SA. Point important du cours : cette redemande NE garantit PAS
      // l'arrêt à Pique. PONS brut répétait très souvent la mineure, passait ou sautait à 3SA.
      if((open.call==='1C'||open.call==='1D') && over.call==='1S' && L.H<4 && H>=12&&H<=14){
        const regularShape=strictBalanced(L);
        // Le cours 24 donne aussi explicitement 1SA avec un 5-4-2-2 de type 1C,
        // lorsque la couleur de Trèfle cinquième est trop médiocre pour être répétée.
        const weakClub5422=open.call==='1C' && L.C===5 && L.D===4 && L.S===2 && L.H===2 && suitHcp(ctx.deal,seat,'C')<=2;
        if(regularShape || weakClub5422){
        const target='1NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
          return {
            call:target,
            changed:raw!==target,
            semantic:{
              natural:true,
              source:'course24-opener-1NT-after-simple-spoutnik',
              hcp:{min:12,max:14},
              forcing:'nonforcing',
              convention:'course24-spoutnik-opener-1NT-no-stopper-required'
            },
            reason:`cours 24 : après Spoutnik simple, main régulière/semi-régulière ${H} H sans quatre Cœurs => 1SA`
          };
        }
        }
      }

      // Cours 24 : bicolores mineurs après 1D-(1S)-X-passe.
      // 2C = bicolore économique, au moins 5D-4C, limité à 16 H, non forcing.
      // 3C = bicolore à saut, normalement 17+ H ; le cours autorise 16 H avec un vrai 5-5.
      if(open.call==='1D' && over.call==='1S' && L.H<4 && L.D>=5 && L.C>=4 && H>=12){
        let target=null, forcing='nonforcing', hcpRange={min:12,max:16};
        if(H>=17 || (H===16&&L.D>=5&&L.C>=5)){
          target='3C'; forcing='one_round_if_uncontested'; hcpRange={min:16,max:37};
        } else if(H<=16){ target='2C'; }
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          return {
            call:target, changed:raw!==target,
            semantic:{natural:true,source:'course24-opener-minor-bicolor-after-spoutnik',suits:{D:{min:5,max:13},C:{min:4,max:13}},hcp:hcpRange,forcing,convention:'course24-1D-spoutnik-minor-bicolor'},
            reason:`cours 24 : bicolore ${L.D}-${L.C} D/C, ${H} H après 1D-(1S)-X => ${target}`
          };
        }
      }

      // Cours 24 : après 1C-(1S)-X-passe, 2D est un bicolore cher atténué : 5C-4D
      // et environ 15/16 H+. Avec une main plus faible, l'ouvreur répète 2C ; à 14 H,
      // le cours montre à la fois un 2C normal et une dérogation 2D avec 6/4 très riche
      // en intermédiaires. On laisse donc volontairement les 6C-4D de 14 H à PONS.
      if(open.call==='1C' && over.call==='1S' && L.H<4 && L.C>=5 && L.D>=4 && H>=12){
        let target=null;
        if(H>=15) target='2D';
        else if(H<=13 || (H===14&&L.C===5)) target='2C';
        if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
          return {
            call:target, changed:raw!==target,
            semantic: target==='2D' ? {
              natural:true,source:'course24-opener-minor-bicolor-after-spoutnik',suits:{C:{min:5,max:13},D:{min:4,max:13}},hcp:{min:15,max:37},forcing:'one_round_if_uncontested',convention:'course24-1C-spoutnik-reverse'
            } : {
              natural:true,source:'course24-opener-minor-repeat-after-spoutnik',suits:{C:{min:5,max:13}},hcp:{min:12,max:14},forcing:'nonforcing',convention:'course24-1C-spoutnik-low-repeat'
            },
            reason:`cours 24 : après 1C-(1S)-X, main ${L.C}C-${L.D}D de ${H} H => ${target}`
          };
        }
      }

      // v2.51 — après 1S-(2H)-X-passe, le X SEF 2024 explicitement publié
      // dénie le fit Pique. On ne doit donc jamais conclure 4S avec cinq Piques
      // au motif d'un fit imaginaire. La fiche Chailley 1S-2H-X-P demande à
      // l'ouvreur de donner le plein de sa main : répétition minimum jusqu'à 15HL,
      // 2SA 16-17 avec arrêt, nouvelle mineure forcing 16-18, cue-bid fort,
      // 3S avec un vrai unicolore 6e et 4S seulement avec 6/7 beaux Piques 18-19.
      if(open.call==='1S' && over.call==='2H'){
        const pm=latestPartnerExplicitMeaning(ctx,m=>m?.source==='v251-sef2024-1S2H-negative-double-no-fit'||m?.convention==='sef2024-1S-2H-spoutnik');
        if(pm){
          const HL=H+lengthPoints(L);
          const stopH=stopperScore(ctx.deal,seat,'H')>=0.7;
          const heartCards=String(ctx.deal?.hands?.[seat]?.H||'');
          // Deux arrêts : estimation volontairement conservatrice, uniquement pour
          // autoriser le 3SA direct documenté par la fiche (sinon on cue-bidde).
          const twoStopH=(heartCards.includes('A') && /[KQJ]/.test(heartCards.replace('A',''))) ||
            (heartCards.includes('K') && heartCards.includes('Q') && heartCards.length>=3);
          const sideMinor=['C','D'].filter(s=>L[s]>=4);
          let target=null, semantic=null, reason='';

          if(L.S>=6 && HL>=18 && HL<=19 && suitHcp(ctx.deal,seat,'S')>=5 && legal('4S')){
            target='4S';
            semantic={natural:true,source:'v251-1S2H-spoutnik-opener-4S-real-six',suits:{S:{min:6,max:7}},points:{min:18,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
            reason=`Chailley : après X sans fit, 4Pique exige le vrai unicolore 6/7e fort (${L.S} Piques, ${HL} HL)`;
          } else if(L.S>=6 && HL>=16 && HL<=17 && legal('3S')){
            target='3S';
            semantic={natural:true,source:'v251-1S2H-spoutnik-opener-3S-six',suits:{S:{min:6,max:13}},points:{min:16,max:17},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
            reason=`Chailley : ${L.S} Piques et ${HL} HL => répétition propositionnelle 3Pique`;
          } else if(sideMinor.length>=1 && HL>=16 && HL<=18){
            // Avec deux mineures quatrièmes (5-0-4-4), on commence par la moins chère.
            const m=sideMinor.includes('C')?'C':sideMinor[0], c=`3${m}`;
            if(legal(c)){
              target=c;
              semantic={natural:true,source:'v251-1S2H-spoutnik-opener-side-minor',suits:{S:{min:5,max:13},[m]:{min:4,max:13}},points:{min:16,max:18},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
              reason=`Chailley : bicolore Pique-${m}, ${HL} HL => ${c} forcing`;
            }
          } else if(balanced(L) && stopH && HL>=16 && HL<=17 && legal('2NT')){
            target='2NT';
            semantic={natural:true,source:'v251-1S2H-spoutnik-opener-2NT',points:{min:16,max:17},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
            reason=`Chailley : main régulière 16-17 HL avec arrêt Cœur => 2SA`;
          } else if(balanced(L) && twoStopH && HL>=18 && legal('3NT')){
            target='3NT';
            semantic={natural:true,source:'v251-1S2H-spoutnik-opener-3NT',points:{min:18,max:23},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
            reason=`Chailley : main forte régulière avec deux arrêts Cœur => 3SA`;
          } else if(HL>=18 && legal('3H')){
            target='3H';
            semantic={natural:false,source:'v251-1S2H-spoutnik-opener-cuebid',suits:{S:{min:5,max:13}},points:{min:18,max:23},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
            reason=`Chailley : ${HL} HL sans meilleure enchère descriptive => cue-bid 3Cœur`;
          } else if(raw==='4S' && L.S===5 && HL>=16 && HL<=17 && legal('3H')){
            // Zone résiduelle non détaillée par la fiche : 4S est en revanche exclu
            // de façon certaine puisque le X partenaire dénie le fit et que l'ouvreur
            // n'a que cinq Piques. On préfère le cue-bid forcing, qui garde toutes les
            // manches ouvertes, plutôt que d'inventer un contrat final à sept atouts.
            target='3H';
            semantic={natural:false,source:'v251-1S2H-spoutnik-five-spade-4S-veto',suits:{S:{min:5,max:5}},points:{min:16,max:17},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
            reason=`garde contrat final : X dénie le fit et l'ouvreur n'a que cinq Piques ; 4Pique est veto, cue-bid 3Cœur pour poursuivre la description`;
          } else if(HL<=15 && L.S>=5 && legal('2S')){
            target='2S';
            semantic={natural:true,source:'v251-1S2H-spoutnik-opener-low-repeat',suits:{S:{min:5,max:13}},points:{min:11,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik-rebid'};
            reason=`Chailley : X dénie le fit ; ouverture ${HL} HL sans meilleure enchère => répétition 2Pique, même avec seulement cinq cartes`;
          }

          if(target && legal(target)) return {call:target,changed:raw!==target,semantic,reason};
        }
      }

      // Cours 24 : développements de l'ouvreur après 1M-(2m)-X-passe.
      // La priorité reste l'autre majeure quatrième (règle déjà présente en v2.6),
      // mais le cours précise aussi les routes sans fit majeur : nouvelle couleur
      // économique, répétition de la majeure, Sans-Atout avec arrêt, répétition à saut,
      // nouvelle couleur au palier de 3 avec une deuxième zone, ou cue-bid fort.
      if(ob.level===1 && (ob.strain==='H'||ob.strain==='S') && ib.level===2 &&
         (ib.strain==='C'||ib.strain==='D') && ib.strain!==ob.strain){
        const otherMajor=ob.strain==='H'?'S':'H';

        // Quatre cartes dans l'autre majeure : 2M avec 12-14 H, saut forcing à partir
        // de 15 H. C'est le traitement déjà validé dans la version précédente.
        if(L[otherMajor]===4 && H>=12){
          const target=H<=14?`2${otherMajor}`:`3${otherMajor}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            const forcing=H>=15?'one_round_if_uncontested':'nonforcing';
            return {
              call:target,
              changed:raw!==target,
              semantic:{
                natural:true,
                source:'course11-opener-support-after-generalized-spoutnik',
                suits:{[otherMajor]:{min:4,max:13}},
                hcp:{min:H>=15?15:12,max:H>=15?37:14},
                forcing,
                convention:'course11-generalized-spoutnik-opener-support'
              },
              reason:`cours 11 : après Spoutnik généralisé, 4 ${otherMajor} et ${H} H => ${target}`
            };
          }
        }

        if(L[otherMajor]<=3){
          const sideSuits=SUITS.filter(s=>s!==ob.strain && s!==ib.strain && s!==otherMajor);
          const economic=sideSuits.filter(s=>L[s]>=4 && cheapestSuitBidAfter(history,`2${s}`));
          const forcedLevel3=sideSuits.filter(s=>L[s]>=4 && cheapestSuitBidAfter(history,`3${s}`));
          const hasSideFour=sideSuits.some(s=>L[s]>=4);
          const stop=stopperScore(ctx.deal,seat,ib.strain)>=0.7;
          let target=null, semantic=null, reason='';

          // Une nouvelle couleur au palier de 2 est économique, non forcing et limitée
          // à 15 H. On ne la propose que lorsqu'une seule couleur latérale répond aux
          // conditions, pour éviter tout arbitrage de bicolore non documenté.
          if(economic.length===1 && H>=11 && H<=15){
            const s=economic[0]; target=`2${s}`;
            semantic={natural:true,source:'course24-major-spoutnik-economic-new-suit',suits:{[s]:{min:4,max:13}},hcp:{min:11,max:15},forcing:'nonforcing',convention:'course24-major-spoutnik-economic-side-suit'};
            reason=`cours 24 : après ${open.call}-(${over.call})-X, nouvelle couleur économique ${target} avec ${L[s]} cartes et ${H} H`;
          }
          // Quand l'intervention oblige à nommer la couleur latérale au palier de 3,
          // le cours exige une main de deuxième zone. On borne l'automatisme à 15-17 H.
          else if(forcedLevel3.length===1 && H>=15 && H<=17){
            const s=forcedLevel3[0]; target=`3${s}`;
            semantic={natural:true,source:'course24-major-spoutnik-level3-new-suit',suits:{[s]:{min:4,max:13}},hcp:{min:15,max:17},forcing:'unknown',convention:'course24-major-spoutnik-positive-side-suit'};
            reason=`cours 24 : couleur latérale ${s} seulement annonçable au palier de 3, deuxième zone ${H} H => ${target}`;
          }
          // Avec une belle majeure sixième et une ouverture agréable, la répétition à
          // saut est non forcing. On exige ici 14-16 H et au moins 5 H dans la couleur.
          else if(!hasSideFour && L[ob.strain]>=6 && H>=14 && H<=16 && suitHcp(ctx.deal,seat,ob.strain)>=5){
            target=`3${ob.strain}`;
            semantic={natural:true,source:'course24-major-spoutnik-jump-repeat',suits:{[ob.strain]:{min:6,max:13}},hcp:{min:14,max:16},forcing:'nonforcing',convention:'course24-major-spoutnik-jump-repeat'};
            reason=`cours 24 : belle ${ob.strain} sixième, ouverture agréable ${H} H => répétition à saut ${target}`;
          }
          // Sans couleur latérale quatrième, 2SA montre une bonne ouverture (14-16 H
          // dans l'overlay) et l'arrêt dans la couleur d'intervention.
          else if(!hasSideFour && balanced(L) && stop && H>=14 && H<=16){
            target='2NT';
            semantic={natural:true,source:'course24-major-spoutnik-opener-2NT',hcp:{min:14,max:16},forcing:'nonforcing',convention:'course24-major-spoutnik-2NT-stopper'};
            reason=`cours 24 : ${H} H, main régulière/semi-régulière et arrêt ${ib.strain} => 2SA`;
          }
          // Avec la force de manche et l'arrêt, l'ouvreur peut conclure directement.
          else if(!hasSideFour && balanced(L) && stop && H>=17 && H<=19){
            target='3NT';
            semantic={natural:true,source:'course24-major-spoutnik-opener-3NT',hcp:{min:17,max:19},forcing:'nonforcing',convention:'course24-major-spoutnik-3NT-stopper'};
            reason=`cours 24 : ${H} H réguliers/semi-réguliers avec arrêt ${ib.strain} => 3SA`;
          }
          // Même profil fort sans arrêt : le cue-bid est la route forcing de manche.
          else if(!hasSideFour && balanced(L) && !stop && H>=17 && H<=19){
            target=`3${ib.strain}`;
            semantic={natural:false,source:'course24-major-spoutnik-opener-cuebid',hcp:{min:17,max:19},forcing:'one_round_if_uncontested',convention:'course24-major-spoutnik-cuebid'};
            reason=`cours 24 : main forte ${H} H sans arrêt ${ib.strain} et sans enchère naturelle => cue-bid ${target} forcing de manche`;
          }
          // Enfin, avec une ouverture minimale et sans autre action économique, l'ouvreur
          // répète sa majeure ; cette répétition ne garantit pas six cartes.
          else if(H>=11 && H<=14 && economic.length===0 && forcedLevel3.length<=1){
            target=`2${ob.strain}`;
            semantic={natural:true,source:'course24-major-spoutnik-opener-low-repeat',suits:{[ob.strain]:{min:5,max:13}},hcp:{min:11,max:14},forcing:'nonforcing',convention:'course24-major-spoutnik-low-repeat'};
            reason=`cours 24 : ouverture minimale ${H} H sans autre action sûre => ${target}, répétition qui peut rester cinquième`;
          }

          if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
            return {call:target,changed:raw!==target,semantic,reason};
          }
        }
      }
      return null;
    }

    // Cours 24 : après 1m-(1S)-X-passe-1SA-passe, le répondant qui a des ambitions
    // de manche et ne tient pas les Piques utilise le cue-bid 2S pour demander l'arrêt.
    // Le cours précise qu'il promet au moins 11 points et qu'après 1SA le cue-bid est
    // la seule enchère forcing. On exige exactement quatre Cœurs et on écarte une
    // nouvelle mineure cinquième qui aurait dû être annoncée naturellement au tour 1.
    if(history.length===6){
      const [open,over,dbl,p1,rebid,p2]=history, partner=partnerOf(seat);

      // Cours 24 : développements du répondant après la séquence particulière
      // 1D-(2C)-X-passe-2x-passe. Le deuxième tour du contreur est fortement
      // codifié : une nouvelle majeure promet désormais cinq cartes, 3D sert de
      // terrain d'atterrissage avec quatre Carreaux, 2SA est une proposition avec
      // 10-11 H et l'arrêt Trèfle, tandis qu'à partir de la zone de manche le
      // cue-bid 3C recherche l'arrêt ou prépare une exploration de chelem.
      if(open.seat===partner && open.call==='1D' && over.call==='2C' &&
         dbl.seat===seat && dbl.call==='X' && p1.call==='PASS' &&
         rebid.seat===partner && p2.call==='PASS'){
        const rb=parseBid(rebid.call);
        const clubStop=stopperScore(ctx.deal,seat,'C')>=0.7;

        // Redemandes basses de l'ouvreur : 2D, 2H ou 2S ne montrent aucune
        // force particulière. On traite d'abord le fit trouvé, puis les routes
        // de repli explicites du cours.
        if(rebid.call==='2D' || rebid.call==='2H' || rebid.call==='2S'){
          const m=(rebid.call==='2H'||rebid.call==='2S') ? rb.strain : null;
          if(m && L[m]>=4){
            const hld=supportHld(ctx.deal,seat,m);
            let target=null, sem=null, why='';
            // Main vraiment forte avec fit : le cue-bid est la route documentée
            // pour garder le chelem ouvert. On exige une marge importante afin
            // de ne pas transformer de simples mains de manche en séquences de chelem.
            if(H>=16 && hld>=17){
              target='3C';
              sem={natural:false,source:'course24-1D-2C-responder-strong-fit-cuebid',suits:{[m]:{min:4,max:13}},hcp:{min:16,max:37},forcing:'one_round_if_uncontested',convention:'course24-1D-2C-cuebid-strong-fit'};
              why=`cours 24 : fit ${m} retrouvé et jeu fort (${H} H / ${hld} HLD) => cue-bid 3C pour garder le chelem ouvert`;
            } else if(hld>=13){
              target=`4${m}`;
              sem={natural:true,source:'course24-1D-2C-responder-game-fit',suits:{[m]:{min:4,max:13}},hcp:{min:8,max:37},forcing:'nonforcing',convention:'course24-1D-2C-fit-game'};
              why=`cours 24 : fit ${m} retrouvé, ${hld} HLD => manche à 4${m}`;
            } else if(hld>=11){
              target=`3${m}`;
              sem={natural:true,source:'course24-1D-2C-responder-fit-invite',suits:{[m]:{min:4,max:13}},hcp:{min:8,max:37},forcing:'nonforcing',convention:'course24-1D-2C-fit-invite'};
              why=`cours 24 : fit ${m} retrouvé, ${hld} HLD => proposition 3${m}`;
            }
            if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
              return {call:target,changed:raw!==target,semantic:sem,reason:why};
            }
          }

          // Une majeure annoncée au deuxième tour promet cinq cartes. Le cas
          // 5 Piques est explicitement illustré : 2S sur 2D ou 2H.
          if(L.S===5 && (rebid.call==='2D'||rebid.call==='2H') && L.H<=3){
            const target='2S';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
              return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-five-spades',suits:{S:{min:5,max:5}},hcp:{min:8,max:11},forcing:'nonforcing',convention:'course24-1D-2C-five-major-second-round'},reason:`cours 24 : après le contre de 2C, 2S au deuxième tour montre cinq Piques (${H} H)`};
            }
          }
          // Avec cinq Cœurs, 2H est naturel sur la répétition de 2D.
          if(L.H===5 && rebid.call==='2D' && L.S<=3){
            const target='2H';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
              return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-five-hearts',suits:{H:{min:5,max:5}},hcp:{min:8,max:11},forcing:'nonforcing',convention:'course24-1D-2C-five-major-second-round'},reason:`cours 24 : après le contre de 2C, 2H au deuxième tour montre cinq Cœurs (${H} H)`};
            }
          }
          // Le cours autorise explicitement le Passe sur 2S avec cinq Cœurs faibles
          // lorsqu'un semi-fit 5-3 à Pique existe : inutile de déplacer le contrat à 3H.
          if(rebid.call==='2S' && L.H===5 && L.S===3 && H>=8 && H<=10){
            const target='PASS';
            return {call:target,changed:raw!==target,semantic:{natural:false,source:'course24-1D-2C-responder-pass-on-2S-with-5H-3S',hcp:{min:8,max:10},forcing:'nonforcing',convention:'course24-1D-2C-safe-pass'},reason:'cours 24 : cinq Cœurs faibles mais trois Piques ; sur 2S, le semi-fit 5-3 est un meilleur terrain d’atterrissage que 3H'};
          }

          // Avec une seule majeure quatrième non retrouvée et quatre Carreaux,
          // le retour à 3D est le terrain d'atterrissage documenté.
          if(H>=8 && H<=11 && L.D>=4 &&
             ((rebid.call==='2S'&&L.H===4&&L.S<=3) || (rebid.call==='2H'&&L.S===4&&L.H<=3))){
            const target='3D';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
              return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-diamond-landing',suits:{D:{min:4,max:13}},hcp:{min:8,max:11},forcing:'nonforcing',convention:'course24-1D-2C-diamond-landing'},reason:`cours 24 : la majeure annoncée par l'ouvreur ne fitte pas ; ${L.D} Carreaux fournissent le terrain d'atterrissage à 3D`};
            }
          }

          // 10-11 H, main régulière/semi-régulière et arrêt Trèfle : 2SA est
          // une proposition de manche lorsque le fit majeur n'a pas été trouvé.
          if(H>=10 && H<=11 && balanced(L) && clubStop &&
             (rebid.call==='2D' || (rebid.call==='2H'&&L.H<=3) || (rebid.call==='2S'&&L.S<=3))){
            const target='2NT';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
              return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-2NT-invite',hcp:{min:10,max:11},forcing:'nonforcing',convention:'course24-1D-2C-2NT-invite'},reason:`cours 24 : ${H} H, arrêt Trèfle et fit majeur non retrouvé => proposition 2SA`};
            }
          }

          // Sur la répétition simple de 2D, le soutien à 3D est également
          // explicitement décrit comme un terrain d'atterrissage non forcing.
          // La proposition à 2SA avec 10-11 H et arrêt reste prioritaire.
          if(rebid.call==='2D' && H>=8 && H<=11 && L.D>=4 && L.H<=4 && L.S<=4){
            const ntInvite=H>=10 && H<=11 && balanced(L) && clubStop;
            if(!ntInvite){
              const target='3D';
              if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
                return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-3D-landing-after-2D',suits:{D:{min:4,max:13}},hcp:{min:8,max:11},forcing:'nonforcing',convention:'course24-1D-2C-diamond-landing'},reason:`cours 24 : sur 2D, ${L.D} Carreaux et ${H} H => soutien de sécurité 3D non forcing`};
              }
            }
          }

          // À partir de 12 H, si la recherche de fit majeur échoue et qu'aucune
          // majeure cinquième n'a à être nommée, le répondant peut imposer la
          // manche : 3SA avec l'arrêt Trèfle, sinon cue-bid 3C.
          const fitFound=m && L[m]>=4;
          const fiveMajor=L.H>=5||L.S>=5;
          if(H>=12 && !fitFound && !fiveMajor){
            const target=clubStop?'3NT':'3C';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
              return {
                call:target, changed:raw!==target,
                semantic:clubStop
                  ? {natural:true,source:'course24-1D-2C-responder-game-NT',hcp:{min:12,max:37},forcing:'nonforcing',convention:'course24-1D-2C-game-NT'}
                  : {natural:false,source:'course24-1D-2C-responder-cuebid-no-stop',hcp:{min:12,max:37},forcing:'one_round_if_uncontested',convention:'course24-1D-2C-cuebid-stopper-search'},
                reason:clubStop
                  ? `cours 24 : ${H} H, fit majeur non trouvé et arrêt Trèfle => 3SA`
                  : `cours 24 : ${H} H, fit majeur non trouvé sans arrêt Trèfle => cue-bid 3C forcing`
              };
            }
          }
        }

        // Une majeure au palier de 3 par l'ouvreur montre une main irrégulière
        // de deuxième zone et est forcing. Le répondant fitte à la manche ; s'il
        // ne fitte pas les Cœurs mais possède cinq Piques, 3S reste descriptif.
        if(rebid.call==='3H' || rebid.call==='3S'){
          const m=rb.strain;
          if(L[m]>=4){
            const target=`4${m}`;
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
              return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-game-after-opener-jump-major',suits:{[m]:{min:4,max:13}},forcing:'nonforcing',convention:'course24-1D-2C-game-after-jump'},reason:`cours 24 : ${rebid.call} de l'ouvreur place le camp dans la zone de manche ; fit ${m} => ${target}`};
            }
          }
          if(rebid.call==='3H' && L.H<=3 && L.S===5){
            const target='3S';
            if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
              return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-five-spades-after-3H',suits:{S:{min:5,max:5}},forcing:'one_round_if_uncontested',convention:'course24-1D-2C-five-spades-after-jump'},reason:'cours 24 : pas de fit Cœur après 3H mais cinq Piques => 3S descriptif'};
            }
          }
        }

        // 4C montre la main forte tricolore avec les deux majeures quatrièmes :
        // le contreur choisit naturellement la manche dans sa majeure.
        if(rebid.call==='4C' && ctx.semanticContext?.entry?.explicitMeaning?.convention==='course24-1D-2C-4C-splinter-like'){
          let target=null;
          if(L.H>=4) target='4H'; else if(L.S>=4) target='4S';
          if(target && (!ctx.isLegal||ctx.isLegal(history,target,seat))){
            return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-major-after-4C',suits:{[target.slice(1)]:{min:4,max:13}},forcing:'nonforcing',convention:'course24-1D-2C-major-after-4C'},reason:`cours 24 : 4C de l'ouvreur montre les deux majeures quatrièmes ; choix de la manche ${target}`};
          }
        }

        // 4H conventionnel = 18-19 réguliers avec les deux majeures. Si le
        // répondant n'a pas les Cœurs mais possède les Piques, il rectifie à 4S.
        if(rebid.call==='4H' && ctx.semanticContext?.entry?.explicitMeaning?.convention==='course24-1D-2C-4H-both-majors' && L.H<=3 && L.S>=4){
          const target='4S';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-responder-correct-4H-to-4S',suits:{S:{min:4,max:13}},forcing:'nonforcing',convention:'course24-1D-2C-4H-both-majors-choice'},reason:'cours 24 : 4H conventionnel montre les deux majeures ; sans fit Cœur mais avec les Piques => 4S'};
          }
        }
      }
      if(open.seat===partner && (open.call==='1C'||open.call==='1D') && over.call==='1S' &&
         dbl.seat===seat && dbl.call==='X' && p1.call==='PASS' && rebid.seat===partner && rebid.call==='1NT' && p2.call==='PASS'){
        const otherMinor=open.call==='1C'?'D':'C';
        const noSpadeStop=stopperScore(ctx.deal,seat,'S')<0.7;
        if(H>=11 && L.H===4 && L[otherMinor]<5 && noSpadeStop){
          const target='2S';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            return {
              call:target, changed:raw!==target,
              semantic:{natural:false,source:'course24-responder-cuebid-after-spoutnik-1NT',hcp:{min:11,max:37},forcing:'one_round_if_uncontested',convention:'course24-spoutnik-stopper-check'},
              reason:`cours 24 : ${H} H sans arrêt Pique après la redemande à 1SA => cue-bid 2S`
            };
          }
        }

        // Même séquence : avec 10 H et cinq cartes ou plus dans la mineure d'ouverture,
        // le saut à 3m est une proposition de manche ; 2m serait un simple choix de contrat.
        if(H===10 && L.H===4 && L[parseBid(open.call).strain]>=5){
          const target=`3${parseBid(open.call).strain}`;
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            return {
              call:target, changed:raw!==target,
              semantic:{natural:true,source:'course24-responder-minor-invite-after-spoutnik-1NT',suits:{[parseBid(open.call).strain]:{min:5,max:13}},hcp:{min:9,max:10},forcing:'nonforcing',convention:'course24-spoutnik-minor-invite'},
              reason:`cours 24 : 10 H et ${L[parseBid(open.call).strain]} cartes dans la mineure d'ouverture => proposition ${target}`
            };
          }
        }
      }
      return null;
    }

    // Cours 24 : le cue-bid 2S demande explicitement l'arrêt après la redemande à 1SA.
    // Si l'ouvreur tient les Piques, 2SA est l'enchère-clé qui confirme cette tenue.
    if(history.length===8){
      const [open,over,dbl,p1,rebid,p2,cue,p3]=history;

      // Cours 24 : continuation de l'ouvreur après les réponses de deuxième tour
      // du contreur de 2C. Deux inférences sont particulièrement explicites.
      if(open.seat===seat && open.call==='1D' && over.call==='2C' && dbl.call==='X' &&
         sideOf(dbl.seat)===sideOf(seat) && p1.call==='PASS' && rebid.seat===seat &&
         p2.call==='PASS' && sideOf(cue.seat)===sideOf(seat) && cue.seat!==seat && p3.call==='PASS'){
        // Avec les deux majeures 4-4, 2H est volontairement économique. Si le
        // répondant revient à 3D, il a dénié le fit Cœur ; son contre initial
        // révèle alors quatre Piques, d'où 3S.
        if(rebid.call==='2H' && cue.call==='3D' && L.H===4 && L.S===4 && H>=12 && H<=14){
          const target='3S';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-opener-infer-spades-after-3D',suits:{S:{min:4,max:4},H:{min:4,max:4}},hcp:{min:12,max:14},forcing:'nonforcing',convention:'course24-1D-2C-infer-other-major'},reason:'cours 24 : après 2H puis 3D, le contreur a dénié les Cœurs ; avec les deux majeures 4-4 l’ouvreur retrouve le fit Pique à 3S'};
          }
        }

        // Après un saut forcing à 3H, 3S du répondant promet cinq cartes.
        // Trois Piques chez l'ouvreur suffisent donc à conclure à 4S.
        if(rebid.call==='3H' && cue.call==='3S' && L.S===3 && H>=15 && ctx.semanticContext?.entry?.explicitMeaning?.convention==='course24-1D-2C-five-spades-after-jump'){
          const target='4S';
          if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
            return {call:target,changed:raw!==target,semantic:{natural:true,source:'course24-1D-2C-opener-support-five-spades',suits:{S:{min:3,max:3}},hcp:{min:15,max:37},forcing:'nonforcing',convention:'course24-1D-2C-five-three-fit'},reason:'cours 24 : 3S du répondant montre cinq Piques ; trois cartes chez l’ouvreur => manche 4S'};
          }
        }
      }
      if(open.seat===seat && (open.call==='1C'||open.call==='1D') && over.call==='1S' &&
         dbl.call==='X' && sideOf(dbl.seat)===sideOf(seat) && p1.call==='PASS' && rebid.seat===seat && rebid.call==='1NT' &&
         p2.call==='PASS' && cue.call==='2S' && sideOf(cue.seat)===sideOf(seat) && cue.seat!==seat && p3.call==='PASS' &&
         stopperScore(ctx.deal,seat,'S')>=0.7){
        const target='2NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
          return {
            call:target, changed:raw!==target,
            semantic:{natural:true,source:'course24-opener-2NT-stopper-confirmation',forcing:'nonforcing',convention:'course24-spoutnik-stopper-confirmation'},
            reason:'cours 24 : cue-bid 2S après 1SA = demande d’arrêt ; l’arrêt Pique est présent => 2SA'
          };
        }
      }
      return null;
    }

    // Cours 24 : si le cue-bid 2S a obtenu la confirmation 2SA de l'arrêt, un répondant
    // de 13-14 H possède le minimum pour conclure à la manche face à la redemande 12-14.
    // On ne touche volontairement pas aux mains de 15 H+ afin de préserver les explorations
    // de chelem que PONS peut déjà entreprendre.
    if(history.length===10){
      const [open,over,dbl,p1,rebid,p2,cue,p3,confirm,p4]=history, partner=partnerOf(seat);
      if(open.seat===partner && (open.call==='1C'||open.call==='1D') && over.call==='1S' &&
         dbl.seat===seat && dbl.call==='X' && p1.call==='PASS' && rebid.seat===partner && rebid.call==='1NT' && p2.call==='PASS' &&
         cue.seat===seat && cue.call==='2S' && p3.call==='PASS' && confirm.seat===partner && confirm.call==='2NT' && p4.call==='PASS' && H>=13 && H<=14){
        const target='3NT';
        if(!ctx.isLegal||ctx.isLegal(history,target,seat)){
          return {
            call:target, changed:raw!==target,
            semantic:{natural:true,source:'course24-responder-3NT-after-stopper-confirmed',hcp:{min:13,max:14},forcing:'nonforcing',convention:'course24-spoutnik-3NT-after-stopper'},
            reason:`cours 24 : arrêt Pique confirmé par 2SA et ${H} H chez le répondant => 3SA`
          };
        }
      }
      return null;
    }

    return null;
  }
  function bidRank(call){ const b=parseBid(call); return b ? (b.level-1)*5+RANK[b.strain] : -1; }
  function allCalls(){
    const out=['PASS','X','XX'];
    for(let l=1;l<=7;l++) for(const s of ['C','D','H','S','NT']) out.push(`${l}${s}`);
    return out;
  }
  function opponentBidSuits(history,seat){
    const side=sideOf(seat), set=new Set();
    for(const x of history){ const b=parseBid(x.call); if(b && sideOf(x.seat)!==side && b.strain!=='NT') set.add(b.strain); }
    return set;
  }
  function partnershipBidSuits(history,seat){
    const side=sideOf(seat), set=new Set();
    for(const x of history){ const b=parseBid(x.call); if(b && sideOf(x.seat)===side && b.strain!=='NT') set.add(b.strain); }
    return set;
  }
  function stopperScore(deal,seat,suit){
    const h=deal?.hands?.[seat]||{}; const cards=String(h[suit]||''); const n=cards.length;
    if(cards.includes('A')) return 1;
    if(cards.includes('K') && n>=2) return 0.9;
    if(cards.includes('Q') && n>=3) return 0.7;
    if(cards.includes('J') && n>=4) return 0.4;
    return 0;
  }
  function legalCalls(history,seat,isLegal){ return allCalls().filter(c=>!isLegal || isLegal(history,c,seat)); }

  function passConcern(ctx){
    const {seat,deal,history}=ctx;
    const H=hcp(deal,seat), L=lengths(deal,seat), partner=partnerOf(seat);
    const role=partnerRole(history,seat), pOpen=role.pFirst;
    if(!pOpen) return {severity:0,reasons:[]};

    // Le Critic vise ici la force encore non exprimée : s'il a déjà fait une annonce
    // constructive, on ne prétend pas connaître la signification fine de son Passe.
    if(ownMeaningfulCalls(history,seat).length) return {severity:0,reasons:[]};

    const last=lastActualBid(history); if(!last) return {severity:0,reasons:[]};
    const lastB=parseBid(last.call); if(!lastB || lastB.level>=4) return {severity:0,reasons:[]};

    const semantic=ctx.semanticContext||null;
    const semanticPartner=semantic?.partnerMeaning||null;
    const semanticHcpMin=Number(semanticPartner?.hcp?.min||0);
    // Ne jamais traiter un overcall de 2C comme une ouverture forte de 2C (bug v0.2).
    // Sans sémantique explicite, une enchère du partenaire qui n'est pas l'ouverture
    // ne reçoit aucun plancher artificiel de force.
    const roleFloor=role.isOpener ? openingMinimum(pOpen.call) : 0;
    const pMin=Math.max(roleFloor,semanticHcpMin);
    const combinedFloor=H+pMin;
    const oppSuits=opponentBidSuits(history,seat);
    const long=SUITS.filter(s=>L[s]>=5 && !oppSuits.has(s)).sort((a,b)=>L[b]-L[a]);
    const legalNatural=long.filter(s=>{
      for(let level=1;level<=3;level++) if(!ctx.isLegal || ctx.isLegal(history,`${level}${s}`,seat)) return true;
      return false;
    });

    let sev=0; const reasons=[];
    if(semantic?.forcingActive){
      sev+=10;
      reasons.push(`enchère partenaire ${semantic.entry?.call||''} enregistrée forcing un tour`);
    }
    if(semanticHcpMin>roleFloor) reasons.push(`partenaire communiqué ${semanticHcpMin}+ H via le journal sémantique`);
    if(semanticPartner?.suits){
      for(const s of SUITS){
        const promised=Number(semanticPartner.suits?.[s]?.min||0);
        if(promised>=5 && L[s]>=3){ sev+=0.8; reasons.push(`fit implicite: partenaire ${promised}+ ${s}, moi ${L[s]}`); }
      }
    }
    if(H>=10){ sev+=1.2; reasons.push(`${H} H encore non exprimés`); }
    if(H>=12){ sev+=2.0; reasons.push(role.isOpener?'force constructive face à une ouverture du partenaire':'force constructive encore non exprimée'); }
    if(H>=13){ sev+=1.0; }
    if(combinedFloor>=23){ sev+=1.2; reasons.push(`plancher de force du camp ≈ ${combinedFloor} H`); }
    if(combinedFloor>=25){ sev+=1.6; reasons.push('potentiel de manche déjà élevé'); }
    if(legalNatural.length){
      sev+=1.8;
      reasons.push(`couleur descriptive ${legalNatural[0]} de ${L[legalNatural[0]]} cartes disponible`);
    }
    // L'adversaire vient de prendre le contrat à bas palier alors que notre camp a ouvert.
    if(sideOf(last.seat)!==sideOf(seat) && lastB.level<=2){
      sev+=1.2; reasons.push(`adversaire seulement au palier de ${lastB.level}`);
    }
    return {severity:sev,reasons,H,L,pMin,combinedFloor,legalNatural,partnerRole:role};
  }

  function scoreAlternative(call,ctx,passInfo){
    const {seat,deal,history,diagnosis}=ctx;
    const H=passInfo.H ?? hcp(deal,seat), L=passInfo.L ?? lengths(deal,seat);
    const b=parseBid(call), last=lastActualBid(history), partner=partnerOf(seat);
    const pSuits=partnershipBidSuits(history,seat), oSuits=opponentBidSuits(history,seat);
    let score=0; const why=[];

    // Petite influence de PONS lorsqu'il avait lui-même envisagé le candidat.
    const top=Array.isArray(diagnosis?.top)?diagnosis.top:[];
    const pd=top.find(x=>String(x.call||'').toUpperCase()===call);
    if(pd){ score += Math.min(1.5, Math.max(-1.5, Number(pd.score||0)*0.25)); why.push('candidat PONS'); }

    if(call==='PASS'){
      score -= passInfo.severity || 0;
      return {call,score,confidence:0,why:['force/information abandonnée']};
    }
    if(call==='X'){
      score += H>=10?1.5:-2;
      const unbidMajors=['H','S'].filter(s=>!pSuits.has(s) && !oSuits.has(s) && L[s]>=4);
      if(unbidMajors.length){ score+=2.2; why.push(`majeure ${unbidMajors[0]} 4+`); }
      if(H>=12) score+=0.8;
      const confidence=unbidMajors.length ? 2.3 : 1.0;
      return {call,score,confidence,why};
    }
    if(call==='XX') return {call,score:H>=10?1:-3,confidence:0.8,why};
    if(!b) return {call,score:-99,confidence:0,why};

    if(b.strain==='NT'){
      score += balanced(L)?2.0:-2.8;
      if(H>=12) score+=0.8;
      if(b.level===2){
        if(H>=11 && H<=14) score+=1.0;
        if(H>=15) score+=0.2;
      }
      if(b.level===3){
        const floor=(passInfo.pMin||0)+H;
        score += floor>=25?1.8:-1.4;
      }
      for(const s of oSuits){ const st=stopperScore(deal,seat,s); score += st*0.8; if(!st) score-=0.7; }
      why.push(balanced(L)?'distribution compatible SA':'distribution peu compatible SA');
      const stopped=[...oSuits].every(s=>stopperScore(deal,seat,s)>=0.7);
      const confidence=(balanced(L)&&stopped&&b.level<=3) ? 2.1 : 1.0;
      return {call,score,confidence,why};
    }

    const len=L[b.strain], q=suitHcp(deal,seat,b.strain);
    // Une couleur annoncée par l'adversaire n'est pas traitée comme une couleur
    // naturelle par le Critic : elle peut être un cue-bid conventionnel, mais sans
    // accord explicite on ne l'invente jamais comme solution automatique.
    let confidence=1.0;
    if(oSuits.has(b.strain)){
      score -= 20.0;
      confidence=0;
      why.push('couleur adverse: cue-bid non présumé');
    }
    if(len>=5){ score += 4.2 + 0.9*(len-5); why.push(`${len} cartes à ${b.strain}`); }
    else if(len===4){ score += 1.0; }
    else if(len===3){ score -= 1.0; }
    else score -= 3.0;
    score += Math.min(1.2,q*0.18);

    if(pSuits.has(b.strain)){
      if(len>=3){ score+=2.0; why.push('soutien de la couleur du partenaire'); }
      else score-=1.5;
    } else {
      // Nouvelle couleur naturelle : une couleur cinquième est particulièrement descriptive
      // et constitue le cas le plus sûr pour une substitution automatique du Critic.
      if(len>=5){ score+=1.2; if(!oSuits.has(b.strain)) confidence=3.2; }
    }

    // Ne pas propulser artificiellement une main au palier de 4+ sans raison nette.
    if(b.level>=4){
      const floor=(passInfo.pMin||0)+H;
      if(floor<25 && !(pSuits.has(b.strain)&&len>=3)) score-=3.0;
    }
    // Une enchère au palier de 3 demande un minimum de valeurs lorsque la couleur est nouvelle.
    if(b.level===3 && !pSuits.has(b.strain)) score += H>=10?0.8:-2.0;

    // Économie : à qualité comparable, ne pas sauter inutilement des paliers.
    const lastRank=last?bidRank(last.call):-1;
    const jump=bidRank(call)-lastRank;
    if(jump>5) score-=Math.min(1.5,(jump-5)*0.15);
    return {call,score,confidence,why};
  }

  function chooseAlternative(ctx,passInfo){
    const last=lastActualBid(ctx.history);
    const lastLevel=parseBid(last?.call)?.level || 0;
    const maxExploratoryLevel=Math.min(3,lastLevel+1);
    // Le veto PASS de v0.1 ne doit pas se transformer en saut de manche/chelem
    // inventé : il cherche d'abord une continuation descriptive à proximité.
    const legal=legalCalls(ctx.history,ctx.seat,ctx.isLegal)
      .filter(c=>{
        if(c==='PASS') return false;
        const b=parseBid(c);
        return !b || b.level<=maxExploratoryLevel;
      });
    const scored=legal.map(c=>scoreAlternative(c,ctx,passInfo))
      .sort((a,b)=>b.score-a.score);
    // Pour agir sans connaître la convention exacte, il faut une alternative à haute
    // confiance. Les autres candidats restent utiles au diagnostic mais ne sont pas joués.
    const safe=scored.filter(x=>(x.confidence||0)>=3.0);
    const best=safe[0]||null, second=safe[1]||null;
    if(!best) return {best:null,scored};
    const margin=second ? best.score-second.score : 99;
    return {best:{...best,margin},scored};
  }


  // SEF 2024 reference overlay derived from the external benchmark v0.3 rulebook.
  // Only high-confidence rules compatible with the user's PONS system are enabled here.
  // Deliberately excluded: direct Rubensohl over 1NT-(2D), because in this project 2D
  // belongs to the Multi-Landy defence and does not have the benchmark's natural meaning.
  function sef2024ReferenceCorrection(ctx){
    const history=normHistory(ctx.history,ctx.deal);
    // v2.39 — CONTRACT FINAL BENCHMARK: les règles SEF de v2.38 ne doivent pas
    // changer de sens à cause de Passes placés AVANT la première vraie enchère.
    // On recadre donc la signature sur la première enchère chiffrée. En revanche,
    // on mémorise explicitement si le joueur courant avait déjà passé : cette
    // information reste indispensable pour Drury et ne doit surtout pas être perdue.
    const firstBidIndex=history.findIndex(x=>parseBid(x.call));
    const preOpening=firstBidIndex>0?history.slice(0,firstBidIndex):[];
    const relHistory=firstBidIndex>=0?history.slice(firstBidIndex):history;
    const key=relHistory.map(x=>x.call).join(' ');
    const seat=String(ctx.seat||'').toUpperCase(), raw=String(ctx.call||'').toUpperCase(), H=hcp(ctx.deal,seat), L=lengths(ctx.deal,seat);
    const passedBeforeOpening=preOpening.some(x=>x.seat===seat&&x.call==='PASS');
    const partnerPassedBeforeOpening=preOpening.some(x=>x.seat===partnerOf(seat)&&x.call==='PASS');
    const hand=ctx.deal?.hands?.[seat]||{};
    const maxLen=Math.max(...SUITS.map(s=>L[s]||0));
    const HL=H+SUITS.reduce((n,s)=>n+Math.max(0,(L[s]||0)-4),0);
    const strictBal=strictBalanced(L);
    const stop=(s)=>{const c=String(hand[s]||'');return c.includes('A')||(c.includes('K')&&c.length>=2)||(c.includes('Q')&&c.length>=3)||(c.includes('J')&&c.length>=4);};
    const short=(s)=>(L[s]||0)<=1;
    // v2.46 : les interventions faibles doivent être jugées comme à la table,
    // pas avec un seuil HCP aveugle. Chailley/SEF : plancher autour de 9HL,
    // modulé par la vulnérabilité ; de 8/9 à 12HL il faut une belle couleur
    // ou une vraie irrégularité, tandis que 13-18HL autorise toute couleur 5e.
    const vulState=String(ctx.deal?.vulnerable||'None');
    const ourSide=sideOf(seat), oppSide=ourSide==='NS'?'EW':'NS';
    const ourVul=vulState==='Both'||vulState===ourSide, oppVul=vulState==='Both'||vulState===oppSide;
    const overcallMinHL=(ourVul&&!oppVul)?10:((!ourVul&&oppVul)?8:9);
    const irregular=SUITS.some(s=>(L[s]||0)<=1);
    const goodOvercallSuit=(s)=>{
      const c=String(hand[s]||''); if(c.length<5) return false;
      const top=['A','K','Q'].filter(r=>c.includes(r)).length;
      const middle=['J','T','9'].filter(r=>c.includes(r)).length;
      return top>=2 && (c.length>=6 || middle>=1);
    };
    const practicalOneLevelOvercall=(s)=>{
      if((L[s]||0)<5 || HL>18 || HL<overcallMinHL) return false;
      if(HL>=13) return true;
      return irregular || goodOvercallSuit(s);
    };
    const legal=(c)=>!ctx.isLegal||ctx.isLegal(history,c,seat);
    const out=(c,reason,convention='sef2024-reference')=>legal(c)?{call:c,reason,semantic:{natural:!['X','XX'].includes(c),source:'sef2024-benchmark-v03-reference',forcing:'unknown',publishWhenNative:true,convention}}:null;

    // RKCB 5 clés 30-41. This is an explicit agreement of this project.
    if(key==='1S PASS 2NT PASS 4S PASS 4NT PASS'){
      const aces=SUITS.reduce((n,s)=>n+(String(hand[s]||'').includes('A')?1:0),0);
      const keys=aces+(String(hand.S||'').includes('K')?1:0), q=String(hand.S||'').includes('Q');
      const target=(keys===0||keys===3)?'5C':(keys===1||keys===4)?'5D':q?'5S':'5H';
      return out(target,`SEF/RKCB 30-41 : ${keys} clé${keys>1?'s':''}${keys===2?(q?' avec':' sans')+' Dame d’atout':''}`,'blackwood-5keys-30-41');
    }

    // Natural splinters after an uncontested major opening.
    if((key==='1H PASS'||key==='1S PASS') && !passedBeforeOpening && H>=11 && H<=15){
      const m=key[1], fit=L[m]||0;
      if(fit>=4){
        const order=m==='H'?[['S','3S'],['C','4C'],['D','4D']]:[['C','4C'],['D','4D'],['H','4H']];
        for(const [s,c] of order) if(short(s)) return out(c,`SEF 2024 : Splinter, fit ${m} 4+ et courte ${s}`,'splinter');
      }
    }

    // v2.45 — audit 100K : ne pas écraser par X les deux familles naturelles
    // qui ont produit les chelems aberrants observés. Les fiches Chailley/SEF
    // sont explicites : après 1C-(1H), un fit Trèfle naturel 5+ dans la zone
    // 6-12 HLD possède 2C/3C ; après 1D-(1H), 2C est naturel forcing avec
    // 5+ Trèfles et 12HL+. Dans les autres zones on conserve le profil PONS
    // v2.44, afin de ne pas élargir cette passe au chantier complet du Contre.
    if(key==='1C 1H' && L.S<=3 && L.C>=5){
      const hldC=supportHld(ctx.deal,seat,'C');
      if(hldC>=11 && hldC<=12 && H<=10 && legal('3C')) return {call:'3C',changed:raw!=='3C',reason:'SEF/Chailley : soutien Trèfle propositionnel 11-12 HLD => 3C, prioritaire au Contre',semantic:{natural:true,source:'v245-sef-natural-priority-1C1H-3C',suits:{C:{min:5,max:13},S:{min:0,max:3}},hcp:{min:5,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'competitive-minor-support'}};
      if(hldC>=6 && hldC<=10 && legal('2C')) return {call:'2C',changed:raw!=='2C',reason:'SEF/Chailley : soutien naturel Trèfle 6-10 HLD => 2C, prioritaire au Contre',semantic:{natural:true,source:'v245-sef-natural-priority-1C1H-2C',suits:{C:{min:5,max:13},S:{min:0,max:3}},hcp:{min:0,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'competitive-minor-support'}};
    }
    if(key==='1D 1H' && L.S<=3 && L.C>=5 && HL>=12 && legal('2C'))
      return {call:'2C',changed:raw!=='2C',reason:'SEF/Chailley : 5+ Trèfles et 12HL+ => 2C naturel forcing, prioritaire au Contre',semantic:{natural:true,source:'v245-sef-natural-priority-1D1H-2C',suits:{C:{min:5,max:13},S:{min:0,max:3}},hcp:{min:10,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'competitive-natural-priority'}};

    // Profil historique PONS/benchmark pour les autres mains sans quatre Piques.
    // v2.45 enrichit surtout le sens publié (S<=3), ce qui empêche l'ouvreur de
    // fabriquer ensuite un fit Pique imaginaire.
    if((key==='1C 1H'||key==='1D 1H') && H>=8&&H<=12 && L.S<=3 && maxLen<=5)
      return {call:'X',changed:raw!=='X',reason:'SEF 2024 : Contre d’appel sans quatre Piques',semantic:{natural:false,source:'v245-sef-spoutnik-no-four-spades',suits:{S:{min:0,max:3}},hcp:{min:8,max:12},forcing:'unknown',publishWhenNative:true,convention:'spoutnik-no-four-spades'}};
    if(key==='1D 1S' && H>=8&&H<=12 && L.H>=4 && L.S<=2)
      return out('X','SEF 2024 : Spoutnik, quatre Cœurs ou plus','spoutnik');

    // v2.56 — Redemande libre vs redemande forcée de l'ouvreur (SEF 2024).
    // Après une réponse forcing et le Passe du n°4, l'ouvreur DOIT reparler :
    // dans la zone régulière 12-14 sans fit ni deuxième couleur naturelle, 1SA
    // ne promet donc PAS l'arrêt de l'intervention. A l'inverse, quand le n°4
    // intervient, la redemande devient libre : 1SA garantit l'arrêt, puisque
    // l'ouvreur pouvait Passer. Les garde-fous de forme ci-dessous évitent
    // d'écraser un soutien réel ou une redemande naturelle.
    const rebidOneNT=(reason,source,suitCaps)=>legal('1NT')?{
      call:'1NT',changed:raw!=='1NT',reason,
      semantic:{natural:true,source,hcp:{min:12,max:14},suits:suitCaps||{},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-free-vs-forced-opener-rebid'}
    }:null;
    let forcedCaps=null;
    if(key==='1C 1D 1H PASS' && L.H<=3 && L.S<=3) forcedCaps={H:{min:0,max:3},S:{min:0,max:3}};
    else if(key==='1C 1D 1S PASS' && L.S<=3 && L.H<=3) forcedCaps={S:{min:0,max:3},H:{min:0,max:3}};
    else if(key==='1C 1H 1S PASS' && L.S<=3 && L.D<=3) forcedCaps={S:{min:0,max:3},D:{min:0,max:3}};
    else if(key==='1D 1H 1S PASS' && L.S<=3 && L.C<=3) forcedCaps={S:{min:0,max:3},C:{min:0,max:3}};
    if(forcedCaps && H>=12&&H<=14 && strictBal)
      return rebidOneNT('SEF 2024 : redemande forcée à 1SA, arrêt de l’intervention non promis','v256-sef2024-forced-1nt-opener-rebid',forcedCaps);

    let freeCaps=null;
    if(key==='1C PASS 1D 1H' && L.D<=3 && L.S<=3 && L.H<=3 && stop('H')) freeCaps={D:{min:0,max:3},S:{min:0,max:3}};
    else if(key==='1C PASS 1D 1S' && L.D<=3 && L.H<=3 && L.S<=3 && stop('S')) freeCaps={D:{min:0,max:3},H:{min:0,max:3}};
    // Avec 3 Cœurs, un accord de paire de type support-double peut être prioritaire ;
    // v2.56 ne force donc 1SA ici que sans soutien possible.
    else if(key==='1C PASS 1H 1S' && L.H<=2 && L.D<=3 && L.S<=3 && stop('S')) freeCaps={H:{min:0,max:2},D:{min:0,max:3}};
    else if(key==='1D PASS 1H 1S' && L.H<=3 && L.C<=3 && stop('S')) freeCaps={H:{min:0,max:3},C:{min:0,max:3}};
    if(freeCaps && H>=12&&H<=14 && strictBal)
      return rebidOneNT('SEF 2024 : redemande libre à 1SA avec arrêt garanti','v256-sef2024-free-1nt-opener-rebid',freeCaps);

    // v2.57 — POSITIONS SANDWICH + INTERVENTIONS DIFFÉRÉES.
    // Objectif architectural : utiliser le Passe précédent comme une information
    // négative. Une action au second tour n'est pas interprétée comme si le joueur
    // arrivait dans la séquence sans passé : ce qu'il aurait pu annoncer au premier
    // tour borne désormais sa distribution résiduelle. Les règles ci-dessous sont
    // volontairement limitées aux poches explicites des fiches Chailley/Bessis.
    const currentPassedEarlier=history.some((x,i)=>i<history.length-1 && x.seat===seat && x.call==='PASS');
    const sandwichGoodLong=(s,minLen=6)=>{
      const c=String(hand[s]||''); if(c.length<minLen) return false;
      const top=['A','K','Q'].filter(r=>c.includes(r)).length;
      const mid=['J','T','9'].filter(r=>c.includes(r)).length;
      // À six cartes, deux gros honneurs suffisent déjà à une couleur sérieuse ;
      // à cinq cartes on exige en plus une carte de structure J/T/9.
      return top>=2 && (c.length>=6 || mid>=1);
    };

    // 1H-P-2C-? : deux couleurs adverses ont été annoncées. Michel Bessis demande
    // une intervention rigoureuse et privilégie le naturel quand une vraie couleur
    // est annonçable. Le contre décrit le bicolore inversé : exactement 4 Piques et
    // 4/5+ Carreaux. On ne force ici que les formes non ambiguës.
    if(key==='1H PASS 2C'){
      if(HL>=13 && HL<=19 && L.S===4 && L.D>=5 && L.H<=2 && L.C<=2 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:'Chailley/Bessis : contre sandwich descriptif, exactement 4 Piques et 5+ Carreaux',
          semantic:{natural:false,source:'v257-sandwich-1H-2C-double-5D4S',suits:{S:{min:4,max:4},D:{min:5,max:13},H:{min:0,max:2},C:{min:0,max:2}},points:{min:13,max:19},forcing:'unknown',publishWhenNative:true,convention:'sandwich-pass-inference'}};
      if(HL>=13 && HL<=19 && L.D>=6 && L.S<=4 && L.H<=2 && L.C<=2 && sandwichGoodLong('D',6) && legal('2D'))
        return {call:'2D',changed:raw!=='2D',reason:'Chailley/Bessis : intervention naturelle sandwich sérieuse, 6+ beaux Carreaux',
          semantic:{natural:true,source:'v257-sandwich-1H-2C-natural-2D',suits:{D:{min:6,max:13}},points:{min:13,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-natural'}};
      if(HL>=13 && HL<=19 && L.S>=6 && L.D<=4 && L.H<=2 && L.C<=2 && sandwichGoodLong('S',6) && legal('2S'))
        return {call:'2S',changed:raw!=='2S',reason:'Chailley/Bessis : intervention naturelle sandwich sérieuse, 6+ beaux Piques',
          semantic:{natural:true,source:'v257-sandwich-1H-2C-natural-2S',suits:{S:{min:6,max:13}},points:{min:13,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-natural'}};
    }

    // 1D-P-1H-1NT : en sandwich, 1SA reste fort (16-18H) et promet des arrêts
    // dans LES DEUX couleurs nommées. C'est une différence importante avec un 1SA
    // de réveil ou certaines conventions après Passe initial.
    if(key==='1D PASS 1H' && H>=16 && H<=18 && strictBal && stop('D') && stop('H') && legal('1NT'))
      return {call:'1NT',changed:raw!=='1NT',reason:'Chailley/Bessis : 1SA sandwich fort 16-18H avec arrêt dans les deux couleurs adverses',
        semantic:{natural:true,source:'v257-sandwich-1D-1H-1NT',hcp:{min:16,max:18},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1NT'}};

    // 1C-P-1S-X : le contre sandwich montre les deux couleurs restantes, avec
    // exactement quatre Cœurs et 4/5+ Carreaux dans la zone d'ouverture.
    if(key==='1C PASS 1S' && HL>=13 && HL<=19 && L.H===4 && L.D>=4 && L.C<=2 && L.S<=3 && legal('X'))
      return {call:'X',changed:raw!=='X',reason:'Chailley : contre sandwich 1T-P-1P = Carreaux + exactement 4 Cœurs, valeur d’ouverture',
        semantic:{natural:false,source:'v257-sandwich-1C-1S-double',suits:{H:{min:4,max:4},D:{min:4,max:13},C:{min:0,max:2},S:{min:0,max:3}},points:{min:13,max:19},forcing:'unknown',publishWhenNative:true,convention:'sandwich-double'}};

    // Continuation après le contre sandwich : l'ouvreur n'est pas autorisé à
    // « inventer » un Surcontre avec une ouverture ordinaire. La fiche Chailley
    // 1T-P-1P-X-? réserve XX aux mains de 18HL+ ; avec 12H-17HL, pas de fit à
    // Pique, pas de sixième Trèfle et sans le profil précis de 1SA (14-15 avec
    // arrêts dans les deux couleurs promises par X), Passe est la redemande
    // économique. Cette règle est volontairement bornée à ce cas sans alternative.
    if(key==='1C PASS 1S X' && H>=12 && HL<=17 && L.S<=3 && L.C<=5 &&
       !(HL>=14 && HL<=15 && stop('D') && stop('H')) && legal('PASS'))
      return {call:'PASS',changed:raw!=='PASS',reason:'Chailley : après le contre sandwich, ouverture ordinaire sans fit ni meilleure redemande = Passe ; XX est réservé à 18HL+',
        semantic:{natural:false,source:'v257-sandwich-1C-1S-X-opener-pass',points:{min:12,max:17},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-double-continuation'}};

    // 1C-P-1NT-X : 1SA de réponse nie les majeures quatrièmes ; le contre du n°4
    // est donc un contre d'appel ordinaire, avec intérêt pour les trois autres
    // couleurs et au moins la valeur d'une ouverture.
    if(key==='1C PASS 1NT' && HL>=13 && HL<=19 && L.C<=2 && L.D>=3 && L.H>=3 && L.S>=3 && legal('X'))
      return {call:'X',changed:raw!=='X',reason:'Chailley : contre sandwich sur 1SA de réponse = contre d’appel ordinaire, intérêt dans les trois autres couleurs',
        semantic:{natural:false,source:'v257-sandwich-1C-1NT-double',suits:{C:{min:0,max:2},D:{min:3,max:13},H:{min:3,max:13},S:{min:3,max:13}},points:{min:13,max:19},forcing:'unknown',publishWhenNative:true,convention:'sandwich-double'}};

    // Intervention différée : 1D-P-1H-P-2D-X. Le joueur courant avait déjà la
    // possibilité d'annoncer 1S au premier tour. Son Passe exclut donc une bonne
    // couleur cinquième à Pique ; le Contre ultérieur montre les deux noires avec
    // EXACTEMENT quatre Piques. C'est l'inférence négative structurante de v2.57.
    if(key==='1D PASS 1H PASS 2D' && currentPassedEarlier && HL>=12 && HL<=18 &&
       L.S===4 && L.C>=4 && L.D<=2 && L.H<=3 && legal('X'))
      return {call:'X',changed:raw!=='X',reason:'Chailley : contre différé = deux noires ; le Passe initial exclut 5 beaux Piques, donc exactement 4 Piques',
        semantic:{natural:false,source:'v257-delayed-double-pass-negative-inference',suits:{S:{min:4,max:4},C:{min:4,max:13},D:{min:0,max:2},H:{min:0,max:3}},points:{min:12,max:18},forcing:'unknown',publishWhenNative:true,convention:'delayed-overcall-pass-inference'}};

    // Après 1S-P-2S-P-P, le fit adverse garantit désormais des valeurs chez le
    // partenaire : une bonne couleur cinquième qui était trop dangereuse au premier
    // tour peut être annoncée en réveil différé. On reste très strict pour ne pas
    // transformer toutes les mains de 10H en interventions automatiques.
    if(key==='1S PASS 2S PASS PASS' && currentPassedEarlier && HL>=10 && HL<=15 &&
       L.D>=5 && L.S<=2 && L.H<=3 && L.C<=3 && sandwichGoodLong('D',5) && legal('3D'))
      return {call:'3D',changed:raw!=='3D',reason:'Chailley : intervention différée après fit Pique, bonne couleur 5e+ à Carreau devenue sûre grâce aux renseignements du premier tour',
        semantic:{natural:true,source:'v257-delayed-natural-after-fit-3D',suits:{D:{min:5,max:13},S:{min:0,max:2}},points:{min:10,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'delayed-overcall-pass-inference'}};

    // v2.58 — RÉVEIL DU RÉPONDANT APRÈS 1SA SANDWICH + DOUBLE MÉMOIRE NÉGATIVE.
    // Séquences : 1C/1D-P-1H-1NT-P-P-?. Le Passe de l'ouvreur n'est pas neutre :
    // il suggère une main limitée (en pratique 12-14H dans les poches sans meilleure
    // redemande) et exclut un unicolore/bicolore annonçable. Le Passe du partenaire
    // de l'intervenant suggère à son tour moins de 6HL. Le répondant peut donc
    // réveiller beaucoup plus précisément ; avec 9HL+ et sans main très excentrée,
    // le Contre punitif est l'action de priorité.
    if(key==='1C PASS 1H 1NT PASS PASS'){
      // Les mains très excentrées priment sur le Contre punitif générique.
      if(HL>=8 && HL<=10 && L.H>=6 && L.C<=4 && L.D<=4 && L.S<=3 && legal('2H'))
        return {call:'2H',changed:raw!=='2H',reason:'Chailley/Bessis : après 1SA sandwich puis deux Passes, 2Cœur naturel avec 6+ Cœurs et 8-10HL',
          semantic:{natural:true,source:'v258-1C-1H-1NT-reopen-2H',suits:{H:{min:6,max:13}},points:{min:8,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory'}};
      if(HL>=8 && L.H>=5 && L.D>=4 && L.C<=3 && L.S<=3 && legal('2D'))
        return {call:'2D',changed:raw!=='2D',reason:'Chailley/Bessis : après 1SA sandwich puis deux Passes, bicolore économique Cœur-Carreau ; la distribution justifie de jouer plutôt que punir',
          semantic:{natural:true,source:'v258-1C-1H-1NT-reopen-2D',suits:{H:{min:5,max:13},D:{min:4,max:13}},points:{min:8,max:37},forcing:'one_round',publishWhenNative:true,convention:'sandwich-1nt-negative-memory'}};
      if(HL>=8 && HL<=10 && L.C>=5 && L.C<=6 && L.H>=4 && L.H<=5 && L.D<=3 && L.S<=3 && legal('2C'))
        return {call:'2C',changed:raw!=='2C',reason:'Chailley/Bessis : après 1SA sandwich puis deux Passes, 2Trèfle naturel avec 5/6 Trèfles et 4/5 Cœurs',
          semantic:{natural:true,source:'v258-1C-1H-1NT-reopen-2C',suits:{C:{min:5,max:6},H:{min:4,max:5}},points:{min:8,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory'}};
      if(HL>=9 && maxLen<=5 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:'Chailley/Bessis : deux Passes ont limité les autres mains ; avec 9HL+ sans distribution extrême, Contre punitif prioritaire de 1SA sandwich',
          semantic:{natural:false,source:'v258-1C-1H-1NT-reopen-penalty-double',points:{min:9,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory',doubleType:'penalty'}};
    }
    if(key==='1D PASS 1H 1NT PASS PASS'){
      if(HL>=8 && HL<=11 && L.H>=6 && L.C<=4 && L.D<=4 && L.S<=3 && legal('2H'))
        return {call:'2H',changed:raw!=='2H',reason:'Chailley/Bessis : après 1SA sandwich puis deux Passes, 2Cœur naturel avec 6+ Cœurs et 8-11HL',
          semantic:{natural:true,source:'v258-1D-1H-1NT-reopen-2H',suits:{H:{min:6,max:13}},points:{min:8,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory'}};
      if(HL>=8 && HL<=11 && L.D>=5 && L.H>=4 && L.C<=3 && L.S<=3 && legal('2D'))
        return {call:'2D',changed:raw!=='2D',reason:'Chailley/Bessis : après 1SA sandwich puis deux Passes, 2Carreau naturel avec 5+ Carreaux et 4 Cœurs',
          semantic:{natural:true,source:'v258-1D-1H-1NT-reopen-2D',suits:{D:{min:5,max:13},H:{min:4,max:13}},points:{min:8,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory'}};
      if(HL>=8 && HL<=11 && L.C>=5 && L.C<=6 && L.H>=4 && L.D<=3 && L.S<=3 && legal('2C'))
        return {call:'2C',changed:raw!=='2C',reason:'Chailley/Bessis : après 1SA sandwich puis deux Passes, 2Trèfle naturel avec 5/6 Trèfles et 4+ Cœurs',
          semantic:{natural:true,source:'v258-1D-1H-1NT-reopen-2C',suits:{C:{min:5,max:6},H:{min:4,max:13}},points:{min:8,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory'}};
      if(HL>=9 && maxLen<=5 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:'Chailley/Bessis : Passe de l’ouvreur + Passe adverse rendent le Contre punitif prioritaire avec 9HL+ contre 1SA sandwich',
          semantic:{natural:false,source:'v258-1D-1H-1NT-reopen-penalty-double',points:{min:9,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory',doubleType:'penalty'}};
    }

    // Une fois le répondant revenu par X, l'ouvreur ne doit pas annuler l'inférence
    // qu'il a lui-même créée par son Passe précédent. Rien de nouveau ne s'est produit
    // entre son Passe sur 1SA et le Contre punitif du partenaire : si le joueur de 1SA
    // passe, l'ouvreur laisse donc jouer 1SA contré au lieu d'inventer une redemande.
    if((key==='1C PASS 1H 1NT PASS PASS X PASS' || key==='1D PASS 1H 1NT PASS PASS X PASS') && legal('PASS'))
      return {call:'PASS',changed:raw!=='PASS',reason:'Mémoire négative v2.58 : l’ouvreur avait déjà passé 1SA ; le Contre ultérieur du partenaire est punitif, donc aucune redemande ne doit être inventée',
        semantic:{natural:false,source:'v258-opener-respects-delayed-penalty-double',forcing:'nonforcing',publishWhenNative:true,convention:'sandwich-1nt-negative-memory'}};

    // v2.61 — RÉOUVERTURE APRÈS UNE INTERVENTION À SAUT FAIBLE : NE PAS
    // APPLIQUER MÉCANIQUEMENT LA RÈGLE DU PALIER DE 1.
    // Fiche Chailley exacte : 1C-(2H faible)-P-P-? puis réponses après X-P.
    // Le Passe du répondant reste ambigu, mais le n°4 peut avoir jusqu'à 13/14HL :
    // contrairement à une intervention au palier de 1, l'ouvreur MINIMUM ne doit
    // donc pas réveiller automatiquement. X exige 17HL+, ou 14-16HL avec courte H
    // et environ trois levées de défense. Les mains très descriptives gardent leur
    // enchère naturelle plutôt que d'être noyées dans le Contre.
    if(key==='1C 2H PASS PASS'){
      const dtr=defensiveTricksEstimate(ctx.deal,seat);
      const cHcp=suitHcp(ctx.deal,seat,'C');
      const shape=SUITS.map(s=>L[s]).sort((a,b)=>a-b).join('-');
      // 6C-5D fort : le bicolore est plus informatif que X.
      if(HL>=19 && HL<=22 && L.C>=6 && L.D>=5 && L.H<=1 && legal('3D'))
        return {call:'3D',changed:raw!=='3D',reason:'Chailley : réveil sur 2Cœur faible, 19+HL avec 6+ Trèfles et 5+ Carreaux => 3Carreaux naturel',
          semantic:{natural:true,source:'v261-1C-2H-reopen-3D',suits:{C:{min:6,max:13},D:{min:5,max:13},H:{min:0,max:1}},points:{min:19,max:22},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      // 6C-5S fort : la fiche donne 3S ; avec seulement quatre Piques, 2S suffit.
      if(HL>=17 && HL<=21 && L.C>=6 && L.S>=5 && L.H<=1 && legal('3S'))
        return {call:'3S',changed:raw!=='3S',reason:'Chailley : réveil sur 2Cœur faible, 6+ Trèfles et 5+ Piques de bonne force => 3Pique descriptif',
          semantic:{natural:true,source:'v261-1C-2H-reopen-3S',suits:{C:{min:6,max:13},S:{min:5,max:13},H:{min:0,max:1}},points:{min:17,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      if(HL>=19 && HL<=21 && L.C>=6 && L.S===4 && L.H<=1 && legal('2S'))
        return {call:'2S',changed:raw!=='2S',reason:'Chailley : réveil sur 2Cœur faible, main forte 6 Trèfles + 4 Piques ne convenant pas au Contre => 2Pique',
          semantic:{natural:true,source:'v261-1C-2H-reopen-2S',suits:{C:{min:6,max:13},S:{min:4,max:4},H:{min:0,max:1}},points:{min:19,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      // Unicolore Trèfle fort, sans seconde couleur annonçable.
      if(HL>=19 && HL<=22 && L.C>=6 && L.S<=3 && L.D<=3 && L.H<=1 && cHcp>=6 && legal('3C'))
        return {call:'3C',changed:raw!=='3C',reason:'Chailley : réveil sur 2Cœur faible, 19+HL et 6/7 beaux Trèfles => 3Trèfles naturel',
          semantic:{natural:true,source:'v261-1C-2H-reopen-3C',suits:{C:{min:6,max:13},H:{min:0,max:1}},points:{min:19,max:22},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      // 18-19 régulier/semi-régulier avec arrêt Cœur : 2SA naturel.
      if(HL>=18 && HL<=19 && (shape==='3-3-3-4'||shape==='2-3-4-4'||shape==='2-3-3-5') && stop('H') && legal('2NT'))
        return {call:'2NT',changed:raw!=='2NT',reason:'Chailley : réveil sur 2Cœur faible, 18-19HL régulier ou semi-régulier avec arrêt Cœur => 2SA',
          semantic:{natural:true,source:'v261-1C-2H-reopen-2NT',points:{min:18,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      // Deuxième zone : Contre d'appel. Avec 14-16, on exige courte et vraie défense.
      if(HL>=17 && L.C<=5 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:'Chailley : après 1Trèfle-(2Cœur faible)-P-P, Contre de réveil avec vraie deuxième zone (17HL+)',
          semantic:{natural:false,source:'v261-1C-2H-reopen-X-strong',points:{min:17,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context',doubleType:'takeout_reopening'}};
      if(HL>=14 && HL<=16 && L.H<=1 && L.C<=5 && dtr>=3 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:`Chailley : réveil semi-fort sur 2Cœur faible, courte Cœur et ${dtr} levées de défense estimées => Contre`,
          semantic:{natural:false,source:'v261-1C-2H-reopen-X-short-defense',suits:{H:{min:0,max:1}},points:{min:14,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context',doubleType:'takeout_reopening'}};
      // Point architectural essentiel : une ouverture minimale courte à Cœur ne
      // suffit PAS ici. Ceci doit précéder la règle générique v2.59.
      if(HL<=16 && legal('PASS'))
        return {call:'PASS',changed:raw!=='PASS',reason:'Chailley : contre un saut faible à 2Cœur, le réveil minimum automatique du palier de 1 ne s’applique pas ; sans force/défense supplémentaire, Passe',
          semantic:{natural:true,source:'v261-1C-2H-reopen-min-pass',points:{min:12,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
    }

    // Répondant après 1C-(2H)-P-P-X-P. Il avait passé au premier tour, mais le
    // barrage explique ce Passe : la fiche donne une vraie table d'atterrissage,
    // dont la priorité est de rester ECONOMIQUE avec les mains faibles.
    if(key==='1C 2H PASS PASS X PASS'){
      const hCards=String(hand.H||'');
      const hTop=['A','K','Q'].filter(r=>hCards.includes(r)).length;
      const dtr=defensiveTricksEstimate(ctx.deal,seat);
      // Passe Blanche-Neige : au moins quatre Cœurs, deux levées sûres dans la
      // couleur et une autre levée de défense ; on borne à 7-10HL.
      if(HL>=7 && HL<=10 && L.H>=4 && hTop>=2 && dtr>=2.5 && legal('PASS'))
        return {call:'PASS',changed:raw!=='PASS',reason:'Chailley : passe-trappe sur 2Cœur, 4+ Cœurs avec deux levées sûres et défense annexe => transformation punitive du Contre',
          semantic:{natural:false,source:'v261-1C-2H-XP-trap-pass',suits:{H:{min:4,max:13}},points:{min:7,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context',doubleType:'penalty-conversion'}};
      if(HL<=7 && L.S>=4 && legal('2S'))
        return {call:'2S',changed:raw!=='2S',reason:'Chailley : après X-P sur 2Cœur faible, 0-7HL et 4+ Piques => 2Pique faible',
          semantic:{natural:true,source:'v261-1C-2H-XP-2S',suits:{S:{min:4,max:13}},points:{min:0,max:7},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      if(HL>=8 && HL<=10 && L.S>=5 && legal('3S'))
        return {call:'3S',changed:raw!=='3S',reason:'Chailley : après X-P, main maximale 8-10HLD avec 5+ Piques => 3Pique propositionnel',
          semantic:{natural:true,source:'v261-1C-2H-XP-3S',suits:{S:{min:5,max:13}},points:{min:8,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      if(HL>=8 && HL<=10 && stop('H') && L.S<=3 && L.D<=4 && L.C<=4 && maxLen<=4 && legal('2NT'))
        return {call:'2NT',changed:raw!=='2NT',reason:'Chailley : après X-P, 8-10HL réguliers avec arrêt Cœur => 2SA',
          semantic:{natural:true,source:'v261-1C-2H-XP-2NT',points:{min:8,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      if(HL<=7 && L.D>=4 && L.S<=3 && legal('3D'))
        return {call:'3D',changed:raw!=='3D',reason:'Chailley : après X-P, 0-7HL et 4+ Carreaux => 3Carreau faible',
          semantic:{natural:true,source:'v261-1C-2H-XP-3D',suits:{D:{min:4,max:13}},points:{min:0,max:7},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      if(HL<=7 && L.C>=5 && L.S<=3 && L.D<=3 && legal('3C'))
        return {call:'3C',changed:raw!=='3C',reason:'Chailley : après X-P, fit/semi-fit Trèfle faible sans meilleure couleur => 3Trèfle',
          semantic:{natural:true,source:'v261-1C-2H-XP-3C',suits:{C:{min:5,max:13}},points:{min:0,max:7},forcing:'nonforcing',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
      // Cue-bid poubelle : main non nulle, aucune sortie naturelle, mais pas assez
      // de défense pour transformer. On évite ainsi de passer mécaniquement 2HX.
      if(HL>=5 && HL<=7 && L.S<=3 && L.D<=3 && L.C<=3 && L.H>=4 && hTop<=1 && legal('3H'))
        return {call:'3H',changed:raw!=='3H',reason:'Chailley : après X-P, cue-bid 3Cœur « poubelle » avec 5-7HL sans meilleure enchère',
          semantic:{natural:false,source:'v261-1C-2H-XP-3H-cuebid',points:{min:5,max:7},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'weak-jump-reopening-context'}};
    }

    // v2.59 — RÉOUVERTURE DE L'OUVREUR APRÈS INTERVENTION + PASSE-TRAPPE.
    // Séquence générique : 1x-(couleur)-P-P-?. Le Passe du répondant est ambigu :
    // il peut être faible, mais il peut aussi cacher une opposition forte dans la
    // couleur adverse en attendant le Contre de réouverture de l'ouvreur. Cette
    // possibilité devient d'autant plus plausible que l'ouvreur est court dans
    // l'intervention. Chailley : avec 0/1/2 cartes dans cette couleur, le Contre
    // est prioritaire même avec une ouverture minimale ; sans courte, le Contre
    // peut encore décrire une main de 2e zone sans meilleure enchère.
    const reopenOpenerPattern=(()=>{
      if(relHistory.length!==4) return null;
      const [a,b,c,d]=relHistory;
      const ob=parseBid(a.call), ib=parseBid(b.call);
      if(a.seat!==seat || !ob || ob.level!==1 || !ib || ib.strain==='NT' || ib.level>2 ||
         c.call!=='PASS' || d.call!=='PASS' || sideOf(a.seat)===sideOf(b.seat)) return null;
      return {open:ob.strain,over:ib.strain};
    })();
    if(reopenOpenerPattern){
      const os=reopenOpenerPattern.open, is=reopenOpenerPattern.over;
      // Une vraie sixième de l'ouvreur conserve son enchère naturelle. Dans les
      // formes ordinaires, la courte dans l'intervention prime même sur une
      // deuxième couleur quatrième : elle protège le passe-trappe du partenaire.
      if(H>=12 && H<=17 && L[is]<=2 && L[os]<=5 && maxLen<=5 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:`Chailley : réouverture de l’ouvreur, ${L[is]} carte${L[is]>1?'s':''} dans l’intervention ${is} => Contre prioritaire pour préserver un éventuel passe-trappe`,
          semantic:{natural:false,source:'v259-opener-reopening-short-overcall-pass-trap',suits:{[is]:{min:0,max:2}},hcp:{min:12,max:17},forcing:'nonforcing',publishWhenNative:true,convention:'opener-reopening-pass-trap',doubleType:'takeout_reopening'}};
      // Deuxième zone régulière : le partenaire a pu passer faute d'enchère ou
      // pour punir. On borne volontairement à 16-17H afin de ne pas écraser le
      // 1SA naturel de réveil 18-20 avec arrêt solide documenté par la fiche.
      if(H>=16 && H<=17 && strictBal && L[os]<=5 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:'Chailley : Contre de réouverture de 2e zone (16-17H) sans meilleure enchère ; le partenaire conserve le droit de transformer en punitif',
          semantic:{natural:false,source:'v259-opener-reopening-second-zone',hcp:{min:16,max:17},forcing:'nonforcing',publishWhenNative:true,convention:'opener-reopening-pass-trap',doubleType:'takeout_reopening'}};
    }

    // Le partenaire qui avait passé peut effectivement avoir tendu le piège.
    // On ne fabrique pas un Passe punitif à partir de simples points : il faut
    // une vraie longueur dans l'intervention et au moins deux gros honneurs.
    const reopenPartnerPattern=(()=>{
      if(relHistory.length!==6) return null;
      const [a,b,c,d,e,f]=relHistory;
      const ob=parseBid(a.call), ib=parseBid(b.call);
      if(!ob || ob.level!==1 || !ib || ib.strain==='NT' || ib.level>2 ||
         c.seat!==seat || c.call!=='PASS' || d.call!=='PASS' || e.call!=='X' || f.call!=='PASS') return null;
      return {open:ob.strain,over:ib.strain};
    })();
    if(reopenPartnerPattern){
      const is=reopenPartnerPattern.over;
      const oc=String(hand[is]||'');
      const top=['A','K','Q'].filter(r=>oc.includes(r)).length;
      if(HL>=8 && HL<=11 && L[is]>=5 && top>=2 && legal('PASS'))
        return {call:'PASS',changed:raw!=='PASS',reason:'Chailley : le Passe initial cachait une forte opposition dans la couleur adverse ; le Contre de réouverture est transformé en punitif',
          semantic:{natural:false,source:'v259-partner-converts-reopening-double',suits:{[is]:{min:5,max:13}},points:{min:8,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'opener-reopening-pass-trap',doubleType:'penalty-conversion'}};
    }

    // v2.60 — CONTINUATIONS APRES LE CONTRE DE REOUVERTURE.
    // Fiche Chailley exacte : 1S-(2C)-P-P-X-? puis 1S-(2C)-P-P-X-P-?.
    // Le but n'est pas de faire "fuir" automatiquement l'intervenant : X est un
    // Contre d'appel de reouverture, et le repondant de l'ouvreur peut encore
    // transformer en punitif. L'intervenant ne reparle donc qu'avec une information
    // serieuse ; inversement le repondant faible choisit une sortie ECONOMIQUE.
    const v260ClubQuality=(()=>{
      const c=String(hand.C||'');
      return {top:['A','K','Q'].filter(r=>c.includes(r)).length,hcp:suitHcp(ctx.deal,seat,'C')};
    })();

    // Intervenant apres 1S-2C-P-P-X. Jusqu'a 16HL, la fiche donne Passe avec
    // 5/6 Trefles sans meilleure enchere. Avec 17-18HL, il faut publier la reserve :
    // bicolore 5/6-4, 7 Trefles, 6332 a SA, cue-bid avec 6 beaux Trefles, sinon XX.
    if(key==='1S 2C PASS PASS X'){
      if(HL<=16 && L.C>=5 && L.C<=6 && legal('PASS'))
        return {call:'PASS',changed:raw!=='PASS',reason:'Chailley : apres le Contre de reouverture, 5/6 Trefles et <=16HL sans information nouvelle => Passe ; ne pas fuir automatiquement le Contre',
          semantic:{natural:true,source:'v260-overcaller-after-reopening-X-weak-pass',suits:{C:{min:5,max:6}},points:{min:8,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
      if(HL>=17 && HL<=18 && L.C>=5){
        // 7 Trefles de bonne qualite : repetition au palier de 3.
        if(L.C>=7 && v260ClubQuality.hcp>=7 && legal('3C'))
          return {call:'3C',changed:raw!=='3C',reason:'Chailley : 17-18HL et 7 beaux Trefles apres X de reouverture => 3Trefles descriptif',
            semantic:{natural:true,source:'v260-overcaller-after-reopening-X-3C',suits:{C:{min:7,max:13}},points:{min:17,max:18},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
        // Un vrai bicolore 5/6 Trefles + 4 cartes laterales prime les enchères artificielles.
        if(L.D>=4 && L.C<=6 && v260ClubQuality.hcp>=5 && legal('2D'))
          return {call:'2D',changed:raw!=='2D',reason:'Chailley : 17-18HL, 5/6 Trefles de bonne qualite et 4+ Carreaux => 2Carreaux descriptif',
            semantic:{natural:true,source:'v260-overcaller-after-reopening-X-2D',suits:{C:{min:5,max:6},D:{min:4,max:13}},points:{min:17,max:18},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
        if(L.H>=4 && L.C<=6 && v260ClubQuality.hcp>=5 && legal('2H'))
          return {call:'2H',changed:raw!=='2H',reason:'Chailley : 17-18HL, 5/6 Trefles de bonne qualite et 4+ Coeurs => 2Coeurs descriptif',
            semantic:{natural:true,source:'v260-overcaller-after-reopening-X-2H',suits:{C:{min:5,max:6},H:{min:4,max:13}},points:{min:17,max:18},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
        // 6332 avec 6 Trefles tres corrects et arret Pique : 2SA naturel.
        const shape6332=SUITS.map(s=>L[s]).sort((a,b)=>a-b).join('-')==='2-2-3-6';
        if(L.C===6 && shape6332 && stop('S') && v260ClubQuality.hcp>=7 && legal('2NT'))
          return {call:'2NT',changed:raw!=='2NT',reason:'Chailley : 17-18HL, 6332, 6 beaux Trefles et arret Pique => 2SA naturel',
            semantic:{natural:true,source:'v260-overcaller-after-reopening-X-2NT',suits:{C:{min:6,max:6}},points:{min:17,max:18},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
        // Six beaux Trefles sans meilleure description : cue-bid, demande l'arret Pique.
        if(L.C===6 && v260ClubQuality.top>=2 && v260ClubQuality.hcp>=8 && legal('2S'))
          return {call:'2S',changed:raw!=='2S',reason:'Chailley : 17-18HL et 6 beaux Trefles => cue-bid 2Pique, recherche d arret pour SA',
            semantic:{natural:false,source:'v260-overcaller-after-reopening-X-cuebid',suits:{C:{min:6,max:6}},points:{min:17,max:18},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'reopening-double-continuations'}};
        // Sans meilleure description, le Surcontre publie simplement la forte reserve.
        if(L.C<=6 && legal('XX'))
          return {call:'XX',changed:raw!=='XX',reason:'Chailley : 17-18HL apres X de reouverture, sans meilleure enchere descriptive => Surcontre',
            semantic:{natural:false,source:'v260-overcaller-after-reopening-X-redouble',suits:{C:{min:5,max:6}},points:{min:17,max:18},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
      }
    }

    // Repondant de l'ouvreur apres 1S-2C-P-P-X-P. Il avait passe au premier tour :
    // - vrai passe-trappe 9-10HL avec 4/5 beaux Trefles => Passe punitif ;
    // - 0-7HL => sortie economique (jamais une manche militaire a 4S) ;
    // - 8-10HL sans couleur naturelle claire et sans passe-trappe => 2SA.
    if(key==='1S 2C PASS PASS X PASS'){
      const c=String(hand.C||'');
      const cTop=['A','K','Q'].filter(r=>c.includes(r)).length;
      if(HL>=9 && HL<=10 && L.C>=4 && L.C<=5 && cTop>=2 && legal('PASS'))
        return {call:'PASS',changed:raw!=='PASS',reason:'Chailley : le Passe initial cachait 4/5 beaux Trefles ; transformation du Contre de reouverture en punitif',
          semantic:{natural:false,source:'v260-responder-after-reopening-X-trap-pass',suits:{C:{min:4,max:5}},points:{min:9,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations',doubleType:'penalty-conversion'}};
      if(HL<=7){
        const opts=[];
        if(L.D>=4) opts.push({s:'D',n:L.D,call:'2D'});
        if(L.H>=4) opts.push({s:'H',n:L.H,call:'2H'});
        if(L.S>=3) opts.push({s:'S',n:L.S,call:'2S'});
        if(opts.length){
          opts.sort((a,b)=>b.n-a.n || ({S:2,H:1,D:0}[b.s]-{S:2,H:1,D:0}[a.s]));
          const best=opts[0], tied=opts.filter(x=>x.n===best.n);
          // Sur egalite exacte entre plusieurs couleurs, le jugement du noyau est conserve.
          // On corrige seulement les choix non ambigus, notamment les faux sauts a 4S.
          if(tied.length===1 && legal(best.call))
            return {call:best.call,changed:raw!==best.call,reason:`Chailley : 0-7HL apres X-P, sortie economique dans la couleur disponible (${best.n} cartes) => ${best.call}`,
              semantic:{natural:true,source:'v260-responder-after-reopening-X-weak-escape',suits:{[best.s]:{min:best.s==='S'?3:4,max:13}},points:{min:0,max:7},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
        }
      }
      if(HL>=8 && HL<=10 && L.D<=3 && L.H<=3 && L.S<=3 && !(L.C>=4 && cTop>=2) && legal('2NT'))
        return {call:'2NT',changed:raw!=='2NT',reason:'Chailley : 8-10HL apres X-P, sans sortie naturelle claire ni passe-trappe rentable => 2SA',
          semantic:{natural:true,source:'v260-responder-after-reopening-X-2NT',points:{min:8,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-continuations'}};
    }

    // Major support in competition / Truscott / fitted 2NT.
    if(key==='1H 1S'){
      if(H>=11&&H<=13&&L.H===3&&maxLen<=5) return out('2NT','SEF 2024 : 2SA fitté, exactement trois Cœurs','major-competitive');
      if(H>=6&&H<=9&&L.H>=3) return out('2H','SEF 2024 : soutien simple compétitif à Cœur','major-competitive');
    }
    if(key==='1H X'){
      if(H>=10&&H<=12&&L.H>=4&&maxLen<=5) return out('2NT','SEF 2024 : Truscott, fit Cœur 4+','major-competitive');
      if(H>=4&&H<=7&&L.H>=4) return out('3H','SEF 2024 : soutien barrage à 3Cœur','major-competitive');
      if(H>=10&&H<=14&&L.H<=2&&maxLen<=5) return out('XX','SEF 2024 : Surcontre de force sans soutien prioritaire','major-competitive');
    }
    if(key==='1S X'){
      if(H>=10&&H<=12&&L.S>=4&&maxLen<=5) return out('2NT','SEF 2024 : Truscott, fit Pique 4+','major-competitive');
      if(H>=4&&H<=7&&L.S>=4) return out('3S','SEF 2024 : soutien barrage à 3Pique','major-competitive');
      if(H>=6&&H<=9&&L.S>=3) return out('2S','SEF 2024 : soutien simple après Contre','major-competitive');
    }
    if(key==='1S 2H'){
      // v2.51 — SEF 2024 / fiche Chailley révisée : le changement majeur est que
      // 2SA est désormais FITTÉ par exactement trois Piques (11-16 HLD). Par
      // inférence le Contre Spoutnik dénie le fit. Publier cette information est
      // indispensable : sinon PONS peut relire X comme promettant des Piques et
      // fabriquer ensuite une manche à 4S avec seulement cinq cartes chez l'ouvreur.
      const hldS=supportHld(ctx.deal,seat,'S');

      // Soutiens explicites, prioritaires au Contre.
      if(L.S===4 && hldS>=13 && legal('3H')) return {
        call:'3H',changed:raw!=='3H',reason:`SEF 2024/Chailley : cue-bid fitté fort, ${hldS} HLD et 4 Piques => 3Cœur`,
        semantic:{natural:false,source:'v251-sef2024-1S2H-fit-cuebid',suits:{S:{min:4,max:13}},points:{min:13,max:37},forcing:'game_if_uncontested',publishWhenNative:true,convention:'sef2024-1S-2H-responses'}
      };
      if(L.S===4 && hldS>=11 && hldS<=12 && legal('3S')) return {
        call:'3S',changed:raw!=='3S',reason:`SEF 2024/Chailley : soutien propositionnel, ${hldS} HLD et 4 Piques => 3Pique`,
        semantic:{natural:true,source:'v251-sef2024-1S2H-four-card-invite',suits:{S:{min:4,max:13}},points:{min:11,max:12},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-responses'}
      };
      if(L.S===3 && hldS>=11 && hldS<=16 && legal('2NT')) return {
        call:'2NT',changed:raw!=='2NT',reason:`SEF 2024/Chailley : 2SA fitté, exactement 3 Piques et ${hldS} HLD`,
        semantic:{natural:false,source:'v251-sef2024-1S2H-fitted-2NT',suits:{S:{min:3,max:3}},points:{min:11,max:16},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-responses'}
      };
      if(L.S>=3 && hldS>=6 && hldS<=10 && legal('2S')) return {
        call:'2S',changed:raw!=='2S',reason:`SEF 2024/Chailley : soutien simple compétitif, ${hldS} HLD et ${L.S} Piques`,
        semantic:{natural:true,source:'v251-sef2024-1S2H-simple-raise',suits:{S:{min:3,max:13}},points:{min:6,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-1S-2H-responses'}
      };

      // Sans fit, une belle mineure cinquième avec 11HL+ possède son enchère
      // naturelle forcing au palier de 3. Le Contre reste le fourre-tout 8+HL
      // lorsqu'aucune de ces enchères naturelles n'est disponible.
      if(L.S<=2 && HL>=11){
        if(L.C>=5 && legal('3C')) return {
          call:'3C',changed:raw!=='3C',reason:`SEF 2024/Chailley : 5+ Trèfles et ${HL} HL => 3Trèfle naturel forcing`,
          semantic:{natural:true,source:'v251-sef2024-1S2H-natural-3C',suits:{C:{min:5,max:13},S:{min:0,max:2}},points:{min:11,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-1S-2H-responses'}
        };
        if(L.D>=5 && legal('3D')) return {
          call:'3D',changed:raw!=='3D',reason:`SEF 2024/Chailley : 5+ Carreaux et ${HL} HL => 3Carreau naturel forcing`,
          semantic:{natural:true,source:'v251-sef2024-1S2H-natural-3D',suits:{D:{min:5,max:13},S:{min:0,max:2}},points:{min:11,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-1S-2H-responses'}
        };
      }
      if(L.S<=2 && HL>=8 && legal('X')) return {
        call:'X',changed:raw!=='X',reason:`SEF 2024/Chailley : Contre Spoutnik généralisé ${HL} HL, sans fit Pique`,
        semantic:{natural:false,source:'v251-sef2024-1S2H-negative-double-no-fit',suits:{S:{min:0,max:2}},points:{min:8,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-1S-2H-spoutnik'}
      };
    }
    if(key==='1H 2C'){
      if(H>=11&&H<=13&&L.H===3&&maxLen<=5) return out('2NT','SEF 2024 : 2SA fitté, exactement trois Cœurs','major-competitive');
      if(H>=6&&H<=9&&L.H>=3) return out('2H','SEF 2024 : soutien simple compétitif à Cœur','major-competitive');
    }


    // Core responses to 1NT (SEF 2024). Stayman has priority with invitational+ 5-4 majors.
    if(key==='1NT PASS'){
      if(H>=8&&H<=14&&((L.H===5&&L.S===4)||(L.S===5&&L.H===4))) return out('2C','SEF 2024 : Stayman avec majeure 5-4 invitation+','stayman');
      if(H>=8&&H<=13&&((L.H===4&&L.S<=4)||(L.S===4&&L.H<=4))) return out('2C','SEF 2024 : Stayman avec majeure quatrième','stayman');
      if(L.H>=5&&L.S<=4&&H<=12) return out('2D','SEF 2024 : Texas Cœur','texas');
      if(L.S>=5&&L.H<=4&&H<=12) return out('2H','SEF 2024 : Texas Pique','texas');
      if(H>=8&&H<=9&&strictBal&&L.H<=3&&L.S<=3) return out('2NT','SEF 2024 : proposition quantitative à 2SA','natural-nt');
      if(H>=10&&H<=14&&strictBal&&L.H<=3&&L.S<=3) return out('3NT','SEF 2024 : conclusion à 3SA','natural-nt');
      if(H<=7&&Math.max(L.H,L.S)<=4&&maxLen<=5) return out('PASS','SEF 2024 : main faible sans transfert utile','natural-nt');
    }

    // Responses to minor openings in clean SEF positions.
    if(key==='1C PASS'){
      if(H>=11&&H<=12&&strictBal&&L.H<=3&&L.S<=3) return out('2NT','SEF : 11-12 H réguliers sans majeure quatrième','minor-response');
      if(H>=6&&H<=10){ if(L.S>=4&&L.H<=3)return out('1S','SEF : réponse naturelle 1P','minor-response'); if(L.H>=4&&L.S<=3)return out('1H','SEF : réponse naturelle 1Cœur','minor-response'); if(L.D>=4&&L.H<=3&&L.S<=3)return out('1D','SEF : réponse naturelle 1Carreau','minor-response'); if(strictBal&&L.H<=3&&L.S<=3)return out('1NT','SEF : réponse 1SA régulière','minor-response'); }
    }
    if(key==='1D PASS'){
      if(H>=11&&H<=12&&strictBal&&L.H<=3&&L.S<=3) return out('2NT','SEF : 11-12 H réguliers sans majeure quatrième','minor-response');
      if(H>=6&&H<=10){ if(L.S>=4&&L.H<=3)return out('1S','SEF : réponse naturelle 1P','minor-response'); if(L.H>=4&&L.S<=3)return out('1H','SEF : réponse naturelle 1Cœur','minor-response'); if(strictBal&&L.H<=3&&L.S<=3)return out('1NT','SEF : réponse 1SA régulière','minor-response'); }
    }

    // v2.45 — audit autonome 100K / fiche 1D-1S-2H : le bicolore cher est
    // forcing un tour. Passe n'existe pas. Avec une main faible, 2SA est le
    // modérateur forcing ; avec 5+ Piques et 8-10 H environ, 2S est naturel et
    // forcing. Cette couche ne s'active que sur la séquence exacte et seulement
    // dans la zone où l'audit observait des Passes illicites.
    if(key==='1D PASS 1S PASS 2H PASS' && H<=10){
      if(L.S>=5 && H>=8 && legal('2S')) return {call:'2S',changed:raw!=='2S',reason:'SEF/Chailley : après bicolore cher, 5+ Piques et 8-10 H => 2S forcing',semantic:{natural:true,source:'v245-reverse-responder-2S',suits:{S:{min:5,max:13}},hcp:{min:8,max:10},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'reverse-continuation'}};
      if(legal('2NT')) return {call:'2NT',changed:raw!=='2NT',reason:'SEF/Chailley : 2SA modérateur après bicolore cher ; Passe est impossible',semantic:{natural:false,source:'v245-reverse-2NT-moderator',hcp:{min:5,max:10},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'reverse-2NT-moderator'}};
    }
    // Après le 2SA modérateur, 3D est obligatoire avec un bicolore cher minimum
    // (18-19). C'est précisément la porte de sortie non forcing du répondant faible.
    if(key==='1D PASS 1S PASS 2H PASS 2NT PASS' && H>=18 && H<=19 && L.D>=5 && L.H>=4 && legal('3D'))
      return {call:'3D',changed:raw!=='3D',reason:'SEF/Chailley : après 2SA modérateur, retour obligatoire à 3D avec 18-19',semantic:{natural:true,source:'v245-reverse-opener-3D-after-moderator',suits:{D:{min:5,max:13},H:{min:4,max:13}},hcp:{min:18,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'reverse-2NT-moderator'}};

    if(key==='1D PASS 1S PASS 2H PASS 2S PASS' && L.D>=5 && L.H>=4){
      if(L.S>=3){
        const target=HL>=21?'3S':'4S';
        if(legal(target)) return {call:target,changed:raw!==target,reason:`SEF/Chailley : après 2S forcing, fit Pique 3e => ${target}`,semantic:{natural:true,source:'v245-reverse-opener-spade-fit-after-2S',suits:{S:{min:3,max:3},D:{min:5,max:13},H:{min:4,max:13}},hcp:{min:15,max:23},forcing:target==='3S'?'one_round_if_uncontested':'nonforcing',publishWhenNative:true,convention:'reverse-continuation'}};
      }
      if(L.D>=6 && legal('3D')) return {call:'3D',changed:raw!=='3D',reason:'SEF/Chailley : après 2S forcing, bicolore 6-4 misfitté => 3D',semantic:{natural:true,source:'v245-reverse-opener-3D-after-2S',suits:{D:{min:6,max:13},H:{min:4,max:13},S:{min:0,max:2}},hcp:{min:15,max:23},forcing:'nonforcing',publishWhenNative:true,convention:'reverse-continuation'}};
      if(HL<=19 && legal('2NT')) return {call:'2NT',changed:raw!=='2NT',reason:'SEF/Chailley : après 2S forcing, bicolore cher minimum misfitté => 2SA',semantic:{natural:true,source:'v245-reverse-opener-2NT-after-2S',suits:{S:{min:0,max:2}},hcp:{min:15,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'reverse-continuation'}};
      if(L.H>=5 && legal('3H')) return {call:'3H',changed:raw!=='3H',reason:'SEF/Chailley : bicolore 6-5 fort après 2S => 3H forcing',semantic:{natural:true,source:'v245-reverse-opener-3H-after-2S',suits:{D:{min:6,max:13},H:{min:5,max:13}},hcp:{min:18,max:23},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'reverse-continuation'}};
      if(L.C>=3 && legal('3C')) return {call:'3C',changed:raw!=='3C',reason:'SEF/Chailley : main forte misfittée 1-4-5-3 après 2S => 3C forcing',semantic:{natural:true,source:'v245-reverse-opener-3C-after-2S',suits:{C:{min:3,max:13},D:{min:5,max:13},H:{min:4,max:13},S:{min:0,max:2}},hcp:{min:18,max:23},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'reverse-continuation'}};
    }

    // Clean opener rebids after 1m-1M.
    if(key==='1C PASS 1H PASS'){
      if(H>=18&&H<=19&&strictBal&&L.H<=3&&L.S<=3&&L.C>=3)return out('2NT','SEF : redemande 18-19 régulière','opener-rebid');
      if(H>=12&&H<=17&&L.S===4&&L.H<=3&&L.C>=3&&L.D<=L.C)return out('1S','SEF : bicolore économique, quatre Piques','opener-rebid');
      if(H>=12&&H<=16&&L.C>=6&&L.H<=3&&L.S<=3)return out('2C','SEF : répétition des Trèfles sixièmes','opener-rebid');
      if(H>=12&&H<=16&&L.H===4&&L.C>=3&&L.S<=3)return out('2H','SEF : soutien Cœur par quatre cartes','opener-rebid');
      if(H>=12&&H<=14&&strictBal&&L.H<=3&&L.S<=3&&L.C>=3)return out('1NT','SEF : redemande 1SA 12-14','opener-rebid');
    }
    if(key==='1D PASS 1S PASS'){
      if(H>=18&&H<=20&&L.D>=4&&L.H===4&&L.S<=3&&legal('2H'))
        return {call:'2H',changed:raw!=='2H',reason:'SEF : bicolore cher Carreau-Cœur, 18-20 H, forcing un tour',semantic:{natural:true,source:'v245-sef-1D-1S-reverse-2H',suits:{D:{min:4,max:13},H:{min:4,max:4},S:{min:0,max:3}},hcp:{min:18,max:20},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-reverse'}};
      if(L.D>=5&&L.H===4&&L.S<=3&&HL<18&&H>=12&&legal('2D'))
        return {call:'2D',changed:raw!=='2D',reason:`SEF : ${HL} HL insuffisants pour un bicolore cher ; répétition économique des Carreaux`,semantic:{natural:true,source:'v245-sef-no-light-reverse-1D1S',suits:{D:{min:5,max:13},H:{min:0,max:4}},hcp:{min:12,max:17},forcing:'unknown',publishWhenNative:true,convention:'opener-rebid'}};
      if(H>=18&&H<=19&&strictBal&&L.S<=3&&L.H<=3&&L.D>=3)return out('2NT','SEF : redemande 18-19 régulière','opener-rebid');
      if(H>=12&&H<=16&&L.D>=6&&L.S<=3&&L.H<=3)return out('2D','SEF : répétition des Carreaux sixièmes','opener-rebid');
      if(H>=12&&H<=16&&L.D>=4&&L.S===4&&L.H<=3)return out('2S','SEF : soutien Pique par quatre cartes','opener-rebid');
      if(H>=12&&H<=14&&strictBal&&L.S<=3&&L.H<=3&&L.D>=3)return out('1NT','SEF : redemande 1SA 12-14','opener-rebid');
    }

    // Major-opening responses (clean benchmark zones).
    if(key==='1H PASS' && !passedBeforeOpening){
      // SEF 2024 / 2SA fitté : avec 13+ HLD et exactement trois atouts,
      // le répondant ne saute pas à 3SA ; il commence par un changement de
      // couleur pour exprimer ensuite le fit. Avec quatre Piques, 1S reste
      // prioritaire ; sinon on utilise la mineure la plus descriptive.
      const directHeartFitHld=supportHld(ctx.deal,seat,'H');
      if(directHeartFitHld>=13&&L.H===3&&L.S<=3){
        const m=(L.C>L.D)?'C':(L.D>L.C)?'D':(suitHcp(ctx.deal,seat,'C')>=suitHcp(ctx.deal,seat,'D')?'C':'D');
        return out(`2${m}`,'SEF 2024 : fit Cœur fort par trois cartes, différé par un changement de couleur','major-response');
      }
      if(H>=12&&H<=15&&L.C>=5&&L.H<=2&&L.S<=3)return out('2C','SEF : 2 sur 1 naturel à Trèfle','major-response');
      if(H>=10&&H<=11&&L.H>=4&&L.S<=3&&maxLen<=5)return out('3H','SEF : soutien limite à 3Cœur','major-response');
      if(H>=6&&H<=9&&L.H>=3&&L.S<=3)return out('2H','SEF : soutien simple à Cœur','major-response');
      if(H>=6&&H<=10&&L.S>=4&&L.H<=2)return out('1S','SEF : réponse naturelle 1P','major-response');
      if(H>=6&&H<=10&&L.H<=2&&L.S<=3&&maxLen<=5)return out('1NT','SEF : réponse 1SA','major-response');
    }
    if(key==='1S PASS' && !passedBeforeOpening){
      // 2C/2D peuvent masquer un fit différé, mais une vraie couleur Cœur 5e+
      // se nomme naturellement à 2H dès la zone du 2-sur-1 ; l'enchère est
      // forcing et auto-forcing, sans plafond. Cette priorité est essentielle
      // dans les mains fortes 5-5 ou 6-4 que le noyau pouvait décrire à Carreau.
      if(H>=17&&L.H>=5)return out('2H','SEF : 2Cœur naturel, 5+ cartes, 2-sur-1 forcing et auto-forcing (garde-fou mains fortes)','major-response');
      if(H>=12&&H<=15&&L.C>=5&&L.S<=2)return out('2C','SEF : 2 sur 1 naturel à Trèfle','major-response');
      if(H>=10&&H<=11&&L.S>=4&&maxLen<=5)return out('3S','SEF : soutien limite à 3Pique','major-response');
      if(H>=6&&H<=9&&L.S>=3)return out('2S','SEF : soutien simple à Pique','major-response');
      if(H>=6&&H<=10&&L.S<=2&&maxLen<=5)return out('1NT','SEF : réponse 1SA','major-response');
    }

    // Defence over 1NT used by this project: Landy majors, X = minor-major.
    if(key==='1NT'&&H>=8&&H<=15){
      if((L.H>=5&&L.S>=4)||(L.S>=5&&L.H>=4)) return out('2C','SEF/PONS : Landy, les deux majeures','defense-1nt');
      if((L.C>=5&&L.H>=4&&L.S<=3)||(L.C>=5&&L.S>=4&&L.H<=3)||(L.D>=5&&L.H>=4&&L.S<=3)||(L.D>=5&&L.S>=4&&L.H<=3)) return out('X','SEF/PONS : Contre mineure-majeure','defense-1nt');
    }

    // v2.46 — veto pratique des mauvaises interventions faibles au palier de 1.
    // Si le noyau propose naturellement une couleur 5e mais que la main est dans
    // la zone faible (<=12HL) sans qualité de couleur, irrégularité ni seuil de
    // vulnérabilité suffisant, on préfère Passe. On ne touche pas aux 5-5, qui
    // peuvent relever d'une convention bicolore, ni aux mains de 13HL+.
    {
      const availByOpening={
        '1C':['D','H','S'],
        '1D':['H','S'],
        '1H':['S']
      };
      const avail=availByOpening[key]||[];
      const longAvail=avail.filter(s=>(L[s]||0)>=5);
      if(longAvail.length===1 && HL<=12){
        const s=longAvail[0];
        const openerSuit=key.length===2?key[1]:null;
        const noOtherFive=SUITS.filter(x=>x!==openerSuit&&x!==s).every(x=>(L[x]||0)<=4);
        if(noOtherFive && raw===`1${s}` && !practicalOneLevelOvercall(s) && legal('PASS')){
          return {
            call:'PASS',changed:true,
            reason:`SEF pratique : intervention 1${s} trop légère ou couleur insuffisante dans la zone faible (${HL} HL)`,
            semantic:{natural:true,source:'v246-overcall-quality-veto',forcing:'nonforcing',publishWhenNative:true,convention:'overcall-quality'}
          };
        }
      }
    }

    // v2.46 — priorité pratique à l'intervention naturelle au palier de 1.
    // En usage réel, l'intervention naturelle a priorité sur le Contre lorsqu'elle
    // est disponible, mais la zone faible est filtrée par qualité/distribution et
    // vulnérabilité. Les 5-5 conventionnels sont laissés à Michaël/2SA.
    // Une couleur naturelle est valable jusqu'à 18HL ; à 19HL+, le Contre fort
    // toutes distributions reprend la priorité.
    if(key==='1C'&&L.D>=5&&L.H<=4&&L.S<=4&&practicalOneLevelOvercall('D'))
      return out('1D','SEF pratique : intervention naturelle 1Carreau prioritaire avec 5+ cartes','overcall');
    if(key==='1C'&&L.H>=5&&L.D<=4&&L.S<=4&&practicalOneLevelOvercall('H'))
      return out('1H','SEF pratique : intervention naturelle 1Cœur prioritaire avec 5+ cartes','overcall');
    if(key==='1C'&&L.S>=5&&L.D<=4&&L.H<=4&&practicalOneLevelOvercall('S'))
      return out('1S','SEF pratique : intervention naturelle 1Pique prioritaire avec 5+ cartes','overcall');
    if(key==='1D'&&L.H>=5&&L.S<=4&&L.C<=4&&practicalOneLevelOvercall('H'))
      return out('1H','SEF pratique : intervention naturelle 1Cœur prioritaire avec 5+ cartes','overcall');
    if(key==='1D'&&L.S>=5&&L.H<=4&&L.C<=4&&practicalOneLevelOvercall('S'))
      return out('1S','SEF pratique : intervention naturelle 1Pique prioritaire avec 5+ cartes','overcall');
    if(key==='1H'&&L.S>=5&&L.C<=4&&practicalOneLevelOvercall('S'))
      return out('1S','SEF pratique : intervention naturelle 1Pique prioritaire avec 5+ cartes','overcall');

    // Michaël précisé sur une majeure : autre majeure + Trèfles.
    if(key==='1H'&&H>=8&&H<=15&&L.S>=5&&L.C>=5)
      return out('2H','SEF/PONS : Michaël sur 1Cœur = cinq Piques et cinq Trèfles ou plus','michaels');
    if(key==='1S'&&H>=8&&H<=15&&L.H>=5&&L.C>=5)
      return out('2S','SEF/PONS : Michaël sur 1Pique = cinq Cœurs et cinq Trèfles ou plus','michaels');

    // Michaël précisé over a minor: 2D = both majors.
    if((key==='1C'||key==='1D')&&H>=9&&H<=16&&L.H>=5&&L.S>=5) return out('2D','SEF : Michaël précisé, les deux majeures','michaels');

    // v2.53 — DÉFENSE PRATIQUE CONTRE LES BARRAGES DE NIVEAU 3.
    // Cette passe ne cherche PAS à réécrire toute la défense. Les sondes v2.52 ont
    // montré que les Contres d'appel propres et 3SA sur 3M étaient déjà globalement
    // fiables. On ne corrige donc que des poches à sens explicite et à fort gain :
    // bicolores de cue-bid, 4SA mineur/mineur sur 3M, et quelques Passes impossibles
    // avec une intervention naturelle ou 3SA évidente.
    const preempt3GoodSuit=(s,minLen=5)=>{
      const c=String(hand[s]||''); if(c.length<minLen) return false;
      const top=['A','K','Q'].filter(r=>c.includes(r)).length;
      const support=['J','T','9'].filter(r=>c.includes(r)).length;
      return top===3 || (top>=2 && support>=1);
    };
    const preemptReopenGoodSuit=(s,minLen=5)=>{
      const c=String(hand[s]||''); if(c.length<minLen) return false;
      const top=['A','K','Q'].filter(r=>c.includes(r)).length;
      const support=['J','T','9'].filter(r=>c.includes(r)).length;
      return top>=2 || (top>=1 && support>=2);
    };
    const cleanOnlyLongSideSuit=(om,s)=>SUITS.every(t=>t===om||t===s||(L[t]||0)<=4);
    const cheapestOver3=(om,s)=>{
      const rank={C:0,D:1,H:2,S:3,NT:4}, base=10+rank[om]; // rang de 3om
      for(let lev=3;lev<=7;lev++) if(((lev-1)*5+rank[s])>base && legal(`${lev}${s}`)) return `${lev}${s}`;
      return null;
    };

    if(['3C','3D','3H','3S'].includes(key)){
      const om=key[1];

      // v2.54 — TRAITEMENT DE PAIRE PONS (OPTIONNEL SEF 2024).
      // Le SEF 2024 ne standardise plus ces bicolores au palier de 3, mais PONS
      // conserve l'ancien traitement Chailley comme convention interne de paire :
      // nos tests longitudinaux v2.53 montrent qu'il évite des atterrissages nettement
      // moins bons avec le noyau natif. Ne pas le présenter comme obligation SEF.
      if(key==='3D' && HL>=17 && L.D<=2 && L.H>=5 && L.S>=5 &&
         preempt3GoodSuit('H') && preempt3GoodSuit('S') && legal('4D')){
        return {call:'4D',changed:raw!=='4D',reason:'Traitement PONS/Chailley optionnel : sur 3Carreau, cue-bid 4Carreau = bicolore majeur 5-5 fort',
          semantic:{natural:false,source:'v253-preempt3-3D-cuebid-majors',suits:{H:{min:5,max:13},S:{min:5,max:13}},points:{min:17,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt3-cuebid-bicolor'}};
      }
      if(key==='3H' && HL>=17 && L.H<=2 && L.S>=5 && preempt3GoodSuit('S')){
        const mins=['C','D'].filter(m=>L[m]>=5 && preempt3GoodSuit(m));
        if(mins.length===1 && L[mins[0]]>=5 && legal('4H')){
          return {call:'4H',changed:raw!=='4H',reason:`Traitement PONS/Chailley optionnel : sur 3Cœur, cue-bid 4Cœur = Pique + ${mins[0]} 5-5 fort`,
            semantic:{natural:false,source:'v253-preempt3-3H-cuebid-spade-minor',suits:{S:{min:5,max:13}},points:{min:17,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt3-cuebid-bicolor'}};
        }
      }
      if(key==='3S' && HL>=17 && L.S<=2 && L.H>=5 && preempt3GoodSuit('H')){
        const mins=['C','D'].filter(m=>L[m]>=5 && preempt3GoodSuit(m));
        if(mins.length===1 && legal('4S')){
          return {call:'4S',changed:raw!=='4S',reason:`Traitement PONS/Chailley optionnel : sur 3Pique, cue-bid 4Pique = Cœur + ${mins[0]} 5-5 fort`,
            semantic:{natural:false,source:'v253-preempt3-3S-cuebid-heart-minor',suits:{H:{min:5,max:13}},points:{min:17,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt3-cuebid-bicolor'}};
        }
      }

      // Sur 3H/3S, 4SA décrit les deux mineures. Le seuil de levées de jeu est
      // volontairement prudent : la fiche parle d'une main capable d'environ
      // 10/11 levées. On préfère manquer quelques cas limites plutôt que pousser
      // un bot d'entraînement au palier de 5 avec une main simplement jolie.
      if((key==='3H'||key==='3S') && HL>=17 && L[om]<=2 && L.C>=5 && L.D>=5 &&
         L[om==='H'?'S':'H']<=2 && preempt3GoodSuit('C') && preempt3GoodSuit('D') &&
         playingTricksEstimate(ctx.deal,seat)>=9 && legal('4NT')){
        return {call:'4NT',changed:raw!=='4NT',reason:`Traitement PONS/Chailley optionnel : 4SA sur ${key} = bicolore mineur 5-5 très fort`,
          semantic:{natural:false,source:'v253-preempt3-major-4NT-minors',suits:{C:{min:5,max:13},D:{min:5,max:13}},points:{min:17,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt3-4NT-minors'}};
      }

      // Veto ultra-local contre un Passe du noyau avec une intervention naturelle
      // claire : 15-19HL, une seule bonne couleur 6e+, et pas la route 3SA.
      if(raw==='PASS' && HL>=15 && HL<=19 && L[om]<=2 && stopperScore(ctx.deal,seat,om)<0.7){
        const side=SUITS.filter(s=>s!==om && L[s]>=6 && preempt3GoodSuit(s,6) && cleanOnlyLongSideSuit(om,s));
        if(side.length===1){
          const target=cheapestOver3(om,side[0]);
          if(target) return {call:target,changed:true,reason:`Chailley : intervention sérieuse sur barrage, ${L[side[0]]} ${side[0]} de bonne qualité et ${HL}HL`,
            semantic:{natural:true,source:'v253-preempt3-pass-veto-natural',suits:{[side[0]]:{min:6,max:13}},points:{min:15,max:19},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-natural-overcall'}};
        }
      }

      // Même philosophie pour 3SA : seulement un PASS manifestement anormal sur
      // une main régulière 18-21HL avec arrêt réel de la couleur du barrage.
      if(raw==='PASS' && HL>=18 && HL<=21 && strictBal && L[om]<=3 && stop(om) && legal('3NT')){
        return {call:'3NT',changed:true,reason:`Chailley : 3SA sur ${key}, 18-21HL réguliers avec arrêt ${om}`,
          semantic:{natural:true,source:'v253-preempt3-pass-veto-3NT',points:{min:18,max:21},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-natural-3NT'}};
      }
    }

    // Le SEF 2024 classe désormais ces bicolores comme accord de paire ; PONS
    // les conserve de façon cohérente de l'enchère initiale jusqu'à l'atterrissage.

    // v2.54 — CONTINUATIONS DU TRAITEMENT DE PAIRE BICOLORE PONS.
    // 4M cue-bid montre l'autre majeure + UNE mineure indéterminée. Il est crucial
    // de ne pas laisser PONS traiter le cue-bid comme un soutien naturel de la
    // couleur adverse. Avec le fit dans l'autre majeure on choisit ce contrat ;
    // sinon 4SA demande à l'intervenant de nommer sa mineure.
    if(key==='3H 4H PASS' || key==='3H 4H X'){
      if(L.S>=3 && legal('4S')) return {call:'4S',changed:raw!=='4S',reason:'Bicolore sur 3Cœur : 4Cœur promet 5+ Piques ; avec 3+ Piques, choix naturel de 4Pique',
        semantic:{natural:true,source:'v253-preempt3-cuebid-advancer-fit-spades',suits:{S:{min:3,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-cuebid-bicolor-continuation'}};
      if(L.S<=2 && legal('4NT')) return {call:'4NT',changed:raw!=='4NT',reason:'Bicolore sur 3Cœur : sans fit Pique, 4SA demande la mineure de l’intervenant',
        semantic:{natural:false,source:'v253-preempt3-cuebid-ask-minor',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt3-cuebid-ask-minor'}};
    }
    if(key==='3S 4S PASS' || key==='3S 4S X'){
      if(L.H>=3 && legal('5H')) return {call:'5H',changed:raw!=='5H',reason:'Bicolore sur 3Pique : 4Pique promet 5+ Cœurs ; avec 3+ Cœurs, choix du fit à 5Cœur',
        semantic:{natural:true,source:'v253-preempt3-cuebid-advancer-fit-hearts',suits:{H:{min:3,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-cuebid-bicolor-continuation'}};
      if(L.H<=2 && legal('4NT')) return {call:'4NT',changed:raw!=='4NT',reason:'Bicolore sur 3Pique : sans fit Cœur, 4SA demande la mineure de l’intervenant',
        semantic:{natural:false,source:'v253-preempt3-cuebid-ask-minor',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt3-cuebid-ask-minor'}};
    }
    if(key==='3H 4H PASS 4NT PASS' || key==='3S 4S PASS 4NT PASS' ||
       key==='3H 4H X 4NT PASS' || key==='3S 4S X 4NT PASS'){
      const knownMajor=key.startsWith('3H')?'S':'H';
      // L'intervenant a promis exactement une mineure 5e+ dans ce module.
      let m=null;
      if(L.C>=5 && L.D<5) m='C'; else if(L.D>=5 && L.C<5) m='D';
      else if(L.C>=5 || L.D>=5) m=(L.D>L.C?'D':L.C>L.D?'C':(suitHcp(ctx.deal,seat,'D')>suitHcp(ctx.deal,seat,'C')?'D':'C'));
      if(m && legal(`5${m}`)) return {call:`5${m}`,changed:raw!==`5${m}`,reason:`4SA demande la mineure du bicolore ${knownMajor}+mineure : réponse 5${m}`,
        semantic:{natural:true,source:'v253-preempt3-cuebid-show-minor',suits:{[m]:{min:5,max:13},[knownMajor]:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-cuebid-bicolor-continuation'}};
    }

    // 4SA direct sur 3H/3S = deux mineures : le partenaire doit choisir une
    // mineure, jamais inventer une majeure au palier de 5. En cas d'égalité de
    // longueur, la qualité d'honneurs départage, avec Trèfle comme solution la
    // plus économique à stricte égalité.
    if(key==='3H 4NT PASS' || key==='3S 4NT PASS'){
      let m=L.D>L.C?'D':L.C>L.D?'C':(suitHcp(ctx.deal,seat,'D')>suitHcp(ctx.deal,seat,'C')?'D':'C');
      if(legal(`5${m}`)) return {call:`5${m}`,changed:raw!==`5${m}`,reason:`4SA bicolore mineur : choix de la meilleure mineure ${m}`,
        semantic:{natural:true,source:'v253-preempt3-4NT-advancer-choose-minor',suits:{[m]:{min:0,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-4NT-minors-continuation'}};
    }

    // v2.54 — REVEILS APRES BARRAGES DE NIVEAU 3.
    // Le reveil est sensiblement plus leger que l'intervention directe : les fiches
    // Chailley donnent 9H environ pour une couleur, 13-14H+ pour 3SA avec arret,
    // et un Contre toujours d'appel. On ne code ici que des poches tres nettes.
    if(['3C PASS PASS','3D PASS PASS','3H PASS PASS','3S PASS PASS'].includes(key)){
      const om=key[1];
      const others=SUITS.filter(s=>s!==om);
      const otherMajor=om==='H'?'S':om==='S'?'H':null;

      // 3SA de reveil : main reguliere/semi-reguliere avec vrai arret. La borne
      // 14-17H est volontairement centrale pour eviter de casser les mains de chelem.
      if(H>=14 && H<=17 && strictBal && stop(om) && legal('3NT')){
        return {call:'3NT',changed:raw!=='3NT',reason:`SEF/Chailley : 3SA de reveil sur 3${om}, 14-17H reguliers avec arret`,
          semantic:{natural:true,source:'v254-preempt3-reopen-3NT',hcp:{min:14,max:17},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-reopening'}};
      }

      // Couleur naturelle de reveil : six cartes de bonne qualite dans notre
      // overlay haute confiance. Les fiches admettent parfois cinq cartes, mais
      // nous restons plus conservateurs pour un bot d'entrainement.
      if(H>=9 && H<=15){
        const cand=others.filter(s=>L[s]>=6 && preemptReopenGoodSuit(s,6));
        if(cand.length){
          cand.sort((a,b)=>(L[b]-L[a])||(suitHcp(ctx.deal,seat,b)-suitHcp(ctx.deal,seat,a)));
          const target=cheapestOver3(om,cand[0]);
          if(target && Number(target[0])<=4 && legal(target)){
            return {call:target,changed:raw!==target,reason:`SEF/Chailley : reveil naturel sur 3${om}, ${L[cand[0]]} cartes ${cand[0]} et ${H}H`,
              semantic:{natural:true,source:'v254-preempt3-reopen-natural',suits:{[cand[0]]:{min:6,max:13}},hcp:{min:9,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-reopening'}};
          }
        }
      }

      // Contre de reveil : toujours d'appel. Avec une main de zone moyenne on
      // exige la courte dans le barrage et une vraie tolerance pour les couleurs
      // restantes ; avec 16+HL le contre toute distribution redevient possible.
      const weakShape = L[om]<=1 && (
        (om==='C'||om==='D') ? (L.H>=3 && L.S>=3 && Math.max(L.H,L.S)>=4 && others.every(s=>L[s]>=3))
                            : (L[otherMajor]>=4 && others.filter(s=>s!==otherMajor).every(s=>L[s]>=3))
      );
      if(((HL>=9 && HL<=15 && weakShape) || (HL>=16 && HL<=19)) && legal('X')){
        return {call:'X',changed:raw!=='X',reason:`SEF/Chailley : Contre de reveil d'appel sur 3${om}`,
          semantic:{natural:false,source:'v254-preempt3-reopen-double',hcp:{min:9,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-reopening'}};
      }
    }

    // v2.54 — REVEIL APRES 4H-P-P, fiche explicitement conforme au SEF 2024.
    // 4SA = les deux mineures ; 4S/5m sont naturels ; le Contre reste d'appel et
    // peut etre transforme en penalite par le partenaire.
    if(key==='4H PASS PASS'){
      if(L.C>=5 && L.D>=5 && L.H<=1 && (H>=10 || HL>=12) &&
         (preemptReopenGoodSuit('C')||preemptReopenGoodSuit('D')) && legal('4NT')){
        return {call:'4NT',changed:raw!=='4NT',reason:'SEF 2024 : 4SA en reveil sur 4Coeur = bicolore mineur 5-5+',
          semantic:{natural:false,source:'v254-preempt4H-reopen-4NT-minors',suits:{C:{min:5,max:13},D:{min:5,max:13}},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-reopening'}};
      }
      if(H>=9 && H<=15 && L.H<=1){
        for(const s of ['S','C','D']){
          const target=s==='S'?'4S':`5${s}`;
          if(L[s]>=6 && preemptReopenGoodSuit(s,6) && legal(target)){
            return {call:target,changed:raw!==target,reason:`SEF 2024 : reveil naturel ${target} sur 4Coeur, couleur 6e+ de bonne qualite`,
              semantic:{natural:true,source:'v254-preempt4H-reopen-natural',suits:{[s]:{min:6,max:13}},hcp:{min:9,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
          }
        }
      }
      if(HL>=9 && L.H<=1 && L.S>=4 && defensiveTricksEstimate(ctx.deal,seat)>=2 && legal('X')){
        return {call:'X',changed:raw!=='X',reason:`SEF 2024 : Contre d'appel en reveil sur 4Coeur, courte Coeur et ${defensiveTricksEstimate(ctx.deal,seat)} levees defensives estimees`,
          semantic:{natural:false,source:'v254-preempt4H-reopen-double',suits:{H:{min:0,max:1},S:{min:4,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
      }
    }

    // v2.55 — REVEIL APRES 4S-P-P.
    // Chailley : contre un barrage a 4S, intervention et reveil gardent la meme
    // signification. X reste d'appel ; une couleur au palier de 5 est naturelle
    // (distribution plus serieuse qu'au palier de 1) ; 4SA montre un bicolore
    // 5-5 quelconque parmi H/C/D, en pass-or-correct. Comme en v2.54 sur 4H,
    // l'overlay reste volontairement prudent dans les zones de jugement.
    if(key==='4S PASS PASS'){
      const side=['H','D','C'];
      const longs=side.filter(s=>L[s]>=5);
      if(L.S<=1 && longs.length>=2 && (H>=10 || HL>=12) &&
         (preemptReopenGoodSuit(longs[0])||preemptReopenGoodSuit(longs[1])) && legal('4NT')){
        return {call:'4NT',changed:raw!=='4NT',reason:'Chailley : 4SA en reveil sur 4Pique = bicolore 5-5+ quelconque (H/C/D), pass-or-correct',
          semantic:{natural:false,source:'v255-preempt4S-reopen-4NT-bicolor',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-reopening'}};
      }
      if(H>=9 && H<=15 && L.S<=1){
        for(const s of ['H','C','D']){
          const target=`5${s}`;
          if(L[s]>=6 && preemptReopenGoodSuit(s,6) && legal(target)){
            return {call:target,changed:raw!==target,reason:`Chailley : reveil naturel ${target} sur 4Pique, couleur 6e+ de bonne qualite`,
              semantic:{natural:true,source:'v255-preempt4S-reopen-natural',suits:{[s]:{min:6,max:13}},hcp:{min:9,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
          }
        }
      }
      // Le Contre de reveil est d'appel et transformable. Avec la zone basse,
      // on exige courte Pique, quatre Coeurs et de vraies levees defensives.
      // A partir de 16HL, la distribution peut etre moins parfaite, mais les
      // unicolores/bicolores clairs ont deja ete traites ci-dessus.
      const cleanShape=L.S<=1 && L.H>=4 && L.C>=3 && L.D>=3 && Math.max(L.H,L.C,L.D)<=5;
      if(((HL>=9 && HL<=15 && cleanShape && defensiveTricksEstimate(ctx.deal,seat)>=2) ||
          (HL>=16 && HL<=19 && L.S<=2 && defensiveTricksEstimate(ctx.deal,seat)>=2.5)) && legal('X')){
        return {call:'X',changed:raw!=='X',reason:`Chailley : Contre d'appel en reveil sur 4Pique (${HL}HL, ${defensiveTricksEstimate(ctx.deal,seat)} levees defensives estimees)`,
          semantic:{natural:false,source:'v255-preempt4S-reopen-double',suits:{S:{min:0,max:2}},hcp:{min:9,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
      }
    }

    // v2.55 — une couleur naturelle de reveil au palier de 5 est non forcing.
    // Le partenaire peut conserver une hausse native dans la meme couleur, mais
    // un saut spontané dans une AUTRE couleur au palier de 6 est une derive du
    // noyau observee dans le gate et n'est pas une continuation constructive
    // documentee de ce reveil naturel.
    if(/^4S PASS PASS 5[HCD] PASS$/.test(key) && /^6/.test(raw)){
      const natural=history[3]?.call?.slice(1), rawSuit=raw.slice(1);
      if(natural && rawSuit!==natural && legal('PASS')) return {call:'PASS',changed:true,reason:`qualite contrat v2.55 : ${history[3].call} de reveil est naturel et non forcing ; refus du saut natif parasite ${raw}`,
        semantic:{natural:true,source:'v255-preempt4S-reopen-natural-signoff-guard',forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }

    // v2.55 — PASS-OR-CORRECT APRES 4S-P-P-4SA.
    // Le partenaire nomme la couleur annexe au moins troisieme la plus
    // economique : 5C, sinon 5D, sinon 5H. Le bicoloreur passe si cette couleur
    // lui appartient ; sinon il rectifie vers la moins chere de ses couleurs.
    if(key==='4S PASS PASS 4NT PASS' || key==='4S PASS PASS 4NT X'){
      // Alain Levy : ne pas depasser 5C sans support Coeur. Avec 3+ Coeurs,
      // 5D sert de relais pass-or-correct ; sinon 5C garde les trois bicolores
      // sous le palier de 5H et evite toute escalade artificielle au palier de 6.
      const target=(L.C<3 && L.H>=3)?'5D':'5C';
      if(legal(target)) return {call:target,changed:raw!==target,reason:target==='5D'?'Alain Levy : sans fit Trefle mais avec support Coeur face au 4SA bicolore sur 4Pique => relais 5D, pass-or-correct':'Alain Levy : 5Trefles garde la sequence economique (fit Trefle ou absence de support Coeur)',
        semantic:{natural:false,source:'v255-preempt4S-reopen-4NT-pass-or-correct',forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }
    if(key==='4S PASS PASS 4NT PASS 5C PASS' || key==='4S PASS PASS 4NT PASS 5C X' ||
       key==='4S PASS PASS 4NT X 5C PASS' || key==='4S PASS PASS 4NT X 5C X'){
      if(L.C>=5 && legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA de reveil sur 4Pique : Trefle appartient au bicolore, 5Trefles accepte',
        semantic:{natural:true,source:'v255-preempt4S-reopen-4NT-accept-clubs',suits:{C:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
      if(L.D>=5 && legal('5D')) return {call:'5D',changed:raw!=='5D',reason:'4SA de reveil sur 4Pique : 5Trefles sans support Coeur, pas de Trefle chez le bicoloreur => bicolore Coeur-Carreau, correction 5Carreau',
        semantic:{natural:true,source:'v255-preempt4S-reopen-4NT-correct-diamonds',suits:{D:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }
    if(key==='4S PASS PASS 4NT PASS 5D PASS' || key==='4S PASS PASS 4NT PASS 5D X' ||
       key==='4S PASS PASS 4NT X 5D PASS' || key==='4S PASS PASS 4NT X 5D X'){
      if(L.D>=5 && legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA de reveil sur 4Pique : Carreau appartient au bicolore, 5Carreaux accepte',
        semantic:{natural:true,source:'v255-preempt4S-reopen-4NT-accept-diamonds',suits:{D:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
      if(L.H>=5 && legal('5H')) return {call:'5H',changed:raw!=='5H',reason:'4SA de reveil sur 4Pique : 5Carreau promet le support Coeur ; sans Carreau chez le bicoloreur => correction 5Coeur',
        semantic:{natural:true,source:'v255-preempt4S-reopen-4NT-correct-hearts',suits:{H:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }


    // Lorsque 5C (sans promesse de Coeur) a force le bicoloreur H-D a corriger
    // a 5D, le répondant peut encore choisir 5H s'il a un vrai support Coeur
    // et est court a Carreau. Sinon il accepte 5D. C'est le garde-fou qui fait
    // du mécanisme un vrai pass-or-correct et non un choix aveugle de mineure.
    if(key==='4S PASS PASS 4NT PASS 5C PASS 5D PASS' || key==='4S PASS PASS 4NT PASS 5C X 5D PASS' ||
       key==='4S PASS PASS 4NT X 5C PASS 5D PASS' || key==='4S PASS PASS 4NT X 5C X 5D PASS'){
      if(L.H>=3 && L.D<=2 && legal('5H')) return {call:'5H',changed:raw!=='5H',reason:'4SA de reveil sur 4Pique : bicolore Coeur-Carreau revele ; support Coeur et courte Carreau => 5Coeur',
        semantic:{natural:true,source:'v255-preempt4S-reopen-4NT-final-heart-choice',suits:{H:{min:3,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
      if(legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA de reveil sur 4Pique : bicolore Coeur-Carreau revele ; 5Carreau reste le meilleur atterrissage',
        semantic:{natural:true,source:'v255-preempt4S-reopen-4NT-final-diamond-choice',forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }


    // v2.54 — CONTINUATION DU 4SA DE REVEIL SUR 4H.
    // 4H-P-P-4SA promet les deux mineures : le partenaire choisit 5C/5D,
    // jamais la couleur du barrage ni une majeure inventee. Le bicoloreur accepte.
    if(key==='4H PASS PASS 4NT PASS' || key==='4H PASS PASS 4NT X'){
      const m=L.D>L.C?'D':L.C>L.D?'C':(suitHcp(ctx.deal,seat,'D')>suitHcp(ctx.deal,seat,'C')?'D':'C');
      if(legal(`5${m}`)) return {call:`5${m}`,changed:raw!==`5${m}`,reason:`4SA de reveil sur 4Coeur = deux mineures : choix de 5${m}`,
        semantic:{natural:true,source:'v254-preempt4H-reopen-4NT-choose-minor',forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }
    if(key==='4H PASS PASS 4NT PASS 5C PASS' || key==='4H PASS PASS 4NT PASS 5C X' ||
       key==='4H PASS PASS 4NT X 5C PASS' || key==='4H PASS PASS 4NT X 5C X'){
      if(L.C>=5 && legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA de reveil promettait les Trefles : 5Trefles choisi, contrat accepte',
        semantic:{natural:true,source:'v254-preempt4H-reopen-4NT-accept-clubs',suits:{C:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }
    if(key==='4H PASS PASS 4NT PASS 5D PASS' || key==='4H PASS PASS 4NT PASS 5D X' ||
       key==='4H PASS PASS 4NT X 5D PASS' || key==='4H PASS PASS 4NT X 5D X'){
      if(L.D>=5 && legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA de reveil promettait les Carreaux : 5Carreaux choisi, contrat accepte',
        semantic:{natural:true,source:'v254-preempt4H-reopen-4NT-accept-diamonds',suits:{D:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-reopening'}};
    }

    // Après la réponse artificielle 4SA (deux mineures) au Contre sur 3H,
    // le contreur doit choisir une mineure. PASS est structurellement impossible.
    if(key==='3H X PASS 4NT PASS'){
      const m=L.D>L.C?'D':L.C>L.D?'C':(suitHcp(ctx.deal,seat,'D')>suitHcp(ctx.deal,seat,'C')?'D':'C');
      if(legal(`5${m}`)) return {call:`5${m}`,changed:raw!==`5${m}`,reason:`4SA du partenaire montre les deux mineures : choix de 5${m}`,
        semantic:{natural:true,source:'v253-3H-X-P-4NT-doubler-choose-minor',suits:{[m]:{min:3,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-takeout-response-continuation'}};
    }

    // v2.53 — APRÈS 3H-X-P : réponses déterministes de la fiche Chailley.
    // C'est une zone très fréquente d'entraînement : v2.52 passait encore avec
    // des mains qui ont une réponse obligatoire, et ne connaissait pas 4SA mineur.
    if(key==='3H X PASS'){
      // 4SA positif, deux mineures : priorité avant les routes à SA/couleur.
      if(HL>=10 && HL<=15 && L.C>=4 && L.D>=4 && (L.C+L.D)>=9 && L.S<=3 && legal('4NT')){
        return {call:'4NT',changed:raw!=='4NT',reason:`Chailley : après 3Cœur-X-P, ${HL}HL avec au moins neuf cartes mineures => 4SA`,
          semantic:{natural:false,source:'v253-3H-X-P-4NT-minors',suits:{C:{min:4,max:13},D:{min:4,max:13}},points:{min:10,max:15},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt3-takeout-response'}};
      }
      // Manche à Pique dans la zone positive. On utilise HL comme filtre prudent ;
      // la fiche raisonne en HLD et exige quatre Piques ou plus.
      if(HL>=10 && HL<=15 && L.S>=4 && L.H<=3 && legal('4S')){
        return {call:'4S',changed:raw!=='4S',reason:`Chailley : réponse positive au Contre sur 3Cœur, ${L.S} Piques et ${HL}HL => 4Pique`,
          semantic:{natural:true,source:'v253-3H-X-P-4S-positive',suits:{S:{min:4,max:13}},points:{min:10,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-takeout-response'}};
      }
      if(HL>=9 && HL<=15 && strictBal && stop('H') && L.S<=3 && legal('3NT')){
        return {call:'3NT',changed:raw!=='3NT',reason:`Chailley : après 3Cœur-X-P, main régulière ${HL}HL avec arrêt Cœur => 3SA`,
          semantic:{natural:true,source:'v253-3H-X-P-3NT',points:{min:9,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-takeout-response'}};
      }
      if(HL<=9 && L.S>=3 && legal('3S')){
        return {call:'3S',changed:raw!=='3S',reason:`Chailley : réponse faible obligatoire au Contre sur 3Cœur, ${HL}HL et ${L.S} Piques => 3Pique`,
          semantic:{natural:true,source:'v253-3H-X-P-3S-weak',suits:{S:{min:3,max:13}},points:{min:0,max:9},forcing:'nonforcing',publishWhenNative:true,convention:'preempt3-takeout-response'}};
      }
    }

    // v2.53 — DÉFENSE CONTRE LES OUVERTURES DE 4H / 4S.
    // Référence : article Alain Lévy / Le Bridgeur reproduit par Chailley.
    // Les seuils ci-dessous sont volontairement plus stricts que le texte pour
    // privilégier la robustesse : à ce palier une surenchère erronée coûte cher.
    if(key==='4H' || key==='4S'){
      const om=key[1], other=om==='H'?'S':'H';
      const strong4Suit=(s,minLen=5)=>{
        const c=String(hand[s]||''); if(c.length<minLen) return false;
        const top=['A','K','Q'].filter(r=>c.includes(r)).length;
        const mid=['J','T','9'].filter(r=>c.includes(r)).length;
        return top===3 || (top>=2 && mid>=1);
      };
      const sideSuits=SUITS.filter(s=>s!==om && L[s]>=5 && strong4Suit(s));

      // 4SA : sur 4H, deux mineures ; sur 4S, bicolore indéterminé 5-5+.
      // Ne jamais publier au partenaire les deux couleurs réelles du bicolore
      // indéterminé sur 4S : ce serait une fuite d'information privée.
      if(HL>=14 && L[om]<=1 && playingTricksEstimate(ctx.deal,seat)>=8.5 && legal('4NT')){
        if(key==='4H' && L.C>=5 && L.D>=5 && strong4Suit('C') && strong4Suit('D')){
          return {call:'4NT',changed:raw!=='4NT',reason:'Alain Lévy/Chailley : 4SA sur 4Cœur = bicolore mineur 5-5+ fort',
            semantic:{natural:false,source:'v253-preempt4-4H-4NT-minors',suits:{C:{min:5,max:13},D:{min:5,max:13}},points:{min:14,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-4NT-bicolor'}};
        }
        if(key==='4S' && sideSuits.length>=2){
          return {call:'4NT',changed:raw!=='4NT',reason:'Alain Lévy/Chailley : 4SA sur 4Pique = bicolore indéterminé 5-5+ fort',
            semantic:{natural:false,source:'v253-preempt4-4S-4NT-unspecified-bicolor',points:{min:14,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-4NT-unspecified-bicolor'}};
        }
      }

      // Intervention naturelle : une seule couleur longue de très bonne qualité,
      // force d'ouverture. 4S reste disponible sur 4H ; les autres couleurs sont
      // nécessairement annoncées au palier de 5.
      const natural6=SUITS.filter(s=>s!==om && L[s]>=6 && strong4Suit(s,6) &&
        SUITS.every(t=>t===om||t===s||(L[t]||0)<=4));
      if(HL>=14 && HL<=22 && natural6.length===1){
        const s=natural6[0], target=(key==='4H'&&s==='S')?'4S':`5${s}`;
        if(legal(target)) return {call:target,changed:raw!==target,reason:`Alain Lévy/Chailley : intervention naturelle constructive sur ${key}, ${L[s]} ${s} de très bonne qualité`,
          semantic:{natural:true,source:'v253-preempt4-natural-overcall',suits:{[s]:{min:6,max:13}},points:{min:14,max:22},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-natural-overcall'}};
      }

      // Contre d'appel : bonne ouverture, courte dans la couleur du barrage,
      // quatre cartes dans l'autre majeure et environ trois levées défensives.
      // Les bicolores et unicolores clairs ont déjà été traités ci-dessus.
      if(HL>=14 && H>=13 && L[om]<=1 && L[other]>=4 && Math.max(...SUITS.filter(s=>s!==om).map(s=>L[s]))<=5 &&
         defensiveTricksEstimate(ctx.deal,seat)>=3 && legal('X')){
        return {call:'X',changed:raw!=='X',reason:`Alain Lévy/Chailley : Contre d'appel sur ${key}, courte ${om}, 4+ ${other} et ${defensiveTricksEstimate(ctx.deal,seat)} levées défensives estimées`,
          semantic:{natural:false,source:'v253-preempt4-takeout-double',suits:{[other]:{min:4,max:13},[om]:{min:0,max:1}},hcp:{min:14,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double'}};
      }
    }

    // v2.53 — RÉPONSES DÉTERMINISTES AU CONTRE DE 4M.
    // Alain Lévy : 5C/5D sont automatiques avec six cartes ; sur 4S, 5H peut
    // se faire avec cinq cartes. 4SA décrit un bicolore mineur sur 4H et un
    // bicolore indéterminé sur 4S. PASS reste parfaitement autorisé hors de ces
    // poches : on ne transforme donc pas le Contre en forcing artificiel.
    if(key==='4H X PASS'){
      if(L.C>=5 && L.D>=5 && legal('4NT')) return {call:'4NT',changed:raw!=='4NT',reason:'Alain Lévy : sur 4Cœur-X-P, 4SA = bicolore mineur',
        semantic:{natural:false,source:'v253-preempt4-X-4H-response-4NT-minors',suits:{C:{min:5,max:13},D:{min:5,max:13}},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
      if(L.C>=6 && L.D<=4 && legal('5C')) return {call:'5C',changed:raw!=='5C',reason:'Alain Lévy : six Trèfles en réponse au Contre de 4Cœur => 5Trèfle automatique',
        semantic:{natural:true,source:'v253-preempt4-X-4H-response-5C',suits:{C:{min:6,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
      if(L.D>=6 && L.C<=4 && legal('5D')) return {call:'5D',changed:raw!=='5D',reason:'Alain Lévy : six Carreaux en réponse au Contre de 4Cœur => 5Carreau automatique',
        semantic:{natural:true,source:'v253-preempt4-X-4H-response-5D',suits:{D:{min:6,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
    }
    if(key==='4S X PASS'){
      const longSide=['H','D','C'].filter(s=>L[s]>=5);
      if(longSide.length>=2 && legal('4NT')) return {call:'4NT',changed:raw!=='4NT',reason:'Alain Lévy : sur 4Pique-X-P, 4SA = bicolore indéterminé 5-5+',
        semantic:{natural:false,source:'v253-preempt4-X-4S-response-4NT-bicolor',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
      if(L.H>=5 && L.C<=4 && L.D<=4 && legal('5H')) return {call:'5H',changed:raw!=='5H',reason:'Alain Lévy : cinq Cœurs suffisent pour répondre 5Cœur au Contre de 4Pique',
        semantic:{natural:true,source:'v253-preempt4-X-4S-response-5H',suits:{H:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
      if(L.C>=6 && L.H<=4 && L.D<=4 && legal('5C')) return {call:'5C',changed:raw!=='5C',reason:'Alain Lévy : six Trèfles en réponse au Contre de 4Pique => 5Trèfle automatique',
        semantic:{natural:true,source:'v253-preempt4-X-4S-response-5C',suits:{C:{min:6,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
      if(L.D>=6 && L.H<=4 && L.C<=4 && legal('5D')) return {call:'5D',changed:raw!=='5D',reason:'Alain Lévy : six Carreaux en réponse au Contre de 4Pique => 5Carreau automatique',
        semantic:{natural:true,source:'v253-preempt4-X-4S-response-5D',suits:{D:{min:6,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
    }

    // v2.53 — RÉPONSES/CONTINUATIONS APRÈS LE CONTRE DE 4M.
    // Alain Lévy : ce Contre est d'appel mais le partenaire a le droit de passer.
    // 4SA du répondant montre les mineures sur 4H ; sur 4S il est volontairement
    // indéterminé et peut même servir de tremplin à un unicolore Cœur très fort.
    // Sur 4S-X-P-4SA, 5C est le relais économique : le répondant passe avec
    // Trèfle dans son bicolore, corrige à 5D avec Cœur-Carreau, ou à 5H lorsque
    // 4SA préparait la description d'un unicolore Cœur ambitieux.
    if(key==='4H X PASS 4NT PASS'){
      const m=L.D>L.C?'D':L.C>L.D?'C':(suitHcp(ctx.deal,seat,'D')>suitHcp(ctx.deal,seat,'C')?'D':'C');
      if(legal(`5${m}`)) return {call:`5${m}`,changed:raw!==`5${m}`,reason:`4SA après Contre de 4Cœur = bicolore mineur : choix de 5${m}`,
        semantic:{natural:true,source:'v253-preempt4-X-4H-4NT-choose-minor',suits:{[m]:{min:0,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
    }
    if(key==='4S X PASS 4NT PASS' && legal('5C')){
      return {call:'5C',changed:raw!=='5C',reason:'4SA après Contre de 4Pique : relais 5Trèfle pour laisser le répondant préciser son bicolore / unicolore fort',
        semantic:{natural:false,source:'v253-preempt4-X-4S-4NT-club-relay',forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
    }
    if(key==='4S X PASS 4NT PASS 5C PASS' || key==='4S X PASS 4NT PASS 5C X'){
      if(L.C>=5 && legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA sur Contre de 4Pique : Trèfle appartient au bicolore, 5Trèfle accepté',
        semantic:{natural:true,source:'v253-preempt4-X-4S-4NT-accept-clubs',suits:{C:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
      if(L.C<5 && L.D>=5 && L.H>=5 && legal('5D')) return {call:'5D',changed:raw!=='5D',reason:'4SA sur Contre de 4Pique : sans Trèfle, bicolore Cœur-Carreau => 5Carreau',
        semantic:{natural:true,source:'v253-preempt4-X-4S-4NT-heart-diamond',suits:{H:{min:5,max:13},D:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
      if(L.C<5 && L.D<5 && L.H>=5 && legal('5H')) return {call:'5H',changed:raw!=='5H',reason:'4SA sur Contre de 4Pique puis 5C : unicolore Cœur fort/ambitieux => 5Cœur',
        semantic:{natural:true,source:'v253-preempt4-X-4S-4NT-strong-hearts',suits:{H:{min:5,max:13}},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-takeout-double-response'}};
    }

    // v2.53 — CONTINUATIONS DE 4SA SUR 4M.
    // 4H-4SA montre précisément les deux mineures : le partenaire choisit.
    if(key==='4H 4NT PASS'){
      const m=L.D>L.C?'D':L.C>L.D?'C':(suitHcp(ctx.deal,seat,'D')>suitHcp(ctx.deal,seat,'C')?'D':'C');
      if(legal(`5${m}`)) return {call:`5${m}`,changed:raw!==`5${m}`,reason:`4SA sur 4Cœur = deux mineures : choix de 5${m}`,
        semantic:{natural:true,source:'v253-preempt4-4H-4NT-choose-minor',suits:{[m]:{min:0,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-4NT-bicolor-continuation'}};
    }

    // 4S-4SA montre un bicolore indéterminé parmi H/C/D. Le partenaire choisit
    // d'abord sa meilleure mineure ; l'intervenant passe si elle fait partie de
    // son bicolore, sinon il rectifie et révèle nécessairement l'autre structure.
    if(key==='4S 4NT PASS'){
      const target=(L.C<3 && L.H>=3)?'5D':'5C';
      if(legal(target)) return {call:target,changed:raw!==target,reason:target==='5D'?'Alain Levy : sur 4Pique-4SA, sans fit Trefle mais avec support Coeur => relais 5Carreau':'Alain Levy : sur 4Pique-4SA, 5Trefles conserve le pass-or-correct economique',
        semantic:{natural:false,source:'v255-preempt4-4S-4NT-pass-or-correct',forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-4NT-pass-or-correct'}};
    }
    if(key==='4S 4NT PASS 5C PASS' || key==='4S 4NT PASS 5C X'){
      if(L.C>=5 && legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA bicolore sur 4Pique : Trèfle appartient au bicolore, 5Trèfle accepté',
        semantic:{natural:true,source:'v253-preempt4-4S-4NT-accept-clubs',suits:{C:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-4NT-pass-or-correct'}};
      if(L.C<5 && L.D>=5 && L.H>=5 && legal('5D')) return {call:'5D',changed:raw!=='5D',reason:'4SA bicolore sur 4Pique : pas de Trèfle => bicolore Cœur-Carreau, rectification 5Carreau',
        semantic:{natural:true,source:'v253-preempt4-4S-4NT-reveal-heart-diamond',suits:{H:{min:5,max:13},D:{min:5,max:13}},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'preempt4-4NT-pass-or-correct'}};
    }
    if(key==='4S 4NT PASS 5D PASS' || key==='4S 4NT PASS 5D X'){
      if(L.D>=5 && legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'4SA bicolore sur 4Pique : Carreau appartient au bicolore, 5Carreau accepté',
        semantic:{natural:true,source:'v253-preempt4-4S-4NT-accept-diamonds',suits:{D:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-4NT-pass-or-correct'}};
      if(L.D<5 && L.C>=5 && L.H>=5 && legal('5H')) return {call:'5H',changed:raw!=='5H',reason:'4SA bicolore sur 4Pique : pas de Carreau => bicolore Cœur-Trèfle, rectification 5Cœur',
        semantic:{natural:true,source:'v253-preempt4-4S-4NT-reveal-heart-club',suits:{H:{min:5,max:13},C:{min:5,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-4NT-pass-or-correct'}};
    }
    // Après 5C-5D, l'intervenant a révélé Cœur+Carreau. Le partenaire ne
    // remonte à 5H que si le fit Cœur est clairement meilleur que le fit Carreau.
    if(key==='4S 4NT PASS 5C PASS 5D PASS'){
      if(L.H>=3 && L.D<=2 && legal('5H')) return {call:'5H',changed:raw!=='5H',reason:'Bicolore Cœur-Carreau révélé : fit Cœur 8e contre Carreau court => 5Cœur',
        semantic:{natural:true,source:'v253-preempt4-4S-4NT-final-heart-choice',suits:{H:{min:3,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-4NT-pass-or-correct'}};
      if(legal('PASS')) return {call:'PASS',changed:raw!=='PASS',reason:'Bicolore Cœur-Carreau révélé : 5Carreau reste le meilleur contrat disponible',
        semantic:{natural:true,source:'v253-preempt4-4S-4NT-final-diamond-choice',forcing:'nonforcing',publishWhenNative:true,convention:'preempt4-4NT-pass-or-correct'}};
    }

    // v2.51 — Défense contre les ouvertures de 2 faible, mise à jour Chailley/SEF 2024.
    // 1) 2SA direct reste naturel : main régulière 16-18HL avec arrêt. Pour éviter
    //    d'écraser un Contre d'appel évident, cette réparation haute confiance est
    //    limitée aux mains sans quatre cartes dans l'autre majeure.
    if((key==='2H'||key==='2S') && HL>=16 && HL<=18 && strictBal){
      const om=key==='2H'?'H':'S', other=om==='H'?'S':'H';
      if(L[other]<=3 && stop(om) && legal('2NT')) return {
        call:'2NT',changed:raw!=='2NT',
        reason:`Chailley/SEF 2024 : 2SA naturel sur ${key}, 16-18HL réguliers avec arrêt`,
        semantic:{natural:true,source:'v251-weak2-direct-2NT',points:{min:16,max:18},forcing:'nonforcing',publishWhenNative:true,convention:'sef2024-defense-weak2'}
      };
    }

    // 2) Après 2M-X-P, 2SA est le mini-cue-bid forcing. Il couvre toute la zone
    //    moyenne 8-10HL, quelle que soit la distribution. Le SEF 2024 y fait aussi
    //    transiter les mains 11+HL avec au moins quatre cartes dans l'autre majeure.
    if(key==='2H X PASS'||key==='2S X PASS'){
      const om=key[1], other=om==='H'?'S':'H';
      const medium=HL>=8&&HL<=10, strongOther=HL>=11&&L[other]===4;
      if((medium||strongOther) && legal('2NT')) return {
        call:'2NT',changed:raw!=='2NT',
        reason:medium
          ? `Chailley/SEF 2024 : ${HL} HL après 2${om}-X-P => mini-cue-bid 2SA forcing`
          : `Chailley/SEF 2024 : ${HL} HL et exactement 4 cartes ${other} => 2SA mini-cue-bid avant de préciser la majeure`,
        semantic:{natural:false,source:medium?'v251-weak2-minicue-8-10':'v251-weak2-minicue-strong-other-major',
          suits:strongOther?{[other]:{min:4,max:13}}:{},points:{min:medium?8:11,max:medium?10:37},
          forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'sef2024-weak2-mini-cuebid'}
      };
    }

    // Takeout doubles and reopening doubles in clean shapes.
    // Sur une ouverture mineure, le standard pratique demande surtout la courte
    // dans la mineure et au moins sept cartes majeures, pas obligatoirement 4-4.
    // Important : cet overlay ne doit jamais écraser une convention bicolore
    // déjà reconnue nativement (ex. 2SA Michaël). Il ne répare que Passe/X/1SA.
    const takeoutOverlayEligible=!(key==='1D'&&raw==='2NT'&&L.C>=5&&L.H>=5);
    if(takeoutOverlayEligible&&key==='1C'&&H>=13&&H<=17&&L.C<=2&&L.H>=3&&L.S>=3&&(L.H+L.S)>=7)return out('X','SEF : Contre d’appel sur 1Trèfle, courte et au moins sept cartes majeures','takeout-double');
    if(takeoutOverlayEligible&&key==='1D'&&H>=13&&H<=17&&L.D<=2&&L.H>=3&&L.S>=3&&(L.H+L.S)>=7)return out('X','SEF : Contre d’appel sur 1Carreau, courte et au moins sept cartes majeures','takeout-double');
    if(takeoutOverlayEligible&&key==='1H'&&H>=13&&H<=17&&L.H<=2&&L.S>=4&&L.C>=3&&L.D>=3)return out('X','SEF : Contre d’appel sur 1Cœur','takeout-double');
    if(takeoutOverlayEligible&&key==='1S'&&H>=13&&H<=17&&L.S<=2&&L.H>=4&&L.C>=3&&L.D>=3)return out('X','SEF : Contre d’appel sur 1Pique','takeout-double');
    if(key==='2H'&&H>=14&&H<=19&&L.H<=2&&L.S>=4&&L.C>=3&&L.D>=3)return out('X','SEF : Contre d’appel sur 2Cœur faible','preempt-reopening');
    if(key==='2S'&&H>=14&&H<=19&&L.S<=2&&L.H>=4&&L.C>=3&&L.D>=3)return out('X','SEF : Contre d’appel sur 2Pique faible','preempt-reopening');
    if(key==='1H PASS PASS'&&H>=8&&H<=14&&L.H<=2&&L.S>=4&&L.C>=3&&L.D>=3)return out('X','SEF : Contre de réveil sur 1Cœur','preempt-reopening');
    if(key==='1S PASS PASS'&&H>=8&&H<=14&&L.S<=2&&L.H>=4&&L.C>=3&&L.D>=3)return out('X','SEF : Contre de réveil sur 1Pique','preempt-reopening');

    // Intervention directe à 1SA : 16-18H, main régulière et arrêt sérieux.
    // Le noyau v2.45 pouvait encore annoncer 1SA avec 15H. Les alternatives
    // naturelles, Michaël ou Contre d'appel ont déjà été traitées ci-dessus ;
    // s'il n'en reste aucune, 15H réguliers ne justifient pas de forcer 1SA.
    if(['1C','1D','1H','1S'].includes(key) && raw==='1NT' && H<16 && legal('PASS'))
      return {call:'PASS',changed:true,reason:`SEF pratique : intervention à 1SA insuffisante avec ${H}H (zone 16-18H)`,semantic:{natural:true,source:'v246-1nt-overcall-range-veto',forcing:'nonforcing',publishWhenNative:true,convention:'1nt-overcall'}};

    // v2.46 — PERFORMANCE COMPETITIVE BAS PALIER.
    // Réponses au Contre d'appel et à l'intervention naturelle : zones très
    // fréquentes contre des humains, codées ici uniquement lorsque la décision
    // standard est suffisamment déterministe.

    const takeoutResponse=(opening)=>{
      const ob=opening.slice(1), cue=`2${ob}`;
      const availableMajors=ob==='H'?['S']:ob==='S'?['H']:['H','S'];
      const majors=availableMajors.filter(m=>(L[m]||0)>=4).sort((a,b)=>(L[b]-L[a])||(a==='S'?-1:1));
      const best=majors[0]||null, n=best?L[best]:0;
      // Main forte : manche directe si une majeure 5e rend le contrat évident ;
      // avec seulement quatre cartes, cue-bid forcing pour préciser la manche.
      if((H>=12||HL>=13) && best && n>=5 && legal(`4${best}`))
        return {call:`4${best}`,changed:raw!==`4${best}`,reason:`SEF : réponse forte au Contre, majeure ${best} 5e+ => manche directe`,semantic:{natural:true,source:'v246-takeout-response-strong-game',suits:{[best]:{min:5,max:13}},points:{min:12,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'takeout-double-response'}};
      if((H>=12||HL>=13) && legal(cue))
        return {call:cue,changed:raw!==cue,reason:'SEF : main forte en réponse au Contre sans manche encore déterminée => cue-bid forcing',semantic:{natural:false,source:'v246-takeout-response-strong-cuebid',points:{min:12,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'takeout-double-response'}};
      // Zone moyenne : saut avec 4 cartes, double saut avec 5+.
      if(H>=8 && HL<=11 && best){
        const target=n>=5?`3${best}`:`2${best}`;
        if(legal(target)) return {call:target,changed:raw!==target,reason:`SEF : 8-11HL en réponse au Contre, ${n} cartes ${best} => ${target}`,semantic:{natural:true,source:'v246-takeout-response-medium',suits:{[best]:{min:n>=5?5:4,max:13}},points:{min:8,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'takeout-double-response'}};
      }
      // Zone faible : réponse obligatoire au palier minimum dans une couleur.
      if(H<=7 && HL<=8 && best){
        let target=null;
        if(opening==='1H'&&best==='S') target='1S';
        else if(opening==='1S'&&best==='H') target='2H';
        else target=`1${best}`;
        if(legal(target)) return {call:target,changed:raw!==target,reason:`SEF : réponse obligatoire faible au Contre, ${best} au palier minimum`,semantic:{natural:true,source:'v246-takeout-response-weak',suits:{[best]:{min:4,max:13}},points:{min:0,max:8},forcing:'nonforcing',publishWhenNative:true,convention:'takeout-double-response'}};
      }
      // 1SA dans la poche équilibrée moyenne, surtout utile après ouverture majeure.
      if(H>=8 && H<=10 && strictBal && stop(ob) && legal('1NT'))
        return {call:'1NT',changed:raw!=='1NT',reason:`SEF : 1SA en réponse au Contre avec 8-10H et arrêt ${ob}`,semantic:{natural:true,source:'v246-takeout-response-1NT',hcp:{min:8,max:10},forcing:'nonforcing',publishWhenNative:true,convention:'takeout-double-response'}};
      return null;
    };
    if(['1C X PASS','1D X PASS','1H X PASS','1S X PASS'].includes(key)){
      const tr=takeoutResponse(key.slice(0,2)); if(tr) return tr;
    }

    // Réponse à une intervention naturelle de 1H/1S du partenaire sur 1m,
    // après Passe du répondant. Le soutien faible est compétitif : 0-7HLD passe ;
    // 8-12HLD suit le nombre d'atouts ET la forme ; 13-16HLD passe par le
    // cue-bid, tandis que 17HLD+ peut conclure directement à la manche.
    if(['1C 1H PASS','1D 1H PASS','1C 1S PASS','1D 1S PASS'].includes(key)){
      const parts=key.split(' '), om=parts[0].slice(1), m=parts[1].slice(1), fit=L[m], hld=supportHld(ctx.deal,seat,m);
      const supportIrregular=SUITS.some(s=>s!==m&&(L[s]||0)<=1);
      if(fit>=3 && hld<=7 && legal('PASS'))
        return {call:'PASS',changed:raw!=='PASS',reason:`SEF pratique : soutien trop faible (${hld} HLD) après intervention => Passe`,semantic:{natural:true,source:'v246-advancer-weak-fit-pass',suits:{[m]:{min:3,max:13}},points:{min:0,max:7},forcing:'nonforcing',publishWhenNative:true,convention:'advancer-after-overcall'}};
      if(fit>=3 && hld>=17 && legal(`4${m}`))
        return {call:`4${m}`,changed:raw!==`4${m}`,reason:`SEF : jeu fort ${hld} HLD et fit ${m} => manche directe`,semantic:{natural:true,source:'v246-advancer-very-strong-fit-game',suits:{[m]:{min:3,max:13}},points:{min:17,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'advancer-after-overcall'}};
      if(fit>=3 && hld>=13 && hld<=16 && legal(`2${om}`))
        return {call:`2${om}`,changed:raw!==`2${om}`,reason:`SEF : cue-bid fort après intervention, fit ${m} et ${hld} HLD`,semantic:{natural:false,source:'v246-advancer-strong-fit-cuebid',suits:{[m]:{min:3,max:13}},points:{min:13,max:16},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'advancer-after-overcall'}};
      if(fit>=3 && hld>=8 && hld<=12){
        let target=`2${m}`;
        if(fit===4 && supportIrregular) target=`3${m}`;
        else if(fit>=5) target=supportIrregular?`4${m}`:`3${m}`;
        if(legal(target)) return {call:target,changed:raw!==target,reason:`SEF/Loi des atouts : ${fit} atouts, ${hld} HLD, main ${supportIrregular?'irrégulière':'régulière'} => ${target}`,semantic:{natural:true,source:'v246-advancer-competitive-fit',suits:{[m]:{min:fit,max:fit}},points:{min:8,max:12},forcing:'nonforcing',publishWhenNative:true,convention:'advancer-after-overcall'}};
      }
      // Sans fit immédiat : changement de couleur forcing. 1 sur 1 = 4 cartes
      // et 9HL+ ; 2 sur 1 = 5 cartes et 11-12HL+ selon la fiche SEF/Chailley.
      if(m==='H' && fit<=2 && L.S>=4 && HL>=9 && legal('1S'))
        return {call:'1S',changed:raw!=='1S',reason:'SEF : nouvelle couleur 1P en réponse à 1Cœur, 9HL+ et 4+ cartes, forcing',semantic:{natural:true,source:'v246-advancer-new-spades',suits:{S:{min:4,max:13}},points:{min:9,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'advancer-after-overcall'}};
      if(m==='S' && fit<=2 && L.H>=5 && HL>=11 && legal('2H'))
        return {call:'2H',changed:raw!=='2H',reason:'SEF : nouvelle couleur 2Cœur en réponse à 1Pique, 11HL+ et 5+ cartes, forcing',semantic:{natural:true,source:'v246-advancer-new-hearts',suits:{H:{min:5,max:13}},points:{min:11,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'advancer-after-overcall'}};
      // Main forte sans enchère naturelle descriptive évidente : cue-bid interrogatif.
      if(fit<=2 && HL>=13 && legal(`2${om}`))
        return {call:`2${om}`,changed:raw!==`2${om}`,reason:'SEF : 13HL+ sans fit immédiat ni meilleure couleur => cue-bid pour connaître la force de l’intervenant',semantic:{natural:false,source:'v246-advancer-strong-no-fit-cuebid',points:{min:13,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'advancer-after-overcall'}};
    }

    // v2.47 — PARTSCORE BATTLE : quand les deux camps se sont fittés,
    // l'advancer ne doit pas abandonner mécaniquement la partielle. On applique
    // la Loi des atouts avec une correction de vulnérabilité : 8 atouts connus
    // permettent de jouer au palier de 2 ; 9+ atouts autorisent le palier de 3,
    // surtout avec une main irrégulière. Rouge contre vert, on rabaisse d'un cran.
    if(['1C 1H 2C','1D 1H 2D','1C 1S 2C','1D 1S 2D','1H 1S 2H'].includes(key)){
      const parts=key.split(' '), om=parts[0].slice(1), m=parts[1].slice(1), fit=L[m]||0, val=supportHld(ctx.deal,seat,m);
      const supportIrregular=SUITS.some(s=>s!==m&&(L[s]||0)<=1);
      const badVul=ourVul&&!oppVul;
      if(fit>=3 && val>=6 && val<=12){
        // Rouge contre vert : avec seulement huit atouts connus, la loi donne le
        // palier de 2 mais la correction de vulnérabilité conseille de descendre
        // d'un cran ; comme ce cran n'est plus disponible, on passe sauf vraie
        // valeur constructive. Avec neuf atouts ou plus, 2M reste la sécurité.
        if(badVul && fit===3 && val<=8 && legal('PASS'))
          return {call:'PASS',changed:raw!=='PASS',reason:`v2.47/Loi des atouts : seulement 8 atouts connus et vulnérabilité défavorable, ${val} HLD => prudence/Passe`,semantic:{natural:true,source:'v247-partscore-advancer-vul-pass',suits:{[m]:{min:3,max:3}},points:{min:6,max:8},forcing:'nonforcing',publishWhenNative:true,convention:'partscore-battle'}};
        let target=`2${m}`;
        if(fit>=4 && !badVul && (fit>=5 || supportIrregular || val>=9)) target=`3${m}`;
        if(legal(target)) return {call:target,changed:raw!==target,reason:`v2.47/Loi des atouts : adversaires fittés, ${fit} atouts chez l'advancer (${5+fit} connus au minimum), ${val} HLD, vulnérabilité ${badVul?'défavorable':'non défavorable'} => ${target}`,semantic:{natural:true,source:'v247-partscore-advancer-law',suits:{[m]:{min:fit,max:fit}},points:{min:6,max:12},forcing:'nonforcing',publishWhenNative:true,convention:'partscore-battle'}};
      }
    }

    // v2.47 — Recontre (responsive double) après 1x-X-2x. Le soutien de la
    // couleur d'ouverture transforme le Contre du n°4 en appel dans les couleurs
    // restantes. On le réserve aux mains réellement bicolores, pour ne pas écraser
    // une couleur naturelle cinquième évidente.
    if(['1C X 2C','1D X 2D','1H X 2H','1S X 2S'].includes(key)){
      const om=key[1], wanted=(om==='C'||om==='D')?['H','S']:['C','D'];
      const a=L[wanted[0]]||0, b=L[wanted[1]]||0;
      // Avec une vraie couleur 6e, priorité à l'enchère naturelle plutôt qu'au
      // recontre : elle décrit mieux la main et évite de demander inutilement au
      // partenaire de choisir.
      const natural=wanted.filter(x=>(L[x]||0)>=6).sort((x,y)=>(L[y]||0)-(L[x]||0))[0];
      if(natural && H>=7 && H<=11){
        const target=cheapestSuitCallAfter(history,natural);
        if(target&&legal(target)) return {call:target,changed:raw!==target,reason:`v2.47 : couleur ${natural} 6e naturelle prioritaire au recontre`,semantic:{natural:true,source:'v247-responsive-natural-six',suits:{[natural]:{min:6,max:13}},hcp:{min:7,max:11},forcing:'nonforcing',publishWhenNative:true,convention:'responsive-double'}};
      }
      if(H>=7 && H<=11 && a>=4 && b>=4 && Math.max(a,b)<=5 && legal('X'))
        return {call:'X',changed:raw!=='X',reason:`v2.47 : recontre d'appel après soutien adverse, ${a}-${b} dans ${wanted.join('/')}`,semantic:{natural:false,source:'v247-responsive-double',suits:{[wanted[0]]:{min:4,max:5},[wanted[1]]:{min:4,max:5}},hcp:{min:7,max:11},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'responsive-double'}};
    }

    // v2.47 — Réveil après un fit majeur adverse simple. En paires, laisser
    // 2M jouer tranquillement vaut souvent -110. Priorité toutefois à une vraie
    // couleur 5e : le Contre est réservé à la forme d'appel sans meilleure
    // enchère naturelle. Rouge contre vert, on exige deux points de plus.
    if(key==='1H PASS 2H PASS PASS' || key==='1S PASS 2S PASS PASS'){
      const m=key[1], other=m==='H'?'S':'H', minH=(ourVul&&!oppVul)?10:8;
      if(H>=minH && H<=13 && (L[m]||0)<=1){
        const natural=[other,'D','C'].filter(x=>(L[x]||0)>=5).sort((x,y)=>(L[y]||0)-(L[x]||0))[0];
        if(natural){
          const target=cheapestSuitCallAfter(history,natural);
          if(target&&legal(target)) return {call:target,changed:raw!==target,reason:`v2.47 : réveil naturel prioritaire avec ${L[natural]} cartes à ${natural}`,semantic:{natural:true,source:'v247-natural-reopening-after-fit',suits:{[natural]:{min:5,max:13}},hcp:{min:minH,max:13},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-after-fit'}};
        }
        if((L[other]||0)>=3 && (L.C||0)>=3 && (L.D||0)>=3 && legal('X'))
          return {call:'X',changed:raw!=='X',reason:`v2.47 : contre de réveil après fit ${m} adverse, courte ${m}, ${H} H${minH===10?' (prudence rouge/vert)':''}`,semantic:{natural:false,source:'v247-reopening-double-after-fit',suits:{[m]:{min:0,max:1},[other]:{min:3,max:13},C:{min:3,max:13},D:{min:3,max:13}},hcp:{min:minH,max:13},forcing:'unknown',publishWhenNative:true,convention:'reopening-double'}};
      }
    }

    // Réponse au Contre de réveil après fit adverse : le contreur peut avoir
    // environ quatre points de moins qu'en direct, donc le partenaire doit être
    // quatre points plus fort pour produire les mêmes ambitions. Jusqu'à 15 H,
    // on recherche d'abord la meilleure partielle ; sans couleur 4e nette, 2SA
    // scramble garde de l'espace et demande au contreur de choisir.
    if(key==='1H PASS 2H PASS PASS X PASS' || key==='1S PASS 2S PASS PASS X PASS'){
      const m=key[1], other=m==='H'?'S':'H';
      const choices=[other,'D','C'].filter(x=>(L[x]||0)>=4).sort((x,y)=>((L[y]||0)-(L[x]||0)) || ((x===other?-1:0)-(y===other?-1:0)));
      if(H<=15 && choices.length){
        const target=cheapestSuitCallAfter(history,choices[0]);
        if(target&&legal(target)) return {call:target,changed:raw!==target,reason:`v2.47 : réponse mesurée au Contre de réveil, priorité à ${target} (${H} H)`,semantic:{natural:true,source:'v247-response-to-reopening-double',suits:{[choices[0]]:{min:4,max:13}},hcp:{min:0,max:15},forcing:'nonforcing',publishWhenNative:true,convention:'reopening-double-response'}};
      }
      if(H<=15 && legal('2NT')) return {call:'2NT',changed:raw!=='2NT',reason:'v2.47 : 2SA scramble après Contre de réveil, aucune couleur 4e évidente',semantic:{natural:false,source:'v247-scramble-2nt-after-reopening-double',hcp:{min:0,max:15},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'scramble-2nt'}};
      if(H>=16 && legal(`3${m}`)) return {call:`3${m}`,changed:raw!==`3${m}`,reason:`v2.47 : réponse forte au Contre de réveil, cue-bid ${3}${m}`,semantic:{natural:false,source:'v247-strong-response-to-reopening-double',hcp:{min:16,max:37},forcing:'one_round_if_uncontested',publishWhenNative:true,convention:'reopening-double-response'}};
    }

    // v2.50 — HIGH-LEVEL COMPETITIVE DECISIONS.
    // Une fois les deux camps fittés et la compétition montée au palier de 3/4,
    // on ne prolonge plus mécaniquement. Chailley/Vernes : le palier de sécurité
    // dépend du nombre d'atouts connus, corrigé d'un cran par la vulnérabilité.
    // Si aucun contrat propre n'est encore permis mais que notre camp est
    // clairement majoritaire en points, le Contre final au palier 3/4 est punitif.
    const v250HighCompetitive=(trump,partnerSupportMin,majorityH,maxCap=4,passExcluded=false)=>{
      const known=(L[trump]||0)+partnerSupportMin;
      let allowed=known>=11?5:(known>=10?4:(known>=9?3:2));
      if(ourVul&&!oppVul) allowed--;
      else if(!ourVul&&oppVul) allowed++;
      allowed=Math.max(2,Math.min(maxCap,allowed));
      // Lorsque plusieurs paliers restent légaux, on va directement au palier
      // distributionnel permis : c'est précisément le rôle préemptif de la Loi.
      for(let lev=allowed;lev>=2;lev--){
        const target=`${lev}${trump}`;
        if(legal(target)) return {call:target,changed:raw!==target,
          reason:`v2.50/Chailley-Vernes : ${known} atouts connus, vulnérabilité ${ourVul&&!oppVul?'défavorable':(!ourVul&&oppVul?'favorable':'égale')} => niveau de sécurité ${allowed}, surenchère ${target}`,
          semantic:{natural:true,source:'v250-high-level-law-compete',suits:{[trump]:{min:L[trump]||0,max:13}},forcing:'nonforcing',publishWhenNative:true,convention:'high-level-competitive'}};
      }
      if((passExcluded||H>=majorityH) && legal('X')){
        const lb=lastActualBid(history), b=parseBid(lb?.call);
        return {call:'X',changed:raw!=='X',
          reason:passExcluded
            ? `v2.50/Chailley : le soutien direct à 4${trump} était attaque-défense ; sur la surenchère adverse, Passe exclu => Contre punitif`
            : `v2.50/Chailley : camp clairement majoritaire, aucun palier sûr dans ${trump} ; Contre final punitif au palier ${b?.level||3}`,
          semantic:{natural:false,source:'v250-high-level-penalty-double',hcp:passExcluded?undefined:{min:majorityH,max:37},forcing:'nonforcing',publishWhenNative:true,convention:'high-level-competitive-penalty'}};
      }
      if(legal('PASS')) return {call:'PASS',changed:raw!=='PASS',
        reason:`v2.50/Chailley-Vernes : palier distributionnel atteint/dépassé sans majorité nette => Passe`,
        semantic:{natural:true,source:'v250-high-level-disciplined-pass',forcing:'nonforcing',publishWhenNative:true,convention:'high-level-competitive'}};
      return null;
    };

    // Ouvreur après soutien simple puis surenchère adverse au palier de 3.
    // 2M promet au moins trois atouts ; avec 16H+ chez l'ouvreur et le minimum
    // usuel du soutien, la ligne est assez nettement majoritaire pour préférer X
    // à un sacrifice hors Loi lorsque notre propre palier n'est plus disponible.
    if(key==='1H 1S 2H 3S'){
      const z=v250HighCompetitive('H',3,16); if(z) return z;
    }
    if(key==='1S 2H 2S 3H'){
      const z=v250HighCompetitive('S',3,16); if(z) return z;
    }

    // Soutien direct à 3M après intervention : la fiche Chailley donne 4 atouts
    // et 11-12 HLD (enchère limite, pas un barrage). L'ouvreur connaît donc au
    // moins neuf atouts, dix avec une majeure sixième.
    if(key==='1H 1S 3H 3S'){
      const z=v250HighCompetitive('H',4,15); if(z) return z;
    }
    if(key==='1S 2H 3S 4H'){
      const z=v250HighCompetitive('S',4,15); if(z) return z;
    }

    // Soutien direct à 4M après intervention : la fiche Chailley le décrit comme
    // attaque-défense, 5 atouts (parfois 4), maximum 9H et très peu de défense.
    // Si les adversaires surenchérissent, le partenaire doit choisir X ou une
    // nouvelle surenchère ; Passe est explicitement exclu. Onze atouts autorisent
    // le palier de 5, dix seulement si la vulnérabilité est favorable.
    if(key==='1H 1S 4H 4S'){
      const z=v250HighCompetitive('H',4,99,5,true); if(z) return z;
    }
    if(key==='1S 2H 4S 5H'){
      const z=v250HighCompetitive('S',4,99,5,true); if(z) return z;
    }

    // Le répondant a soutenu à 2M, l'ouvreur a déjà poussé à 3M et les adversaires
    // poussent encore. Le répondant ne devine pas une sixième carte chez l'ouvreur :
    // il travaille avec les cinq cartes promises. Avec 10H+, l'ouverture minimale
    // garantit déjà environ 22H dans la ligne : à défaut de surenchère légitime,
    // le Contre devient punitif plutôt qu'un nouveau saut aventureux.
    if(key==='1H 1S 2H 2S 3H 3S'){
      const z=v250HighCompetitive('H',5,10); if(z) return z;
    }
    if(key==='1S 2H 2S 3H 3S 4H'){
      const z=v250HighCompetitive('S',5,10); if(z) return z;
    }

    // Après un X punitif v2.50, le partenaire qui a déjà montré son fit ne
    // transforme pas soudain ce Contre en invitation à 3SA. Chailley précise qu'au
    // terme d'une compétition au palier 3/4 le Contre est punitif. Dans ces cadres
    // limités, le partenaire respecte donc la décision de défense.
    if([
      '1H 1S 2H 3S X PASS','1S 2H 2S 3H X PASS',
      '1H 1S 3H 3S X PASS','1S 2H 3S 4H X PASS',
      '1H 1S 2H 2S 3H 3S X PASS','1S 2H 2S 3H 3S 4H X PASS',
      '1H 1S 4H 4S X PASS','1S 2H 4S 5H X PASS'
    ].includes(key) && legal('PASS')){
      return {call:'PASS',changed:raw!=='PASS',
        reason:'v2.50/Chailley : le Contre de fin de compétition est punitif ; le partenaire fitté le laisse',
        semantic:{natural:true,source:'v250-partner-leaves-penalty-double',forcing:'nonforcing',publishWhenNative:true,convention:'high-level-competitive-penalty'}};
    }

    // Si le joueur faible a passé sur la dernière surenchère, la main forte peut
    // récupérer la parole après deux Passes. On réapplique alors la même décision
    // Loi des atouts / vulnérabilité / X punitif au lieu de laisser les adversaires
    // voler le contrat simplement parce que le partenaire limité n'a pas agi.
    if(key==='1H 1S 2H 2S 3H 3S PASS PASS'){
      const z=v250HighCompetitive('H',3,16); if(z) return z;
    }
    if(key==='1S 2H 2S 3H 3S 4H PASS PASS'){
      const z=v250HighCompetitive('S',3,16); if(z) return z;
    }

    // Advancer after partner's 1H overcall over 1C.
    if(key==='1C 1H PASS'){
      if(H>=12&&H<=15&&L.H>=3)return out('2C','SEF : cue-bid fort de l’advancer avec fit','advancer');
      if(H>=8&&H<=10&&L.H>=3&&maxLen<=5)return out('2H','SEF : soutien simple de l’intervention','advancer');
      if(H>=8&&H<=11&&L.S>=5&&L.H<=2)return out('1S','SEF : nouvelle couleur naturelle de l’advancer','advancer');
      if(H>=8&&H<=11&&strictBal&&L.H<=2&&stop('C'))return out('1NT','SEF : 1SA avec arrêt Trèfle','advancer');
    }

    // 2NT responses: Stayman, Texas, natural game.
    if(key==='2NT PASS'){
      if(H>=4&&H<=10&&((L.H===4&&L.S<=4)||(L.S===4&&L.H<=4)))return out('3C','SEF : Stayman sur 2SA','2nt-response');
      if(L.H>=5&&L.S<=4&&H<=10)return out('3D','SEF : Texas Cœur sur 2SA','2nt-response');
      if(L.S>=5&&L.H<=4&&H<=10)return out('3H','SEF : Texas Pique sur 2SA','2nt-response');
      if(H>=4&&H<=9&&strictBal&&L.H<=3&&L.S<=3)return out('3NT','SEF : conclusion 3SA sur 2SA','2nt-response');
    }

    // Stayman follow-ups including misère dorée and the SEF 2012 slam trigger.
    if(key==='1NT PASS 2C PASS 2D PASS'){
      if(H>=8&&H<=9&&L.H===5&&L.S===4)return out('2H','SEF : misère dorée avec cinq Cœurs et quatre Piques','stayman-followup');
      if(H>=8&&H<=9&&L.S===5&&L.H===4)return out('2S','SEF : misère dorée avec cinq Piques et quatre Cœurs','stayman-followup');
      if(H>=8&&H<=9&&strictBal&&(L.H===4||L.S===4)&&Math.max(L.H,L.S)<=4)return out('2NT','SEF : Stayman sans fit, proposition 2SA','stayman-followup');
      if(H>=10&&H<=14&&strictBal&&(L.H===4||L.S===4)&&Math.max(L.H,L.S)<=4)return out('3NT','SEF : Stayman sans fit, manche 3SA','stayman-followup');
    }
    if(key==='1NT PASS 2C PASS 2H PASS'&&H>=15&&H<=19&&L.H>=4)return out('3S','SEF Convention 2012 : autre majeure = fit Cœur, ambition de chelem','stayman-followup');
    if(key==='1NT PASS 2C PASS 2S PASS'&&H>=15&&H<=19&&L.S>=4)return out('3H','SEF Convention 2012 : autre majeure = fit Pique, ambition de chelem','stayman-followup');

    // Responder second-bid structures.
    if(key==='1C PASS 1H PASS 1S PASS'){
      if(H>=11&&H<=15&&L.H>=5&&L.S<=3&&L.C<=3)return out('2D','SEF : quatrième couleur forcing','responder-second-bid');
      if(H>=6&&H<=10&&L.H>=4&&L.C>=3&&L.S<=3)return out('2C','SEF : préférence Trèfle','responder-second-bid');
    }
    if(key==='1D PASS 1S PASS 2C PASS'){
      if(H>=11&&H<=15&&L.S>=5&&L.H<=3&&L.D<=3)return out('2H','SEF : quatrième couleur forcing','responder-second-bid');
      if(H>=6&&H<=10&&L.S>=4&&L.D>=3&&L.C<=3)return out('2D','SEF : préférence Carreau','responder-second-bid');
    }
    if(key==='1C PASS 1H PASS 2C PASS'&&H>=10&&H<=14&&L.H>=5&&L.D>=4)return out('2D','SEF : troisième couleur forcing','responder-second-bid');
    if(key==='1D PASS 1S PASS 2D PASS'&&H>=10&&H<=14&&L.S>=5&&L.H>=4)return out('2H','SEF : troisième couleur forcing','responder-second-bid');
    if(key==='1C PASS 1H PASS 2D PASS'&&H>=6&&H<=9&&L.H>=4&&L.C<=3&&L.D<=3)return out('2NT','SEF : 2SA coup de frein après bicolore cher','responder-second-bid');

    // Drury and its SEF 2024 opener developments.
    if(passedBeforeOpening&&(key==='1S PASS'||key==='1H PASS')&&H>=10&&H<=12){const m=key.startsWith('1S')?'S':'H';if(L[m]>=3&&maxLen<=5)return out('2C','SEF 2024 : Drury fitté après Passe','drury');}
    if(partnerPassedBeforeOpening&&key==='1S PASS 2C PASS'){
      if(H>=10&&H<=12&&L.S>=5)return out('2S','SEF 2024 : retour 2P = ouverture faible','drury-development');
      if(H>=13&&H<=14&&L.S>=5&&L.C<=4&&L.D<=4)return out('2D','SEF 2024 : 2Carreau constructif après Drury','drury-development');
    }

    // Responder after transfer completion: 5-card suits choose NT, 6+ choose the major.
    const tx=(key==='1NT PASS 2D PASS 2H PASS')?'H':(key==='1NT PASS 2H PASS 2S PASS')?'S':null;
    if(tx){
      const n=L[tx]||0;
      if(n===5){ if(H<=7)return out('PASS','SEF : arrêt après Texas avec main faible','texas-followup'); if(H<=9)return out('2NT','SEF : proposition à 2SA après Texas, majeure cinquième','texas-followup'); if(H<=14)return out('3NT','SEF : manche à 3SA après Texas, majeure cinquième','texas-followup'); }
      if(n>=6){ if(H<=7)return out('PASS','SEF : arrêt après Texas avec longue majeure faible','texas-followup'); if(H<=9)return out(`3${tx}`,'SEF : proposition dans la majeure sixième après Texas','texas-followup'); if(H<=14)return out(`4${tx}`,'SEF : manche dans la majeure sixième après Texas','texas-followup'); }
    }

    // A one-over-one sequence is forcing for the responder's second turn.
    if(key==='1C PASS 1H PASS 1S PASS' && H>=6&&H<=9 && strictBal && L.H>=4&&L.S<=3)
      return out('1NT','SEF : le 1 sur 1 est forcing, seconde enchère régulière minimum à 1SA','forcing-check');
    if(key==='1C PASS 1H PASS' && H>=12&&H<=17 && L.S===4&&L.C>=3&&L.H<=3)
      return out('1S','SEF : nouvelle couleur naturelle de l’ouvreur, 1P','forcing-check');

    return null;
  }

  function review(ctx){
    // Normaliser aussi les historiques sous forme de simples chaînes, afin que
    // l'identification partenaire/adversaires ne dépende pas du format d'appel.
    ctx={...ctx,history:normHistory(ctx.history,ctx.deal)};
    const call=String(ctx.call||'').toUpperCase();

    const sefRef=sef2024ReferenceCorrection(ctx);
    if(sefRef?.call){
      return {changed:sefRef.call!==call,level:sefRef.call!==call?'red':'green',call:sefRef.call,original:call,severity:9,semantic:sefRef.semantic,reason:sefRef.reason};
    }

    // Une petite poignée de continuations Spoutnik est suffisamment explicite dans les
    // cours pour corriger même une annonce non-PASS. Cette vérification précède donc le
    // garde-fou historique qui limite le Critic aux PASS.
    const courseCall=knownCourseCallCorrection(ctx);
    if(courseCall?.call){
      if(courseCall.changed){
        return {
          changed:true,
          level:'red',
          call:courseCall.call,
          original:call,
          severity:10,
          semantic:courseCall.semantic,
          reason:`correction de continuation adossée au cours: ${courseCall.reason}`
        };
      }
      return {changed:false,level:'green',call,semantic:courseCall.semantic,reason:courseCall.reason};
    }
    if(call!=='PASS'){
      // Pour l'instant, le moteur n'est modifié que sur les veto PASS rouges.
      // Les autres décisions peuvent être enrichies plus tard sans risque d'une grosse
      // sur-correction dès la première version.
      return {changed:false,level:'green',call,reason:'aucun veto général certain'};
    }

    const courseBacked=knownCoursePassSubstitution(ctx);
    if(courseBacked?.call){
      return {
        changed:true,
        level:'red',
        call:courseBacked.call,
        original:'PASS',
        severity:10,
        semantic:courseBacked.semantic,
        reason:`substitution adossée au cours: ${courseBacked.reason}`
      };
    }

    const info=passConcern(ctx);
    const level=info.severity>=7?'red':info.severity>=4.5?'orange':'green';
    if(level!=='red'){
      return {changed:false,level,call,reason:info.reasons.join(' · ')||'Passe plausible',severity:info.severity};
    }

    const choice=chooseAlternative(ctx,info);
    if(!choice.best || choice.best.score<2.5){
      return {changed:false,level:'orange',call,reason:`Passe très suspect, mais aucune alternative assez sûre (${info.reasons.join(' · ')})`,severity:info.severity};
    }
    // Si deux alternatives sont quasiment ex aequo, on sait que PASS est mauvais mais
    // pas quoi substituer avec assez de confiance : journaliser seulement.
    if(choice.best.margin<0.55){
      return {changed:false,level:'orange',call,reason:`Passe veto en théorie, alternatives ambiguës (${choice.best.call}/${choice.scored[1]?.call})`,severity:info.severity,alternatives:choice.scored.slice(0,5)};
    }

    const semantic=knownSemanticForSubstitution(ctx,info,choice.best);
    if(!semantic){
      return {
        changed:false,
        level:'orange',
        call,
        severity:info.severity,
        reason:`Passe très suspect, mais contexte non couvert avec assez de certitude pour substituer ${choice.best.call} (${info.reasons.join(' · ')})`,
        alternatives:choice.scored.slice(0,5)
      };
    }

    return {
      changed:true,
      level:'red',
      call:choice.best.call,
      original:'PASS',
      severity:info.severity,
      semantic,
      reason:`veto de plausibilité PASS dans un contexte naturel validé: ${info.reasons.join(' · ')}; alternative ${choice.best.call} (${choice.best.why.join(', ')})`,
      alternatives:choice.scored.slice(0,5)
    };
  }

  const api={VERSION,review,hcp,lengths,supportHld,passConcern,scoreAlternative,chooseAlternative,knownFreeBidContext,cheapestSuitBidAfter,knownSemanticForSubstitution,knownCoursePassSubstitution,knownCourseCallCorrection};
  root.PonsCritic=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
