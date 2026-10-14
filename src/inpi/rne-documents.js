'use strict';

/**
 * Pièces déposées au registre national des entreprises : actes (statuts, PV,
 * décisions…) et comptes annuels (PDF et données saisies). Lecture seule.
 *
 * Sources : documentations INPI « Accéder aux Actes d'une entreprise » (v4.0,
 * juin 2025) et « Accéder aux comptes annuels PDF et saisis » (v5, juin 2025).
 *   GET /api/companies/{siren}/attachments   actes, bilans, bilansSaisis
 *   GET /api/actes/{id}       GET /api/actes/{id}/download
 *   GET /api/bilans/{id}      GET /api/bilans/{id}/download
 *   GET /api/bilans-saisis/{id}
 * Codes retour : 401 non authentifié, 403 habilitation insuffisante, 429 quota
 * journalier dépassé (10 000 appels ou 10 000 Mo).
 */

const client = require('./client');
const { config } = require('./config');
const { nettoyerSiren, sirenValide, formaterSiren } = require('./normalize');
const { textePdf } = require('./texte-pdf');
const POSTES = require('./data/postes-comptes.json');

const TYPES_COMPTES = POSTES.types;

const CONFIDENTIALITE_SAISIS = {
  0: 'aucune déclaration de confidentialité',
  1: 'comptes confidentiels : seules les données d’identité sont diffusées',
  2: 'compte de résultat confidentiel',
  3: 'publication simplifiée : la partie « complet » n’est pas diffusée',
  4: 'rapport du commissaire aux comptes et compte de résultat confidentiels',
};

const CODES_SAISIE = {
  0: 'saisis sans anomalie', 1: 'saisis avec des incohérences comptables à la source', '1A': 'saisis avec des données manquantes à la source',
  6: 'saisis (document reçu en double)', 2: 'non saisis : actif, passif ou compte de résultat nul', 3: 'non saisis : incomplets',
  4: 'non saisis : non détaillés', 5: 'non saisis : doublon', 7: 'non saisis : comptes intermédiaires', 8: 'non saisis : illisibles',
  9: 'non saisis : manuscrits', 10: 'non saisis : illisibles', 11: 'non saisis : scannés en biais ou rognés', 12: 'non saisis : numérisés trop clairs',
  13: 'non saisis : illisibles', 14: 'non saisis : antérieurs à 2017', 15: 'non saisis : bilan de clôture de liquidation',
  16: 'non saisi : ordonnance de report d’assemblée', 17: 'non saisi : refus du report d’assemblée', 18: 'non saisi : déclaration d’impôts',
  19: 'non saisi : autre document', 20: 'non saisi : société immobilière', 21: 'non saisi : société étrangère',
  22: 'non saisis : déclaration de confidentialité incohérente', 23: 'non saisis : mélange de documents', 24: 'non saisis : PDF non conforme',
};

function erreur(message, status = 400, code = null) {
  return Object.assign(new Error(message), { status, code });
}

/** Les refus de l'API, traduits pour l'avocat. */
function traduire(e, quoi) {
  if (e.code && !e.api) return e; // déjà traduite ici
  const s = e.status;
  if (s === 404) return erreur(`${quoi} introuvable au registre.`, 404, 'INTROUVABLE');
  if (s === 403) {
    return erreur('Le compte INPI du connecteur n’a pas l’habilitation nécessaire pour accéder à ce document '
      + '(actes et comptes annuels : droit d’accès à demander à l’INPI pour ce compte, via le portail data.inpi.fr).', 403, 'HABILITATION');
  }
  if (s === 429) return erreur('Quota journalier de l’API INPI dépassé (10 000 appels ou 10 000 Mo par jour) : réessayez demain.', 429, 'QUOTA');
  if (s === 401) return erreur('Connexion au registre refusée : identifiants du compte INPI du connecteur à vérifier.', 401, 'IDENTIFIANTS');
  if (s === 504) return erreur(`Le registre ne répond pas pour le moment (${e.message}). Réessayez dans quelques minutes.`, 504, 'INDISPONIBLE');
  return erreur(`Registre INPI : ${e.message}`, s && s < 500 ? s : 502, 'INPI');
}

function verifierSimulation() {
  if (config.modeRne === 'simulation') {
    throw erreur('Accès au registre non configuré : identifiants INPI (INPI_RNE_USERNAME / INPI_RNE_PASSWORD) absents.', 503, 'NON_CONFIGURE');
  }
}

async function lireJson(chemin, quoi) {
  verifierSimulation();
  try { return await client.appel('rne', { chemin }); } catch (e) { throw traduire(e, quoi); }
}

