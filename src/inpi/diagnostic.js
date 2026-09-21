'use strict';

/**
 * Diagnostic des accès INPI, partagé par la ligne de commande
 * (scripts/inpi-connexion.js) et par l'interface (bouton « Tester la
 * connexion »).
 *
 * Deux vérifications par API, dans cet ordre, parce qu'elles échouent pour des
 * raisons différentes :
 *   1. connexion — l'identifiant et le mot de passe ouvrent-ils une session ?
 *   2. lecture   — le compte a-t-il réellement accès aux données ? Un compte
 *      peut s'authentifier sans porter l'habilitation « mandataire de dépôt ».
 *
 * Tout est en lecture seule : ce diagnostic ne dépose jamais rien.
 */

const { config, etat } = require('./config');
const { jeton, appel, chemin, ErreurInpi } = require('./client');
const { normaliserEntreprise } = require('./normalize');

const SIREN_TEST_DEFAUT = '552100554';

/** Traduit un échec en cause probable plutôt qu'en code HTTP. */
function diagnostiquerErreur(e) {
  if (!(e instanceof ErreurInpi)) return { message: e.message, cause: null };
  if (e.codeInpi === 'RESEAU_INTERMEDIAIRE') {
    return {
      message: e.message,
      cause: 'La requête n’a pas atteint l’INPI : un proxy ou un pare-feu l’a interceptée. '
        + 'Les identifiants ne sont pas en cause — autoriser les hôtes inpi.fr en sortie.',
    };
  }
  if (e.status === 401) {
    return {
      message: e.message,
      cause: 'Mot de passe erroné, compte de l’autre environnement (démonstration ≠ production), '
        + 'ou conditions particulières d’utilisation jamais acceptées sur l’interface web.',
    };
  }
  if (e.status === 403) {
    return {
      message: e.message,
      cause: 'Compte authentifié mais sans l’habilitation demandée — pour le guichet unique, '
        + 'l’habilitation « mandataire de dépôt ».',
    };
  }
  if (e.status === 504) {
    return { message: e.message, cause: 'Hôte INPI injoignable depuis ce serveur (réseau, DNS ou pare-feu).' };
  }
  return { message: e.message, cause: null };
}

/** Lectures de contrôle : la plus simple qui prouve un accès réel. */
const LECTURES = {
  async rne(options) {
    const siren = (options.siren || SIREN_TEST_DEFAUT).replace(/\D/g, '');
    const json = await appel('rne', { chemin: chemin(config.rne.paths.entreprise, { siren }) });
    const fiche = normaliserEntreprise(json);
    return fiche
      ? `SIREN ${siren} → ${fiche.denomination || '(sans dénomination)'}${fiche.forme_juridique ? ` · ${fiche.forme_juridique}` : ''}`
      : `réponse reçue pour ${siren}, mais non exploitable (format inattendu)`;
  },
  async guichet() {
    const rep = await appel('guichet', {
      chemin: config.guichet.paths.formalites,
      params: { itemsPerPage: 1, 'groups[]': 'formality:read:no-content' },
    });
    const liste = Array.isArray(rep) ? rep : (rep?.['hydra:member'] || []);
    const total = rep?.['hydra:totalItems'];
    return `liste des formalités accessible — ${total ?? liste.length} dossier(s) sur ce compte`;
  },
};

/**
 * @param {'rne'|'guichet'} cible
 * @returns {Promise<object>} état détaillé, sans jamais lever d'exception
 */
