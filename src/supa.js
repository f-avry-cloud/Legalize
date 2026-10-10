'use strict';

/**
 * Client Supabase partagé (Postgres via PostgREST + Storage).
 *
 * La clé « publishable » est publique par conception : seule, elle n'ouvre
 * plus rien. Chaque requête de l'application parle à la base au nom de
 * l'utilisateur connecté (son jeton de session accompagne chaque appel), et
 * les règles d'accès de la base n'ouvrent les données qu'aux membres du
 * cabinet authentifiés par double authentification (voir
 * scripts/schema-auth.sql).
 *
 * `supabase` reste importable tel quel partout : c'est un relais vers le
 * client de la requête en cours (AsyncLocalStorage). Hors requête — scripts —
 * il retombe sur le client anonyme, donc sans accès aux données.
 */

const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvvijjmfxwlukhkdrzua.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_rcjhxdbE0IJySerBbAwcPg_FU7bpzum';

const OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/** Client anonyme : vérification des jetons, et rien d'autre. */
const anonyme = createClient(SUPABASE_URL, SUPABASE_KEY, OPTIONS);

/** Client qui agit au nom de l'utilisateur porteur du jeton. */
function clientPour(jeton) {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    ...OPTIONS,
    global: { headers: { Authorization: `Bearer ${jeton}` } },
  });
}

const contexte = new AsyncLocalStorage();

/** Exécute la suite de la requête avec le client et l'utilisateur donnés. */
function dansContexte(valeurs, suite) {
  return contexte.run(valeurs, suite);
}

const courant = () => contexte.getStore()?.client || anonyme;

const supabase = new Proxy({}, {
  get(_, cle) {
    const c = courant();
    const v = c[cle];
    return typeof v === 'function' ? v.bind(c) : v;
  },
});

/**
 * Un middleware qui rend la main depuis un flux (réception de fichier) perd le
 * contexte de la requête : la suite partirait sans session. On rattache sa
 * continuation au contexte d'origine.
 */
function garderContexte(middleware) {
  return (req, res, next) => middleware(req, res, AsyncResource.bind(next));
}

/** L'utilisateur connecté pour la requête en cours (null hors requête). */
const utilisateurCourant = () => contexte.getStore()?.utilisateur || null;

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

/** Retire des fichiers du bucket ; un fichier déjà absent n'est pas une erreur. */
async function removeFiles(paths) {
  const liste = [...new Set((paths || []).filter(Boolean))];
  for (let i = 0; i < liste.length; i += 100) {
    const { error } = await supabase.storage.from(BUCKET).remove(liste.slice(i, i + 100));
    if (error) throw new Error(`Stockage : ${error.message}`);
  }
  return liste.length;
}

module.exports = {
  supabase, q, qCount, uploadFile, downloadFile, removeFiles, BUCKET,
  SUPABASE_URL, SUPABASE_KEY, anonyme, clientPour, dansContexte, garderContexte, utilisateurCourant,
};