/** Téléchargement binaire, avec une reconnexion si la session a expiré. */
async function lireFichier(chemin, quoi) {
  verifierSimulation();
  const essai = async () => client.telecharger('rne', { chemin, accept: 'application/pdf, application/octet-stream, */*' });
  let donnees;
  try {
    try { donnees = await essai(); } catch (e) {
      if (e.status !== 401) throw e;
      await client.jeton('rne', true);
      donnees = await essai();
    }
  } catch (e) { throw traduire(e, quoi); }
  if (!Buffer.isBuffer(donnees) || donnees.subarray(0, 1024).indexOf('%PDF-') === -1) {
    throw erreur(`${quoi} : le registre n’a pas renvoyé de PDF.`, 502, 'PAS_UN_PDF');
  }
  return donnees;
}

const publique = (c) => !c || String(c).trim().toLowerCase() === 'public';
const parDate = (cle) => (a, b) => String(b[cle] || '').localeCompare(String(a[cle] || ''));

/* ------------------------------------------------------------------ liste */

async function piecesDeposees(sirenBrut) {
  const siren = nettoyerSiren(sirenBrut);
  if (!sirenValide(siren)) throw erreur(`SIREN invalide : ${formaterSiren(sirenBrut) || sirenBrut} (9 chiffres, clé de Luhn).`, 400, 'SIREN');
  const r = await lireJson(client.chemin('/api/companies/{siren}/attachments', { siren }), `SIREN ${formaterSiren(siren)}`);
  const saisis = (r?.bilansSaisis || []).filter((b) => !b.deleted);
  const actes = (r?.actes || []).filter((a) => !a.deleted).map((a) => {
    const types = (a.typeRdd || []).map((t) => ({ type: t.typeActe || null, ...(t.decision ? { decision: String(t.decision).trim() } : {}) }));
    return {
      id: a.id,
      date_depot: a.dateDepot || null,
      types,
      // Un acte ancien peut ne porter aucun type au registre : son nom de fichier n'en dit rien.
      libelle: types.length ? types.map((t) => t.type + (t.decision ? ` (${t.decision})` : '')).join(' ; ') : (a.libelle || 'Acte déposé (type non précisé par le registre)'),
      confidentiel: !publique(a.confidentiality),
      ...(publique(a.confidentiality) ? {} : { confidentialite: a.confidentiality }),
    };
  }).sort(parDate('date_depot'));
  const bilans = (r?.bilans || []).filter((b) => !b.deleted).map((b) => {
    const saisi = saisis.find((x) => (x.bilanSaisi?.bilan?.identite?.dateClotureExercice || x.dateCloture) === b.dateCloture);
    const codeConf = saisi?.bilanSaisi?.bilan?.identite?.codeConfidentialite;
    return {
      id: b.id,
      date_cloture: b.dateCloture || null,
      date_depot: b.dateDepot || null,
      type_comptes: TYPES_COMPTES[b.typeBilan] || b.typeBilan || null,
      confidentiel: !publique(b.confidentiality),
      confidentialite: publique(b.confidentiality) ? 'publics' : b.confidentiality,
      donnees_saisies: saisi ? {
        disponibles: true,
        ...(codeConf !== undefined && codeConf !== '' ? { confidentialite: CONFIDENTIALITE_SAISIS[Number(codeConf)] || `code ${codeConf}` } : {}),
      } : { disponibles: false },
    };
  }).sort(parDate('date_cloture'));
  return {
    siren: formaterSiren(siren),
    denomination: (r?.actes || [])[0]?.denomination?.trim() || (r?.bilans || [])[0]?.denomination?.trim() || null,
    actes,
    bilans,
  };
}

/* ------------------------------------------------------------------ actes */

async function acte(id, { pages } = {}) {
  if (!String(id || '').trim()) throw erreur('Indiquez l’identifiant de l’acte (voir lister_pieces_deposees).');
  const meta = await lireJson(client.chemin('/api/actes/{id}', { id }), 'Acte');
  if (meta?.deleted) throw erreur('Cet acte a été retiré du registre.', 410, 'SUPPRIME');
  if (!publique(meta?.confidentiality)) {
    throw erreur(`Acte confidentiel (${meta.confidentiality}) : il n’est pas récupéré.`, 403, 'CONFIDENTIEL');
  }
  const pdf = await lireFichier(client.chemin('/api/actes/{id}/download', { id }), 'Acte');
  const texte = await textePdf(pdf, { pages });
  return {
    meta: {
      id: meta.id || id, siren: meta.siren ? formaterSiren(meta.siren) : null, denomination: meta.denomination?.trim() || null,
      date_depot: meta.dateDepot || null,
      types: (meta.typeRdd || []).map((t) => ({ type: t.typeActe || null, ...(t.decision ? { decision: String(t.decision).trim() } : {}) })),
      nom_document: meta.nomDocument || null,
    },
    pdf,
    texte,
  };
}

