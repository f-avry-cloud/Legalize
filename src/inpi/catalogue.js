'use strict';

/**
 * Catalogue des formalités du Guichet unique.
 *
 * C'est ici que se joue la simplification du parcours : pour chaque formalité
 * on ne demande QUE le delta, c'est-à-dire ce que l'INPI ne peut pas déjà
 * savoir. Tout le reste (dénomination, forme, capital, siège, dirigeants en
 * place) provient du pré-remplissage RNE à partir du seul SIREN.
 *
 * Chaque entrée décrit :
 *   typeFormalite — C création, M modification, R cessation (contrat d'interface) ;
 *   evenement     — code évènement du RNE (11M, 15M…), affiché pour traçabilité ;
 *   champs        — le questionnaire minimal, rendu automatiquement par le front ;
 *   pieces        — les pièces justificatives par CODE OFFICIEL (PJ_xx) ; les
 *                   libellés viennent du dictionnaire de données, pas d'ici ;
 *   delai         — le délai légal, calculé sur une date du questionnaire ;
 *   controles     — les vérifications métier propres à la formalité ;
 *   apercu        — le récapitulatif lisible présenté avant dépôt.
 *
 * Les délais rappelés sont ceux du code de commerce ; ils aident au suivi et
 * ne remplacent pas l'analyse du dossier.
 */

const { TYPES_FORMALITE, piece, EVENEMENTS, enumeration, obligation } = require('./referentiels');

const DELAI_MODIFICATION = {
  jours: 30,
  texte: 'Dans le mois de la décision (art. R. 123-66 du code de commerce).',
};

/* ----------------------------------------------------- champs réutilisables */

const champDateDecision = {
  name: 'date_decision', label: 'Date de la décision', type: 'date', required: true,
  aide: 'Date du PV d’assemblée ou de la décision de l’associé unique. Elle déclenche le délai de dépôt.',
};

const champAdresse = (name, label, aide, inpi) => ({ name, label, type: 'adresse', required: true, aide, inpi });
const champPersonne = (name, label, opts = {}) => ({ name, label, type: 'personne', required: true, ...opts });

const nombre = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/** Options d'un select alimentées par une énumération officielle. */
function optionsEnum(nom, codes) {
  const table = enumeration(nom);
  return (codes || Object.keys(table)).map((code) => ({ value: code, label: table[code] || code }));
}

/* ---------------------------------------------------------------- catalogue */

