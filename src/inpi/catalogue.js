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
 *   champs   — le questionnaire minimal (rendu automatiquement par le front) ;
 *   pieces   — les pièces justificatives, avec leur condition d'exigibilité ;
 *   delai    — le délai légal, calculé sur une date du questionnaire ;
 *   controles— les vérifications métier propres à la formalité ;
 *   apercu   — le récapitulatif lisible présenté avant dépôt.
 *
 * Les délais rappelés sont ceux du code de commerce ; ils sont affichés à
 * titre d'aide au suivi et ne remplacent pas l'analyse du dossier.
 */

const { TYPES_FORMALITE, TYPES_PIECE } = require('./referentiels');

const DELAI_MODIFICATION = {
  jours: 30,
  texte: 'Dans le mois de la décision (art. R. 123-66 du code de commerce).',
};

/* ----------------------------------------------------- champs réutilisables */

const champDateDecision = {
  name: 'date_decision', label: 'Date de la décision', type: 'date', required: true,
  aide: 'Date du PV d’assemblée ou de la décision de l’associé unique. Elle déclenche le délai de dépôt.',
};

const champAdresse = (name, label, aide) => ({
  name, label, type: 'adresse', required: true, aide,
});

const champPersonne = (name, label, opts = {}) => ({
  name, label, type: 'personne', required: true, ...opts,
});

/* ------------------------------------------------------------- utilitaires */

const nombre = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/* -------------------------------------------------------------- catalogue */

