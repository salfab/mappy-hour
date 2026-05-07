# Plan - Precompute haute valeur avec Rust/wgpu Vulkan

**Date** : 2026-04-14  
**Statut** : Brouillon d'exécution expérimentale  
**Références** : ADR-0009, ADR-0010

## Objectif

Tester Rust/wgpu Vulkan comme backend expérimental pour le precompute du cache des tuiles haute valeur, sans remplacer `gpu-raster` comme chemin de production.

Le but n'est pas encore de promouvoir Vulkan par défaut. Le but est de vérifier qu'un run cache réel peut être lancé, écrit et nettoyé proprement, puis d'étendre progressivement la fenêtre de calcul.

## Politique de cache

Les caches `gpu-raster` et Rust/wgpu Vulkan sont volontairement partagés tant que nous traitons Vulkan comme une autre implémentation du même contrat fonctionnel.

Vérification locale du 2026-04-14 :

- `getSunlightModelVersion()` construit `modelVersionHash` à partir des manifests, de la calibration, de l'index bâtiments, du terrain, de la végétation et du partage horizon adaptatif.
- Le hash inclut `buildingsIndex.method`, mais pas le mode actif `MAPPY_BUILDINGS_SHADOW_MODE`.
- `evaluation-context` ajoute bien un suffixe de méthode dans l'artefact, par exemple `|gpu-raster-v1` ou `|rust-wgpu-vulkan-v1`, mais ce suffixe arrive pendant le calcul d'une tuile, pas dans le `modelVersionHash` utilisé pour le chemin de cache et pour `skip-existing`.

Conséquence voulue : si une tuile existe déjà en cache pour `gpu-raster` avec le même `modelVersionHash`, un run Vulkan avec `--skip-existing=true` la considère comme déjà calculée et la skippe.

Cela permet de remplir les trous du cache haute valeur avec Vulkan sans recalculer ce qui existe déjà. Pour comparer les backends, utiliser les dry-runs et les summaries de valeurs dédiées plutôt que deux caches de production séparés.

Limite observée le 2026-04-15 : le cache est partagé entre backends, mais la détection `skip-existing` reste liée au run complet, notamment à `startLocalTime` et `endLocalTime`. Une tuile calculée pour `12:00-13:00` n'est donc pas automatiquement réutilisée lors d'un run `06:00-21:00`, alors que les frames communes ont le même sens fonctionnel.

Évolution à planifier : rendre le cache plus intelligent au niveau frame ou segment horaire. Une frame de tuile devrait être identifiée par le contrat fonctionnel réel (`region`, `tileId`, `date`, heure locale ou timestamp solaire, `gridStepMeters`, `sampleEveryMinutes`, `modelVersionHash`, calibration), pas par le batch qui l'a produite. Un run large devrait pouvoir réutiliser les frames déjà calculées dans des runs plus courts et ne calculer que les frames manquantes.

Cette évolution est volontairement reportée. Elle implique de revoir le format de manifest, la validation de complétude, la lecture côté API et la stratégie de purge, pour éviter de mélanger silencieusement des fragments incompatibles.

Point d'attention : pour forcer un vrai calcul Vulkan, `--skip-existing=false` doit être utilisé uniquement sur un scope contrôlé, de préférence une date/fenêtre courte qui ne contient pas de cache raster à préserver, ou après purge explicite du run cible.

Option non retenue pour l'instant : inclure le backend bâtiment dans `modelVersionHash`. Elle isolerait mieux les comparaisons, mais empêcherait aussi la réutilisation naturelle du cache raster et obligerait à dupliquer les métadonnées de grille.

## Préconditions Vulkan

Le backend Rust/wgpu Vulkan ne remplace pas encore toute la chaîne `gpu-raster`.

Précondition importante observée le 2026-04-15 : les masques indoor/zenith doivent déjà exister pour les tuiles visées. Sinon le calcul échoue avec `Indoor detection unavailable ... no grid metadata and no GPU backend`, car le mode Vulkan ne sait pas générer ce masque à la volée comme `gpu-raster`.

Conséquence opérationnelle : avant un run Vulkan haute valeur, vérifier ou générer les grid metadata des tuiles sélectionnées. Les tuiles sans metadata doivent être traitées comme des trous préparatoires, pas comme des erreurs Vulkan de calcul d'ombre.

Autre correction validée le 2026-04-15 : le serveur natif Rust/wgpu est lié au fichier de points chargé au démarrage. Il ne peut pas être réutilisé tel quel entre deux tuiles avec des points outdoor différents. Le backend garde donc le mesh en cache, mais recrée le serveur natif quand le jeu de points ou le focus change.

