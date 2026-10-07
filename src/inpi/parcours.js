'use strict';

/**
 * Le parcours de formalités : de l'opération choisie à la liste exacte des
 * pièces et des informations, sans rien demander d'inutile.
 *
 * Trois couches, de la plus juridique à la plus mécanique :
 *   1. les QUESTIONS de typologie — ce qui fait varier les pièces (le nouveau
 *      dirigeant est-il une personne physique ou morale ? le siège est-il
 *      domicilié ?). On ne pose que celles des opérations choisies, et
 *      seulement quand elles ont un effet ;
 *   2. les RÈGLES de pièces — pour chaque opération, quelles pièces, à quelle
 *      condition, et pour quelle personne. Plusieurs opérations du même
 *      dossier partagent leurs pièces communes (un seul PV, une seule annonce) ;
 *   3. les CHAMPS ciblés — uniquement les informations qui changent, avec la
 *      valeur actuelle du registre en regard.
 *
 * Les pièces viennent des fiches du catalogue (catalogue-evenements.js), déjà
 * confrontées au Code de commerce. Ce module ne fait que les qualifier :
 * une pièce « selon le cas » dont la condition est connue devient obligatoire
 * ou disparaît ; celle dont la condition n'est pas modélisée reste « à
 * apprécier » et l'utilisateur la coche s'il est concerné.
 */

const catalogue = require('./catalogue-evenements');
const creation = require('./parcours-creation');

/* ------------------------------------------------------------- opérations */

/** Nom courant des opérations, et type de questionnaire existant qui sait les déposer. */
const OPERATIONS = {
  '01M': { nom: 'Créer une société', type: 'creation_societe', creation: true },
  '02M': { nom: 'Créer une société sans activité', type: 'creation_societe', creation: true },
  '10M': { nom: 'Changer de dénomination', type: 'changement_denomination' },
  '11M': { nom: 'Transférer le siège social', type: 'transfert_siege' },
  '12M': { nom: 'Modifier l’objet social ou l’activité', type: 'modification_objet' },
  '13M': { nom: 'Transformer la société', type: 'transformation' },
  '14M': { nom: 'Déclarer un site internet', type: 'nom_domaine' },
  '15M': { nom: 'Augmenter ou réduire le capital', type: 'modification_capital' },
  '16M': { nom: 'Changer la date de clôture ou la durée', type: 'cloture_duree' },
  '17M': { nom: 'Passer à un associé unique (ou en sortir)', type: 'associe_unique' },
  '20M': { nom: 'Changer la date de début d’activité', type: null },
  '25M': { nom: 'Capitaux propres inférieurs à la moitié du capital', type: 'capitaux_propres' },
  '26M': { nom: 'Capitaux propres reconstitués', type: 'capitaux_propres' },
  '34M': { nom: 'Dirigeants d’une SNC, SCI ou société civile', type: 'changement_dirigeant' },
  '35M': { nom: 'Nommer ou remplacer un dirigeant ou un commissaire aux comptes', type: 'changement_dirigeant' },
  '38F': { nom: 'Déclarer ou modifier les bénéficiaires effectifs', type: null },
  '54PMF': { nom: 'Ouvrir un établissement', type: null },
  '56PMF': { nom: 'Transférer un établissement', type: null },
  '61PMF': { nom: 'Ajouter une activité', type: null },
  '80PMF': { nom: 'Fermer un établissement', type: null },
  '84M': { nom: 'Mettre le fonds en location-gérance', type: null },
  '22M': { nom: 'Dissoudre la société (liquidation amiable)', type: 'cessation', cessation: true },
  '28M': { nom: 'Dissolution-confusion (TUP)', type: null, cessation: true },
  '41M': { nom: 'Fusion : radier la société absorbée', type: null, cessation: true },
  '42M': { nom: 'Radier après la clôture de la liquidation', type: 'cessation', cessation: true },
};

/* ------------------------------------------------------------- questions */

const OUI_NON = [[true, 'Oui'], [false, 'Non']];

/**
 * Les questions de typologie. `si` restreint une question au cas où elle a
 * un effet ; `type` « personnes » ouvre une liste (une ligne par personne).
 */
