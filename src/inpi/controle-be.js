'use strict';

/**
 * Modalités de contrôle d'un bénéficiaire effectif (BlocModaliteControle du
 * dictionnaire de données du guichet, GU_MCON002 à GU_MCON047).
 *
 * Le guichet refuse le texte libre (« Choisissez un type d'origine valide »,
 * dossier LGZ-2026-00052) : il attend la ventilation chiffrée de la détention
 * (directe ou indirecte, par personne morale ou en indivision ; pleine
 * propriété, nue-propriété, usufruit des votes) et les codes de
 * modalitesDeControle. La saisie se fait donc sous une forme structurée,
 * « controle », d'où l'on calcule le bloc attendu.
 */

const ENUMS = require('./data/enumerations.json');

const CODES_MODALITES = (ENUMS.valeurs || ENUMS).modalitesDeControle;

const DETENTIONS = ['direct', 'indirect_personnes_morales', 'indirect_indivision'];
const DROITS = { capital: ['pleine_propriete', 'nue_propriete'], votes: ['pleine_propriete', 'nue_propriete', 'usufruit'] };
const AUTRES = ['pouvoir_decision_ag', 'pouvoir_nomination', 'autres_moyens', 'representant_legal'];

/** Forme attendue, pour l'assistant et la documentation. */
const FORMAT_CONTROLE = 'Objet "controle" de chaque bénéficiaire : {"capital": {"direct": {"pleine_propriete": 49, "nue_propriete": 0}, '
  + '"indirect_personnes_morales": {"pleine_propriete": 0, "nue_propriete": 0}, "indirect_indivision": {…}}, '
  + '"votes": {"direct": {"pleine_propriete": 49, "nue_propriete": 0, "usufruit": 0}, "indirect_personnes_morales": {…}, "indirect_indivision": {…}}, '
  + '"autres": {"pouvoir_decision_ag": false, "pouvoir_nomination": false, "autres_moyens": false, "representant_legal": false}}. '
  + 'Pourcentages de 0 à 100 ; une détention indirecte par une société se déclare sous "indirect_personnes_morales" '
  + '(ex. 25,50 % détenus par l’intermédiaire d’une holding). Seules les rubriques utiles sont à fournir.';

