'use strict';

/**
 * Test de l'outil en ligne de commande des formalités (scripts/gu.js), en
 * simulation : aucun identifiant INPI, rien ne part.
 *
 *   node scripts/test-gu.js
 */

for (const v of ['INPI_GU_USERNAME', 'INPI_GU_PASSWORD', 'INPI_RNE_USERNAME', 'INPI_RNE_PASSWORD', 'INPI_DEPOT_REEL']) delete process.env[v];

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const d = require('../src/gu/dossiers');
const guichet = require('../src/inpi/guichet');

const GU = path.join(__dirname, 'gu.js');
const PDF = path.join(__dirname, 'fixtures', 'piece-test.pdf');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-'));

let echecs = 0;
let total = 0;
async function test(nom, fn) {
  total += 1;
  try { await fn(); console.log(`  ✓ ${nom}`); } catch (e) { echecs += 1; console.log(`  ✗ ${nom}\n    ${e.stack || e.message}`); }
}

const cli = (...args) => JSON.parse(execFileSync('node', [GU, ...args], { cwd: TMP, encoding: 'utf8' }));
const cliBrut = (...args) => spawnSync('node', [GU, ...args], { cwd: TMP, encoding: 'utf8' });

function remplir(fichier, modif) {
  const dossier = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  modif(dossier);
  fs.writeFileSync(fichier, JSON.stringify(dossier, null, 2));
}

const REPONSES = {
  date_decision: new Date(Date.now() - 4 * 86400000).toISOString().slice(0, 10),
  nature: 'remplacement', dirigeant_sortant: 'Jean MARTIN', fonction: 'Président',
  dirigeant_entrant: {
    nom: 'DURAND', prenoms: ['Claire'], genre: '2', date_naissance: '1980-04-12', lieu_naissance: 'Lyon',
    code_insee_naissance: '69123', nationalite: 'Française', forme_sociale: '1', nom_complet: 'Claire DURAND',
    adresse: { numVoie: '8', typeVoie: 'AV', voie: 'Victor Hugo', codePostal: '69002', commune: 'Lyon' },
  },
};