const QUESTIONS = {
  ...creation.QUESTIONS,
  entrants: {
    libelle: 'Qui est nommé ?',
    aide: 'Une ligne par personne nommée : dirigeant, administrateur, commissaire aux comptes ou liquidateur.',
    type: 'entrants',
  },
  sortants: {
    libelle: 'Qui quitte ses fonctions ?',
    aide: 'Une ligne par personne qui part, avec le motif du départ.',
    type: 'sortants',
  },
  statuts_modifies: {
    libelle: 'Les statuts sont-ils modifiés (dirigeant nommé dans les statuts, par exemple) ?',
    type: 'choix', options: OUI_NON,
  },
  siege_occupation: {
    libelle: 'Où le siège est-il installé ?',
    type: 'choix',
    options: [
      ['locaux', 'Dans des locaux dont la société a la jouissance (bail, propriété…)'],
      ['domicile', 'Au domicile du représentant légal'],
      ['domiciliation', 'Chez une entreprise de domiciliation'],
    ],
  },
  domiciliataire_meme_greffe: {
    libelle: 'Le domiciliataire est-il immatriculé au même greffe ?',
    type: 'choix', options: OUI_NON,
    si: (t) => t.siege_occupation === 'domiciliation',
  },
  hors_ressort: {
    libelle: 'Le nouveau siège dépend-il d’un autre greffe ?',
    aide: 'Changement de tribunal de commerce : double annonce légale et liste des sièges antérieurs.',
    type: 'choix', options: OUI_NON,
  },
  capital_sens: {
    libelle: 'Augmentation ou réduction ?',
    type: 'choix', options: [['augmentation', 'Augmentation'], ['reduction', 'Réduction']],
  },
  capital_modalite: {
    libelle: 'Comment le capital est-il augmenté ?',
    type: 'choix',
    options: [
      ['numeraire', 'Apport en numéraire'],
      ['nature', 'Apport en nature'],
      ['incorporation', 'Incorporation de réserves'],
      ['compensation', 'Compensation de créances'],
    ],
    si: (t) => t.capital_sens === 'augmentation',
  },
  commissaire_apports: {
    libelle: 'Un commissaire aux apports a-t-il été désigné ?',
    type: 'choix', options: OUI_NON,
    si: (t) => t.capital_modalite === 'nature' || t.apports_nature === true,
  },
  activite_reglementee: {
    libelle: 'L’activité est-elle réglementée (agrément, diplôme, autorisation) ?',
    type: 'choix', options: OUI_NON,
  },
  rapport_transformation: {
    libelle: 'Un commissaire à la transformation a-t-il établi un rapport ?',
    aide: 'Requis notamment pour la transformation d’une SARL en SAS ou en SA en l’absence de commissaire aux comptes.',
    type: 'choix', options: OUI_NON,
  },
  apports_nature: {
    libelle: 'Y a-t-il des apports en nature ?',
    type: 'choix', options: OUI_NON,
  },
  premiers_dirigeants_statuts: {
    libelle: 'Les premiers dirigeants sont-ils nommés dans les statuts ?',
    type: 'choix', options: OUI_NON,
  },
  fonds_origine: {
    libelle: 'D’où vient le fonds exploité ?',
    type: 'choix',
    options: [
      ['creation', 'Création'],
      ['achat', 'Achat'],
      ['apport', 'Apport'],
      ['location', 'Prise en location-gérance'],
      ['gerance_mandat', 'Gérance-mandat'],
    ],
  },
};

/* ---------------------------------------------------------------- règles */

/** Pièces d'une personne nommée, selon sa nature et sa fonction. */
function piecesEntrant(e, forme) {
  const p = [];
  const fonction = creation.categorieFonction(e.fonction);
  if (fonction === 'cac') {
    p.push('PJ_41');
    if (e.inscrit === false) p.push('PJ_40');
    return p;
  }
  if (e.nature === 'PM') {
    p.push('PJ_20');
    if (fonction === 'administrateur' && /^55|^56/.test(forme || '')) p.push('PJ_80');
  } else {
    p.push('PJ_11', 'PJ_17');
  }
  return p;
}

/**
 * Pour chaque opération : les questions posées, et pour les pièces « selon
 * le cas » du catalogue, la règle qui tranche. Une règle renvoie true
 * (la pièce est due), false (elle ne l'est pas) ou undefined (la réponse
 * manque encore). Les pièces par personne sont produites par `personnes`.
 */
