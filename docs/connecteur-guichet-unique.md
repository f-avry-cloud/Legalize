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
| `ouvrir_depot_pieces` | Ouvre (ou met à jour) le dossier et rend un lien de dépôt des PDF, valable 7 jours ; rappelé, il garde le lien en cours (`nouveau_lien: true` pour le remplacer) |
| `renseigner_formalite` | Complète le dossier (qualification, valeurs) ; lève l'exigence d'un champ sur instruction de l'avocat (`exigences_champs`) |
| `pieces_recues` | Pièces reçues et manquantes |
| `controler_formalite` | Bloquants, alertes, échéance, mode simulation |
| `enregistrer_formalite` | Transmission au guichet, **uniquement avec `confirmation_avocat: true`** |
| `transmettre_pieces` | Dépose sur une formalité enregistrée les pièces que le guichet n'a pas encore ; sur accord de l'avocat. Idempotent : les pièces jointes à la création ne repartent pas. Rapprochement par code PJ, puis taille et nom normalisé comme le guichet (accents retirés, espaces en « _ », parenthèses supprimées, « .docx.pdf » → « _docx.pdf »). La liste du guichet est relue : `depose: true` seulement quand toutes les pièces y sont confirmées ; les doublons sont listés (`en_trop`). La synthèse est régénérée après un ajout (`GET /api/formalities/{id}/refresh`, contrat §6.4) |
| `retirer_piece_guichet` | Retire une pièce rattachée à la formalité au guichet (doublon, erreur), par son identifiant, avant signature et sur accord de l'avocat : suppression (`DELETE`), ou à défaut invalidation (`PUT …/remove`, la pièce reste listée, marquée invalidée). Synthèse régénérée ensuite. Les synthèses PJ_99 / PJ_119 ne se retirent pas |
| `statut_formalite`, `lister_formalites` | Suivi (statut relu auprès de l'INPI, régularisations, journal) |
| `reclasser_piece`, `retirer_piece`, `catalogue_pieces` | Ranger une pièce reçue sous la bonne ligne ou un autre type officiel |
| `lister_pieces_deposees` | Actes et comptes annuels déposés au registre pour un SIREN (lecture seule) |
| `telecharger_acte` | PDF d'un acte et son texte, par reconnaissance de caractères s'il est numérisé (lecture seule) |
| `annonces_bodacc` | Annonces publiées au BODACC pour un SIREN (données ouvertes de la DILA, sans compte) ; pour une TUP, `controler_formalite` y cherche la publication de la dissolution et calcule la fin du délai d'opposition |
| `telecharger_comptes` | PDF des comptes annuels, texte et données saisies par l'INPI (postes libellés, chiffres clés) ; comptes confidentiels non récupérés (lecture seule) |

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

## Pièces déposées au registre

Sources : documentations INPI « Accéder aux Actes d'une entreprise » (v4.0, juin 2025) et « Accéder aux
comptes annuels PDF et saisis » (v5, juin 2025). Le compte INPI du connecteur (`INPI_RNE_USERNAME`) doit être
habilité aux actes et comptes annuels ; à défaut l'API répond 403 et l'outil le dit. Le quota journalier de
l'INPI est de 10 000 appels ou 10 000 Mo.

- Les PDF sont conservés dans le stockage du cabinet (`registre/actes/…`, `registre/comptes/…`) et remis par
  un lien valable une heure ; un PDF de moins de 1,5 Mo est aussi joint à la réponse.
- Le texte d'une page sans couche texte est obtenu par reconnaissance de caractères (Tesseract, français) :
  environ une seconde par page ; au-delà de 35 secondes ou de 60 000 caractères, l'outil rend les pages
  restantes, à lire en le rappelant avec `pages`.
- Les libellés des postes comptables (`src/inpi/data/postes-comptes.json`) sont tirés de la section E de la
  documentation des comptes annuels : `node scripts/build-postes-comptes.js <texte de la documentation>`.

## Brouillon signable sur le portail

Le portail du guichet n'ouvre la signature que si la société est complète, même pour ce qui ne change pas
(« lors de votre première modification, des informations complémentaires »). Constaté sur COUVOIR JOSSET :

- **personne morale dirigeante ou commissaire aux comptes** : le registre public ne diffuse que l'identifiant
  de la personne physique qui la représente. Son identité est demandée (« Données du registre à compléter »,
  champ `representant_<rang>`) : nom de naissance, prénoms, sexe, date, commune et pays de naissance,
  nationalité, domicile avec la voie. Elle se lit sur l'extrait Kbis de la société représentée (ou, pour un
  commissaire aux comptes, sur sa lettre de mission ou son rapport) ;
