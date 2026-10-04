'use strict';

/**
 * Sonde du serveur de démonstration du Guichet unique.
 *
 * Ni le contrat d'interface ni le dictionnaire ne disent ce qu'une formalité
 * exige : ces règles ne se lisent que dans les refus du serveur. La sonde
 * relaie donc une requête brute vers l'INPI et rend la réponse telle quelle,
 * erreurs comprises, pour qu'on puisse déposer des dossiers de test et lire
 * ce qui manque.
 *
 * Elle ne fonctionne que sur l'environnement de démonstration : rien de ce
 * qu'elle envoie n'atteint un greffe, et elle refuse le paiement.
 */

const { config } = require('./config');
const { requete, jeton, ErreurInpi } = require('./client');

const CHEMINS_AUTORISES = [
  /^\/api\/formalities(\/\d+(\/(attachments(\/\d+(\/remove)?)?|formality_status_histories|synthesis(_content|_be|_be_content)?|cancel))?)?$/,
  /^\/api\/formality_updates$/,
  /^\/api\/formality_drafts(\/\d+)?$/,
  /^\/api\/attachments\/\d+(\/file)?$/,
  /^\/api\/regularization_requests(\/\d+)?$/,
  /^\/api\/signatures$/,
  /^\/api\/companies\/\d{9}$/,
];

function disponible() {
  return config.guichet.environnement === 'demonstration' && config.modeGuichet === 'reel';
}

/** Retire les fichiers encodés : ils alourdissent la réponse sans rien apprendre. */
function sansFichiers(valeur) {
  if (Array.isArray(valeur)) return valeur.map(sansFichiers);
  if (!valeur || typeof valeur !== 'object') return valeur;
  const copie = {};
  for (const [k, v] of Object.entries(valeur)) {
    copie[k] = k === 'documentBase64' && typeof v === 'string' ? `[${v.length} caractères]` : sansFichiers(v);
  }
  return copie;
}

/**
 * @param {{methode?: string, chemin: string, params?: object, corps?: object}} demande
 * @returns {{ok: boolean, statut: number, message?: string, reponse: any}}
 */
async function sonder({ methode = 'GET', chemin, params, corps }) {
  if (!disponible()) {
    throw new ErreurInpi('La sonde ne fonctionne que sur l’environnement de démonstration de l’INPI.', { status: 403 });
  }
  methode = String(methode).toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(methode)) {
    throw new ErreurInpi(`Méthode refusée : ${methode}.`, { status: 400 });
  }
  if (!CHEMINS_AUTORISES.some((re) => re.test(String(chemin)))) {
    throw new ErreurInpi(`Chemin refusé par la sonde : ${chemin}.`, { status: 400 });
  }

  const token = await jeton('guichet');
  try {
    const { donnees, reponse } = await requete('guichet', { methode, chemin, params, corps, token });
    return { ok: true, statut: reponse.status, reponse: sansFichiers(donnees) };
  } catch (e) {
    if (!(e instanceof ErreurInpi)) throw e;
    return { ok: false, statut: e.status, message: e.message, reponse: sansFichiers(e.detail ?? null) };
  }
}

module.exports = { sonder, disponible };
