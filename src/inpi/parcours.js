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
const audit = require('./audit-pieces');

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
  MAJDIR: { nom: 'Mettre à jour un dirigeant déjà en place (nouvelle dénomination, nouvelle adresse…)', type: null },
  '38F': { nom: 'Déclarer ou modifier les bénéficiaires effectifs', type: null },
  '54PMF': { nom: 'Ouvrir un établissement', type: null },
  '56PMF': { nom: 'Transférer un établissement', type: null },
  '61PMF': { nom: 'Ajouter une activité', type: null },
  '80PMF': { nom: 'Fermer un établissement', type: null },
  '84M': { nom: 'Mettre le fonds en location-gérance', type: null },
  '22M': { nom: 'Dissoudre la société (liquidation amiable)', type: 'cessation', cessation: true },
  '28M': { nom: 'Dissolution sans liquidation par l’associé unique (TUP)', type: null, cessation: true },
  '40M': { nom: 'Mettre la société en sommeil (cessation totale d’activité)', type: null, cessation: true },
  '18M': { nom: 'Qualité d’entreprise de l’économie sociale et solidaire (ESS)', type: null },
  '19M': { nom: 'Changer la nature de la gérance (SARL)', type: null },
  '29M': { nom: 'Acquérir ou perdre la qualité de société à mission', type: null },
  '51M': { nom: 'Débuter l’activité au siège (société sans activité)', type: null },
  '55PM': { nom: 'Déclarer le site internet d’un établissement', type: null },
  '60PMF': { nom: 'Modifier l’enseigne ou le nom commercial d’un établissement', type: null },
  '62M': { nom: 'Supprimer une partie de l’activité', type: null },
  '63M': { nom: 'Racheter le fonds pris en location-gérance', type: null },
  '67PMF': { nom: 'Modifier la description d’une activité', type: null },
  '41M': { nom: 'Fusion : radier la société absorbée', type: null, cessation: true },
  '42M': { nom: 'Radier après la clôture de la liquidation', type: 'cessation', cessation: true },
};

/**
 * Toute formalité de société du catalogue peut être choisie. Celles qui n'ont
 * pas de règles dédiées reprennent les pièces de leur fiche (à préciser) et
 * se finalisent sur le portail ; les entreprises individuelles, les
 * exploitations agricoles et les événements émis par le registre sont exclus.
 */
/**
 * Opérations du parcours sans événement propre au référentiel : elles se
 * déposent sous un événement existant (la mise à jour d'un dirigeant en 35M,
 * constaté par dépôt de test) et ont leur propre liste de pièces.
 */
const FICHES_PROPRES = {
  MAJDIR: () => ({
    code: 'MAJDIR', libelle: 'Modification relative à un dirigeant déjà inscrit', famille: 'dirigeants',
    quand: 'Un dirigeant en place change de dénomination ou de nom, d’adresse ou de représentant permanent.',
    informations: [], pieces_obligatoires: [],
    pieces_selon_le_cas: [catalogue.decrirePiece('PJ_02', 'si les statuts désignent le dirigeant sous son ancien nom')],
  }),
};

/** Fiche d'une opération : celle du catalogue, ou la fiche propre au parcours. */
function ficheOp(code) {
  return FICHES_PROPRES[code] ? FICHES_PROPRES[code]() : catalogue.fiche(code);
}