async function diagnostiquer(cible, options = {}) {
  const cfg = cible === 'rne' ? config.rne : config.guichet;
  const resume = etat()[cible === 'rne' ? 'rne' : 'guichet'];
  const resultat = {
    api: cible,
    libelle: cible === 'rne'
      ? 'API RNE — pré-remplissage (compte data.inpi.fr)'
      : 'API Guichet unique — dépôt et suivi (compte e-procédures)',
    hote: cfg.baseUrl,
    compte: resume.compte,
    configure: Boolean(cfg.username && cfg.password),
    connexion: null,
    lecture: null,
    ok: false,
  };
  if (!resultat.configure) {
    resultat.connexion = {
      ok: false,
      message: `Non configuré — renseigner ${cible === 'rne'
        ? 'INPI_RNE_USERNAME / INPI_RNE_PASSWORD' : 'INPI_GU_USERNAME / INPI_GU_PASSWORD'}.`,
      cause: null,
    };
    return resultat;
  }

  try {
    const debut = Date.now();
    await jeton(cible, true);
    resultat.connexion = { ok: true, message: `Jeton de session obtenu en ${Date.now() - debut} ms.`, duree_ms: Date.now() - debut };
  } catch (e) {
    resultat.connexion = { ok: false, ...diagnostiquerErreur(e) };
    return resultat;
  }

  try {
    resultat.lecture = { ok: true, message: await LECTURES[cible](options) };
    resultat.ok = true;
  } catch (e) {
    resultat.lecture = { ok: false, ...diagnostiquerErreur(e) };
  }
  return resultat;
}

/** Diagnostic des deux API, plus le rappel du mode courant. */
async function diagnostiquerTout(options = {}) {
  const [rne, guichet] = await Promise.all([
    diagnostiquer('rne', options),
    diagnostiquer('guichet', options),
  ]);
  return { etat: etat(), rne, guichet, ok: rne.ok && guichet.ok };
}


/**
 * Inventaire brut : ce que le compte INPI renvoie réellement sur les
 * collections de formalités, sans rien enregistrer. Sert quand « Importer »
 * ne ramène aucun dossier : on veut savoir si la collection est vide, si
 * l'INPI filtre, ou si les champs ne portent pas les noms attendus.
 */
async function diagnostiquerInventaire() {
  const rapport = { mode: config.modeGuichet, compte: etat().guichet.compte, services: [] };
  if (config.modeGuichet === 'simulation') {
    rapport.note = 'Mode simulation : aucune requête n\'est envoyée à l\'INPI.';
    return rapport;
  }

  const collections = [
    { service: 'formalites', chemin: config.guichet.paths.formalites },
    { service: 'comptes_annuels', chemin: config.guichet.paths.comptesAnnuels },
  ];

  for (const { service, chemin: route } of collections) {
    for (const variante of ['allege', 'complet']) {
      const params = { itemsPerPage: 5, page: 1 };
      if (variante === 'allege') params['groups[]'] = 'formality:read:no-content';
      const essai = { service, variante, chemin: route, params: { ...params } };
      try {
        const rep = await appel('guichet', { chemin: route, params });
        const membres = Array.isArray(rep) ? rep : (rep?.['hydra:member'] || rep?.member || rep?.items || []);
        essai.ok = true;
        essai.total_annonce = rep?.['hydra:totalItems'] ?? rep?.totalItems ?? null;
        essai.recus = membres.length;
        essai.cles_reponse = rep && !Array.isArray(rep) ? Object.keys(rep).slice(0, 12) : ['(tableau)'];
        essai.cles_premier = membres[0] ? Object.keys(membres[0]).slice(0, 40) : [];
        essai.echantillon = membres.slice(0, 3).map((m) => ({
          id: m.id ?? null,
          liasse: m.liasseNumber ?? m.liasse_number ?? null,
          statut: m.status ?? m.statut ?? null,
          type: m.typeFormalite ?? m.type_formalite ?? null,
          siren: m.siren ?? null,
        }));
      } catch (e) {
        essai.ok = false;
        essai.statut_http = e.status ?? null;
        essai.erreur = String(e.message || e).slice(0, 400);
      }
      rapport.services.push(essai);
    }
  }
  return rapport;
}

module.exports = { diagnostiquer, diagnostiquerTout, diagnostiquerInventaire, SIREN_TEST_DEFAUT };
