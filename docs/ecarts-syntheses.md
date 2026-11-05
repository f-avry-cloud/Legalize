# Connecteur et pratique du cabinet : écarts relevés dans les synthèses du guichet

Analyse du 4 novembre 2026, sur les 5 887 documents de synthèse du cabinet (2023-2026), soit
3 607 formalités distinctes après regroupement des versions d'une même liasse. Les PDF sont restés
sur le poste du cabinet ; seuls des comptages sortent ici, sans donnée personnelle.

Un pourcentage indique la part des formalités d'un type dont la synthèse contient la pièce ou la
rubrique. Les greffes ayant validé ces dossiers, une pièce absente de la plupart d'entre eux n'est
pas exigée en pratique ; une pièce présente partout l'est, ou le cabinet la juge indispensable.

## 1. Ce que le connecteur couvre, au regard du volume du cabinet

| Formalités du corpus | Nombre | Connecteur |
|---|---|---|
| Modifications | 1 591 | Couvertes, sauf le transfert de siège (11M, 202 dossiers) et le transfert d'établissement (56PMF, 11) : exigences rendues, dépôt « à finaliser sur le portail » |
| Dépôts de comptes annuels | 931 | **Absents** du catalogue d'opérations (le questionnaire `depot_comptes` existe dans `payload.js`) |
| Créations | 472 | Couvertes |
| Cessations | 206 | TUP (28M), sommeil (40M) et fusion (41M) déposables ; dissolution (22M, 60 dossiers) et clôture (42M, 46) à finaliser sur le portail |
| Corrections | 163 | **Absentes** |
| Dépôts d'actes seuls | 126 | **Absents** |

Priorités qui en découlent, par volume :

1. **Comptes annuels** (26 % des formalités du cabinet).
2. **Transfert de siège** en dépôt automatique : le guichet le déclare toujours avec l'ouverture du
   nouvel établissement et le sort de l'ancien (« devient secondaire », « supprimé »).
3. **Dissolution et clôture** en dépôt automatique.
4. **Dépôt d'actes** (statuts mis à jour, projet de fusion, rapport du commissaire à la
   transformation déposé à part dans 20 cas).
5. **Correction** (pièces constantes : identité du déclarant, Kbis, pouvoir, avis de situation INSEE
   dans 74 % des cas).

## 2. Modifications apportées sur cette branche

| Sujet | Constat dans les synthèses | Changement |
|---|---|---|
| Diffusion commerciale | « Non » dans 91 % des créations ; le connecteur transmettait toujours « Oui » | Champ `diffusion_commerciale` (commun et création), proposé à « Non », à confirmer par l'avocat, transmis au guichet. Un dossier antérieur sans réponse garde « Oui » |
| 16M : annonce légale | 76 % des changements de date de clôture, validés compris, sans annonce | Question `objet_16M` ; l'annonce n'est due que si la durée change (l'avis de constitution, art. R. 210-4 C. com., ne mentionne pas la clôture) |
| 22M : liquidateur | Aucune pièce d'identité du liquidateur dans les 60 dissolutions, non-condamnation dans 12 % | Question `liquidateur_en_place` : liquidateur déjà dirigeant inscrit → pièces « à préciser » au lieu d'obligatoires |
| 22M : informations | Poursuite d'activité et publicité présentes dans 98 à 100 % des synthèses ; 19 dissolutions sur 60 « avec poursuite d'activité » | Champs `poursuite_activite`, `date_cessation_activite`, `journal_publication`, `date_publication` |
| 42M : informations | Publicité de la liquidation dans 87 % des synthèses | Champs `journal_publication`, `date_publication` |
| 28M : pièces | Kbis de l'associé unique dans 50 % des TUP validées | PJ_188 proposé (« à préciser ») |
| TUP en deux temps | Sur 34 TUP, environ la moitié sont des déclarations de dissolution (immatriculation maintenue, publicité de la dissolution), l'autre moitié des radiations (« disparition suite à une TUP », date de transfert du patrimoine) ; le connecteur faisait tout en un seul 28M | 28M = déclaration de la dissolution ; nouvelle opération RADTUP = radiation, déposée en 42M après le délai d'opposition (voir `docs/connecteur-guichet-unique.md`) |
| 41M : pièces | Annonce légale dans 100 % des radiations d'absorbées, Kbis des sociétés participantes dans 96 % | PJ_08 obligatoire, PJ_20 (Kbis de l'absorbante) proposé |