const PIECES_CREATION = {
  PJ_25: (t) => def(t.siege_occupation, () => t.siege_occupation === 'locaux'),
  PJ_26: (t) => def(t.siege_occupation, () => t.siege_occupation === 'domicile'),
  PJ_29: (t) => def(t.siege_occupation, () => t.siege_occupation === 'domiciliation'),
  PJ_45: (t) => def(t.siege_occupation, () => t.siege_occupation === 'domiciliation' && def(t.domiciliataire_meme_greffe, () => t.domiciliataire_meme_greffe === false)),
  PJ_06: (t) => def(t.apports_numeraire, () => t.apports_numeraire === true),
  PJ_03: (t) => def(t.premiers_dirigeants_statuts, () => t.premiers_dirigeants_statuts === false),
  PJ_04: (t) => def(t.apports_nature, () => t.apports_nature === true && def(t.commissaire_apports, () => t.commissaire_apports === true)),
  PJ_05: (t) => def(t.apports_nature, () => t.apports_nature === true),
  PJ_31: (t) => def(t.activite_reglementee, () => t.activite_reglementee === true),
};

const REGLES = {
  '01M': {
    questions: ['forme_creation', 'associe_unique_nature', 'entrants', 'premiers_dirigeants_statuts', 'siege_occupation', 'domiciliataire_meme_greffe',
      'apports_numeraire', 'apports_nature', 'commissaire_apports', 'fonds_origine', 'activite_reglementee'],
    pieces: PIECES_CREATION,
    ajouts: creation.AJOUTS,
    personnes: true,
  },
  '02M': {
    questions: ['forme_creation', 'associe_unique_nature', 'entrants', 'premiers_dirigeants_statuts', 'siege_occupation', 'domiciliataire_meme_greffe',
      'apports_numeraire', 'apports_nature', 'commissaire_apports'],
    pieces: PIECES_CREATION,
    personnes: true,
  },
  '11M': {
    questions: ['siege_occupation', 'domiciliataire_meme_greffe', 'hors_ressort'],
    pieces: {
      PJ_25: (t) => def(t.siege_occupation, () => t.siege_occupation === 'locaux'),
      PJ_26: (t) => def(t.siege_occupation, () => t.siege_occupation === 'domicile'),
      PJ_29: (t) => def(t.siege_occupation, () => t.siege_occupation === 'domiciliation'),
      PJ_45: (t) => def(t.siege_occupation, () => t.siege_occupation === 'domiciliation' && t.domiciliataire_meme_greffe === false),
      PJ_97: (t) => def(t.hors_ressort, () => t.hors_ressort === true),
    },
  },
  '12M': {
    questions: ['activite_reglementee'],
    pieces: { PJ_31: (t) => def(t.activite_reglementee, () => t.activite_reglementee === true) },
  },
  '13M': {
    questions: ['rapport_transformation'],
    pieces: {
      PJ_160: (t) => def(t.rapport_transformation, () => t.rapport_transformation === true),
      PJ_58: (t) => def(t.rapport_transformation, () => t.rapport_transformation === true),
    },
  },
  '15M': {
    questions: ['capital_sens', 'capital_modalite', 'commissaire_apports'],
    pieces: {
      PJ_180: (t) => def(t.capital_sens, () => t.capital_sens === 'augmentation' && def(t.capital_modalite, () => t.capital_modalite === 'numeraire')),
      PJ_163: (t) => def(t.capital_sens, () => t.capital_sens === 'augmentation' && def(t.capital_modalite, () => t.capital_modalite === 'nature' && t.commissaire_apports !== false)),
      PJ_191: () => false,
      PJ_57: (t) => def(t.capital_sens, () => t.capital_sens === 'augmentation' && def(t.capital_modalite, () => t.capital_modalite === 'compensation')),
      PJ_155: (t) => def(t.capital_sens, () => t.capital_sens === 'augmentation'),
      PJ_156: (t) => def(t.capital_sens, () => t.capital_sens === 'reduction'),
    },
  },
  '34M': {
    questions: ['entrants', 'sortants', 'statuts_modifies'],
    pieces: { PJ_02: (t) => def(t.statuts_modifies, () => t.statuts_modifies === true) },
    personnes: true,
  },
  '35M': {
    questions: ['entrants', 'sortants', 'statuts_modifies'],
    pieces: { PJ_02: (t) => def(t.statuts_modifies, () => t.statuts_modifies === true) },
    personnes: true,
  },
  '22M': {
    questions: ['entrants'],
    personnes: true,
  },
  '54PMF': {
    questions: ['siege_occupation', 'fonds_origine', 'activite_reglementee'],
    pieces: {
      PJ_25: (t) => def(t.siege_occupation, () => t.siege_occupation === 'locaux'),
      PJ_29: (t) => def(t.siege_occupation, () => t.siege_occupation === 'domiciliation'),
      PJ_33: (t) => def(t.fonds_origine, () => t.fonds_origine === 'achat'),
      PJ_36: (t) => def(t.fonds_origine, () => t.fonds_origine === 'apport'),
      PJ_37: (t) => def(t.fonds_origine, () => t.fonds_origine === 'location'),
      PJ_31: (t) => def(t.activite_reglementee, () => t.activite_reglementee === true),
    },
  },
  '61PMF': {
    questions: ['activite_reglementee'],
    pieces: { PJ_31: (t) => def(t.activite_reglementee, () => t.activite_reglementee === true) },
  },
};

