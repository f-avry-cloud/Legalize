# Legalize — Logiciel métier droit des affaires / corporate (MVP)

Outil métier pour avocat / cabinet en droit des affaires et corporate, centré sur
l'**efficacité de production documentaire** : tout l'effort est investi en amont
(templates, logique conditionnelle, données structurées) pour que la production
nécessite un minimum d'intervention manuelle.

## Démarrage

Les données vivent dans Supabase (Postgres + Storage) : l'application est
utilisable depuis n'importe où (cabinet + mobilité) et les documents générés
sont conservés dans le bucket `documents`.

```bash
npm install
npm start           # http://localhost:3000
```

Le jeu de démonstration (Groupe Horizon) est chargé automatiquement au premier
démarrage sur base vide. `SUPABASE_URL` / `SUPABASE_KEY` permettent de pointer
un autre projet Supabase (valeurs par défaut dans `src/supa.js`).

Déploiement : compatible Vercel tel quel (`api/index.js` + `vercel.json`).

Autres commandes :

```bash
npm test                  # test de bout en bout (base éphémère)
npm run build:templates   # matérialise les templates .docx dans templates/generated/
npm run dev               # serveur avec rechargement (node --watch)
```

## Fonctionnalités (P0 du cahier des charges)

1. **Fiches Société / Groupe** — forme, capital, siège, SIREN, dirigeants,
   associés/actionnaires, historique des opérations. Les participations
   inter-sociétés (associé « personne morale » lié à une société du référentiel)
   alimentent automatiquement l'**organigramme de groupe** avec pourcentages.