/* ----------------------------------------------------------------- comptes */

const montant = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

/** Signification des colonnes m1…m4, par type de comptes et par page (documentation, section E). */
const COLONNES = {
  C: { '01': ['brut N', 'amortissements N', 'net N', 'net N-1'], '03': ['France N', 'export N', 'total N', 'total N-1'], '05': ['valeur brute début', 'réévaluation', 'acquisitions'],
    '06': ['début d’exercice', 'dotations', 'reprises', 'fin d’exercice'], '07': ['début d’exercice', 'dotations', 'reprises', 'fin d’exercice'], '08': ['brut', 'à 1 an au plus', 'de 1 à 5 ans', 'à plus de 5 ans'] },
  S: { '01': ['brut N', 'amortissements N', 'net N', 'net N-1'] },
};
COLONNES.AC = COLONNES.C;
COLONNES.AS = COLONNES.S;
COLONNES.K = { '*': ['brut N', 'amortissements N', 'net N', 'net N-1'] };
const COLONNES_DEFAUT = ['N', 'N-1', 'colonne 3', 'colonne 4'];

/** Chiffres clés par type de comptes : [page, code, colonne N, colonne N-1]. */
const CLES = {
  C: { chiffre_affaires: ['03', 'FJ', 'm3', 'm4'], resultat: ['02', 'DI', 'm1', 'm2'], capitaux_propres: ['02', 'DL', 'm1', 'm2'], total_bilan: ['02', 'EE', 'm1', 'm2'], effectif: ['11', 'YP', 'm1', 'm2'] },
  S: { chiffre_affaires: [['02', ['209', '210', '214', '215', '217', '218'], 'm1'], ['02', ['210', '214', '218'], 'm2']], resultat: ['02', '310', 'm1', 'm2'],
    capitaux_propres: ['01', '142', 'm3', 'm4'], total_bilan: ['01', '180', 'm3', 'm4'], effectif: ['02', '376', 'm1'] },
  AC: { chiffre_affaires: ['03', 'FP', 'm3', 'm4'], resultat: ['02', 'DI', 'm1', 'm2'], capitaux_propres: ['02', 'DL', 'm1', 'm2'], total_bilan: ['02', 'EB', 'm1', 'm2'], effectif: ['11', 'UR', 'm1', 'm2'] },
  AS: { chiffre_affaires: [['02', ['EA', 'EB', 'EC', 'ED', 'EE'], 'm1'], ['02', ['EA', 'EB', 'EC', 'ED', 'EE'], 'm2']], resultat: ['02', 'FJ', 'm1', 'm2'],
    capitaux_propres: ['01', 'CG', 'm3', 'm4'], total_bilan: ['01', 'CP', 'm3', 'm4'], effectif: ['02', 'HA', 'm1'] },
  B: { resultat: ['*', 'P8', 'm1', 'm2'], total_bilan: ['*', 'P9', 'm1', 'm2'] },
  A: { resultat: ['*', 'R4', 'm1', 'm2'], total_bilan: ['*', 'P3', 'm1', 'm2'] },
};

function chiffresCles(type, valeur) {
  const out = {};
  for (const [cle, def] of Object.entries(CLES[type] || {})) {
    if (Array.isArray(def[0])) {
      const somme = ([page, codes, col]) => {
        const vs = codes.map((c) => valeur(page, c, col)).filter((v) => v !== null);
        return vs.length ? vs.reduce((a, b) => a + b, 0) : null;
      };
      const n = somme(def[0]);
      const n1 = somme(def[1]);
      if (n !== null || n1 !== null) out[cle] = { N: n, 'N-1': n1 };
    } else {
      const [page, code, colN, colN1] = def;
      const n = valeur(page, code, colN);
      const n1 = colN1 ? valeur(page, code, colN1) : null;
      if (n !== null || n1 !== null) out[cle] = { N: n, ...(colN1 ? { 'N-1': n1 } : {}) };
    }
  }
  return out;
}