/** true/false une fois la réponse connue, undefined tant qu'elle manque. */
function def(reponse, regle) {
  return reponse === undefined || reponse === null || reponse === '' ? undefined : regle();
}

/* Les pièces par personne remplacent ces pièces génériques du catalogue. */
const PIECES_PAR_PERSONNE = new Set(['PJ_11', 'PJ_12', 'PJ_17', 'PJ_20', 'PJ_80', 'PJ_40', 'PJ_41', 'PJ_230']);

/** Pièces jamais exigées, mais utiles à déposer selon le dossier. */
const FACULTATIVES = ['PJ_51'];

const FONCTIONS = [
  ['dirigeant', 'Dirigeant (président, gérant, directeur général…)'],
  ['administrateur', 'Administrateur ou membre du conseil'],
  ['cac', 'Commissaire aux comptes'],
  ['liquidateur', 'Liquidateur'],
];
const MOTIFS_DEPART = [
  ['demission', 'Démission'], ['revocation', 'Révocation'], ['fin_mandat', 'Fin de mandat'], ['deces', 'Décès'],
];

/* -------------------------------------------------------------- résolution */

/**
 * Tout ce que l'écran doit afficher, pour un jeu d'opérations et de réponses.
 * @param {string[]} operations codes d'événements
 * @param {object} t réponses de typologie (dont `manuel` : pièces cochées à la main)
 * @param {object} fiche fiche normalisée de la société (forme, dirigeants…)
 */