- **pays de la personne morale** : code « FRA » pour une société inscrite par son SIREN (le libellé « FRANCE » est
  refusé par l'API : « Choisissez un code pays valide ») ; sans lui, le portail
  juge sa forme juridique invalide ;
- **« Avez-vous une autre fonction ? »** : non, chaque fonction étant un pouvoir distinct du registre ;
- **caractères** : apostrophe et guillemets typographiques, points de suspension, tirets longs, puces et
  retours à la ligne sont remplacés avant l'envoi (`src/inpi/texte-guichet.js`) ; l'état antérieur et les
  pièces ne sont pas retouchés.

## Catégorie d'activité

La catégorie (champ `categorie` de `c_activite` pour une création, de 54PMF et de 61PMF) doit être une feuille de la
nomenclature du guichet (`src/inpi/data/categories-activite.json`, relevée sur `GET /api/data_dictionary/category_activities`,
date dans `_source`). Formes admises :

- le code de la feuille, `"07-02-03-01"`, ou ses huit chiffres `"07020301"` (« 00 » pour un niveau absent : `"01020000"`) ;
- `{"categorisationActivite1": "07", "categorisationActivite2": "02", "categorisationActivite3": "03", "categorisationActivite4": "01"}`
  (accompagné de `code`, les deux doivent concorder) ;
- un mot (« restauration ») : le dossier rend `categories_candidates` (codes et libellés des niveaux) sans en retenir
  aucune. L'avocat choisit, puis le code est renseigné.

Une catégorie reconnue est rangée sous son code ; ses codes, libellés et sa forme d'exercice sont conservés
(`reponses._categorie`, avec la version de la nomenclature), affichés (`categorie_resolue`) et journalisés. Une catégorie
non reconnue n'est pas « remplie » : `controler_formalite` la bloque, et la liasse n'est pas construite (erreur 422)
plutôt que transmise sans catégorie. La liasse porte `categorisationActivite1…n` (les niveaux existants) et la
`formeExercice` déduite de la catégorie.

## Bénéficiaires effectifs et dirigeant personne morale

Le guichet refuse les modalités de contrôle en texte libre (« Choisissez un type d'origine valide »). Chaque
bénéficiaire porte un objet `controle`, d'où le connecteur calcule le bloc `modalite` du guichet
(`src/inpi/controle-be.js`, BlocModaliteControle du dictionnaire de données) :

```json
{"capital": {"direct": {"pleine_propriete": 49}},
 "votes":   {"direct": {"pleine_propriete": 49}}}
{"capital": {"indirect_personnes_morales": {"pleine_propriete": 25.5}},
 "votes":   {"indirect_personnes_morales": {"pleine_propriete": 25.5}}}
```

- Détentions : `direct`, `indirect_personnes_morales`, `indirect_indivision` ; droits : `pleine_propriete`,
  `nue_propriete` (capital et votes), `usufruit` (votes seulement, comme le dictionnaire).
- Autres critères : `autres` = `pouvoir_decision_ag`, `pouvoir_nomination`, `autres_moyens`, `representant_legal`.
- Codes `modalitesDeControle` : « 1 » au-delà de 25 % du capital ou des votes (comme une création validée par le
  portail), « 5 » pouvoir de nomination, « 6 » autre moyen de contrôle, « 0 » représentant légal à défaut. Tous les
  autres champs du bloc partent à 0 ou false.
- `controler_formalite` bloque un texte libre, un code inconnu, un pourcentage hors de 0–100, un total supérieur à
  100 % et un bénéficiaire sans aucun critère (25 % tout juste ne suffit pas). L'écran Legalize (cases à cocher et
  pourcentages) reste accepté ; seuls les codes du référentiel partent.

Dirigeant personne morale : `forme_juridique_code` est un code du référentiel (5710 pour une SAS, pas « SAS »), le
pays de la société part en code « FRA » et le registre en code « 1 » (RCS, référentiel `registre` ; champ resté vide
sur le portail pour LGZ-2026-00052, `lieuRegistre` portant la ville du greffe).

## Valeurs par défaut

Un champ laissé à sa valeur par défaut (exercice permanent, pas de salarié, IS réel simplifié, TVA réel simplifié, pas
d'ACRE, capital fixe, affiliation « non applicable »…) est rendu `a_confirmer` et n'est pas « rempli » :
`controler_formalite` le bloque et `enregistrer_formalite` refuse le dossier tant que l'avocat ne l'a pas confirmé par
`renseigner_formalite`. Les sous-champs codés d'une personne (affiliation sociale, sexe, nationalité) sont contrôlés
contre le référentiel ; les valeurs admises figurent dans `valeurs_admises`.

## Lien de dépôt

`ouvrir_depot_pieces` rappelé avec une référence garde le lien déjà remis (`lien_depot: null`) ; `nouveau_lien: true`
en émet un autre, qui remplace l'ancien. Pour compléter un dossier, `renseigner_formalite` suffit.

## Lever l'exigence d'un champ (décision de l'avocat)

Un champ « requis » que le guichet n'exige pas pour un dossier donné (par exemple le représentant d'un commissaire
aux comptes personne morale inchangé) peut être levé, **sur instruction expresse de l'avocat seulement**, par le
paramètre `exigences_champs` de `renseigner_formalite` ou `ouvrir_depot_pieces` :

```json
[{ "champ": "_registre.representant_1", "requis": false, "motif": "Représentant du CAC inchangé, non exigé par le portail, décision de l'avocat" }]
```

- Le motif est obligatoire ; `{"champ": …, "requis": true}` rétablit l'exigence.
- Seules les « Données du registre à compléter » (groupe `_registre`) peuvent être levées. Sont refusés : le SIREN,
  la date de décision, la donnée qui fait l'objet du changement (ex. `MAJDIR.maj_0`), les champs des opérations, une
  donnée déjà refusée par le guichet, et les pièces (qui gardent `typologie.manuel`).
- Une levée ne couvre que l'absence : une donnée saisie mais erronée (clé invalide, changement identique) reste bloquante.
- Effet : le bloquant devient une alerte de `controler_formalite` (« exigence levée à la demande de l'avocat — motif :
  … ») et figure dans `exigences_levees`, à reprendre dans le récapitulatif de validation. Chaque levée et chaque
  rétablissement sont inscrits au journal du dossier.
- À l'enregistrement, un champ levé vide ou incomplet n'est pas transmis : aucune valeur fictive.
- Si le guichet refuse malgré tout la liasse sur ce champ, l'erreur le dit en clair et l'exigence est rétablie d'office.
- `enregistrer_formalite` exige toujours `confirmation_avocat: true`.

Stockage : `typologie.manuel_champs` (`{"<groupe>.<name>": {"requis": false, "motif", "date"}}`).

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
- `src/inpi/rne-documents.js`, `src/inpi/texte-pdf.js` : pièces déposées au registre, texte et OCR.
- Tests : `node scripts/test-connecteur.js`, `node scripts/test-registre.js`, `node scripts/test-categorie-activite.js`, `npm run test:portail` (API INPI simulée).
- Écarts avec la pratique du cabinet relevés dans ses synthèses du guichet : `docs/ecarts-syntheses.md` ; tests `npm run test:pratique`.

## Formalité sortie du compte mandataire

Deux constats, distingués dans le journal et les réponses :

- **supprimée** : le guichet renvoie un statut de suppression ;
- **introuvable** : la fiche répond 404 et la liasse est absente de tout le
  compte mandataire. C'est aussi ce que produit une formalité « À signer »
  **ramenée en brouillon sur le portail** (constaté trois fois le 3/11 sur
  LGZ-2026-00052) : le brouillon du portail perd les pièces jointes par l'API.

Dans les deux cas le connecteur ne supprime rien au guichet : il constate une
absence. Le dossier repasse « non enregistré » (Brouillon, étape Validation),
données et pièces conservées ; l'ancienne formalité est au journal et dans
`typologie._formalites_disparues`. Si elle est « introuvable »,
`enregistrer_formalite` exige `brouillon_portail_verifie: true` : l'avocat a
vérifié qu'aucun brouillon ne subsiste sur procedures.inpi.fr (doublon).

`enregistrer_formalite` et `transmettre_pieces` rappellent de signer depuis
« À signer » sans ramener la formalité en brouillon. L'historique des statuts
n'est pas un critère (l'INPI le sert encore après la disparition). L'état est
relu au guichet par `statut_formalite`, `controler_formalite`,
`consulter_formalite_guichet`, `renseigner_formalite`, `enregistrer_formalite`
et `retirer_piece_guichet`.

