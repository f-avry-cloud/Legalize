'use strict';

/**
 * Exhaustivité du parcours : aucune pièce du guichet sans décision, aucune
 * pièce d'une fiche perdue en route, aucune règle morte, et les informations
 * que le serveur exige toujours demandées.
 *
 *   node scripts/test-exhaustivite.js
 *
 * Le pendant réel de ce test est scripts/banc-guichet.js, qui dépose chaque
 * scénario sur le serveur de démonstration.
 */

const catalogue = require('../src/inpi/catalogue-evenements');
const parcours = require('../src/inpi/parcours');
const creation = require('../src/inpi/parcours-creation');
const audit = require('../src/inpi/audit-pieces');
const { deposable } = require('../src/inpi/payload-parcours');

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 900)}` : ''}`);
    process.exitCode = 1;
  }
}

console.log('\nPièces du guichet (dictionnaire officiel)');
const couv = audit.couverture();
const parDecision = (d) => couv.filter((x) => x.decision === d);
verifier(`chaque pièce « personne morale » du guichet a une décision (${couv.length} pièces)`, !parDecision('non_decidee').length, parDecision('non_decidee').map((x) => x.code));
verifier('chaque exclusion est motivée', parDecision('exclue').every((x) => x.motif && x.motif.length > 10));
const utilisees = audit.piecesUtilisees();
verifier('une variante remplace toujours une pièce effectivement demandée', Object.keys(audit.VARIANTES).every((b) => utilisees.has(b)),
  Object.keys(audit.VARIANTES).filter((b) => !utilisees.has(b)));
verifier('aucune pièce à la fois demandée et exclue', Object.keys(audit.EXCLUSIONS).every((c) => !utilisees.has(c)));
const typesDocument = new Set(require('../src/inpi/data/pieces-guichet.json').types_document);
verifier('chaque pièce demandée ou proposée est un type de document accepté par le guichet',
  [...utilisees.keys(), ...Object.values(audit.VARIANTES).flat(), ...Object.keys(audit.COMPLEMENTS)].every((c) => typesDocument.has(c)),
  [...utilisees.keys(), ...Object.values(audit.VARIANTES).flat()].filter((c) => !typesDocument.has(c)));
console.log(`    ${parDecision('utilisee').length} utilisées, ${parDecision('variante').length} variantes, ${parDecision('complement').length} compléments, ${parDecision('exclue').length} exclues`);

console.log('\nRègles de pièces, opération par opération');
for (const op of Object.keys(parcours.OPERATIONS)) {
  const f = parcours.ficheOp(op);
  if (!f) { verifier(`${op} : fiche du catalogue`, false); continue; }
  const codesFiche = new Set([...f.pieces_obligatoires, ...f.pieces_selon_le_cas].map((p) => p.code));
  const regles = parcours.REGLES[op] || {};
  const mortes = Object.keys(regles.pieces || {}).filter((c) => !codesFiche.has(c) && !(regles.ajouts || {})[c]);
  // Situation encore vierge : toute pièce de la fiche doit apparaître, exigée ou à préciser.
  const r = parcours.resoudre([op], {}, { forme_juridique_code: '5710' });
  const vues = new Set([...r.pieces.obligatoires, ...r.pieces.a_preciser].map((p) => p.code));
  const parPersonne = new Set(['PJ_11', 'PJ_12', 'PJ_17', 'PJ_20', 'PJ_80', 'PJ_40', 'PJ_41', 'PJ_230']);
  // Une pièce sans règle doit au moins être proposée « à préciser » ; une règle, elle, tranche.
  const perdues = [...codesFiche].filter((c) => !vues.has(c) && !(regles.pieces || {})[c] && !(regles.personnes && parPersonne.has(c)));
  verifier(`${op} : ${codesFiche.size} pièce(s) de la fiche, aucune perdue, aucune règle morte`, !mortes.length && !perdues.length, { mortes, perdues });
}