function resoudre(operations, t = {}, fiche = {}, rep = {}) {
  const ops = operations.filter((c) => catalogue.fiche(c));
  const estCreation = ops.some((c) => OPERATIONS[c]?.creation);
  const forme = (estCreation ? creation.forme(t)?.code : fiche.forme_juridique_code) || '';
  const manuel = t.manuel || {};

  // Questions : union ordonnée, filtrée par leur condition d'utilité.
  const vues = [];
  for (const op of ops) {
    for (const id of REGLES[op]?.questions || []) {
      const q = QUESTIONS[id];
      if (!q || (q.si && !q.si(t))) continue;
      let entree = vues.find((v) => v.id === id);
      if (!entree) {
        entree = {
          id, libelle: q.libelle, aide: q.aide || null, type: q.type,
          options: q.options || (id === 'entrants' ? (estCreation ? creation.rolesCreation(t) : FONCTIONS) : id === 'sortants' ? MOTIFS_DEPART : null),
          valeur: t[id] ?? null, pour: [],
        };
        if (id === 'entrants' && estCreation) {
          entree.libelle = 'Qui sont les dirigeants (et le commissaire aux comptes, s’il y en a un) ?';
          entree.aide = 'Une ligne par personne, avec sa fonction : les pièces à réunir en dépendent.';
          entree.creation = true;
          if (!creation.forme(t)) entree.attente = 'Choisissez d’abord la forme de la société.';
        }
        if (id === 'sortants') {
          entree.dirigeants_actuels = (fiche.dirigeants || []).map((d) => d.nom_complet).filter(Boolean);
        }
        vues.push(entree);
      }
      entree.pour.push(nomOperation(op));
    }
  }

  // Pièces : une entrée par clé (code, ou code + personne), qui cumule les
  // opérations qui la requièrent.
  const pieces = new Map();
  const ajouter = (cle, code, categorie, op, extra = {}) => {
    const desc = catalogue.fiche(op)
      ? [...catalogue.fiche(op).pieces_obligatoires, ...catalogue.fiche(op).pieces_selon_le_cas].find((p) => p.code === code)
      : null;
    const base = desc || catalogue.piecesCommunes().find((p) => p.code === code) || pieceSeule(code);
    const rang = { obligatoire: 0, a_preciser: 1, facultative: 2 };
    const existant = pieces.get(cle);
    if (existant) {
      if (!existant.pour.includes(nomOperation(op))) existant.pour.push(nomOperation(op));
      if (rang[categorie] < rang[existant.categorie]) Object.assign(existant, { categorie, ...extra });
      return;
    }
    pieces.set(cle, {
      cle, code, categorie,
      court: base.court, libelle: base.libelle, nota: base.nota || null,
      par_le_cabinet: base.par_le_cabinet,
      condition: null, question: null,
      pour: [nomOperation(op)],
      ...extra,
    });
  };

  for (const op of ops) {
    const f = catalogue.fiche(op);
    const regles = REGLES[op] || {};
    for (const p of f.pieces_obligatoires) {
      if (regles.personnes && PIECES_PAR_PERSONNE.has(p.code)) continue;
      ajouter(p.code, p.code, 'obligatoire', op);
    }
    for (const p of f.pieces_selon_le_cas) {
      if (regles.personnes && PIECES_PAR_PERSONNE.has(p.code)) continue;
      const regle = regles.pieces?.[p.code];
      if (regle) {
        const due = regle(t);
        if (due === true) ajouter(p.code, p.code, 'obligatoire', op, { raison: p.condition });
        else if (due === undefined) {
          ajouter(p.code, p.code, 'a_preciser', op, { condition: p.condition, question: questionDe(op, p.code) });
        }
      } else if (manuel[p.code] === true) {
        ajouter(p.code, p.code, 'obligatoire', op, { raison: p.condition, manuel: true });
      } else if (manuel[p.code] !== false) {
        ajouter(p.code, p.code, 'a_preciser', op, { condition: p.condition, manuel: true });
      }
    }
    // Pièces que la situation rend nécessaires sans que la fiche les porte
    // (origine du fonds à la création, par exemple).
    for (const [code, a] of Object.entries(regles.ajouts || {})) {
      const due = a.regle(t);
      if (due === true) ajouter(code, code, 'obligatoire', op, { raison: a.condition });
      else if (due === undefined) ajouter(code, code, 'a_preciser', op, { condition: a.condition, question: questionAjout(a) });
    }
    if (OPERATIONS[op]?.creation && creation.forme(t)?.unique && t.associe_unique_nature === 'PM') {
      ajouter('PJ_188', 'PJ_188', 'facultative', op, { raison: 'proposée par le guichet quand l’associé unique est une société' });
    }
    if (regles.personnes) {
      for (const [i, e] of (t.entrants || []).entries()) {
        if (!e || !e.nom) continue;
        if (op === '22M' && e.fonction !== 'liquidateur') continue;
        for (const code of piecesEntrant(e, forme)) {
          ajouter(`${code}:e${i}`, code, 'obligatoire', op, { personne: e.nom });
        }
        // Ressortissant d'un État hors Union européenne : titre de séjour,
        // s'il réside en France. Seul l'intéressé sait s'il y réside.
        if (e.nature !== 'PM' && e.hors_ue && creation.categorieFonction(e.fonction) !== 'cac') {
          const cle = `PJ_14:e${i}`;
          const condition = 'titre de séjour (carte de séjour ou de résident) si la personne réside en France';
          if (manuel[cle] === true) ajouter(cle, 'PJ_14', 'obligatoire', op, { personne: e.nom, raison: condition, manuel: true });
          else if (manuel[cle] !== false) ajouter(cle, 'PJ_14', 'a_preciser', op, { personne: e.nom, condition, manuel: true });
        }
      }
      for (const [i, s] of (t.sortants || []).entries()) {
        if (s?.nom && s.motif === 'demission') ajouter(`PJ_230:s${i}`, 'PJ_230', 'obligatoire', op, { personne: s.nom });
      }
      if (!(t.entrants || []).length && ['35M', '34M', '22M', '01M'].includes(op)) {
        const qui = op === '22M' ? 'le liquidateur' : 'les personnes nommées';
        ajouter(`personnes:${op}`, 'PJ_11', 'a_preciser', op, {
          court: 'Pièces d’identité et attestations des personnes nommées',
          condition: `selon ${qui} : pièce d’identité et déclaration de non-condamnation pour une personne physique, Kbis pour une personne morale`,
          question: 'entrants',
        });
      }
    }
    for (const code of FACULTATIVES) ajouter(code, code, 'facultative', op);
  }

  const liste = [...pieces.values()];
  return {
    operations: ops.map((code) => ({ code, nom: nomOperation(code), libelle_inpi: catalogue.fiche(code).libelle })),
    questions: vues,
    pieces: {
      obligatoires: liste.filter((p) => p.categorie === 'obligatoire'),
      a_preciser: liste.filter((p) => p.categorie === 'a_preciser'),
      facultatives: liste.filter((p) => p.categorie === 'facultative'),
    },
    champs: champs(ops, t, fiche, rep),
    incompatibilites: incompatibilites(ops),
  };
}