const FORMALITES = {
  creation_societe: {
    libelle: 'Création d’une société',
    categorie: 'creation',
    typeFormalite: TYPES_FORMALITE.CREATION,
    evenement: '01M',
    service: 'formalites',
    resume: 'Immatriculer une société au registre national des entreprises.',
    sansSiren: true,
    signature: 'simple',
    delai: {
      base: 'date_debut_activite', jours: 15,
      texte: 'Au plus tard dans les quinze jours du début d’activité.',
    },
    champs: [
      { name: '_s1', label: 'Nature de la création', type: 'section' },
      { name: 'succursale_ou_filiale', inpi: 'Company.succursaleOuFiliale', label: 'Structure', type: 'select', required: true,
        default: 'AVEC_ETABLISSEMENT', options: optionsEnum('succursaleOuFiliale'),
        aide: 'Une société sans établissement (holding pure, société civile sans local) se déclare « Sans établissement ».' },
      { name: 'micro_entreprise', inpi: 'BlocNatureCreation.microEntreprise', label: 'Micro-entreprise', type: 'checkbox' },
      { name: 'entreprise_agricole', inpi: 'BlocNatureCreation.entrepriseAgricole', label: 'Entreprise agricole', type: 'checkbox' },
      { name: 'societe_etrangere', inpi: 'BlocNatureCreation.societeEtrangere', label: 'Société étrangère', type: 'checkbox' },

      { name: '_s2', label: 'Identité de la société', type: 'section' },
      { name: 'forme_juridique_code', inpi: 'BlocEntrepriseIdentite.formeJuridique', label: 'Forme juridique', type: 'select', required: true, source: 'formes' },
      { name: 'denomination', inpi: 'BlocEntrepriseIdentite.denomination', label: 'Dénomination sociale', type: 'text', required: true },
      { name: 'sigle', inpi: 'BlocDetailPersonneMorale.sigle', label: 'Sigle', type: 'text' },
      { name: 'nom_commercial', inpi: 'BlocEntrepriseIdentite.nomCommercial', label: 'Nom commercial', type: 'text' },
      { name: 'capital', inpi: 'BlocDetailPersonneMorale.montantCapital', label: 'Capital social (€)', type: 'money', required: true },
      { name: 'capital_variable', inpi: 'BlocDetailPersonneMorale.capitalVariable', label: 'Capital variable', type: 'checkbox' },
      { name: 'associe_unique', inpi: 'BlocDetailPersonneMorale.indicateurAssocieUnique', label: 'Société unipersonnelle (associé unique)', type: 'checkbox' },
      { name: 'duree', inpi: 'BlocDetailPersonneMorale.duree', label: 'Durée (années)', type: 'number', default: 99, required: true },
      { name: 'date_cloture', inpi: 'BlocDetailPersonneMorale.dateClotureExerciceSocial', label: 'Clôture de l’exercice (JJ/MM)', type: 'text', default: '31/12', required: true },
      { name: 'objet', inpi: 'BlocDetailPersonneMorale.objet', label: 'Objet social', type: 'textarea', required: true },
      { name: 'date_signature_statuts', label: 'Date de signature des statuts', type: 'date', required: true },
      { name: 'depositaire_fonds', label: 'Banque dépositaire des fonds', type: 'text', required: true },
      { name: 'apports_nature', label: 'Apports en nature', type: 'checkbox',
        aide: 'Déclenche l’exigence du rapport du commissaire aux apports.' },

      { name: '_s3', label: 'Siège social', type: 'section' },
      champAdresse('adresse_siege', 'Adresse du siège social', undefined, 'RubriqueAdresseEntreprise.adresse'),

      { name: '_s4', label: 'Activité et établissement principal', type: 'section' },
      { name: 'role_etablissement', inpi: 'BlocDescriptionEtablissement.rolePourEntreprise', label: 'Rôle de l’établissement', type: 'select', default: '2',
        options: optionsEnum('rolePourEntreprise', ['1', '2', '3']) },
      { name: 'activite_principale', inpi: 'BlocDescriptionActivite.descriptionDetaillee', label: 'Activité principale exercée', type: 'textarea', required: true },
      { name: 'precision_activite', inpi: 'BlocDescriptionActivite.precisionActivite', label: 'Précision sur l’activité', type: 'select',
        options: optionsEnum('precisionActivite') },
      { name: 'forme_exercice', inpi: 'Company.formeExerciceActivitePrincipale', label: 'Forme d’exercice de l’activité', type: 'select', default: 'COMMERCIALE',
        options: optionsEnum('formeExerciceActivitePrincipale') },
      { name: 'exercice_activite', inpi: 'BlocDescriptionActivite.exerciceActivite', label: 'Exercice', type: 'select', default: 'P', options: optionsEnum('exerciceActivite') },
      { name: 'activite_reguliere', inpi: 'BlocDescriptionActivite.activiteReguliere', label: 'Régularité', type: 'select', default: 'R', options: optionsEnum('activiteReguliere') },
      { name: 'origine_activite', inpi: 'BlocDescriptionActivite.origine', label: 'Origine du fonds', type: 'select', default: '1', options: optionsEnum('typeOrigine') },
      { name: 'date_debut_activite', inpi: 'BlocDescriptionActivite.dateDebut', label: 'Date de début d’activité', type: 'date', required: true },

      { name: '_s5', label: 'Autres établissements', type: 'section',
        aide: 'Laisser vide s’il n’y a que le siège.' },
      { name: 'autres_etablissements', label: 'Établissements secondaires', type: 'liste', champs: [
        champAdresse('adresse', 'Adresse'),
        { name: 'activite', label: 'Activité exercée', type: 'textarea' },
        { name: 'role', label: 'Rôle', type: 'select', default: '3', options: optionsEnum('rolePourEntreprise', ['1', '2', '3']) },
        { name: 'date_debut', label: 'Date d’ouverture', type: 'date' },
      ] },

      { name: '_s6', label: 'Dirigeants', type: 'section' },
      { name: 'dirigeants', label: 'Représentants légaux', type: 'liste', champs: [
        champPersonne('personne', 'Personne'),
      ] },
      { name: 'nature_gerance', label: 'Nature de la gérance (SARL)', type: 'select', options: optionsEnum('natureGerance') },

      { name: '_s7', label: 'Associés et actionnaires', type: 'section' },
      { name: 'associes', label: 'Associés', type: 'liste', champs: [
        champPersonne('personne', 'Associé'),
        { name: 'parts', label: 'Parts ou actions détenues', type: 'number' },
        { name: 'pourcentage', label: '% du capital', type: 'number' },
      ] },

      { name: '_s8', label: 'Bénéficiaires effectifs', type: 'section',
        aide: 'Déclaration obligatoire au registre national des entreprises.' },
      { name: 'beneficiaires_effectifs', label: 'Bénéficiaires effectifs', type: 'liste', champs: [
        champPersonne('personne', 'Bénéficiaire'),
        { name: 'modalite_controle', label: 'Modalité du contrôle', type: 'select', options: optionsEnum('modalitesDeControle') },
        { name: 'pourcentage_capital', label: '% du capital', type: 'number' },
        { name: 'pourcentage_votes', label: '% des droits de vote', type: 'number' },
      ] },

      { name: '_s9', label: 'Options fiscales', type: 'section' },
      { name: 'regime_benefices', inpi: 'BlocOptionFiscale.regimeImpositionBenefices', label: 'Régime d’imposition des bénéfices', type: 'select',
        options: optionsEnum('regimeImpositionBenefices') },
      { name: 'regime_tva', inpi: 'BlocOptionFiscale.regimeImpositionTVA', label: 'Régime de TVA', type: 'select', options: optionsEnum('regimeImpositionTVA') },
      { name: 'periodicite_tva', inpi: 'BlocOptionFiscale.periodiciteEtOptionsParticulieresTVA', label: 'Périodicité et options TVA', type: 'select',
        options: optionsEnum('periodiciteEtOptionsParticulie') },
      { name: 'date_cloture_comptable', inpi: 'BlocOptionFiscale.dateClotureExerciceComptable', label: 'Première clôture comptable', type: 'date' },
      { name: 'ca_previsionnel_vente', inpi: 'BlocOptionFiscale.chiffreAffairePrevisionnelVente', label: 'CA prévisionnel — ventes (€)', type: 'money' },
      { name: 'ca_previsionnel_service', inpi: 'BlocOptionFiscale.chiffreAffairePrevisionnelService', label: 'CA prévisionnel — services (€)', type: 'money' },

      { name: '_s10', label: 'Salariés', type: 'section' },
      { name: 'emploi_salaries', inpi: 'BlocEtablissementSalarie.presenceSalarie', label: 'La société emploie des salariés', type: 'checkbox' },
      { name: 'date_premiere_embauche', inpi: 'BlocEtablissementSalarie.dateEffetDebutEmploiSalarie', label: 'Date de la première embauche', type: 'date' },
      { name: 'effectif_salarie', inpi: 'BlocEtablissementSalarie.nombreSalarie', label: 'Effectif salarié', type: 'number' },

      { name: '_s11', label: 'Correspondance et publication', type: 'section' },
      { name: 'contact_nom', label: 'Destinataire de la correspondance', type: 'text' },
      { name: 'contact_email', inpi: 'BlocContact.mail', label: 'Courriel', type: 'text' },
      { name: 'contact_telephone', inpi: 'BlocContact.telephone', label: 'Téléphone', type: 'text' },
      { name: 'journal_publication', inpi: 'BlocPublication.journalPublication', label: 'Journal d’annonces légales', type: 'text' },
      { name: 'date_publication', inpi: 'BlocPublication.datePublication', label: 'Date de publication', type: 'date' },
    ],
    pieces: [
      { code: 'PJ_01', obligatoire: true },
      { code: 'PJ_06', obligatoire: true },
      { code: 'PJ_25', obligatoire: true },
      { code: 'PJ_11', obligatoire: true },
      { code: 'PJ_17', obligatoire: true },
      { code: 'PJ_08', obligatoire: true },
      { code: 'PJ_04', obligatoire: true, condition: (r) => Boolean(r.apports_nature) },
      { code: 'PJ_51', obligatoire: false, aide: 'Si le déposant n’est pas le représentant légal.' },
    ],
    controles(r) {
      const alertes = [];
      if (nombre(r.capital) !== null && nombre(r.capital) <= 0) {
        alertes.push({ niveau: 'bloquant', message: 'Le capital social doit être supérieur à zéro.' });
      }
      if (r.date_signature_statuts && r.date_debut_activite && r.date_debut_activite < r.date_signature_statuts) {
        alertes.push({ niveau: 'alerte', message: 'Le début d’activité est antérieur à la signature des statuts.' });
      }
      return alertes;
    },
    apercu: (r) => [
      ['Dénomination', r.denomination],
      ['Forme', r.forme_juridique_libelle || r.forme_juridique_code],
      ['Capital', r.capital ? `${r.capital} €` : ''],
      ['Siège', r.adresse_siege?.texte],
      ['Début d’activité', r.date_debut_activite],
    ],
  },

  transfert_siege: {
    libelle: 'Transfert de siège social',
    categorie: 'modification',
    typeFormalite: TYPES_FORMALITE.MODIFICATION,
    evenement: '11M',
    service: 'formalites',
    resume: 'Déclarer la nouvelle adresse du siège social.',
    signature: 'avancee',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      champAdresse('nouvelle_adresse', 'Nouvelle adresse du siège', undefined, 'RubriqueAdresseEntreprise.adresse'),
      { name: 'date_effet', label: 'Date d’effet du transfert', type: 'date',
        aide: 'Laisser vide si le transfert prend effet à la date de la décision.' },
      { name: 'hors_ressort', label: 'Transfert dans un autre ressort de greffe', type: 'checkbox',
        aide: 'Impose une double publication (ancien et nouveau ressort).' },
      { name: 'transfert_etablissement', label: 'L’établissement principal suit le siège', type: 'checkbox', default: true },
    ],
    pieces: [
      { code: 'PJ_54', obligatoire: true },
      { code: 'PJ_02', obligatoire: true },
      { code: 'PJ_25', obligatoire: true },
      { code: 'PJ_08', obligatoire: true,
        aide: 'Deux attestations en cas de changement de ressort (ancien et nouveau).' },
      { code: 'PJ_97', obligatoire: false, condition: (r) => Boolean(r.hors_ressort) },
    ],
    controles(r, fiche) {
      const alertes = [];
      const cp = r.nouvelle_adresse?.codePostal;
      if (cp && fiche?.adresse?.codePostal && cp.slice(0, 2) !== fiche.adresse.codePostal.slice(0, 2) && !r.hors_ressort) {
        alertes.push({
          niveau: 'alerte',
          message: 'Le département change : vérifier s’il s’agit d’un transfert hors ressort (double publication et, le cas échéant, décision de l’organe compétent pour modifier les statuts).',
        });
      }
      if (r.date_effet && r.date_decision && r.date_effet < r.date_decision) {
        alertes.push({ niveau: 'alerte', message: 'La date d’effet précède la décision.' });
      }
      return alertes;
    },
    apercu: (r, fiche) => [
      ['Ancien siège', fiche?.adresse?.texte],
      ['Nouveau siège', r.nouvelle_adresse?.texte],
      ['Décision du', r.date_decision],
      ['Hors ressort', r.hors_ressort ? 'Oui' : 'Non'],
    ],
  },

  changement_dirigeant: {
    libelle: 'Changement de dirigeant',
    categorie: 'modification',
    typeFormalite: TYPES_FORMALITE.MODIFICATION,
    evenement: '35M',
    service: 'formalites',
    resume: 'Nomination, cessation ou remplacement d’un représentant légal.',
    signature: 'avancee',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      { name: 'nature', label: 'Nature du changement', type: 'select', required: true, default: 'remplacement',
        options: [
          { value: 'nomination', label: 'Nomination (ajout)' },
          { value: 'cessation', label: 'Cessation de fonctions (départ)' },
          { value: 'remplacement', label: 'Remplacement' },
        ] },
      { name: 'dirigeant_sortant', label: 'Dirigeant sortant', type: 'select', source: 'dirigeants_rne',
        required: true, depend: { name: 'nature', valeurs: ['cessation', 'remplacement'] } },
      champPersonne('dirigeant_entrant', 'Nouveau dirigeant', {
        depend: { name: 'nature', valeurs: ['nomination', 'remplacement'] },
      }),
      { name: 'fonction', label: 'Fonction', type: 'text',
        depend: { name: 'nature', valeurs: ['nomination', 'remplacement'] },
        aide: 'Déduite de la forme juridique si laissée vide (Président de SAS, Gérant…).' },
      { name: 'demission', label: 'Départ par démission', type: 'checkbox',
        depend: { name: 'nature', valeurs: ['cessation', 'remplacement'] } },
    ],
    pieces: [
      { code: 'PJ_54', obligatoire: true },
      { code: 'PJ_03', obligatoire: false, condition: (r) => r.nature !== 'cessation' },
      { code: 'PJ_11', obligatoire: true, condition: (r) => r.nature !== 'cessation' },
      { code: 'PJ_63', obligatoire: true, condition: (r) => r.nature !== 'cessation' },
      { code: 'PJ_64', obligatoire: true, condition: (r) => r.nature !== 'cessation' },
      { code: 'PJ_230', obligatoire: false, condition: (r) => Boolean(r.demission) },
      { code: 'PJ_02', obligatoire: false, aide: 'Si le dirigeant est désigné dans les statuts.' },
      { code: 'PJ_08', obligatoire: false,
        aide: 'Publication requise pour les sociétés commerciales lors du changement de représentant légal.' },
    ],
    controles(r) {
      const alertes = [];
      const p = r.dirigeant_entrant;
      if (r.nature !== 'cessation' && p?.date_naissance) {
        const age = (Date.now() - new Date(p.date_naissance).getTime()) / (365.25 * 24 * 3600 * 1000);
        if (age < 18) alertes.push({ niveau: 'bloquant', message: 'Le dirigeant déclaré est mineur.' });
      }
      return alertes;
    },
    apercu: (r) => [
      ['Nature', r.nature],
      ['Sortant', r.dirigeant_sortant],
      ['Entrant', r.dirigeant_entrant?.nom_complet],
      ['Fonction', r.fonction],
      ['Décision du', r.date_decision],
    ],
  },

  changement_denomination: {
    libelle: 'Changement de dénomination sociale',
    categorie: 'modification',
    typeFormalite: TYPES_FORMALITE.MODIFICATION,
    evenement: '10M',
    service: 'formalites',
    resume: 'Modifier le nom de la société (et son sigle).',
    signature: 'avancee',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      { name: 'nouvelle_denomination', label: 'Nouvelle dénomination', type: 'text', required: true },
      { name: 'nouveau_sigle', label: 'Nouveau sigle', type: 'text' },
      { name: 'nouveau_nom_commercial', label: 'Nouveau nom commercial', type: 'text' },
    ],
    pieces: [
      { code: 'PJ_54', obligatoire: true },
      { code: 'PJ_02', obligatoire: true },
      { code: 'PJ_08', obligatoire: true },
    ],
    controles(r, fiche) {
      const alertes = [];
      if (fiche?.denomination && r.nouvelle_denomination
        && fiche.denomination.trim().toUpperCase() === r.nouvelle_denomination.trim().toUpperCase()) {
        alertes.push({ niveau: 'bloquant', message: 'La nouvelle dénomination est identique à l’actuelle.' });
      }
      alertes.push({ niveau: 'info', message: 'Penser à la recherche d’antériorité de marque avant dépôt.' });
      return alertes;
    },
    apercu: (r, fiche) => [
      ['Ancienne dénomination', fiche?.denomination],
      ['Nouvelle dénomination', r.nouvelle_denomination],
      ['Décision du', r.date_decision],
    ],
  },

  modification_capital: {
    libelle: 'Modification du capital social',
    categorie: 'modification',
    typeFormalite: TYPES_FORMALITE.MODIFICATION,
    evenement: '15M',
    service: 'formalites',
    resume: 'Augmentation ou réduction du capital.',
    signature: 'avancee',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      { name: 'sens', label: 'Sens de l’opération', type: 'select', required: true, default: 'augmentation',
        options: [
          { value: 'augmentation', label: 'Augmentation de capital' },
          { value: 'reduction', label: 'Réduction de capital' },
        ] },
      { name: 'nouveau_capital', label: 'Nouveau capital social (€)', type: 'money', required: true },
      // Modalités reprises des énumérations officielles du Guichet unique.
      { name: 'modalite', label: 'Modalité de l’augmentation', type: 'select', required: true,
        default: 'APPORT_NUMERAIRE', depend: { name: 'sens', valeurs: ['augmentation'] },
        options: optionsEnum('typeAugmentationCapital') },
      { name: 'modalite', label: 'Modalité de la réduction', type: 'select', required: true,
        default: 'AUTRE', depend: { name: 'sens', valeurs: ['reduction'] },
        options: optionsEnum('typeReductionCapital') },
      { name: 'capital_variable', label: 'Capital variable', type: 'checkbox' },
    ],
    pieces: [
      { code: 'PJ_155', obligatoire: true, condition: (r) => r.sens === 'augmentation' },
      { code: 'PJ_156', obligatoire: true, condition: (r) => r.sens === 'reduction' },
      { code: 'PJ_02', obligatoire: true },
      { code: 'PJ_08', obligatoire: true },
      { code: 'PJ_56', obligatoire: true,
        condition: (r) => r.sens === 'augmentation' && String(r.modalite || '').includes('NUMERAIRE') },
      { code: 'PJ_04', obligatoire: true,
        condition: (r) => r.sens === 'augmentation' && String(r.modalite || '').includes('NATURE') },
      { code: 'PJ_57', obligatoire: false, condition: (r) => r.sens === 'augmentation',
        aide: 'En cas de libération par compensation de créances.' },
    ],
    controles(r, fiche) {
      const alertes = [];
      const nouveau = nombre(r.nouveau_capital);
      const actuel = fiche?.capital ?? null;
      if (nouveau !== null && nouveau <= 0) {
        alertes.push({ niveau: 'bloquant', message: 'Le nouveau capital doit être supérieur à zéro.' });
      }
      if (nouveau !== null && actuel !== null) {
        if (r.sens === 'augmentation' && nouveau <= actuel) {
          alertes.push({ niveau: 'bloquant', message: `Augmentation déclarée mais le capital passe de ${actuel} € à ${nouveau} €.` });
        }
        if (r.sens === 'reduction' && nouveau >= actuel) {
          alertes.push({ niveau: 'bloquant', message: `Réduction déclarée mais le capital passe de ${actuel} € à ${nouveau} €.` });
        }
      }
      if (r.sens === 'reduction') {
        alertes.push({
          niveau: 'alerte',
          message: 'Réduction de capital : purger le délai d’opposition des créanciers lorsqu’elle n’est pas motivée par des pertes.',
        });
      }
      return alertes;
    },
    apercu: (r, fiche) => [
      ['Capital actuel', fiche?.capital != null ? `${fiche.capital} €` : ''],
      ['Nouveau capital', r.nouveau_capital ? `${r.nouveau_capital} €` : ''],
      ['Modalité', r.modalite],
      ['Décision du', r.date_decision],
    ],
  },

  modification_objet: {
    libelle: 'Modification de l’objet social',
    categorie: 'modification',
    typeFormalite: TYPES_FORMALITE.MODIFICATION,
    evenement: '12M',
    service: 'formalites',
    resume: 'Changer l’objet social et, le cas échéant, l’activité déclarée.',
    signature: 'avancee',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      { name: 'nouvel_objet', label: 'Nouvel objet social', type: 'textarea', required: true },
      { name: 'nouvelle_activite', label: 'Nouvelle activité principale exercée', type: 'textarea',
        aide: 'À renseigner si l’activité réellement exercée change (impacte le code APE).' },
      { name: 'activite_reglementee', label: 'Activité réglementée', type: 'checkbox',
        aide: 'Déclenche l’exigence d’un justificatif d’autorisation ou de diplôme.' },
    ],
    pieces: [
      { code: 'PJ_54', obligatoire: true },
      { code: 'PJ_02', obligatoire: true },
      { code: 'PJ_08', obligatoire: true },
      { code: 'PJ_31', obligatoire: true, condition: (r) => Boolean(r.activite_reglementee) },
    ],
    controles(r) {
      return r.activite_reglementee
        ? [{ niveau: 'alerte', message: 'Activité réglementée : joindre l’autorisation, l’agrément ou le diplôme exigé.' }]
        : [];
    },
    apercu: (r) => [
      ['Nouvel objet', (r.nouvel_objet || '').slice(0, 140)],
      ['Décision du', r.date_decision],
    ],
  },

  cessation: {
    libelle: 'Cessation d’activité / dissolution',
    categorie: 'cessation',
    typeFormalite: TYPES_FORMALITE.CESSATION,
    evenement: '22M',
    service: 'formalites',
    resume: 'Dissolution, clôture de liquidation ou cessation totale d’activité.',
    signature: 'avancee',
    delai: { base: 'date_cessation', ...DELAI_MODIFICATION },
    champs: [
      { name: 'nature', label: 'Nature', type: 'select', required: true, default: 'dissolution',
        options: [
          { value: 'dissolution', label: 'Dissolution anticipée (évènement 22M)' },
          { value: 'cloture_liquidation', label: 'Clôture de liquidation et radiation (évènement 42M)' },
          { value: 'cessation_activite', label: 'Cessation totale d’activité sans disparition (évènement 40M)' },
        ] },
      { name: 'date_cessation', label: 'Date de la décision / de cessation', type: 'date', required: true },
      { name: 'type_dissolution', label: 'Type de dissolution', type: 'select', default: '1',
        depend: { name: 'nature', valeurs: ['dissolution'] }, options: optionsEnum('typeDissolution') },
      champPersonne('liquidateur', 'Liquidateur', { depend: { name: 'nature', valeurs: ['dissolution'] } }),
      champAdresse('adresse_liquidation', 'Adresse du siège de liquidation',
        'Adresse à laquelle la correspondance doit être adressée pendant la liquidation.'),
      { name: 'boni_mali', label: 'Boni / mali de liquidation (€)', type: 'money',
        depend: { name: 'nature', valeurs: ['cloture_liquidation'] } },
    ],
    pieces: [
      { code: 'PJ_54', obligatoire: true, condition: (r) => r.nature !== 'cloture_liquidation' },
      { code: 'PJ_133', obligatoire: true, condition: (r) => r.nature === 'cloture_liquidation' },
      { code: 'PJ_82', obligatoire: true, condition: (r) => r.nature === 'cloture_liquidation' },
      { code: 'PJ_08', obligatoire: true },
      { code: 'PJ_11', obligatoire: true, condition: (r) => r.nature === 'dissolution',
        aide: 'Pièce d’identité du liquidateur.' },
    ],
    controles(r) {
      return r.nature === 'cloture_liquidation'
        ? [{ niveau: 'alerte', message: 'La clôture de liquidation emporte radiation : vérifier que la dissolution a bien été publiée au préalable.' }]
        : [];
    },
    apercu: (r) => [
      ['Nature', r.nature],
      ['Date', r.date_cessation],
      ['Liquidateur', r.liquidateur?.nom_complet],
    ],
  },

  depot_comptes: {
    libelle: 'Dépôt des comptes annuels',
    categorie: 'depot',
    // Service dédié du Guichet unique (/api/annual_accounts), distinct des
    // formalités de création / modification / cessation.
    typeFormalite: null,
    service: 'comptes_annuels',
    evenement: null,
    resume: 'Déposer les comptes approuvés et, si besoin, demander leur confidentialité.',
    signature: 'avancee',
    delai: {
      base: 'date_approbation', jours: 60,
      texte: 'Dans le mois de l’approbation, porté à deux mois en cas de dépôt par voie électronique (art. R. 123-111 c. com.).',
    },
    champs: [
      { name: 'exercice_debut', label: 'Début de l’exercice', type: 'date' },
      { name: 'exercice_clos', label: 'Date de clôture de l’exercice', type: 'date', required: true },
      { name: 'date_approbation', label: 'Date d’approbation des comptes', type: 'date', required: true },
      { name: 'resultat', label: 'Résultat de l’exercice (€)', type: 'money', required: true },
      { name: 'affectation', label: 'Affectation du résultat', type: 'select', required: true, default: 'report',
        options: [
          { value: 'report', label: 'Report à nouveau' },
          { value: 'reserves', label: 'Affectation en réserves' },
          { value: 'dividendes', label: 'Distribution de dividendes' },
        ] },
      { name: 'montant_dividendes', label: 'Dividendes distribués (€)', type: 'money',
        depend: { name: 'affectation', valeurs: ['dividendes'] } },
      { name: 'confidentialite', label: 'Confidentialité des comptes', type: 'select', default: 'aucune',
        options: [
          { value: 'aucune', label: 'Aucune (publication intégrale)' },
          { value: 'totale', label: 'Comptes confidentiels (micro-entreprise)' },
          { value: 'resultat', label: 'Compte de résultat confidentiel (petite entreprise)' },
        ],
        aide: 'La confidentialité suppose de respecter les seuils de la catégorie déclarée.' },
      { name: 'depot_simplifie', label: 'Présentation simplifiée', type: 'checkbox' },
      { name: 'dispense_annexes', label: 'Dispense de dépôt des annexes', type: 'checkbox' },
      { name: 'comptes_consolides', label: 'Comptes consolidés', type: 'checkbox' },
      { name: 'commissaire_comptes', label: 'Société dotée d’un commissaire aux comptes', type: 'checkbox' },
    ],
    pieces: [
      { code: 'PJ_232', obligatoire: true },
      { code: 'PJ_236', obligatoire: true },
      { code: 'PJ_235', obligatoire: true, condition: (r) => Boolean(r.commissaire_comptes) },
    ],
    controles(r) {
      const alertes = [];
      if (r.exercice_clos && r.date_approbation && r.date_approbation <= r.exercice_clos) {
        alertes.push({ niveau: 'bloquant', message: 'L’approbation des comptes ne peut pas précéder la clôture de l’exercice.' });
      }
      if (r.exercice_clos && r.date_approbation) {
        const mois = (new Date(r.date_approbation) - new Date(r.exercice_clos)) / (30.44 * 24 * 3600 * 1000);
        if (mois > 6.2) {
          alertes.push({
            niveau: 'alerte',
            message: 'Approbation au-delà de six mois après la clôture : une prorogation judiciaire du délai était requise.',
          });
        }
      }
      if (r.affectation === 'dividendes' && !nombre(r.montant_dividendes)) {
        alertes.push({ niveau: 'bloquant', message: 'Préciser le montant des dividendes distribués.' });
      }
      return alertes;
    },
    apercu: (r) => [
      ['Exercice clos le', r.exercice_clos],
      ['Approuvés le', r.date_approbation],
      ['Résultat', r.resultat != null && r.resultat !== '' ? `${r.resultat} €` : ''],
      ['Confidentialité', r.confidentialite || 'aucune'],
    ],
  },
};

