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
  verifier('pièces exigées calculées', initial.corps.pieces_exigees.length === 4, initial.corps.pieces_exigees);

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

  for (const code of ['PV', 'STATUTS', 'JOUISSANCE', 'JAL']) {
    const form = new FormData();
    form.append('code', code);
    form.append('libelle', code);
    form.append('fichier', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), `${code}.pdf`);
    const rep = await appel('POST', `/formalites/${id}/pieces`, null, form);
    if (rep.statut !== 201) throw new Error(`pièce ${code} refusée : ${JSON.stringify(rep.corps)}`);
  }
  const complet = await appel('GET', `/formalites/${id}`);
  verifier('dossier prêt une fois les pièces jointes', complet.corps.controles.pret === true, complet.corps.controles.bloquants);
  verifier('payload INPI produit', complet.corps.payload?.typeFormalite === 'M', complet.corps.payload);

  const depot = await appel('POST', `/formalites/${id}/deposer`);
  verifier('dépôt accepté', depot.statut === 200 && depot.corps.numero_liasse, depot.corps);
  verifier('dépôt marqué comme simulé (pas d’identifiants)', depot.corps.simule === true);

  const suivi = await appel('POST', `/formalites/${id}/synchroniser`);
  verifier('statut synchronisé auprès de l’INPI', suivi.corps.synchronise === true, suivi.corps);

  const journal = (await appel('GET', `/formalites/${id}`)).corps.evenements;
  verifier('journal alimenté automatiquement', journal.length >= 6, journal.map((e) => e.type));

  const tableau = await appel('GET', '/formalites/dashboard');
  verifier('tableau de bord alimenté', tableau.corps.compteurs.total === 1, tableau.corps.compteurs);

  const suppression = await appel('DELETE', `/formalites/${id}`);
  verifier('un dossier déposé n’est pas supprimable', suppression.statut === 409, suppression.corps);

  const importSociete = await appel('POST', '/inpi/importer-societe', { siren: '901234567' });
  verifier('import d’une société depuis le seul SIREN', importSociete.statut === 201 && importSociete.corps.societe.denomination, importSociete.corps);

  instance.close();
  console.log(`\n${ok} vérification(s) passée(s).${echecs.length ? ` ÉCHECS : ${echecs.join(', ')}` : ' Tout est vert.'}\n`);
})();
