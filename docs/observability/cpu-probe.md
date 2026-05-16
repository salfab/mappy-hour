# Une jauge à essence pour Mitch

## Le doute

Ce matin, MappyHour a gagné une "amélioration UX" qui s'est révélée porter une question d'infra
plus profonde : chaque case à cocher (Ignorer la végétation, fréquence d'échantillonnage…)
relance désormais automatiquement un calcul d'ensoleillement, sans attendre que l'utilisateur
clique "Calculer". Plus fluide, plus moderne — mais aussi plus glouton.

Or le serveur qui héberge MappyHour, surnommé **Mitch**, n'est pas un mastodonte. C'est un
mini-PC posé sur une étagère, avec un processeur grand public. Une question s'est imposée :
si quelqu'un coche trois cases à la volée, Mitch va-t-il sortir la langue ? Faut-il s'inquiéter,
ou est-ce qu'on imagine un problème qui n'existe pas ?

## L'idée d'une sonde

Avant de débattre dans le vide, il fallait **regarder**. C'est l'équivalent de la jauge à
essence d'une voiture : sans jauge, on roule en se disant "il doit rester un peu", et on
tombe en panne sur l'autoroute. Avec jauge, on prend une décision informée.

Nous avons donc installé une jauge sur Mitch — pas une vraie jauge à essence, mais un
indicateur en temps réel de :
- **CPU** (à quel point le moteur tourne),
- **Mémoire** (combien d'espace de stockage rapide est encore libre),
- **Charge système** (le nombre de tâches qui attendent leur tour).

Cette jauge prend la forme d'un petit cadran discret en haut à droite de l'écran, qui
n'apparaît **que si on le demande explicitement** en ajoutant `?debug-cpu=1` à l'URL.
Aucune trace pour les visiteurs normaux ; un outil de pilotage pour le développeur.

## Où on a regardé

Un détail technique mais important : Mitch fait tourner MappyHour à l'intérieur d'un
"conteneur" (une boîte logicielle isolée du reste de la machine, comme un appartement
dans un immeuble). Trois périmètres de mesure étaient possibles :

1. **L'appartement** — ce que voit le programme Node.js depuis l'intérieur du conteneur.
2. **L'immeuble entier** — la machine hôte, avec tous ses autres locataires.
3. **Un capteur externe** — type `docker stats`, qui mesure de l'extérieur.

Nous avons choisi le point 1 : simple à câbler, suffisant pour répondre à la question du
jour. Si Node souffre à l'intérieur, on le verra. Si c'est l'immeuble entier qui flambe
(autre logiciel sur Mitch qui mange tout), il faudra ajouter une mesure externe plus tard.

## Le compromis

L'option idéale aurait été un capteur externe (mesure exacte du conteneur, vue
indépendante). On a préféré la version **simple aujourd'hui, précise demain** : un petit
service interne qui suffit pour dire "ça va" ou "ça va pas", et on raffinera si jamais on
détecte un signal louche.

C'est un principe utile en général : ne construis pas la Rolls-Royce de l'instrumentation
avant d'avoir confirmé que tu as un problème à instrumenter.

## Ce qu'on voit

Quelques règles de lecture, pour interpréter les chiffres comme un mécanicien lit un
tableau de bord :

- **CPU à 100% sur un seul cœur** = un calcul saturé, un seul fil de discussion. Pas grave
  si c'est court, à surveiller si ça dure.
- **Charge supérieure au nombre de cœurs** = la file d'attente déborde. La machine n'arrive
  plus à suivre. Rouge.
- **Mémoire qui grimpe sans jamais redescendre** = fuite probable. La voiture qui boit de
  l'huile sans qu'on sache pourquoi.

## Et après ?

La jauge, c'est la première marche. Les suivantes :
- Une **alerte automatique** : si Mitch dépasse 80% de CPU pendant 30 secondes, recevoir
  une notification (Slack, mail).
- Un **historique** : pas seulement l'instant T, mais une courbe sur 24h pour repérer les
  pics récurrents.
- Un **dashboard** : Grafana ou similaire, pour visualiser plusieurs métriques côte à côte.

Mais avant tout, la même règle qu'aujourd'hui : mesurer d'abord, raffiner ensuite. La
meilleure instrumentation, c'est celle qu'on construit en réponse à une question concrète —
pas celle qu'on déploie "au cas où".

---

*Implémentation :*
- *Endpoint serveur : `src/app/api/admin/diag/system/route.ts`*
- *Widget client : `src/components/diag/cpu-probe-overlay.tsx`*
- *Activation : ajouter `?debug-cpu=1` à n'importe quelle URL MappyHour.*
