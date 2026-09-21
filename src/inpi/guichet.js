'use strict';

/**
 * API « mandataire de dépôt » du Guichet unique : dépôt, signature, paiement,
 * suivi, régularisation.
 *
 * Le cycle de vie d'un dépôt côté INPI est le suivant :
 *   POST → RECEIVED → SIGNATURE_PENDING → (signature) → PAYMENT_PENDING →
 *   (paiement) → VALIDATION_PENDING → VALIDATED / AMENDMENT_PENDING / REJECTED
 * Chaque statut porte l'action attendue du mandataire (cf. referentiels.js),
 * ce qui permet au suivi de dire non pas seulement « où en est-on » mais
 * « qui doit jouer maintenant ».
 *
 * Garde-fous : le dépôt réel exige des identifiants ET INPI_DEPOT_REEL=1 ; le
 * paiement exige en plus une configuration dédiée. Dans tous les autres cas,
 * le dossier est traité par le backend simulé (mock.js) — rien ne part.
 */

const { config } = require('./config');
const { appel, telecharger, chemin, ErreurInpi } = require('./client');
const { normaliserStatut, statut } = require('./referentiels');
const mock = require('./mock');

function simulationActive() {
  return config.modeGuichet === 'simulation' || !config.depotReelAutorise;
}

function motifSimulation() {
  if (config.modeGuichet === 'simulation') return 'Aucun identifiant Guichet unique configuré.';
  return 'Dépôt réel désactivé (INPI_DEPOT_REEL non activé).';
}

/* ---------------------------------------------------------- normalisation */

/** Montant à payer, renvoyé par l'INPI dans le panier après dépôt. */
function montantDe(brute) {
  const panier = Array.isArray(brute?.carts) ? brute.carts[0] : brute?.carts;
  const total = panier?.total ?? brute?.amount ?? null;
  return total === null || total === undefined ? null : Number(total);
}

/** Projette une formalité du Guichet unique sur le modèle interne. */
function normaliserFormalite(brute, idParDefaut) {
  const id = brute?.id ?? idParDefaut ?? null;
  const code = normaliserStatut(brute?.status);
  const panier = Array.isArray(brute?.carts) ? brute.carts[0] : brute?.carts;
  // Certaines réponses de l'INPI portent les champs en snake_case : on
  // accepte les deux graphies.
  return {
    inpi_id: id === null ? null : String(id),
    numero_liasse: brute?.liasseNumber || brute?.liasse_number || null,
    siren: brute?.siren || null,
    company_name: brute?.companyName || brute?.company_name || null,
    nom_dossier: brute?.nomDossier || brute?.nom_dossier || null,
    type_formalite: brute?.typeFormalite || brute?.type_formalite || null,
    forme_juridique: brute?.formeJuridique || brute?.forme_juridique || null,
    statut: code,
    statut_brut: brute?.status || null,
    statut_date: brute?.statusDate || brute?.status_date || brute?.updated || null,
    reference_mandataire: brute?.referenceMandataire || brute?.reference_mandataire || null,
    action_attendue: statut(code).action,
    montant: montantDe(brute),
    paiement_date: panier?.paymentDate || null,
    signature_date: brute?.signedDate || brute?.signed_date || null,
    num_nat: brute?.numNat || null,
    regularisations: extraireRegularisations(brute),
    simule: Boolean(brute?._simule),
    brut: brute || null,
  };
}

/** Motifs de régularisation, quel que soit l'endroit où l'INPI les place. */
function extraireRegularisations(brute) {
  const demandes = []
    .concat(brute?.regularizationRequests || [])
    .concat((brute?.validationsRequests || []).flatMap((v) => v.regularizationRequests || []));
  return demandes.flatMap((d) => (d.regularizationObjects || []).map((o) => ({
    id: o.id ?? null,
    type: o.type || null,
    motif: o.observation || o.fieldName || '',
    champ: o.fieldName || null,
    piece: o.fileName || o.attachment?.nomDocument || null,
    echeance: d.deadline || null,
    frais: o.regularizationFeeAmount ?? null,
  })));
}

/** Régularisations renvoyées par /api/regularization_requests. */
function normaliserRegularisations(liste) {
  return (liste || []).flatMap((d) => (d.regularizationObjects || []).map((o) => ({
    id: o.id ?? null,
    type: o.type || null,
    motif: o.observation || '',
    champ: o.fieldName || null,
    piece: o.fileName || o.attachment?.nomDocument || null,
    echeance: d.deadline || null,
    frais: o.regularizationFeeAmount ?? null,
    statut_demande: d.status || null,
  })));
}

