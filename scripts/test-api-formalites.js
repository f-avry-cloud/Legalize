'use strict';

/**
 * Test de bout en bout des routes /api/formalites/* sur une base en mémoire.
 *
 * Supabase est remplacé par le double de scripts/fake-supa.js. On déroule
 * alors le parcours complet — ouverture du dossier, questionnaire, pièces, contrôles, dépôt, suivi — pour
 * vérifier le câblage HTTP, sans dépendre du réseau.
 *
 *   node scripts/test-api-formalites.js
 */

const { tables } = require('./fake-supa');

/**
 * Le compte INPI simulé ne renvoie rien : pour éprouver l'import, on substitue
 * la liste distante par deux formalités déjà validées côté INPI, comme celles
 * déposées avant la mise en service de l'application.
 */
const guichet = require('../src/inpi/guichet');
const FORMALITES_DISTANTES = [
  {
    inpi_id: '900001', numero_liasse: 'A2024-000900001', siren: '552100554',
    company_name: 'HORIZON HOLDING', nom_dossier: 'Transfert 2024', type_formalite: 'M',
    statut: 'VALIDATED', statut_brut: 'VALIDATED', statut_date: '2024-07-02T10:00:00Z',
    action_attendue: null, montant: 195.71, num_nat: 'NN-900001',
    signature_date: '2024-06-30T09:00:00Z', paiement_date: '2024-06-30T09:05:00Z', regularisations: [],
  },
  {
    inpi_id: '900002', numero_liasse: 'A2025-000900002', siren: '552100554',
    company_name: 'HORIZON HOLDING', nom_dossier: null, type_formalite: 'C',
    statut: 'AMENDMENT_PENDING', statut_brut: 'AMENDMENT_PENDING', statut_date: '2025-02-11T10:00:00Z',
    action_attendue: 'regulariser', montant: null, num_nat: null,
    signature_date: null, paiement_date: null,
    regularisations: [{ id: 7, type: 'ADDITIONAL_INFORMATION', motif: 'Adresse du siège à corriger' }],
  },
];
guichet.listerTout = async ({ service } = {}) => (service === 'comptes_annuels' ? [] : FORMALITES_DISTANTES);

/* ------------------------------------------------------------ scénario */

const app = require('../src/routes');
const express = require('express');

const serveur = express();
serveur.use(express.json());
serveur.use('/api', app);
serveur.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

let ok = 0;
const echecs = [];
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    echecs.push(nom); console.error(`  ✗ ${nom}${detail ? `\n    ${JSON.stringify(detail)}` : ''}`);
    process.exitCode = 1;
  }
}

