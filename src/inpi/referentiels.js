'use strict';

/**
 * Référentiels de codes utilisés par les API INPI.
 *
 * ⚠️ Point d'attention unique du projet : les tables de codes ci-dessous sont
 * la SEULE partie du connecteur qui dépend des annexes de la documentation
 * technique INPI (« Annexes — référentiels » de la doc API formalités et du
 * contrat d'interface mandataire). Elles sont volontairement regroupées ici
 * pour être vérifiées / complétées d'un seul endroit, sans toucher au reste
 * du code. Les codes « catégorie juridique » suivent la nomenclature INSEE,
 * qui est celle reprise par le RNE.
 *
 * Toute valeur inconnue est signalée par les contrôles (src/inpi/controles.js)
 * plutôt que devinée silencieusement.
 */

/* ------------------------------------------------- formes juridiques (INSEE) */

const FORMES_JURIDIQUES = {
  1000: { libelle: 'Entrepreneur individuel', famille: 'ei', titres: null, capital: false, dirigeant: 'Entrepreneur' },
  5202: { libelle: 'Société en nom collectif', famille: 'snc', titres: 'parts', capital: true, dirigeant: 'Gérant' },
  5306: { libelle: 'Société en commandite simple', famille: 'scs', titres: 'parts', capital: true, dirigeant: 'Gérant' },
  5498: { libelle: 'SARL unipersonnelle (EURL)', famille: 'sarl', titres: 'parts', capital: true, dirigeant: 'Gérant' },
  5499: { libelle: 'SARL', famille: 'sarl', titres: 'parts', capital: true, dirigeant: 'Gérant' },
  5599: { libelle: 'SA à conseil d’administration', famille: 'sa', titres: 'actions', capital: true, dirigeant: 'Président du conseil d’administration' },
  5699: { libelle: 'SA à directoire', famille: 'sa', titres: 'actions', capital: true, dirigeant: 'Président du directoire' },
  5710: { libelle: 'SAS', famille: 'sas', titres: 'actions', capital: true, dirigeant: 'Président' },
  5720: { libelle: 'SASU', famille: 'sas', titres: 'actions', capital: true, dirigeant: 'Président' },
  5785: { libelle: 'SELAS', famille: 'sas', titres: 'actions', capital: true, dirigeant: 'Président' },
  6540: { libelle: 'Société civile immobilière', famille: 'sci', titres: 'parts', capital: true, dirigeant: 'Gérant' },
  6599: { libelle: 'Autre société civile', famille: 'civile', titres: 'parts', capital: true, dirigeant: 'Gérant' },
};

function formeJuridique(code) {
  return FORMES_JURIDIQUES[String(code)] || null;
}

/** Retrouve un code INSEE à partir d'un libellé libre saisi en fiche société. */
function codeFormeDepuisLibelle(libelle) {
  if (!libelle) return null;
  const n = String(libelle).toUpperCase().replace(/[^A-Z]/g, '');
  const table = [
    ['SASU', '5720'], ['SELAS', '5785'], ['SAS', '5710'],
    ['EURL', '5498'], ['SARLUNIPERSONNELLE', '5498'], ['SARL', '5499'],
    ['SADIRECTOIRE', '5699'], ['SA', '5599'],
    ['SCI', '6540'], ['SNC', '5202'],
  ];
  for (const [motif, code] of table) if (n.includes(motif)) return code;
  return null;
}

/* --------------------------------------------------------- rôles / fonctions */

// Codes « rôle de la personne » du RNE. À confirmer avec l'annexe INPI avant
// un dépôt réel : un code absent d'ici est signalé en contrôle bloquant.
const ROLES = {
  PRESIDENT: { code: '30', libelle: 'Président' },
  DIRECTEUR_GENERAL: { code: '31', libelle: 'Directeur général' },
  GERANT: { code: '5', libelle: 'Gérant' },
  ADMINISTRATEUR: { code: '23', libelle: 'Administrateur' },
  COMMISSAIRE_COMPTES: { code: '73', libelle: 'Commissaire aux comptes titulaire' },
  LIQUIDATEUR: { code: '40', libelle: 'Liquidateur' },
  ASSOCIE: { code: '2', libelle: 'Associé' },
};

function roleDepuisFonction(fonction) {
  const n = String(fonction || '').toLowerCase();
  if (n.includes('liquidateur')) return ROLES.LIQUIDATEUR;
  if (n.includes('commissaire')) return ROLES.COMMISSAIRE_COMPTES;
  if (n.includes('directeur')) return ROLES.DIRECTEUR_GENERAL;
  if (n.includes('gérant') || n.includes('gerant')) return ROLES.GERANT;
  if (n.includes('administrateur')) return ROLES.ADMINISTRATEUR;
  if (n.includes('président') || n.includes('president')) return ROLES.PRESIDENT;
  return null;
}

/* ------------------------------------------------------ types de formalité */

