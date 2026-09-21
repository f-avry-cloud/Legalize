'use strict';

/**
 * Configuration des accès aux API de l'INPI.
 *
 * L'INPI ne délivre pas de clé d'API statique : on s'authentifie avec
 * l'IDENTIFIANT (e-mail) et le MOT DE PASSE du compte, et le service renvoie
 * un jeton JWT de session, à replacer dans l'en-tête `Authorization` de tous
 * les appels suivants. Le jeton expire : il est mis en cache puis renouvelé
 * automatiquement (voir src/inpi/client.js). Rien d'autre n'est à fournir.
 *
 * Deux comptes distincts, pour deux API :
 *
 *  1. RNE — registre-national-entreprises.inpi.fr, compte data.inpi.fr.
 *     Lecture seule. Sert au pré-remplissage à partir du seul SIREN.
 *     Authentification : POST /api/sso/login
 *
 *  2. Guichet unique — guichet-unique.inpi.fr, compte e-procédures INPI
 *     (habilitation mandataire de dépôt). Dépôt, signature, paiement, suivi.
 *     Authentification : POST /api/user/login/sso
 *
 * Les deux environnements de l'INPI (démonstration et production) exigent des
 * comptes DIFFÉRENTS, et l'usage des API suppose d'avoir accepté les CPU en se
 * connectant au moins une fois à l'interface web.
 *
 * Sans identifiants, l'application bascule en mode « simulation » : le
 * parcours complet reste praticable sur un backend local (src/inpi/mock.js),
 * et rien n'est transmis à l'INPI.
 */

const env = process.env;

function bool(v, parDefaut) {
  if (v === undefined || v === '') return parDefaut;
  return /^(1|true|oui|yes)$/i.test(String(v));
}

/* ------------------------------------------------------------------- RNE */

const rne = {
  baseUrl: env.INPI_RNE_URL || 'https://registre-national-entreprises.inpi.fr',
  username: env.INPI_RNE_USERNAME || '',
  password: env.INPI_RNE_PASSWORD || '',
  paths: {
    login: '/api/sso/login',
    entreprise: '/api/companies/{siren}',
    recherche: '/api/companies',
    pieces: '/api/companies/{siren}/attachments',
  },
};

/* --------------------------------------------------------- Guichet unique */

// Environnement INPI visé : « demonstration » (bac à sable, comptes dédiés)
// ou « production ». Les deux hôtes sont ceux du contrat d'interface, § 2.
const HOTES_GU = {
  demonstration: 'https://guichet-unique-demo.inpi.fr',
  production: 'https://guichet-unique.inpi.fr',
};

// Portail e-procédures : c'est là que le signataire se connecte via
// FranceConnect+ pour signer gratuitement une formalité déposée par API.
const PORTAILS = {
  demonstration: 'https://procedures-demo.inpi.fr',
  production: 'https://procedures.inpi.fr',
};

const environnementGu = env.INPI_GU_ENV === 'demonstration' ? 'demonstration' : 'production';

const guichet = {
  environnement: environnementGu,
  baseUrl: env.INPI_GU_URL || HOTES_GU[environnementGu],
  portailUrl: env.INPI_PORTAIL_URL || PORTAILS[environnementGu],
  username: env.INPI_GU_USERNAME || '',
  password: env.INPI_GU_PASSWORD || '',
  // Chemins du contrat d'interface (annexe « Liste des endpoint »).
  paths: {
    login: '/api/user/login/sso',
    formalites: '/api/formalities',
    formalite: '/api/formalities/{id}',
    formalitesModification: '/api/formality_updates',
    // Attention : sur le compte mandataire, ce groupe de sérialisation
    // renvoie un objet sans aucun champ. Ne pas l'employer pour lister.
    formaliteAllegee: '/api/formalities/{id}?groups[]=formality:read:no-content',
    historiqueStatuts: '/api/formalities/{id}/formality_status_histories',
    piecesFormalite: '/api/formalities/{id}/attachments',
    piece: '/api/attachments/{id}',
    pieceFichier: '/api/attachments/{id}/file',
    pieceInvalider: '/api/formalities/{formaliteId}/attachments/{pieceId}/remove',
    synthese: '/api/formalities/{id}/synthesis',
    syntheseMetadonnees: '/api/formalities/{id}/synthesis_content',
    regularisations: '/api/regularization_requests',
    signatures: '/api/signatures',
    paiement: '/api/payment',
    solde: '/api/customer-balance',
    comptesAnnuels: '/api/annual_accounts',
    compteAnnuel: '/api/annual_accounts/{id}',
  },
};

/* ------------------------------------------------------------------ modes */

/** « reel » dès qu'un couple identifiant / mot de passe est présent. */
function modeDe(cfg) {
  if (env.INPI_MODE === 'simulation') return 'simulation';
  if (env.INPI_MODE === 'reel') return 'reel';
  return cfg.username && cfg.password ? 'reel' : 'simulation';
}

const config = {
  rne,
  guichet,
  get modeRne() { return modeDe(rne); },
  get modeGuichet() { return modeDe(guichet); },
  timeoutMs: Number(env.INPI_TIMEOUT_MS || 30000),
  // Un dépôt engage la société, déclenche une facturation et n'est pas
  // annulable après signature : il reste désactivé tant qu'on ne l'autorise
  // pas explicitement, même avec des identifiants valides.
  depotReelAutorise: bool(env.INPI_DEPOT_REEL, false),
  // Le paiement des taxes exige en plus les identifiants du compte client
  // (compte CCL) : il n'est jamais déclenché sans configuration dédiée.
  paiement: {
    actif: bool(env.INPI_PAIEMENT_AUTO, false),
    login: env.INPI_PAIEMENT_LOGIN || '',
    password: env.INPI_PAIEMENT_PASSWORD || '',
    type: env.INPI_PAIEMENT_TYPE || 'CCL',
  },
  // Taille maximale d'une pièce jointe imposée par le Guichet unique.
  pieceMaxOctets: 10 * 1024 * 1024,
};

/** Résumé exposé au frontend (jamais de secret). */
function etat() {
  return {
    rne: { mode: config.modeRne, baseUrl: rne.baseUrl, compte: rne.username ? masquer(rne.username) : null },
    guichet: {
      mode: config.modeGuichet,
      environnement: guichet.environnement,
      baseUrl: guichet.baseUrl,
      portailUrl: guichet.portailUrl,
      compte: guichet.username ? masquer(guichet.username) : null,
      depotReelAutorise: config.depotReelAutorise,
      paiementAuto: config.paiement.actif,
    },
  };
}

/** « marie.dupont@cabinet.fr » → « m***@cabinet.fr ». */
function masquer(identifiant) {
  const [avant, apres] = String(identifiant).split('@');
  return apres ? `${avant.slice(0, 1)}***@${apres}` : `${avant.slice(0, 2)}***`;
}

module.exports = { config, etat, HOTES_GU, PORTAILS };