const FORMALITES = {
  creation_societe: {
    libelle: 'Création d’une société',
    categorie: 'creation',
    typeFormalite: TYPES_FORMALITE.CREATION,
    resume: 'Immatriculer une société au registre national des entreprises.',
    sansSiren: true,
    delai: {
      base: 'date_debut_activite', jours: 15,
      texte: 'Au plus tard dans les quinze jours du début d’activité.',
    },
    champs: [
      { name: 'forme_juridique_code', label: 'Forme juridique', type: 'select', required: true, source: 'formes' },
      { name: 'denomination', label: 'Dénomination sociale', type: 'text', required: true },
      { name: 'sigle', label: 'Sigle', type: 'text' },
      { name: 'capital', label: 'Capital social (€)', type: 'money', required: true },
      { name: 'duree', label: 'Durée (années)', type: 'number', default: 99, required: true },
      { name: 'date_cloture', label: 'Clôture de l’exercice (JJ/MM)', type: 'text', default: '31/12', required: true },
      { name: 'objet', label: 'Objet social', type: 'textarea', required: true },
      champAdresse('adresse_siege', 'Adresse du siège social'),
      { name: 'activite_principale', label: 'Activité principale exercée', type: 'textarea', required: true },
      { name: 'date_debut_activite', label: 'Date de début d’activité', type: 'date', required: true },
      { name: 'date_signature_statuts', label: 'Date de signature des statuts', type: 'date', required: true },
      { name: 'depositaire_fonds', label: 'Banque dépositaire des fonds', type: 'text', required: true },
      { name: 'apports_nature', label: 'Apports en nature', type: 'checkbox',
        aide: 'Déclenche l’exigence du rapport du commissaire aux apports.' },
      champPersonne('dirigeant', 'Dirigeant (représentant légal)'),
    ],
    pieces: [
      { type: TYPES_PIECE.STATUTS, obligatoire: true },
      { type: TYPES_PIECE.ATTESTATION_DEPOT_FONDS, obligatoire: true },
      { type: TYPES_PIECE.JOUISSANCE_LOCAUX, obligatoire: true },
      { type: TYPES_PIECE.PIECE_IDENTITE, obligatoire: true },
      { type: TYPES_PIECE.DNC, obligatoire: true },
      { type: TYPES_PIECE.JAL, obligatoire: true },
      { type: TYPES_PIECE.RAPPORT_CAC, obligatoire: true, condition: (r) => Boolean(r.apports_nature),
        aide: 'Exigé en présence d’apports en nature (sauf dispense régulière).' },
    ],
    controles(r) {
      const alertes = [];
      if (nombre(r.capital) !== null && nombre(r.capital) <= 0) {
        alertes.push({ niveau: 'bloquant', message: 'Le capital social doit être supérieur à zéro.' });
      }
      if (r.date_signature_statuts && r.date_debut_activite
        && r.date_debut_activite < r.date_signature_statuts) {
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
    resume: 'Déclarer la nouvelle adresse du siège social.',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      champAdresse('nouvelle_adresse', 'Nouvelle adresse du siège'),
      { name: 'date_effet', label: 'Date d’effet du transfert', type: 'date',
        aide: 'Laisser vide si le transfert prend effet à la date de la décision.' },
      { name: 'hors_ressort', label: 'Transfert dans un autre ressort de greffe', type: 'checkbox',
        aide: 'Impose une double publication (ancien et nouveau ressort).' },
      { name: 'transfert_etablissement', label: 'L’établissement principal suit le siège', type: 'checkbox', default: true },
    ],
    pieces: [
      { type: TYPES_PIECE.PV_DECISION, obligatoire: true },
      { type: TYPES_PIECE.STATUTS, obligatoire: true, aide: 'Statuts mis à jour de la nouvelle adresse.' },
      { type: TYPES_PIECE.JOUISSANCE_LOCAUX, obligatoire: true },
      { type: TYPES_PIECE.JAL, obligatoire: true,
        aide: 'Deux attestations en cas de changement de ressort (ancien et nouveau).' },
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
    resume: 'Nomination, cessation ou remplacement d’un représentant légal.',
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
      { name: 'fonction', label: 'Fonction', type: 'text', required: true, default: '',
        depend: { name: 'nature', valeurs: ['nomination', 'remplacement'] },
        aide: 'Reprise de la forme juridique si laissée vide (Président, Gérant…).' },
    ],
    pieces: [
      { type: TYPES_PIECE.PV_DECISION, obligatoire: true },
      { type: TYPES_PIECE.PIECE_IDENTITE, obligatoire: true, condition: (r) => r.nature !== 'cessation' },
      { type: TYPES_PIECE.DNC, obligatoire: true, condition: (r) => r.nature !== 'cessation' },
      { type: TYPES_PIECE.STATUTS, obligatoire: false,
        aide: 'Si le dirigeant est nommé dans les statuts, joindre les statuts mis à jour.' },
      { type: TYPES_PIECE.JAL, obligatoire: false,
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
    resume: 'Modifier le nom de la société (et son sigle).',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      { name: 'nouvelle_denomination', label: 'Nouvelle dénomination', type: 'text', required: true },
      { name: 'nouveau_sigle', label: 'Nouveau sigle', type: 'text' },
      { name: 'nouveau_nom_commercial', label: 'Nouveau nom commercial', type: 'text' },
    ],
    pieces: [
      { type: TYPES_PIECE.PV_DECISION, obligatoire: true },
      { type: TYPES_PIECE.STATUTS, obligatoire: true },
      { type: TYPES_PIECE.JAL, obligatoire: true },
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
    resume: 'Augmentation ou réduction du capital.',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      { name: 'sens', label: 'Sens de l’opération', type: 'select', required: true, default: 'augmentation',
        options: [
          { value: 'augmentation', label: 'Augmentation de capital' },
          { value: 'reduction', label: 'Réduction de capital' },
        ] },
      { name: 'nouveau_capital', label: 'Nouveau capital social (€)', type: 'money', required: true },
      { name: 'modalite', label: 'Modalité', type: 'select', required: true, default: 'numeraire',
        options: [
          { value: 'numeraire', label: 'Apports en numéraire' },
          { value: 'nature', label: 'Apports en nature' },
          { value: 'reserves', label: 'Incorporation de réserves' },
          { value: 'creances', label: 'Compensation de créances' },
          { value: 'pertes', label: 'Réduction motivée par des pertes' },
        ] },
      { name: 'capital_variable', label: 'Capital variable', type: 'checkbox' },
    ],
    pieces: [
      { type: TYPES_PIECE.PV_DECISION, obligatoire: true },
      { type: TYPES_PIECE.STATUTS, obligatoire: true },
      { type: TYPES_PIECE.JAL, obligatoire: true },
      { type: TYPES_PIECE.ATTESTATION_DEPOT_FONDS, obligatoire: true, condition: (r) => r.modalite === 'numeraire' },
      { type: TYPES_PIECE.RAPPORT_CAC, obligatoire: true,
        condition: (r) => ['nature', 'creances'].includes(r.modalite),
        aide: 'Commissaire aux apports (apports en nature) ou rapport du CAC (compensation de créances).' },
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
      if (r.sens === 'reduction' && r.modalite !== 'pertes') {
        alertes.push({
          niveau: 'alerte',
          message: 'Réduction non motivée par des pertes : délai d’opposition des créanciers à purger avant réalisation définitive.',
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
    resume: 'Changer l’objet social et, le cas échéant, l’activité déclarée.',
    delai: { base: 'date_decision', ...DELAI_MODIFICATION },
    champs: [
      champDateDecision,
      { name: 'nouvel_objet', label: 'Nouvel objet social', type: 'textarea', required: true },
      { name: 'nouvelle_activite', label: 'Nouvelle activité principale exercée', type: 'textarea',
        aide: 'À renseigner si l’activité réellement exercée change (impacte le code APE).' },
      { name: 'activite_reglementee', label: 'Activité réglementée', type: 'checkbox',
        aide: 'Déclenche l’exigence d’un justificatif d’autorisation / diplôme.' },
    ],
    pieces: [
      { type: TYPES_PIECE.PV_DECISION, obligatoire: true },
      { type: TYPES_PIECE.STATUTS, obligatoire: true },
      { type: TYPES_PIECE.JAL, obligatoire: true },
      { type: TYPES_PIECE.POUVOIR, obligatoire: false },
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
    resume: 'Dissolution, clôture de liquidation ou cessation totale d’activité.',
    delai: { base: 'date_cessation', ...DELAI_MODIFICATION },
    champs: [
      { name: 'nature', label: 'Nature', type: 'select', required: true, default: 'dissolution',
        options: [
          { value: 'dissolution', label: 'Dissolution anticipée (ouverture de liquidation)' },
          { value: 'cloture_liquidation', label: 'Clôture de liquidation (radiation)' },
          { value: 'cessation_activite', label: 'Cessation totale d’activité' },
        ] },
      { name: 'date_cessation', label: 'Date de la décision / de cessation', type: 'date', required: true },
      champPersonne('liquidateur', 'Liquidateur', { depend: { name: 'nature', valeurs: ['dissolution'] } }),
      champAdresse('adresse_liquidation', 'Adresse du siège de liquidation',
        'Adresse à laquelle la correspondance doit être adressée pendant la liquidation.'),
      { name: 'boni_mali', label: 'Boni / mali de liquidation (€)', type: 'money',
        depend: { name: 'nature', valeurs: ['cloture_liquidation'] } },
    ],
    pieces: [
      { type: TYPES_PIECE.PV_DECISION, obligatoire: true },
      { type: TYPES_PIECE.JAL, obligatoire: true },
      { type: TYPES_PIECE.COMPTES_LIQUIDATION, obligatoire: true,
        condition: (r) => r.nature === 'cloture_liquidation' },
      { type: TYPES_PIECE.PIECE_IDENTITE, obligatoire: true, condition: (r) => r.nature === 'dissolution',
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
    typeFormalite: TYPES_FORMALITE.DEPOT_COMPTES,
    resume: 'Déposer les comptes approuvés et, si besoin, demander leur confidentialité.',
    delai: {
      base: 'date_approbation', jours: 60,
      texte: 'Dans le mois de l’approbation, porté à deux mois en cas de dépôt par voie électronique (art. R. 123-111 c. com.).',
    },
    champs: [
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
      { name: 'comptes_consolides', label: 'Comptes consolidés', type: 'checkbox' },
    ],
    pieces: [
      { type: TYPES_PIECE.COMPTES_ANNUELS, obligatoire: true },
      { type: TYPES_PIECE.PV_APPROBATION, obligatoire: true },
      { type: TYPES_PIECE.DECLARATION_CONFIDENTIALITE, obligatoire: true,
        condition: (r) => r.confidentialite && r.confidentialite !== 'aucune' },
      { type: TYPES_PIECE.RAPPORT_CAC, obligatoire: false,
        aide: 'Obligatoire si la société est dotée d’un commissaire aux comptes.' },
    ],
    controles(r) {
      const alertes = [];
      if (r.exercice_clos && r.date_approbation && r.date_approbation <= r.exercice_clos) {
        alertes.push({ niveau: 'bloquant', message: 'L’approbation des comptes ne peut pas précéder la clôture de l’exercice.' });
      }
      if (r.exercice_clos && r.date_approbation) {
        const clos = new Date(r.exercice_clos);
        const appro = new Date(r.date_approbation);
        const mois = (appro - clos) / (30.44 * 24 * 3600 * 1000);
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

/** Liste destinée au front (les fonctions ne sont pas sérialisables). */
function catalogue() {
  return Object.entries(FORMALITES).map(([code, f]) => ({
    code,
    libelle: f.libelle,
    categorie: f.categorie,
    resume: f.resume,
    sansSiren: Boolean(f.sansSiren),
    typeFormalite: f.typeFormalite,
    delai: f.delai,
    champs: f.champs,
    pieces: f.pieces.map((p) => ({
      code: p.type.code, libelle: p.type.libelle, obligatoire: p.obligatoire,
      conditionnelle: Boolean(p.condition), aide: p.aide || null,
    })),
  }));
}

function definition(code) {
  return FORMALITES[code] || null;
}

/** Pièces réellement exigées compte tenu des réponses saisies. */
function piecesExigees(code, reponses = {}) {
  const def = definition(code);
  if (!def) return [];
  return def.pieces
    .filter((p) => !p.condition || p.condition(reponses))
    .map((p) => ({
      code: p.type.code, libelle: p.type.libelle,
      obligatoire: Boolean(p.obligatoire), aide: p.aide || null,
    }));
}

/** Champs réellement à saisir (les dépendances masquent le reste). */
function champsActifs(code, reponses = {}) {
  const def = definition(code);
  if (!def) return [];
  return def.champs.filter((c) => !c.depend || c.depend.valeurs.includes(reponses[c.depend.name]));
}

module.exports = { FORMALITES, catalogue, definition, piecesExigees, champsActifs };