function infoOperation(code) {
  if (OPERATIONS[code]) return OPERATIONS[code];
  const f = catalogue.fiche(code);
  if (!f || f.famille === 'hors_champ' || /P$/.test(code) || f.emise_par_le_registre) return null;
  return { nom: f.libelle, generique: true, creation: f.famille === 'creation', cessation: f.famille === 'dissolution' };
}

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
  mises_a_jour: {
    libelle: 'Quel dirigeant déjà en place change, et sur quoi ?',
    aide: 'Une ligne par dirigeant : choisissez-le dans la liste du registre, puis indiquez ce qui change.',
    type: 'maj',
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
    pieces: Object.fromEntries(Object.entries(PIECES_CREATION).filter(([c]) => !['PJ_05', 'PJ_31'].includes(c))),
    // L'évaluation des apports en nature vaut aussi sans activité ; la fiche ne la porte pas.
    ajouts: { PJ_05: { condition: 'en cas d’apports en nature', regle: PIECES_CREATION.PJ_05 } },
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
      // Cas rare (société par actions, apport en nature sans commissaire,
      // évaluation antérieure) : seul le cabinet sait s'il s'applique.
      PJ_191: (t) => (t.capital_modalite === 'nature' && t.commissaire_apports === false ? 'manuel' : false),
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
  MAJDIR: {
    questions: ['mises_a_jour', 'statuts_modifies'],
    pieces: { PJ_02: (t) => def(t.statuts_modifies, () => t.statuts_modifies === true) },
    misesAJour: true,
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
const FACULTATIVES = [];

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
  const ops = operations.filter((c) => ficheOp(c));
  const estCreation = ops.some((c) => infoOperation(c)?.creation);
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
          options: q.options || (id === 'entrants' ? (estCreation ? creation.rolesCreation(t) : FONCTIONS) : id === 'sortants' ? MOTIFS_DEPART : id === 'mises_a_jour' ? CHANGEMENTS : null),
          valeur: t[id] ?? null, pour: [],
        };
        if (id === 'entrants' && estCreation) {
          entree.libelle = 'Qui sont les dirigeants (et le commissaire aux comptes, s’il y en a un) ?';
          entree.aide = 'Une ligne par personne, avec sa fonction : les pièces à réunir en dépendent.';
          entree.creation = true;
          if (!creation.forme(t)) entree.attente = 'Choisissez d’abord la forme de la société.';
        }
        if (id === 'sortants' || id === 'mises_a_jour') {
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
    const desc = ficheOp(op)
      ? [...ficheOp(op).pieces_obligatoires, ...ficheOp(op).pieces_selon_le_cas].find((p) => p.code === code)
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
      // Documents que le guichet accepte à la place (passeport pour la carte d'identité…).
      variantes: audit.variantes(code),
      par_le_cabinet: base.par_le_cabinet,
      condition: null, question: null,
      pour: [nomOperation(op)],
      ...extra,
    });
  };

  for (const op of ops) {
    const f = ficheOp(op);
    const regles = REGLES[op] || {};
    for (const p of f.pieces_obligatoires) {
      if (regles.personnes && PIECES_PAR_PERSONNE.has(p.code)) continue;
      ajouter(p.code, p.code, 'obligatoire', op);
    }
    for (const p of f.pieces_selon_le_cas) {
      if (regles.personnes && PIECES_PAR_PERSONNE.has(p.code)) continue;
      const regle = regles.pieces?.[p.code];
      const due = regle ? regle(t) : 'manuel';
      if (due !== 'manuel') {
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
    // Mise à jour d'un dirigeant en place : la pièce qui établit le changement.
    if (regles.misesAJour) {
      for (const [i, m] of (t.mises_a_jour || []).entries()) {
        if (!m?.nom) continue;
        const pm = estPersonneMorale(fiche, m.nom);
        if (m.motif === 'representant') ajouter(`PJ_80:m${i}`, 'PJ_80', 'obligatoire', op, { personne: m.nom, raison: 'désignation du nouveau représentant permanent' });
        else if (pm) ajouter(`PJ_20:m${i}`, 'PJ_20', 'obligatoire', op, { personne: m.nom, raison: 'Kbis à jour, sous la nouvelle dénomination ou à la nouvelle adresse' });
        else if (m.motif === 'denomination') ajouter(`PJ_11:m${i}`, 'PJ_11', 'obligatoire', op, { personne: m.nom, raison: 'pièce d’identité sous le nouveau nom' });
      }
      if (!(t.mises_a_jour || []).length) {
        ajouter(`maj:${op}`, 'PJ_20', 'a_preciser', op, { court: 'Justificatif du changement', condition: 'Kbis à jour pour une société, pièce d’identité pour une personne', question: 'mises_a_jour' });
      }
    }
    // Compléments proposés par le guichet selon la situation.
    if (infoOperation(op)?.creation && t.apports_numeraire === true) {
      ajouter('PJ_138', 'PJ_138', 'facultative', op, { raison: audit.COMPLEMENTS.PJ_138 });
    }
    const natureSansCommissaire = (infoOperation(op)?.creation && t.apports_nature === true)
      || (op === '15M' && t.capital_modalite === 'nature');
    if (natureSansCommissaire && t.commissaire_apports === false) {
      ajouter('PJ_195', 'PJ_195', 'facultative', op, { raison: audit.COMPLEMENTS.PJ_195 });
    }
    if (infoOperation(op)?.creation && creation.forme(t)?.unique && t.associe_unique_nature === 'PM') {
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

  // Le cabinet dépose toujours comme mandataire (« mandataire ayant
  // procuration ») : le pouvoir signé par le représentant légal est dû.
  if (ops.length) {
    ajouter('PJ_51', 'PJ_51', 'obligatoire', ops[0], { raison: 'le cabinet dépose en qualité de mandataire : pouvoir signé par le représentant légal', redigeable: true });
    pieces.get('PJ_51').pour = ops.map(nomOperation);
  }
  const liste = [...pieces.values()];
  return {
    operations: ops.map((code) => ({ code, nom: nomOperation(code), libelle_inpi: ficheOp(code).libelle })),
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
  if (code === 'MAJDIR') return /^5[4-7]/.test(forme) ? '35M' : '34M';
  // Constaté : la disparition de la société absorbée est enregistrée en 42M.
  if (code === '41M') return '42M';
  return code.replace(/PMF?$|PM$/, 'M');
}

function nomOperation(code) {
  return infoOperation(code)?.nom || ficheOp(code)?.libelle || code;
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
  return catalogue.decrirePiece(code);
}

/** Combinaisons qui ne tiennent pas dans un même dépôt. */
function incompatibilites(ops) {
  const out = [];
  const creations = ops.filter((c) => infoOperation(c)?.creation);
  const cessations = ops.filter((c) => infoOperation(c)?.cessation);
  const modifs = ops.filter((c) => !infoOperation(c)?.creation && !infoOperation(c)?.cessation);
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
  const modifs = ops.filter((c) => !infoOperation(c)?.creation);
  if (modifs.length) {
    groupes.push({
      op: 'commun', titre: 'Pour toutes les opérations',
      champs: [{ name: 'date_decision', type: 'date', requis: true,
        // Une mise à jour (nouvelle dénomination d'un dirigeant…) ne suit pas une décision de la société.
        label: modifs.every((c) => c === 'MAJDIR') ? 'Date d’effet du changement (par exemple, date de la nouvelle dénomination)'
          : 'Date de la décision (PV ou décision de l’associé unique)' }],
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
    '18M': [{ name: 'ess', label: 'La société a la qualité d’entreprise de l’ESS', type: 'ouinon', requis: true }],
    '19M': [{ name: 'nature_gerance', label: 'Nouvelle nature de la gérance', type: 'choix', requis: true, options: NATURES_GERANCE }],
    '29M': [{ name: 'societe_mission', label: 'La société a la qualité de société à mission', type: 'ouinon', requis: true }],
    '51M': [{ name: 'date_debut', label: 'Date de début de l’activité au siège', type: 'date', requis: true }],
    '38F': [{ name: 'beneficiaires', label: 'Liste complète des bénéficiaires effectifs après la modification', type: 'beneficiaires', requis: true,
      sous_requis: ['nom', 'prenoms', 'genre', 'date_naissance', 'lieu_naissance', 'adresse.codePostal', 'adresse.commune', 'modalites'],
      aide: 'La déclaration remplace la précédente : indiquez tous les bénéficiaires, y compris ceux qui ne changent pas.',
      actuel: (fiche.beneficiaires_effectifs || []).map((b) => b.nom_complet).filter(Boolean).join(', ') }],
    '54PMF': [{ name: 'adresse', label: 'Adresse du nouvel établissement', type: 'adresse', requis: true },
      { name: 'activite', label: 'Activité exercée dans cet établissement', type: 'textarea', requis: true },
      { name: 'categorie', label: 'Catégorie d’activité (nomenclature du guichet)', type: 'categorie', requis: true },
      { name: 'date_ouverture', label: 'Date d’ouverture', type: 'date', requis: true },
      { name: 'salaries', label: 'L’établissement emploie des salariés', type: 'ouinon', defaut: false }],
    '55PM': [{ name: 'etablissement', label: 'Établissement concerné', type: 'choix', requis: true, options: optionsEtablissements(fiche) },
      { name: 'nom_domaine', label: 'Adresse du site internet', type: 'text', requis: true }],
    '60PMF': [{ name: 'etablissement', label: 'Établissement concerné', type: 'choix', requis: true, options: optionsEtablissements(fiche) },
      { name: 'enseigne', label: 'Nouvelle enseigne', type: 'text', requis: true }],
    '61PMF': [{ name: 'activite', label: 'Activité ajoutée (au siège / établissement principal)', type: 'textarea', requis: true },
      { name: 'categorie', label: 'Catégorie d’activité (nomenclature du guichet)', type: 'categorie', requis: true },
      { name: 'date_debut', label: 'Date de début de cette activité', type: 'date', requis: true }],
    '62M': [{ name: 'activite', label: 'Activité qui cesse', type: 'choix', requis: true, options: optionsActivites(fiche) },
      { name: 'date_fin', label: 'Date de fin de cette activité', type: 'date', requis: true }],
    '63M': [{ name: 'date_rachat', label: 'Date du rachat du fonds', type: 'date', requis: true }],
    '67PMF': [{ name: 'activite', label: 'Activité modifiée', type: 'choix', requis: true, options: optionsActivites(fiche) },
      { name: 'description', label: 'Nouvelle description de l’activité', type: 'textarea', requis: true }],
    '84M': [{ name: 'mode', label: 'Mode d’exploitation', type: 'choix', requis: true, defaut: 'D', options: [['D', 'Location-gérance de la totalité du fonds'], ['K', 'Gérance-mandat']] },
      { name: 'locataire', label: 'Locataire-gérant ou gérant-mandataire', type: 'personne_morale', requis: true,
        sous_requis: ['denomination', 'siren', 'greffe'] },
      { name: 'date_effet', label: 'Date de début du contrat', type: 'date', requis: true }],
    '28M': [{ name: 'date_dissolution', label: 'Date de la décision de dissolution', type: 'date', requis: true },
      { name: 'associe_unique', label: 'Associé unique qui recueille le patrimoine', type: 'personne_morale', requis: true,
        sous_requis: ['denomination', 'siren', 'forme_juridique_code', 'greffe', 'adresse.codePostal', 'adresse.commune'] }],
    '80PMF': [{ name: 'etablissement', label: 'Établissement fermé', type: 'choix', requis: true, options: optionsEtablissements(fiche) },
      { name: 'date_fermeture', label: 'Date de fermeture', type: 'date', requis: true },
      { name: 'destination', label: 'Devenir de l’établissement', type: 'choix', requis: true, defaut: 'B',
        options: [['B', 'Fermé'], ['3', 'Vendu'], ['C', 'Supprimé'], ['5', 'Repris par le propriétaire']] }],
    '41M': [{ name: 'date_fusion', label: 'Date de réalisation de la fusion', type: 'date', requis: true },
      { name: 'absorbante', label: 'Société absorbante', type: 'personne_morale', requis: true,
        sous_requis: ['denomination', 'siren', 'forme_juridique_code', 'adresse.codePostal', 'adresse.commune'] }],
    '40M': [{ name: 'date_cessation', label: 'Date de cessation totale d’activité', type: 'date', requis: true }],
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
    if (REGLES[op]?.misesAJour) {
      for (const [i, m] of (t.mises_a_jour || []).entries()) {
        if (!m?.nom) continue;
        const actuel = pouvoirActuel(fiche, m.nom);
        const libelle = `${m.nom} — ${(CHANGEMENTS.find(([c]) => c === m.motif) || [null, 'changement'])[1].toLowerCase()}`;
        liste.push(actuel?.entreprise
          ? { name: `maj_${i}`, label: libelle, type: 'personne_morale', requis: true, representant_requis: m.motif === 'representant',
            aide: 'Les données actuelles du registre sont reprises : corrigez ce qui change.', sous_requis: ['denomination', 'adresse.codePostal', 'adresse.commune'],
            prerempli: {
              denomination: actuel.entreprise.denomination, siren: actuel.entreprise.siren, forme_juridique_code: actuel.entreprise.formeJuridique,
              greffe: actuel.entreprise.lieuRegistre, adresse: adresseFiche(actuel.adresseEntreprise),
            } }
          : { name: `maj_${i}`, label: libelle, type: 'personne', requis: true, aide: 'Les données actuelles du registre sont reprises : corrigez ce qui change.',
            sous_requis: ['nom', 'adresse.codePostal', 'adresse.commune'],
            prerempli: {
              nom: actuel?.individu?.descriptionPersonne?.nom, prenoms: (actuel?.individu?.descriptionPersonne?.prenoms || []).join(' '),
              adresse: adresseFiche(actuel?.individu?.adresseDomicile),
            } });
      }
    }
    if (REGLES[op]?.personnes && op !== '01M') {
      for (const [i, e] of (t.entrants || []).entries()) {
        if (!e?.nom || (op === '22M' && e.fonction !== 'liquidateur')) continue;
        // Les mêmes exigences qu'à la création : le guichet revalide chaque pouvoir ajouté.
        liste.push(e.nature === 'PM'
          ? { name: `entrant_${i}`, label: `${e.nom} — ${libelleFonction(e.fonction)}`, type: 'personne_morale', requis: true, prerempli: { denomination: e.nom },
            sous_requis: ['denomination', 'forme_juridique_code', 'greffe', 'adresse.codePostal', 'adresse.commune'] }
          : { name: `entrant_${i}`, label: `${e.nom} — ${libelleFonction(e.fonction)}`, type: 'personne', requis: true, prerempli: separerNom(e.nom),
            sous_requis: ['nom', 'prenoms', 'genre', 'date_naissance', 'lieu_naissance', 'adresse.codePostal', 'adresse.commune', 'forme_sociale'] });
      }
    }
    if (infoOperation(op)?.creation) {
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

const NATURES_GERANCE = [['1', 'Gérance majoritaire'], ['3', 'Minoritaire ou égalitaire, avec société associée'], ['4', 'Minoritaire ou égalitaire, sans société associée'],
  ['5', 'Gérance non associée, avec société associée'], ['6', 'Gérance non associée, sans société associée']];

/** Établissements secondaires ouverts, d'après la fiche du registre (rang dans la fiche). */
function optionsEtablissements(fiche) {
  const autres = fiche?.brut?.formality?.content?.personneMorale?.autresEtablissements || [];
  return autres.map((e, i) => [String(i), e]).filter(([, e]) => !/^1[1-6]$/.test(String(e.descriptionEtablissement?.rolePourEntreprise || '')))
    .map(([i, e]) => [i, [e.descriptionEtablissement?.enseigne, e.adresse?.numVoie, e.adresse?.typeVoie, e.adresse?.voie, e.adresse?.codePostal, e.adresse?.commune,
      e.descriptionEtablissement?.siret ? `(SIRET ${e.descriptionEtablissement.siret})` : ''].filter(Boolean).join(' ')]);
}

/** Activités de l'établissement principal. */
function optionsActivites(fiche) {
  const acts = fiche?.brut?.formality?.content?.personneMorale?.etablissementPrincipal?.activites || [];
  return acts.map((a, i) => [String(i), `${String(a.descriptionDetaillee || a.codeApe || `activité n° ${i + 1}`).slice(0, 120)}${a.dateDebut ? ` (depuis ${a.dateDebut})` : ''}`]);
}

const CHANGEMENTS = [['denomination', 'Nouvelle dénomination (ou nouveau nom)'], ['adresse', 'Nouvelle adresse'], ['representant', 'Nouveau représentant permanent']];

/** Le pouvoir du registre qui correspond au nom choisi (dénomination ou prénom et nom). */
function pouvoirActuel(fiche, nom) {
  const cle = String(nom || '').trim().toLowerCase();
  const pouvoirs = fiche?.brut?.formality?.content?.personneMorale?.composition?.pouvoirs || [];
  const nomDe = (p) => (p.entreprise ? p.entreprise.denomination
    : `${(p.individu?.descriptionPersonne?.prenoms || []).join(' ')} ${p.individu?.descriptionPersonne?.nom || ''}`);
  return pouvoirs.find((p) => String(nomDe(p)).trim().toLowerCase() === cle)
    || pouvoirs.find((p) => String(nomDe(p)).toLowerCase().includes(cle.split(' ').pop()));
}

function estPersonneMorale(fiche, nom) { return Boolean(pouvoirActuel(fiche, nom)?.entreprise); }

function adresseFiche(a) {
  if (!a) return {};
  return { numVoie: a.numVoie, typeVoie: a.typeVoie, voie: a.voie, complementLocalisation: a.complementLocalisation, codePostal: a.codePostal, commune: a.commune, codeInseeCommune: a.codeInseeCommune };
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
  const { deposable } = require('./payload-parcours');
  const codes = [...Object.keys(OPERATIONS), ...catalogue.catalogueComplet().map((f) => f.code).filter((c) => !OPERATIONS[c])];
  return codes.map((code) => {
    const o = infoOperation(code);
    if (!o) return null;
    const f = ficheOp(code);
    return {
      code, nom: o.nom, libelle_inpi: f?.libelle || null,
      groupe: catalogue.FAMILLES[f?.famille]?.libelle || 'Autres formalités', ordre: catalogue.FAMILLES[f?.famille]?.ordre || 9,
      creation: Boolean(o.creation), cessation: Boolean(o.cessation),
      // Courante : règles de pièces et informations ciblées ; sinon pièces de la fiche seulement.
      guidee: !o.generique,
      depot_automatique: deposable(code),
    };
  }).filter(Boolean);
}

module.exports = { OPERATIONS, QUESTIONS, REGLES, infoOperation, pouvoirActuel, ficheOp, resoudre, operationsProposees, nomOperation, piecesEntrant, evenementAttendu };