## Résultats observés

### 2026-04-15 - Smoke bbox Lausanne

Commande :

```powershell
pnpm precompute:region:vulkan -- --region=lausanne --bbox=6.617833535951478,46.50733328648029,6.6210564648232975,46.50960558893264 --start-date=2026-04-13 --days=1 --start-local-time=12:00 --end-local-time=12:15 --grid-step-meters=1 --sample-every-minutes=15 --skip-existing=false
```

Résultat après génération de la metadata indoor manquante :

- 5 tuiles sélectionnées ;
- 5 réussites, 0 échec ;
- manifest complet sous `lausanne/d43fe24cbb9190af/g1/m15/2026-04-13/t1200-1215` ;
- artefacts avec `buildingsShadowMethod` contenant `rust-wgpu-vulkan-v1` ;
- aucun process natif résiduel observé après shutdown.

### 2026-04-15 - Top-priority court

Préparation metadata :

- top-priority : 181 tuiles ;
- Lausanne : 161/161 metadata déjà présentes après le smoke ;
- Morges : 3 metadata générées ;
- Nyon : 1 metadata générée ;
- Genève : 2 metadata générées.

Commande :

```powershell
pnpm precompute:all-regions:vulkan -- --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json --start-date=2026-04-13 --days=1 --start-local-time=12:00 --end-local-time=13:00 --grid-step-meters=1 --sample-every-minutes=15 --skip-existing=true
```

Résultat :

- Lausanne : 161/161 tuiles, 0 échec, manifest complet ;
- Morges : 12/12 tuiles, 0 échec, manifest complet ;
- Nyon : 4/4 tuiles, 0 échec, manifest complet ;
- Genève : 4/4 tuiles, 0 échec, manifest complet ;
- les artefacts inspectés contiennent `rust-wgpu-vulkan-v1` ;
- aucun process `mappyhour-wgpu-vulkan-probe.exe` résiduel observé après le run.

### 2026-04-15 - Top-priority journée complète

Commande :

```powershell
pnpm precompute:all-regions:vulkan -- --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json --start-date=2026-04-13 --days=1 --start-local-time=06:00 --end-local-time=21:00 --grid-step-meters=1 --sample-every-minutes=15 --skip-existing=true
```

Résultat :

- Lausanne : 161/161 tuiles, 0 échec, manifest complet, durée 45m56s ;
- Morges : 12/12 tuiles, 0 échec, manifest complet, durée 3m30s ;
- Nyon : 4/4 tuiles, 0 échec, manifest complet, durée 1m26s ;
- Genève : 4/4 tuiles, 0 échec, manifest complet, durée 1m16s ;
- total : 181/181 tuiles, 0 échec, environ 52m ;
- les manifests sont écrits sous `data/cache/sunlight/<region>/<model>/g1/m15/2026-04-13/t0600-2100` ;
- les artefacts inspectés contiennent `rust-wgpu-vulkan-v1` et 60 frames par tuile ;
- aucun process `mappyhour-wgpu-vulkan-probe.exe` résiduel observé après le run.

Observation perf : sur les tuiles simples Lausanne, une journée complète de 60 frames tourne souvent autour de 12s par tuile, avec environ 11s d'évaluation GPU. Quelques tuiles plus denses montent nettement plus haut, par exemple 34.5s observées sur une tuile avec masque indoor partiel. Le restart du serveur natif reste donc mesurable, mais il n'est pas le coût dominant sur une journée complète.

## Plan d'implémentation

1. Ajouter un flag explicite expérimental à `precompute-region-sunlight.ts` :
   `--buildings-shadow-mode=gpu-raster|rust-wgpu-vulkan`.

2. Relayer ce flag depuis `precompute-all-regions-sunlight.ts` vers chaque région, sans dépendre uniquement d'une variable d'environnement implicite.

3. Ne pas inclure le backend bâtiment dans la version de modèle/cache par défaut.

   Le comportement attendu est :

   - les runs Vulkan peuvent skipper des tuiles raster existantes ;
   - les artefacts recalculés en Vulkan conservent une méthode bâtiment contenant `rust-wgpu-vulkan-v1` ;
   - les comparaisons raster/Vulkan restent dans les rapports de benchmark, pas dans deux arbres de cache concurrents.

4. Logguer clairement le mode actif :

   - `buildingsShadowMode=gpu-raster`
   - `EXPERIMENTAL buildingsShadowMode=rust-wgpu-vulkan`
   - `modelVersionHash=<hash>`

