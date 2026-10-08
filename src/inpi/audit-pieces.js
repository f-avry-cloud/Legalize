'use strict';

/**
 * Couverture des pièces justificatives du guichet unique.
 *
 * Le dictionnaire du guichet (GET /api/data_dictionary) range chaque pièce
 * par bloc du formulaire et par type de personne, mais ne la rattache à
 * aucun événement. Pour garantir que le parcours n'en oublie aucune, chaque
 * pièce proposée aux mandataires pour une personne morale reçoit ici une
 * décision explicite :
 *   - utilisée : une opération du parcours la demande (fiche du catalogue,
 *     règle de situation, pièce par personne) ;
 *   - variante : document accepté à la place d'une pièce demandée (le
 *     passeport pour la carte d'identité…), choisi au chargement ;
 *   - complément : pièce proposée en plus, selon la situation ;
 *   - exclue : hors du champ du parcours, avec le motif.
 * Le test de cohérence échoue dès qu'une pièce reste sans décision.
 */

const GUICHET = require('./data/pieces-guichet.json').valeurs;

/** Documents acceptés à la place d'une pièce demandée. */
const VARIANTES = {
  PJ_11: ['PJ_12', 'PJ_213'],
  PJ_17: ['PJ_63', 'PJ_64'],
  PJ_14: ['PJ_15', 'PJ_13'],
  PJ_20: ['PJ_22', 'PJ_23'],
  PJ_80: ['PJ_24'],
  PJ_03: ['PJ_93'],
  PJ_06: ['PJ_92', 'PJ_180'],
  PJ_180: ['PJ_56', 'PJ_92'],
  PJ_08: ['PJ_09'],
  PJ_54: ['PJ_52', 'PJ_152'],
  PJ_160: ['PJ_91'],
  PJ_133: ['PJ_134'],
  PJ_82: ['PJ_59'],
  PJ_38: ['PJ_90'],
  PJ_31: ['PJ_74'],
  PJ_25: ['PJ_244'],
};

/** Pièces proposées en plus, selon la situation (voir parcours.js). */
const COMPLEMENTS = {
  PJ_138: 'liste des souscripteurs, annexée au certificat du dépositaire des fonds',
  PJ_195: 'décision de ne pas recourir à un commissaire aux apports',
};

const EPIC = 'établissement public : hors du champ des sociétés traitées par le parcours';
const ETRANGERE = 'société étrangère : hors du champ du parcours';
const EI = 'entrepreneur individuel ou conjoint de l’exploitant : ne concerne pas une société';
const PROCEDURE = 'procédure judiciaire ou décision du juge commis : dossier à traiter au cas par cas';
const SANS_LIBELLE = 'pièce sans libellé dans le dictionnaire du guichet';
const RADIATION = 'réservée par le guichet aux rapports de radiation d’office';

/** Pièces écartées du parcours, et pourquoi. */
const EXCLUSIONS = {
  PJ_07: 'assemblée constitutive : SA constituée par offre au public, hors parcours',
  PJ_10: 'actes constitutifs déposés avant l’immatriculation : cas rare, à joindre à la main',
  PJ_19: 'ancienne déclaration préalable de l’étranger non résident : régime supprimé',
  PJ_34: 'fonds acquis par donation : cas rare pour une société, à joindre à la main',
  PJ_35: 'fonds recueilli par succession : cas rare pour une société, à joindre à la main',
  PJ_39: PROCEDURE,
  PJ_42: EI, PJ_62: EI, PJ_81: EI, PJ_94: EI, PJ_136: EI, PJ_137: EI, PJ_67: EI, PJ_98: EI,
  PJ_61: 'contrat d’appui au projet d’entreprise : concerne le créateur accompagné, non la société',
  PJ_46: EPIC, PJ_47: EPIC, PJ_48: EPIC, PJ_238: EPIC,
  PJ_73: 'pouvoir d’un héritier : succession d’un entrepreneur individuel',
  PJ_75: 'société européenne : hors parcours', PJ_76: 'société européenne : hors parcours', PJ_77: 'société européenne : hors parcours',
  PJ_79: 'groupement d’intérêt économique : hors parcours',
  PJ_239: 'GAEC : hors parcours',
  PJ_132: ETRANGERE, PJ_141: ETRANGERE, PJ_142: ETRANGERE, PJ_143: ETRANGERE, PJ_182: ETRANGERE,
  PJ_184: ETRANGERE, PJ_185: ETRANGERE, PJ_186: ETRANGERE, PJ_187: ETRANGERE, PJ_225: ETRANGERE,
  PJ_226: 'dirigeant mineur : cas exceptionnel, à joindre à la main', PJ_237: 'dirigeant mineur : cas exceptionnel, à joindre à la main',
  PJ_144: 'comptes combinés : dépôt des comptes, hors parcours',
  PJ_198: 'refus d’approbation des comptes : dépôt des comptes, hors parcours',
  PJ_196: 'projet de fusion ou de scission : dépôt de projet, hors parcours',
  PJ_197: 'projet de fusion ou de scission : dépôt de projet, hors parcours',
  PJ_204: 'rapport du liquidateur : dépôt d’acte isolé, hors parcours',
  PJ_183: PROCEDURE, PJ_242: PROCEDURE, PJ_243: PROCEDURE,
  PJ_245: 'réservée aux formalités de correction',
  PJ_249: RADIATION, PJ_250: RADIATION, PJ_251: RADIATION, PJ_252: RADIATION,
  PJ_95: SANS_LIBELLE, PJ_96: SANS_LIBELLE, PJ_205: SANS_LIBELLE, PJ_228: SANS_LIBELLE, PJ_229: SANS_LIBELLE, PJ_248: SANS_LIBELLE,
};

