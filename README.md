# Legalize — Logiciel métier droit des affaires / corporate (MVP)

Outil métier pour avocat / cabinet en droit des affaires et corporate, centré sur
l'**efficacité de production documentaire** : tout l'effort est investi en amont
(templates, logique conditionnelle, données structurées) pour que la production
nécessite un minimum d'intervention manuelle.

## Démarrage

```bash
npm install
npm run seed        # données de démonstration (optionnel)
npm start           # http://localhost:3000
```

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

## Architecture

```
server.js               Express (API + fichiers statiques)
src/db.js               SQLite (better-sqlite3) — schéma Société/Groupe/Opération/Document/Checklist
src/definitions.js      Référentiel métier : types d'opérations, variables, checklists, templates
src/docx.js             Construction .docx (OOXML) + extraction de texte (.docx/.pdf)
src/routes.js           API REST
src/services/generation.js   Génération en un clic (contexte de fusion + docxtemplater)
src/services/compare.js      Comparaison de versions (diff mot à mot)
scripts/                seed, build-templates, smoke-test
public/                 Interface web (vanilla JS, sans build)
storage/                Documents générés — arborescence Société/Opération (gitignoré)
data/                   Base SQLite (gitignoré)
```

### Personnalisation des templates

`npm run build:templates` écrit les templates dans `templates/generated/`
(`<type>__<document>.docx`). Un template retravaillé à la main (mise en forme du
cabinet, clauses maison) **est utilisé en priorité** par le moteur de
génération, tant que les balises `{variable}` / `{#condition}…{/condition}` /
`{#liste}…{/liste}` sont conservées. Les variables auto-injectées depuis la
fiche société sont listées en tête de `src/definitions.js`.

### Stockage

Les documents sont écrits dans une arborescence lisible
`storage/<société>/<n°-opération>/` : le dossier peut être synchronisé tel quel
avec l'arborescence existante du cabinet (OneDrive/serveur). Variables
d'environnement : `PORT`, `LEGALIZE_DATA_DIR`, `LEGALIZE_STORAGE_DIR`.

## Hors périmètre MVP (conforme au cahier des charges)

Signature électronique, data room, facturation électronique DGFiP, RPVA,
connecteur mail (P2 — restera optionnel et déconnectable).
