'use strict';

/**
 * Le catalogue des formalités ne doit rien inventer : chaque événement,
 * chaque code de pièce, chaque référence au dictionnaire doit exister dans
 * les référentiels INPI. Une coquille ici, c'est une pièce que l'utilisateur
 * chercherait en vain, ou un champ qui n'existe pas dans le dossier.
 */

const assert = require('node:assert');
const catalogue = require('../src/inpi/catalogue-evenements');
const EVENEMENTS = require('../src/inpi/data/evenements.json').valeurs;
const PIECES = require('../src/inpi/data/pieces-justificatives.json').valeurs;
const { DICTIONNAIRE } = require('../src/inpi/referentiels');

let ok = 0;
function test(nom, fn) {
  try { fn(); ok += 1; console.log('  ✓', nom); }
  catch (e) { console.log('  ✗', nom, '\n   ', e.message); process.exitCode = 1; }
}

const toutes = catalogue.catalogueComplet();

console.log('\nCatalogue des formalités');

test('les 107 événements INPI sont tous listés', () => {
  assert.strictEqual(toutes.length, Object.keys(EVENEMENTS).length);
  for (const code of Object.keys(EVENEMENTS)) assert.ok(catalogue.fiche(code), `${code} absent`);
});

test('aucune fiche détaillée pour un événement inexistant', () => {
  const inconnus = Object.keys(catalogue.DETAIL).filter((c) => !EVENEMENTS[c]);
  assert.deepStrictEqual(inconnus, []);
});

test('chaque code de pièce existe dans le catalogue INPI', () => {
  const inconnues = [];
  for (const f of toutes) {
    for (const p of [...f.pieces_obligatoires, ...f.pieces_selon_le_cas]) {
      if (!PIECES[p.code]) inconnues.push(`${f.code} : ${p.code}`);
    }
  }
  for (const p of [...catalogue.piecesCommunes(), ...catalogue.piecesGenerees()]) {
    if (!PIECES[p.code]) inconnues.push(`commune : ${p.code}`);
  }
  assert.deepStrictEqual(inconnues, []);
});

test('chaque pièce porte le libellé officiel, pas son code', () => {
  for (const f of toutes) {
    for (const p of [...f.pieces_obligatoires, ...f.pieces_selon_le_cas]) {
      assert.notStrictEqual(p.libelle, p.code, `${f.code} : ${p.code} sans libellé`);
    }
  }
});

test('chaque référence pointe vers une propriété réelle du dictionnaire', () => {
  const fausses = [];
  for (const f of toutes) {
    for (const i of f.informations) {
      if (!i.ref) continue;
      const [classe, prop] = i.ref.split('.');
      if (!DICTIONNAIRE[classe]?.proprietes?.[prop]) fausses.push(`${f.code} : ${i.ref}`);
    }
  }
  assert.deepStrictEqual(fausses, []);
});

test('aucune pièce n’apparaît deux fois dans une même fiche', () => {
  for (const f of toutes) {
    const codes = [...f.pieces_obligatoires, ...f.pieces_selon_le_cas].map((p) => `${p.code}|${p.condition}`);
    assert.strictEqual(new Set(codes).size, codes.length, `${f.code} : doublon`);
  }
});

test('toute fiche détaillée dit quand elle s’applique et quoi transmettre', () => {
  for (const f of toutes.filter((x) => x.detaillee)) {
    assert.ok(f.quand, `${f.code} sans « quand »`);
    assert.ok(f.informations.length, `${f.code} sans information à transmettre`);
  }
});

test('les formalités sans pièce le disent explicitement', () => {
  for (const f of toutes.filter((x) => x.detaillee)) {
    const aucune = !f.pieces_obligatoires.length && !f.pieces_selon_le_cas.length;
    if (aucune) assert.ok(f.note, `${f.code} : aucune pièce et aucune explication`);
  }
});

test('les événements courants du droit des sociétés sont détaillés', () => {
  for (const code of ['01M', '10M', '11M', '12M', '13M', '15M', '16M', '22M', '35M', '38F', '42M', '54PMF', '80PMF']) {
    assert.ok(catalogue.fiche(code).detaillee, `${code} non détaillé`);
  }
});

console.log(`\n${ok} assertion(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