/** Code d'événement que le guichet renvoie pour une opération (54PMF → 54M, 34M → 35M sur une société de capitaux…). */
function evenementAttendu(code, forme = '') {
  if (code === '34M' && /^5[4-7]/.test(forme)) return '35M';
  return code.replace(/PMF?$|PM$/, 'M');
}

function nomOperation(code) {
  return OPERATIONS[code]?.nom || catalogue.fiche(code)?.libelle || code;
}

function questionAjout(a) {
  const m = String(a.regle).match(/t\.(\w+)/);
  return m ? m[1] : null;
}

/** La question dont dépend une pièce, pour l'afficher à côté d'elle. */
function questionDe(op, code) {
  const source = String(REGLES[op]?.pieces?.[code] || '');
  const m = source.match(/t\.(\w+)/);
  return m ? m[1] : null;
}

function pieceSeule(code) {
  const { piece } = require('./referentiels');
  const p = piece(code);
  return { court: p?.libelle || code, libelle: p?.libelle || code, par_le_cabinet: false };
}

/** Combinaisons qui ne tiennent pas dans un même dépôt. */
function incompatibilites(ops) {
  const out = [];
  const creations = ops.filter((c) => OPERATIONS[c]?.creation);
  const cessations = ops.filter((c) => OPERATIONS[c]?.cessation);
  const modifs = ops.filter((c) => !OPERATIONS[c]?.creation && !OPERATIONS[c]?.cessation);
  if (creations.length > 1) out.push('Une seule création par dossier.');
  if (creations.length && (modifs.length || cessations.length)) {
    out.push('Une création se dépose seule : les modifications viendront après l’immatriculation.');
  }
  if (cessations.length && modifs.length) {
    out.push('La dissolution ou la radiation se dépose séparément des modifications : elles feront l’objet de deux dépôts.');
  }
  if (cessations.length > 1) out.push('Une seule opération de dissolution ou de radiation par dépôt.');
  // Constaté sur le serveur de démonstration : déclarés ensemble, seul le
  // changement de clôture ou de durée est enregistré.
  if (ops.includes('16M') && ops.includes('17M')) {
    out.push('Le changement de clôture ou de durée et le passage à l’associé unique se déposent séparément : ensemble, le guichet n’enregistre que le premier.');
  }
  return out;
}

/* ------------------------------------------------------------------ champs */

/**
 * Les informations à saisir : uniquement celles qui changent. Chaque champ
 * porte la valeur actuelle du registre quand elle existe, pour comparaison.
 * Les clés reprennent celles des questionnaires existants, afin que le dépôt
 * réutilise les générateurs déjà éprouvés.
 */
