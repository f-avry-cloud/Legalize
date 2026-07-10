'use strict';

/**
 * Client Supabase partagé (Postgres via PostgREST + Storage).
 *
 * La clé « publishable » est publique par conception (équivalent de la clé
 * anon exposée aux navigateurs dans toute app Supabase) ; les valeurs par
 * défaut ci-dessous pointent le projet de démo et sont surchargeables par
 * SUPABASE_URL / SUPABASE_KEY. Posture démo : accès complet sans
 * authentification — à durcir (Supabase Auth + RLS) avant d'y mettre de
 * vrais dossiers clients.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvvijjmfxwlukhkdrzua.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_rcjhxdbE0IJySerBbAwcPg_FU7bpzum';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BUCKET = 'documents';

/** Déballe une réponse supabase-js : retourne data, lève une erreur HTTP sinon. */
async function q(promise) {
  const { data, error } = await promise;
  if (error) {
    const e = new Error(error.message || 'Erreur base de données');
    e.status = /not.*found|0 rows/i.test(e.message) ? 404 : 500;
    throw e;
  }
  return data;
}

/** Variante avec count (select(..., { count: 'exact' })). */
async function qCount(promise) {
  const { count, error } = await promise;
  if (error) throw new Error(error.message);
  return count || 0;
}

/** Dépose un fichier dans le bucket documents. */
async function uploadFile(path, buffer, contentType) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType, upsert: true,
  });
  if (error) throw new Error(`Stockage : ${error.message}`);
}

/** Télécharge un fichier du bucket documents (Buffer). */
async function downloadFile(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) {
    const e = new Error(`Fichier introuvable dans le stockage : ${error.message}`);
    e.status = 404;
    throw e;
  }
  return Buffer.from(await data.arrayBuffer());
}

module.exports = { supabase, q, qCount, uploadFile, downloadFile, BUCKET };