function listeHydra(rep) {
  if (Array.isArray(rep)) return rep;
  return rep?.['hydra:member'] || rep?.member || rep?.items || [];
}

/* ------------------------------------------------------------------ dépôt */

/**
 * Dépose une formalité.
 * @param {{endpoint: string, methode: string, corps: object}} requete produite par payload.js
 */
async function deposer(requete) {
  if (simulationActive()) {
    const simulee = mock.deposerSimule(requete);
    return { ...normaliserFormalite(simulee, simulee.id), simule: true, motif_simulation: motifSimulation() };
  }
  const rep = await appel('guichet', {
    methode: requete.methode || 'POST',
    chemin: config.guichet.paths[requete.endpoint],
    corps: requete.corps,
  });
  return normaliserFormalite(rep);
}

/** Mise à jour d'un dépôt avant signature, ou réponse à une régularisation. */
async function mettreAJour(id, corps, service = 'formalites') {
  if (String(id).startsWith('SIM-')) return normaliserFormalite(mock.statutSimule(id), id);
  const modele = service === 'comptes_annuels' ? config.guichet.paths.compteAnnuel : config.guichet.paths.formalite;
  const rep = await appel('guichet', { methode: 'PUT', chemin: chemin(modele, { id }), corps });
  return normaliserFormalite(rep, id);
}

/* ------------------------------------------------------------------ suivi */