function champs(ops, t, fiche, rep = {}) {
  const creations = ops.filter((c) => OPERATIONS[c]?.creation);
  if (creations.length) return creation.champsCreation(creations[0], t, rep);
  const groupes = [];
  const modifs = ops.filter((c) => !OPERATIONS[c]?.creation);
  if (modifs.length) {
    groupes.push({
      op: 'commun', titre: 'Pour toutes les opérations',
      champs: [{ name: 'date_decision', label: 'Date de la décision (PV ou décision de l’associé unique)', type: 'date', requis: true }],
    });
  }
  const adresse = fiche.adresse?.texte || '';
  const DEF = {
    '10M': [{ name: 'nouvelle_denomination', label: 'Nouvelle dénomination', type: 'text', requis: true, actuel: fiche.denomination },
      { name: 'nouveau_sigle', label: 'Nouveau sigle', type: 'text', actuel: fiche.sigle }],
    '11M': [{ name: 'nouvelle_adresse', label: 'Nouvelle adresse du siège', type: 'adresse', requis: true, actuel: adresse },
      { name: 'date_effet', label: 'Date d’effet, si différente de la décision', type: 'date' },
      { name: 'transfert_etablissement', label: 'L’établissement principal suit le siège', type: 'ouinon', defaut: true }],
    '12M': [{ name: 'nouvel_objet', label: 'Nouvel objet social', type: 'textarea', requis: true, actuel: fiche.objet },
      { name: 'nouvelle_activite', label: 'Nouvelle activité exercée, si elle change', type: 'textarea', actuel: fiche.activite_principale }],
    '13M': [{ name: 'nouvelle_forme', label: 'Nouvelle forme juridique', type: 'forme', requis: true, actuel: fiche.forme_juridique }],
    '14M': [{ name: 'nom_domaine', label: 'Nom de domaine du site', type: 'text', requis: true }],
    '15M': [{ name: 'nouveau_capital', label: 'Nouveau montant du capital (€)', type: 'money', requis: true, actuel: fiche.capital != null ? `${fiche.capital} €` : '' }],
    '16M': [{ name: 'nouvelle_cloture', label: 'Nouvelle date de clôture (JJ/MM), si elle change', type: 'text', actuel: formaterCloture(fiche.date_cloture) },
      { name: 'nouvelle_duree', label: 'Nouvelle durée (années), si elle change', type: 'number', actuel: fiche.duree ? `${fiche.duree} ans` : '' }],
    '17M': [{ name: 'associe_unique', label: 'La société a désormais un associé unique', type: 'ouinon', requis: true }],
    '20M': [{ name: 'date_debut_activite', label: 'Nouvelle date de début d’activité', type: 'date', requis: true, actuel: fiche.date_debut_activite }],
    '22M': [{ name: 'lieu_liquidation', label: 'Siège de la liquidation', type: 'choix', options: [['S', 'Au siège social'], ['L', 'À l’adresse du liquidateur'], ['A', 'À une autre adresse']], defaut: 'S' },
      { name: 'adresse_liquidation', label: 'Adresse de liquidation (si autre)', type: 'adresse' }],
    '42M': [{ name: 'date_cloture_liquidation', label: 'Date de clôture de la liquidation', type: 'date', requis: true }],
  };
  const complements = complementsRegistre(fiche, t._rejets || []);
  if (modifs.length && complements.length) {
    groupes.push({
      op: '_registre', titre: 'Données du registre à compléter',
      aide: 'Le guichet revalide toute la société à chaque dépôt : ces informations manquent au registre et bloqueraient la formalité.',
      champs: complements,
    });
  }
  for (const op of ops) {
    let liste = DEF[op] ? DEF[op].map((c) => ({ ...c })) : [];
    if (REGLES[op]?.personnes && op !== '01M') {
      for (const [i, e] of (t.entrants || []).entries()) {
        if (!e?.nom || (op === '22M' && e.fonction !== 'liquidateur')) continue;
        // Les mêmes exigences qu'à la création : le guichet revalide chaque pouvoir ajouté.
        liste.push(e.nature === 'PM'
          ? { name: `entrant_${i}`, label: `${e.nom} — ${libelleFonction(e.fonction)}`, type: 'personne_morale', requis: true, prerempli: { denomination: e.nom },
            sous_requis: ['denomination', 'greffe', 'adresse.codePostal', 'adresse.commune'] }
          : { name: `entrant_${i}`, label: `${e.nom} — ${libelleFonction(e.fonction)}`, type: 'personne', requis: true, prerempli: separerNom(e.nom),
            sous_requis: ['nom', 'prenoms', 'genre', 'date_naissance', 'lieu_naissance', 'adresse.codePostal', 'adresse.commune', 'forme_sociale'] });
      }
    }
    if (OPERATIONS[op]?.creation) {
      liste = [{ name: '_formulaire_creation', label: 'La création demande l’ensemble des informations de la société', type: 'renvoi', requis: false }];
    }
    if (!liste.length) continue;
    groupes.push({ op, titre: nomOperation(op), champs: liste });
  }
  return groupes;
}

