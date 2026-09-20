'use strict';

/**
 * API Guichet unique « mandataire de dépôt » (écriture + suivi).
 *
 * Garde-fou volontaire : le dépôt réel n'est effectué que si des identifiants
 * sont configurés ET que INPI_DEPOT_REEL=1. Dans tous les autres cas, la
 * formalité est marquée « déposée (simulation) » — le dossier, le payload et
 * le suivi existent, mais rien n'est transmis à l'INPI. Un dépôt engage la
 * société et déclenche une facturation : il ne doit jamais partir par accident.
 */

const { config } = require('./config');
const { appel, chemin } = require('./client');
const { normaliserStatut } = require('./referentiels');
const mock = require('./mock');

function simulationActive() {
  return config.modeGuichet === 'demo' || !config.depotReelAutorise;
}

/** Projette une formalité brute du Guichet unique sur le modèle interne. */
function normaliserFormalite(brute, idParDefaut) {
  const id = brute?.id || brute?.liasse_number || brute?.liasseNumber || idParDefaut;
  const regularisations = brute?.regularisations || brute?.demandes_regularisation || [];
  return {
    inpi_id: id ? String(id) : null,
    numero_liasse: brute?.liasse_number || brute?.liasseNumber || (id ? String(id) : null),
    statut: normaliserStatut(brute?.status || brute?.statut),
    statut_brut: brute?.status || brute?.statut || null,
    statut_date: brute?.status_date || brute?.statusDate || brute?.updated || null,
    reference_mandataire: brute?.reference_mandataire || brute?.referenceMandataire || null,
    regularisations: (Array.isArray(regularisations) ? regularisations : [regularisations]).filter(Boolean).map((r) => ({
      date: r.date || r.created || null,
      motif: r.motif || r.message || r.commentaire || '',
      delai_reponse_jours: r.delai_reponse_jours ?? r.delai ?? null,
    })),
    simule: Boolean(brute?._simule),
    brut: brute || null,
  };
}

/** Dépose une formalité. Retourne toujours un identifiant de suivi. */
async function deposer(payload) {
  if (simulationActive()) {
    const id = mock.liasseSimulee();
    return {
      ...normaliserFormalite({ id, status: 'DEPOSEE', _simule: true }, id),
      simule: true,
      motif_simulation: config.modeGuichet === 'demo'
        ? 'Aucun identifiant Guichet unique configuré.'
        : 'Dépôt réel désactivé (INPI_DEPOT_REEL non activé).',
    };
  }
  const rep = await appel('guichet', {
    methode: 'POST',
    chemin: config.guichet.paths.formalites,
    corps: payload,
  });
  return normaliserFormalite(rep);
}

/** État courant d'une formalité déposée (statut + régularisations). */
async function statut(id) {
  if (!id) return null;
  if (String(id).startsWith('DEMO-')) return normaliserFormalite(mock.statutSimule(id), id);
  const rep = await appel('guichet', { chemin: chemin(config.guichet.paths.formalite, { id }) });
  return normaliserFormalite(rep, id);
}

/**
 * Liste les formalités du compte mandataire.
 * @param {object} filtres { status, siren, updated, reference_mandataire }
 */
async function lister(filtres = {}) {
  if (config.modeGuichet === 'demo') return [];
  const rep = await appel('guichet', { chemin: config.guichet.paths.formalites, params: filtres });
  const liste = Array.isArray(rep) ? rep : (rep?.['hydra:member'] || rep?.items || []);
  return liste.map((f) => normaliserFormalite(f));
}

/** Demandes de régularisation en attente de réponse. */
async function regularisations() {
  if (config.modeGuichet === 'demo') return [];
  try {
    const rep = await appel('guichet', { chemin: config.guichet.paths.regularisations });
    const liste = Array.isArray(rep) ? rep : (rep?.['hydra:member'] || rep?.items || []);
    return liste;
  } catch (e) {
    // Route absente selon la version du contrat d'interface : on retombe sur
    // le filtrage par statut, qui est toujours disponible.
    if (e.status !== 404) throw e;
    return (await lister({ status: 'REGULARISATION' })).flatMap((f) => f.regularisations.map((r) => ({ ...r, formalite: f.inpi_id })));
  }
}

module.exports = { deposer, statut, lister, regularisations, normaliserFormalite, simulationActive };
