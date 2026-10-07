'use strict';

/**
 * Test de bout en bout du parcours de formalités, sur une base en mémoire :
 * augmentation de capital et changement de président dans une SAS.
 *
 *   node scripts/test-parcours.js
 */

const { tables } = require('./fake-supa');

const app = require('../src/routes');
const express = require('express');
const { construireParcours } = require('../src/inpi/payload-parcours');
const { resoudre } = require('../src/inpi/parcours');

const serveur = express();
serveur.use(express.json());
serveur.use('/api', app);
serveur.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message, details: err.details }));

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 600)}` : ''}`);
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
  const charger = async (id, cle, code, extra = {}) => {
    const form = new FormData();
    form.append('cle', cle); form.append('code', code);
    for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
    form.append('fichier', new Blob([require('fs').readFileSync(require('path').join(__dirname, 'fixtures/piece-test.pdf'))], { type: 'application/pdf' }), `${cle.replace(':', '-')}.pdf`);
    return appel('POST', `/parcours/${id}/pieces`, null, form);
  };

  console.log('\nRègles de pièces');
  const fiche = { forme_juridique_code: '5710', dirigeants: [{ nom_complet: 'Jean DUPONT' }] };
  const r = resoudre(['35M'], { entrants: [{ nom: 'A', nature: 'PP', fonction: 'dirigeant' }, { nom: 'B SAS', nature: 'PM', fonction: 'dirigeant' }, { nom: 'C', nature: 'PP', fonction: 'cac', inscrit: false }] }, fiche);
  const codesDe = (nom) => r.pieces.obligatoires.filter((p) => p.personne === nom).map((p) => p.code).sort();
  verifier('personne physique : pièce d’identité et déclaration de non-condamnation', JSON.stringify(codesDe('A')) === JSON.stringify(['PJ_11', 'PJ_17']), codesDe('A'));
  verifier('personne morale : extrait Kbis', JSON.stringify(codesDe('B SAS')) === JSON.stringify(['PJ_20']), codesDe('B SAS'));
  verifier('commissaire aux comptes non inscrit : acceptation et justificatif d’inscription', JSON.stringify(codesDe('C')) === JSON.stringify(['PJ_40', 'PJ_41']), codesDe('C'));
  const r2 = resoudre(['11M'], { siege_occupation: 'domiciliation', domiciliataire_meme_greffe: false, hors_ressort: true }, fiche);
  const c2 = r2.pieces.obligatoires.map((p) => p.code);
  verifier('siège domicilié hors ressort : contrat, Kbis du domiciliataire, liste des sièges', ['PJ_29', 'PJ_45', 'PJ_97'].every((c) => c2.includes(c)) && !c2.includes('PJ_25'), c2);
  const r3 = resoudre(['15M', '35M', '10M'], {}, fiche);
  verifier('pièces communes une seule fois (PV, statuts, annonce)', ['PJ_54', 'PJ_02', 'PJ_08'].every((c) => r3.pieces.obligatoires.filter((p) => p.code === c).length === 1), r3.pieces.obligatoires.map((p) => p.code));
  verifier('création et modification signalées incompatibles', resoudre(['01M', '10M'], {}, {}).incompatibilites.length === 1);

  console.log('\nParcours complet : augmentation de capital et changement de président');
  const creation = await appel('POST', '/parcours', { societe_id: 1, operations: ['15M', '35M'] });
  verifier('dossier ouvert', creation.statut === 201 && creation.corps.id, creation.corps);
  const id = creation.corps.id;

  let d = (await appel('GET', `/parcours/${id}`)).corps;
  verifier('questions de typologie posées', d.questions.some((qq) => qq.id === 'capital_sens') && d.questions.some((qq) => qq.id === 'entrants'), d.questions?.map((qq) => qq.id));
  verifier('pièces à préciser tant que la typologie manque', d.pieces.a_preciser.length > 0);
  verifier('formulaire ciblé : date de décision, capital, rien d’autre', d.champs.map((g) => g.op).filter((o) => o !== '_registre').join(',') === 'commun,15M', d.champs.map((g) => g.op));
  const registre = d.champs.find((g) => g.op === '_registre');
  verifier('données manquantes au registre réclamées (sexe de la dirigeante en place)', registre && registre.champs.some((c) => /^genre_/.test(c.name)), registre);
  verifier('dépôt refusé tant que le dossier est incomplet', (await appel('POST', `/parcours/${id}/deposer`)).statut === 422);

  d = (await appel('PUT', `/parcours/${id}/typologie`, {
    capital_sens: 'augmentation', capital_modalite: 'numeraire', statuts_modifies: false,
    entrants: [{ nom: 'Claire MARTIN', nature: 'PP', fonction: 'dirigeant' }],
    sortants: [{ nom: 'Jean DUPONT', motif: 'demission' }],
    manuel: { PJ_55: false },
  })).corps;
  verifier('plus rien à préciser une fois la typologie renseignée', d.pieces.a_preciser.length === 0, d.pieces.a_preciser.map((p) => p.code));
  const attendues = d.pieces.obligatoires.map((p) => p.cle);
  verifier('pièces de la nouvelle présidente et du démissionnaire', ['PJ_11:e0', 'PJ_17:e0', 'PJ_230:s0', 'PJ_180'].every((c) => attendues.includes(c)), attendues);
  verifier('formulaire ciblé complété de la fiche de la nouvelle présidente', d.champs.some((g) => g.op === '35M' && g.champs[0].type === 'personne'));

  for (const p of d.pieces.obligatoires) {
    const rep = await charger(id, p.cle, p.code, p.code === 'PJ_54' ? { version: 'provisoire' } : {});
    if (rep.statut !== 200) throw new Error(`pièce ${p.cle} refusée : ${JSON.stringify(rep.corps)}`);
  }
  d = (await appel('GET', `/parcours/${id}`)).corps;
  verifier('toutes les pièces obligatoires chargées', d.etat.pieces_manquantes.length === 0, d.etat.pieces_manquantes);
  verifier('version provisoire comptée et bloquante', d.etat.provisoires === 1 && d.etat.pret === false);
  const pv = d.pieces.obligatoires.find((p) => p.code === 'PJ_54').fichiers[0];
  d = (await appel('PUT', `/parcours/pieces/${pv.id}`, { version: 'definitive', a_signer: true })).corps;
  verifier('pièce passée en définitive et marquée à signer', d.etat.provisoires === 0 && d.etat.a_signer === 1);

  d = (await appel('PUT', `/parcours/${id}/reponses`, {
    commun: { date_decision: '2026-09-30' },
    _registre: Object.fromEntries((registre?.champs || []).map((c) => [c.name, c.options ? c.options[0][0] : 'NANTERRE'])),
    '15M': { nouveau_capital: '50000' },
    '35M': { entrant_0: { nom: 'MARTIN', prenoms: 'Claire', genre: '2', date_naissance: '1985-05-05', lieu_naissance: 'Paris', code_insee_naissance: '75056', forme_sociale: '0', adresse: { numVoie: '10', typeVoie: 'RUE', voie: 'de la Paix', codePostal: '75002', commune: 'Paris' } } },
  })).corps;
  verifier('champs requis tous remplis', d.etat.champs_manquants.length === 0, d.etat.champs_manquants);
  verifier('dossier prêt à déposer', d.etat.pret === true, d.etat);

  const apercu = (await appel('GET', `/parcours/${id}/apercu`)).corps;
  const contenu = apercu.newFormality.content;
  verifier('une seule formalité de modification', apercu.newFormality.typeFormalite === 'M' && apercu.previousFormality);
  verifier('capital modifié avec son déclencheur et sa date', contenu.personneMorale.identite.description.montantCapital === 50000
    && contenu.personneMorale.identite.description.is15MTriggered === true
    && contenu.personneMorale.identite.description.dateEffet15M === '2026-09-30', contenu.personneMorale.identite.description);
  const pouvoirs = contenu.personneMorale.composition.pouvoirs;
  const nouvelle = pouvoirs.find((p) => p.individu?.descriptionPersonne?.nom === 'MARTIN');
  verifier('nouvelle présidente ajoutée (statut 1, rôle de président de SAS)', nouvelle && nouvelle.statutPourLaFormalite === '1' && nouvelle.is34Or35MAdjonctionTriggered, nouvelle);
  verifier('champs exigés par le guichet présents', contenu.personneMorale.identite.destinataireCorrespondance && apercu.newFormality.diffusionCommerciale === 'O');
  verifier('pièces jointes au contenu', contenu.piecesJointes.length === attendues.length, contenu.piecesJointes.length);

  const depot = await appel('POST', `/parcours/${id}/deposer`);
  verifier('dépôt effectué (simulé sans identifiants INPI)', depot.statut === 200 && depot.corps.inpi_id, depot.corps);
  verifier('dossier figé après dépôt', (await appel('PUT', `/parcours/${id}/reponses`, { commun: { date_decision: '2026-01-01' } })).statut === 409);

  console.log('\nOpération non encore déposable');
  const c2b = await appel('POST', '/parcours', { societe_id: 1, operations: ['11M'] });
  const d2 = (await appel('GET', `/parcours/${c2b.corps.id}`)).corps;
  verifier('transfert de siège signalé comme non déposable automatiquement', d2.etat.non_deposables.length === 1, d2.etat.non_deposables);
  try { construireParcours({ operations: ['11M'], fiche: {} }); verifier('refus explicite', false); } catch (e) { verifier('refus explicite à l’assemblage', /pas encore disponible/.test(e.message)); }

  instance.close();
  console.log(`\n${ok} vérification(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
})();