Tests : `npm run test:pratique`. Jeux d'essai existants mis à jour pour confirmer la diffusion
commerciale.

Les nouveaux champs de 22M et 42M servent à la collecte : ces opérations se finalisent encore sur le
portail. Pour le dépôt automatique, ils correspondent à `indicateurPoursuiteActivite`,
`dateCessationTotaleActivite`, `indicateurMaintienImmatriculationRegistre` et au bloc
`publicationLegale` du dictionnaire INPI (06/2026).

## 3. Rubriques du portail (`sousTypeDocument`)

Le portail range chaque pièce sous une rubrique propre à la formalité, codée `sousTypeDocument`
(PJPM…, PJCA…, PJDA…). Ce sont ces libellés qui figurent dans les synthèses et que le greffe lit.
Le connecteur n'envoie que `typeDocument` (PJ_xx) : ses pièces apparaissent dans les synthèses sous
leur code (« PJ_54 », « PJ_25 »…). Parmi les motifs d'invalidation relevés : « Mauvaise rubrique »,
« Veuillez placer le PV dans un onglet acte », « l'intitulé ne leur convient pas ».

Rapprochement proposé, **à valider par un dépôt sur le serveur de démonstration** (`npm run
banc:guichet`) avant tout envoi en production :

| Rubrique du portail (sousTypeDocument) | Utilisations | Code PJ du connecteur |
|---|---|---|
| PJPM0034 Procuration signée… effectue la formalité | 2 938 | PJ_51 |
| PJPM0035 Justificatif d'identité du mandataire | 3 041 | pièce du déclarant |
| PJPM0021 Pièce justifiant de l'occupation régulière des locaux du siège | 1 088 | PJ_25 (ou PJ_29 si domiciliation) |
| PJPM0024 Convention de mise à disposition (siège chez le représentant légal) | 260 | PJ_26 |
| PJPM0004 Statuts mis à jour, datés et certifiés conformes | 800 | PJ_02 |
| PJPM0001 Statuts paraphés, datés et signés par tous les associés | 706 | PJ_01 |
| PJPM0013 Attestation de parution de l'avis de modification | 755 | PJ_08 (modification) |
| PJPM0012 Attestation de parution de l'avis de création | 689 | PJ_08 (création) |
| PJPM0087 Attestation de parution de l'avis de cessation | 153 | PJ_08 (cessation) |
| PJPM0019 Extrait de l'immatriculation au RCS | 645 | PJ_20 |
| PJPM0018 Attestation de non-condamnation (avec filiation) | 616 | PJ_17 |
| PJPM0014 Justificatif d'identité (recto/verso) | 590 | PJ_11 / PJ_12 |
| PJPM0037 PV de l'AGE ayant approuvé la modification du capital | 236 | PJ_155 / PJ_54 (15M) |
| PJPM0109 Procès-verbal décidant de la mise à jour des statuts | 208 | PJ_152 |
| PJPM0115 Attestation de dépôt des fonds | 151 | PJ_180 |
| PJPM0068 Liste des souscripteurs | 161 | PJ_06 |
| PJPM0043 Acte constatant le changement de président de la SAS | 130 | PJ_54 (35M, président) |
| PJPM0040 Acte décidant du changement de gérant | 54 | PJ_54 (35M, gérant) |
| PJPM0044 PV ayant décidé du changement de directeur général | 25 | PJ_54 (35M, DG) |
| PJPM0050 Acte constatant le changement de représentant permanent | 76 | PJ_80 |
| PJPM0110 Procès-verbal de transformation | 89 | PJ_153 |
| PJPM0036 Acte décidant du changement de dénomination | 54 | PJ_54 (10M) |
| PJPM0038 Acte validant la poursuite malgré la perte de la moitié du capital | 77 | PJ_108 (25M) |
| PJPM0039 Acte duquel résulte la reconstitution des capitaux propres | 26 | PJ_108 (26M) |
| PJPM0063 PV décidant la dissolution et nommant le liquidateur | 72 | PJ_108 (22M) |
| PJPM0064 PV constatant la dissolution par réunion des parts (TUP) | 27 | PJ_108 (28M) |
| PJPM0061 Compte de liquidation certifié conforme | 69 | PJ_82 |
| PJPM0088 Procès-verbal de clôture et de liquidation | 58 | PJ_133 |
| PJCA0042 PV d'assemblée (affectation du résultat) | 939 | comptes annuels |
| PJCA0043 Déclaration de confidentialité des comptes annuels | 544 | comptes annuels |
| PJCA0040 Bilan et compte de résultat | 449 | comptes annuels |

