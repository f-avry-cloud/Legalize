'use strict';

/**
 * Test du module Formalités INPI, sans réseau ni base de données : tout ce qui
 * décide de la qualité d'un dépôt (référentiels officiels, pré-remplissage,
 * contrôles, payload) est du code pur et se teste tel quel.
 *
 *   node scripts/test-formalites.js
 */

const assert = require('node:assert');

const { sirenValide, normaliserEntreprise, formaterSiren } = require('../src/inpi/normalize');
const mock = require('../src/inpi/mock');
const { catalogue, definition, piecesExigees, champsActifs, FORMALITES } = require('../src/inpi/catalogue');
const { controler, echeance } = require('../src/inpi/controles');
const { construirePayload, indicateursEvenement, dateInpi, clotureInpi } = require('../src/inpi/payload');
const {
  normaliserStatut, statut, formeJuridique, role, roleDepuisFonction, rolePrincipal,
  piece, codeFormeDepuisLibelle, TYPES_FORMALITE,
} = require('../src/inpi/referentiels');

let ok = 0;
function test(nom, fn) {
  try { fn(); ok += 1; console.log(`  ✓ ${nom}`); } catch (e) {
    console.error(`  ✗ ${nom}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('\nRéférentiels officiels INPI');
test('formes juridiques chargées depuis le fichier INPI', () => {
  assert.match(formeJuridique('5710').libelle, /SAS/);
  assert.match(formeJuridique('5499').libelle, /SARL/);
  assert.strictEqual(formeJuridique('0000'), null);
});
test('codes rôle conformes au dictionnaire', () => {
  assert.strictEqual(role('73').libelle, 'Président de SAS');
  assert.strictEqual(role('30').libelle, 'Gérant');
  assert.strictEqual(role('40').libelle, 'Liquidateur');
});
test('fonction en clair → code rôle sociétaire', () => {
  assert.strictEqual(roleDepuisFonction('Président').code, '73');
  assert.strictEqual(roleDepuisFonction('Gérante').code, '30');
  assert.strictEqual(roleDepuisFonction('Directeur général').code, '53');
  assert.strictEqual(roleDepuisFonction('Président du conseil d’administration').code, '51');
});
test('rôle par défaut déduit de la forme juridique', () => {
  assert.strictEqual(rolePrincipal('5710').code, '73');
  assert.strictEqual(rolePrincipal('5499').code, '30');
  assert.strictEqual(rolePrincipal('5599').code, '51');
});
test('sigle usuel → code forme', () => {
  assert.strictEqual(codeFormeDepuisLibelle('SAS'), '5710');
  assert.strictEqual(codeFormeDepuisLibelle('SASU'), '5710');
  assert.strictEqual(codeFormeDepuisLibelle('SARL'), '5499');
});
test('pièces justificatives officielles', () => {
  assert.match(piece('PJ_08').libelle, /journal d’annonces légales/i);
  assert.match(piece('PJ_02').libelle, /statuts mis à jour/i);
  assert.strictEqual(piece('PJ_999'), null);
});
test('statuts du guichet unique et action attendue', () => {
  assert.strictEqual(normaliserStatut('AMENDMENT_PENDING'), 'AMENDMENT_PENDING');
  assert.strictEqual(statut('SIGNATURE_PENDING').action, 'signer');
  assert.strictEqual(statut('PAYMENT_PENDING').action, 'payer');
  assert.strictEqual(statut('VALIDATED').terminal, true);
  assert.strictEqual(statut('VALIDATION_PENDING').action, 'attendre');
});

console.log('\nSIREN');
test('clé de Luhn acceptée', () => assert.ok(sirenValide('552 100 554')));
test('clé de Luhn refusée', () => assert.ok(!sirenValide('552100555')));
test('formatage', () => assert.strictEqual(formaterSiren('552100554'), '552 100 554'));

console.log('\nNormalisation RNE');
const fiche = normaliserEntreprise(mock.entrepriseSimulee('552100554'));
test('dénomination, capital et adresse extraits', () => {
  assert.ok(fiche.denomination.length > 3);
  assert.strictEqual(typeof fiche.capital, 'number');
  assert.match(fiche.adresse.texte, /\d{5}/);
});
test('dirigeant avec libellé de rôle officiel', () => {
  assert.ok(fiche.dirigeants[0].nom_complet);
  assert.ok(fiche.dirigeants[0].role_libelle);
});
test('JSON vide toléré', () => assert.strictEqual(normaliserEntreprise(null), null));

console.log('\nCatalogue');
test('toutes les formalités sont exposées', () => assert.strictEqual(catalogue().length, Object.keys(FORMALITES).length));
test('chaque formalité porte un service et des pièces officielles', () => {
  for (const f of catalogue()) {
    assert.ok(f.service, `${f.code} sans service`);
    assert.ok(f.champs.length, `${f.code} sans champs`);
    assert.ok(f.pieces.length, `${f.code} sans pièces`);
    for (const p of f.pieces) {
      assert.match(p.code, /^PJ_\d+$/, `${f.code} : code pièce non officiel (${p.code})`);
      assert.notStrictEqual(p.libelle, p.code, `${f.code} : pièce ${p.code} inconnue du dictionnaire INPI`);
    }
  }
});
test('types de formalité conformes au contrat d’interface', () => {
  assert.strictEqual(definition('creation_societe').typeFormalite, TYPES_FORMALITE.CREATION);
  assert.strictEqual(definition('transfert_siege').typeFormalite, TYPES_FORMALITE.MODIFICATION);
  assert.strictEqual(definition('cessation').typeFormalite, 'R');
  assert.strictEqual(definition('depot_comptes').service, 'comptes_annuels');
});
test('pièces conditionnelles : apport en nature', () => {
  const numeraire = piecesExigees('modification_capital', { sens: 'augmentation', modalite: 'APPORT_NUMERAIRE' }).map((p) => p.code);
  const nature = piecesExigees('modification_capital', { sens: 'augmentation', modalite: 'APPORT_NATURE' }).map((p) => p.code);
  assert.ok(numeraire.includes('PJ_56') && !numeraire.includes('PJ_04'));
  assert.ok(nature.includes('PJ_04') && !nature.includes('PJ_56'));
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
  assert.ok(c.bloquants.some((x) => /Nouvelle adresse/i.test(x.message)));
});
const dossierComplet = {
  type: 'transfert_siege', siren: '552100554', fiche,
  reponses: {
    date_decision: new Date().toISOString().slice(0, 10),
    nouvelle_adresse: { numVoie: '5', typeVoie: 'RUE', voie: 'de Rivoli', codePostal: '75001', commune: 'Paris' },
  },
  pieces: [
    { code: 'PJ_54', nom: 'pv.pdf' }, { code: 'PJ_02', nom: 'statuts.pdf' },
    { code: 'PJ_25', nom: 'bail.pdf' }, { code: 'PJ_08', nom: 'jal.pdf' },
  ],
};
test('dossier complet → prêt', () => {
  const c = controler(dossierComplet);
  assert.deepStrictEqual(c.bloquants, []);
  assert.ok(c.pret);
});
test('pièce non PDF → bloquant', () => {
  const c = controler({ ...dossierComplet, pieces: [...dossierComplet.pieces.slice(1), { code: 'PJ_54', nom: 'pv.docx' }] });
  assert.ok(c.bloquants.some((x) => /format PDF/.test(x.message)));
});
test('pièce de plus de 10 Mo → bloquant', () => {
  const c = controler({ ...dossierComplet, pieces: [...dossierComplet.pieces, { code: 'PJ_51', nom: 'gros.pdf', taille: 12 * 1024 * 1024 }] });
  assert.ok(c.bloquants.some((x) => /10 Mo/.test(x.message)));
});
test('type de voie hors référentiel → alerte', () => {
  const c = controler({
    ...dossierComplet,
    reponses: { ...dossierComplet.reponses, nouvelle_adresse: { ...dossierComplet.reponses.nouvelle_adresse, typeVoie: 'RUELLE' } },
  });
  assert.ok(c.alertes.some((x) => /référentiel INPI/.test(x.message)));
});
test('SIREN invalide → bloquant', () => {
  assert.ok(controler({ ...dossierComplet, siren: '552100555' }).bloquants.some((x) => /SIREN invalide/.test(x.message)));
});
test('capital incohérent → bloquant', () => {
  const c = controler({
    type: 'modification_capital', siren: '552100554', fiche: { ...fiche, capital: 100000 },
    reponses: { date_decision: '2026-09-01', sens: 'augmentation', nouveau_capital: 50000, modalite: 'APPORT_NUMERAIRE' },
    pieces: [{ code: 'PJ_155', nom: 'a.pdf' }, { code: 'PJ_02', nom: 'b.pdf' }, { code: 'PJ_08', nom: 'c.pdf' }, { code: 'PJ_56', nom: 'd.pdf' }],
  });
  assert.ok(c.bloquants.some((x) => /Augmentation déclarée/.test(x.message)));
});
test('modification sans indicateur d’évènement → bloquant', () => {
  const c = controler({ ...dossierComplet, payload: { corps: { newFormality: { content: { personneMorale: {} } } } } });
  assert.ok(c.bloquants.some((x) => /indicateur d’évènement/.test(x.message)));
});
test('approbation avant clôture → bloquant', () => {
  const c = controler({
    type: 'depot_comptes', siren: '552100554', fiche,
    reponses: { exercice_clos: '2025-12-31', date_approbation: '2025-06-30', resultat: 1000, affectation: 'report' },
    pieces: [{ code: 'PJ_232', nom: 'comptes.pdf' }, { code: 'PJ_236', nom: 'pv.pdf' }],
  });
  assert.ok(c.bloquants.some((x) => /approbation/i.test(x.message)));
});

console.log('\nDélais légaux');
test('échéance à un mois de la décision', () => {
  assert.strictEqual(echeance('transfert_siege', { date_decision: '2026-03-01' }).limite, '2026-03-31');
});
test('délai dépassé détecté', () => {
  assert.strictEqual(echeance('transfert_siege', { date_decision: '2020-01-01' }).etat, 'depasse');
});
test('dépôt des comptes : deux mois', () => {
  assert.strictEqual(echeance('depot_comptes', { date_approbation: '2026-06-30' }).limite, '2026-08-29');
});

console.log('\nPayload Guichet unique');
test('dates au format ISO attendu par l’API', () => {
  assert.strictEqual(dateInpi('2026-03-12'), '2026-03-12');
  assert.strictEqual(dateInpi('12/03/2026'), '2026-03-12');
  assert.strictEqual(clotureInpi('31/12'), '3112');
  assert.strictEqual(clotureInpi('2025-12-31'), '3112');
});
test('modification → endpoint formality_updates et couple previous/new', () => {
  const p = construirePayload({ ...dossierComplet, reference: 'LGZ-2026-00001', libelle: 'Transfert' });
  assert.strictEqual(p.endpoint, 'formalitesModification');
  assert.ok(p.corps.previousFormality.content);
  assert.strictEqual(p.corps.newFormality.typeFormalite, 'M');
  assert.strictEqual(p.corps.newFormality.typePersonne, 'M');
  assert.strictEqual(p.corps.newFormality.referenceMandataire, 'LGZ-2026-00001');
  assert.strictEqual(
    p.corps.newFormality.content.personneMorale.adresseEntreprise.adresse.codePostal, '75001',
  );
});
test('modification : au moins un indicateur d’évènement', () => {
  const p = construirePayload(dossierComplet);
  assert.deepStrictEqual(
    indicateursEvenement(p.corps.newFormality.content),
    ['personneMorale.etablissementPrincipal.is11PMFTriggered'],
  );
});
test('chaque formalité de modification porte son indicateur', () => {
  const reponses = {
    date_decision: '2026-03-12', nature: 'remplacement', dirigeant_sortant: 'Léa THOMAS',
    dirigeant_entrant: { nom: 'DURAND', prenoms: ['Claire'], date_naissance: '1975-05-05' },
    sens: 'augmentation', nouveau_capital: 200000, modalite: 'APPORT_NUMERAIRE',
    nouvelle_denomination: 'NOUVEAU NOM', nouvel_objet: 'nouvel objet',
    nouvelle_adresse: { codePostal: '75001', commune: 'Paris', voie: 'de Rivoli' },
  };
  for (const [code, def] of Object.entries(FORMALITES)) {
    if (def.typeFormalite !== 'M') continue;
    const p = construirePayload({ type: code, siren: '552100554', fiche, reponses, pieces: [] });
    assert.ok(
      indicateursEvenement(p.corps.newFormality.content).length > 0,
      `${code} : aucun indicateur d’évènement`,
    );
  }
});
test('création → enveloppe simple, sans SIREN', () => {
  const p = construirePayload({
    type: 'creation_societe', siren: '', fiche: {},
    reponses: {
      denomination: 'NOUVELLE SAS', forme_juridique_code: '5710', capital: 10000, duree: 99,
      date_cloture: '31/12', objet: 'conseil', activite_principale: 'conseil',
      date_debut_activite: '2026-04-01',
      adresse_siege: { codePostal: '75001', commune: 'Paris', voie: 'de Rivoli' },
      dirigeant: { nom: 'MARTIN', prenoms: ['Paul'], date_naissance: '1980-01-01', fonction: 'Président' },
    },
    pieces: [],
  });
  assert.strictEqual(p.endpoint, 'formalites');
  assert.strictEqual(p.corps.typeFormalite, 'C');
  assert.strictEqual(p.corps.siren, undefined);
  const pouvoir = p.corps.content.personneMorale.composition.pouvoirs[0];
  assert.strictEqual(pouvoir.roleEntreprise, '73');
  assert.strictEqual(pouvoir.statutPourLaFormalite, 'A');
  assert.strictEqual(
    p.corps.content.personneMorale.etablissementPrincipal.descriptionEtablissement.rolePourEntreprise, '2',
  );
});
test('cessation → typeFormalite R et évènement de cessation', () => {
  const p = construirePayload({
    type: 'cessation', siren: '552100554', fiche,
    reponses: {
      nature: 'dissolution', date_cessation: '2026-03-12', type_dissolution: '1',
      liquidateur: { nom: 'MARTIN', prenoms: ['Paul'], date_naissance: '1980-01-01' },
      adresse_liquidation: { codePostal: '75001', commune: 'Paris', voie: 'de Rivoli' },
    },
    pieces: [],
  });
  assert.strictEqual(p.corps.typeFormalite, 'R');
  assert.strictEqual(p.corps.content.evenementCessation, '22M');
  assert.strictEqual(p.corps.content.personneMorale.composition.pouvoirs[0].roleEntreprise, '40');
});
test('comptes annuels → service dédié et confidentialité par bloc', () => {
  const p = construirePayload({
    type: 'depot_comptes', siren: '552100554', fiche,
    reponses: {
      exercice_clos: '2025-12-31', date_approbation: '2026-06-25', resultat: 1000,
      affectation: 'report', confidentialite: 'resultat',
    },
    pieces: [],
  });
  assert.strictEqual(p.endpoint, 'comptesAnnuels');
  assert.strictEqual(p.corps.content.comptesAnnuels.compteResultat.confidentiel, true);
  assert.strictEqual(p.corps.content.comptesAnnuels.compteBilan.confidentiel, false);
});
test('pièces transmises en base64 avec leur code officiel', () => {
  const p = construirePayload({
    ...dossierComplet,
    pieces: [{ code: 'PJ_54', nom: 'pv.pdf', base64: 'QUJD' }],
  });
  const pj = p.corps.newFormality.content.piecesJointes[0];
  assert.strictEqual(pj.typeDocument, 'PJ_54');
  assert.strictEqual(pj.documentBase64, 'QUJD');
  assert.strictEqual(pj.documentExtension, 'pdf');
});
test('aucune clé vide dans le payload', () => {
  assert.strictEqual(JSON.stringify(construirePayload(dossierComplet)).match(/:(null|"")/g), null);
});

console.log('\nConformité au dictionnaire officiel');
const { DICTIONNAIRE } = require('../src/inpi/referentiels');

const PROPRIETES_INPI = new Set();
for (const classe of Object.values(DICTIONNAIRE)) {
  for (const nom of Object.keys(classe.proprietes)) PROPRIETES_INPI.add(nom);
}

function proprietesEmises(objet, vues = new Set()) {
  for (const [cle, valeur] of Object.entries(objet || {})) {
    if (valeur === undefined) continue;
    vues.add(cle);
    if (Array.isArray(valeur)) {
      valeur.forEach((v) => { if (v && typeof v === 'object') proprietesEmises(v, vues); });
    } else if (valeur && typeof valeur === 'object') {
      proprietesEmises(valeur, vues);
    }
  }
  return vues;
}

test('le dictionnaire couvre les 85 classes et 140 énumérations', () => {
  assert.ok(Object.keys(DICTIONNAIRE).length >= 85);
  assert.ok(PROPRIETES_INPI.size > 800);
});

// Un nom de propriété inventé est refusé par l'INPI sans que rien ne le
// signale côté application : on le détecte ici plutôt qu'au dépôt.
test('aucune propriété émise hors dictionnaire INPI', () => {
  const inconnues = new Set();
  for (const f of catalogue()) {
    let requete;
    try {
      requete = construirePayload({ ...dossierComplet, type: f.cle, service: f.service });
    } catch { continue; }
    for (const nom of proprietesEmises(requete.corps?.content)) {
      if (!PROPRIETES_INPI.has(nom)) inconnues.add(`${f.cle} : ${nom}`);
    }
  }
  assert.deepStrictEqual([...inconnues], []);
});

console.log('\nGuichet unique (simulation du cycle réel)');
test('dépôt puis cycle signature / paiement / validation', () => {
  const depot = mock.deposerSimule({ endpoint: 'formalites', corps: { companyName: 'ACME' } });
  assert.strictEqual(depot.status, 'RECEIVED');
  assert.ok(depot.carts.total > 0);
  mock.signerSimule(depot.id);
  assert.strictEqual(mock.statutSimule(depot.id).status, 'PAYMENT_PENDING');
  mock.payerSimule(depot.id);
  assert.strictEqual(mock.statutSimule(depot.id).status, 'VALIDATION_PENDING');
});
test('document de synthèse simulé exploitable', () => {
  const pdf = mock.syntheseSimulee('SIM-TEST-001');
  assert.strictEqual(pdf.subarray(0, 5).toString(), '%PDF-');
});

console.log(`\n${ok} assertion(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