// Type de formalité au sens du Guichet unique.
const TYPES_FORMALITE = {
  CREATION: 'C',
  MODIFICATION: 'M',
  CESSATION: 'F',
  DEPOT_COMPTES: 'B',
};

/* ------------------------------------------------------------ pièces jointes */

const TYPES_PIECE = {
  STATUTS: { code: 'STATUTS', libelle: 'Statuts à jour signés' },
  PV_DECISION: { code: 'PV', libelle: 'Procès-verbal / décision de l’organe compétent' },
  JAL: { code: 'JAL', libelle: 'Attestation de parution au journal d’annonces légales' },
  JOUISSANCE_LOCAUX: { code: 'JOUISSANCE', libelle: 'Justificatif de jouissance des locaux (bail, titre de propriété, contrat de domiciliation)' },
  PIECE_IDENTITE: { code: 'IDENTITE', libelle: 'Copie de la pièce d’identité du dirigeant' },
  DNC: { code: 'DNC', libelle: 'Déclaration sur l’honneur de non-condamnation et de filiation' },
  ATTESTATION_DEPOT_FONDS: { code: 'DEPOT_FONDS', libelle: 'Attestation de dépôt des fonds' },
  RAPPORT_CAC: { code: 'RAPPORT_CAC', libelle: 'Rapport du commissaire aux apports / aux comptes' },
  COMPTES_ANNUELS: { code: 'COMPTES', libelle: 'Comptes annuels (bilan, compte de résultat, annexe)' },
  PV_APPROBATION: { code: 'PV_APPRO', libelle: 'Procès-verbal d’approbation des comptes' },
  DECLARATION_CONFIDENTIALITE: { code: 'CONFIDENTIALITE', libelle: 'Déclaration de confidentialité des comptes' },
  COMPTES_LIQUIDATION: { code: 'COMPTES_LIQ', libelle: 'Comptes définitifs de liquidation' },
  POUVOIR: { code: 'POUVOIR', libelle: 'Pouvoir du signataire (si le déposant n’est pas le représentant légal)' },
};

/* ---------------------------------------------------------------- statuts GU */

// Statuts renvoyés par l'API mandataire sur une formalité déposée, projetés
// sur un vocabulaire stable côté application (l'INPI a fait évoluer ses
// libellés ; on normalise pour que le suivi ne casse pas).
const STATUTS = {
  BROUILLON: { libelle: 'Brouillon', couleur: 'gris', terminal: false },
  A_SIGNER: { libelle: 'À signer', couleur: 'orange', terminal: false },
  SIGNEE: { libelle: 'Signée', couleur: 'bleu', terminal: false },
  A_PAYER: { libelle: 'À payer', couleur: 'orange', terminal: false },
  DEPOSEE: { libelle: 'Déposée', couleur: 'bleu', terminal: false },
  EN_COURS: { libelle: 'En cours de traitement', couleur: 'bleu', terminal: false },
  REGULARISATION: { libelle: 'Régularisation demandée', couleur: 'rouge', terminal: false },
  VALIDEE: { libelle: 'Validée', couleur: 'vert', terminal: true },
  REJETEE: { libelle: 'Rejetée', couleur: 'rouge', terminal: true },
  ABANDONNEE: { libelle: 'Abandonnée', couleur: 'gris', terminal: true },
};

const ALIAS_STATUTS = {
  DRAFT: 'BROUILLON', BROUILLON: 'BROUILLON',
  TO_SIGN: 'A_SIGNER', A_SIGNER: 'A_SIGNER',
  SIGNED: 'SIGNEE', SIGNEE: 'SIGNEE', SIGNE: 'SIGNEE',
  TO_PAY: 'A_PAYER', A_PAYER: 'A_PAYER',
  SUBMITTED: 'DEPOSEE', DEPOSEE: 'DEPOSEE', DEPOSE: 'DEPOSEE',
  IN_PROGRESS: 'EN_COURS', EN_COURS: 'EN_COURS', EN_COURS_DE_TRAITEMENT: 'EN_COURS',
  REGULARIZATION: 'REGULARISATION', REGULARISATION: 'REGULARISATION', A_REGULARISER: 'REGULARISATION',
  VALIDATED: 'VALIDEE', VALIDEE: 'VALIDEE', VALIDE: 'VALIDEE',
  REJECTED: 'REJETEE', REJETEE: 'REJETEE', REJETE: 'REJETEE',
  ABANDONED: 'ABANDONNEE', ABANDONNEE: 'ABANDONNEE',
};

/** Projette un statut brut de l'INPI sur le vocabulaire interne. */
function normaliserStatut(brut) {
  if (!brut) return 'DEPOSEE';
  const k = String(brut).toUpperCase().replace(/[\s-]/g, '_');
  return ALIAS_STATUTS[k] || (STATUTS[k] ? k : 'EN_COURS');
}

module.exports = {
  FORMES_JURIDIQUES, formeJuridique, codeFormeDepuisLibelle,
  ROLES, roleDepuisFonction,
  TYPES_FORMALITE, TYPES_PIECE,
  STATUTS, normaliserStatut,
};