Un brouillon du portail se termine **sur le portail** : y rejoindre les pièces (chacune une fois), corriger au
besoin, puis signer et payer. Précédent : COUVOIR JOSSET, déposé par le connecteur, ramené en brouillon, complété
et signé sur le portail, validé le 21/10 sous une nouvelle liasse (J00291641058), de nouveau visible du compte.

### Pièces : ce que dit le contrat d'interface (06/2026)

- **Envoi** (§3.3) : les PDF partent en base64 dans `content.piecesJointes` de la formalité ; le guichet les garde
  (sous ses propres noms). Après l'enregistrement, le connecteur relit seulement la liste : **aucun envoi
  automatique** (le second envoi du 3/11 a produit dix doublons). Une pièce manquante se transmet ensuite avec
  `transmettre_pieces`, sur accord de l'avocat, la formalité restant « À signer ».
- **Ajout** (§3.11) : `POST /api/formalities/{id}/attachments`, puis **régénération de la synthèse** (§6.4,
  `GET /api/formalities/{id}/refresh`), sans quoi la signature est impossible.
- **Retrait** (§3.12) : `DELETE /api/formalities/{id}/attachments/{pieceId}` supprime la pièce, entre le dépôt et
  la signature ; `PUT …/{pieceId}/remove` ne fait que l'**invalider** (elle reste listée, « plus à prendre en
  compte » par le valideur ; seule voie en régularisation). Le connecteur appelait `remove` : d'où le retrait
  « accepté mais pièce toujours listée » du 3/11 (412125056, J00297506073). Il supprime désormais d'abord et
  n'invalide que si la suppression est refusée (code 5003 : pièce absente du content). Une pièce invalidée ne
  compte plus dans le rapprochement (`invalidees`).
