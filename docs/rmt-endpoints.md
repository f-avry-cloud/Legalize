# Registre des mouvements de titres — spécification des endpoints

Contrat d'interface du module RMT, à lire avant l'implémentation. Il fixe la
sémantique ; la suite de tests du livrable 4 en dérive directement.

## Conventions

- Préfixe `/api/rmt`, sauf la vérification publique d'un extrait, qui vit hors
  de l'API authentifiée (voir *Vérification publique*).
- Réponses JSON. Erreurs `{ "error": "message lisible", "details": … }`, avec
  le code HTTP qui convient : `400` saisie invalide, `403` droit manquant,
  `404` inconnu, `409` conflit d'état, `422` règle métier non satisfaite.
- **Identité.** Le contrôle d'accès général viendra d'une brique ultérieure.
  D'ici là, l'utilisateur courant est résolu par l'en-tête `X-Utilisateur`
  (identifiant) ou, à défaut, le premier compte actif. L'identité sert au
  circuit d'approbation et au journal, pas encore de barrière de sécurité :
  aucun endpoint ne doit *dépendre* de cette résolution pour sa sûreté, et le
  jour où l'authentification arrive, seul le résolveur change.
- **Journal.** Toute écriture, toute certification, toute consultation
  d'extrait certifié produit une ligne `rmt_audit`. C'est une obligation du
  module, pas une option d'implémentation.
- Les dates sont en `YYYY-MM-DD`, les horodatages en ISO 8601 UTC.

## Modèle d'état, en un paragraphe

Une écriture est une identité stable (`rmt_mouvements`) et une suite de
versions (`rmt_mouvement_versions`). **Toute** opération d'écriture crée une
version ; rien n'est jamais écrasé ni effacé, une suppression étant une version
de type `suppression`. Le statut — `CRAYON`, `ENCRE`, `ENCRE_MODIFIEE`,
`ENCRE_SUPPRIMEE` — n'est pas stocké : il se déduit des extraits certifiés qui
couvrent l'écriture. Les endpoints ci-dessous n'ont donc jamais à le mettre à
jour, seulement à le lire.

---

## 1. Société et paramètres

### `POST /api/rmt/societes/:id/activer`
Ouvre un registre pour une société existante.

Corps : `{ forme, titres_numerotes, certifiant_type, certifiant_nom,
certifiant_qualite, clauses: {...}, seuils_surveilles: [10, 25, 50] }`

- `422` si `forme` n'est pas `SA`, `SAS`, `SASU` ou `SCA`. Le message nomme la
  forme refusée et explique que les parts sociales ne se tiennent pas en
  comptes de titres — un registre faux serait pire qu'un refus.
- `409` si un registre existe déjà.

### `GET /api/rmt/societes/:id`
Paramètres, catégories, compteurs, et **l'encart de réconciliation du
capital** : capital porté par la fiche, capital recalculé (Σ titres émis ×
nominal), titres annoncés, titres émis, titres détenus, et les trois écarts.
Un nominal manquant donne `capital_calcule: null` et
`nominal_indetermine: true` — jamais un zéro qui ferait croire à un calcul.

### `PUT /api/rmt/societes/:id/capital`
Corrige l'écart, dans le sens choisi par l'utilisateur.

Corps : `{ sens: "aligner_fiche" | "corriger_registre", capital_social?,
nb_titres?, emissions?: [{ categorie_id, quantite, date_effet, decision }] }`

Aucun sens n'est imposé : l'outil ne sait pas lequel des deux chiffres a
raison.

### `GET|POST|PUT|DELETE /api/rmt/societes/:id/categories[/:catId]`
Catégories de titres. Le nominal est porté ici, non par la société : une
division de nominal peut ne toucher qu'une catégorie.
`DELETE` refusé (`409`) si des écritures y renvoient.

### `GET|POST|DELETE /api/rmt/societes/:id/emissions[/:emId]`
Variations de titres émis, rattachées à une décision sociale. C'est contre ce
cumul que se vérifie l'invariant « Σ soldes = titres émis », et non contre le
champ `nb_titres` de la fiche, qui n'est qu'un reflet.

---

## 2. Titulaires et comptes

### `GET|POST|PUT|DELETE /api/rmt/societes/:id/titulaires[/:tId]`
Personne physique ou morale. `DELETE` refusé si le titulaire tient un compte.

