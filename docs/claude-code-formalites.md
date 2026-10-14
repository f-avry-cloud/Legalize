# Formalités avec Claude Code (cloud)

Les formalités se traitent dans des **sessions Claude Code dans le cloud**,
lancées depuis l'onglet **Code** de l'app Claude (iPhone, Windows) ou depuis
claude.ai/code. Elles tournent sur un ordinateur d'Anthropic : le PC du cabinet
peut être éteint.

- **Une session = un dossier**, nommée « Société – formalité ».
- **Registre et tableau de suivi** dans OneDrive : `Formalités/registre-formalites.json`
  (tenu par Claude) et `Formalités/Suivi des formalités.xlsx` (pour l'avocat).
- **Chaque matin**, une exécution programmée actualise les statuts et envoie
  l'e-mail de suivi.
- **Signature et paiement** : toujours par l'avocat, sur le portail du Guichet unique.

## 1. Créer l'environnement « Formalités » (une fois)

Sur claude.ai/code, menu de l'environnement → nouvel environnement :

| Réglage | Valeur |
|---|---|
| Nom | `Formalités` |
| Accès réseau | **Custom**, en cochant « Also include default list of common package managers » |
| Domaines autorisés | `guichet-unique.inpi.fr`<br>`guichet-unique-demo.inpi.fr`<br>`registre-national-entreprises.inpi.fr` |
| Variables d'environnement | voir ci-dessous |

```
INPI_GU_ENV=demonstration
INPI_GU_USERNAME=<identifiant e-procédures, compte de démonstration>
INPI_GU_PASSWORD=<mot de passe>
INPI_RNE_USERNAME=<identifiant data.inpi.fr>
INPI_RNE_PASSWORD=<mot de passe>
INPI_DEPOT_REEL=1
```

- Commencer sur l'environnement de **démonstration** de l'INPI (comptes
  distincts de la production). Une fois un dossier d'essai concluant, passer
  `INPI_GU_ENV=production` avec les identifiants de production.
- Sans `INPI_DEPOT_REEL=1`, tout reste en simulation.
- Les variables d'un environnement sont lisibles par quiconque l'utilise : ne
  partagez pas cet environnement.

## 2. Ouvrir un dossier (depuis l'iPhone)

Onglet **Code** → nouvelle session sur le dépôt **Legalize**, environnement
**Formalités** → joindre les PDF et écrire, par exemple :

> Nomination de Mme Claire Durand comme présidente d'Horizon SAS (SIREN 552 100 554), PV du 10 octobre ci-joint.

Claude lit les actes, contrôle, présente le récapitulatif ; il n'enregistre
qu'après « je confirme ».

## 3. Programmer le suivi du matin (une fois)

Créer une **routine** (exécution programmée) sur le dépôt Legalize, environnement
**Formalités**, connecteur **Microsoft 365** activé, du lundi au vendredi vers
7 h 45, avec cette consigne :

> Suivi quotidien des formalités : applique la section « Suivi quotidien » de la skill dossier-formalite et envoie l'e-mail à favry@lce-avocats.com.

## Confidentialité

- Rien de ce qui concerne un client n'est versionné (voir `.gitignore` et
  `CLAUDE.md`) ; les fichiers d'un dossier ne vivent que dans la session et dans
  OneDrive.
- Le dépôt Legalize étant public, mieux vaut le passer en **privé** sur GitHub
  (et installer l'application GitHub de Claude dessus).

## Outil

`node scripts/gu.js` — voir l'en-tête du fichier. Test : `npm run test:gu`.