- **Mise à jour avant signature** (§3.4) : `PUT /api/formalities/{id}` avec le même JSON qu'à la création
  (sans redonner les base64) ; refusé (400) pour une formalité de modification. Pas encore proposé par le
  connecteur : c'est la voie pour corriger une création « À signer » sans passer par le brouillon du portail.
- **Brouillons** : l'API ne documente que `PUT /api/formality_drafts/{id}/transfer_agent` ; un brouillon du
  portail n'est ni listable ni supprimable par le connecteur.

## Exigences du portail (relevé du 5/11/2026)

Relevé fait sur le portail avec trois brouillons fictifs, jamais transmis (création de SAS,
modification et dissolution d'une SAS dont le président est une personne morale), et lecture des
référentiels que le portail charge. En modification et en cessation, le portail ne bloque sur aucune
pièce ; en création, il en exige sept, chacune sous son type. Une pièce envoyée sous un autre type que
celui de la rubrique y manque : à la signature d'une création, ou si la formalité est ramenée en
brouillon, le portail la redemande.

Appliqué au connecteur :

- **Création (01M, 02M, 03M)** : copie de l'insertion (PJ_09) exigée ; l'attestation de parution
  (PJ_08) n'est plus que facultative.
- **Création d'une SAS ou SASU avec apports en numéraire** : certificat du dépositaire (PJ_06) et
  attestation de dépôt des fonds (PJ_180), chacun sur sa ligne et sans document de substitution (le
  même document de la banque peut être joint sur les deux). SARL, SA et autres formes : inchangé, non
  relevé.
- **15M** : décision de l'assemblée (PJ_54), rapport du commissaire aux apports (PJ_04) et, pour une SA
  ou une SAS, certificat du dépositaire (PJ_56). PJ_155, PJ_156 et PJ_163, réservées au dépôt d'actes
  (DA) par le dictionnaire, ne sont plus demandées.
- **13M** : rapport du commissaire à la transformation sous PJ_91 (et non PJ_160) ; PJ_157 (DA) n'est
  plus demandée.
- **22M** : lieu de liquidation obligatoire (proposé « au siège », à confirmer) ; date de cessation
  d'activité obligatoire sans poursuite d'activité.
- **Dirigeant personne morale** : « Souhaitez-vous désigner un représentant permanent ? »
  (`designerRepresentantPermanent`, GU_POU054) est transmis : oui quand l'identité du représentant
  part avec la liasse ; non pour une nomination sans représentant ; pour un dirigeant déjà inscrit, rien
  n'est deviné sans identité.
- **Date de première clôture** : déjà calculée et transmise quand elle n'est pas saisie.
- **Complément de pièces avant signature** : une formalité « À signer » à laquelle manque une pièce
  exigée par le portail se complète sans brouillon. `ouvrir_depot_pieces`, rappelé avec la seule
  référence, ouvre un lien de complément : les pièces déjà au dossier y sont verrouillées, les données
  ne se modifient pas. Les PDF déposés partent ensuite avec `transmettre_pieces`, sur accord de
  l'avocat (§3.11, puis régénération de la synthèse, §6.4). Fermé dès la signature.
- **Contrôle** : `npm run test:portail` échoue si une opération demande une pièce dont le type n'est pas
  « PM » au dictionnaire, hors exceptions nommées que le relevé n'a pas couvertes : 41M (PJ_161, PJ_175,
  PJ_176, PJ_199), 26M (PJ_236), 62M (PJ_53), 11M (PJ_97, absente du dictionnaire).

