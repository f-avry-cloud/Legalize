'use strict';

/**
 * Catalogue des formalités : pour chaque événement du guichet unique, ce
 * qu'il faut savoir AVANT de rédiger les actes — les informations à
 * transmettre et les pièces à joindre.
 *
 * Trois sources, de valeur inégale, et l'écran dit laquelle parle :
 *
 *   1. La liste des événements et leurs libellés : référentiel INPI
 *      (dictionnaire des données mandataire, onglet « events »). Fait foi.
 *
 *   2. Ce que chaque événement modifie dans le dossier : déduit du même
 *      dictionnaire, par les drapeaux `is…Triggered` et les descriptions qui
 *      citent l'événement (src/inpi/data/evenements-dictionnaire.json).
 *      Fait foi, mais ne couvre pas tout : les créations, notamment, portent
 *      sur l'ensemble du dossier et n'ont pas de drapeau.
 *
 *   3. Les pièces justificatives : AUCUN fichier INPI ne les rattache aux
 *      événements. La liste réglementaire est fixée par l'arrêté prévu à
 *      l'article R. 123-292 du Code de commerce. Les rattachements ci-dessous
 *      s'appuient sur les libellés officiels des 167 codes PJ — qui nomment
 *      souvent l'opération (« Certificat du dépositaire (modification du
 *      capital social d'une SA ou d'une SAS) ») — et sur la pratique. Ils sont
 *      présentés comme À VALIDER, jamais comme du droit établi.
 *
 * Les informations sont rédigées pour un juriste, pas pour un développeur :
 * la référence technique au dictionnaire reste disponible, en second rang.
 */

const EVENEMENTS = require('./data/evenements.json').valeurs;
const TRACES = require('./data/evenements-dictionnaire.json').valeurs;
const { piece } = require('./referentiels');

const FAMILLES = {
  creation: { libelle: 'Création', ordre: 1 },
  identite: { libelle: 'Statuts et identité de la société', ordre: 2 },
  dirigeants: { libelle: 'Dirigeants, associés et bénéficiaires effectifs', ordre: 3 },
  etablissements: { libelle: 'Établissements et activités', ordre: 4 },
  fonds: { libelle: 'Fonds de commerce et location-gérance', ordre: 5 },
  dissolution: { libelle: 'Dissolution, fusion et radiation', ordre: 6 },
  particulier: { libelle: 'Situations particulières', ordre: 7 },
  hors_champ: { libelle: 'Entreprises individuelles et exploitations agricoles', ordre: 8 },
};

/** Pièces communes à toute formalité déposée par un mandataire. */
const PIECES_COMMUNES = [
  { code: 'PJ_51', condition: 'pour toute formalité déposée par un mandataire, notamment un avocat' },
];

/** Pièces que le guichet génère lui-même : à signer, pas à fournir. */
const PIECES_GENEREES = [
  { code: 'PJ_115', condition: 'document de synthèse, généré au dépôt puis signé' },
  { code: 'PJ_120', condition: 'synthèse des bénéficiaires effectifs, générée puis signée lorsqu’ils sont déclarés' },
];

/* Raccourcis pour les pièces qui reviennent d'une formalité à l'autre. */
const PV = ['PJ_54'];
const STATUTS_MAJ = ['PJ_02'];
const ANNONCE = ['PJ_08'];
const IDENTITE_DIRIGEANT = [
  ['PJ_11', 'pour chaque nouveau dirigeant personne physique (ou PJ_12, passeport)'],
  ['PJ_63', 'pour chaque nouveau dirigeant personne physique'],
  ['PJ_64', 'pour chaque nouveau dirigeant personne physique'],
  ['PJ_20', 'pour chaque nouveau dirigeant personne morale'],
];
const SIEGE = [
  ['PJ_25', 'si le siège est fixé dans des locaux dont la société a la jouissance'],
  ['PJ_29', 'si le siège est fixé chez une entreprise de domiciliation'],
];

/* ------------------------------------------------------------------------
   Les formalités d'une société, une par une.
   informations : [libellé, référence au dictionnaire]
   pieces       : [code] = toujours requise ; [code, condition] = selon le cas
   ------------------------------------------------------------------------ */

