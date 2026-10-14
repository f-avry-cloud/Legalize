'use strict';

/**
 * Test de bout en bout du connecteur Claude (MCP), en simulation.
 *
 * Aucun identifiant INPI : le RNE et le Guichet unique sont simulés
 * (src/inpi/mock.js) et rien ne part. Le stockage des pièces est en mémoire.
 * On parle au serveur avec le VRAI client MCP, sur HTTP, comme Claude.
 *
 *   node scripts/test-connecteur.js
 */

process.env.CONNECTEUR_SECRET = 'secret-de-test-0123456789-abcdefghijklmnop';
process.env.CONNECTEUR_STOCKAGE = 'memoire';
for (const v of ['INPI_GU_USERNAME', 'INPI_GU_PASSWORD', 'INPI_RNE_USERNAME', 'INPI_RNE_PASSWORD', 'INPI_DEPOT_REEL', 'CONNECTEUR_URL_PUBLIQUE', 'APP_HOST']) {
  delete process.env[v];
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const app = require('../server');
const stockage = require('../src/connecteur/stockage');

const SIREN = '552100554';
const PDF = fs.readFileSync(path.join(__dirname, 'fixtures', 'piece-test.pdf'));

let echecs = 0;
let total = 0;
async function test(nom, fn) {
  total += 1;
  try { await fn(); console.log(`  ✓ ${nom}`); } catch (e) { echecs += 1; console.log(`  ✗ ${nom}\n    ${e.stack || e.message}`); }
}

function json(resultat) {
  assert.ok(!resultat.isError, `outil en erreur : ${resultat.content?.[0]?.text}`);
  return JSON.parse(resultat.content[0].text);
}

const REPONSES_DIRIGEANT = {
  date_decision: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
  nature: 'remplacement',
  dirigeant_sortant: 'Jean MARTIN',
  fonction: 'Président',
  dirigeant_entrant: {
    nom: 'DURAND', prenoms: ['Claire', 'Anne'], genre: '2', date_naissance: '1980-04-12',
    lieu_naissance: 'Lyon', code_insee_naissance: '69123', nationalite: 'Française', forme_sociale: '1',
    adresse: { numVoie: '8', typeVoie: 'AV', voie: 'Victor Hugo', codePostal: '69002', commune: 'Lyon' },
    nom_complet: 'Claire DURAND',
  },
};

(async () => {
  const serveur = app.listen(0);
  await new Promise((r) => serveur.once('listening', r));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  const url = new URL(`${base}/api/mcp/${process.env.CONNECTEUR_SECRET}`);

  console.log('\nAccès');
  await test('mauvais secret : 404', async () => {
    const r = await fetch(`${base}/api/mcp/mauvais-secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 404);
  });
  await test('GET sur l’URL MCP : 405', async () => {
    const r = await fetch(url, { method: 'GET' });
    assert.strictEqual(r.status, 405);
  });
  await test('le reste de l’API exige toujours une session', async () => {
    const r = await fetch(`${base}/api/formalites`);
    assert.ok([401, 403].includes(r.status), `statut ${r.status}`);
  });

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));

  console.log('\nProtocole');
  await test('instructions et outils publiés, sans signature ni paiement', async () => {
    assert.match(client.getInstructions() || '', /Guichet unique/);
    const { tools } = await client.listTools();
    const noms = tools.map((t) => t.name).sort();
    assert.deepStrictEqual(noms, [
      'controler_formalite', 'enregistrer_formalite', 'exigences_formalite', 'fiche_entreprise',
      'lister_formalites', 'lister_types_formalites', 'ouvrir_depot_pieces', 'pieces_recues',
      'rechercher_entreprise', 'statut_formalite',
    ]);
    assert.ok(!noms.some((n) => /sign|pay|paie|supprim/.test(n)));
  });

  console.log('\nPréparation');
  await test('types de formalités', async () => {
    const d = json(await client.callTool({ name: 'lister_types_formalites', arguments: {} }));
    assert.ok(d.formalites.some((f) => f.type === 'changement_dirigeant' && f.evenement === '35M'));
  });
  await test('exigences d’un changement de dirigeant', async () => {
    const d = json(await client.callTool({ name: 'exigences_formalite', arguments: { type: 'changement_dirigeant', reponses: { nature: 'remplacement', demission: true } } }));
    assert.ok(d.champs.some((c) => c.nom === 'dirigeant_entrant'));
    const codes = d.pieces.map((p) => p.code);
    for (const c of ['PJ_54', 'PJ_11', 'PJ_63', 'PJ_64', 'PJ_230']) assert.ok(codes.includes(c), c);
    assert.ok(d.formats.personne.genre);
  });
  await test('type inconnu refusé par le schéma', async () => {
    const r = await client.callTool({ name: 'exigences_formalite', arguments: { type: 'inconnue' } });
    assert.ok(r.isError);
  });
  await test('fiche RNE (simulée)', async () => {
    const d = json(await client.callTool({ name: 'fiche_entreprise', arguments: { siren: SIREN } }));
    assert.ok(d.simule);
    assert.ok(d.fiche.denomination);
    assert.strictEqual(d.fiche.brut, undefined);
  });
  await test('SIREN invalide : erreur lisible', async () => {
    const r = await client.callTool({ name: 'fiche_entreprise', arguments: { siren: '552100555' } });
    assert.ok(r.isError);
    assert.match(r.content[0].text, /SIREN invalide/);
  });

  let reference;
  let lien;
  console.log('\nPièces');
  await test('contrôle sans pièces : bloquants sur les pièces', async () => {
    const d = json(await client.callTool({ name: 'controler_formalite', arguments: { type: 'changement_dirigeant', siren: SIREN, reponses: REPONSES_DIRIGEANT } }));
    assert.strictEqual(d.controles.pret, false);
    assert.ok(d.controles.pieces_manquantes.some((p) => /PJ_54/.test(p)));
    assert.ok(d.mode.simulation);
  });
  await test('lien de dépôt des pièces', async () => {
    const d = json(await client.callTool({ name: 'ouvrir_depot_pieces', arguments: { type: 'changement_dirigeant', reponses: REPONSES_DIRIGEANT, denomination: 'HORIZON' } }));
    reference = d.reference;
    lien = d.lien;
    assert.match(reference, /^GU-[A-Z2-9]{8}$/);
    assert.ok(lien.startsWith(`${base}/api/connecteur/pieces?j=`));
  });
  await test('enregistrement refusé tant que des pièces manquent', async () => {
    const d = json(await client.callTool({ name: 'enregistrer_formalite', arguments: { type: 'changement_dirigeant', siren: SIREN, reponses: REPONSES_DIRIGEANT, reference, confirmation_avocat: true } }));
    assert.strictEqual(d.enregistre, false);
  });

  const j = () => new URL(lien).searchParams.get('j');
  await test('page de dépôt servie, lien altéré refusé', async () => {
    const ok = await fetch(lien);
    assert.strictEqual(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /PV ayant décidé/);
    assert.match(html, new RegExp(reference));
    const altere = await fetch(`${lien.slice(0, -3)}xyz`);
    assert.strictEqual(altere.status, 403);
  });

  async function deposer(code, nom, contenu = PDF) {
    const r = await fetch(`${base}/api/connecteur/pieces/url`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ j: j(), code, nom, taille: contenu.length }),
    });
    const d = await r.json();
    assert.ok(r.ok, d.error);
    assert.strictEqual(d.mode, 'memoire');
    const f = await fetch(`${base}/api/connecteur/pieces/fichier?j=${encodeURIComponent(j())}&chemin=${encodeURIComponent(d.chemin)}`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: contenu,
    });
    assert.ok(f.ok);
    return d.chemin;
  }

  await test('pièce non attendue ou non PDF refusée', async () => {
    const r1 = await fetch(`${base}/api/connecteur/pieces/url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ j: j(), code: 'PJ_999', nom: 'x.pdf', taille: 10 }) });
    assert.strictEqual(r1.status, 400);
    const r2 = await fetch(`${base}/api/connecteur/pieces/url`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ j: j(), code: 'PJ_54', nom: 'x.docx', taille: 10 }) });
    assert.strictEqual(r2.status, 400);
  });
  await test('chemin hors dossier refusé', async () => {
    const r = await fetch(`${base}/api/connecteur/pieces/supprimer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ j: j(), chemin: 'GU-AAAAAAAA/PJ_54__1__x.pdf' }) });
    assert.strictEqual(r.status, 400);
  });

  let cheminRetire;
  await test('dépôt des pièces, liste, retrait', async () => {
    await deposer('PJ_54', 'PV AGE 2026.pdf');
    await deposer('PJ_11', 'CNI Claire Durand.pdf');
    await deposer('PJ_63', 'Non-condamnation.pdf');
    await deposer('PJ_64', 'Filiation.pdf');
    cheminRetire = await deposer('PJ_08', 'Attestation JAL.pdf');
    const r = await fetch(`${base}/api/connecteur/pieces/supprimer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ j: j(), chemin: cheminRetire }) });
    assert.ok(r.ok);
    const d = json(await client.callTool({ name: 'pieces_recues', arguments: { reference } }));
    assert.deepStrictEqual(d.pieces.map((p) => p.code).sort(), ['PJ_11', 'PJ_54', 'PJ_63', 'PJ_64']);
    assert.ok(d.pieces.some((p) => p.fichier === 'PV_AGE_2026.pdf'));
  });

  console.log('\nContrôle et enregistrement');
  await test('contrôle complet : prêt', async () => {
    const d = json(await client.callTool({ name: 'controler_formalite', arguments: { type: 'changement_dirigeant', siren: SIREN, reponses: REPONSES_DIRIGEANT, reference } }));
    assert.deepStrictEqual(d.controles.bloquants, [], JSON.stringify(d.controles.bloquants));
    assert.strictEqual(d.controles.pret, true);
    assert.strictEqual(d.pieces_recues.length, 4);
    assert.ok(d.apercu.some((a) => a.valeur === 'Claire DURAND'));
    assert.ok(d.controles.echeance && d.controles.echeance.etat === 'ok');
  });
  await test('sans confirmation de l’avocat : refusé', async () => {
    const r = await client.callTool({ name: 'enregistrer_formalite', arguments: { type: 'changement_dirigeant', siren: SIREN, reponses: REPONSES_DIRIGEANT, reference, confirmation_avocat: false } });
    assert.ok(r.isError);
  });
  await test('fichier corrompu : enregistrement refusé', async () => {
    const chemin = await deposer('PJ_08', 'Attestation JAL.pdf', Buffer.from('ceci n’est pas un PDF'.repeat(10)));
    const d = json(await client.callTool({ name: 'enregistrer_formalite', arguments: { type: 'changement_dirigeant', siren: SIREN, reponses: REPONSES_DIRIGEANT, reference, confirmation_avocat: true } }));
    assert.strictEqual(d.enregistre, false);
    assert.match(d.motif, /PDF lisible/);
    await stockage.supprimer([chemin]);
  });

  let inpiId;
  await test('enregistrement (simulé) : liasse, statut, action attendue', async () => {
    const d = json(await client.callTool({ name: 'enregistrer_formalite', arguments: { type: 'changement_dirigeant', siren: SIREN, reponses: REPONSES_DIRIGEANT, reference, confirmation_avocat: true } }));
    assert.strictEqual(d.enregistre, true);
    assert.strictEqual(d.simule, true);
    assert.ok(d.motif_simulation);
    assert.ok(d.inpi_id && d.numero_liasse);
    assert.strictEqual(d.pieces_transmises.length, 4);
    assert.strictEqual(d.pieces_effacees_du_stockage, false, 'en simulation, les pièces sont conservées');
    assert.ok(d.portail_signature);
    inpiId = d.inpi_id;
  });

  await test('mode réel : un dossier déjà enregistré n’est pas renvoyé', async () => {
    const guichet = require('../src/inpi/guichet');
    const origine = { simulationActive: guichet.simulationActive, lister: guichet.lister, deposer: guichet.deposer };
    let deposeAppele = false;
    guichet.simulationActive = () => false;
    guichet.lister = async () => [{ inpi_id: '777', numero_liasse: 'L-777', statut: 'SIGNATURE_PENDING', action_attendue: 'signer', reference_mandataire: reference, regularisations: [] }];
    guichet.deposer = async () => { deposeAppele = true; return {}; };
    try {
      const d = json(await client.callTool({ name: 'enregistrer_formalite', arguments: { type: 'changement_dirigeant', siren: SIREN, reponses: REPONSES_DIRIGEANT, reference, confirmation_avocat: true } }));
      assert.strictEqual(d.enregistre, false);
      assert.match(d.motif, /déjà été enregistré/);
      assert.strictEqual(deposeAppele, false);
    } finally {
      Object.assign(guichet, origine);
    }
  });

  console.log('\nSuivi');
  await test('statut de la formalité', async () => {
    const d = json(await client.callTool({ name: 'statut_formalite', arguments: { inpi_id: inpiId } }));
    assert.ok(d.statut);
    assert.ok('action_attendue' in d);
  });
  await test('liste du compte (vide en simulation)', async () => {
    const d = json(await client.callTool({ name: 'lister_formalites', arguments: {} }));
    assert.strictEqual(d.nombre, 0);
    assert.ok(d.statuts_possibles.AMENDMENT_PENDING);
  });

  console.log('\nCréation (sans SIREN)');
  await test('création : contrôle sans SIREN, bloquants explicites', async () => {
    const d = json(await client.callTool({ name: 'controler_formalite', arguments: { type: 'creation_societe', reponses: { denomination: 'NOVA', capital: 0 } } }));
    assert.strictEqual(d.controles.pret, false);
    assert.ok(d.controles.bloquants.some((b) => /capital/i.test(b)));
  });

  await client.close();

  console.log('\nConnecteur fermé sans secret');
  await test('sans CONNECTEUR_SECRET : 404 et liens invalides', async () => {
    const s = process.env.CONNECTEUR_SECRET;
    delete process.env.CONNECTEUR_SECRET;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 404);
    const p = await fetch(lien);
    assert.strictEqual(p.status, 403);
    process.env.CONNECTEUR_SECRET = s;
  });

  serveur.close();
  console.log(`\n${total - echecs}/${total} tests réussis`);
  process.exit(echecs ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
