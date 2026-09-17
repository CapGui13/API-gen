# PLAY — Deal Pool V3 + pré-calcul prioritaire

## 1. Stock générique READY

Chaque donne READY contient :

- 52 cartes + métadonnées HCP/distributions ;
- table DD exacte ;
- 72 tables statistiques brutes côté NS ;
- 72 tables statistiques brutes côté EW ;
- `statisticalSeedId` stable.

Le conditionnement PONS dépend de l'enchère réellement jouée et reste calculé dans PLAY.

Clés Redis principales :

- `bridge-deal-pool:v3:data`
- `bridge-deal-pool:v3:ready`

Cible par défaut : **2000 donnes READY**.

Le workflow `PLAY deal pool precompute` utilise maintenant **4 runners GitHub en parallèle**.
Chaque runner utilise **2 Worker Threads DDS**, soit jusqu'à **8 donnes en calcul simultané**.
Les quatre shards relisent le stock réel avant chaque vague ; un job final `verify-target`
vérifie que la cible globale a réellement été atteinte.

## 2. Donnes fresh générées dans PLAY

Si les contraintes sont trop précises pour trouver tout le lot dans le stock, PLAY génère
localement comme avant. Ces donnes sont immédiatement jouables : aucun serveur n'est requis.

En parallèle, PLAY appelle silencieusement :

- `action: "enqueue-precompute"` pour placer les donnes dans une file prioritaire Redis ;
- `action: "precompute-status"` pour récupérer les résultats au fil de l'eau.

Le workflow `PLAY priority deal precompute` possède lui aussi **4 runners × 2 workers**.
Pour chaque donne, il publie progressivement :

1. DD exact ;
2. 24 tirages statistiques pour NS + 24 pour EW ;
3. 48 + 48 ;
4. 72 + 72.

PLAY absorbe chaque palier dès qu'il arrive. Son calcul DDS local continue en parallèle :
le premier résultat disponible gagne, sans message ni attente supplémentaire pour l'utilisateur.

Les jobs prioritaires expirent automatiquement après 6 heures.

## 3. Secrets GitHub Actions

Dans `CapGui13/API-gen` → Settings → Secrets and variables → Actions :

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

## 4. Déclenchement instantané des jobs prioritaires

Pour que Vercel puisse lancer `PLAY priority deal precompute` dès qu'une donne fresh arrive,
ajouter dans les variables d'environnement du projet Vercel `api-gen` :

- `BRIDGE_GITHUB_ACTIONS_TOKEN`

Utiliser un token GitHub finement limité au dépôt `CapGui13/API-gen`, avec la permission
**Actions: Read and write**. Ne jamais mettre ce token dans le dépôt ni dans PLAY.

Variables optionnelles (les valeurs par défaut conviennent au dépôt actuel) :

- `BRIDGE_GITHUB_REPOSITORY=CapGui13/API-gen`
- `BRIDGE_GITHUB_PRIORITY_WORKFLOW=priority-deal-precompute.yml`
- `BRIDGE_GITHUB_REF=main`

Sans token, PLAY continue de fonctionner normalement et le calcul local reste le fallback ;
les jobs en file seront également drainés au début d'un futur run normal de remplissage.

## 5. Fichiers

- `api/deal-pool.js` — service Vercel léger : take/status + queue prioritaire.
- `scripts/fill-deal-pool.js` — fabrication du stock générique.
- `scripts/process-priority-deals.js` — calcul progressif des donnes fresh.
- `.github/workflows/deal-pool-precompute.yml` — remplissage 4 runners + vérification finale.
- `.github/workflows/priority-deal-precompute.yml` — calcul urgent 4 runners.
- `lib/pool-statistical-sampler.js` — sampler déterministe partagé avec PLAY.
