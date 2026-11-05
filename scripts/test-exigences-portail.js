'use strict';

/**
 * Exigences du portail du guichet unique relevées le 5/11/2026 (brouillons
 * fictifs de création de SAS, de modification et de dissolution, jamais
 * transmis), confrontées au dictionnaire du guichet embarqué
 * (src/inpi/data/pieces-guichet.json). Aucun appel à l'INPI.
 *
 *   node scripts/test-exigences-portail.js
 */

const moteur = require('../src/inpi/parcours');
const { construireParcours } = require('../src/inpi/payload-parcours');
const usage = require('../src/inpi/data/pieces-guichet.json').valeurs;

let ok = 0;
let echecs = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    echecs += 1;
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
  }
}
const codes = (l) => l.map((p) => p.code);
const SAS = { forme_juridique_code: '5710', denomination: 'ESSAI SAS', siren: '552100554' };
const SARL = { forme_juridique_code: '5499', denomination: 'ESSAI SARL', siren: '552100554' };
const CREATION = {
  siege_occupation: 'locaux', apports_numeraire: true, apports_nature: false, premiers_dirigeants_statuts: true,
  fonds_origine: 'creation', activite_reglementee: false, entrants: [{ nom: 'Paul MARTIN', nature: 'PP', fonction: '73' }],
};

console.log('\nPièces de société : aucune pièce réservée au dépôt d’actes (dictionnaire du guichet)');
// Exceptions connues, que le relevé du 5/11 n'a pas couvertes (opérations non testées
// sur le portail) : à trancher par un relevé avant de les changer. Toute nouvelle
// pièce hors du type « PM » fait échouer le test.
const EXCEPTIONS = {
  PJ_97: '11M : liste des sièges antérieurs, absente du dictionnaire (11M se finalise sur le portail)',
  PJ_236: '26M : PV d’affectation du résultat, pièce de comptes annuels',
  PJ_53: '62M : carte d’activité non sédentaire, sans type au dictionnaire',
  PJ_161: '41M : projet de fusion (dépôt d’actes)', PJ_199: '41M : projet de scission (dépôt d’actes)',
  PJ_175: '41M : PV d’approbation de la fusion (dépôt d’actes)', PJ_176: '41M : publication au BODACC (dépôt d’actes)',
};
const situations = [{}, { capital_sens: 'augmentation', capital_modalite: 'numeraire' },
  { capital_sens: 'augmentation', capital_modalite: 'nature', commissaire_apports: true }, { capital_sens: 'reduction' },
  { rapport_transformation: true }, { ...CREATION, forme_creation: 'SAS', apports_nature: true, commissaire_apports: true, fonds_origine: 'achat' },
  { entrants: [{ nom: 'A B', nature: 'PP', fonction: 'liquidateur' }] }];
const horsPm = {};
for (const op of Object.keys(moteur.OPERATIONS)) {
  for (const fiche of [SAS, SARL]) {
    for (const t of situations) {
      let r;
      try { r = moteur.resoudre([op], t, fiche); } catch (e) { continue; }
      for (const p of [...r.pieces.obligatoires, ...r.pieces.a_preciser, ...r.pieces.facultatives]) {
        if (!(usage[p.code]?.types || []).includes('PM')) (horsPm[p.code] = horsPm[p.code] || new Set()).add(op);
      }
    }
  }
}
const nouvelles = Object.keys(horsPm).filter((c) => !EXCEPTIONS[c]);
verifier('aucune pièce hors type « PM » en dehors des exceptions connues', !nouvelles.length,
  Object.fromEntries(nouvelles.map((c) => [c, [...horsPm[c]]])));
verifier('le contrôle voit bien les exceptions connues (il ne passe pas à vide)', Object.keys(EXCEPTIONS).every((c) => horsPm[c]),
  Object.keys(EXCEPTIONS).filter((c) => !horsPm[c]));
verifier('15M et 13M n’emploient plus PJ_155, PJ_156, PJ_163, PJ_157 ni PJ_160',
  !['PJ_155', 'PJ_156', 'PJ_163', 'PJ_157', 'PJ_160'].some((c) => horsPm[c]), Object.keys(horsPm));

