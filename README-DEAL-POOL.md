# PLAY — Deal Pool V1 + V2

Fichiers à ajouter dans le dépôt `CapGui13/API-gen` :

- `api/deal-pool.js`
- `lib/pool-statistical-sampler.js`

Le code réutilise les variables Upstash déjà employées par API-gen :

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Aucune nouvelle base n'est nécessaire.

## Fonctionnement

- `POST /api/deal-pool` avec `{action:"take", count, seatAssignment, constraints}` : consomme atomiquement un lot compatible du stock caché.
- `POST /api/deal-pool` avec `{action:"replenish"}` : remplit automatiquement le stock sous verrou Redis.
- V1 : chaque donne du stock contient sa table DD exacte.
- V2 : le réapprovisionnement enrichit progressivement des donnes avec 24 tables statistiques brutes côté NS et 24 côté EW.
- Si le stock ne fournit pas un lot complet, l'API renvoie 204 ; PLAY retombe alors sur sa génération locale sans consommation partielle.

Valeurs par défaut : cible 240 donnes, seuil bas 160, ajout par vague 24, enrichissement V2 d'une donne par vague. Elles sont ajustables par variables d'environnement `BRIDGE_DEAL_POOL_*` déjà lues par le code.

## Ordre de déploiement

1. Ajouter/déployer ces deux fichiers sur API-gen.
2. Vérifier que `POST https://api-gen-beta.vercel.app/api/deal-pool` avec `{ "action":"replenish" }` répond 200/202.
3. Déployer ensuite les fichiers PLAY modifiés (`app.js`, `statistical-par.js`, `sw.js`, plus le nouveau test).

Le frontend possède un fallback local, mais déployer le backend en premier évite d'attendre le timeout réseau lors d'une génération si l'endpoint n'existe pas encore.
