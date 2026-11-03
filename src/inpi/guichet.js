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
const { nettoyerTextes } = require('./texte-guichet');

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
  // Le guichet compte en centimes (OpenAPI : « Total TTC en centimes d'euros du panier »).
  return total === null || total === undefined ? null : Math.round(Number(total)) / 100;
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
    corps: nettoyerTextes(requete.corps),
  });
  // Une modification (formality_updates) renvoie { formalities: [ … ] } et
  // non la formalité elle-même : sans ce déballage, l'identifiant INPI du
  // dossier déposé était perdu (constaté sur le serveur de démonstration).
  const formalite = Array.isArray(rep?.formalities) ? rep.formalities[0] : rep;
  const resultat = { ...normaliserFormalite(formalite), evenements: formalite?.events || [] };
  // Constaté en production (COUVOIR JOSSET) : l'identifiant rendu par un dépôt
  // de modification n'était pas celui de la formalité (lecture en 404). On le
  // vérifie aussitôt, et on retrouve la formalité par sa liasse au besoin.
  if (resultat.inpi_id && resultat.numero_liasse) {
    try {
      await appel('guichet', { chemin: chemin(config.guichet.paths.formalite, { id: resultat.inpi_id }) });
    } catch (e) {
      if (e.status !== 404) throw e;
      const siren = (/"siren"\s*:\s*"(\d{9})"/.exec(JSON.stringify(requete.corps || {})) || [])[1];
      const vraie = await retrouver({ liasse: resultat.numero_liasse, siren });
      if (vraie?.inpi_id) Object.assign(resultat, { inpi_id: vraie.inpi_id, identifiant_corrige: true });
    }
  }
  return resultat;
}

/** Une formalité du compte mandataire, retrouvée par son numéro de liasse. */
async function retrouver({ liasse, siren } = {}) {
  if (!liasse || config.modeGuichet === 'simulation') return null;
  const trouve = (lot) => lot.find((f) => f.numero_liasse === liasse) || null;
  if (siren) {
    const parSiren = trouve(await lister({ siren }));
    if (parSiren) return parSiren;
  }
  // Une création n'a pas de SIREN : tout le compte est parcouru, pas seulement
  // la première page, avant de conclure qu'une liasse n'y est plus.
  return trouve(await listerTout({ maxPages: 20 }));
}

