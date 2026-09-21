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
   réduit au strict delta, contrôles bloquants avant dépôt, puis dépôt,
   signature, paiement et suivi des statuts, régularisations et délais légaux.
   Référentiels et payloads conformes au contrat d'interface de l'API
   mandataire. Détail : [Formalités INPI](#formalités-inpi-guichet-unique--rne).

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
src/inpi/               Connecteur INPI : config, client HTTP (jeton de session), RNE,
                        guichet unique, catalogue, contrôles, payload, mode simulation
src/inpi/data/          Référentiels officiels INPI convertis en JSON (générés)
src/services/formalites.js   Cycle de vie d'un dossier de formalité
src/routes-formalites.js     API /api/inpi/* et /api/formalites/*
scripts/                seed, build-templates, smoke-test, schéma, référentiels INPI
                        et tests des formalités
public/                 Interface web (vanilla JS, sans build) : système de design
                        en variables CSS, thème clair/sombre, responsive
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
en trois écrans (`#/formalites`). Il est aligné sur le **contrat d'interface de
l'API mandataire de dépôt** et sur le **dictionnaire de données mandataire**
publiés par l'INPI.

### Authentification — pas de clé d'API

L'INPI ne délivre aucune clé d'API statique. L'application se connecte avec
**l'identifiant (e-mail) et le mot de passe** du compte, récupère un **jeton JWT
de session** et le replace dans l'en-tête `Authorization` de chaque appel
suivant :

| API | Compte | Connexion |
| --- | --- | --- |
| RNE (lecture, pré-remplissage) | [data.inpi.fr](https://data.inpi.fr) | `POST /api/sso/login` |
| Guichet unique (dépôt, suivi) | e-procédures INPI, habilitation mandataire | `POST /api/user/login/sso` |

Le jeton est mis en cache jusqu'à son expiration (lue dans le JWT lui-même),
renouvelé automatiquement sur rejet 401/403, et accepté aussi bien en cookie
`BEARER` qu'en en-tête `Authorization` — les deux sont envoyés. Les mots de
passe ne servent qu'à la connexion : ils ne sont ni journalisés, ni exposés au
frontend (l'interface n'affiche que l'identifiant masqué).

### Tester les accès

Trois façons, toutes en **lecture seule** — aucune ne dépose quoi que ce soit :

```bash
npm run inpi:test                              # diagnostic des deux API
node scripts/inpi-connexion.js --siren 552100554   # avec un SIREN de contrôle
```

- **Bouton « Tester la connexion INPI »** sur l'écran Formalités : même
  diagnostic, depuis l'application déployée — c'est là que vivent réellement
  les variables d'environnement.
- **`POST /api/inpi/test-connexion`** (corps `{}` pour les deux API, ou
  `{"api":"rne"}` / `{"api":"guichet"}`).

Chaque API est vérifiée en deux temps, parce qu'ils échouent pour des raisons
différentes : d'abord la **connexion** (l'identifiant et le mot de passe
ouvrent-ils une session ?), puis une **lecture réelle** (le compte a-t-il
vraiment accès aux données ?) — un compte peut s'authentifier sans porter
l'habilitation « mandataire de dépôt ». Les échecs sont traduits en cause
probable plutôt qu'en code HTTP : mot de passe erroné, compte du mauvais
environnement, CPU non acceptées, habilitation manquante, ou requête
interceptée par un proxy avant d'atteindre l'INPI.

> Les identifiants se règlent par variables d'environnement. Sur Vercel, un
> **redéploiement est nécessaire** pour qu'une variable modifiée soit prise en
> compte.

> Les environnements de démonstration et de production de l'INPI exigent des
> comptes **distincts**, et l'accès aux API suppose d'avoir accepté les
> conditions particulières d'utilisation lors d'une première connexion à
> l'interface web — sinon la connexion est rejetée.

### Le parcours

1. **Un SIREN suffit.** La fiche entreprise est rapatriée de l'API RNE
   (dénomination, forme, capital, siège, objet, dirigeants en fonction) et
   figée comme instantané du dossier. Ce même instantané sert de
   `previousFormality.content` lors d'un dépôt de modification : le format du
   RNE est déjà celui du guichet unique.
2. **Le questionnaire ne demande que le delta.** Huit formalités : création
   (01M), transfert de siège (11M), changement de dirigeant (35M), changement
   de dénomination (10M), modification du capital (15M), modification de
   l'objet (12M), cessation / dissolution (22M, 40M, 42M) et dépôt des comptes
   annuels. Les champs sans objet sont masqués selon les réponses.
3. **Les contrôles tournent avant le dépôt, pas après le rejet.** Complétude,
   cohérence métier, codes de référentiel (forme juridique, rôle, type de
   voie), pièces exigibles compte tenu des réponses, format PDF et limite de
   10 Mo, délai légal — et, pour une modification, la présence d'au moins un
   indicateur d'évènement `…Triggered`, faute de quoi le guichet rejetterait
   le dépôt. Le bouton de dépôt reste verrouillé tant qu'un point bloquant
   subsiste.
4. **Le cycle du guichet est suivi de bout en bout** : dépôt → signature →
   paiement → validation, avec les régularisations et leurs délais. À chaque
   instant le dossier affiche **l'action attendue et de qui** ; le tableau de
   bord classe d'abord ce qui attend une action de notre côté.

Le JSON transmis est consultable dans le dossier, avec l'endpoint visé :
`/api/formalities` (création, cessation), `/api/formality_updates`
(modification) ou `/api/annual_accounts` (comptes annuels).

### Signature et paiement

- **Création** : signature simple, un appel suffit.
- **Modification, cessation, comptes annuels** : deux voies, présentées dans
  l'écran de signature du dossier.
  - *Gratuite (par défaut)* — la formalité est déposée par API, puis le
    signataire se connecte au guichet unique via FranceConnect+ (identité
    numérique La Poste) et signe. L'écran affiche le numéro de liasse à copier,
    le lien vers le portail, et un bouton qui réinterroge le statut.
  - *Certificat qualifié* — télécharger le document de synthèse (PJ_99), le
    signer hors ligne avec un certificat eIDAS, puis le redéposer depuis
    l'application : le dépôt en PJ_115 vaut signature.
- **Paiement** : jamais automatique. Il faut activer `INPI_PAIEMENT_AUTO` et
  fournir les identifiants du compte client INPI ; sinon le montant des taxes
  est affiché et le règlement se fait depuis le portail.

### Référentiels

Aucune table de codes n'est saisie à la main. Les formes juridiques, les codes
rôle, les 167 types de pièces justificatives (PJ_xx), les évènements et les
énumérations proviennent des fichiers officiels de l'INPI et sont convertis en
JSON dans `src/inpi/data/` :

```bash
pip install openpyxl
python3 scripts/build-referentiels-inpi.py \
  --dictionnaire inpi_dictionnaire-donnees-mandataire_<date>.xlsx \
  --formes inpi_liste-formes-juridiques-code-et-valideurs_<annee>.xlsx
```

Régénérer ces fichiers suffit à suivre une mise à jour du contrat d'interface.
Un code absent du référentiel est signalé par les contrôles, jamais deviné.

### Configuration

Sans identifiants, l'application tourne en **mode simulation** : parcours
complet, données RNE simulées, cycle de dépôt reproduit (statuts, signature,
paiement, régularisation), et rien n'est transmis à l'INPI.

| Variable | Rôle |
| --- | --- |
| `INPI_RNE_USERNAME` / `INPI_RNE_PASSWORD` | Compte data.inpi.fr — lecture RNE |
| `INPI_GU_USERNAME` / `INPI_GU_PASSWORD` | Compte e-procédures habilité mandataire |
| `INPI_GU_ENV` | `production` (défaut) ou `demonstration` (bac à sable INPI, compte dédié) |
| `INPI_PORTAIL_URL` | Portail e-procédures pour la signature FranceConnect+ (déduit de `INPI_GU_ENV`) |
| `INPI_DEPOT_REEL` | `1` pour autoriser le dépôt réel (défaut : simulation, même avec identifiants) |
| `INPI_PAIEMENT_AUTO`, `INPI_PAIEMENT_LOGIN`, `INPI_PAIEMENT_PASSWORD`, `INPI_PAIEMENT_TYPE` | Règlement des taxes par API (compte client INPI) |
| `INPI_RNE_URL` / `INPI_GU_URL` | Surcharge des hôtes |
| `INPI_MODE` | `simulation` ou `reel` pour forcer le mode |
| `INPI_TIMEOUT_MS` | Délai maximal par appel (défaut 30 s) |

Un dépôt engage la société, déclenche une facturation et n'est plus annulable
après signature : il faut **à la fois** des identifiants et `INPI_DEPOT_REEL=1`
pour que quoi que ce soit parte à l'INPI.

Créer les tables une fois dans le projet Supabase :

```bash
# SQL editor Supabase → coller scripts/schema-formalites.sql
```

### Tests

```bash
npm run test:formalites   # référentiels, contrôles, délais, payloads des 8 formalités
npm run test:api          # parcours complet des routes sur une base en mémoire
```

Aucun des deux n'a besoin du réseau ni de Supabase. Ce qui ne peut pas être
testé hors ligne — la réponse réelle du guichet unique à un premier dépôt —
se vérifie sur l'environnement de démonstration de l'INPI (`INPI_GU_ENV=demonstration`,
compte de démo dédié) avant tout passage en production.

## Hors périmètre MVP (conforme au cahier des charges)

Signature électronique, data room, facturation électronique DGFiP, RPVA,
connecteur mail (P2 — restera optionnel et déconnectable).
