'use strict';

/**
 * Annonces du BODACC (Bulletin officiel des annonces civiles et commerciales),
 * en données ouvertes de la DILA : API publique, sans compte ni clé.
 * https://www.bodacc.fr/explore/dataset/annonces-commerciales/api/
 *
 * Bulletin A : ventes et cessions, immatriculations, procédures collectives ;
 * bulletin B : modifications et radiations ; bulletin C : dépôts des comptes.
 */

const BASE = process.env.BODACC_URL || 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';

const FAMILLES = {
  creation: 'Créations', immatriculation: 'Immatriculations', modification: 'Modifications diverses', vente: 'Ventes et cessions',
  radiation: 'Radiations', collective: 'Procédures collectives', dpc: 'Dépôts des comptes', conciliation: 'Procédures de conciliation',
  retablissement_professionnel: 'Rétablissement professionnel', divers: 'Annonces diverses',
};
const BULLETINS = { A: 'Bodacc A', B: 'Bodacc B', C: 'Bodacc C' };

// Champs publiés sous forme de texte JSON par la DILA.
const COMPOSES = {
  modificationsgenerales: 'Modification', radiationaurcs: 'Radiation', jugement: 'Jugement', acte: 'Acte', depot: 'Dépôt',
  divers: 'Divers', listeetablissements: 'Établissement', listeprecedentexploitant: 'Précédent exploitant',
  listeprecedentproprietaire: 'Précédent propriétaire', parutionavisprecedent: 'Avis précédent',
};

const objet = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return v; }
};

/** Les valeurs d'un champ composé, à plat : « descriptif : … ; date : … ». */
function aPlat(v, prefixe = '', out = []) {
  if (v === null || v === undefined || v === '') return out;
  if (Array.isArray(v)) { v.forEach((x) => aPlat(x, prefixe, out)); return out; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) aPlat(x, k, out); return out; }
  out.push(prefixe && !/^(descriptif|complementJugement)$/.test(prefixe) ? `${prefixe} : ${v}` : String(v));
  return out;
}

/** Appel brut de l'API (remplaçable dans les tests). */
async function requete(params) {
  const url = `${BASE}?${new URLSearchParams(params)}`;
  let r;
  try {
    r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw Object.assign(new Error(`BODACC injoignable : ${e.message}`), { status: 503 });
  }
  if (!r.ok) throw Object.assign(new Error(`BODACC — erreur ${r.status}`), { status: r.status >= 500 ? 503 : 502 });
  return r.json();
}

function vueAnnonce(a) {
  const personnes = objet(a.listepersonnes);
  const p = Array.isArray(personnes?.personne) ? personnes.personne[0] : personnes?.personne;
  const contenu = Object.entries(COMPOSES)
    .map(([cle, libelle]) => {
      const t = aPlat(objet(a[cle])).join(' ; ');
      return t ? `${libelle} — ${t}` : null;
    })
    .filter(Boolean);
  return {
    id: a.id,
    date_parution: a.dateparution || null,
    bulletin: BULLETINS[a.publicationavis] || a.publicationavis || null,
    numero_annonce: a.numeroannonce ?? null,
    type: a.typeavis_lib || a.typeavis || null,
    famille: a.familleavis_lib || FAMILLES[a.familleavis] || a.familleavis || null,
    tribunal: a.tribunal || null,
    denomination: a.commercant || p?.denomination || null,
    forme_juridique: p?.formeJuridique || null,
    ville: a.ville || null,
    contenu: contenu.join('\n').slice(0, 2000),
    url: a.url_complete || null,
  };
}

/**
 * Annonces publiées pour un SIREN, les plus récentes d'abord.
 * @param {{siren: string, famille?: string, depuis?: string, limite?: number}} o
 */
async function annonces({ siren, famille, depuis, limite = 20 } = {}) {
  const s = String(siren || '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(s)) throw Object.assign(new Error('SIREN invalide : 9 chiffres attendus.'), { status: 400 });
  if (famille && !FAMILLES[famille]) {
    throw Object.assign(new Error(`Famille d’annonces inconnue : ${famille}. Valeurs : ${Object.keys(FAMILLES).join(', ')}.`), { status: 400 });
  }
  if (depuis && !/^\d{4}-\d{2}-\d{2}$/.test(String(depuis))) throw Object.assign(new Error('« depuis » : date au format AAAA-MM-JJ.'), { status: 400 });
  const conditions = [`registre like "${s}"`];
  if (famille) conditions.push(`familleavis = "${famille}"`);
  if (depuis) conditions.push(`dateparution >= date'${depuis}'`);
  const n = Math.min(Math.max(Number(limite) || 20, 1), 100);
  const r = await module.exports.requete({ where: conditions.join(' and '), order_by: 'dateparution desc', limit: String(n) });
  return {
    siren: s,
    total: r.total_count ?? (r.results || []).length,
    annonces: (r.results || []).map(vueAnnonce),
    source: 'BODACC — données ouvertes de la DILA',
  };
}

/**
 * Publication de la dissolution d'une société par l'associé unique (TUP) :
 * l'annonce la plus récente qui la mentionne, depuis la date de décision.
 */
async function publicationDissolution(siren, depuis) {
  const r = await annonces({ siren, depuis, limite: 50 });
  return r.annonces.find((a) => /dissolution|transmission universelle/i.test(a.contenu)) || null;
}

module.exports = { annonces, publicationDissolution, requete, vueAnnonce, FAMILLES, BASE };