/**
 * Ce que le registre ne fournit pas et que le guichet exige pour toute
 * modification (constaté par dépôt de test) : sexe et affiliation sociale
 * des dirigeants personnes physiques, greffe d'immatriculation des
 * personnes morales qui exercent un mandat.
 */
function complementsRegistre(fiche, rejets = []) {
  const pouvoirs = fiche?.brut?.formality?.content?.personneMorale?.composition?.pouvoirs || [];
  const out = [];
  // Adresses refusées lors d'un dépôt précédent : à corriger avant de redéposer.
  const adressesRefusees = new Set(rejets
    .map((r) => /composition\.pouvoirs\[(\d+)\]\.(adresseEntreprise|individu\.adresseDomicile)/.exec(r.champ || ''))
    .filter(Boolean).map((m) => Number(m[1])));
  pouvoirs.forEach((p, i) => {
    const d = p.individu?.descriptionPersonne;
    if (d) {
      const nom = `${(d.prenoms || []).join(' ')} ${d.nom || ''}`.trim() || `dirigeant n° ${i + 1}`;
      if (!d.genre) {
        out.push({ name: `genre_${i}`, label: `Sexe de ${nom}`, type: 'choix', options: [['1', 'Masculin'], ['2', 'Féminin']], requis: true });
      }
      if (!['0', '1', '3'].includes(String(d.formeSociale ?? ''))) {
        out.push({ name: `forme_sociale_${i}`, label: `Affiliation sociale de ${nom}`, type: 'choix', options: AFFILIATION, requis: true, defaut: '0' });
      }
    } else if (p.entreprise && !p.entreprise.lieuRegistre) {
      out.push({ name: `greffe_${i}`, label: `Greffe d’immatriculation de ${p.entreprise.denomination || `la personne morale n° ${i + 1}`}`, type: 'text', requis: true, aide: 'Ville du greffe, par exemple NANTERRE.' });
    }
    if (adressesRefusees.has(i)) {
      const nom = p.entreprise?.denomination || `${(d?.prenoms || []).join(' ')} ${d?.nom || ''}`.trim();
      const a = p.adresseEntreprise || p.individu?.adresseDomicile || {};
      out.push({ name: `adresse_${i}`, label: `Adresse de ${nom} (refusée par le guichet)`, type: 'adresse', requis: true,
        actuel: [a.numVoie, a.typeVoie, a.voie, a.codePostal, a.commune].filter(Boolean).join(' ') });
    }
  });
  return out;
}

const AFFILIATION = [['0', 'Non applicable'], ['1', 'Sans affiliation sociale'], ['3', 'Avec affiliation sociale']];

/** « Claire MARTIN » → nom MARTIN, prénoms Claire (le nom s'écrit en capitales). */
function separerNom(complet) {
  const mots = String(complet || '').trim().split(/\s+/);
  const nom = mots.filter((m) => m.length > 1 && m === m.toUpperCase() && /\p{L}/u.test(m));
  if (!nom.length || nom.length === mots.length) return { nom: complet };
  return { nom: nom.join(' '), prenoms: mots.filter((m) => !nom.includes(m)).join(' ') };
}

function libelleFonction(code) {
  return (FONCTIONS.find(([c]) => c === code) || [null, 'fonction à préciser'])[1].replace(/ \(.+\)$/, '');
}

function formaterCloture(jjmm) {
  return /^\d{4}$/.test(jjmm || '') ? `${jjmm.slice(0, 2)}/${jjmm.slice(2)}` : '';
}

/** Les opérations proposées au choix, rangées comme le mémo. */
function operationsProposees() {
  return Object.entries(OPERATIONS).map(([code, o]) => ({
    code, nom: o.nom, creation: Boolean(o.creation), cessation: Boolean(o.cessation),
    depot_automatique: require('./payload-parcours').deposable(code),
  }));
}

module.exports = { OPERATIONS, QUESTIONS, REGLES, resoudre, operationsProposees, nomOperation, piecesEntrant, evenementAttendu };
