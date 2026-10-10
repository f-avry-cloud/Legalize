'use strict';

/**
 * Contrôle d'accès de l'API.
 *
 * Toute requête doit porter la session d'un membre du cabinet :
 *   — le jeton est vérifié (signature, expiration) ;
 *   — la double authentification doit avoir été faite (code à usage unique,
 *     ou connexion Microsoft, dont la politique de sécurité s'applique) ;
 *   — l'adresse doit figurer, active, dans la liste des membres
 *     (table `utilisateurs`).
 * La base applique les mêmes règles de son côté (scripts/schema-auth.sql) :
 * même une faille ici ne donnerait pas accès aux données.
 *
 * Le jeton arrive dans l'en-tête Authorization. Pour les liens de
 * téléchargement (balises <a>), qui ne peuvent pas porter d'en-tête, il est
 * aussi lu dans un cookie — pour les lectures seulement : une écriture exige
 * l'en-tête, ce qui ferme la porte aux requêtes forgées depuis un autre site.
 */

const { anonyme, clientPour, dansContexte } = require('./supa');

const COOKIE = 'lz_jeton';

/** Accessibles sans session : rien qui touche aux données. */
const PUBLIQUES = new Set(['/version']);

function lireCookie(req, nom) {
  const brut = req.headers.cookie || '';
  for (const morceau of brut.split(';')) {
    const i = morceau.indexOf('=');
    if (i > 0 && morceau.slice(0, i).trim() === nom) return decodeURIComponent(morceau.slice(i + 1).trim());
  }
  return null;
}

function jetonDe(req) {
  const entete = req.get('authorization') || '';
  if (/^bearer /i.test(entete)) return entete.slice(7).trim();
  if (req.method === 'GET' || req.method === 'HEAD') return lireCookie(req, COOKIE);
  return null;
}

/** Double authentification faite : code à usage unique, ou fournisseur d'identité (Microsoft). */
function doubleAuthentification(claims) {
  if (claims.aal === 'aal2') return true;
  return (claims.amr || []).some((m) => ['oauth', 'sso/saml'].includes(m?.method));
}

// Membres déjà vérifiés, par jeton, pour une minute : évite un aller-retour
// vers la base à chaque appel d'un même écran.
const VERIFIES = new Map();
const DUREE = 60 * 1000;

function refus(res, statut, code, message) {
  return res.status(statut).json({ error: message, code });
}

async function exigerConnexion(req, res, next) {
  if (PUBLIQUES.has(req.path)) return next();
  const jeton = jetonDe(req);
  if (!jeton) return refus(res, 401, 'non_connecte', 'Connexion requise.');

  const connu = VERIFIES.get(jeton);
  if (connu && connu.expire > Date.now()) {
    return dansContexte({ client: clientPour(jeton), utilisateur: connu.utilisateur, jeton }, next);
  }

  const { data, error } = await anonyme.auth.getClaims(jeton);
  const claims = data?.claims;
  if (error || !claims?.sub) return refus(res, 401, 'session_expiree', 'Session expirée : reconnectez-vous.');
  if (!doubleAuthentification(claims)) {
    return refus(res, 401, 'double_authentification', 'Saisissez le code de votre application d’authentification.');
  }

  const client = clientPour(jeton);
  const { data: lignes, error: e2 } = await client.from('utilisateurs')
    .select('id, email, nom, prenom, role').ilike('email', claims.email || '').eq('actif', true).limit(1);
  if (e2) return refus(res, 503, 'base_indisponible', `Base de données indisponible : ${e2.message}`);
  const utilisateur = lignes?.[0];
  if (!utilisateur || utilisateur.role === 'client') {
    return refus(res, 403, 'non_autorise', `L’adresse ${claims.email || ''} n’est pas autorisée à accéder au cabinet.`);
  }

  if (VERIFIES.size > 500) VERIFIES.clear();
  VERIFIES.set(jeton, { utilisateur, expire: Math.min(Date.now() + DUREE, (claims.exp || 0) * 1000) });
  return dansContexte({ client, utilisateur, jeton }, next);
}

module.exports = { exigerConnexion, doubleAuthentification, COOKIE };