### `GET|POST|PUT /api/rmt/societes/:id/comptes[/:cId]`
Corps : `{ numero, type, titulaires: [{ titulaire_id, quote_part }],
demembrement_id }`

- `type` ∈ `pleine_propriete`, `indivision`, `nue_propriete`, `usufruit`.
- Un compte d'indivision accepte plusieurs titulaires et des quotes-parts.
- `demembrement_id` relie le compte de nue-propriété à celui d'usufruit.
  Sans ce lien, une réunion d'usufruit est indécidable.

### `GET /api/rmt/comptes/:id`
Fiche de compte : identité, écritures au débit et au crédit avec leur statut
crayon/encre, solde par catégorie, mentions actives, historique des soldes.

---

## 3. Écritures — CRUD versionné

### `GET /api/rmt/societes/:id/mouvements`
Paramètres : `?historique=1` inclut les écritures supprimées (affichées
barrées), `?date=YYYY-MM-DD` arrête le registre à une date, `?compte=`,
`?categorie=`.

Chaque écriture renvoie son `statut`, son `numero_version`, son n° d'ordre
d'affichage et, le cas échéant, le dernier extrait qui la couvre.

### `POST /api/rmt/societes/:id/mouvements`
Crée une écriture. Version 1, action `creation`.

Corps : `{ date_inscription, date_effet, nature, categorie_id, quantite,
numeros, compte_debite, compte_credite, prix_unitaire, prix_total,
observations, apres_id? }`

- `apres_id` insère entre deux écritures : l'ordre devient la moyenne des
  ordres voisins. Aucune renumérotation en base ; l'affichage seul renumérote,
  et les identifiants internes ne bougent jamais.
- `nature` ∈ `souscription`, `cession`, `apport`, `donation`, `succession`,
  `fusion_tup`, `demembrement`, `reunion_usufruit`, `conversion`,
  `division_nominal`, `regroupement_nominal`, `annulation`.
- Les incohérences (solde négatif, invariant rompu, justificatif manquant)
  **n'empêchent pas la saisie**. Elles remontent dans la réponse sous
  `anomalies`, et empêcheront la certification.

### `GET /api/rmt/mouvements/:id/impact`
À appeler **avant** d'enregistrer une modification ou une suppression d'une
écriture à l'encre. Renvoie la liste des extraits certifiés qui couvrent
l'écriture, leur date, leur statut et leurs destinataires déclarés.

C'est ce que l'écran affiche pour que l'utilisateur sache ce qu'il déplace
avant de le déplacer. Endpoint en lecture seule, sans effet.

### `PUT /api/rmt/mouvements/:id`
Nouvelle version, action `modification`.

- Écriture `CRAYON` : motif facultatif.
- Écriture `ENCRE` ou `ENCRE_MODIFIEE` : `motif_code` et `motif`
  **obligatoires** ; `422` sinon, avec le rappel des extraits impactés.
- Effet de bord : les extraits couvrant une version antérieure passent
  `devenu_inexact`, et la réponse propose l'émission d'un extrait à jour.

### `POST /api/rmt/mouvements/:id/deplacer`
Réordonnancement (glisser-déposer). Corps : `{ apres_id }` ou `{ avant_id }`.
Crée une version `deplacement` : un déplacement est une écriture de
l'historique, pas un simple tri d'affichage.

### `DELETE /api/rmt/mouvements/:id`
- Écriture `CRAYON` : version `suppression` immédiate. L'écriture reste
  visible en mode historique, barrée.
- Écriture `ENCRE` ou `ENCRE_MODIFIEE` : **`403`**. La suppression passe par
  la demande ci-dessous. Le message le dit explicitement plutôt que de
  renvoyer un refus muet.

### `GET /api/rmt/mouvements/:id/versions`
Historique complet : contenu de chaque version, action, auteur, date, motif.
Sert à la fois à l'affichage de l'historique et à la comparaison.

### `POST /api/rmt/mouvements/:id/restaurer`
Corps : `{ version_id, motif? }`

Rétablit le contenu d'une version antérieure **en créant une nouvelle
version** d'action `restauration`. L'historique n'est jamais tronqué : on
n'efface pas le détour, on le documente.

---

## 4. Suppression d'une écriture à l'encre — double validation

### `POST /api/rmt/mouvements/:id/demande-suppression`
Corps : `{ motif_code, motif }` — tous deux obligatoires.