(async () => {
  tables.societes.push({ id: 1, denomination: 'HORIZON HOLDING', siren: '552 100 554', forme_sociale: 'SAS' });

  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}/api`;
  const appel = async (methode, url, corps, form) => {
    const res = await fetch(base + url, {
      method: methode,
      headers: corps && !form ? { 'Content-Type': 'application/json' } : undefined,
      body: form || (corps ? JSON.stringify(corps) : undefined),
    });
    return { statut: res.status, corps: await res.json().catch(() => null) };
  };

  console.log('\nParcours complet d’une formalité');

  const creation = await appel('POST', '/formalites', { type: 'transfert_siege', societe_id: 1 });
  verifier('ouverture du dossier depuis une société du cabinet', creation.statut === 201 && creation.corps.id, creation.corps);
  const id = creation.corps.id;
  verifier('référence mandataire attribuée', /^LGZ-\d{4}-\d{5}$/.test(creation.corps.reference || ''), creation.corps.reference);

  const initial = await appel('GET', `/formalites/${id}`);
  verifier('fiche RNE rapatriée et figée', Boolean(initial.corps.fiche?.denomination), initial.corps.fiche);
  verifier('contrôles bloquants au départ', initial.corps.controles.pret === false);
  verifier('pièces exigées : codes officiels du guichet unique',
    initial.corps.pieces_exigees.length === 4
      && initial.corps.pieces_exigees.every((p) => /^PJ_\d+$/.test(p.code)),
    initial.corps.pieces_exigees.map((p) => p.code));

  const refus = await appel('POST', `/formalites/${id}/deposer`);
  verifier('dépôt refusé tant que le dossier est incomplet', refus.statut === 422, refus.corps);

  await appel('PUT', `/formalites/${id}/reponses`, {
    reponses: {
      date_decision: new Date().toISOString().slice(0, 10),
      nouvelle_adresse: { numVoie: '5', typeVoie: 'RUE', voie: 'de Rivoli', codePostal: '75001', commune: 'Paris' },
    },
  });
  const apresSaisie = await appel('GET', `/formalites/${id}`);
  verifier('échéance légale calculée', Boolean(apresSaisie.corps.controles.echeance?.limite));
  verifier('récapitulatif alimenté', apresSaisie.corps.apercu.length > 0);

  for (const code of ['PJ_54', 'PJ_02', 'PJ_25', 'PJ_08']) {
    const form = new FormData();
    form.append('code', code);
    form.append('libelle', code);
    form.append('fichier', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), `${code}.pdf`);
    const rep = await appel('POST', `/formalites/${id}/pieces`, null, form);
    if (rep.statut !== 201) throw new Error(`pièce ${code} refusée : ${JSON.stringify(rep.corps)}`);
  }
  const complet = await appel('GET', `/formalites/${id}`);
  verifier('dossier prêt une fois les pièces jointes', complet.corps.controles.pret === true, complet.corps.controles.bloquants);
  verifier('payload de modification (previousFormality + newFormality)',
    complet.corps.payload_endpoint === 'formalitesModification'
      && complet.corps.payload?.newFormality?.typeFormalite === 'M'
      && Boolean(complet.corps.payload?.previousFormality?.content),
    complet.corps.payload_endpoint);

  const depot = await appel('POST', `/formalites/${id}/deposer`);
  verifier('dépôt accepté', depot.statut === 200 && depot.corps.numero_liasse, depot.corps);
  verifier('statut initial RECEIVED, comme au guichet unique', depot.corps.statut === 'RECEIVED', depot.corps.statut);
  verifier('montant des taxes remonté', Number(depot.corps.montant) > 0, depot.corps.montant);
  verifier('dépôt marqué comme simulé (pas d’identifiants)', depot.corps.simule === true);

  const redepot = await appel('POST', `/formalites/${id}/deposer`);
  verifier('un second dépôt est refusé', redepot.statut === 409, redepot.corps);

  const suivi = await appel('POST', `/formalites/${id}/synchroniser`);
  verifier('statut synchronisé auprès de l’INPI', suivi.corps.synchronise === true, suivi.corps);

  const signature = await appel('POST', `/formalites/${id}/signer`, {});
  verifier('signature → passage en attente de paiement',
    signature.corps.statut === 'PAYMENT_PENDING' && signature.corps.action_attendue === 'payer',
    { statut: signature.corps.statut, action: signature.corps.action_attendue });

  const paiementRefuse = await appel('POST', `/formalites/${id}/payer`, {});
  verifier('paiement refusé tant qu’il n’est pas configuré', paiementRefuse.statut === 409, paiementRefuse.corps);

  const apresSignature = await appel('GET', `/formalites/${id}`);
  verifier('cycle INPI reflété dans le dossier',
    Boolean(apresSignature.corps.signature_date) && apresSignature.corps.statut_libelle === 'À payer',
    { signature: apresSignature.corps.signature_date, statut: apresSignature.corps.statut_libelle });

  const journal = apresSignature.corps.evenements;
  verifier('journal alimenté automatiquement', journal.length >= 7, journal.map((e) => e.type));

  const tableau = await appel('GET', '/formalites/dashboard');
  verifier('tableau de bord : le dossier attend une action de notre côté',
    tableau.corps.compteurs.total === 1 && tableau.corps.compteurs.a_payer === 1,
    tableau.corps.compteurs);

  const etat = await appel('GET', '/inpi/etat');
  verifier('référentiels officiels servis au formulaire',
    etat.corps.formes_juridiques.length > 100 && Object.keys(etat.corps.types_voie).length > 100,
    { formes: etat.corps.formes_juridiques.length, voies: Object.keys(etat.corps.types_voie || {}).length });

  const suppression = await appel('DELETE', `/formalites/${id}`);
  verifier('un dossier déposé n’est pas supprimable', suppression.statut === 409, suppression.corps);

  console.log('\nImport des formalités déjà présentes sur le compte INPI');

  const avant = (await appel('GET', '/formalites')).corps.length;
  const imp = await appel('POST', '/formalites/importer');
  verifier('import : deux dossiers repris', imp.corps.importees === 2, imp.corps);

  const apres = (await appel('GET', '/formalites')).corps;
  verifier('les dossiers importés apparaissent dans la liste', apres.length === avant + 2, { avant, apres: apres.length });

  const valide = apres.find((f) => f.numero_liasse === 'A2024-000900001');
  verifier('statut et libellé repris du compte INPI',
    valide && valide.statut === 'VALIDATED' && valide.importe === true && /import/i.test(valide.type_libelle),
    valide && { statut: valide.statut, type: valide.type_libelle, importe: valide.importe });
  verifier('rattachement à la société du cabinet par le SIREN', Boolean(valide && valide.societe_id), valide?.societe_id);

  const detail = await appel('GET', `/formalites/${valide.id}`);
  verifier('dossier importé en lecture seule (ni contrôles ni payload)',
    detail.corps.importe === true && detail.corps.controles === null && detail.corps.payload === null,
    { controles: detail.corps.controles, payload: detail.corps.payload });

  const regul = apres.find((f) => f.numero_liasse === 'A2025-000900002');
  verifier('régularisation en attente remontée', regul && regul.nb_regularisations === 1, regul?.nb_regularisations);

  const imp2 = await appel('POST', '/formalites/importer');
  verifier('un second import ne duplique rien',
    imp2.corps.importees === 0 && imp2.corps.inchangees === 2, imp2.corps);

  const importSociete = await appel('POST', '/inpi/importer-societe', { siren: '901234567' });
  verifier('import d’une société depuis le seul SIREN', importSociete.statut === 201 && importSociete.corps.societe.denomination, importSociete.corps);

  instance.close();
  console.log(`\n${ok} vérification(s) passée(s).${echecs.length ? ` ÉCHECS : ${echecs.join(', ')}` : ' Tout est vert.'}\n`);
})();
