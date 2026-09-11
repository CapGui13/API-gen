API-gen — Deal Pool cible LIVE 240

Tu peux pousser ces fichiers pendant que le run actuel tourne.

IMPORTANT :
- le run actuellement en cours a déjà checkout l'ancien commit ;
- il continuera donc normalement avec l'ancien comportement ;
- le nouveau code ne s'appliquera qu'au prochain run.

Nouveau comportement :
- relit le stock READY réel après chaque vague ;
- si PLAY consomme des donnes pendant la génération, le générateur continue ;
- arrêt seulement quand READY >= target (240), ou si le plafond de sécurité est atteint ;
- toujours 1 seul runner GitHub, concurrence interne = 2.

Fichiers :
- .github/workflows/deal-pool-precompute.yml
- scripts/fill-deal-pool.js
