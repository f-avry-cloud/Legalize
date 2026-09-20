'use strict';

/**
 * Référentiels du Guichet unique.
 *
 * Les tables ne sont plus saisies à la main : elles sont générées depuis les
 * fichiers officiels de l'INPI (dictionnaire de données mandataire et liste
 * des formes juridiques) par `scripts/build-referentiels-inpi.py`, et lues
 * ici telles quelles. Régénérer les JSON suffit à suivre une mise à jour du
 * contrat d'interface.
 *
 * Ce module n'expose que les accesseurs et les quelques correspondances
 * métier (fonction de dirigeant → code rôle, forme sociale → code) que le
 * dictionnaire ne fournit pas.
 */

const FORMES = require('./data/formes-juridiques.json').valeurs;
const ROLES = require('./data/roles.json').valeurs;
const PIECES = require('./data/pieces-justificatives.json').valeurs;
const EVENEMENTS = require('./data/evenements.json').valeurs;
const ENUMS = require('./data/enumerations.json').valeurs;

/* ------------------------------------------------------ formes juridiques */

/** @returns {{libelle, famille, categorie, codeInsee, unipersonnelle}|null} */
function formeJuridique(code) {
  const f = FORMES[String(code || '').trim()];
  return f ? { code: String(code), ...f } : null;
}

/** Formes proposables à la création (sous-ensemble utile du formulaire). */
function formesCreation() {
  return Object.entries(FORMES)
    .filter(([, f]) => f.creation)
    .map(([code, f]) => ({ code, libelle: f.libelle, categorie: f.categorie }))
    .sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'));
}

/** Retrouve un code à partir d'une forme sociale saisie en clair (« SAS »). */
function codeFormeDepuisLibelle(libelle) {
  if (!libelle) return null;
  const n = String(libelle).toUpperCase().replace(/[^A-Z]/g, '');
  if (!n) return null;
  // Sigles usuels : le dictionnaire INPI ne distingue pas SAS et SASU
  // (même code 5710, l'unipersonnalité est portée par un indicateur).
  const sigles = [
    ['SASU', '5710'], ['SELAS', '5785'], ['SAS', '5710'],
    ['EURL', '5499'], ['SARL', '5499'],
    ['SCA', '5308'], ['SCS', '5306'], ['SELARL', '5485'],
    ['SADIRECTOIRE', '5699'], ['SA', '5599'],
    ['SCI', '6540'], ['SNC', '5202'], ['GIE', '6220'],
  ];
  for (const [motif, code] of sigles) if (n.includes(motif) && FORMES[code]) return code;
  const exact = Object.entries(FORMES)
    .find(([, f]) => f.libelle.toUpperCase().replace(/[^A-Z]/g, '') === n);
  return exact ? exact[0] : null;
}

/* ------------------------------------------------------------------ rôles */

const ROLES_PAR_LIBELLE = new Map(
  Object.entries(ROLES).map(([code, libelle]) => [libelle.toLowerCase(), code]),
);

function role(code) {
  const libelle = ROLES[String(code || '').trim()];
  return libelle ? { code: String(code), libelle } : null;
}

/**
 * Fonction saisie en clair → code rôle du RNE.
 * L'ordre compte : « président du conseil d'administration » doit être testé
 * avant « président ».
 */
const CORRESPONDANCES_ROLE = [
  [/liquidateur/i, '40'],
  [/commissaire aux comptes suppl/i, '72'],
  [/commissaire aux comptes/i, '71'],
  [/pr[ée]sident du conseil d.?administration et directeur g[ée]n[ée]ral/i, '60'],
  [/pr[ée]sident du conseil d.?administration/i, '51'],
  [/pr[ée]sident du conseil de surveillance/i, '61'],
  [/pr[ée]sident du directoire/i, '52'],
  [/membre du directoire/i, '63'],
  [/membre du conseil de surveillance/i, '64'],
  [/directeur g[ée]n[ée]ral d[ée]l[ée]gu/i, '70'],
  [/directeur g[ée]n[ée]ral unique/i, '69'],
  [/directeur g[ée]n[ée]ral/i, '53'],
  [/administrateur provisoire/i, '98'],
  [/administrateur/i, '65'],
  [/g[ée]rant/i, '30'],
  [/pr[ée]sident/i, '73'],
  [/associ[ée] unique/i, '41'],
  [/mandataire ad hoc/i, '97'],
];

/**
 * Les correspondances sociétaires priment sur la recherche par libellé exact :
 * « Président » doit donner « Président de SAS » (73) et non le rôle 205,
 * qui est celui du président d'une association.
 * @returns {{code, libelle}|null}
 */
function roleDepuisFonction(fonction) {
  const texte = String(fonction || '').trim();
  if (!texte) return null;
  for (const [motif, code] of CORRESPONDANCES_ROLE) if (motif.test(texte)) return role(code);
  const direct = ROLES_PAR_LIBELLE.get(texte.toLowerCase());
  return direct ? role(direct) : null;
}