const nombre = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(',', '.').replace(/\s|%/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const arrondi = (n) => Math.round(n * 100) / 100;

/** Somme des pourcentages d'une rubrique (capital ou votes). */
function total(rubrique = {}, droits) {
  return arrondi(DETENTIONS.reduce((s, d) => s + droits.reduce((t, k) => t + (nombre(rubrique[d]?.[k]) || 0), 0), 0));
}
const sousTotal = (rubrique = {}, detention, droits) => arrondi(droits.reduce((t, k) => t + (nombre(rubrique[detention]?.[k]) || 0), 0));

/** Erreurs de la saisie structurée, en clair ; vide si elle est valable. */
function erreursControle(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['modalités de contrôle : objet « controle » attendu'];
  const out = [];
  for (const k of Object.keys(c)) if (!['capital', 'votes', 'autres'].includes(k)) out.push(`rubrique inconnue « ${k} » (capital, votes, autres)`);
  for (const [rub, droits] of Object.entries(DROITS)) {
    const r = c[rub];
    if (r === undefined || r === null) continue;
    if (typeof r !== 'object' || Array.isArray(r)) { out.push(`« ${rub} » : objet attendu`); continue; }
    for (const [det, v] of Object.entries(r)) {
      if (!DETENTIONS.includes(det)) { out.push(`${rub} : détention inconnue « ${det} » (${DETENTIONS.join(', ')})`); continue; }
      if (!v || typeof v !== 'object') { out.push(`${rub}.${det} : objet attendu`); continue; }
      for (const [droit, p] of Object.entries(v)) {
        if (!droits.includes(droit)) { out.push(`${rub}.${det} : droit inconnu « ${droit} » (${droits.join(', ')})`); continue; }
        const n = nombre(p);
        if (Number.isNaN(n) || n < 0 || n > 100) out.push(`${rub}.${det}.${droit} : pourcentage de 0 à 100 attendu`);
      }
    }
    if (total(r, droits) > 100.001) out.push(`${rub} : le total des détentions dépasse 100 %`);
  }
  if (c.autres !== undefined && c.autres !== null) {
    if (typeof c.autres !== 'object' || Array.isArray(c.autres)) out.push('« autres » : objet attendu');
    else {
      for (const [k, v] of Object.entries(c.autres)) {
        if (!AUTRES.includes(k)) out.push(`autres : critère inconnu « ${k} » (${AUTRES.join(', ')})`);
        else if (typeof v !== 'boolean') out.push(`autres.${k} : true ou false attendu`);
      }
    }
  }
  if (!out.length) {
    const autre = AUTRES.some((k) => c.autres?.[k] === true);
    if (total(c.capital, DROITS.capital) <= 25 && total(c.votes, DROITS.votes) <= 25 && !autre) {
      out.push('aucun critère de bénéficiaire effectif : plus de 25 % du capital ou des votes, ou un autre moyen de contrôle');
    }
  }
  return out;
}

/** Ce qui manque à la déclaration du contrôle d'un bénéficiaire (saisie structurée ou codes du guichet). */
function manquantsControle(b = {}) {
  if (b.controle !== undefined && b.controle !== null) return erreursControle(b.controle).map((e) => `contrôle — ${e}`);
  const m = b.modalites;
  if (m === undefined || m === null || m === '' || (Array.isArray(m) && !m.length)) return ['modalités de contrôle (objet « controle »)'];
  const codes = [].concat(m).map(String);
  if (typeof m === 'string' && !CODES_MODALITES[m]) return ['modalités de contrôle en texte libre : à déclarer sous « controle » (détention chiffrée)'];
  const inconnus = codes.filter((x) => !CODES_MODALITES[x]);
  return inconnus.length ? [`modalités de contrôle inconnues du guichet (${inconnus.join(', ')}) : à déclarer sous « controle »`] : [];
}

/** Bloc « modalite » du guichet, calculé depuis la saisie structurée. */
function modaliteInpi(c = {}, dateEffet) {
  const cap = c.capital || {};
  const vot = c.votes || {};
  const g = (r, det, k) => arrondi(nombre(r[det]?.[k]) || 0);
  const capDirect = sousTotal(cap, 'direct', DROITS.capital);
  const capPm = sousTotal(cap, 'indirect_personnes_morales', DROITS.capital);
  const capInd = sousTotal(cap, 'indirect_indivision', DROITS.capital);
  const votDirect = sousTotal(vot, 'direct', DROITS.votes);
  const votPm = sousTotal(vot, 'indirect_personnes_morales', DROITS.votes);
  const votInd = sousTotal(vot, 'indirect_indivision', DROITS.votes);
  const capTotal = arrondi(capDirect + capPm + capInd);
  const votTotal = arrondi(votDirect + votPm + votInd);
  const a = c.autres || {};
  const codes = [];
  if (capTotal > 25 || votTotal > 25) codes.push('1');
  if (a.pouvoir_nomination) codes.push('5');
  if (a.autres_moyens || a.pouvoir_decision_ag) codes.push('6');
  if (a.representant_legal) codes.push('0');
  return {
    dateEffet: dateEffet || undefined,
    detentionPartDirecte: capDirect > 0,
    partsDirectesPleinePropriete: g(cap, 'direct', 'pleine_propriete'),
    partsDirectesNuePropriete: g(cap, 'direct', 'nue_propriete'),
    detentionPartIndirecte: capPm + capInd > 0,
    partsIndirectesIndivision: capInd,
    partsIndirectesIndivisionPleinePropriete: g(cap, 'indirect_indivision', 'pleine_propriete'),
    partsIndirectesIndivisionNuePropriete: g(cap, 'indirect_indivision', 'nue_propriete'),
    partsIndirectesPersonnesMorales: capPm,
    partsIndirectesPmoralesPleinePropriete: g(cap, 'indirect_personnes_morales', 'pleine_propriete'),
    partsIndirectesPmoralesNuePropriete: g(cap, 'indirect_personnes_morales', 'nue_propriete'),
    detentionPartTotale: capTotal,
    detentionVoteDirecte: votDirect > 0,
    voteDirectePleinePropriete: g(vot, 'direct', 'pleine_propriete'),
    voteDirecteNuePropriete: g(vot, 'direct', 'nue_propriete'),
    voteDirecteUsufruit: g(vot, 'direct', 'usufruit'),
    detentionVoteIndirecte: votPm + votInd > 0,
    voteIndirecteIndivision: votInd,
    voteIndirecteIndivisionPleinePropriete: g(vot, 'indirect_indivision', 'pleine_propriete'),
    voteIndirecteIndivisionNuePropriete: g(vot, 'indirect_indivision', 'nue_propriete'),
    voteIndirecteIndivisionUsufruit: g(vot, 'indirect_indivision', 'usufruit'),
    voteIndirectePersonnesMorales: votPm,
    voteIndirectePmoralesPleinePropriete: g(vot, 'indirect_personnes_morales', 'pleine_propriete'),
    voteIndirectePmoralesNuePropriete: g(vot, 'indirect_personnes_morales', 'nue_propriete'),
    voteIndirectePmoralesUsufruit: g(vot, 'indirect_personnes_morales', 'usufruit'),
    detentionVoteTotal: votTotal,
    vocationTitulaireDirectePleinePropriete: 0,
    vocationTitulaireDirecteNuePropriete: 0,
    vocationTitulaireIndirecteIndivision: 0,
    vocationTitulaireIndirectePleinePropriete: 0,
    vocationTitulaireIndirecteNuePropriete: 0,
    vocationTitulaireIndirectePersonnesMorales: 0,
    vocationTitulaireIndirectePmoralesPleinePropriete: 0,
    vocationTitulaireIndirectePmoralesNuePropriete: 0,
    detentionPouvoirDecisionAG: Boolean(a.pouvoir_decision_ag),
    detentionPouvoirNommageMembresConseilAdmin: Boolean(a.pouvoir_nomination),
    detentionAutresMoyensControle: Boolean(a.autres_moyens),
    beneficiaireRepresentantLegal: Boolean(a.representant_legal),
    gestionDelegueeSocieteGestion: false,
    representantLegalPlacementSansGestionDelegue: false,
    modalitesDeControle: codes,
    detention25pCapital: capTotal > 25,
    detention25pDroitVote: votTotal > 25,
    detentionCapitalIndirecteIndivision: capInd > 0,
    detentionCapitalIndirectesPersonnesMorales: capPm > 0,
    detentionVoteIndirecteIndivision: votInd > 0,
    detentionVoteIndirectePersonnesMorales: votPm > 0,
  };
}

module.exports = { CODES_MODALITES, FORMAT_CONTROLE, DETENTIONS, DROITS, AUTRES, erreursControle, manquantsControle, modaliteInpi };
