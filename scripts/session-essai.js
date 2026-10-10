'use strict';

/**
 * Session d'essai pour les scripts de test qui appellent l'application.
 *
 * L'API exige désormais la session d'un membre du cabinet, double
 * authentification faite. Les scripts s'identifient avec un compte d'essai :
 *   LEGALIZE_ESSAI_EMAIL, LEGALIZE_ESSAI_MDP, LEGALIZE_ESSAI_TOTP (secret de
 *   l'application d'authentification, affiché par scripts/test-acces.js au
 *   premier passage).
 * `installer()` ajoute alors la session à chaque appel de l'API ; sans compte
 * d'essai, les appels partent sans session et sont refusés.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_KEY } = require('../src/supa');

/** Code à six chiffres (RFC 6238), comme une application d'authentification. */
function totp(secretBase32, decalage = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretBase32.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const cle = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + decalage));
  const h = crypto.createHmac('sha1', cle).update(compteur).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/**
 * fetch sur une seule connexion maintenue ouverte. Le service d'authentification
 * exige que la demande de code et sa vérification viennent de la même adresse
 * IP ; derrière un proxy dont l'adresse de sortie change à chaque connexion,
 * seule une connexion unique la garantit.
 */
const https = require('https');
const agentUnique = new https.Agent({ keepAlive: true, maxSockets: 1 });
function fetchConnexionUnique(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = options.headers instanceof Headers ? Object.fromEntries(options.headers.entries()) : { ...(options.headers || {}) };
    const req = https.request(url, { method: options.method || 'GET', headers, agent: agentUnique }, (r) => {
      const morceaux = [];
      r.on('data', (c) => morceaux.push(c));
      r.on('end', () => resolve(new Response(r.statusCode === 204 ? null : Buffer.concat(morceaux), { status: r.statusCode, headers: r.headers })));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

let jetonEnCours = null;

/** Jeton d'une session complète (mot de passe + code) du compte d'essai. */
function jeton() {
  if (!jetonEnCours) {
    jetonEnCours = (async () => {
      const { LEGALIZE_ESSAI_EMAIL: email, LEGALIZE_ESSAI_MDP: mdp, LEGALIZE_ESSAI_TOTP: secret } = process.env;
      if (!email || !mdp || !secret) throw new Error('Compte d’essai incomplet : LEGALIZE_ESSAI_EMAIL, LEGALIZE_ESSAI_MDP, LEGALIZE_ESSAI_TOTP.');
      const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchConnexionUnique } });
      const { error } = await client.auth.signInWithPassword({ email, password: mdp });
      if (error) throw new Error(`Connexion du compte d’essai : ${error.message}`);
      const { data: f } = await client.auth.mfa.listFactors();
      if (!f.totp[0]) throw new Error('Le compte d’essai n’a pas d’application d’authentification : lancer scripts/test-acces.js.');
      const { error: e2 } = await client.auth.mfa.challengeAndVerify({ factorId: f.totp[0].id, code: totp(secret) });
      if (e2) throw new Error(`Code du compte d’essai refusé : ${e2.message}`);
      const { data } = await client.auth.getSession();
      agentUnique.destroy();
      return data.session.access_token;
    })();
  }
  return jetonEnCours;
}

/** Ajoute la session d'essai aux appels de l'API de l'application (fetch global). */
function installer() {
  if (!process.env.LEGALIZE_ESSAI_EMAIL || globalThis.fetch.sessionEssai) return;
  const origine = globalThis.fetch;
  const avecSession = async (url, options = {}) => {
    const adresse = new URL(String(url instanceof Request ? url.url : url));
    if (!adresse.pathname.startsWith('/api/') || adresse.hostname.endsWith('supabase.co')) return origine(url, options);
    const headers = new Headers(options.headers || {});
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${await jeton()}`);
    return origine(url, { ...options, headers });
  };
  avecSession.sessionEssai = true;
  globalThis.fetch = avecSession;
}

module.exports = { totp, fetchConnexionUnique, agentUnique, jeton, installer };
