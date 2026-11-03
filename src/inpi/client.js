'use strict';

/**
 * Client HTTP des deux API INPI.
 *
 * Authentification — point central du connecteur : l'INPI ne distribue pas de
 * clé d'API. On poste l'identifiant (e-mail) et le mot de passe du compte, et
 * le service répond par un jeton JWT de session, soit dans un cookie `BEARER`,
 * soit dans le corps de la réponse selon l'API et le type de compte. Le jeton
 * est mis en cache, renvoyé à la fois en en-tête `Authorization: Bearer` et en
 * cookie (le contrat d'interface accepte les deux), puis renouvelé
 * automatiquement dès qu'un appel est rejeté en 401/403.
 *
 * Les mots de passe ne servent qu'à cet appel de connexion et ne sont jamais
 * journalisés ni renvoyés au frontend.
 */

const { config } = require('./config');

// Jeton par API : { token, obtenuA, expireA }.
const jetons = new Map();
const DUREE_JETON_DEFAUT_MS = 50 * 60 * 1000;

class ErreurInpi extends Error {
  constructor(message, { status = 502, api, detail, code } = {}) {
    super(message);
    this.name = 'ErreurInpi';
    this.status = status;
    this.api = api;
    this.detail = detail;
    this.codeInpi = code || null;
  }
}

function cfgDe(cible) {
  return cible === 'rne' ? config.rne : config.guichet;
}

function url(cfg, chemin, params) {
  const u = new URL(chemin, cfg.baseUrl);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    // Les filtres tableau du Guichet unique s'écrivent `status[]=A&status[]=B`.
    if (Array.isArray(v)) v.forEach((item) => u.searchParams.append(`${k}[]`, item));
    else u.searchParams.set(k, v);
  }
  return u.toString();
}

