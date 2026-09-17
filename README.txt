API-gen — PLAY deal pool 2000 + calcul prioritaire

Stock générique :
- cible = 2000 READY
- 4 runners GitHub en parallèle
- 2 workers DDS par runner
- vérification finale de la cible

Donnes fresh de PLAY :
- queue Redis prioritaire
- DD exact puis paliers 24 / 48 / 72 pour NS et EW
- workflow GitHub séparé 4 runners x 2 workers
- déclenchement instantané si BRIDGE_GITHUB_ACTIONS_TOKEN est configuré dans Vercel

Voir README-DEAL-POOL.md pour la configuration.
