# Connecteur « Guichet unique » — Claude gestionnaire de formalités

Le connecteur permet à Claude (claude.ai, application mobile, Claude Code) de mener une formalité
jusqu'à son enregistrement au Guichet unique de l'INPI, **hors de l'interface Legalize**, en
réutilisant le moteur de l'application : règles de pièces, contrôles, dépôt, suivi.

Les dossiers ouverts par Claude portent l'origine `assistant`. Ils se consultent dans l'onglet
**Suivi Formalités AI** de Legalize, en lecture seule, et n'apparaissent pas dans l'écran
« Formalités INPI » classique.

## Mise en service (une fois)

1. **Vercel → projet legalize → Settings → Environment Variables** (Production), ajouter :
   - `SUPABASE_SERVICE_ROLE_KEY` : la clé `service_role` du projet Supabase
     (Supabase → Project Settings → API Keys). Elle ne doit jamais quitter Vercel.
   - `MCP_GU_JETON` : une longue chaîne aléatoire (au moins 24 caractères, 40 conseillés),
     par exemple produite par un gestionnaire de mots de passe. C'est le secret de l'adresse
     du connecteur.
   - Vérifier `INPI_GU_ENV` (`production`) et `INPI_DEPOT_REEL` (`true` pour des dépôts réels ;
     sinon tout est simulé et Claude le signale).
   - Redéployer.
2. **claude.ai → Paramètres → Connecteurs → Ajouter un connecteur personnalisé** :
   - nom : `Guichet unique` ;
   - adresse : `https://legalize-rho.vercel.app/mcp/<MCP_GU_JETON>`.
3. Dans une conversation, activer le connecteur. Avec la skill « formalites-guichet-unique »,
   Claude suit le déroulé complet.

Changer `MCP_GU_JETON` dans Vercel révoque immédiatement l'ancienne adresse.

## Outils

| Outil | Rôle |
|---|---|
| `rechercher_entreprise`, `fiche_entreprise` | Registre national des entreprises |
| `catalogue_operations` | Opérations disponibles (codes évènements) |
| `exigences_formalite` | Questions, champs et pièces exigés, sans créer de dossier |
| `ouvrir_depot_pieces` | Ouvre (ou met à jour) le dossier et rend un lien de dépôt des PDF, valable 7 jours |
| `renseigner_formalite` | Complète le dossier (qualification, valeurs) |
| `pieces_recues` | Pièces reçues et manquantes |
| `controler_formalite` | Bloquants, alertes, échéance, mode simulation |
| `enregistrer_formalite` | Transmission au guichet, **uniquement avec `confirmation_avocat: true`** |
| `statut_formalite`, `lister_formalites` | Suivi (statut relu auprès de l'INPI, régularisations, journal) |

Aucun outil ne signe ni ne paie : la signature et le paiement restent sur le portail.

## Pièces

Les PDF joints à une conversation ne peuvent pas être transmis par un outil. Claude remet un lien
`https://legalize-rho.vercel.app/depot/<jeton>` : l'avocat y dépose les PDF (10 Mo maximum chacun),
depuis un téléphone ou un ordinateur. Les fichiers vont directement du navigateur au stockage
Supabase par une adresse d'envoi signée, puis le serveur vérifie qu'ils sont lisibles avant de les
inscrire au dossier. Le lien est conservé sous forme d'empreinte, expire au bout de 7 jours, est
remplacé par tout nouveau lien du même dossier et se ferme une fois le dossier transmis.

Le connecteur Microsoft 365 de Claude ne donne accès qu'au texte des pièces jointes Outlook, pas aux
fichiers : Claude peut y lire les données d'un acte, mais le PDF doit passer par le lien de dépôt.

## Garde-fous

- Adresse MCP protégée par `MCP_GU_JETON` (comparaison à temps constant ; jeton trop court = fermé).
- Sans `SUPABASE_SERVICE_ROLE_KEY`, le connecteur et la page de dépôt répondent 503.
- Le connecteur ne modifie que ses propres dossiers (origine `assistant`) ; un dossier ouvert dans
  Legalize se modifie dans Legalize.
- Un dossier déjà transmis ne se retransmet pas.

## Code

- `src/connecteur/service.js` : outils.
- `src/connecteur/mcp.js` : protocole MCP (HTTP, sans état), `POST /mcp/:jeton`.
- `src/connecteur/depot.js` : page et API de dépôt, `/depot/:jeton`.
- `src/routes-formalites-ai.js`, `public/formalites-ai.js` : onglet Suivi Formalités AI.
- Tests : `node scripts/test-connecteur.js`.
