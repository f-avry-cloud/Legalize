'use strict';

/**
 * Stockage temporaire des pièces d'un dossier du connecteur.
 *
 * L'avocat téléverse ses PDF depuis la page de dépôt ; ils attendent ici
 * l'enregistrement de la formalité, puis sont effacés dès que le Guichet
 * unique les a reçus. Rien n'est conservé au-delà.
 *
 *  - Production : un bucket Supabase PRIVÉ (CONNECTEUR_BUCKET, par défaut
 *    « connecteur-pieces »), manipulé avec la clé secrète du projet
 *    (SUPABASE_SECRET_KEY), côté serveur uniquement. Le navigateur n'y écrit
 *    que par une URL de téléversement signée, à usage unique, émise pour un
 *    fichier précis : il ne voit jamais la clé.
 *  - Tests : CONNECTEUR_STOCKAGE=memoire, une Map en mémoire.
 *
 * Arborescence : <référence du dossier>/<code pièce>__<horodatage>__<nom>.pdf
 */

const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.CONNECTEUR_BUCKET || 'connecteur-pieces';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvvijjmfxwlukhkdrzua.supabase.co';

const enMemoire = () => process.env.CONNECTEUR_STOCKAGE === 'memoire';
const memoire = new Map();

let client = null;
function supa() {
  if (!process.env.SUPABASE_SECRET_KEY) {
    throw Object.assign(new Error('Stockage des pièces non configuré : renseigner SUPABASE_SECRET_KEY.'), { status: 503 });
  }
  if (!client) {
    client = createClient(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return client;
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw Object.assign(new Error(`Stockage des pièces : ${error.message}`), { status: 502 });
  return data;
}

const configure = () => enMemoire() || Boolean(process.env.SUPABASE_SECRET_KEY);

/** Nom de fichier sûr et lisible. */
function nomSur(nom) {
  const base = String(nom || 'piece.pdf').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(-80);
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

function cheminPiece(reference, code, nom) {
  return `${reference}/${code}__${Date.now()}__${nomSur(nom)}`;
}

/** Décompose un chemin en { code, nom }. */
function lireChemin(chemin) {
  const fichier = chemin.split('/').pop();
  const [code, , ...reste] = fichier.split('__');
  return { code, nom: reste.join('__') || fichier };
}

/**
 * Moyen de téléverser un fichier donné.
 * @returns {{ mode: 'signe', url: string } | { mode: 'memoire' }}
 */
async function urlTeleversement(chemin) {
  if (enMemoire()) return { mode: 'memoire' };
  const data = await q(supa().storage.from(BUCKET).createSignedUploadUrl(chemin));
  return { mode: 'signe', url: data.signedUrl };
}

/** Écriture directe (tests, et repli serveur). */
async function ecrire(chemin, buffer) {
  if (enMemoire()) { memoire.set(chemin, Buffer.from(buffer)); return; }
  await q(supa().storage.from(BUCKET).upload(chemin, buffer, { contentType: 'application/pdf', upsert: true }));
}

/** Pièces reçues pour un dossier : [{ chemin, code, nom, taille, date }]. */
async function lister(reference) {
  if (enMemoire()) {
    return [...memoire.entries()].filter(([c]) => c.startsWith(`${reference}/`))
      .map(([chemin, buf]) => ({ chemin, ...lireChemin(chemin), taille: buf.length, date: null }));
  }
  const data = await q(supa().storage.from(BUCKET).list(reference, { limit: 100, sortBy: { column: 'name', order: 'asc' } }));
  return (data || []).filter((f) => f.id).map((f) => {
    const chemin = `${reference}/${f.name}`;
    return { chemin, ...lireChemin(chemin), taille: f.metadata?.size ?? null, date: f.created_at || null };
  });
}

async function lire(chemin) {
  if (enMemoire()) return memoire.get(chemin) || null;
  const blob = await q(supa().storage.from(BUCKET).download(chemin));
  return Buffer.from(await blob.arrayBuffer());
}

async function supprimer(chemins) {
  if (!chemins.length) return;
  if (enMemoire()) { chemins.forEach((c) => memoire.delete(c)); return; }
  await q(supa().storage.from(BUCKET).remove(chemins));
}

module.exports = {
  BUCKET, configure, cheminPiece, lireChemin, urlTeleversement, ecrire, lister, lire, supprimer, nomSur,
  _memoire: memoire,
};
