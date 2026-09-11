API-gen — remplissage du Deal Pool en un seul run

Remplacer dans CapGui13/API-gen :
- .github/workflows/deal-pool-precompute.yml
- scripts/fill-deal-pool.js

Après push :
GitHub > API-gen > Actions > PLAY deal pool precompute > Run workflow
Laisser target=240 et batch=240, puis lancer.

Le run utilise un seul runner GitHub mais 2 worker_threads internes.
Il reprend automatiquement à partir du nombre READY déjà présent.