/** État courant d'un dépôt (statut, montant, régularisations). */
async function lire(id, service = 'formalites') {
  if (!id) return null;
  if (String(id).startsWith('SIM-')) return normaliserFormalite(mock.statutSimule(id), id);
  const modele = service === 'comptes_annuels' ? config.guichet.paths.compteAnnuel : config.guichet.paths.formalite;
  const rep = await appel('guichet', { chemin: chemin(modele, { id }) });
  const formalite = normaliserFormalite(rep, id);
  // Les motifs de régularisation ne sont pas toujours inclus dans le détail :
  // on va les chercher explicitement dès que le statut l'exige.
  if (!formalite.regularisations.length && String(formalite.statut).startsWith('AMENDMENT')) {
    try {
      formalite.regularisations = await regularisations(id, service);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return formalite;
}

/**
 * Liste les dépôts du compte mandataire.
 * @param {object} filtres { status, typeFormalite, siren, referenceClientMandataire, page, itemsPerPage }
 */
async function lister(filtres = {}, service = 'formalites') {
  if (config.modeGuichet === 'simulation') return [];
  const modele = service === 'comptes_annuels' ? config.guichet.paths.comptesAnnuels : config.guichet.paths.formalites;
  const rep = await appel('guichet', {
    chemin: modele,
    params: { itemsPerPage: 50, 'order[statusDate]': 'desc', ...filtres },
  });
  return listeHydra(rep).map((f) => normaliserFormalite(f));
}

/** Demandes de régularisation d'un dépôt (ou toutes, sans identifiant). */
async function regularisations(id, service = 'formalites') {
  if (config.modeGuichet === 'simulation') {
    return id && String(id).startsWith('SIM-') ? (mock.statutSimule(id).regularisations || []) : [];
  }
  const params = {};
  if (id) {
    params[service === 'comptes_annuels'
      ? 'annualAccountValidationRequest.annualAccount'
      : 'validationRequest.formality'] = id;
  }
  const rep = await appel('guichet', { chemin: config.guichet.paths.regularisations, params });
  return normaliserRegularisations(listeHydra(rep));
}

/** Historique des changements de statut, tel que l'INPI le conserve. */
async function historique(id) {
  if (String(id).startsWith('SIM-')) return [];
  const rep = await appel('guichet', { chemin: chemin(config.guichet.paths.historiqueStatuts, { id }) });
  return listeHydra(rep).map((h) => ({
    statut: normaliserStatut(h.status),
    date: h.created || h.updated || null,
  }));
}

/* -------------------------------------------------------------- signature */

/**
 * Signature du dépôt.
 *  - création : signature simple, un simple POST suffit ;
 *  - modification / cessation / comptes annuels : signature électronique
 *    avancée — le document de synthèse (PJ_99) doit être téléchargé, signé
 *    hors ligne avec un certificat qualifié, redéposé en PJ_115, puis son
 *    identifiant transmis ici.
 */
async function signer(id, { documentSigneId = null, service = 'formalites' } = {}) {
  if (String(id).startsWith('SIM-')) return mock.signerSimule(id);
  const ressource = service === 'comptes_annuels' ? 'annual_accounts' : 'formalities';
  const corps = { [service === 'comptes_annuels' ? 'annualAccount' : 'formality']: `/api/${ressource}/${id}` };
  if (documentSigneId) corps.signedDocument = `/api/attachments/${documentSigneId}`;
  const rep = await appel('guichet', { methode: 'POST', chemin: config.guichet.paths.signatures, corps });
  return { signature_id: rep?.id ?? null, date: rep?.created || null, brut: rep };
}

/** Document de synthèse (PJ_99) à signer, au format PDF. */
async function synthese(id) {
  if (String(id).startsWith('SIM-')) return mock.syntheseSimulee(id);
  return telecharger('guichet', { chemin: chemin(config.guichet.paths.synthese, { id }), accept: 'application/pdf' });
}

/* --------------------------------------------------------------- paiement */

/**
 * Paiement des taxes. Jamais automatique par défaut : il faut activer
 * INPI_PAIEMENT_AUTO et fournir les identifiants du compte client (CCL).
 */
async function payer(id, { service = 'formalites' } = {}) {
  const p = config.paiement;
  if (!p.actif || !p.login || !p.password) {
    throw new ErreurInpi(
      'Paiement non configuré : activer INPI_PAIEMENT_AUTO et renseigner les identifiants du compte client INPI.',
      { status: 409, api: 'guichet' },
    );
  }
  if (String(id).startsWith('SIM-')) return mock.payerSimule(id);
  const ressource = service === 'comptes_annuels' ? 'annual_accounts' : 'formalities';
  const rep = await appel('guichet', {
    methode: 'POST',
    chemin: config.guichet.paths.paiement,
    corps: {
      login: p.login,
      password: p.password,
      paymentType: p.type,
      [service === 'comptes_annuels' ? 'annualAccount' : 'formality']: `/api/${ressource}/${id}`,
    },
  });
  return { ok: true, brut: rep };
}

/* ----------------------------------------------------------- pièces jointes */

/** Ajoute une pièce à un dépôt existant (PDF en base64, 10 Mo maximum). */
async function ajouterPiece(id, { code, nom, base64, path = null }) {
  if (String(id).startsWith('SIM-')) return { id: `SIM-PJ-${Date.now()}`, simule: true };
  const rep = await appel('guichet', {
    methode: 'POST',
    chemin: chemin(config.guichet.paths.piecesFormalite, { id }),
    corps: {
      nomDocument: nom,
      typeDocument: code,
      langueDocument: 'Français',
      documentExtension: 'pdf',
      documentBase64: base64,
      ...(path ? { path } : {}),
    },
  });
  return { id: rep?.id ?? null, brut: rep };
}

/**
 * Parcourt toutes les pages de la liste du compte mandataire.
 * L'appel léger suffit pour un inventaire : il ne rapatrie pas le `content`,
 * qui pèse lourd et n'a pas d'intérêt ici.
 * @param {number} maxPages garde-fou : un compte ancien peut compter des
 *   milliers de dossiers, on ne veut pas boucler indéfiniment.
 */
async function listerTout({ service = 'formalites', itemsPerPage = 50, maxPages = 30, ...filtres } = {}) {
  if (config.modeGuichet === 'simulation') return [];
  const tout = [];
  for (let page = 1; page <= maxPages; page += 1) {
    // Sans `groups[]` : mesuré sur le compte mandataire, l'appel allégé
    // `groups[]=formality:read:no-content` renvoie bien une ligne par
    // formalité, mais vidée de tous ses champs — pas même l'identifiant.
    // L'inventaire y perdait silencieusement tous les dossiers. On demande
    // donc la réponse complète et on jette le contenu, inutile ici et lourd.
    const lot = await lister({ page, itemsPerPage, ...filtres }, service);
    for (const f of lot) {
      if (f.brut) delete f.brut.content;
      tout.push(f);
    }
    if (lot.length < itemsPerPage) break;
  }
  return tout;
}

async function listerPieces(id) {
  if (String(id).startsWith('SIM-')) return [];
  const rep = await appel('guichet', { chemin: chemin(config.guichet.paths.piecesFormalite, { id }) });
  return listeHydra(rep).map((p) => ({
    id: p.id, nom: p.nomDocument, code: p.typeDocument, taille: p.size ?? null, date: p.created || null,
  }));
}

module.exports = {
  deposer, mettreAJour, lire, lister, listerTout, regularisations, historique,
  signer, synthese, payer, ajouterPiece, listerPieces,
  normaliserFormalite, simulationActive, motifSimulation,
};
