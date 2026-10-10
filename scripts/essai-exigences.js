'use strict';

require('./session-essai').installer();

/**
 * Ce que l'INPI exige vraiment, établi par l'essai : on part d'un dossier
 * complet accepté, puis on retire UNE information à la fois et on redépose
 * sur le serveur de démonstration. Refus → l'information est exigée.
 * Chaque dossier accepté est supprimé aussitôt.
 *
 *   node scripts/essai-exigences.js creation-SAS
 *   node scripts/essai-exigences.js modification-35M
 *
 * Résultat écrit en JSON dans le fichier indiqué en second argument.
 */

const fs = require('fs');
const { construireParcours } = require('../src/inpi/payload-parcours');
const { normaliserEntreprise } = require('../src/inpi/normalize');
const banc = require('./banc-guichet');

/** Toutes les feuilles d'un objet de réponses, sous forme de chemins. */
function feuilles(o, chemin = []) {
  if (o === null || o === undefined || typeof o !== 'object') return [chemin];
  if (Array.isArray(o) && o.every((x) => typeof x !== 'object')) return [chemin];
  return Object.entries(o).flatMap(([k, v]) => feuilles(v, [...chemin, k]));
}

function sans(objet, chemin) {
  const copie = JSON.parse(JSON.stringify(objet));
  let o = copie;
  for (const k of chemin.slice(0, -1)) o = o[k];
  delete o[chemin[chemin.length - 1]];
  return copie;
}

async function deposer(endpoint, dossier) {
  let corps;
  try { ({ corps } = construireParcours(dossier)); } catch (e) { return { bloque_par_l_outil: e.message }; }
  const r = await banc.sonde({ methode: 'POST', chemin: endpoint, corps });
  const f = r.reponse?.formalities?.[0] || (r.ok ? r.reponse : null);
  if (r.ok && f?.id) {
    await banc.sonde({ methode: 'DELETE', chemin: `/api/formalities/${f.id}` });
    return { accepte: true };
  }
  return { accepte: false, motifs: (r.reponse?.violations || []).map((v) => v.message).slice(0, 3), message: r.reponse?.violations ? undefined : r.message };
}

(async () => {
  const [nom = 'creation-SAS', sortie = 'exigences.json'] = process.argv.slice(2);
  let fiche = null;
  if (nom.startsWith('modification')) {
    const brut = (await banc.sonde({ api: 'rne', chemin: `/api/companies/${banc.SIREN_DEMO}` })).reponse;
    fiche = { ...normaliserEntreprise(brut), brut };
  }
  const scen = nom === 'creation-SAS' ? banc.creation('SAS')
    : nom === 'creation-SARL' ? banc.creation('SARL')
      : banc.modification(['35M'], fiche);
  const base = scen.dossier;
  // Ne garder que les réponses utiles à l'opération testée.
  if (nom.startsWith('modification')) base.reponses = { commun: base.reponses.commun, _registre: base.reponses._registre, '35M': base.reponses['35M'] };

  const reference = await deposer(scen.endpoint, base);
  const resultats = { scenario: nom, dossier_complet: reference, essais: [] };
  console.log(`dossier complet : ${reference.accepte ? 'accepté' : 'REFUSÉ'}`);
  if (!reference.accepte) { fs.writeFileSync(sortie, JSON.stringify(resultats, null, 1)); return; }

  const chemins = feuilles(base.reponses).filter((c) => c[0] !== '_registre');
  // Retirer aussi les blocs entiers qui ont un sens pour l'utilisateur.
  for (const bloc of [['c_be', 'beneficiaires'], ['c_publication'], ['c_fiscal']]) {
    if (bloc.reduce((o, k) => o?.[k], base.reponses) !== undefined) chemins.push(bloc);
  }
  for (const chemin of chemins) {
    const r = await deposer(scen.endpoint, { ...base, reponses: sans(base.reponses, chemin) });
    resultats.essais.push({ retire: chemin.join('.'), ...r });
    console.log(`${r.accepte ? 'accepté sans' : r.bloque_par_l_outil ? 'outil bloque' : 'REFUSÉ sans'} : ${chemin.join('.')}${r.motifs?.length ? ` — ${r.motifs[0]}` : ''}`);
    fs.writeFileSync(sortie, JSON.stringify(resultats, null, 1));
  }
  const restants = (await banc.sonde({ methode: 'GET', chemin: '/api/formalities' })).reponse || [];
  for (const x of restants) await banc.sonde({ methode: 'DELETE', chemin: `/api/formalities/${x.id}` });
})();