console.log('\nCréation d’une SAS : pièces bloquantes du portail');
const sas = moteur.resoudre(['01M'], { ...CREATION, forme_creation: 'SAS' }, {});
const obl = codes(sas.pieces.obligatoires);
verifier('copie de l’insertion (PJ_09) exigée, attestation de parution (PJ_08) facultative',
  obl.includes('PJ_09') && !obl.includes('PJ_08') && codes(sas.pieces.facultatives).includes('PJ_08'), { obl, fac: codes(sas.pieces.facultatives) });
verifier('apports en numéraire : certificat du dépositaire (PJ_06) et attestation de dépôt des fonds (PJ_180)', ['PJ_06', 'PJ_180'].every((c) => obl.includes(c)), obl);
const ligne = (r, c) => r.pieces.obligatoires.find((p) => p.code === c);
verifier('aucun document de substitution sur ces deux lignes (une pièce sous l’autre type y manquerait)',
  !ligne(sas, 'PJ_06').variantes.length && !ligne(sas, 'PJ_180').variantes.length, [ligne(sas, 'PJ_06').variantes, ligne(sas, 'PJ_180').variantes]);
verifier('statuts, justificatif des locaux, identité et non-condamnation du dirigeant exigés',
  ['PJ_01', 'PJ_25', 'PJ_11', 'PJ_17'].every((c) => obl.includes(c)), obl);
const sasu = moteur.resoudre(['01M'], { ...CREATION, forme_creation: 'SASU' }, {});
verifier('SASU : mêmes pièces de fonds', ['PJ_06', 'PJ_180'].every((c) => codes(sasu.pieces.obligatoires).includes(c)));
const sansNumeraire = moteur.resoudre(['01M'], { ...CREATION, forme_creation: 'SAS', apports_numeraire: false, apports_nature: true, commissaire_apports: true }, {});
verifier('SAS sans apport en numéraire : ni PJ_06 ni PJ_180', !codes(sansNumeraire.pieces.obligatoires).some((c) => ['PJ_06', 'PJ_180'].includes(c)));
const sarl = moteur.resoudre(['01M'], { ...CREATION, forme_creation: 'SARL', entrants: [{ nom: 'Paul MARTIN', nature: 'PP', fonction: '30' }] }, {});
verifier('SARL (non relevée sur le portail) : certificat du dépositaire seul, comme avant',
  codes(sarl.pieces.obligatoires).includes('PJ_06') && !codes(sarl.pieces.obligatoires).includes('PJ_180') && ligne(sarl, 'PJ_06').variantes.length > 0);
const sansActivite = moteur.resoudre(['02M'], { ...CREATION, forme_creation: 'SAS' }, {});
verifier('société sans activité (02M) : PJ_09, PJ_06 et PJ_180', ['PJ_09', 'PJ_06', 'PJ_180'].every((c) => codes(sansActivite.pieces.obligatoires).includes(c)));
const modif = moteur.resoudre(['10M'], {}, SAS);
verifier('modification : l’attestation de parution (PJ_08) reste la pièce d’annonce', codes(modif.pieces.obligatoires).includes('PJ_08'));

console.log('\nCapital (15M) : pièces de société');
const p15 = (t, fiche) => { const r = moteur.resoudre(['15M'], t, fiche); return { obl: codes(r.pieces.obligatoires), tout: [...codes(r.pieces.obligatoires), ...codes(r.pieces.a_preciser)] }; };
const augSas = p15({ capital_sens: 'augmentation', capital_modalite: 'numeraire' }, SAS);
verifier('SAS, augmentation en numéraire : PV (PJ_54) et certificat du dépositaire (PJ_56)', ['PJ_54', 'PJ_56'].every((c) => augSas.obl.includes(c)) && !augSas.tout.includes('PJ_180'), augSas);
const augSarl = p15({ capital_sens: 'augmentation', capital_modalite: 'numeraire' }, SARL);
verifier('SARL, augmentation en numéraire : attestation de dépôt des fonds (PJ_180), pas PJ_56', augSarl.obl.includes('PJ_180') && !augSarl.tout.includes('PJ_56'), augSarl);
const nature = p15({ capital_sens: 'augmentation', capital_modalite: 'nature', commissaire_apports: true }, SAS);
verifier('apport en nature : rapport du commissaire aux apports (PJ_04)', nature.obl.includes('PJ_04') && !nature.tout.includes('PJ_163'), nature);
const reduction = p15({ capital_sens: 'reduction' }, SAS);
verifier('réduction : PV (PJ_54), sans PJ_156', reduction.obl.includes('PJ_54') && !reduction.tout.includes('PJ_156'), reduction);
const inconnu = moteur.resoudre(['15M'], {}, SAS);
verifier('sens non précisé : la question est posée, rien d’exigé à l’aveugle', inconnu.questions.some((q) => q.id === 'capital_sens') && !codes(inconnu.pieces.obligatoires).includes('PJ_56'));