Enregistre la demande avec un instantané des extraits impactés et de leurs
destinataires. `409` si une demande est déjà en attente.

### `GET /api/rmt/demandes-suppression?statut=en_attente`
File d'approbation.

### `POST /api/rmt/demandes-suppression/:id/approuver`
Réservé au rôle `associe` ; `403` sinon, en nommant le rôle requis.
Crée la version `suppression`, bascule les extraits concernés en
`devenu_inexact`, notifie les destinataires déclarés.

### `POST /api/rmt/demandes-suppression/:id/refuser`
Corps : `{ motif }`. Même rôle. L'écriture reste inchangée.

---

## 5. Mentions et justificatifs

### `GET|POST|PUT|DELETE /api/rmt/comptes/:id/mentions[/:mId]`
Nantissement, séquestre, saisie, inaliénabilité temporaire. Elles grèvent les
titres sans les transférer. Une mention active sur les titres cédés déclenche
une alerte à l'inscription d'une cession.

### `POST /api/rmt/mouvements/:id/justificatifs`
Envoi multipart. `type` ∈ ordre de mouvement, bulletin de souscription,
certificat du dépositaire, acte de donation, attestation notariale, PV,
enregistrement fiscal, agrément, purge de préemption.

### `DELETE /api/rmt/justificatifs/:id` · `GET /api/rmt/justificatifs/:id/fichier`

---

## 6. Contrôles de cohérence

### `GET /api/rmt/societes/:id/anomalies`
Paramètre `?perimetre=` pour restreindre au périmètre d'un futur extrait.

```json
{
  "bloquants": [
    { "code": "solde_negatif", "message": "…", "compte_id": 12,
      "date": "2026-06-30", "mouvement_id": 34 }
  ],
  "alertes": [
    { "code": "clause_agrement", "message": "…", "mouvement_id": 34,
      "acquittee": false }
  ],
  "certifiable": false
}
```

**Bloquants** — jamais pour la saisie, toujours pour la certification :

| code | contrôle |
|---|---|
| `solde_negatif` | solde négatif sur un compte, **à n'importe quelle date** de l'historique : un solde final positif masque une impossibilité survenue en cours d'année |
| `invariant_categorie` | Σ soldes d'une catégorie ≠ titres émis, rattaché aux décisions sociales |
| `justificatif_manquant` | justificatif principal exigé par la nature de l'écriture |
| `numeros_incoherents` | numéros de titres en double ou hors des titres émis, si la société les numérote |

**Alertes** — acquittables, jamais bloquantes, même pour la certification :
`clause_agrement`, `clause_preemption`, `clause_inalienabilite`,
`mention_active`, `enregistrement_fiscal_absent`, `insertion_retroactive`
(date d'inscription antérieure à une écriture déjà à l'encre),
`franchissement_seuil`.

### `POST /api/rmt/alertes/acquitter`
Corps : `{ version_id, code, commentaire }`

L'acquittement est tracé et **ne vaut que pour la version acquittée** : une
nouvelle version rouvre l'alerte. L'outil signale, l'avocat décide — mais la
décision porte sur un état précis, pas sur l'écriture en général.

---

## 7. Certification

### `POST /api/rmt/societes/:id/extraits/previsualiser`
Corps : `{ type, perimetre, date_arrete? }`

Exécute les contrôles sur le périmètre et renvoie le contenu qui serait figé,
sans rien écrire. `certifiable: false` si un bloquant subsiste, avec
l'anomalie en clair.

### `POST /api/rmt/societes/:id/extraits`
Émet l'extrait certifié. `type` ∈ `registre_complet`, `compte_individuel`,
`attestation_inscription`, `table_capitalisation`.

Corps : `{ type, perimetre, date_arrete?, destinataires: [{ nom, qualite,
email }] }`

Déroulé, dans cet ordre, en transaction :
1. contrôles complets sur le périmètre — **`422` si un bloquant subsiste** ;
2. gel du contenu (`contenu` JSON) et enregistrement des versions couvertes
   dans `rmt_extrait_mouvements` — c'est ce qui fait passer les écritures à
   l'encre, par déduction et non par mise à jour ;
3. empreinte SHA-256 du contenu canonique, chaînée à l'extrait précédent ;
4. génération du PDF portant la mention « extrait certifié conforme à l'état
   du registre de travail au [date/heure] » et le QR code ;
