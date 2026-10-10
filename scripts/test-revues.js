'use strict';

/**
 * Revue quotidienne : lecture d'une revue déposée par l'assistant et
 * application des propositions, sur une base en mémoire.
 *
 *   node scripts/test-revues.js
 *
 * Le dépôt lui-même (agent_deposer_revue) est une fonction de la base : il
 * est simulé ici par les lignes qu'il écrit, et éprouvé à part sur la base
 * réelle.
 */

const fake = require('./fake-supa');

const { tables } = fake;
const app = require('../src/routes');
const express = require('express');

const serveur = express();
serveur.use(express.json());
serveur.use('/api', app);
serveur.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
    process.exitCode = 1;
  }
}

(async () => {
  tables.utilisateurs.push({ id: 1, email: 'associe@cabinet.test', nom: 'Martin', prenom: 'Claire', role: 'associe', actif: true });
  fake.faux.connecte = tables.utilisateurs[0];
  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}/api`;
  const appel = async (methode, url, corps) => {
    const res = await fetch(base + url, {
      method: methode, headers: corps ? { 'Content-Type': 'application/json' } : undefined, body: corps ? JSON.stringify(corps) : undefined,
    });
    return { statut: res.status, corps: await res.json().catch(() => null) };
  };

  console.log('\nRevue vide');
  const vide = (await appel('GET', '/revues/derniere')).corps;
  verifier('aucune revue : réponse claire, pas d’erreur', vide.revue === null && Array.isArray(vide.revues));

  // Ce qu'écrit agent_deposer_revue : un dossier proposé (clé), ses mails, ses propositions.
  const date = new Date().toISOString();
  tables.revues.push({ id: 1, date_revue: date.slice(0, 10), moment: 'matin', statut: 'complete', stats: { recus: 36, envoyes: 2, utiles: 10, ecartes: 26 },
    echeances: [{ date: '2026-10-14', libelle: 'Closing', dossier_cle: 'alpha' }], remarques: ['Un destinataire protégé par un filtre anti-spam.'] });
  tables.revue_dossiers.push(
    { id: 1, revue_id: 1, dossier_id: null, cle: 'alpha', titre: 'Alpha — acquisition', priorite: 'haute', faits: ['Projets reçus'], a_faire: ['Relire les projets'], en_attente: ['Sûretés'], ordre: 0 },
    { id: 2, revue_id: 1, dossier_id: null, cle: 'beta', titre: 'Beta — question', priorite: 'basse', faits: [], a_faire: [], en_attente: [], ordre: 1 },
  );
  tables.emails.push(
    { id: 1, message_id: '<m1>', conversation_id: 'c1', sens: 'recu', expediteur: 'avocat@confrere.test', objet: 'Alpha - Tirage', date, resume: 'Quatre projets pour revue.', revue_id: 1, dossier_id: null, dossier_cle: 'alpha', statut: 'propose' },
    { id: 2, message_id: '<m2>', conversation_id: 'c1', sens: 'envoye', expediteur: 'moi@cabinet.test', objet: 'RE: Alpha - Tirage', date, resume: 'Organigramme envoyé.', revue_id: 1, dossier_id: null, dossier_cle: 'alpha', statut: 'propose' },
    { id: 3, message_id: '<m3>', conversation_id: 'c9', sens: 'recu', expediteur: 'news@galerie.test', objet: 'Exposition', date, revue_id: 1, statut: 'ignore' },
    { id: 4, message_id: '<m4>', conversation_id: 'c5', sens: 'recu', expediteur: 'inconnu@client.test', objet: 'Question', date, resume: 'Une question.', revue_id: 1, statut: 'propose' },
  );
  tables.propositions.push(
    { id: 1, revue_id: 1, dossier_cle: 'alpha', nature: 'creer_dossier', statut: 'proposee', justification: 'Fil Alpha actif',
      donnees: { titre: 'Alpha — acquisition', type: 'acquisition', client_nom: 'Fonds Exemple', client_nature: 'societe',
        parties: [{ denomination: 'ALPHA SAS', role: 'cible' }], donnees: { date_closing_visee: '2026-10-14' } } },
    { id: 2, revue_id: 1, dossier_cle: 'alpha', nature: 'creer_tache', statut: 'proposee', donnees: { titre: 'Relire les quatre projets', echeance: '2026-10-12' } },
    { id: 3, revue_id: 1, dossier_cle: 'alpha', nature: 'ajouter_contact', statut: 'proposee', donnees: { prenom: 'Charlotte', nom: 'Exemple', email: 'Avocat@Confrere.test', fonction: 'Avocat (conseil des porteurs)' } },
    { id: 4, revue_id: 1, dossier_cle: 'alpha', nature: 'creer_echeance', statut: 'proposee', donnees: { libelle: 'Closing', date: '2026-10-14' } },
    { id: 5, revue_id: 1, dossier_cle: 'beta', nature: 'creer_dossier', statut: 'proposee', donnees: { titre: 'Beta', type: 'question_ponctuelle', client_nom: 'Beta' } },
    { id: 6, revue_id: 1, dossier_cle: 'beta', nature: 'creer_tache', statut: 'proposee', donnees: { titre: 'Répondre' } },
    { id: 7, revue_id: 1, nature: 'creer_tache', statut: 'proposee', donnees: { titre: 'Sans dossier' } },
  );

  console.log('\nLecture de la revue');
  let r = (await appel('GET', '/revues/derniere')).corps;
  verifier('revue lue, blocs par priorité', r.revue.id === 1 && r.sections.map((s) => s.cle).join() === 'alpha,beta');
  verifier('bloc Alpha : 2 mails et 4 propositions', r.sections[0].emails.length === 2 && r.sections[0].propositions.length === 4, r.sections[0]);
  verifier('propositions décrites pour l’écran', r.sections[0].propositions[0].libelle === 'Ouvrir le dossier' && /Acquisition/.test(r.sections[0].propositions[0].texte));
  verifier('mail sans dossier : à rattacher', r.a_rattacher.map((e) => e.id).join() === '4');
  verifier('mails écartés comptés, pas affichés', r.ecartes === 1 && !r.a_rattacher.some((e) => e.id === 3));
  verifier('pastille : 7 propositions en attente', (await appel('GET', '/revues/en-attente')).corps.propositions === 7);

  console.log('\nValidation');
  const avant = await appel('POST', '/propositions/2/accepter');
  verifier('tâche d’un dossier pas encore ouvert : refus clair (409)', avant.statut === 409 && /Ouvrez d’abord/.test(avant.corps.error));
  const sansType = await appel('POST', '/propositions/1/accepter', { type: '' });
  verifier('ouverture sans type : refus clair', sansType.statut === 400 && /type/.test(sansType.corps.error));
  const ouvert = await appel('POST', '/propositions/1/accepter');
  verifier('dossier ouvert depuis la proposition', ouvert.statut === 200 && ouvert.corps.dossier_id && tables.dossiers.length === 1, ouvert.corps);
  const did = ouvert.corps.dossier_id;
  verifier('client créé', tables.clients[0]?.nom === 'Fonds Exemple');
  verifier('mails de la clé rattachés au dossier', tables.emails.filter((e) => e.dossier_id === did && e.statut === 'rattache').length === 2);
  verifier('propositions de la clé rattachées au dossier', tables.propositions.filter((p) => p.dossier_cle === 'alpha' && p.statut === 'proposee').every((p) => p.dossier_id === did));
  verifier('bloc de la revue rattaché', tables.revue_dossiers.find((b) => b.cle === 'alpha').dossier_id === did);
  verifier('ouverture inscrite comme venant de l’assistant', tables.evenements.some((e) => e.dossier_id === did && e.origine === 'agent'));
  verifier('déjà traitée : refus (409)', (await appel('POST', '/propositions/1/accepter')).statut === 409);

  const tache = await appel('POST', '/propositions/2/accepter');
  verifier('tâche ajoutée, origine assistant', tache.statut === 200 && tables.taches.some((t) => t.titre === 'Relire les quatre projets' && t.origine === 'agent'));
  const contact = await appel('POST', '/propositions/3/accepter');
  verifier('contact rangé chez le client du dossier, adresse en minuscules', contact.statut === 200 && tables.contacts[0]?.email === 'avocat@confrere.test' && tables.contacts[0].client_id === tables.clients[0].id);
  const modif = await appel('POST', '/propositions/4/accepter', { date: '2026-10-15' });
  verifier('échéance corrigée avant validation', modif.statut === 200 && tables.echeances.some((x) => x.dossier_id === did && x.date === '2026-10-15'));

  r = (await appel('GET', '/dossiers/' + did)).corps;
  verifier('fiche dossier : mails rattachés avec leur résumé', r.emails.length === 2 && r.emails.some((e) => e.resume === 'Quatre projets pour revue.'));

  console.log('\nRefus et règles');
  const refus = await appel('POST', '/propositions/5/refuser', { regle: { nature: 'ignorer_expediteur', valeur: 'Inconnu@Client.test' } });
  verifier('refus enregistré', refus.statut === 200 && tables.propositions.find((p) => p.id === 5).statut === 'refusee');
  verifier('refuser un dossier refuse ce qui s’y rattachait', tables.propositions.find((p) => p.id === 6).statut === 'refusee');
  verifier('règle mémorisée (minuscules)', tables.regles_agent.some((x) => x.nature === 'ignorer_expediteur' && x.valeur === 'inconnu@client.test'));
  verifier('règle incomplète refusée', (await appel('POST', '/revues/regles', { nature: 'ignorer_expediteur' })).statut === 400);

  console.log('\nMails');
  const range = await appel('PUT', '/emails/4', { dossier_id: did });
  verifier('mail rangé à la main dans un dossier', range.statut === 200 && tables.emails.find((e) => e.id === 4).dossier_id === did);
  await appel('PUT', '/emails/4', { ignorer: true });
  verifier('mail écarté : résumé effacé', tables.emails.find((e) => e.id === 4).statut === 'ignore' && tables.emails.find((e) => e.id === 4).resume === null);

  console.log('\nClôture du dossier');
  await appel('PUT', `/dossiers/${did}`, { statut: 'clos' });
  verifier('résumés des mails effacés', tables.emails.filter((e) => e.dossier_id === did).every((e) => e.resume === null));
  verifier('blocs de revue du dossier effacés', !tables.revue_dossiers.some((b) => b.dossier_id === did));
  verifier('objet, date et lien conservés', tables.emails.filter((e) => e.dossier_id === did).every((e) => e.objet));
  verifier('effacement inscrit dans la chronologie', tables.evenements.some((e) => e.dossier_id === did && /Résumés des mails effacés/.test(e.resume)));

  instance.close();
  console.log(`\n${ok} vérification(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
})();
