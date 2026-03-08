# Faisabilite, Cout, Hebergement

Date: 2026-03-08

## Reponse courte

Le projet webapp n'est pas condamne a l'echec.
Il faut separer:
- API interactive "rapide" (instant + petites zones)
- calculs lourds (daily/grandes zones) en jobs asynchrones + cache

## Pourquoi le cout peut exploser

Les couts augmentent surtout avec:
- nombre de points evalues
- nombre de frames temporelles
- chargements repetes de rasters/index
- absence de cache resultat

## Architecture recommandee

### 1. API synchrone pour usage interactif
- garder `point` et `area instant` pour petites bbox
- limites strictes (`maxPoints`, `sampleEveryMinutes`, taille bbox)
- streaming SSE pour feedback progressif

### 2. Jobs asynchrones pour calculs lourds
- `POST /jobs/sunlight` retourne un `jobId`
- worker calcule en arriere-plan (queue)
- client suit l'etat (`/jobs/:id`) et lit les frames en increment

### 3. Cache multicouche
- cache memoire court (resultats recents)
- cache disque/objet pour frames daily
- cle de cache: `{region, bboxNorm, date, timeRange, gridStep, sample}`

### 4. Precompute sur zones frequentes
- tuiles fixes sur zones touristiques / parcs / terrasses
- precompute matin-midi-soir et saisons
- fallback temps reel pour requetes hors cache

## Options d'hebergement

### Option A - VM simple (MVP)
- 1 VM CPU correcte + disque local SSD
- worker local + API sur meme machine
- cout modere, operations simples

### Option B - API + workers separes
- API stateless (petites instances)
- workers CPU autoscalables
- stockage objet pour resultats precomputes
- meilleur controle cout/perf

### Option C - Hybrid edge + backend
- UI + API legere proche utilisateur
- jobs lourds dans region unique
- utile si trafic international

## Webapp vs client-side lourd

Faire tout calculer cote client (mobile/desktop) n'est pas obligatoire.
Strategie plus intelligente:
- serveur pour modele fiable + donnees lourdes centralisees
- client pour visualisation, timeline, diagnostics
- eventuellement mode offline partiel plus tard

## Garde-fous de cout

- quotas par utilisateur/session
- limites dynamiques selon charge
- priorite aux requetes cacheables
- observabilite: temps par endpoint, cout CPU par job, hit-rate cache

## Decision pratique immediate

1. Continuer webapp.
2. Introduire endpoint jobs pour daily lourd.
3. Ajouter cache persistant des frames daily.
4. Precompute progressif sur zones a forte demande.