const DETAIL = {
  /* ------------------------------------------------------------ création */
  '01M': {
    famille: 'creation',
    type: 'C',
    quand: 'Constitution d’une société qui commence son activité dès l’immatriculation.',
    informations: [
      ['Forme juridique, dénomination, nom commercial', 'BlocEntrepriseIdentite.denomination'],
      ['Sigle', 'BlocDetailPersonneMorale.sigle'],
      ['Capital social et sa variabilité', 'BlocDetailPersonneMorale.montantCapital'],
      ['Durée et date de clôture de l’exercice', 'BlocDetailPersonneMorale.dateClotureExerciceSocial'],
      ['Objet social', 'BlocDetailPersonneMorale.objet'],
      ['Adresse du siège et nature de son occupation (propre, domiciliation)', 'RubriqueAdresseEntreprise.adresse'],
      ['Activité principale exercée et date de début', 'BlocDescriptionActivite.descriptionDetaillee'],
      ['Origine du fonds (création, achat, apport, location-gérance)', 'BlocDescriptionActivite.origine'],
      ['Dirigeants : identité, fonction, domicile', 'PMRubriqueComposition.pouvoirs'],
      ['Bénéficiaires effectifs et modalités de contrôle', 'PersonneMorale.beneficiairesEffectifs'],
      ['Options fiscales : régime d’imposition, TVA', 'PersonneMorale.optionsFiscales'],
      ['Présence de salariés', 'BlocEtablissementSalarie.presenceSalarie'],
    ],
    pieces: [
      ['PJ_01'], ANNONCE, ...SIEGE,
      ['PJ_06', 'en cas d’apports en numéraire'],
      ['PJ_03', 'si les premiers dirigeants ne sont pas désignés dans les statuts'],
      ...IDENTITE_DIRIGEANT,
      ['PJ_04', 'en cas d’apports en nature, sauf dispense de commissaire aux apports'],
      ['PJ_05', 'en cas d’apports en nature'],
      ['PJ_40', 'si un commissaire aux comptes est désigné'],
      ['PJ_41', 'si un commissaire aux comptes est désigné'],
      ['PJ_80', 'si une personne morale administrateur désigne un représentant permanent'],
      ['PJ_31', 'si l’activité est réglementée'],
    ],
  },
  '02M': {
    famille: 'creation',
    type: 'C',
    quand: 'Constitution d’une société qui n’exerce encore aucune activité (holding naissante, société en sommeil dès l’origine).',
    informations: [
      ['Forme juridique, dénomination', 'BlocEntrepriseIdentite.denomination'],
      ['Capital social', 'BlocDetailPersonneMorale.montantCapital'],
      ['Durée et date de clôture de l’exercice', 'BlocDetailPersonneMorale.dateClotureExerciceSocial'],
      ['Objet social', 'BlocDetailPersonneMorale.objet'],
      ['Adresse du siège', 'RubriqueAdresseEntreprise.adresse'],
      ['Dirigeants', 'PMRubriqueComposition.pouvoirs'],
      ['Bénéficiaires effectifs', 'PersonneMorale.beneficiairesEffectifs'],
      ['Options fiscales', 'PersonneMorale.optionsFiscales'],
    ],
    pieces: [
      ['PJ_01'], ANNONCE, ...SIEGE,
      ['PJ_06', 'en cas d’apports en numéraire'],
      ['PJ_03', 'si les premiers dirigeants ne sont pas désignés dans les statuts'],
      ...IDENTITE_DIRIGEANT,
      ['PJ_04', 'en cas d’apports en nature, sauf dispense'],
      ['PJ_40', 'si un commissaire aux comptes est désigné'],
      ['PJ_41', 'si un commissaire aux comptes est désigné'],
    ],
  },
  '03M': {
    famille: 'creation',
    type: 'C',
    quand: 'Constitution d’une société sans activité au siège, mais qui exerce dans un établissement distinct.',
    informations: [
      ['Les informations d’une création (01M)', 'BlocEntrepriseIdentite.denomination'],
      ['Adresse et activité de l’établissement où l’activité commence', 'PersonneMorale.autresEtablissements'],
    ],
    pieces: [
      ['PJ_01'], ANNONCE, ...SIEGE,
      ['PJ_25', 'pour l’établissement où l’activité est exercée'],
      ['PJ_06', 'en cas d’apports en numéraire'],
      ...IDENTITE_DIRIGEANT,
    ],
  },
  '04M': {
    famille: 'creation',
    type: 'C',
    quand: 'Une société de droit étranger ouvre son premier établissement en France.',
    informations: [
      ['Identification de la société étrangère et de son registre d’origine', 'BlocEntrepriseIdentite.formeJuridiqueEtrangere'],
      ['Adresse et activité de l’établissement français', 'RubriqueEtablissement.adresse'],
      ['Personnes ayant le pouvoir d’engager la société en France', 'PMRubriqueComposition.pouvoirs'],
    ],
    pieces: [
      ['PJ_140'], ['PJ_142', 'si les statuts ne sont pas rédigés en français'], ['PJ_25'],
      ['PJ_137', 'pour une société d’un État de l’Union européenne ou de l’EEE'],
      ...IDENTITE_DIRIGEANT,
    ],
  },
  '07M': {
    famille: 'creation',
    type: 'C',
    quand: 'Une société étrangère sans établissement en France doit être inscrite (employeur, assujetti à la TVA).',
    informations: [
      ['Identification de la société étrangère', 'BlocEntrepriseIdentite.formeJuridiqueEtrangere'],
      ['Représentant social ou fiscal en France', 'PMRubriqueComposition.pouvoirs'],
    ],
    pieces: [['PJ_140'], ['PJ_141'], ['PJ_225', 'si un représentant fiscal est désigné']],
  },

  /* ------------------------------------------------ statuts et identité */
  '10M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F36170',
    famille: 'identite',
    type: 'M',
    quand: 'Changement de dénomination, de sigle ou de nom commercial de la société.',
    informations: [
      ['Nouvelle dénomination', 'BlocEntrepriseIdentite.denomination'],
      ['Nouveau sigle', 'BlocDetailPersonneMorale.sigle'],
      ['Nouveau nom commercial', 'BlocEntrepriseIdentite.nomCommercial'],
      ['Date d’effet', 'BlocDetailPersonneMorale.is10MTriggered'],
    ],
    pieces: [PV, STATUTS_MAJ, ANNONCE],
  },
  '11M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F36267',
    famille: 'identite',
    type: 'M',
    quand: 'Le siège social est déplacé, dans le ressort du même greffe ou hors de ce ressort.',
    informations: [
      ['Nouvelle adresse du siège', 'RubriqueAdresseEntreprise.adresse'],
      ['Date d’effet du transfert', 'BlocAdresse.datePriseEffetAdresse'],
      ['Sort de l’établissement principal : transféré avec le siège, ou maintenu à l’ancienne adresse', 'BlocDescriptionEtablissement.rolePourEntreprise'],
    ],
    pieces: [
      PV, STATUTS_MAJ, ANNONCE, ...SIEGE,
      ['PJ_97', 'en cas de transfert hors du ressort du greffe'],
    ],
    note: 'Un transfert hors ressort donne lieu à deux annonces légales : dans le département de départ et dans celui d’arrivée.',
  },
  '12M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F36182',
    famille: 'identite',
    type: 'M',
    quand: 'Modification de l’objet social ou des principales activités exercées.',
    informations: [
      ['Nouvel objet social', 'BlocDetailPersonneMorale.objet'],
      ['Activités effectivement exercées, si elles changent', 'BlocDescriptionActivite.descriptionDetaillee'],
    ],
    pieces: [PV, STATUTS_MAJ, ANNONCE, ['PJ_31', 'si une activité réglementée est ajoutée']],
  },
  '13M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F36177',
    famille: 'identite',
    type: 'M',
    quand: 'Transformation de la société (SARL en SAS, SAS en SA…) ou changement de statut particulier.',
    informations: [
      ['Nouvelle forme juridique', 'BlocEntrepriseIdentite.formeJuridique'],
      ['Nouveaux dirigeants, si la transformation en entraîne', 'PMRubriqueComposition.pouvoirs'],
      ['Capital, s’il est modifié à cette occasion', 'BlocDetailPersonneMorale.montantCapital'],
    ],
    pieces: [
      ['PJ_153'], ['PJ_157'], STATUTS_MAJ, ANNONCE,
      ['PJ_160', 'lorsqu’un commissaire à la transformation doit être désigné'],
      ['PJ_58', 'pour la transformation d’une SARL en SA'],
      ['PJ_03', 'si de nouveaux dirigeants sont nommés'],
      ...IDENTITE_DIRIGEANT,
    ],
  },
  '14M': {
    famille: 'identite',
    type: 'M',
    quand: 'Ajout, modification ou suppression des noms de domaine des sites internet de la société.',
    informations: [
      ['Noms de domaine concernés', 'BlocNomDeDomaine.nomDomaine'],
      ['Date d’effet', 'BlocNomDeDomaine.dateEffet14M'],
    ],
    pieces: [],
    note: 'Déclaration sans pièce justificative spécifique identifiée.',
  },
  '15M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F36607',
    famille: 'identite',
    type: 'M',
    quand: 'Augmentation ou réduction du capital social.',
    informations: [
      ['Nouveau montant du capital', 'BlocDetailPersonneMorale.montantCapital'],
      ['Nature de l’opération (augmentation, réduction) et modalités', 'BlocDetailPersonneMorale.is15MTriggered'],
    ],
    pieces: [
      STATUTS_MAJ, ANNONCE,
      ['PJ_155', 'en cas d’augmentation : décision ou procès-verbal'],
      ['PJ_156', 'en cas de réduction : décision actant son principe'],
      ['PJ_54', 'en cas de réduction : décision constatant sa réalisation'],
      ['PJ_55', 'SA ou SAS : décision du conseil ou du directoire agissant sur délégation'],
      ['PJ_180', 'augmentation en numéraire'],
      ['PJ_57', 'SA ou SAS : libération par compensation de créances'],
      ['PJ_163', 'augmentation par apport en nature (avec le récépissé de son dépôt)'],
    ],
  },
  '16M': {
    famille: 'identite',
    type: 'M',
    quand: 'Prorogation de la durée de la société ou changement de la date de clôture de l’exercice.',
    informations: [
      ['Nouvelle durée', 'BlocDetailPersonneMorale.duree'],
      ['Nouvelle date de clôture', 'BlocDetailPersonneMorale.dateClotureExerciceSocial'],
    ],
    pieces: [PV, STATUTS_MAJ, ANNONCE],
  },
  '17M': {
    famille: 'identite',
    type: 'M',
    quand: 'La société devient unipersonnelle, ou cesse de l’être.',
    informations: [['Mention « associé unique »', 'BlocDetailPersonneMorale.indicateurAssocieUnique']],
    pieces: [['PJ_54', 'acte ou décision constatant la réunion ou la division des titres']],
  },
  '19M': {
    famille: 'identite',
    type: 'M',
    quand: 'SARL : la gérance devient majoritaire, minoritaire ou égalitaire.',
    informations: [['Nature de la gérance', 'BlocDetailPersonneMorale.is19MTriggered']],
    pieces: [['PJ_190', 'si le changement résulte d’une cession de parts sous seing privé'], ['PJ_189', 'si le changement résulte d’un acte notarié']],
  },
  '20M': {
    famille: 'identite',
    type: 'M',
    quand: 'Rectification de la date de début d’activité déclarée.',
    informations: [['Date de début d’activité', 'BlocDescriptionActivite.dateDebut']],
    pieces: [],
    note: 'Déclaration sans pièce justificative spécifique identifiée.',
  },
  '25M': {
    famille: 'identite',
    type: 'M',
    quand: 'Les capitaux propres sont devenus inférieurs à la moitié du capital et les associés décident de ne pas dissoudre.',
    informations: [['Décision de poursuite de l’activité malgré la perte de la moitié du capital', null]],
    pieces: [['PJ_108'], ANNONCE],
  },
  '26M': {
    famille: 'identite',
    type: 'M',
    quand: 'Les capitaux propres ont été reconstitués.',
    informations: [['Constat de la reconstitution des capitaux propres', null]],
    pieces: [['PJ_108'], ['PJ_236', 'procès-verbal d’approbation des comptes faisant apparaître la reconstitution']],
  },
  '29M': {
    famille: 'identite',
    type: 'M',
    quand: 'Toute autre modification de la personne morale qui n’a pas d’événement propre.',
    informations: [['Selon la modification', 'BlocDetailPersonneMorale.is29MTriggered']],
    pieces: [PV, ['PJ_02', 'si les statuts sont modifiés']],
  },

  /* ------------------------------------------------------- dirigeants */
  '35M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F36173',
    famille: 'dirigeants',
    type: 'M',
    quand: 'Nomination, cessation ou changement de fonctions d’un dirigeant de SARL, SAS, SA (gérant, président, directeur général, administrateur, commissaire aux comptes…).',
    informations: [
      ['Nature du changement : nomination, cessation, modification', 'BlocNatureModification.is34Or35MAdjonctionTriggered'],
      ['Identité et fonction du dirigeant concerné', 'BlocPouvoir.roleEntreprise'],
      ['Domicile du dirigeant', 'BlocPouvoir.individu'],
      ['Date d’effet', 'BlocPouvoir.dateEffet34Or35M'],
    ],
    pieces: [
      ['PJ_54'], ANNONCE,
      ['PJ_230', 'en cas de démission'],
      ...IDENTITE_DIRIGEANT,
      ['PJ_80', 'désignation du représentant permanent d’une personne morale administrateur'],
      ['PJ_40', 'nomination d’un commissaire aux comptes'],
      ['PJ_41', 'nomination d’un commissaire aux comptes'],
      ['PJ_02', 'si les statuts sont modifiés'],
    ],
    note: 'Un changement de dirigeant ne modifie pas, à lui seul, les bénéficiaires effectifs : à vérifier au cas par cas (38F).',
  },
  '34M': {
    famille: 'dirigeants',
    type: 'M',
    quand: 'Changement de dirigeant d’une société de personnes (SNC, société en commandite simple, société civile).',
    informations: [
      ['Nature du changement', 'BlocNatureModification.is34Or35MAdjonctionTriggered'],
      ['Identité et fonction', 'BlocPouvoir.roleEntreprise'],
      ['Date d’effet', 'BlocPouvoir.dateEffet34Or35M'],
    ],
    pieces: [
      ANNONCE,
      ['PJ_03', 'en cas de nomination'],
      ['PJ_54', 'en cas de cessation'],
      ...IDENTITE_DIRIGEANT,
      ['PJ_02', 'les gérants étant le plus souvent statutaires'],
    ],
  },
  '38F': {
    famille: 'dirigeants',
    type: 'M',
    quand: 'Un bénéficiaire effectif apparaît, disparaît, ou ses modalités de contrôle changent.',
    informations: [
      ['Identité du bénéficiaire effectif', 'PMRubriqueBeneficiaireEffectif.beneficiaire'],
      ['Modalités de contrôle (détention, droits de vote, autre moyen)', 'BlocModaliteControle.modalitesDeControle'],
      ['Date d’effet', 'PMRubriqueBeneficiaireEffectif.is38FModalitesControle'],
    ],
    pieces: [],
    note: 'Aucune pièce à joindre : le document de synthèse des bénéficiaires effectifs (PJ_120) est généré par le guichet, puis signé.',
  },
  '36M': {
    famille: 'dirigeants',
    type: 'M',
    quand: 'Société étrangère employeur sans établissement : changement de représentant social ou fiscal.',
    informations: [['Identité du représentant', 'BlocPouvoir.roleEntreprise']],
    pieces: [['PJ_225', 'pour un représentant fiscal'], ['PJ_132', 'convention de représentation']],
  },
  '70PM': {
    famille: 'dirigeants',
    type: 'M',
    quand: 'Nomination ou départ d’une personne ayant le pouvoir d’engager un établissement (directeur d’établissement).',
    informations: [
      ['Identité de la personne', 'BlocPouvoir.individu'],
      ['Date d’effet', 'BlocPouvoir.dateEffet70PM'],
    ],
    pieces: [['PJ_03', 'en cas de nomination'], ...IDENTITE_DIRIGEANT],
  },

  /* -------------------------------------------- établissements, activités */
  '54PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Ouverture d’un établissement secondaire.',
    informations: [
      ['Adresse de l’établissement', 'RubriqueEtablissement.adresse'],
      ['Activité exercée', 'BlocDescriptionActivite.descriptionDetaillee'],
      ['Date d’ouverture', 'RubriqueEtablissement.dateEffetOuvertureEtablissement'],
      ['Origine du fonds', 'BlocDescriptionActivite.origine'],
      ['Enseigne, nom commercial', 'BlocDescriptionEtablissement.enseigne'],
    ],
    pieces: [
      ['PJ_25'],
      ['PJ_33', 'fonds acquis par achat'],
      ['PJ_36', 'fonds acquis par apport'],
      ['PJ_37', 'fonds pris en location-gérance'],
      ['PJ_31', 'activité réglementée'],
    ],
  },
  '56PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Transfert d’un établissement secondaire à une nouvelle adresse.',
    informations: [
      ['Nouvelle adresse', 'RubriqueEtablissement.adresse'],
      ['Date d’effet', 'BlocDescriptionEtablissement.dateEffetTransfert'],
    ],
    pieces: [['PJ_25']],
  },
  '60PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Modification de l’enseigne ou du nom commercial d’un établissement.',
    informations: [
      ['Enseigne', 'BlocDescriptionEtablissement.enseigne'],
      ['Nom commercial', 'BlocDescriptionEtablissement.nomCommercial'],
      ['Date d’effet', 'BlocDescriptionEtablissement.dateEffet60PMF'],
    ],
    pieces: [],
    note: 'Déclaration sans pièce justificative spécifique identifiée.',
  },
  '61PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Une activité nouvelle s’ajoute à celles d’un établissement.',
    informations: [['Activité ajoutée et date de début', 'BlocDescriptionActivite.descriptionDetaillee']],
    pieces: [['PJ_31', 'activité réglementée']],
    note: 'Si l’activité ajoutée sort de l’objet social, il faut d’abord modifier l’objet (12M).',
  },
  '67PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Modification des activités exercées dans un établissement.',
    informations: [['Activités exercées', 'BlocDescriptionActivite.descriptionDetaillee']],
    pieces: [['PJ_31', 'activité réglementée']],
  },
  '62M': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Une partie des activités cesse.',
    informations: [['Activité supprimée et date', 'BlocDescriptionEtablissement.dateEffetSuppression']],
    pieces: [['PJ_53', 'activité non sédentaire supprimée']],
  },
  '80PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Fermeture d’un établissement secondaire.',
    informations: [
      ['Établissement fermé', 'RubriqueEtablissement.adresse'],
      ['Date de fermeture et destination du fonds (vendu, fermé, mis en location-gérance…)', 'BlocDescriptionEtablissement.destinationEtablissement'],
    ],
    pieces: [['PJ_83', 'si le fonds est cédé']],
  },
  '51M': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Une société sans activité commence à exercer au siège, ou y reprend son activité.',
    informations: [
      ['Activité exercée et date de début', 'BlocDescriptionActivite.descriptionDetaillee'],
      ['Origine du fonds', 'BlocDescriptionActivite.origine'],
    ],
    pieces: [['PJ_33', 'fonds acquis par achat'], ['PJ_37', 'fonds pris en location-gérance'], ['PJ_31', 'activité réglementée']],
  },
  '52M': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Une société sans activité ouvre un établissement distinct du siège.',
    informations: [
      ['Adresse et activité de l’établissement', 'RubriqueEtablissement.adresse'],
      ['Origine du fonds', 'BlocDescriptionActivite.origine'],
    ],
    pieces: [['PJ_25'], ['PJ_33', 'fonds acquis par achat'], ['PJ_37', 'fonds pris en location-gérance']],
  },
  '65PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Embauche d’un premier salarié dans un établissement.',
    informations: [['Date d’embauche du premier salarié', 'BlocEtablissementSalarie.dateEffetDebutEmploiSalarie']],
    pieces: [],
    note: 'Déclaration sans pièce justificative.',
  },
  '66PMF': {
    famille: 'etablissements',
    type: 'M',
    quand: 'Plus aucun salarié dans un établissement.',
    informations: [['Date de fin d’emploi', 'BlocEtablissementSalarie.dateEffetFinEmploiSalarie']],
    pieces: [],
    note: 'Déclaration sans pièce justificative.',
  },

  /* ------------------------------------------------ fonds et location-gérance */
  '84M': {
    famille: 'fonds',
    type: 'M',
    quand: 'Le fonds unique de la société est donné en location-gérance ou en gérance-mandat, la société restant immatriculée.',
    informations: [
      ['Identité du locataire-gérant ou du gérant-mandataire', 'BlocLocataireGerantMandataire.denomination'],
      ['Date d’effet', 'BlocLocationGeranceMandat.dateEffet'],
    ],
    pieces: [['PJ_37', 'location-gérance'], ['PJ_38', 'gérance-mandat'], ANNONCE],
  },
  '82PMF': {
    famille: 'fonds',
    type: 'M',
    quand: 'L’un des fonds exploités est donné en location-gérance ou en gérance-mandat.',
    informations: [
      ['Établissement concerné', 'RubriqueEtablissement.locationGeranceMandat'],
      ['Identité du locataire-gérant', 'BlocLocataireGerantMandataire.denomination'],
    ],
    pieces: [['PJ_37', 'location-gérance'], ['PJ_90', 'gérance-mandat'], ANNONCE],
  },
  '53PMF': {
    famille: 'fonds',
    type: 'M',
    quand: 'La société reprend l’exploitation d’un fonds qu’elle avait donné en location-gérance.',
    informations: [['Date de reprise', 'RubriqueEtablissement.dateEffet53PMF']],
    pieces: [['PJ_37', 'acte constatant la fin de la location-gérance'], ANNONCE],
  },
  '64PMF': {
    famille: 'fonds',
    type: 'M',
    quand: 'Renouvellement d’un contrat de location-gérance.',
    informations: [['Date d’effet du renouvellement', 'BlocLocationGeranceMandat.dateEffet']],
    pieces: [['PJ_37']],
  },
  '68M': {
    famille: 'fonds',
    type: 'M',
    quand: 'Changement de locataire-gérant du fonds.',
    informations: [['Identité du nouveau locataire-gérant', 'BlocLocataireGerantMandataire.denomination']],
    pieces: [['PJ_37'], ANNONCE],
  },
  '69M': {
    famille: 'fonds',
    type: 'M',
    quand: 'Le fonds exploité en location-gérance change de propriétaire.',
    informations: [['Identité du nouveau loueur', 'BlocLocataireGerantMandataire.denomination']],
    pieces: [['PJ_33', 'acquisition par achat'], ['PJ_34', 'acquisition par donation'], ['PJ_36', 'acquisition par apport']],
  },
  '63M': {
    famille: 'fonds',
    type: 'M',
    quand: 'La société, jusqu’ici locataire-gérante, acquiert le fonds qu’elle exploite.',
    informations: [['Date et mode d’acquisition', 'BlocDescriptionActivite.origine']],
    pieces: [['PJ_83'], ANNONCE],
  },

  /* ------------------------------------------- dissolution, fusion, radiation */
  '22M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F23744',
    famille: 'dissolution',
    type: 'M',
    quand: 'Dissolution anticipée de la société suivie d’une liquidation amiable.',
    informations: [
      ['Date de la dissolution', 'BlocDetailCessation.dateDissolutionDisparition'],
      ['Identité du liquidateur et adresse de correspondance', 'BlocPouvoir.typeAdresseLiquidateur'],
      ['Lieu de la liquidation (siège de liquidation)', 'BlocDetailCessation.lieuDeLiquidation'],
      ['Journal et date de publication', 'BlocPublication.journalPublication'],
    ],
    pieces: [
      ['PJ_108'], ANNONCE,
      ['PJ_11', 'liquidateur personne physique (ou PJ_12, passeport)'],
      ['PJ_63', 'liquidateur personne physique'],
      ['PJ_64', 'liquidateur personne physique'],
      ['PJ_20', 'liquidateur personne morale'],
    ],
    note: 'La société subsiste pour les besoins de la liquidation. Sa radiation suit, après clôture (42M).',
  },
  '42M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F23744',
    famille: 'dissolution',
    type: 'R',
    quand: 'Radiation de la société après la clôture de la liquidation.',
    informations: [
      ['Date de clôture de la liquidation', 'BlocDetailCessation.dateClotureLiquidation'],
      ['Motif de la disparition', 'BlocDetailCessation.motifDisparition'],
    ],
    pieces: [
      ['PJ_133'], ['PJ_82'], ANNONCE, ['PJ_240'], ['PJ_241'],
    ],
    note: 'Depuis octobre 2024, la clôture d’une liquidation amiable exige une attestation fiscale et une attestation de régularité sociale.',
  },
  '28M': {
    source: 'https://entreprendre.service-public.gouv.fr/vosdroits/F35962',
    famille: 'dissolution',
    type: 'R',
    quand: 'Dissolution sans liquidation par décision de l’associé unique personne morale (transmission universelle de patrimoine).',
    informations: [
      ['Date de la décision et de la transmission du patrimoine', 'BlocDetailCessation.dateTransfertPatrimoine'],
      ['Identité de l’associé unique qui reçoit le patrimoine', null],
    ],
    pieces: [['PJ_108'], ANNONCE],
    note: 'La transmission n’a lieu qu’à l’issue du délai d’opposition des créanciers (30 jours après la publication au Bodacc). Le procès-verbal n’a pas à être enregistré.',
  },
  '41M': {
    famille: 'dissolution',
    type: 'R',
    quand: 'La société disparaît par l’effet d’une fusion (absorbée) ou d’une scission.',
    informations: [
      ['Date de réalisation de l’opération', 'BlocDetailCessation.dateDissolutionDisparition'],
      ['Société absorbante ou sociétés bénéficiaires de la scission', null],
    ],
    pieces: [
      ['PJ_161', 'fusion : projet de fusion'],
      ['PJ_199', 'scission : projet de scission'],
      ['PJ_175'], ['PJ_135'], ['PJ_85'], ['PJ_176'],
      ['PJ_202', 'lorsqu’un commissaire à la fusion est désigné'],
      ['PJ_203', 'scission : rapport du commissaire'],
    ],
  },
  '40M': {
    famille: 'dissolution',
    type: 'M',
    quand: 'La société cesse toute activité mais continue d’exister (mise en sommeil).',
    informations: [
      ['Date de cessation totale d’activité', 'BlocDetailCessation.dateCessationTotaleActivite'],
      ['Date de mise en sommeil', 'BlocDetailCessation.dateMiseEnSommeil'],
    ],
    pieces: [['PJ_54', 'décision constatant la mise en sommeil']],
  },

  /* ------------------------------------------------- situations particulières */
  '99PMF': {
    famille: 'particulier',
    type: 'M',
    quand: 'Corriger ou compléter une formalité déjà inscrite.',
    informations: [['Les informations à corriger ou compléter', null]],
    pieces: [['PJ_245']],
  },
  '37M': {
    famille: 'particulier',
    type: 'M',
    quand: 'Fin d’un contrat d’appui au projet d’entreprise.',
    informations: [['Date de fin du contrat d’appui', null]],
    pieces: [['PJ_61']],
  },
  '23M': {
    famille: 'particulier',
    type: 'M',
    quand: 'Prorogation de l’immatriculation au RCS d’une société sans activité.',
    informations: [['Date de la demande', 'BlocDetailCessation.dateDemandeProrogationRegistre']],
    pieces: [],
    note: 'Pièces non identifiées.',
  },
};