2. **Génération documentaire en un clic** — les variables d'une opération sont
   saisies **une seule fois** ; un clic génère l'intégralité des documents Word
   de la checklist, fusionnés avec la fiche société (docxtemplater : variables,
   blocs conditionnels, boucles). Les clauses optionnelles pilotent l'inclusion
   de paragraphes et même de documents entiers (ex. PV d'agrément, GAP).
3. **Checklists d'opérations types** — 5 opérations couvertes : constitution,
   cession de titres, augmentation de capital, pacte d'associés, approbation des
   comptes. Les documents requis sont instanciés à la création de l'opération et
   les manquants signalés (opération + tableau de bord).
4. **Suivi de versions / markup** — chaque document a un historique de versions
   (générée / reçue / importée, .docx et .pdf). La comparaison mot à mot entre
   version envoyée et version reçue met en évidence ajouts et suppressions.
5. **Devis / facturation simple** — devis et factures par opération, au forfait
   ou au temps passé, numérotation automatique (DEV-AAAA-nnn / FAC-AAAA-nnn),
   TVA, suivi de statut, impression.

6. **Formalités INPI (guichet unique)** — ouverture d'un dossier à partir du
   seul SIREN (état civil rapatrié du RNE, zéro ressaisie), questionnaire
   réduit au strict delta, contrôles bloquants avant dépôt, dépôt au guichet
   unique et suivi automatique des statuts, régularisations et délais légaux.
   Détail : [Formalités INPI](#formalités-inpi-guichet-unique--rne).

## Architecture

```
server.js               Express (API + fichiers statiques + seed démo au premier démarrage)
api/index.js            Point d'entrée serverless (Vercel)
src/supa.js             Client Supabase (Postgres via PostgREST + Storage)
src/definitions.js      Référentiel métier : types d'opérations, variables, checklists, templates
src/docx.js             Construction .docx (OOXML) + extraction de texte (.docx/.pdf)
src/routes.js           API REST
src/services/generation.js   Génération en un clic (contexte de fusion + docxtemplater)
src/services/compare.js      Comparaison de versions (diff mot à mot)
src/inpi/               Connecteur INPI : config, client HTTP, RNE, guichet unique,
                        catalogue des formalités, contrôles, payload, référentiels, mode démo
src/services/formalites.js   Cycle de vie d'un dossier de formalité
src/routes-formalites.js     API /api/inpi/* et /api/formalites/*
scripts/                seed, build-templates, smoke-test, schéma et tests des formalités
public/                 Interface web (vanilla JS, sans build)
```

Le schéma Postgres (tables `societes`, `groupes`, `operations`, `documents`,
`document_versions`, `factures`, `dirigeants`, `associes`) est versionné dans
les migrations du projet Supabase. Les documents sont rangés dans le bucket
Storage `documents` sous une arborescence lisible `société/opération/fichier`.

> **Posture de sécurité (démo)** : l'application et la base sont accessibles
> sans authentification (politiques RLS ouvertes). Avant d'y mettre de vrais
> dossiers clients : activer Supabase Auth, restreindre les politiques RLS et
> protéger l'accès à l'interface.

### Personnalisation des templates

`npm run build:templates` écrit les templates dans `templates/generated/`
(`<type>__<document>.docx`). Un template retravaillé à la main (mise en forme du
cabinet, clauses maison) **est utilisé en priorité** par le moteur de
génération, tant que les balises `{variable}` / `{#condition}…{/condition}` /
`{#liste}…{/liste}` sont conservées. Les variables auto-injectées depuis la
fiche société sont listées en tête de `src/definitions.js`.

### Stockage

Les documents sont rangés dans le bucket Supabase `documents` sous une
arborescence lisible `<société>/<n°-opération>/<fichier>`, exportable telle
quelle vers l'arborescence existante du cabinet (OneDrive/serveur). Variables
d'environnement : `PORT`, `SUPABASE_URL`, `SUPABASE_KEY`.

## Formalités INPI (guichet unique / RNE)

Le module remplace la saisie sur le portail du guichet unique par un parcours
en trois écrans (`#/formalites`).

### Le parcours

1. **Un SIREN suffit.** La fiche entreprise est rapatriée de l'API RNE
   (dénomination, forme, capital, siège, objet, dirigeants en fonction) et
   figée comme instantané du dossier. Rien de ce que l'INPI connaît déjà n'est
   ressaisi. Le même appel permet de créer une fiche société du cabinet
   (`POST /api/inpi/importer-societe`).
2. **Le questionnaire ne demande que le delta.** Huit formalités couvertes :
   création, transfert de siège, changement de dirigeant, changement de
   dénomination, modification du capital, modification de l'objet, cessation /
   dissolution, dépôt des comptes annuels. Les champs sans objet sont masqués
   selon les réponses (une cessation de fonctions ne demande pas l'identité du
   nouveau dirigeant).
3. **Les contrôles tournent avant le dépôt, pas après le rejet.** Complétude,
   cohérence (capital qui baisse sur une « augmentation », approbation
   antérieure à la clôture, dirigeant mineur, changement de ressort…), pièces
   justificatives exigibles compte tenu des réponses, et délai légal calculé
   sur la date pivot. Le bouton de dépôt reste verrouillé tant qu'un point
   bloquant subsiste.
4. **Le suivi se construit tout seul.** Statut, numéro de liasse, demandes de
   régularisation et journal horodaté de chaque action. Le tableau de bord
   remonte ce qui bloque (régularisations), ce qui presse (échéances dépassées)
   et ce qui dort (brouillons).

Le JSON transmis à l'INPI est consultable dans le dossier : aucune boîte noire.

### Configuration

Sans identifiants, l'application tourne en **mode démo** : parcours complet,
données RNE simulées, dépôt simulé, rien n'est transmis à l'INPI.

| Variable | Rôle |
| --- | --- |
| `INPI_RNE_USERNAME` / `INPI_RNE_PASSWORD` | Compte [data.inpi.fr](https://data.inpi.fr) — lecture RNE (pré-remplissage) |
| `INPI_GU_USERNAME` / `INPI_GU_PASSWORD` | Compte e-procédures INPI habilité mandataire — dépôt et suivi |
| `INPI_DEPOT_REEL` | `1` pour autoriser le dépôt réel (défaut : simulation, même avec identifiants) |
| `INPI_RNE_URL` / `INPI_GU_URL` | Bascule vers la pré-production INPI |
| `INPI_RNE_PATH_*` / `INPI_GU_PATH_*` | Chemins d'API, paramétrables sans toucher au code |
| `INPI_MODE` | `demo` ou `live` pour forcer le mode |
| `INPI_TIMEOUT_MS` | Délai maximal par appel (défaut 20 s) |

Garde-fou volontaire : un dépôt engage la société et déclenche une
facturation. Il faut **à la fois** des identifiants et `INPI_DEPOT_REEL=1`
pour que quoi que ce soit parte à l'INPI.

Créer les tables une fois dans le projet Supabase :

```bash
# SQL editor Supabase → coller scripts/schema-formalites.sql
```

### À vérifier avant le premier dépôt réel

Deux points dépendent des annexes de la documentation technique INPI et sont
isolés pour être confirmés d'un seul endroit :

- `src/inpi/referentiels.js` — tables de codes (catégories juridiques INSEE,
  codes « rôle » des dirigeants). Un code absent de la table est signalé en
  contrôle, jamais deviné silencieusement.
- `src/inpi/config.js` — chemins des routes du contrat d'interface « API
  mandataire de dépôt », surchargeables par variables d'environnement.

Documentation de référence : [accès aux API du guichet
unique](https://www.inpi.fr/ressources/formalites-dentreprises/acces-aux-api-guichet-unique),
[accès à l'API formalité /
RNE](https://www.inpi.fr/ressources/formalites-dentreprises/acces-lapi-formalite-rne).

### Tests

```bash
npm run test:formalites   # logique pure : SIREN, normalisation, contrôles, délais, payloads
npm run test:api          # parcours complet des routes sur une base en mémoire
```

Aucun des deux n'a besoin du réseau ni de Supabase.

## Hors périmètre MVP (conforme au cahier des charges)

Signature électronique, data room, facturation électronique DGFiP, RPVA,
connecteur mail (P2 — restera optionnel et déconnectable).
