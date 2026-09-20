'use strict';

/**
 * Test du module Formalités INPI, sans réseau ni base de données : tout ce qui
 * décide de la qualité d'un dépôt (pré-remplissage, contrôles, payload) est
 * du code pur et se teste tel quel.
 *
 *   node scripts/test-formalites.js
 */

const assert = require('node:assert');

const { sirenValide, normaliserEntreprise, formaterSiren } = require('../src/inpi/normalize');
const { entrepriseSimulee, statutSimule, liasseSimulee } = require('../src/inpi/mock');
const { catalogue, definition, piecesExigees, champsActifs, FORMALITES } = require('../src/inpi/catalogue');
const { controler, echeance } = require('../src/inpi/controles');
const { construirePayload, dateInpi, clotureInpi } = require('../src/inpi/payload');
const { normaliserStatut, formeJuridique } = require('../src/inpi/referentiels');

let ok = 0;
function test(nom, fn) {
  try { fn(); ok += 1; console.log(`  ✓ ${nom}`); } catch (e) {
    console.error(`  ✗ ${nom}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nSIREN');
test('clé de Luhn acceptée', () => assert.ok(sirenValide('552 100 554')));
test('clé de Luhn refusée', () => assert.ok(!sirenValide('552100555')));
test('longueur refusée', () => assert.ok(!sirenValide('5521005')));
test('formatage', () => assert.strictEqual(formaterSiren('552100554'), '552 100 554'));

console.log('\nNormalisation RNE');
const fiche = normaliserEntreprise(entrepriseSimulee('552100554'));
test('dénomination extraite', () => assert.ok(fiche.denomination.length > 3));
test('forme juridique résolue', () => assert.ok(formeJuridique(fiche.forme_juridique_code)));
test('capital numérique', () => assert.strictEqual(typeof fiche.capital, 'number'));
test('adresse reconstituée', () => assert.match(fiche.adresse.texte, /\d{5}/));
test('dirigeant présent', () => assert.ok(fiche.dirigeants[0].nom_complet));
test('JSON vide toléré', () => assert.strictEqual(normaliserEntreprise(null), null));

console.log('\nCatalogue');
test('toutes les formalités sont exposées', () => assert.strictEqual(catalogue().length, Object.keys(FORMALITES).length));
test('chaque formalité a un type et des pièces', () => {
  for (const f of catalogue()) {
    assert.ok(f.typeFormalite, `${f.code} sans typeFormalite`);
    assert.ok(f.pieces.length, `${f.code} sans pièces`);
    assert.ok(f.champs.length, `${f.code} sans champs`);
  }
});
test('pièces conditionnelles : apport en nature', () => {
  const sans = piecesExigees('modification_capital', { modalite: 'numeraire' }).map((p) => p.code);
  const avec = piecesExigees('modification_capital', { modalite: 'nature' }).map((p) => p.code);
  assert.ok(!sans.includes('RAPPORT_CAC'));
  assert.ok(avec.includes('RAPPORT_CAC'));
});
test('champs masqués par dépendance', () => {
  const noms = champsActifs('changement_dirigeant', { nature: 'cessation' }).map((c) => c.name);
  assert.ok(noms.includes('dirigeant_sortant'));
  assert.ok(!noms.includes('dirigeant_entrant'));
});

console.log('\nContrôles');
const dossierIncomplet = {
  type: 'transfert_siege', siren: '552100554', fiche,
  reponses: { date_decision: '2026-09-01' }, pieces: [],
};
test('champ obligatoire manquant → bloquant', () => {
  const c = controler(dossierIncomplet);
  assert.ok(!c.pret);
  assert.ok(c.bloquants.some((m) => /Nouvelle adresse/i.test(m)));
});
test('pièces obligatoires manquantes → bloquant', () => {
  assert.ok(controler(dossierIncomplet).bloquants.some((m) => /Pièce obligatoire/.test(m)));
});
const dossierComplet = {
  type: 'transfert_siege', siren: '552100554', fiche,
  reponses: {
    date_decision: new Date().toISOString().slice(0, 10),
    nouvelle_adresse: { numVoie: '5', typeVoie: 'RUE', voie: 'de Rivoli', codePostal: '75001', commune: 'Paris' },
  },
  pieces: [{ code: 'PV' }, { code: 'STATUTS' }, { code: 'JOUISSANCE' }, { code: 'JAL' }],
};
test('dossier complet → prêt', () => {
  const c = controler(dossierComplet);
  assert.deepStrictEqual(c.bloquants, []);
  assert.ok(c.pret);
});
test('SIREN invalide → bloquant', () => {
  const c = controler({ ...dossierComplet, siren: '552100555' });
  assert.ok(c.bloquants.some((m) => /SIREN invalide/.test(m)));
});
test('capital incohérent → bloquant', () => {
  const c = controler({
    type: 'modification_capital', siren: '552100554', fiche: { ...fiche, capital: 100000 },
    reponses: { date_decision: '2026-09-01', sens: 'augmentation', nouveau_capital: 50000, modalite: 'numeraire' },
    pieces: [{ code: 'PV' }, { code: 'STATUTS' }, { code: 'JAL' }, { code: 'DEPOT_FONDS' }],
  });
  assert.ok(c.bloquants.some((m) => /Augmentation déclarée/.test(m)));
});
test('approbation avant clôture → bloquant', () => {
  const c = controler({
    type: 'depot_comptes', siren: '552100554', fiche,
    reponses: { exercice_clos: '2025-12-31', date_approbation: '2025-06-30', resultat: 1000, affectation: 'report' },
    pieces: [{ code: 'COMPTES' }, { code: 'PV_APPRO' }],
  });
  assert.ok(c.bloquants.some((m) => /approbation/i.test(m)));
});

console.log('\nDélais légaux');
test('échéance à un mois de la décision', () => {
  const e = echeance('transfert_siege', { date_decision: '2026-03-01' });
  assert.strictEqual(e.limite, '2026-03-31');
});
test('délai dépassé détecté', () => {
  const e = echeance('transfert_siege', { date_decision: '2020-01-01' });
  assert.strictEqual(e.etat, 'depasse');
});
test('dépôt des comptes : deux mois', () => {
  const e = echeance('depot_comptes', { date_approbation: '2026-06-30' });
  assert.strictEqual(e.limite, '2026-08-29');
});

console.log('\nPayload INPI');
test('dates converties au format RNE', () => assert.strictEqual(dateInpi('2026-03-12'), '12-03-2026'));
test('clôture convertie', () => assert.strictEqual(clotureInpi('31/12'), '3112'));
test('payload transfert de siège', () => {
  const p = construirePayload({ ...dossierComplet, reference: 'LGZ-2026-00001' });
  assert.strictEqual(p.typeFormalite, 'M');
  assert.strictEqual(p.siren, '552100554');
  assert.strictEqual(p.content.personneMorale.adresseEntreprise.adresse.codePostal, '75001');
  assert.strictEqual(p.referenceMandataire, 'LGZ-2026-00001');
});
test('aucune clé vide dans le payload', () => {
  const p = construirePayload(dossierComplet);
  const vides = JSON.stringify(p).match(/:(null|"")/g);
  assert.strictEqual(vides, null);
});
test('payload construit pour chaque formalité', () => {
  for (const code of Object.keys(FORMALITES)) {
    const p = construirePayload({
      type: code, siren: '552100554', fiche,
      reponses: {
        date_decision: '2026-03-12', date_cessation: '2026-03-12', date_approbation: '2026-06-30',
        date_debut_activite: '2026-04-01', nature: 'dissolution', sens: 'augmentation',
        nouveau_capital: 200000, modalite: 'numeraire', nouvelle_denomination: 'NOUVEAU NOM',
        nouvel_objet: 'objet', denomination: 'NOUVELLE SAS', forme_juridique_code: '5710',
        capital: 10000, duree: 99, date_cloture: '31/12', objet: 'conseil',
        activite_principale: 'conseil', depositaire_fonds: 'Banque',
        exercice_clos: '2025-12-31', resultat: 1000, affectation: 'report',
        adresse_siege: { codePostal: '75001', commune: 'Paris', voie: 'de Rivoli' },
        nouvelle_adresse: { codePostal: '75001', commune: 'Paris', voie: 'de Rivoli' },
        dirigeant: { nom: 'MARTIN', prenoms: ['Paul'], date_naissance: '1980-01-01', fonction: 'Président' },
        dirigeant_entrant: { nom: 'DURAND', prenoms: ['Claire'], date_naissance: '1975-05-05' },
        liquidateur: { nom: 'MARTIN', prenoms: ['Paul'], date_naissance: '1980-01-01' },
      },
      pieces: [],
    });
    assert.ok(p.typeFormalite, `${code} : typeFormalite manquant`);
    assert.ok(p.content && Object.keys(p.content).length, `${code} : contenu vide`);
    assert.strictEqual(definition(code).typeFormalite, p.typeFormalite);
  }
});
test('création : pas de SIREN transmis', () => {
  const p = construirePayload({
    type: 'creation_societe', siren: '', fiche: {},
    reponses: { denomination: 'NOUVELLE SAS', forme_juridique_code: '5710', capital: 10000,
      date_debut_activite: '2026-04-01', adresse_siege: { codePostal: '75001', commune: 'Paris' },
      dirigeant: { nom: 'MARTIN', prenoms: ['Paul'], date_naissance: '1980-01-01', fonction: 'Président' } },
    pieces: [],
  });
  assert.strictEqual(p.siren, undefined);
  assert.strictEqual(p.content.personneMorale.composition.pouvoirs[0].individu.descriptionPersonne.role, '30');
});

console.log('\nGuichet unique (simulation)');
test('statuts normalisés', () => {
  assert.strictEqual(normaliserStatut('EN_COURS_DE_TRAITEMENT'), 'EN_COURS');
  assert.strictEqual(normaliserStatut('validated'), 'VALIDEE');
  assert.strictEqual(normaliserStatut(''), 'DEPOSEE');
});
test('liasse simulée exploitable', () => {
  const id = liasseSimulee();
  assert.match(id, /^DEMO-/);
  assert.ok(['DEPOSEE', 'EN_COURS', 'VALIDEE', 'REGULARISATION'].includes(statutSimule(id).status));
});

console.log(`\n${ok} assertion(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
