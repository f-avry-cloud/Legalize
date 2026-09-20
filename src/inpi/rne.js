'use strict';

/**
 * API RNE / formalités (lecture) — le moteur du pré-remplissage.
 *
 * Un SIREN suffit à reconstituer l'état civil complet de l'entreprise :
 * dénomination, forme, capital, siège, objet, dirigeants en fonction. C'est
 * ce qui supprime la ressaisie, principale source de temps perdu et d'erreurs
 * dans les formalités.
 */

const { config } = require('./config');
const { appel, chemin, ErreurInpi } = require('./client');
const { normaliserEntreprise, nettoyerSiren, sirenValide, formaterSiren } = require('./normalize');
const mock = require('./mock');

/** Fiche normalisée d'une entreprise à partir de son SIREN. */
async function entreprise(sirenBrut) {
  const siren = nettoyerSiren(sirenBrut);
  if (!sirenValide(siren)) {
    throw new ErreurInpi(`SIREN invalide : ${formaterSiren(sirenBrut)} (9 chiffres, clé de Luhn).`, { status: 400, api: 'rne' });
  }
  if (config.modeRne === 'demo') {
    const fiche = normaliserEntreprise(mock.entrepriseSimulee(siren));
    return { ...fiche, simule: true };
  }
  const json = await appel('rne', { chemin: chemin(config.rne.paths.entreprise, { siren }) });
  const fiche = normaliserEntreprise(json);
  if (!fiche) throw new ErreurInpi('Réponse RNE inexploitable pour ce SIREN.', { status: 502, api: 'rne' });
  return fiche;
}

/** Recherche par dénomination ou par SIREN (saisie libre). */
async function rechercher(terme) {
  const t = String(terme || '').trim();
  if (!t) return [];
  const siren = nettoyerSiren(t);
  if (sirenValide(siren)) {
    const fiche = await entreprise(siren);
    return [{
      siren: fiche.siren, siren_formate: fiche.siren_formate, denomination: fiche.denomination,
      forme_juridique_code: fiche.forme_juridique_code, commune: fiche.adresse?.commune || '',
      simule: Boolean(fiche.simule),
    }];
  }
  if (config.modeRne === 'demo') return mock.rechercheSimulee(t).map((r) => ({ ...r, simule: true }));

  const json = await appel('rne', {
    chemin: config.rne.paths.recherche,
    params: { companyName: t, pageSize: 10 },
  });
  const liste = Array.isArray(json) ? json : (json?.['hydra:member'] || json?.items || []);
  return liste.map((item) => {
    const fiche = normaliserEntreprise(item) || {};
    return {
      siren: fiche.siren, siren_formate: fiche.siren_formate, denomination: fiche.denomination,
      forme_juridique_code: fiche.forme_juridique_code, commune: fiche.adresse?.commune || '',
    };
  }).filter((r) => r.siren);
}

/** Actes et comptes annuels déposés, utiles pour vérifier l'historique. */
async function pieces(sirenBrut) {
  const siren = nettoyerSiren(sirenBrut);
  if (config.modeRne === 'demo') return { actes: [], bilans: [], simule: true };
  return appel('rne', { chemin: chemin(config.rne.paths.pieces, { siren }) });
}

module.exports = { entreprise, rechercher, pieces };