console.log('\nRéponses complètes : plus rien à préciser');
const SITUATION_CREATION = {
  forme_creation: 'SAS', siege_occupation: 'locaux', apports_numeraire: true, apports_nature: true, commissaire_apports: true,
  premiers_dirigeants_statuts: false, fonds_origine: 'achat', activite_reglementee: true, entrants: [{ nom: 'A B', nature: 'PP', fonction: '73' }],
};
const SITUATIONS = {
  '01M': SITUATION_CREATION, '02M': SITUATION_CREATION,
  '11M': { siege_occupation: 'domiciliation', domiciliataire_meme_greffe: false, hors_ressort: true },
  '12M': { activite_reglementee: false }, '13M': { rapport_transformation: true },
  '15M': { capital_sens: 'augmentation', capital_modalite: 'numeraire' },
  '35M': { entrants: [{ nom: 'A B', nature: 'PP', fonction: 'dirigeant' }], sortants: [], statuts_modifies: false },
  '34M': { entrants: [{ nom: 'A B', nature: 'PP', fonction: 'dirigeant' }], sortants: [], statuts_modifies: false },
  '22M': { entrants: [{ nom: 'A B', nature: 'PP', fonction: 'liquidateur' }] },
  '54PMF': { siege_occupation: 'locaux', fonds_origine: 'creation', activite_reglementee: false },
  '61PMF': { activite_reglementee: false },
  MAJDIR: { mises_a_jour: [{ nom: 'A B', motif: 'adresse' }], statuts_modifies: false },
};
for (const [op, t] of Object.entries(SITUATIONS)) {
  const r = parcours.resoudre([op], t, { forme_juridique_code: '5710' });
  const restent = r.pieces.a_preciser.filter((p) => !p.manuel);
  verifier(`${op} : chaque pièce conditionnelle tranchée par les réponses`, !restent.length && r.questions.every((q) => q.valeur !== null || q.attente), restent.map((p) => p.code));
}

console.log('\nInformations exigées par le serveur (constatées par dépôts de test)');
const g = parcours.resoudre(['01M'], { ...SITUATION_CREATION, siege_occupation: 'domiciliation', entrants: [{ nom: 'A B', nature: 'PP', fonction: '73' }, { nom: 'X SAS', nature: 'PM', fonction: '53' }] }, {}, {}).champs;
const champ = (op, name) => g.find((x) => x.op === op)?.champs.find((c) => c.name === name);
const pp = champ('c_dirigeants', 'entrant_0');
const pm = champ('c_dirigeants', 'entrant_1');
for (const k of ['genre', 'date_naissance', 'lieu_naissance', 'forme_sociale', 'adresse.codePostal', 'adresse.commune']) {
  verifier(`dirigeant personne physique : ${k}`, pp.sous_requis.includes(k));
}
verifier('dirigeant personne physique : code INSEE de naissance si né en France', creation.manquants(pp, { nom: 'B', prenoms: 'A', genre: '1', date_naissance: '1980-01-01', lieu_naissance: 'Lyon', forme_sociale: '1', adresse: { codePostal: '75002', commune: 'Paris' } }).includes('code INSEE de la commune de naissance'));
verifier('travailleur non salarié : NIR et volet social', ['numéro de sécurité sociale', 'régime d’assurance maladie actuel', 'activité exercée en parallèle']
  .every((m) => creation.manquants(pp, { forme_sociale: '3' }).includes(m)));
for (const k of ['siren', 'forme_juridique_code', 'greffe']) verifier(`dirigeant personne morale : ${k}`, pm.sous_requis.includes(k));
for (const [op, name] of [['c_societe', 'date_signature_statuts'], ['c_siege', 'domiciliataire_siren'], ['c_activite', 'categorie'], ['c_publication', 'journal_publication'],
  ['c_publication', 'date_publication'], ['c_fiscal', 'regime_benefices'], ['c_fiscal', 'regime_tva'], ['c_be', 'beneficiaires']]) {
  verifier(`création : ${name} demandé et obligatoire`, champ(op, name)?.requis === true);
}
const modif = parcours.resoudre(['35M'], { entrants: [{ nom: 'A B', nature: 'PP', fonction: 'dirigeant' }, { nom: 'X', nature: 'PM', fonction: 'dirigeant' }] }, { forme_juridique_code: '5710' }).champs.find((x) => x.op === '35M');
verifier('nomination : mêmes exigences qu’à la création', modif.champs[0].sous_requis.includes('forme_sociale') && modif.champs[1].sous_requis.includes('forme_juridique_code'));

console.log('\nDépôt automatique');
const nonDeposables = Object.keys(parcours.OPERATIONS).filter((op) => !deposable(op));
console.log(`    déposables : ${Object.keys(parcours.OPERATIONS).filter(deposable).join(', ')}`);
console.log(`    à finaliser sur le portail : ${nonDeposables.join(', ')}`);
verifier('création et modifications courantes déposables', ['01M', '02M', '10M', '12M', '13M', '14M', '15M', '16M', '17M', '25M', '26M', '34M', '35M'].every(deposable));

console.log(`\n${ok} vérification(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