/** Données saisies (liasse) rendues lisibles : postes libellés et chiffres clés. */
function lireSaisis(brut) {
  const bilan = brut?.bilanSaisi?.bilan || {};
  const id = bilan.identite || {};
  const type = id.codeTypeBilan || null;
  const conf = id.codeConfidentialite;
  const pages = bilan.detail?.pages || [];
  const index = new Map();
  for (const p of pages) for (const l of p.liasses || []) index.set(`${String(p.numero).padStart(2, '0')}|${l.code}`, l);
  const valeur = (page, code, col) => montant((index.get(`${page}|${code}`) || (page === '*' ? [...index.entries()].find(([k]) => k.endsWith(`|${code}`))?.[1] : null))?.[col]);
  const referentiel = POSTES.postes[type] || {};
  const postes = pages.map((p) => {
    const num = String(p.numero).padStart(2, '0');
    const ref = referentiel[num] || referentiel['*'] || { rubrique: null, codes: {} };
    const noms = (COLONNES[type] || {})[num] || (COLONNES[type] || {})['*'] || COLONNES_DEFAUT;
    return {
      page: num,
      rubrique: ref.rubrique,
      postes: (p.liasses || []).map((l) => {
        const valeurs = {};
        ['m1', 'm2', 'm3', 'm4'].forEach((m, i) => { const v = montant(l[m]); if (v !== null) valeurs[noms[i] || m] = v; });
        return { code: l.code, libelle: ref.codes[l.code]?.libelle || null, valeurs };
      }).filter((x) => Object.keys(x.valeurs).length),
    };
  });
  return {
    type_comptes: TYPES_COMPTES[type] || type,
    date_cloture: id.dateClotureExercice || null,
    date_cloture_precedente: id.dateClotureExerciceNMoins1 || null,
    duree_mois: Number(id.dureeExerciceN) || null,
    devise: id.codeDevise || 'EUR',
    // La documentation donne « 00 » comme « 0 » : le code se lit sans ses zéros de tête.
    saisie: CODES_SAISIE[/^\d+$/.test(String(id.codeSaisie ?? '')) ? Number(id.codeSaisie) : id.codeSaisie] || (id.codeSaisie ? `code ${id.codeSaisie}` : null),
    confidentialite: conf !== undefined && conf !== '' ? (CONFIDENTIALITE_SAISIS[Number(conf)] || `code ${conf}`) : null,
    chiffres_cles: chiffresCles(type, valeur),
    detail: postes,
  };
}

async function comptes(id, { pages, avec_texte: avecTexte = true } = {}) {
  if (!String(id || '').trim()) throw erreur('Indiquez l’identifiant des comptes (voir lister_pieces_deposees).');
  const meta = await lireJson(client.chemin('/api/bilans/{id}', { id }), 'Comptes annuels');
  if (meta?.deleted) throw erreur('Ces comptes ont été retirés du registre.', 410, 'SUPPRIME');
  const base = {
    id: meta.id || id, siren: meta.siren ? formaterSiren(meta.siren) : null, denomination: meta.denomination?.trim() || null,
    date_cloture: meta.dateCloture || null, date_depot: meta.dateDepot || null, type_comptes: TYPES_COMPTES[meta.typeBilan] || meta.typeBilan || null,
  };
  // Comptes confidentiels : on le dit, sans tenter de les récupérer.
  if (!publique(meta.confidentiality)) {
    return { meta: { ...base, confidentiel: true, confidentialite: meta.confidentiality }, pdf: null, texte: null, saisis: null };
  }
  const pdf = await lireFichier(client.chemin('/api/bilans/{id}/download', { id }), 'Comptes annuels');
  const texte = avecTexte ? await textePdf(pdf, { pages, budgetMs: 25000 }) : null;

  // Données saisies : retrouvées par la date de clôture dans la liste de la société.
  let saisis = null;
  if (meta.siren) {
    try {
      const liste = await lireJson(client.chemin('/api/companies/{siren}/attachments', { siren: nettoyerSiren(meta.siren) }), 'Société');
      const ref = (liste?.bilansSaisis || []).find((b) => !b.deleted
        && (b.bilanSaisi?.bilan?.identite?.dateClotureExercice || b.dateCloture) === meta.dateCloture);
      if (ref) {
        const brut = ref.bilanSaisi?.bilan?.detail ? ref : await lireJson(client.chemin('/api/bilans-saisis/{id}', { id: ref.id }), 'Données saisies');
        saisis = lireSaisis(brut);
      }
    } catch (e) {
      saisis = { indisponibles: e.message };
    }
  }
  return { meta: { ...base, confidentiel: false }, pdf, texte, saisis };
}

module.exports = { piecesDeposees, acte, comptes, lireSaisis, traduire, TYPES_COMPTES };