console.log('\nTransformation (13M)');
const t13 = moteur.resoudre(['13M'], { rapport_transformation: true }, SAS);
verifier('PV de transformation (PJ_153), statuts, rapport du commissaire (PJ_91) ; ni PJ_157 ni PJ_160',
  ['PJ_153', 'PJ_02', 'PJ_91'].every((c) => codes(t13.pieces.obligatoires).includes(c)) && !codes(t13.pieces.obligatoires).some((c) => ['PJ_157', 'PJ_160'].includes(c)), codes(t13.pieces.obligatoires));

console.log('\nDissolution (22M) : rubriques obligatoires du portail');
const ch22 = (rep) => moteur.resoudre(['22M'], { entrants: [{ nom: 'A B', nature: 'PP', fonction: 'liquidateur' }], liquidateur_en_place: false }, SAS, rep)
  .champs.find((g) => g.op === '22M').champs;
const champ = (l, n) => l.find((c) => c.name === n);
verifier('lieu de liquidation obligatoire (proposé « au siège », à confirmer)', champ(ch22({}), 'lieu_liquidation').requis === true && champ(ch22({}), 'lieu_liquidation').defaut === 'S');
verifier('sans poursuite d’activité : date de cessation d’activité obligatoire', champ(ch22({ '22M': { poursuite_activite: false } }), 'date_cessation_activite').requis === true);
verifier('avec poursuite d’activité : date de cessation facultative', !champ(ch22({ '22M': { poursuite_activite: true } }), 'date_cessation_activite').requis);

console.log('\nDirigeant personne morale : « Souhaitez-vous désigner un représentant permanent ? »');
const ADR = { numVoie: '1', typeVoie: 'RUE', voie: 'de Brest', codePostal: '29000', commune: 'Quimper', codeInseeCommune: '29232' };
const representant = { nom: 'LE GALL', prenoms: 'Yann', genre: '1', date_naissance: '1970-03-12', lieu_naissance: 'Brest', code_insee_naissance: '29019',
  pays_naissance: 'FRANCE', nationalite: 'Française', adresse: ADR };
const creationPm = (avecRepresentant) => construireParcours({
  operations: ['01M'], fiche: {}, siren: '', reference: 'LGZ-TEST', libelle: 'Essai',
  typologie: { ...CREATION, forme_creation: 'SAS', entrants: [{ nom: 'HOLDING ESSAI', nature: 'PM', fonction: '73' }] },
  reponses: {
    c_societe: { denomination: 'ESSAI', capital: 1000, objet: 'Conseil', duree: 99, date_cloture: '31/12', date_signature_statuts: '2026-10-15' },
    c_siege: { adresse_siege: ADR },
    c_activite: { activite_principale: 'Conseil', categorie: '07-04-08-02', date_debut_activite: '2026-11-02', exercice_activite: 'P' },
    c_dirigeants: { entrant_0: { denomination: 'HOLDING ESSAI', siren: '794598813', forme_juridique_code: '5710', greffe: 'Quimper', adresse: ADR,
      ...(avecRepresentant ? { representant } : {}) } },
    c_fiscal: { regime_benefices: '114', regime_tva: '311' },
    c_publication: { journal_publication: 'actu.fr', date_publication: '2026-11-03', diffusion_commerciale: false },
  },
  pieces: [],
}).corps.content.personneMorale.composition.pouvoirs[0];
const avec = creationPm(true);
verifier('représentant identifié : « oui » transmis, avec son identité', avec.designerRepresentantPermanent === true && avec.representant?.descriptionPersonne?.nom === 'LE GALL', avec);
const sans = creationPm(false);
verifier('représentant non identifié : « non » transmis, aucun représentant', sans.designerRepresentantPermanent === false && !sans.representant, sans);
verifier('personne morale française : pays « FRA » et lieu du registre transmis', avec.entreprise.pays === 'FRA' && avec.entreprise.lieuRegistre === 'QUIMPER', avec.entreprise);

console.log(`\n${ok} vérification(s)${echecs ? ` — ${echecs} ÉCHEC(S)` : ' — tout est vert'}`);
process.exit(echecs ? 1 : 0);
