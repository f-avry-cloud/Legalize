'use strict';

/**
 * Configuration des accès aux API de l'INPI.
 *
 * Deux API distinctes, deux jeux d'identifiants possibles :
 *
 *  1. API RNE / formalités (lecture) — registre-national-entreprises.inpi.fr
 *     Compte data.inpi.fr. Sert au PRÉ-REMPLISSAGE : on récupère l'état civil
 *     complet d'une entreprise à partir de son SIREN, donc l'utilisateur ne
 *     ressaisit jamais ce que l'INPI connaît déjà.
 *
 *  2. API Guichet unique « mandataire de dépôt » (écriture) —
 *     guichet-unique.inpi.fr. Compte e-procédures INPI, habilitation
 *     mandataire. Sert au DÉPÔT et au SUIVI des formalités.
 *
 * Les chemins sont paramétrables : le contrat d'interface de l'API mandataire
 * évolue, et la pré-production n'expose pas toujours les mêmes routes. On les
 * déclare ici plutôt que de les figer dans le code appelant.
 *
 * Sans identifiants, l'application bascule en mode « démo » : le connecteur
 * répond avec un backend simulé (src/inpi/mock.js) et TOUT le workflow reste
 * praticable (pré-remplissage, contrôles, payload, suivi) sans rien déposer.
 */

const env = process.env;

function bool(v, parDefaut) {
  if (v === undefined || v === '') return parDefaut;
  return /^(1|true|oui|yes)$/i.test(String(v));
}

const rne = {
  baseUrl: env.INPI_RNE_URL || 'https://registre-national-entreprises.inpi.fr',
  username: env.INPI_RNE_USERNAME || '',
  password: env.INPI_RNE_PASSWORD || '',
  paths: {
    login: env.INPI_RNE_PATH_LOGIN || '/api/sso/login',
    entreprise: env.INPI_RNE_PATH_COMPANY || '/api/companies/{siren}',
    recherche: env.INPI_RNE_PATH_SEARCH || '/api/companies',
    pieces: env.INPI_RNE_PATH_ATTACHMENTS || '/api/companies/{siren}/attachments',
  },
};

const guichet = {
  baseUrl: env.INPI_GU_URL || 'https://guichet-unique.inpi.fr',
  username: env.INPI_GU_USERNAME || '',
  password: env.INPI_GU_PASSWORD || '',
  paths: {
    login: env.INPI_GU_PATH_LOGIN || '/api/sso/login',
    formalites: env.INPI_GU_PATH_FORMALITES || '/api/formalites',
    formalite: env.INPI_GU_PATH_FORMALITE || '/api/formalites/{id}',
    depot: env.INPI_GU_PATH_DEPOT || '/api/formalites/{id}/depot',
    pieces: env.INPI_GU_PATH_PIECES || '/api/formalites/{id}/pieces',
    regularisations: env.INPI_GU_PATH_REGULARISATIONS || '/api/regularisations',
  },
};

/** « live » dès qu'un couple d'identifiants est présent, « demo » sinon. */
function modeDe(cfg) {
  if (env.INPI_MODE === 'demo') return 'demo';
  if (env.INPI_MODE === 'live') return 'live';
  return cfg.username && cfg.password ? 'live' : 'demo';
}

const config = {
  rne,
  guichet,
  get modeRne() { return modeDe(rne); },
  get modeGuichet() { return modeDe(guichet); },
  timeoutMs: Number(env.INPI_TIMEOUT_MS || 20000),
  // Le dépôt réel est une action irréversible et payante : il reste désactivé
  // tant qu'on ne l'autorise pas explicitement, même avec des identifiants.
  depotReelAutorise: bool(env.INPI_DEPOT_REEL, false),
};

/** Résumé exposé au frontend (jamais de secret). */
function etat() {
  return {
    rne: { mode: config.modeRne, baseUrl: rne.baseUrl },
    guichet: { mode: config.modeGuichet, baseUrl: guichet.baseUrl, depotReelAutorise: config.depotReelAutorise },
  };
}

module.exports = { config, etat };