/** Rôle par défaut du représentant légal selon la forme juridique. */
function rolePrincipal(codeForme) {
  const f = formeJuridique(codeForme);
  if (!f) return null;
  const famille = `${f.famille} ${f.categorie}`.toLowerCase();
  if (famille.includes('actions simplifi')) return role('73');      // Président de SAS
  if (famille.includes('anonyme à directoire')) return role('52');  // Président du directoire
  if (famille.includes('anonyme')) return role('51');               // Président du CA
  return role('30');                                                // Gérant
}

/* ----------------------------------------------------------- pièces jointes */

function piece(code) {
  const p = PIECES[String(code || '').trim()];
  return p ? { code: String(code), ...p } : null;
}

/* ----------------------------------------------------------- énumérations */

function enumeration(nom) {
  return ENUMS[nom] || {};
}

function libelleEnum(nom, code) {
  return enumeration(nom)[String(code)] || null;
}

const TYPES_FORMALITE = { CREATION: 'C', MODIFICATION: 'M', CESSATION: 'R', CORRECTION: 'Y', COMPLETION: 'Z' };
const TYPES_PERSONNE = { MORALE: 'M', PHYSIQUE: 'P', EXPLOITATION: 'E' };

// Rôle de l'établissement pour l'entreprise (annexe rolePourEntreprise).
const ROLE_ETABLISSEMENT = {
  SIEGE: '1',
  SIEGE_ET_PRINCIPAL: '2',
  PRINCIPAL: '3',
  SECONDAIRE: '4',
};

// Statut d'un bloc vis-à-vis de la formalité (annexe statutPourLaFormalite).
const STATUT_BLOC = { ADJONCTION: 'A', MODIFICATION: 'M', SUPPRESSION: 'S', INCHANGE: 'I' };

/* ------------------------------------------------- statuts d'une formalité */

/**
 * Statuts renvoyés par le Guichet unique (§ 9.1 du contrat d'interface),
 * enrichis de l'action attendue côté mandataire : c'est cette colonne qui
 * pilote le suivi (« qui doit jouer ? »).
 */
const STATUTS = {
  BROUILLON: { libelle: 'Brouillon (non déposé)', couleur: 'gris', terminal: false, action: 'deposer' },
  RECEIVED: { libelle: 'Reçue par le guichet', couleur: 'bleu', terminal: false, action: 'attendre' },
  ERROR: { libelle: 'Erreur de contrôle', couleur: 'rouge', terminal: false, action: 'corriger' },
  SIGNATURE_PENDING: { libelle: 'À signer', couleur: 'orange', terminal: false, action: 'signer' },
  SIGNED: { libelle: 'Signée', couleur: 'bleu', terminal: false, action: 'attendre' },
  PAYMENT_PENDING: { libelle: 'À payer', couleur: 'orange', terminal: false, action: 'payer' },
  PAYMENT_VALIDATION_PENDING: { libelle: 'Paiement en cours', couleur: 'bleu', terminal: false, action: 'attendre' },
  PAID: { libelle: 'Payée', couleur: 'bleu', terminal: false, action: 'attendre' },
  VALIDATION_PENDING: { libelle: 'En cours de validation', couleur: 'bleu', terminal: false, action: 'attendre' },
  AMENDMENT_PENDING: { libelle: 'Régularisation demandée', couleur: 'rouge', terminal: false, action: 'regulariser' },
  AMENDMENT_SIGNATURE_PENDING: { libelle: 'Régularisation à signer', couleur: 'orange', terminal: false, action: 'signer' },
  AMENDMENT_PAYMENT_PENDING: { libelle: 'Régularisation à payer', couleur: 'orange', terminal: false, action: 'payer' },
  AMENDED: { libelle: 'Régularisée, en attente de validation', couleur: 'bleu', terminal: false, action: 'attendre' },
  EXPIRED: { libelle: 'Expirée (délai de régularisation dépassé)', couleur: 'rouge', terminal: false, action: 'regulariser' },
  VALIDATED: { libelle: 'Validée', couleur: 'vert', terminal: true, action: null },
  REJECTED: { libelle: 'Rejetée', couleur: 'rouge', terminal: true, action: null },
};

/** Normalise un statut reçu de l'INPI (inconnu → conservé tel quel). */
function normaliserStatut(brut) {
  if (!brut) return 'RECEIVED';
  const k = String(brut).toUpperCase().replace(/[\s-]/g, '_');
  return STATUTS[k] ? k : 'RECEIVED';
}

function statut(code) {
  return STATUTS[code] || { libelle: code, couleur: 'gris', terminal: false, action: null };
}

module.exports = {
  formeJuridique, formesCreation, codeFormeDepuisLibelle,
  role, roleDepuisFonction, rolePrincipal,
  piece, PIECES,
  EVENEMENTS, enumeration, libelleEnum,
  TYPES_FORMALITE, TYPES_PERSONNE, ROLE_ETABLISSEMENT, STATUT_BLOC,
  STATUTS, statut, normaliserStatut,
};