Écarts du relevé non encore traités : régime fiscal selon la forme (SAS : impôt sur les sociétés ou
option sociétés de personnes) ; origine du fonds selon la catégorie d'activité ; rôles (auditeur de
durabilité, personnes ayant le pouvoir d'engager) ; une date d'effet par évènement (`dateEffetXX`) au
lieu de la date de décision commune ; 29M (fusion simplifiée de l'absorbante, première date de clôture) ;
12M (activités rattachées à l'établissement, 61PMF / 67PMF) ; 35M (PJ_03 acceptée) ; 38F (bénéficiaires
effectifs à ressaisir) ; rubriques du portail (`sousTypeDocument`, 343 valeurs au dictionnaire, non
envoyées). Opérations non relevées sur le portail : création de SARL, EURL, SA et SCI ; 19M, 34M, 51M,
55PM, 56PMF, 63M, 80PMF, 28M, 40M, 41M, 42M.

## Traces

Chaque échange avec l'API du guichet (et chaque échec du registre) est tracé dans `guichet_traces` : méthode,
chemin, statut HTTP, durée, forme de la requête (clés, codes et tailles des pièces) et de la réponse
(identifiants, statuts, nombre d'éléments, refus par champ). Jamais de valeur saisie, de nom, de contenu de
fichier, d'identifiant de connexion ni de jeton. Lecture avec la clé de service ; purge au-delà de 30 jours.

```sql
select cree_le, methode, chemin, statut, duree_ms, reponse from guichet_traces order by cree_le desc limit 50;
```

## Document de synthèse

`/api/formalities/{id}/synthesis` refuse `Accept: application/pdf` (406). La
synthèse est lue comme pièce jointe de la formalité (PJ_99, puis PJ_119, via
`/api/attachments/{id}/file`), puis à défaut sur `/synthesis` en JSON.