/** Événements émis par le registre lui-même : ils ne se déposent pas. */
const EMIS_PAR_LE_REGISTRE = new Set(['91PM', '92PM']);

/** Famille par défaut d'un événement sans fiche détaillée. */
function familleParDefaut(code) {
  if (/P$/.test(code) && !/PM/.test(code)) return 'hors_champ';
  if (/F$/.test(code) && !/PMF$/.test(code) && code !== '38F') return 'hors_champ';
  if (['44M', '32M'].includes(code)) return 'hors_champ';
  return 'particulier';
}

function decrirePiece([code, condition]) {
  // Un code inconnu ne doit pas rendre tout le catalogue indisponible : il
  // s'affiche tel quel, signalé, et le test de cohérence le fait échouer.
  const p = piece(code);
  return {
    code,
    libelle: p ? p.libelle : code,
    nota: p?.nota || null,
    condition: condition || null,
    inconnue: !p,
  };
}

/** La fiche complète d'un événement, prête à afficher. */
function fiche(code) {
  const libelle = EVENEMENTS[code];
  if (!libelle) return null;
  const detail = DETAIL[code];
  const trace = TRACES[code] || { drapeaux: [], champs: [] };
  const pieces = (detail?.pieces || []).map((p) => (Array.isArray(p) ? decrirePiece(p) : null)).filter(Boolean);

  return {
    code,
    libelle,
    famille: detail?.famille || familleParDefaut(code),
    type: detail?.type || null,
    quand: detail?.quand || null,
    detaillee: Boolean(detail),
    emise_par_le_registre: EMIS_PAR_LE_REGISTRE.has(code),
    informations: (detail?.informations || []).map(([lib, ref]) => ({ libelle: lib, ref: ref || null })),
    pieces_obligatoires: pieces.filter((p) => !p.condition),
    pieces_selon_le_cas: pieces.filter((p) => p.condition),
    note: detail?.note || null,
    // Ce que le dictionnaire INPI rattache à l'événement, pour qui veut
    // vérifier : le drapeau déclencheur et les champs qu'il conditionne.
    inpi: { drapeaux: trace.drapeaux, champs: trace.champs },
    // Les pièces ne viennent d'aucun fichier INPI : vérifiées sur la fiche
    // service-public quand elle existe, à valider sinon.
    source: detail?.source || null,
    pieces_a_valider: pieces.length > 0 && !detail?.source,
  };
}

function catalogueComplet() {
  return Object.keys(EVENEMENTS)
    .map(fiche)
    .sort((a, b) => (FAMILLES[a.famille].ordre - FAMILLES[b.famille].ordre) || a.code.localeCompare(b.code, 'fr', { numeric: true }));
}

module.exports = {
  FAMILLES, PIECES_COMMUNES, PIECES_GENEREES, DETAIL,
  fiche, catalogueComplet,
  piecesCommunes: () => PIECES_COMMUNES.map((p) => decrirePiece([p.code, p.condition])),
  piecesGenerees: () => PIECES_GENEREES.map((p) => decrirePiece([p.code, p.condition])),
};