/** Mise à jour d'un dépôt avant signature, ou réponse à une régularisation. */
async function mettreAJour(id, corps, service = 'formalites') {
  if (String(id).startsWith('SIM-')) return normaliserFormalite(mock.statutSimule(id), id);
  const modele = service === 'comptes_annuels' ? config.guichet.paths.compteAnnuel : config.guichet.paths.formalite;
  const rep = await appel('guichet', { methode: 'PUT', chemin: chemin(modele, { id }), corps: nettoyerTextes(corps) });
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

/** Un PDF, qu'il arrive brut ou encodé en base64 dans une réponse JSON. */
function pdfDepuis(donnees) {
  if (!donnees) return null;
  const buf = Buffer.isBuffer(donnees) ? donnees : Buffer.from(String(donnees));
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return buf;
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
  const pile = [json];
  while (pile.length) {
    const v = pile.pop();
    if (typeof v === 'string' && v.length > 100) {
      const b = Buffer.from(v.replace(/^data:application\/pdf;base64,/, ''), 'base64');
      if (b.subarray(0, 5).toString('latin1') === '%PDF-') return b;
    } else if (v && typeof v === 'object') pile.push(...Object.values(v));
  }
  return null;
}

/** Fichier d'une pièce jointe au guichet, par son identifiant. */
async function fichierPiece(pieceId) {
  const brut = await telecharger('guichet', { chemin: chemin(config.guichet.paths.pieceFichier, { id: pieceId }) });
  const pdf = pdfDepuis(brut);
  if (!pdf) throw new ErreurInpi(`La pièce n° ${pieceId} du guichet n’a pas rendu de PDF lisible.`, { status: 502, api: 'guichet' });
  return pdf;
}

/** Codes des documents de synthèse que le guichet joint lui-même à la formalité. */
const CODES_SYNTHESE = ['PJ_99', 'PJ_119'];

/**
 * Document de synthèse (PJ_99) à signer, en PDF.
 * Constaté en production : /synthesis refuse « Accept: application/pdf » (406 ;
 * formats acceptés : JSON, HTML). La synthèse est donc lue d'abord comme pièce
 * jointe de la formalité (PJ_99, puis PJ_119), puis, à défaut, sur /synthesis
 * en JSON (PDF encodé).
 */
async function synthese(id, { avecSource = false } = {}) {
  if (String(id).startsWith('SIM-')) {
    const pdf = mock.syntheseSimulee(id);
    return avecSource ? { pdf, source: 'simulation' } : pdf;
  }
  const echecs = [];
  try {
    const pieces = await listerPieces(id);
    for (const code of CODES_SYNTHESE) {
      for (const p of pieces.filter((x) => x.code === code)) {
        try {
          const pdf = await fichierPiece(p.id);
          return avecSource ? { pdf, source: `pièce ${code} n° ${p.id}` } : pdf;
        } catch (e) { echecs.push(`${code} n° ${p.id} : ${e.message}`); }
      }
    }
  } catch (e) { echecs.push(`liste des pièces : ${e.message}`); }
  try {
    const brut = await telecharger('guichet', { chemin: chemin(config.guichet.paths.synthese, { id }), accept: 'application/json' });
    const pdf = pdfDepuis(brut);
    if (pdf) return avecSource ? { pdf, source: 'synthesis (JSON)' } : pdf;
    echecs.push('synthesis : réponse sans PDF');
  } catch (e) { echecs.push(`synthesis : ${e.message}`); }
  throw new ErreurInpi(`Document de synthèse introuvable — ${echecs.join(' ; ')}`, { status: 502, api: 'guichet' });
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

/**
 * Nom d'un fichier tel que le guichet le range (constaté en production) :
 * accents retirés, espaces en « _ », parenthèses supprimées, points
 * intermédiaires en « _ » (« acte.docx.pdf » → « acte_docx.pdf »).
 * « attestation-parution (14).pdf » → « attestation-parution_14.pdf ».
 */
function nomGuichet(nom) {
  const n = String(nom || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const m = /^(.*?)(\.[A-Za-z0-9]{1,5})?$/.exec(n);
  const base = (m[1] || '').replace(/[()[\]{}]/g, '').replace(/[\s.]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return `${base}${(m[2] || '').toLowerCase()}`;
}

/** Clé de rapprochement tolérante : lettres et chiffres seulement, en minuscules. */
function nomCompact(nom) {
  return nomGuichet(nom).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Rapproche les pièces du dossier de celles du guichet, une à une (un même
 * code peut figurer deux fois). Même code PJ, puis, par ordre de confiance :
 * taille et nom, taille seule, nom normalisé seul.
 * @returns {{paires: Array<{dossier, guichet}>, manquantes: Array, en_trop: Array}}
 */
function rapprocherPieces(duDossier, auGuichet) {
  const libres = auGuichet.map((g, i) => ({ g, i }));
  const prises = new Set();
  const paires = [];
  const reste = [];
  const taille = (x) => (x.taille === null || x.taille === undefined || x.taille === '' ? null : Number(x.taille));
  const criteres = [
    (d, g) => taille(d) !== null && taille(d) === taille(g) && nomCompact(d.nom) === nomCompact(g.nom),
    (d, g) => taille(d) !== null && taille(d) === taille(g),
    (d, g) => nomCompact(d.nom) === nomCompact(g.nom),
  ];
  let aTraiter = duDossier.slice();
  for (const critere of criteres) {
    const suivants = [];
    for (const d of aTraiter) {
      const t = libres.find(({ g, i }) => !prises.has(i) && g.code === d.code && critere(d, g));
      if (t) { prises.add(t.i); paires.push({ dossier: d, guichet: t.g }); } else suivants.push(d);
    }
    aTraiter = suivants;
  }
  reste.push(...aTraiter);
  return { paires, manquantes: reste, en_trop: libres.filter(({ i }) => !prises.has(i)).map(({ g }) => g) };
}

/**
 * Retire une pièce d'une formalité avant signature (route « remove » du
 * contrat d'interface). La méthode n'y est pas précisée : PUT d'abord, POST
 * si le guichet répond 405 (méthode refusée, donc rien n'a été fait).
 */
async function retirerPieceGuichet(id, pieceId) {
  if (String(id).startsWith('SIM-')) return { ok: true, simule: true };
  const ch = chemin(config.guichet.paths.pieceInvalider, { formaliteId: id, pieceId });
  let methode = 'PUT';
  let reponse;
  try {
    reponse = await appel('guichet', { methode, chemin: ch, corps: {} });
  } catch (e) {
    if (e.status !== 405) throw e;
    methode = 'POST';
    reponse = await appel('guichet', { methode, chemin: ch, corps: {} });
  }
  // La réponse du guichet est rendue telle quelle (sans contenu de fichier) : constaté
  // en production, un retrait accepté laissait la pièce dans la liste.
  return { ok: true, methode, reponse: resumeReponse(reponse) };
}

/** Ajoute une pièce à un dépôt existant (PDF en base64, 10 Mo maximum). */
async function ajouterPiece(id, { code, nom, base64, path = null }) {
  if (String(id).startsWith('SIM-')) return { id: `SIM-PJ-${Date.now()}`, simule: true };
  const rep = await appel('guichet', {
    methode: 'POST',
    chemin: chemin(config.guichet.paths.piecesFormalite, { id }),
    corps: {
      nomDocument: nom,
      typeDocument: code,
      // Code de langue ISO : le serveur refuse « Français ».
      langueDocument: 'fr',
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

/**
 * Supprime une formalité non payée chez l'INPI (contrat d'interface, § 3.17).
 * Une formalité payée ne se supprime pas : elle s'abandonne ou se régularise.
 */
async function supprimer(id) {
  if (String(id).startsWith('SIM-')) return { ok: true, simule: true };
  await appel('guichet', { methode: 'DELETE', chemin: chemin(config.guichet.paths.formalite, { id }) });
  return { ok: true };
}

/** La formalité telle que le guichet la conserve (lecture seule, JSON complet). */
async function brut(id) {
  if (String(id).startsWith('SIM-')) return mock.statutSimule(id);
  return appel('guichet', { chemin: chemin(config.guichet.paths.formalite, { id }) });
}

async function listerPieces(id) {
  if (String(id).startsWith('SIM-')) return [];
  const rep = await appel('guichet', { chemin: chemin(config.guichet.paths.piecesFormalite, { id }) });
  return listeHydra(rep).map((p) => ({
    id: p.id, nom: p.nomDocument, code: p.typeDocument, taille: p.size ?? null, date: p.created || null,
    // Marques d'état éventuelles (pièce invalidée ou retirée mais encore listée).
    ...etatPiece(p),
  }));
}

/** Champs d'état d'une pièce du guichet, quel que soit leur nom exact. */
function etatPiece(p = {}) {
  const etat = {};
  for (const [k, v] of Object.entries(p)) {
    if (/remov|delet|invalid|valid|statu|state|actif|active|archiv/i.test(k) && (typeof v !== 'object' || v === null)) etat[k] = v;
  }
  return Object.keys(etat).length ? { etat_guichet: etat } : {};
}

/** Réponse du guichet ramenée à ses champs simples (jamais le contenu d'un fichier). */
function resumeReponse(r) {
  if (r === null || r === undefined || r === '') return null;
  if (typeof r !== 'object') return String(r).slice(0, 500);
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (/base64|content|file/i.test(k)) continue;
    out[k] = v && typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : v;
  }
  return out;
}

module.exports = {
  deposer, mettreAJour, lire, lister, listerTout, regularisations, historique,
  signer, synthese, fichierPiece, pdfDepuis, payer, ajouterPiece, listerPieces, supprimer, brut, retrouver,
  nomGuichet, rapprocherPieces, retirerPieceGuichet, CODES_SYNTHESE,
  normaliserFormalite, simulationActive, motifSimulation,
};