/** Extrait le JWT d'un `Set-Cookie: BEARER=…`. */
function jetonDepuisCookies(reponse) {
  const brut = typeof reponse.headers.getSetCookie === 'function'
    ? reponse.headers.getSetCookie()
    : [reponse.headers.get('set-cookie')].filter(Boolean);
  for (const cookie of brut) {
    const m = /(?:^|;\s*)BEARER=([^;]+)/i.exec(cookie);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

/** Date d'expiration lue dans le JWT lui-même, si elle s'y trouve. */
function expirationDuJeton(token) {
  try {
    const charge = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return charge.exp ? charge.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function requete(cible, options) {
  const debut = Date.now();
  try {
    const r = await requeteBrute(cible, options);
    await tracer(cible, options, { statut: r.reponse?.status ?? null, duree: Date.now() - debut, donnees: r.donnees });
    return r;
  } catch (e) {
    await tracer(cible, options, { statut: e.httpStatus ?? e.status ?? null, duree: Date.now() - debut, erreur: e });
    throw e;
  }
}

async function requeteBrute(cible, { methode = 'GET', chemin, params, corps, token, brut = false, accept }) {
  const cfg = cfgDe(cible);
  const controleur = new AbortController();
  const minuteur = setTimeout(() => controleur.abort(), config.timeoutMs);
  let reponse;
  try {
    reponse = await fetch(url(cfg, chemin, params), {
      method: methode,
      headers: {
        Accept: accept || (brut ? '*/*' : 'application/json'),
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}`, Cookie: `BEARER=${token}` } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
      signal: controleur.signal,
      redirect: 'follow',
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

  if (brut) {
    if (reponse.ok) return { donnees: Buffer.from(await reponse.arrayBuffer()), reponse };
    // On relit le corps en texte pour produire un message exploitable.
  }

  const texte = await reponse.text();
  let donnees = null;
  if (texte) { try { donnees = JSON.parse(texte); } catch { donnees = null; } }

  if (!reponse.ok) throw erreurDeReponse(cible, reponse, donnees, texte);
  return { donnees, reponse };
}

/**
 * Une erreur renvoyée par un intermédiaire réseau (proxy d'entreprise,
 * pare-feu, passerelle) se présente comme une erreur de l'API alors qu'elle
 * n'a jamais atteint l'INPI. La confondre avec un refus d'habilitation
 * enverrait chercher le problème au mauvais endroit.
 */
function erreurIntermediaire(reponse, donnees, texte) {
  if (donnees) return null; // un corps JSON exploitable vient bien de l'API
  if (reponse.status === 407) return texte || 'authentification du proxy requise';
  const signature = /allowlist|egress|proxy|firewall|pare-feu|blocked by|not permitted by/i;
  if ((reponse.status === 403 || reponse.status === 502 || reponse.status === 503)
    && texte && signature.test(texte)) return texte.trim().slice(0, 200);
  return null;
}

/** Message d'erreur lisible à partir des formats d'erreur du Guichet unique. */
function erreurDeReponse(cible, reponse, donnees, texte) {
  const intermediaire = erreurIntermediaire(reponse, donnees, texte);
  if (intermediaire) {
    return new ErreurInpi(
      `Accès réseau bloqué avant d'atteindre l'INPI (${cible}) : ${intermediaire}`,
      { status: 504, api: cible, detail: donnees, code: 'RESEAU_INTERMEDIAIRE' },
    );
  }

  const detail = donnees?.message
    || donnees?.detail
    || donnees?.['hydra:description']
    || donnees?.error?.message
    || (Array.isArray(donnees?.violations)
      ? donnees.violations.map((v) => `${v.propertyPath} : ${v.message}`).join(' ; ')
      : '')
    || (texte && texte.length < 400 && !/^\s*</.test(texte) ? texte : '');

  const status = reponse.status === 404 ? 404
    : (reponse.status === 422 || reponse.status === 400 ? 422 : (reponse.status >= 500 ? 502 : reponse.status));

  let message = `API INPI (${cible}) — ${reponse.status} ${reponse.statusText}${detail ? ` : ${detail}` : ''}`;
  if (reponse.status === 401) {
    message += '. Vérifier l’identifiant et le mot de passe du compte, et que les conditions particulières '
      + 'd’utilisation ont bien été acceptées lors d’une première connexion à l’interface web.';
  }
  const erreur = new ErreurInpi(message, {
    status, api: cible, detail: donnees, code: donnees?.id || donnees?.code || null,
  });
  // Statut HTTP d'origine, pour les traces (status est ramené à 404/422/502).
  erreur.httpStatus = reponse.status;
  return erreur;
}

/* --------------------------------------------------------------- traces */

/*
 * Traces des échanges avec le guichet, sans données personnelles : méthode,
 * chemin, statut, durée, et la forme de la requête et de la réponse (clés,
 * identifiants, statuts, codes et tailles des pièces ; jamais un nom, une
 * adresse, un contenu de fichier ni un jeton). Vercel ne garde qu'une heure de
 * journaux : sans elles, un comportement du guichet ne se diagnostique pas
 * après coup (constaté le 3/11 sur LGZ-2026-00052). Table guichet_traces,
 * lisible avec la clé de service seulement, purgée au-delà de 30 jours.
 */
const CLES_SIMPLES = /^(@id|@type|id|status|statut|state|etat|liasseNumber|numeroLiasse|numeroNational|typeDocument|typeFormalite|typePersonne|documentExtension|langueDocument|created|updated|statusDate|size|removed|deleted|valid|invalid|isRemoved|isDeleted|isValid|hydra:totalItems|totalItems)$/i;
const RETENTION_TRACES_JOURS = 30;

/** Champs simples et sans donnée personnelle d'un objet du guichet. */
function champsSimples(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o)) {
    if (CLES_SIMPLES.test(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) out[k] = typeof v === 'string' ? v.slice(0, 80) : v;
  }
  return out;
}

const koBase64 = (b) => (typeof b === 'string' ? Math.round((b.length * 3) / 4 / 1024) : null);

/** Forme d'un corps de requête : clés et pièces (type, taille), sans aucune valeur saisie. */
function resumeCorps(corps) {
  if (!corps || typeof corps !== 'object') return null;
  const contenu = corps.content || corps.newFormality?.content || null;
  const pieces = Array.isArray(contenu?.piecesJointes) ? contenu.piecesJointes : null;
  return {
    cles: Object.keys(corps).slice(0, 30),
    ...champsSimples(corps),
    ...(pieces ? { pieces: pieces.map((p) => ({ type: p.typeDocument || null, ko: koBase64(p.documentBase64) })) } : {}),
    ...(corps.documentBase64 ? { piece: { type: corps.typeDocument || null, ko: koBase64(corps.documentBase64) } } : {}),
  };
}

/** Forme d'une réponse du guichet : identifiants, statuts, nombre d'éléments, refus par champ. */
function resumeReponse(donnees) {
  if (donnees === null || donnees === undefined) return null;
  if (Buffer.isBuffer(donnees)) return { octets: donnees.length };
  if (typeof donnees !== 'object') return { type: typeof donnees };
  const elements = Array.isArray(donnees) ? donnees
    : (donnees['hydra:member'] || donnees.member || donnees.formalities || null);
  return {
    ...(Array.isArray(donnees) ? {} : { cles: Object.keys(donnees).slice(0, 30), ...champsSimples(donnees) }),
    ...(Array.isArray(elements) ? { nombre: elements.length, elements: elements.slice(0, 40).map(champsSimples) } : {}),
    ...(Array.isArray(donnees.violations)
      ? { violations: donnees.violations.slice(0, 40).map((v) => ({ champ: v.propertyPath, message: String(v.message || '').slice(0, 160) })) } : {}),
  };
}

/** Enregistre l'échange ; une trace ne fait jamais échouer ni ralentir sensiblement un appel. */
async function tracer(cible, { methode = 'GET', chemin, params, corps }, { statut, duree, donnees, erreur }) {
  // Guichet : tout ; registre : les échecs seulement (appels nombreux).
  if (cible !== 'guichet' && !erreur) return;
  let service;
  try { service = require('../supa').clientService(); } catch (e) { return; }
  if (!service) return;
  const connexion = chemin === cfgDe(cible).paths.login;
  const ligne = {
    api: cible, methode, chemin: String(chemin || '').slice(0, 300), params: params ? Object.keys(params) : null,
    statut, duree_ms: duree,
    erreur: erreur ? `${erreur.httpStatus || erreur.status || ''} ${erreur.code && typeof erreur.code === 'string' ? erreur.code : ''}`.trim() || 'échec' : null,
    // Connexion : ni identifiants ni jeton.
    requete: connexion ? null : resumeCorps(corps),
    reponse: connexion ? null : resumeReponse(erreur ? erreur.detail : donnees),
  };
  try {
    await Promise.race([
      (async () => {
        await service.from('guichet_traces').insert(ligne);
        if (Math.random() < 0.02) {
          await service.from('guichet_traces').delete().lt('cree_le', new Date(Date.now() - RETENTION_TRACES_JOURS * 86400000).toISOString());
        }
      })(),
      new Promise((ok) => setTimeout(ok, 1500)),
    ]);
  } catch (e) { /* trace perdue : sans conséquence */ }
}

/**
 * Jeton de session : connexion par identifiant / mot de passe, puis cache.
 * @param {'rne'|'guichet'} cible
 * @param {boolean} forcer relance la connexion même si un jeton est en cache
 */
async function jeton(cible, forcer = false) {
  const cfg = cfgDe(cible);
  const cache = jetons.get(cible);
  if (!forcer && cache && Date.now() < cache.expireA) return cache.token;
  if (!cfg.username || !cfg.password) {
    throw new ErreurInpi(
      `Identifiants INPI (${cible}) absents : renseigner l’e-mail et le mot de passe du compte.`,
      { status: 401, api: cible },
    );
  }

  const { donnees, reponse } = await requete(cible, {
    methode: 'POST',
    chemin: cfg.paths.login,
    corps: { username: cfg.username, password: cfg.password },
  });

  const token = jetonDepuisCookies(reponse)
    || donnees?.token || donnees?.access_token || donnees?.jwt || null;
  if (!token) {
    throw new ErreurInpi(
      `Authentification INPI (${cible}) : aucun jeton dans la réponse (ni cookie BEARER, ni corps).`,
      { status: 502, api: cible, detail: donnees },
    );
  }

  const expireA = expirationDuJeton(token)
    // Marge d'une minute pour ne pas utiliser un jeton qui expire pendant l'appel.
    ? Math.max(Date.now() + 60000, expirationDuJeton(token) - 60000)
    : Date.now() + DUREE_JETON_DEFAUT_MS;
  jetons.set(cible, { token, obtenuA: Date.now(), expireA });
  return token;
}

/** Appel authentifié, avec une seule tentative de reconnexion sur 401/403. */
async function appel(cible, options) {
  let token = await jeton(cible);
  try {
    const { donnees } = await requete(cible, { ...options, token });
    return donnees;
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e;
    token = await jeton(cible, true);
    const { donnees } = await requete(cible, { ...options, token });
    return donnees;
  }
}

/** Variante binaire (téléchargement de pièce jointe ou de PDF de synthèse). */
async function telecharger(cible, options) {
  const token = await jeton(cible);
  const { donnees } = await requete(cible, { ...options, token, brut: true });
  return donnees;
}

/** Remplace les {jetons} d'un chemin paramétré. */
function chemin(modele, valeurs) {
  return modele.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(valeurs[k]));
}

/** Vérifie que les identifiants ouvrent bien une session (bouton « Tester »). */
async function verifierConnexion(cible) {
  const debut = Date.now();
  await jeton(cible, true);
  return { ok: true, api: cible, duree_ms: Date.now() - debut };
}

function viderCache() { jetons.clear(); }

module.exports = { appel, telecharger, requete, chemin, jeton, verifierConnexion, ErreurInpi, viderCache, resumeCorps, resumeReponse };
