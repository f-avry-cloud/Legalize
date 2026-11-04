'use strict';

/**
 * Règles tirées des synthèses du guichet déposées par le cabinet (2023-2026) :
 * chaque vérification correspond à un écart constaté entre la pratique validée
 * par les greffes et le connecteur (docs/ecarts-syntheses.md).
 */
const parcours = require('../src/inpi/parcours');
const { construireParcours } = require('../src/inpi/payload-parcours');

let echecs = 0;
function verifier(nom, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${nom}`);
  if (!ok) { echecs += 1; if (detail !== undefined) console.log('    ', JSON.stringify(detail).slice(0, 400)); }
}
const codes = (liste) => liste.map((p) => p.code);
const FICHE = { forme_juridique_code: '5710', denomination: 'ESSAI', siren: '552100554' };

console.log('\n16M : annonce légale selon ce qui change');
const cloture = parcours.resoudre(['16M'], { objet_16M: 'cloture' }, FICHE);
verifier('seule la date de clôture change : pas d’annonce', !codes(cloture.pieces.obligatoires).includes('PJ_08') && !codes(cloture.pieces.a_preciser).includes('PJ_08'), cloture.pieces);
verifier('PV et statuts restent dus', ['PJ_54', 'PJ_02'].every((c) => codes(cloture.pieces.obligatoires).includes(c)));
const duree = parcours.resoudre(['16M'], { objet_16M: 'duree' }, FICHE);
verifier('la durée change : annonce due', codes(duree.pieces.obligatoires).includes('PJ_08'));
const inconnu = parcours.resoudre(['16M'], {}, FICHE);
verifier('sans réponse : annonce à préciser, question posée', codes(inconnu.pieces.a_preciser).includes('PJ_08') && inconnu.questions.some((q) => q.id === 'objet_16M'));
const avecAutre = parcours.resoudre(['16M', '10M'], { objet_16M: 'cloture' }, FICHE);
verifier('avec un changement de dénomination, l’annonce reste due', codes(avecAutre.pieces.obligatoires).includes('PJ_08'));

console.log('\n22M : liquidateur et informations de la dissolution');
const liq = [{ nom: 'Jean MARTIN', nature: 'PP', fonction: 'liquidateur' }];
const nouveau = parcours.resoudre(['22M'], { entrants: liq, liquidateur_en_place: false }, FICHE);
verifier('liquidateur nouveau : identité et non-condamnation dues', ['PJ_11', 'PJ_17'].every((c) => codes(nouveau.pieces.obligatoires).includes(c)));
const enPlace = parcours.resoudre(['22M'], { entrants: liq, liquidateur_en_place: true }, FICHE);
verifier('liquidateur déjà dirigeant : pièces proposées, pas exigées',
  !['PJ_11', 'PJ_17'].some((c) => codes(enPlace.pieces.obligatoires).includes(c)) && ['PJ_11', 'PJ_17'].every((c) => codes(enPlace.pieces.a_preciser).includes(c)), enPlace.pieces);
verifier('la question n’est posée que pour un liquidateur personne physique',
  !parcours.resoudre(['22M'], { entrants: [{ nom: 'LIQUI SAS', nature: 'PM', fonction: 'liquidateur' }] }, FICHE).questions.some((q) => q.id === 'liquidateur_en_place'));
const ch22 = nouveau.champs.find((g) => g.op === '22M').champs.map((c) => c.name);
verifier('poursuite d’activité, cessation et publicité demandées', ['poursuite_activite', 'date_cessation_activite', 'journal_publication', 'date_publication'].every((n) => ch22.includes(n)), ch22);
const ch42 = parcours.resoudre(['42M'], {}, FICHE).champs.find((g) => g.op === '42M').champs.map((c) => c.name);
verifier('42M : publicité de la clôture demandée', ['journal_publication', 'date_publication'].every((n) => ch42.includes(n)), ch42);

console.log('\nTUP et fusion : pièces constatées dans la pratique');
const tup = parcours.resoudre(['28M'], {}, FICHE);
verifier('28M : Kbis de l’associé unique proposé', codes(tup.pieces.a_preciser).includes('PJ_188'), tup.pieces);
const fusion = parcours.resoudre(['41M'], {}, FICHE);
verifier('41M : annonce légale exigée', codes(fusion.pieces.obligatoires).includes('PJ_08'));
verifier('41M : Kbis de l’absorbante proposé', codes(fusion.pieces.a_preciser).includes('PJ_20'));

console.log('\nDiffusion commerciale : choix du client, transmis');
const mod = parcours.resoudre(['10M'], {}, FICHE);
const diff = mod.champs.find((g) => g.op === 'commun').champs.find((c) => c.name === 'diffusion_commerciale');
verifier('champ commun, proposé à « Non »', diff && diff.defaut === false && diff.type === 'ouinon', diff);
const dossier = (diffusion) => ({
  operations: ['10M'], siren: '552100554', fiche: FICHE, typologie: {},
  reponses: { commun: { date_decision: '2026-10-01', ...(diffusion === undefined ? {} : { diffusion_commerciale: diffusion }) }, '10M': { nouvelle_denomination: 'NOUVEAU' } },
});
const corpsNon = construireParcours(dossier(false)).corps;
verifier('« Non » transmis au guichet', corpsNon.newFormality.diffusionCommerciale === 'N');
verifier('« Oui » transmis au guichet', construireParcours(dossier(true)).corps.newFormality.diffusionCommerciale === 'O');
verifier('dossier antérieur sans réponse : inchangé (« Oui »)', construireParcours(dossier(undefined)).corps.newFormality.diffusionCommerciale === 'O');
const pub = require('../src/inpi/parcours-creation').champsCreation('01M', { forme_creation: 'SAS' }, {}).find((g) => g.op === 'c_publication');
verifier('création : champ proposé avec l’annonce légale', pub.champs.some((c) => c.name === 'diffusion_commerciale' && c.defaut === false));

console.log(echecs ? `\n${echecs} échec(s).` : '\nTout est vert.');
process.exit(echecs ? 1 : 0);
