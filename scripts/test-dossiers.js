'use strict';

/**
 * Dossiers, clients, contacts : de bout en bout par l'API, sur une base en
 * mémoire. Une cession de titres, une approbation des comptes, une
 * consultation ; étapes, tâches, échéances, chronologie, fiche client,
 * modèles d'étapes modifiés.
 *
 *   node scripts/test-dossiers.js
 */

const fake = require('./fake-supa');

const { tables } = fake;
const app = require('../src/routes');
const express = require('express');
const { ajouterMois, approbationComptes } = require('../src/modules/dossiers/echeances');

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
  tables.societes.push(
    { id: 1, denomination: 'HORIZON HOLDING', siren: '552100554', forme_sociale: 'SAS', groupe_id: 7 },
    { id: 2, denomination: 'ATELIERS DUPONT', siren: '443061841', forme_sociale: 'SARL' },
  );
  fake.faux.connecte = tables.utilisateurs[0];
  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}/api`;
  const appel = async (methode, url, corps) => {
    const res = await fetch(base + url, {
      method: methode, headers: corps ? { 'Content-Type': 'application/json' } : undefined, body: corps ? JSON.stringify(corps) : undefined,
    });
    return { statut: res.status, corps: await res.json().catch(() => null) };
  };

  console.log('\nÉchéances légales');
  // C. pr. civ., art. 641 : même quantième, à défaut dernier jour du mois.
  verifier('31/12 + 6 mois = 30/06 (pas de 31 juin)', ajouterMois('2025-12-31', 6) === '2026-06-30');
  verifier('30/06 + 1 mois = 30/07 (même quantième, pas fin de mois)', ajouterMois('2026-06-30', 1) === '2026-07-30');
  verifier('31/01 + 1 mois = 28/02', ajouterMois('2026-01-31', 1) === '2026-02-28');
  verifier('28/02/2027 + 12 mois = 28/02/2028', ajouterMois('2027-02-28', 12) === '2028-02-28');
  const ec = approbationComptes({ exercice_clos_le: '2025-12-31' }, 'SARL');
  verifier('approbation : 30/06, article L. 223-26 pour une SARL', ec[0].date === '2026-06-30' && /L\. 223-26/.test(ec[0].base_legale), ec);
  verifier('dépôt : un mois après l’approbation, article L. 232-22', ec[1].date === '2026-07-30' && /L\. 232-22/.test(ec[1].base_legale), ec);
  const ecPrevue = approbationComptes({ exercice_clos_le: '2025-12-31', date_decision_prevue: '2026-05-20' }, 'SAS');
  verifier('dépôt calculé depuis la décision prévue (20/05 → 20/06), SAS : L. 232-23', ecPrevue[1].date === '2026-06-20' && /L\. 232-23/.test(ecPrevue[1].base_legale));

  console.log('\nCatalogue et modèles d’étapes');
  const cat = (await appel('GET', '/dossiers/catalogue')).corps;
  verifier('trois familles', Object.keys(cat.familles).join() === 'haut_de_bilan,secretariat,conseil');
  verifier('chaque type a des étapes', cat.types.every((t) => t.etapes.length > 0), cat.types.filter((t) => !t.etapes.length));
  const modifie = await appel('PUT', '/dossiers/modeles/consultation', { etapes: 'Question reçue\nRecherches\nNote écrite\nRendez-vous de restitution' });
  verifier('modèle modifié par le cabinet', modifie.corps.types.find((t) => t.code === 'consultation').etapes.length === 4);
  verifier('type inconnu refusé', (await appel('PUT', '/dossiers/modeles/inexistant', { etapes: 'x' })).statut === 404);

  console.log('\nCession de titres (haut de bilan)');
  const refusSansClient = await appel('POST', '/dossiers', { type: 'cession_titres' });
  verifier('client exigé', refusSansClient.statut === 400 && /client/i.test(refusSansClient.corps.error));
  const cession = await appel('POST', '/dossiers', {
    type: 'cession_titres',
    nouveau_client: { nom: 'Famille Dupont', nature: 'groupe' },
    parties: [{ societe_id: 2, role: 'cible' }, { denomination: 'ACQUIREUR GMBH', role: 'acquereur' }, { societe_id: 2, role: 'role_inconnu' }],
    donnees: { cote: 'cedant', prix: '1 250 000', date_closing_visee: '2026-12-15', inconnu: 'ignoré' },
  });
  const d1 = cession.corps;
  verifier('dossier ouvert (201)', cession.statut === 201, cession.corps);
  verifier('référence de l’année', new RegExp(`^${new Date().getFullYear()}-0001$`).test(d1.reference), d1.reference);
  verifier('titre proposé à partir de la société', d1.titre === 'Cession de titres — ATELIERS DUPONT', d1.titre);
  verifier('client créé au passage', d1.client?.nom === 'Famille Dupont' && tables.clients.length === 1);
  verifier('étapes copiées du modèle (10)', d1.etapes.length === 10 && d1.etape_courante?.libelle === 'Lettre de mission');
  verifier('parties : société de la base, société sans fiche, rôle inconnu ramené à « concernée »',
    d1.parties.map((p) => `${p.denomination}:${p.role}`).join('|') === 'ATELIERS DUPONT:cible|ACQUIREUR GMBH:acquereur|ATELIERS DUPONT:concernee', d1.parties);
  verifier('données propres au type nettoyées (prix en nombre, champ inconnu écarté)', d1.donnees.prix === 1250000 && !('inconnu' in d1.donnees), d1.donnees);
  verifier('échéance du dossier = closing visé', d1.echeance === '2026-12-15');
  verifier('responsable = le membre connecté', d1.responsable_id === 1 && d1.responsable_nom === 'Claire Martin');
  verifier('ouverture inscrite dans la chronologie, avec son auteur', d1.evenements.some((e) => e.nature === 'ouverture' && e.auteur_nom === 'Claire Martin'));
  verifier('actions proposées : générer des actes, préparer une formalité', d1.actions.map((a) => a.id).join() === 'generer-actes,preparer-formalite'
    && d1.actions[0].lien === `#/operations/new?dossier=${d1.id}&societe=2`, d1.actions);

  const etapes = d1.etapes;
  let r = await appel('PUT', `/etapes/${etapes[0].id}`, { statut: 'fait' });
  verifier('étape faite : date du jour posée', r.corps.etapes[0].statut === 'fait' && r.corps.etapes[0].date_realisee === new Date().toISOString().slice(0, 10));
  verifier('étape courante avancée', r.corps.etape_courante.libelle === 'Accord de confidentialité' && r.corps.etapes_faites === 1);
  r = await appel('PUT', `/etapes/${etapes[1].id}`, { statut: 'sans_objet' });
  verifier('étape sans objet : sortie du décompte', r.corps.etapes_total === 9 && r.corps.etape_courante.libelle === 'Lettre d’intention');
  r = await appel('POST', `/dossiers/${d1.id}/etapes`, { libelle: 'Notification à l’Autorité de la concurrence' });
  verifier('étape ajoutée au dossier seulement', r.corps.etapes.length === 11 && !tables.modeles_processus.some((m) => m.type === 'cession_titres'));
  r = await appel('POST', `/dossiers/${d1.id}/taches`, { titre: 'Relancer l’acquéreur sur la LOI', echeance: '2026-10-20' });
  const tache = r.corps.taches[0];
  verifier('tâche ajoutée, confiée au membre connecté', tache.titre.startsWith('Relancer') && tache.responsable_nom === 'Claire Martin' && r.corps.taches_ouvertes === 1, { tache, ouvertes: r.corps.taches_ouvertes });
  r = await appel('PUT', `/taches/${tache.id}`, { statut: 'fait' });
  verifier('tâche faite : sortie des tâches ouvertes, inscrite', r.corps.taches_ouvertes === 0 && r.corps.evenements.some((e) => /Tâche faite/.test(e.resume)));
  r = await appel('POST', `/dossiers/${d1.id}/echeances`, { libelle: 'Date limite de réalisation (long stop date)', date: '2027-03-31' });
  verifier('échéance contractuelle ajoutée', r.corps.echeances.length === 1);
  verifier('prochaine échéance : la plus proche', r.corps.prochaine_echeance.date === '2026-12-15', r.corps.prochaine_echeance);
  verifier('échéance sans date refusée', (await appel('POST', `/dossiers/${d1.id}/echeances`, { libelle: 'x' })).statut === 400);
  r = await appel('POST', `/dossiers/${d1.id}/notes`, { texte: 'Appel du DAF : data room ouverte lundi.' });
  verifier('note dans la chronologie, la plus récente en tête', r.corps.evenements[0].resume.startsWith('Appel du DAF'));
  r = await appel('PUT', `/dossiers/${d1.id}`, { statut: 'en_attente', donnees: { prix: '1300000' } });
  verifier('statut changé et inscrit', r.corps.statut === 'en_attente' && r.corps.evenements.some((e) => /En cours → En attente du client/.test(e.resume)));
  verifier('donnée modifiée sans perdre les autres', r.corps.donnees.prix === 1300000 && r.corps.donnees.cote === 'cedant');
  verifier('statut inconnu refusé', (await appel('PUT', `/dossiers/${d1.id}`, { statut: 'gagne' })).statut === 400);

  console.log('\nApprobation des comptes (secrétariat)');
  const client2 = (await appel('POST', '/clients', { nom: 'Horizon', nature: 'groupe', groupe_id: 7 })).corps;
  const refusExercice = await appel('POST', '/dossiers', { type: 'approbation_comptes', client_id: client2.id, parties: [{ societe_id: 1 }] });
  verifier('exercice clos exigé', refusExercice.statut === 400 && /Exercice clos le/.test(refusExercice.corps.error), refusExercice.corps);
  const approb = (await appel('POST', '/dossiers', {
    type: 'approbation_comptes', client_id: client2.id, parties: [{ societe_id: 1 }],
    donnees: { exercice_clos_le: '2025-12-31', mode_decision: 'associe_unique' },
  })).corps;
  verifier('deuxième référence', approb.reference.endsWith('-0002'));
  verifier('échéances légales calculées (SAS)', approb.echeances.length === 2 && approb.echeances[0].date === '2026-06-30'
    && approb.echeances.every((x) => x.origine === 'calcul' && x.base_legale), approb.echeances);
  r = await appel('PUT', `/echeances/${approb.echeances[0].id}`, { statut: 'faite' });
  verifier('échéance tenue : sortie des échéances à venir', r.corps.prochaine_echeance.libelle.startsWith('Dépôt des comptes'));

  console.log('\nConsultation (conseil), modèle du cabinet');
  const consult = (await appel('POST', '/dossiers', {
    type: 'consultation', nouveau_client: { nom: 'Jean Morel', nature: 'personne' }, titre: 'Apport-cession : report d’imposition',
    donnees: { domaine: 'fiscal', question: 'Report d’imposition 150-0 B ter ?', reponse_attendue_le: '2026-10-30' },
  })).corps;
  verifier('étapes du modèle modifié par le cabinet', consult.etapes.map((e) => e.libelle).join('|') === 'Question reçue|Recherches|Note écrite|Rendez-vous de restitution');
  verifier('titre saisi conservé', consult.titre === 'Apport-cession : report d’imposition');
  verifier('pas d’actions de formalité sur une consultation', consult.actions.length === 0);

  console.log('\nVues et fiche client');
  let liste = (await appel('GET', '/dossiers?famille=haut_de_bilan')).corps;
  verifier('vue haut de bilan : la cession seule', liste.length === 1 && liste[0].id === d1.id);
  verifier('carte : étapes et parties pour l’affichage', liste[0].etapes.length === 11 && liste[0].parties.length === 3 && liste[0].client_nom === 'Famille Dupont',
    { etapes: liste[0].etapes.length, parties: liste[0].parties.length, client: liste[0].client_nom });
  liste = (await appel('GET', '/dossiers?famille=secretariat')).corps;
  verifier('vue secrétariat', liste.length === 1 && liste[0].type_libelle === 'Approbation des comptes');
  liste = (await appel('GET', '/dossiers?famille=conseil')).corps;
  verifier('vue conseil', liste.length === 1 && liste[0].client_nom === 'Jean Morel');
  await appel('PUT', `/dossiers/${consult.id}`, { statut: 'clos' });
  verifier('dossier clos : hors des dossiers en cours', (await appel('GET', '/dossiers?famille=conseil')).corps.length === 0);
  verifier('… et visible parmi les dossiers clos', (await appel('GET', '/dossiers?famille=conseil&statut=clos')).corps[0]?.date_cloture);

  const contact = await appel('POST', `/clients/${client2.id}/contacts`, { nom: 'Leroy', prenom: 'Anne', fonction: 'DAF', email: 'Anne.Leroy@Horizon.test' });
  verifier('contact ajouté, adresse en minuscules', contact.corps.contacts[0].email === 'anne.leroy@horizon.test');
  const fiche = (await appel('GET', `/clients/${client2.id}`)).corps;
  verifier('fiche client : dossiers, sociétés du groupe, échéances', fiche.dossiers.length === 1 && fiche.societes.some((s) => s.denomination === 'HORIZON HOLDING')
    && fiche.echeances.length === 1 && fiche.echeances[0].dossier_reference === approb.reference, fiche);
  const clients = (await appel('GET', '/clients')).corps;
  verifier('liste des clients : dossiers en cours comptés', clients.find((c) => c.id === client2.id).dossiers_actifs === 1 && clients.length === 3);

  console.log('\nLiens et suppression');
  tables.operations.push({ id: 50, libelle: 'Cession de parts — ATELIERS DUPONT', societe_id: 2, dossier_id: null });
  r = (await appel('GET', `/dossiers/${d1.id}`)).corps;
  verifier('opération de la société proposée au rattachement', r.rattachables.operations.map((o) => o.id).join() === '50');
  r = (await appel('PUT', `/dossiers/${d1.id}/liens`, { table: 'operations', objet_id: 50 })).corps;
  verifier('opération rattachée et inscrite', r.operations.length === 1 && r.rattachables.operations.length === 0 && r.evenements[0].nature === 'lien');
  verifier('autre table refusée', (await appel('PUT', `/dossiers/${d1.id}/liens`, { table: 'utilisateurs', objet_id: 1 })).statut === 400);
  const synth = (await appel('GET', '/dossiers/synthese')).corps;
  verifier('synthèse : dossiers en cours par famille', synth.par_famille.haut_de_bilan === 1 && synth.par_famille.secretariat === 1 && synth.par_famille.conseil === 0, synth.par_famille);
  verifier('suppression sans la référence refusée', (await appel('DELETE', `/dossiers/${d1.id}`, { confirmation: 'oui' })).statut === 422);
  verifier('suppression avec la référence', (await appel('DELETE', `/dossiers/${d1.id}`, { confirmation: d1.reference })).statut === 200
    && !tables.dossiers.some((d) => d.id === d1.id));

  instance.close();
  console.log(`\n${ok} vérification(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
})();