/** Libellé officiel d'une pièce, avec repli si le code n'est pas au catalogue. */
function decrirePiece(p) {
  const officielle = piece(p.code);
  return {
    code: p.code,
    libelle: officielle ? officielle.libelle : p.code,
    nota: officielle?.nota || null,
    obligatoire: Boolean(p.obligatoire),
    conditionnelle: Boolean(p.condition),
    aide: p.aide || null,
  };
}

/** Liste destinée au front (les fonctions ne sont pas sérialisables). */
function catalogue() {
  return Object.entries(FORMALITES).map(([code, f]) => ({
    code,
    libelle: f.libelle,
    categorie: f.categorie,
    resume: f.resume,
    sansSiren: Boolean(f.sansSiren),
    typeFormalite: f.typeFormalite,
    service: f.service,
    evenement: f.evenement,
    evenement_libelle: f.evenement ? EVENEMENTS[f.evenement] || null : null,
    signature: f.signature,
    delai: f.delai,
    champs: f.champs,
    pieces: f.pieces.map(decrirePiece),
  }));
}

function definition(code) {
  return FORMALITES[code] || null;
}

/** Pièces réellement exigées compte tenu des réponses saisies. */
function piecesExigees(code, reponses = {}) {
  const def = definition(code);
  if (!def) return [];
  return def.pieces.filter((p) => !p.condition || p.condition(reponses)).map(decrirePiece);
}

/**
 * Champs réellement à saisir (les dépendances masquent le reste), enrichis de
 * ce que le dictionnaire officiel dit de leur caractère obligatoire.
 *
 * Le drapeau `required` reste notre appréciation ; `obligation` est le texte
 * de l'INPI, qui seul fait foi, et qui est presque toujours conditionnel.
 */
function champsActifs(code, reponses = {}) {
  return champsDecrits(code)
    .filter((c) => !c.depend || c.depend.valeurs.includes(reponses[c.depend.name]));
}

/** Tous les champs d'une formalité, enrichis de la règle INPI. */
function champsDecrits(code) {
  const def = definition(code);
  if (!def) return [];
  return def.champs.map((c) => (c.inpi ? { ...c, obligation: obligation(c.inpi) } : c));
}

module.exports = { FORMALITES, catalogue, definition, piecesExigees, champsActifs, champsDecrits };
