'use strict';

/**
 * Secrets du connecteur Claude.
 *
 * Deux usages, une seule variable d'environnement (CONNECTEUR_SECRET) :
 *  1. l'URL du connecteur contient ce secret : c'est la clé d'accès aux
 *     outils (les connecteurs personnalisés de Claude acceptent une URL, pas
 *     d'en-tête d'authentification arbitraire) ;
 *  2. il signe les liens de dépôt des pièces, valables quelques jours, que
 *     l'avocat ouvre depuis son téléphone ou son ordinateur.
 *
 * Sans secret configuré (ou s'il est trop court), le connecteur est fermé.
 */

const crypto = require('crypto');

const LONGUEUR_MINIMALE = 32;

function secret() {
  const s = process.env.CONNECTEUR_SECRET || '';
  return s.length >= LONGUEUR_MINIMALE ? s : '';
}

const actif = () => Boolean(secret());

/** Comparaison à temps constant, quelle que soit la longueur du candidat. */
function secretValide(candidat) {
  const s = secret();
  if (!s || typeof candidat !== 'string') return false;
  const a = crypto.createHash('sha256').update(candidat).digest();
  const b = crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(a, b);
}

// Clé dérivée : un lien de dépôt ne révèle rien du secret de l'URL.
const cleLiens = () => crypto.createHmac('sha256', secret()).update('liens-pieces').digest();

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Jeton signé, opaque pour le navigateur : { ...donnees, exp } . signature. */
function signer(donnees, dureeSecondes) {
  if (!actif()) throw new Error('Connecteur non configuré (CONNECTEUR_SECRET).');
  const corps = b64url(JSON.stringify({ ...donnees, exp: Math.floor(Date.now() / 1000) + dureeSecondes }));
  const sig = b64url(crypto.createHmac('sha256', cleLiens()).update(corps).digest());
  return `${corps}.${sig}`;
}

/** Contenu d'un jeton valide et non expiré, sinon null. */
function verifier(jeton) {
  if (!actif() || typeof jeton !== 'string' || !jeton.includes('.')) return null;
  const [corps, sig] = jeton.split('.');
  const attendu = crypto.createHmac('sha256', cleLiens()).update(corps).digest();
  let recu;
  try { recu = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (recu.length !== attendu.length || !crypto.timingSafeEqual(recu, attendu)) return null;
  let donnees;
  try { donnees = JSON.parse(Buffer.from(corps, 'base64url').toString('utf8')); } catch { return null; }
  if (!donnees.exp || donnees.exp < Math.floor(Date.now() / 1000)) return null;
  return donnees;
}

/** Référence de dossier courte et non devinable (ex. « GU-7K3Q9MZT »). */
function nouvelleReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const octets = crypto.randomBytes(8);
  return `GU-${Array.from(octets, (o) => alphabet[o % alphabet.length]).join('')}`;
}

const REFERENCE = /^GU-[A-Z2-9]{8}$/;

module.exports = { actif, secretValide, signer, verifier, nouvelleReference, REFERENCE, LONGUEUR_MINIMALE };