/** Pièces du guichet proposées aux mandataires pour une personne morale. */
function piecesPersonneMorale() {
  return Object.entries(GUICHET)
    .filter(([, v]) => v.types.includes('PM') && v.propose_mandataire)
    .map(([code, v]) => ({ code, ...v }));
}

/**
 * Où chaque pièce intervient dans le parcours.
 * @returns {Map<string, string[]>} code → opérations (ou « parcours » pour les règles transverses)
 */
function piecesUtilisees() {
  const catalogue = require('./catalogue-evenements');
  const parcours = require('./parcours');
  const creation = require('./parcours-creation');
  const util = new Map();
  const noter = (code, op) => { if (!util.has(code)) util.set(code, []); if (!util.get(code).includes(op)) util.get(code).push(op); };
  for (const op of Object.keys(parcours.OPERATIONS)) {
    const f = catalogue.fiche(op);
    if (!f) continue;
    for (const p of [...f.pieces_obligatoires, ...f.pieces_selon_le_cas]) noter(p.code, op);
    for (const code of Object.keys(parcours.REGLES[op]?.ajouts || {})) noter(code, op);
  }
  for (const code of Object.keys(creation.AJOUTS)) noter(code, '01M');
  // Pièces par personne et propositions transverses du moteur.
  for (const code of ['PJ_11', 'PJ_14', 'PJ_17', 'PJ_20', 'PJ_40', 'PJ_41', 'PJ_80', 'PJ_230', 'PJ_51', 'PJ_188']) noter(code, 'parcours');
  return util;
}

/** La décision prise pour chaque pièce, prête à afficher et à tester. */
function couverture() {
  const util = piecesUtilisees();
  const varianteDe = new Map();
  for (const [base, alts] of Object.entries(VARIANTES)) for (const a of alts) varianteDe.set(a, base);
  const { piece } = require('./referentiels');
  return piecesPersonneMorale().map((p) => {
    const libelle = piece(p.code)?.libelle || null;
    if (util.has(p.code)) return { code: p.code, libelle, bloc: p.bloc, decision: 'utilisee', operations: util.get(p.code) };
    if (varianteDe.has(p.code)) return { code: p.code, libelle, bloc: p.bloc, decision: 'variante', de: varianteDe.get(p.code) };
    if (COMPLEMENTS[p.code]) return { code: p.code, libelle, bloc: p.bloc, decision: 'complement', motif: COMPLEMENTS[p.code] };
    if (EXCLUSIONS[p.code]) return { code: p.code, libelle, bloc: p.bloc, decision: 'exclue', motif: EXCLUSIONS[p.code] };
    return { code: p.code, libelle, bloc: p.bloc, decision: 'non_decidee' };
  });
}

/** Variantes d'une pièce, avec leur libellé, pour le choix au chargement. */
function variantes(code) {
  const { decrirePiece } = require('./catalogue-evenements');
  return (VARIANTES[code] || []).map((c) => { const d = decrirePiece(c); return { code: c, court: d.court, libelle: d.libelle }; });
}

module.exports = { VARIANTES, COMPLEMENTS, EXCLUSIONS, couverture, variantes, piecesPersonneMorale, piecesUtilisees };