(async () => {
  console.log('\nCommandes de base');
  await test('types et état (simulation signalée)', () => {
    assert.ok(cli('types').formalites.some((f) => f.type === 'transfert_siege'));
    assert.strictEqual(cli('etat').mode.simulation, true);
  });
  await test('commande inconnue : code 2', () => {
    assert.strictEqual(cliBrut('inconnue').status, 2);
  });

  let fichier;
  let reference;
  console.log('\nDossier');
  await test('nouveau dossier : répertoire, fiche RNE, inscription au registre', () => {
    const r = cli('nouveau', 'changement_dirigeant', '--siren', '552100554', '--registre', 'registre.json');
    fichier = r.dossier;
    reference = r.reference;
    assert.ok(fs.existsSync(fichier));
    assert.ok(fs.existsSync(path.join(path.dirname(fichier), 'pieces')));
    assert.ok(r.fiche_rne.denomination);
    assert.strictEqual(r.fiche_rne.brut, undefined);
    const reg = JSON.parse(fs.readFileSync(path.join(TMP, 'registre.json'), 'utf8'));
    assert.strictEqual(reg[0].statut, 'PREPARATION');
  });
  await test('modification sans SIREN refusée', () => {
    const r = cliBrut('nouveau', 'transfert_siege');
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /SIREN requis/);
  });
  await test('contrôle d’un dossier vide : bloquants', () => {
    const r = cli('controler', fichier);
    assert.strictEqual(r.controles.pret, false);
    assert.ok(r.controles.pieces_manquantes.length);
  });
  await test('exigences recalculées selon les réponses du dossier', () => {
    remplir(fichier, (x) => { x.reponses = { ...REPONSES, demission: true }; });
    const r = cli('exigences', fichier);
    assert.ok(r.pieces.some((p) => p.code === 'PJ_230'));
    remplir(fichier, (x) => { x.reponses = REPONSES; });
  });

  const dir = () => path.dirname(fichier);
  await test('PDF illisible : bloquant', () => {
    fs.writeFileSync(path.join(dir(), 'pieces', 'faux.pdf'), 'pas un pdf');
    remplir(fichier, (x) => { x.pieces = [{ code: 'PJ_54', fichier: 'pieces/faux.pdf' }]; });
    const r = cli('controler', fichier);
    assert.ok(r.controles.bloquants.some((b) => /PDF lisible/.test(b)));
  });
  await test('pièce introuvable : erreur claire', () => {
    remplir(fichier, (x) => { x.pieces = [{ code: 'PJ_54', fichier: 'pieces/absent.pdf' }]; });
    const r = cliBrut('controler', fichier);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /introuvable/);
  });
  await test('dossier complet : prêt, échéance calculée', () => {
    for (const n of ['PV', 'CNI', 'NC', 'FIL']) fs.copyFileSync(PDF, path.join(dir(), 'pieces', `${n}.pdf`));
    remplir(fichier, (x) => {
      x.pieces = [
        { code: 'PJ_54', fichier: 'pieces/PV.pdf' }, { code: 'PJ_11', fichier: 'pieces/CNI.pdf' },
        { code: 'PJ_63', fichier: 'pieces/NC.pdf' }, { code: 'PJ_64', fichier: 'pieces/FIL.pdf' },
      ];
    });
    const r = cli('controler', fichier);
    assert.deepStrictEqual(r.controles.bloquants, []);
    assert.strictEqual(r.controles.pret, true);
    assert.ok(r.controles.echeance.limite);
    assert.ok(r.apercu.some((a) => a.valeur === 'Claire DURAND'));
  });

  console.log('\nEnregistrement');
  await test('sans --confirme : refusé', () => {
    const r = cliBrut('enregistrer', fichier);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /--confirme/);
  });
  await test('avec --confirme : enregistré (simulé), dossier et registre mis à jour', () => {
    const r = cli('enregistrer', fichier, '--confirme', '--registre', 'registre.json');
    assert.strictEqual(r.enregistre, true);
    assert.strictEqual(r.simule, true);
    assert.strictEqual(r.pieces_transmises.length, 4);
    const dossier = JSON.parse(fs.readFileSync(fichier, 'utf8'));
    assert.ok(dossier.inpi.inpi_id);
    const reg = JSON.parse(fs.readFileSync(path.join(TMP, 'registre.json'), 'utf8'));
    assert.strictEqual(reg.length, 1, 'une entrée par dossier');
    assert.strictEqual(reg[0].inpi_id, dossier.inpi.inpi_id);
  });
  await test('mode réel : un dossier déjà déposé n’est pas renvoyé', async () => {
    const origine = { simulationActive: guichet.simulationActive, lister: guichet.lister, deposer: guichet.deposer };
    let appele = false;
    guichet.simulationActive = () => false;
    guichet.lister = async () => [{ inpi_id: '42', numero_liasse: 'L42', statut: 'SIGNATURE_PENDING', reference_mandataire: reference }];
    guichet.deposer = async () => { appele = true; return {}; };
    try {
      const r = await d.enregistrerDossier(fichier, { confirme: true });
      assert.strictEqual(r.enregistre, false);
      assert.match(r.motif, /Déjà enregistré/);
      assert.strictEqual(appele, false);
    } finally {
      Object.assign(guichet, origine);
    }
  });

  console.log('\nSuivi quotidien');
  await test('suivi : à faire / en cours / en préparation, e-mail et Excel', async () => {
    const registre = path.join(TMP, 'registre-suivi.json');
    const base = { siren: '552100554', type: 'changement_dirigeant', formalite: 'Changement de dirigeant', regularisations: [] };
    const bientot = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    fs.writeFileSync(registre, JSON.stringify([
      { ...base, reference: 'GU-AAAAAAAA', societe: 'ALPHA', inpi_id: '101', statut: 'RECEIVED' },
      { ...base, reference: 'GU-BBBBBBBB', societe: 'BETA', inpi_id: '102', statut: 'RECEIVED' },
      { ...base, reference: 'GU-CCCCCCCC', societe: 'GAMMA', inpi_id: '103', statut: 'RECEIVED' },
      { ...base, reference: 'GU-DDDDDDDD', societe: 'DELTA', inpi_id: null, statut: 'PREPARATION', statut_libelle: 'En préparation', echeance: bientot },
      { ...base, reference: 'GU-EEEEEEEE', societe: 'EPSILON', inpi_id: '105', statut: 'VALIDATED', statut_libelle: 'Validée' },
    ]));
    const reponses = {
      101: { statut: 'SIGNATURE_PENDING', action_attendue: 'signer', regularisations: [] },
      102: { statut: 'AMENDMENT_PENDING', action_attendue: 'regulariser', regularisations: [{ motif: 'Adresse du siège à corriger', echeance: bientot }] },
      103: { statut: 'VALIDATION_PENDING', action_attendue: 'attendre', regularisations: [] },
    };
    const origine = guichet.lire;
    const lus = [];
    guichet.lire = async (id) => { lus.push(id); return { inpi_id: id, numero_liasse: `L${id}`, statut_date: null, montant: 195.71, ...reponses[id] }; };
    try {
      const r = await d.suivi(registre, { sortie: path.join(TMP, 'suivi') });
      assert.deepStrictEqual(lus.sort(), ['101', '102', '103'], 'ni les dossiers en préparation ni les terminés ne sont interrogés');
      assert.strictEqual(r.a_faire, 2);
      assert.strictEqual(r.en_cours, 1);
      assert.strictEqual(r.en_preparation, 1);
      assert.strictEqual(r.termines, 1);
      assert.match(r.objet_email, /2 actions à faire/);
      assert.match(r.objet_email, /échéance/);
      const html = fs.readFileSync(r.fichiers.email_html, 'utf8');
      assert.match(html, /À faire par toi \(2\)/);
      assert.match(html, /Adresse du siège à corriger/);
      const classeur = new ExcelJS.Workbook();
      await classeur.xlsx.readFile(r.fichiers.excel);
      const feuille = classeur.getWorksheet('Formalités');
      assert.strictEqual(feuille.rowCount, 6);
      assert.strictEqual(feuille.getRow(1).getCell(1).value, 'Société');
      const maj = JSON.parse(fs.readFileSync(registre, 'utf8'));
      assert.strictEqual(maj.find((e) => e.inpi_id === '102').regularisations.length, 1);
    } finally {
      guichet.lire = origine;
    }
  });

  console.log('\nConfidentialité');
  await test('les dossiers et registres ne peuvent pas être versionnés', () => {
    const racine = path.join(__dirname, '..');
    const ignores = (p) => spawnSync('git', ['check-ignore', '-q', p], { cwd: racine }).status === 0;
    for (const p of ['dossiers/GU-X/dossier.json', 'dossiers/GU-X/pieces/PV.pdf', 'registre.json', 'suivi/suivi-formalites.html', 'Suivi des formalités.xlsx']) {
      assert.ok(ignores(p), `${p} devrait être ignoré par git`);
    }
    assert.ok(!ignores('scripts/fixtures/piece-test.pdf'), 'la pièce de test reste versionnée');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${total - echecs}/${total} tests réussis`);
  process.exit(echecs ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
