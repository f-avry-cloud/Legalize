# Connecteur Claude — Guichet unique

Le connecteur rend le moteur INPI de Legalize pilotable depuis une conversation
avec Claude (app iPhone, Windows, web), dans un Projet « Formalités » à raison
d'une conversation par dossier. Claude lit les actes, contrôle, puis enregistre
la formalité sur le Guichet unique au nom du compte mandataire. **L'avocat signe
et paie ensuite sur le portail** : le connecteur n'a, volontairement, aucun outil
de signature, de paiement ni de suppression.

## Ce que voit Claude

| Outil | Rôle | Écrit au GU ? |
|---|---|---|
| `lister_types_formalites` | Les 8 formalités prises en charge, évènement et délai | non |
| `exigences_formalite` | Champs à renseigner (valeurs, formats) et pièces exigées | non |
| `rechercher_entreprise`, `fiche_entreprise` | État actuel au RNE | non |
| `controler_formalite` | Contrôles bloquants / alertes / délai, aperçu lisible | non |
| `ouvrir_depot_pieces` | Lien (7 jours) où l'avocat dépose ses PDF | non |
| `pieces_recues` | PDF déjà déposés pour le dossier | non |
| `enregistrer_formalite` | Transmet formalité et pièces, **après accord explicite** (`confirmation_avocat: true`) et seulement si aucun contrôle bloquant ne subsiste | **oui** |
| `statut_formalite`, `lister_formalites` | Suivi : statut, action attendue, régularisations | non |

Le connecteur est sans état : Claude lui redonne à chaque appel le type, le
SIREN et les réponses. Seules les pièces transitent par un bucket privé, et
sont effacées dès que le Guichet unique les a reçues.

## Sécurité

- **L'URL du connecteur est la clé** : `https://<hôte>/api/mcp/<CONNECTEUR_SECRET>`.
  Ne la communiquez à personne. Pour la révoquer, changez `CONNECTEUR_SECRET`
  sur Vercel et redéployez, puis remplacez l'URL dans Claude.
- L'URL apparaît dans les journaux de requêtes de Vercel : réservez l'accès au
  projet Vercel aux seules personnes de confiance.
- Sans `CONNECTEUR_SECRET` (ou s'il fait moins de 32 caractères), toutes les
  routes du connecteur répondent 404 : il est fermé par défaut.
- Les liens de dépôt des pièces sont signés (HMAC dérivé du secret), limités
  à un dossier et à la liste de pièces attendues, et expirent après 7 jours.
- Le navigateur n'écrit dans le stockage que par une URL signée émise pour un
  fichier précis ; il ne voit jamais la clé secrète de Supabase.
- Le reste de l'application garde son authentification : le connecteur ne
  donne accès à aucune donnée de Legalize (sociétés, dossiers, documents).
- Le dépôt réel reste soumis au garde-fou existant `INPI_DEPOT_REEL=1`. Sans
  lui, tout se déroule en **simulation** et Claude le signale.

## Mise en service

1. **Supabase** — exécuter `scripts/schema-connecteur.sql` (éditeur SQL du
   projet). Copier la **clé secrète** du projet (Project Settings → API Keys →
   Secret key, `sb_secret_…`).
2. **Vercel** — variables d'environnement du projet, puis **redéployer** :

   | Variable | Valeur |
   |---|---|
   | `CONNECTEUR_SECRET` | chaîne aléatoire d'au moins 32 caractères, ex. `openssl rand -hex 32` |
   | `SUPABASE_SECRET_KEY` | la clé secrète copiée à l'étape 1 |
   | `INPI_GU_USERNAME`, `INPI_GU_PASSWORD` | compte e-procédures mandataire (déjà utilisés par Legalize) |
   | `INPI_RNE_USERNAME`, `INPI_RNE_PASSWORD` | compte data.inpi.fr (déjà utilisés par Legalize) |
   | `INPI_GU_ENV` | `demonstration` pour les essais, puis `production` |
   | `INPI_DEPOT_REEL` | `1` quand les essais sont concluants |
   | `CONNECTEUR_URL_PUBLIQUE` | facultatif, ex. `https://legalize-rho.vercel.app` |

3. **Claude** — Personnaliser → Connecteurs → « + » → *Ajouter un connecteur
   personnalisé* ; nom « Guichet unique », URL
   `https://legalize-rho.vercel.app/api/mcp/<CONNECTEUR_SECRET>`. Sur une offre
   Team ou Enterprise, c'est le propriétaire de l'organisation qui l'ajoute.
4. **Projet « Formalités »** — y activer le connecteur et la skill
   `formalites-guichet-unique`.

## Essais

```bash
npm run test:connecteur   # protocole MCP réel, en simulation, stockage en mémoire
```

Avant la production : faire un dossier complet sur l'environnement de
**démonstration** de l'INPI (comptes distincts), vérifier la formalité sur le
portail de démonstration, puis la supprimer.

## Limites connues

- Les pièces d'un dossier abandonné restent dans le bucket : les purger de temps
  en temps depuis le tableau de bord Supabase (Storage → `connecteur-pieces`).
- Pas de formalité hors des 8 du catalogue (le parcours multi-évènements de
  Legalize n'est pas exposé).
- Les réponses aux régularisations ne passent pas encore par le connecteur :
  Claude les prépare, l'avocat les dépose sur le portail.
