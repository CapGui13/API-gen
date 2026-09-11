# PLAY — Deal Pool V3 (pré-calcul hors Vercel)

## Objectif

Le stock n'est plus seulement un réservoir de cartes : chaque donne publiée dans le stock V3 est **complètement pré-calculée avant d'être servie à PLAY**.

Par donne READY :

- 52 cartes + métadonnées HCP/distributions ;
- table DD exacte ;
- 72 tables statistiques brutes côté NS ;
- 72 tables statistiques brutes côté EW ;
- `statisticalSeedId` stable.

Cela couvre d'avance les paliers adaptatifs 24 / 48 / 72 du PAR statistique brut. Le conditionnement PONS dépend de l'enchère réellement jouée et reste donc calculé au moment du jeu.

## Pourquoi GitHub Actions

Le calcul lourd n'est plus fait par une Function Vercel. Cela évite de consommer le quota CPU Vercel pour remplir le stock.

- GitHub Actions calcule les donnes.
- GitHub Actions écrit directement dans Upstash.
- Vercel `/api/deal-pool` ne fait que filtrer/servir les donnes.

## Stock

Clés V3 séparées des anciennes V2 :

- `bridge-deal-pool:v3:data`
- `bridge-deal-pool:v3:ready`

Cible par défaut : **240 donnes READY**.

Le workflow ajoute au maximum 8 donnes par passage et tourne deux fois par heure. Une fois les 240 atteintes, il ne fait plus de DDS ; il vérifie seulement le niveau du stock.

## Fichiers

- `api/deal-pool.js` — endpoint Vercel léger V3.
- `lib/pool-statistical-sampler.js` — sampler déterministe identique à PLAY.
- `scripts/fill-deal-pool.js` — générateur/calculateur lancé dans GitHub Actions.
- `.github/workflows/deal-pool-precompute.yml` — maintenance automatique + lancement manuel.

## Secrets GitHub à créer une seule fois

Dans `CapGui13/API-gen` → **Settings → Secrets and variables → Actions → New repository secret** :

1. `UPSTASH_REDIS_REST_URL`
2. `UPSTASH_REDIS_REST_TOKEN`

Copier les mêmes valeurs que celles déjà configurées dans les variables d'environnement du projet Vercel `api-gen`.

Ne jamais mettre ces valeurs directement dans un fichier du dépôt.

## Mise en service

1. Remplacer/ajouter les fichiers du patch sur `API-gen` et pousser sur `main`.
2. Attendre que Vercel redéploie `api-gen` avec succès.
3. Créer les deux secrets GitHub ci-dessus.
4. GitHub → Actions → `PLAY deal pool precompute` → `Run workflow`.
5. Pour le premier remplissage, on peut lancer plusieurs runs manuels ; le cron prendra ensuite le relais.
6. Vérifier le niveau avec :

```js
fetch('https://api-gen-beta.vercel.app/api/deal-pool', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({action:'status'})
}).then(async r => console.log(r.status, await r.text()))
```

Depuis `https://capgui13.github.io/play/`, la réponse doit contenir `poolVersion: "play-deal-pool-v3-precomputed72"` et le nombre `ready`.

## PLAY

Le PLAY V1/V2 déjà déployé sait lire ce format : il accepte jusqu'à 72 entrées pré-calculées par côté. Aucun changement supplémentaire du frontend n'est nécessaire pour V3.

L'appel automatique `{action:"replenish"}` de PLAY reste compatible : en V3 il devient un simple contrôle léger du stock et ne lance plus de DDS sur Vercel.