5. signature PAdES par le certifiant paramétré pour la société — représentant
   légal ou avocat mandaté ;
6. horodatage, journal d'audit.

Si la signature échoue, **toute la transaction est annulée** : un extrait non
signé mais enregistré ferait passer des écritures à l'encre sans contrepartie.

### `GET /api/rmt/extraits/:id` · `GET /api/rmt/extraits/:id/pdf`
La consultation d'un extrait certifié est journalisée.

### `POST /api/rmt/extraits/:id/revoquer`
Réservé au rôle `associe`. Corps : `{ motif }` obligatoire.

Un extrait révoqué ne couvre plus rien : les écritures qu'il seul couvrait
redeviennent `CRAYON`, sans code de rattrapage, la déduction s'en chargeant.

---

## 8. Comparaison et vérification

### `GET /api/rmt/societes/:id/diff`
Paramètres : `?extrait=ID` ou `?date=YYYY-MM-DD`, exclusifs.

```json
{
  "reference": { "type": "extrait", "id": 7, "date_arrete": "2026-03-01" },
  "ajouts":        [ { "mouvement_id": 41, "resume": "…" } ],
  "modifications": [ { "mouvement_id": 12, "champs": ["quantite"],
                       "avant": {...}, "apres": {...} } ],
  "suppressions":  [ { "mouvement_id": 9, "resume": "…" } ],
  "ecarts_soldes": [ { "compte_id": 3, "avant": 1000, "apres": 1500 } ]
}
```

### `GET /v/:jeton` — **vérification publique, hors API authentifiée**
Le jeton est celui du QR code : long et aléatoire, non devinable, non
énumérable. La page n'expose que ce qui est nécessaire pour vérifier :

- statut actuel — *à jour*, *devenu inexact* (avec la date), *révoqué* ;
- date d'arrêté, date de certification, nom et qualité du certifiant ;
- empreinte, pour comparer avec le PDF détenu.

Jamais le contenu du registre, jamais un nom d'actionnaire. Un tiers vérifie
qu'un document est authentique et toujours exact ; il n'apprend rien d'autre.
Cette consultation est journalisée. Jeton inconnu : `404`, sans distinguer
l'inexistant du révoqué.

---

## 9. Reprise d'un registre papier

### `POST /api/rmt/societes/:id/import/analyser`
Envoi CSV ou XLSX. Renvoie les lignes interprétées, la correspondance des
colonnes, les titulaires et comptes à créer, et les anomalies détectées.
**N'écrit rien.**

### `POST /api/rmt/societes/:id/import/valider`
Corps : `{ lignes: [...], creer_titulaires: true, creer_comptes: true }`

Tout l'historique importé entre au statut `CRAYON`, conformément à la
philosophie du module : la reprise d'un registre papier n'est pas une
certification, et les corrections doivent rester libres jusqu'à la première.
Rejeu complet depuis la constitution, puis rapport d'anomalies.

---

## 10. Sorties documentaires

`GET /api/rmt/…/export?format=pdf|docx` sur :

| chemin | document |
|---|---|
| `mouvements/:id/ordre-mouvement` | ordre de mouvement pré-rempli |
| `societes/:id/registre` | page de registre au format papier, écritures crayon et encre distinguées, pour retranscription |
| `comptes/:id/fiche` | fiche de compte individuel |
| `comptes/:id/attestation` | attestation d'inscription en compte |
| `societes/:id/capitalisation` | table de capitalisation à date, non diluée et diluée |
| `societes/:id/anomalies` | rapport d'anomalies |
| `societes/:id/ecarts` | écarts depuis le dernier extrait certifié |

Chaque export porte la mention que le document est issu d'un **registre de
travail**, et non du registre légal. Seuls les extraits certifiés portent en
outre l'empreinte et le QR code.

---

## 11. Journal d'audit

### `GET /api/rmt/societes/:id/audit`
Paramètres `?depuis=`, `?action=`, `?utilisateur=`. Lecture seule : le journal
ne s'amende pas.

---

## Hors périmètre de cette version

Le calcul des droits d'enregistrement est écarté pour l'instant. Les tables
`rmt_taux_enregistrement` restent en place, sans endpoint, et l'alerte
`enregistrement_fiscal_absent` se borne à signaler l'absence de justificatif
sans chiffrer quoi que ce soit.
