'use strict';

/**
 * Essai de bout en bout sur l'application en production, par les mêmes
 * appels que les écrans : ouvrir un dossier, répondre aux questions, charger
 * chaque pièce demandée (PDF), compléter les informations, déposer au
 * guichet (serveur de démonstration de l'INPI), puis supprimer le dossier.
 *
 *   node scripts/essai-production.js [URL de l'application]
 */

const banc = require('./banc-guichet');

const APP = (process.argv[2] || 'https://legalize-rho.vercel.app').replace(/\/$/, '') + '/api';
const PDF = require('fs').readFileSync(require('path').join(__dirname, 'fixtures/piece-test.pdf'));

async function appel(methode, url, corps, form) {
  const r = await fetch(APP + url, {
    method: methode,
    headers: corps && !form ? { 'Content-Type': 'application/json' } : undefined,
    body: form || (corps ? JSON.stringify(corps) : undefined),
  });
  const json = await r.json().catch(() => null);
  return { statut: r.status, corps: json };
}

async function essai(nom, { operations, siren, typologie, reponses }) {
  const out = { essai: nom };
  const ouvert = await appel('POST', '/parcours', { operations, siren });
  if (ouvert.statut !== 201) return { ...out, erreur: ouvert.corps?.error };
  const id = ouvert.corps.id;
  let d = (await appel('PUT', `/parcours/${id}/typologie`, typologie)).corps;
  out.questions_sans_reponse = d.questions.filter((q) => q.valeur === null || q.valeur === undefined).map((q) => q.libelle);
  out.pieces_demandees = d.pieces.obligatoires.map((p) => p.court + (p.personne ? ` (${p.personne})` : ''));
  out.pieces_a_preciser = d.pieces.a_preciser.map((p) => p.court);
  out.pieces_facultatives = d.pieces.facultatives.map((p) => p.court);
  out.rubriques = d.champs.map((g) => `${g.titre} : ${g.champs.filter((c) => c.requis).length} obligatoire(s) sur ${g.champs.length}`);
  // Pièces « selon le cas » sans question : l'utilisateur indique qu'il n'est pas concerné.
  const manuel = Object.fromEntries(d.pieces.a_preciser.filter((p) => p.manuel).map((p) => [p.cle, false]));
  if (Object.keys(manuel).length) d = (await appel('PUT', `/parcours/${id}/typologie`, { manuel })).corps;
  for (const p of d.pieces.obligatoires) {
    const form = new FormData();
    form.append('cle', p.cle); form.append('code', p.code);
    form.append('fichier', new Blob([PDF], { type: 'application/pdf' }), `${p.code}.pdf`);
    d = (await appel('POST', `/parcours/${id}/pieces`, null, form)).corps;
  }
  d = (await appel('PUT', `/parcours/${id}/reponses`, reponses)).corps;
  out.manque_avant_depot = [...d.etat.champs_manquants, ...d.etat.pieces_manquantes];
  const depot = await appel('POST', `/parcours/${id}/deposer`);
  if (depot.statut === 200) {
    out.depot = { accepte: true, simule: depot.corps.simule, liasse: depot.corps.numero_liasse, statut: depot.corps.statut, montant: depot.corps.montant };
    const journal = await appel('GET', `/formalites/${id}`);
    out.alertes = (journal.corps?.evenements || []).filter((e) => /Attention/.test(e.message)).map((e) => e.message);
  } else {
    out.depot = { accepte: false, motif: depot.corps?.error, violations: depot.corps?.violations, details: depot.corps?.details };
  }
  const suppr = await appel('DELETE', `/formalites/${id}`);
  out.supprime = suppr.statut === 200 ? suppr.corps.message : suppr.corps?.error;
  return out;
}

(async () => {
  const fiche = null;
  const sarl = banc.creation('SARL', { siege: 'domiciliation' }).dossier;
  const sas = banc.creation('SAS', { entrants: [{ nom: 'HOLDING FICTIVE', nature: 'PM', fonction: '73' }, { nom: 'Paul MARTIN', nature: 'PP', fonction: '53' }] }).dossier;
  const modif = banc.modification(['15M', '35M'], fiche).dossier;
  const essais = [
    ['Création d’une SARL domiciliée, gérant travailleur non salarié', { operations: ['01M'], typologie: { ...sarl.typologie, domiciliataire_meme_greffe: true }, reponses: sarl.reponses }],
    ['Création d’une SAS présidée par une société, avec un directeur général', { operations: ['01M'], typologie: sas.typologie, reponses: sas.reponses }],
    ['Augmentation de capital et nomination d’un directeur général (société existante)', {
      operations: ['15M', '35M'], siren: banc.SIREN_DEMO,
      typologie: { ...modif.typologie, capital_sens: 'augmentation', capital_modalite: 'numeraire', statuts_modifies: false, manuel: { PJ_55: false } },
      reponses: { commun: modif.reponses.commun, '15M': modif.reponses['15M'], '35M': modif.reponses['35M'], _registre: modif.reponses._registre },
    }],
  ];
  // Formalités ajoutées : une par une, sur la même société de l'échantillon.
  const seule = (op, nom, typologie = {}) => [nom, { operations: [op], siren: banc.SIREN_DEMO, typologie: { ...typologie },
    reponses: { commun: modif.reponses.commun, _registre: modif.reponses._registre, [op]: modif.reponses[op] } }];
  essais.push(seule('28M', 'Dissolution par l’associé unique (TUP)'), seule('38F', 'Déclaration des bénéficiaires effectifs'),
    seule('60PMF', 'Nouvelle enseigne d’un établissement'), seule('80PMF', 'Fermeture d’un établissement'), seule('41M', 'Fusion : radiation de la société absorbée'));
  const filtre = process.env.FILTRE || '';
  const resultats = [];
  for (const [nom, e] of essais.filter(([n]) => n.includes(filtre))) {
    const r = await essai(nom, e);
    resultats.push(r);
    console.log(JSON.stringify(r, null, 1));
  }
  require('fs').writeFileSync(process.env.SORTIE || 'essai-production.json', JSON.stringify(resultats, null, 1));
})();