Une même pièce PJ change de rubrique selon l'opération (l'annonce légale en création, modification ou
cessation ; le PJ_54 selon le dirigeant qui change). Le rapprochement se fait donc par opération et
par personne, comme les règles de `parcours.js`.

## 4. Écarts à trancher par l'avocat

Ces points opposent le référentiel du connecteur à la pratique validée. Ils ne sont pas modifiés.

| Opération | Référentiel du connecteur | Pratique du cabinet |
|---|---|---|
| 13M transformation | PJ_157 (actes enregistrés, PV et statuts) obligatoire | Présent dans moins de 5 % des 82 transformations |
| 01M SARL et EURL | PJ_06 (dépôt des fonds) dû en cas d'apports en numéraire | Joint dans 20 % des SARL et 27 % des EURL |
| 34M associés de société civile | Annonce légale obligatoire | 27 % des 74 ajouts d'associé ; changement d'associé par cession de parts, souvent sans changement de gérant |
| 17M associé unique | PV seul | PV 79 %, statuts 64 %, annonce 55 % |
| 25M capitaux propres | Annonce obligatoire | 69 % (74 % des dossiers validés) |
| 40M mise en sommeil | Pouvoir, PV à préciser | Annonce dans 38 % des dossiers validés ; acte de cession du fonds dans 22 % |

## 5. Informations que le portail demande et que le connecteur ne collecte pas encore

- **11M** : sort de l'ancien établissement (« devient secondaire », « supprimé »), au-delà de
  « l'établissement principal suit le siège ». 147 transferts portent sur « le siège et
  l'établissement principal », 12 sur l'établissement principal seul, 3 sur le siège seul.
- **40M** : présence de salariés et date de cessation de leur emploi (90 % des synthèses),
  destination de l'établissement (100 %).
- **80PMF** : présence de salariés dans l'établissement fermé.
- **Comptes annuels** : type de dépôt (comptes sociaux ou consolidés), dépôt rectificatif, dates de
  l'exercice, confidentialité (niveau 0 public 16 %, niveau 1 micro-entreprise 55 %, niveau 2 petite
  entreprise 11 %), dispense de dépôt de l'annexe (39 %).

## 6. Contrôles avant envoi suggérés par les invalidations

128 pièces portent un motif d'invalidation autre que le remplacement par le déclarant. Ceux que le
connecteur peut vérifier :

- pouvoir de plus de trois mois ; Kbis d'un dirigeant personne morale de plus de trois mois ;
- comptes annuels : confidentialité totale demandée par une entreprise qui dépasse les seuils de la
  micro-entreprise ; fichiers à combiner ou à dissocier selon le greffe ; annexe absente sans dispense ;
- statuts mis à jour datés après la décision déclarée ;
- pièce rangée sous une rubrique d'une autre opération (annonce de création jointe à une modification).
