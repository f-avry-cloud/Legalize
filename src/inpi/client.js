'use strict';

/**
 * Client HTTP commun aux deux API INPI.
 *
 * Responsabilités :
 *  - authentification SSO (POST {base}/api/sso/login → jeton porté en
 *    `Authorization: Bearer`) avec mise en cache du jeton par API ;
 *  - reconnexion automatique une fois sur 401/403 (jeton expiré) ;
 *  - délai maximal par appel et messages d'erreur exploitables côté métier
 *    (l'INPI renvoie volontiers du HTML ou un corps vide sur incident).
 */

const { config } = require('./config');

// Jeton par API : { token, obtenuA }. Durée de vie non documentée de façon
// stable → on renouvelle au bout d'une heure, et sur rejet 401/403.
const jetons = new Map();
const DUREE_JETON_MS = 55 * 60 * 1000;

class ErreurInpi extends Error {
  constructor(message, { status = 502, api, detail } = {}) {
    super(message);
    this.name = 'ErreurInpi';
    this.status = status;
    this.api = api;
    this.detail = detail;
  }
}

function url(cfg, chemin, params) {
  const u = new URL(chemin, cfg.baseUrl);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => u.searchParams.append(`${k}[]`, item));
    else u.searchParams.set(k, v);
  }
  return u.toString();
}

async function requete(cible, { methode = 'GET', chemin, params, corps, token, brut = false }) {
  const cfg = cible === 'rne' ? config.rne : config.guichet;
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), config.timeoutMs);
  let reponse;
  try {
    reponse = await fetch(url(cfg, chemin, params), {
      method: methode,
      headers: {
        Accept: brut ? '*/*' : 'application/json',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: controleur.signal,
    });
  } catch (e) {
    throw new ErreurInpi(
      e.name === 'AbortError'
        ? `L'API INPI (${cible}) n'a pas répondu en ${Math.round(config.timeoutMs / 1000)} s`
        : `API INPI (${cible}) injoignable : ${e.message}`,
      { status: 504, api: cible },
    );
  } finally {
    clearTimeout(minuteur);
  }

  if (brut && reponse.ok) return Buffer.from(await reponse.arrayBuffer());

  const texte = await reponse.text();
  let donnees = null;
  if (texte) { try { donnees = JSON.parse(texte); } catch { donnees = null; } }

  if (!reponse.ok) {
    const detail = donnees?.message || donnees?.detail || donnees?.['hydra:description']
      || (texte && texte.length < 300 ? texte : '');
    throw new ErreurInpi(`API INPI (${cible}) — ${reponse.status} ${reponse.statusText}${detail ? ` : ${detail}` : ''}`, {
      status: reponse.status === 404 ? 404 : (reponse.status >= 500 ? 502 : reponse.status),
      api: cible,
      detail: donnees,
    });
  }
  return donnees;
}

/** Jeton Bearer pour l'API demandée (login ou réutilisation du cache). */
async function jeton(cible, forcer = false) {
  const cfg = cible === 'rne' ? config.rne : config.guichet;
  const cache = jetons.get(cible);
  if (!forcer && cache && Date.now() - cache.obtenuA < DUREE_JETON_MS) return cache.token;
  if (!cfg.username || !cfg.password) {
    throw new ErreurInpi(`Identifiants INPI (${cible}) absents`, { status: 401, api: cible });
  }
  const rep = await requete(cible, {
    methode: 'POST',
    chemin: cfg.paths.login,
    corps: { username: cfg.username, password: cfg.password },
  });
  const token = rep?.token || rep?.access_token || rep?.jwt;
  if (!token) throw new ErreurInpi(`Authentification INPI (${cible}) : jeton absent de la réponse`, { status: 502, api: cible });
  jetons.set(cible, { token, obtenuA: Date.now() });
  return token;
}

/** Appel authentifié, avec une seule tentative de reconnexion sur 401/403. */
async function appel(cible, options) {
  let token = await jeton(cible);
  try {
    return await requete(cible, { ...options, token });
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e;
    token = await jeton(cible, true);
    return requete(cible, { ...options, token });
  }
}

/** Remplace les {jetons} d'un chemin paramétré. */
function chemin(modele, valeurs) {
  return modele.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(valeurs[k]));
}

function viderCache() { jetons.clear(); }

module.exports = { appel, requete, chemin, ErreurInpi, viderCache };
