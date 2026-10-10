'use strict';

/**
 * Registre des actions proposées sur un dossier.
 *
 * Les boutons d'une fiche dossier ne sont pas écrits dans l'écran : chaque
 * module déclare ici ses actions, et la fiche affiche celles qui s'appliquent.
 * Les actions à venir (SharePoint : rapport de gestion, audit d'un contrat
 * Word…) s'ajouteront de la même façon, sans toucher aux écrans.
 *
 * Une action :
 *   id          identifiant stable ;
 *   libelle     texte du bouton ;
 *   description une phrase, affichée au survol ;
 *   familles    familles de dossiers concernées (toutes si absent) ;
 *   types       types de dossiers concernés (tous si absent) ;
 *   lien(d)     action de navigation : adresse de l'écran à ouvrir ;
 *   executer(d, params)  action exécutée par le serveur (renvoie un résultat).
 */

const ACTIONS = new Map();

function enregistrer(action) {
  if (!action?.id || !action.libelle || (!action.lien && !action.executer)) {
    throw new Error('Action incomplète : id, libelle et lien ou executer requis.');
  }
  ACTIONS.set(action.id, action);
}

function s_applique(action, dossier) {
  if (action.familles && !action.familles.includes(dossier.famille)) return false;
  if (action.types && !action.types.includes(dossier.type)) return false;
  return true;
}

/** Les actions proposées pour ce dossier, telles que l'écran les affiche. */
function pour(dossier) {
  return [...ACTIONS.values()].filter((a) => s_applique(a, dossier)).map((a) => ({
    id: a.id,
    libelle: a.libelle,
    description: a.description || '',
    lien: a.lien ? a.lien(dossier) : null,
    executable: Boolean(a.executer),
  }));
}

async function executer(id, dossier, params = {}) {
  const a = ACTIONS.get(id);
  if (!a || !s_applique(a, dossier) || !a.executer) {
    throw Object.assign(new Error('Action indisponible pour ce dossier.'), { status: 404 });
  }
  return a.executer(dossier, params);
}

module.exports = { enregistrer, pour, executer };
