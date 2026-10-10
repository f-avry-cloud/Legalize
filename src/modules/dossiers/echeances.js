'use strict';

/**
 * Échéances légales calculées à l'ouverture d'un dossier.
 *
 * Seules des règles sûres et générales sont calculées ; le cabinet ajoute
 * à la main ce qui dépend des statuts ou d'une convention. Chaque date est
 * proposée avec son texte : on voit d'où elle vient.
 */

/**
 * Terme d'un délai exprimé en mois (C. pr. civ., art. 641) : le jour du
 * dernier mois qui porte le même quantième ; à défaut, le dernier jour de
 * ce mois. 31/12 + 6 mois = 30/06 ; 30/06 + 1 mois = 30/07.
 */
function ajouterMois(iso, mois) {
  const [a, m, j] = iso.split('-').map(Number);
  const cible = new Date(Date.UTC(a, m - 1 + mois, 1));
  const dernier = new Date(Date.UTC(cible.getUTCFullYear(), cible.getUTCMonth() + 1, 0)).getUTCDate();
  cible.setUTCDate(Math.min(j, dernier));
  return cible.toISOString().slice(0, 10);
}

/** Famille de forme sociale, à partir du libellé de la fiche société. */
function familleForme(forme = '') {
  const f = String(forme).toUpperCase();
  if (/\bSAS\b|\bSASU\b|ACTIONS SIMPLIFI/.test(f)) return 'SAS';
  if (/\bSARL\b|\bEURL\b|RESPONSABILIT/.test(f)) return 'SARL';
  if (/\bSA\b|ANONYME/.test(f)) return 'SA';
  if (/\bSNC\b|NOM COLLECTIF/.test(f)) return 'SNC';
  return null;
}

const TEXTES_APPROBATION = {
  SARL: 'C. com., art. L. 223-26',
  SA: 'C. com., art. L. 225-100',
  SAS: 'C. com., art. L. 225-100, applicable par renvoi de l’art. L. 227-1',
  SNC: 'C. com., art. L. 221-7',
};
const TEXTES_DEPOT = {
  SARL: 'C. com., art. L. 232-22',
  SA: 'C. com., art. L. 232-23',
  SAS: 'C. com., art. L. 232-23',
  SNC: 'C. com., art. L. 232-21',
};

/**
 * Échéances d'un dossier d'approbation des comptes.
 *   donnees.exercice_clos_le : date de clôture ;
 *   donnees.date_decision_prevue : date prévue de la décision (facultative).
 */
function approbationComptes(donnees = {}, formeSociale = '') {
  const cloture = donnees.exercice_clos_le;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cloture || ''))) return [];
  const forme = familleForme(formeSociale);
  const limiteApprobation = ajouterMois(cloture, 6);
  const decision = /^\d{4}-\d{2}-\d{2}$/.test(String(donnees.date_decision_prevue || '')) ? donnees.date_decision_prevue : limiteApprobation;
  return [
    {
      nature: 'approbation_comptes',
      libelle: 'Approbation des comptes : au plus tard six mois après la clôture (sauf prorogation par le président du tribunal de commerce)',
      date: limiteApprobation,
      base_legale: forme ? TEXTES_APPROBATION[forme] : 'C. com., art. L. 223-26 (SARL), L. 225-100 (SA, SAS)',
    },
    {
      nature: 'depot_comptes',
      libelle: 'Dépôt des comptes au greffe : un mois après l’approbation (deux mois par voie électronique)',
      date: ajouterMois(decision, 1),
      base_legale: forme ? TEXTES_DEPOT[forme] : 'C. com., art. L. 232-22 (SARL), L. 232-23 (SA, SAS)',
    },
  ];
}

/** Échéances calculées pour un type de dossier. */
function calculer(type, donnees, formeSociale) {
  if (type === 'approbation_comptes') return approbationComptes(donnees, formeSociale);
  return [];
}

module.exports = { calculer, ajouterMois, familleForme, approbationComptes };
