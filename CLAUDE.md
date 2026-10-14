# Legalize

Logiciel métier d'un cabinet d'avocats (droit des affaires) : Express + Supabase,
déployé sur Vercel. Le module INPI (`src/inpi/`) parle au Guichet unique et au RNE.

## Deux usages de ce dépôt dans Claude Code

1. **Développement de l'application** : code, tests (`npm run test:formalites`,
   `test:api`, `test:connecteur`, `test:gu`…), pull requests.
2. **Formalités d'un client** : quand la session porte sur une formalité
   d'entreprise (nomination, transfert de siège, capital, dépôt des comptes…)
   ou sur le suivi des formalités, suivre la skill **dossier-formalite**
   (`.claude/skills/dossier-formalite/SKILL.md`) et l'outil `scripts/gu.js`.
   Dans ce cas, ne modifie pas le code de l'application.

## Règles

- **Aucune donnée de client dans git** : `dossiers/`, registres, `suivi/`, PDF
  et Excel sont ignorés et doivent le rester. Le dépôt peut être public.
- Ne jamais signer, payer ni supprimer une formalité au Guichet unique.
- Le dépôt réel n'a lieu qu'avec des identifiants INPI et `INPI_DEPOT_REEL=1` ;
  sinon tout est simulé, et il faut le dire.
- Écrire en français, code compris (noms, commentaires, messages).