5. Vérifier que deux runs identiques, l'un en `gpu-raster` et l'autre en `rust-wgpu-vulkan`, produisent le même `modelVersionHash` tant que la politique de cache partagé est active.

6. Vérifier que `skip-existing=true` voit bien un cache raster compatible comme déjà calculé.

7. Garder `MAPPY_PRECOMPUTE_WORKERS=1` pour Vulkan tant que la stabilité multi-worker n'a pas été testée.

8. Planifier une architecture de cache indépendante du batch horaire :

   - indexer ou lire les artefacts au niveau frame/segment, pas seulement au niveau run complet ;
   - permettre à un run large de réutiliser les frames déjà présentes dans un run plus court compatible ;
   - conserver une validation stricte de compatibilité sur le modèle, la calibration, la grille et la méthode de calcul ;
   - définir une migration ou un mode de compatibilité avec les manifests actuels.

## Plan de run

### Smoke cache réel

Scope recommandé :

- région : `lausanne`
- tuile ou bbox réduite autour de `e2538000_n1152500_s250`
- date : 1 jour
- fenêtre : `12:00-12:15`
- grille : `1m`
- workers : `1`
- mode : `rust-wgpu-vulkan`

Critères de passage :

- une tuile est écrite dans le cache partagé avec une méthode d'artefact Vulkan si le scope n'était pas déjà calculé ;
- le log affiche le `modelVersionHash` partagé attendu ;
- le serveur natif s'arrête proprement (`Native server stopped`) ;
- aucun `mappyhour-wgpu-vulkan-probe.exe` ne reste actif ;
- les tuiles avec metadata indoor existante passent même si le nombre de points outdoor varie d'une tuile à l'autre ;
- les tuiles sans metadata indoor sont identifiées explicitement dans les logs ;
- si `--skip-existing=true`, le cache raster existant peut être utilisé pour skipper le calcul Vulkan ;
- si on veut forcer le calcul, choisir un scope sans cache existant ou utiliser `--skip-existing=false` sur une fenêtre de test contrôlée.

### Top-priority court

Après le smoke :

```powershell
pnpm precompute:all-regions:vulkan -- --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json --start-date=2026-04-13 --days=1 --start-local-time=12:00 --end-local-time=13:00 --grid-step-meters=1 --sample-every-minutes=15 --skip-existing=true
```

Critères de passage :

- toutes les régions sélectionnées terminent ou échouent avec une erreur exploitable ;
- pas de process Rust/wgpu résiduel ;
- temps par tuile cohérent avec les dry-runs observés ;
- cache écrit sous le modèle partagé, avec une méthode d'artefact Vulkan pour les tuiles réellement recalculées ;
- les tuiles déjà présentes dans le cache partagé peuvent être skippées.

### Journée complète

Si le top-priority court passe :

```powershell
pnpm precompute:all-regions:vulkan -- --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json --start-date=2026-04-13 --days=1 --start-local-time=06:00 --end-local-time=21:00 --grid-step-meters=1 --sample-every-minutes=15 --skip-existing=true
```

### Multi-jours

Seulement après une journée complète verte :

```powershell
pnpm precompute:all-regions:vulkan -- --tile-selection-file=data/processed/precompute/high-value-tile-selection.top-priority.json --start-date=2026-04-11 --days=7 --start-local-time=06:00 --end-local-time=21:00 --grid-step-meters=1 --sample-every-minutes=15 --skip-existing=true
```

## Vérifications après chaque run

1. Vérifier les logs de precompute.
2. Vérifier les manifests de cache écrits.
3. Vérifier l'absence de process natif résiduel :

   ```powershell
   Get-Process | Where-Object { $_.ProcessName -like '*wgpu*' -or $_.ProcessName -like '*vulkan*' -or $_.Path -like '*wgpu-vulkan-probe*' }
   ```

4. Vérifier que les artefacts indiquent une méthode bâtiment contenant `rust-wgpu-vulkan-v1`.
5. Lancer une comparaison ponctuelle contre `gpu-raster` si un run long montre des écarts ou des performances inattendues.

## Critères pour ne pas continuer

Arrêter l'extension du scope si l'un de ces points apparaît :

- un process Rust/wgpu reste actif après shutdown ;
- une tuile échoue sans fallback exploitable ;
- les divergences visuelles ne ressemblent plus à des cas de bord bâtiment ;
- les temps de setup dominent au point de rendre le backend moins utile que `gpu-raster` sur les tuiles haute valeur.
