'use strict';

/**
 * Tests du registre des mouvements de titres.
 *
 * Portent sur les règles pures — celles qui décident si un registre est
 * certifiable — sans toucher à la base : ce sont elles qui doivent rester
 * justes quoi qu'il arrive au stockage.
 */

const assert = require('node:assert');
const controles = require('../src/services/rmt-controles');
const certification = require('../src/services/rmt-certification');

let ok = 0;
function test(nom, fn) {
  try { fn(); ok += 1; console.log('  ✓', nom); }
  catch (e) { console.log('  ✗', nom, '\n   ', e.message); process.exitCode = 1; }
}

/** Fabrique une écriture minimale. */
const ecriture = (n, champs = {}) => ({
  numero_affiche: n, mouvement_id: n, id: n * 100,
  supprimee: false, statut: 'CRAYON', nature: 'souscription', nature_libelle: 'Souscription',
  quantite: 0, numeros: null, compte_credite: null, compte_debite: null,
  date_effet: '2026-01-01', date_inscription: '2026-01-01', ...champs,
});

console.log('\nNuméros de titres');

test('une cession ne recrée pas les numéros qu’elle transfère', () => {
  const a = controles.numerosIncoherents([
    ecriture(1, { numeros: '{[1,5000]}', compte_credite: 1 }),
    ecriture(2, { numeros: '{[1,1200]}', compte_credite: 2, compte_debite: 1, nature: 'cession' }),
  ], 5000);
  assert.deepStrictEqual(a, [], 'une cession ne doit produire aucune anomalie de numéro');
});

test('deux attributions qui se chevauchent donnent UNE anomalie, pas mille', () => {
  const a = controles.numerosIncoherents([
    ecriture(1, { numeros: '{[1,5000]}', compte_credite: 1 }),
    ecriture(2, { numeros: '{[4000,6000]}', compte_credite: 2 }),
  ], 6000);
  assert.strictEqual(a.length, 1);
  assert.match(a[0].message, /4000 à 5000 attribués deux fois/);
});

test('transférer des numéros jamais attribués est signalé', () => {
  const a = controles.numerosIncoherents([
    ecriture(1, { numeros: '{[1,100]}', compte_credite: 1 }),
    ecriture(2, { numeros: '{[500,600]}', compte_credite: 2, compte_debite: 1, nature: 'cession' }),
  ], 1000);
  assert.strictEqual(a.length, 1);
  assert.match(a[0].message, /aucune écriture antérieure ne les a attribués/);
});

test('un numéro au-delà des titres émis est signalé', () => {
  const a = controles.numerosIncoherents([ecriture(1, { numeros: '{[1,12000]}', compte_credite: 1 })], 10000);
  assert.ok(a.some((x) => /dépassent les 10000 titres émis/.test(x.message)));
});

test('couverture par intervalles contigus', () => {
  assert.strictEqual(controles.couvert([1, 200], [[1, 100], [101, 300]]), true);
  assert.strictEqual(controles.couvert([1, 200], [[1, 100], [150, 300]]), false);
});

console.log('\nSoldes');

test('un solde négatif est détecté même si le solde final est positif', () => {
  const comptes = [{ id: 1, numero: 'A-001', titulaires: [] }, { id: 2, numero: 'A-002', titulaires: [] }];
  const a = controles.soldesNegatifs([
    ecriture(1, { date_effet: '2026-01-01', quantite: 100, compte_credite: 1, categorie_id: 1 }),
    ecriture(2, { date_effet: '2026-03-01', quantite: 300, compte_debite: 1, compte_credite: 2, categorie_id: 1, nature: 'cession' }),
    ecriture(3, { date_effet: '2026-06-01', quantite: 500, compte_credite: 1, categorie_id: 1 }),
  ], comptes);
  assert.strictEqual(a.length, 1, 'le creux de mars doit être vu');
  assert.match(a[0].message, /Solde négatif de -200/);
  assert.strictEqual(a[0].date, '2026-03-01');
});

test('un registre équilibré ne produit aucun solde négatif', () => {
  const comptes = [{ id: 1, numero: 'A-001', titulaires: [] }, { id: 2, numero: 'A-002', titulaires: [] }];
  const a = controles.soldesNegatifs([
    ecriture(1, { quantite: 1000, compte_credite: 1, categorie_id: 1 }),
    ecriture(2, { date_effet: '2026-02-01', quantite: 400, compte_debite: 1, compte_credite: 2, categorie_id: 1 }),
  ], comptes);
  assert.deepStrictEqual(a, []);
});

console.log('\nInvariant du capital');

test('l’écart entre titres émis et titres détenus est signalé', () => {
  const a = controles.invariantCategories(
    [{ categorie_id: 1, code: 'ORD', emis: 10000 }],
    [{ categorie_id: 1, solde: 9000 }],
    [{ id: 1, libelle: 'Actions ordinaires' }],
  );
  assert.strictEqual(a.length, 1);
  assert.match(a[0].message, /10000 titre\(s\) émis pour 9000 détenu\(s\)/);
  assert.strictEqual(a[0].ecart, 1000);
});

test('un registre équilibré ne rompt pas l’invariant', () => {
  const a = controles.invariantCategories(
    [{ categorie_id: 1, code: 'ORD', emis: 10000 }],
    [{ categorie_id: 1, solde: 6000 }, { categorie_id: 1, solde: 4000 }],
    [{ id: 1, libelle: 'Actions ordinaires' }],
  );
  assert.deepStrictEqual(a, []);
});

console.log('\nJustificatifs');

test('le justificatif exigé par la nature de l’écriture est réclamé', () => {
  const a = controles.justificatifsManquants([ecriture(1, { nature: 'cession', nature_libelle: 'Cession' })], []);
  assert.strictEqual(a.length, 1);
  assert.match(a[0].message, /ordre mouvement/);
});

test('le justificatif présent lève l’anomalie', () => {
  const a = controles.justificatifsManquants(
    [ecriture(1, { nature: 'cession' })],
    [{ mouvement_id: 1, type: 'ordre_mouvement' }],
  );
  assert.deepStrictEqual(a, []);
});

console.log('\nEmpreinte d’un extrait certifié');

test('deux fois le même état donnent la même empreinte', () => {
  const etat = { b: 2, a: [1, { y: 2, x: 1 }] };
  const memeEtat = { a: [1, { x: 1, y: 2 }], b: 2 };
  assert.strictEqual(certification.empreinteDe(etat), certification.empreinteDe(memeEtat),
    'l’ordre des clés ne doit pas changer l’empreinte');
});

test('un état différent donne une empreinte différente', () => {
  assert.notStrictEqual(
    certification.empreinteDe({ quantite: 100 }),
    certification.empreinteDe({ quantite: 101 }),
  );
});

console.log(`\n${ok} assertion(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
