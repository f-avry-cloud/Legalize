'use strict';

/**
 * Suppression d'une société, en connaissance de cause.
 *
 * Supprimer une société efface en cascade ses dirigeants, associés,
 * opérations (documents et factures compris) et tout son registre des
 * mouvements de titres, extraits certifiés inclus. Les formalités sont
 * conservées, détachées de la société : un dépôt reste tracé.
 *
 * D'où deux temps : un aperçu de ce qui disparaîtra, puis la suppression,
 * confirmée en retapant la dénomination. L'effacement suit un ordre explicite,
 * parce que certains liens du registre interdisent la suppression en cascade
 * d'un seul coup ; les fichiers stockés sont retirés à la fin.
 */

const { supabase, q, removeFiles } = require('../supa');

/** Lignes d'une table, ou rien si la table n'existe pas (module non installé). */
async function lignes(table, colonne, valeur, champs = '*') {
  try {
    return await q(supabase.from(table).select(champs).eq(colonne, valeur));
  } catch (e) {
    if (/does not exist|schema cache/i.test(e.message || '')) return [];
    throw e;
  }
}

async function effacer(table, colonne, valeur) {
  try {
    await q(supabase.from(table).delete().eq(colonne, valeur).select('id'));
  } catch (e) {
    if (/does not exist|schema cache/i.test(e.message || '')) return;
    throw e;
  }
}

/** Ce que la suppression emporterait, et ce qu'elle laisserait. */
async function impact(id) {
  const societe = await q(supabase.from('societes').select('*').eq('id', id).single());
  const [dirigeants, associes, operations, formalites, participations, mouvements, extraits] = await Promise.all([
    lignes('dirigeants', 'societe_id', id, 'id'),
    lignes('associes', 'societe_id', id, 'id'),
    lignes('operations', 'societe_id', id, 'id'),
    lignes('formalites', 'societe_id', id, 'id, statut'),
    lignes('associes', 'societe_liee_id', id, 'id, societe_id'),
    lignes('rmt_mouvements', 'societe_id', id, 'id'),
    lignes('rmt_extraits', 'societe_id', id, 'id, statut'),
  ]);
  let documents = 0;
  let factures = 0;
  for (const o of operations) {
    documents += (await lignes('documents', 'operation_id', o.id, 'id')).length;
    factures += (await lignes('factures', 'operation_id', o.id, 'id')).length;
  }
  return {
    id: societe.id,
    denomination: societe.denomination,
    supprime: {
      dirigeants: dirigeants.length,
      associes: associes.length,
      operations: operations.length,
      documents,
      factures,
      ecritures_registre: mouvements.length,
      extraits_certifies: extraits.length,
    },
    conserve: {
      formalites: formalites.length,
      participations: participations.length,
    },
  };
}

function normaliser(texte) {
  return String(texte || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

async function supprimerSociete(id, { confirmation } = {}) {
  const avant = await impact(id);
  if (normaliser(confirmation) !== normaliser(avant.denomination)) {
    throw Object.assign(new Error('Confirmation incorrecte : retapez la dénomination exacte de la société.'), { status: 422 });
  }

  // Fichiers à retirer du stockage une fois les lignes effacées.
  const chemins = [];
  for (const o of await lignes('operations', 'societe_id', id, 'id')) {
    for (const d of await lignes('documents', 'operation_id', o.id, 'id')) {
      chemins.push(...(await lignes('document_versions', 'document_id', d.id, 'filepath')).map((v) => v.filepath));
    }
  }
  chemins.push(...(await lignes('rmt_justificatifs', 'societe_id', id, 'chemin')).map((j) => j.chemin));
  chemins.push(...(await lignes('rmt_extraits', 'societe_id', id, 'pdf_chemin')).map((x) => x.pdf_chemin));

  // Registre des mouvements de titres : des écritures vers les comptes et
  // catégories, dans l'ordre que les liens imposent.
  for (const table of [
    'rmt_alertes_acquittees', 'rmt_mouvements', 'rmt_extraits', 'rmt_mentions', 'rmt_justificatifs',
    'rmt_comptes', 'rmt_titulaires', 'rmt_categories', 'rmt_societes',
  ]) await effacer(table, 'societe_id', id);

  // Les formalités restent : elles sont seulement détachées.
  await q(supabase.from('formalites').update({ societe_id: null }).eq('societe_id', id).select('id'));
  // Les participations d'autres sociétés gardent leur dénomination, sans le lien.
  try {
    await q(supabase.from('associes').update({ societe_liee_id: null }).eq('societe_liee_id', id).select('id'));
  } catch (e) { if (!/does not exist/i.test(e.message || '')) throw e; }

  await q(supabase.from('societes').delete().eq('id', id).select('id'));

  let fichiers = 0;
  try { fichiers = await removeFiles(chemins); } catch { /* un fichier orphelin ne doit pas faire échouer la suppression */ }
  return { ok: true, ...avant, fichiers_retires: fichiers };
}

module.exports = { impact, supprimerSociete };
