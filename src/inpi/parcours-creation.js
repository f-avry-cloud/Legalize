'use strict';

/**
 * La création de société dans le parcours.
 *
 * Même tunnel que les modifications — situation, pièces, informations,
 * dépôt — mais sans fiche du registre : tout est à saisir. L'enjeu est donc
 * de ne demander que ce que le guichet exige pour la forme choisie, rangé
 * comme un juriste le pense (la société, le siège, l'activité, les
 * dirigeants, les bénéficiaires effectifs, la fiscalité, l'annonce), et de
 * déduire le reste : code de forme, associé unique, forme d'exercice tirée de
 * la catégorie d'activité, clôture comptable, caractéristiques du siège.
 *
 * Ce que le serveur exige a été établi par dépôts de test sur
 * l'environnement de démonstration (voir verifications-inpi.json).
 */

const CATEGORIES = require('./data/categories-activite.json').valeurs;

/* ------------------------------------------------------------------ formes */

/**
 * Les formes proposées. La nomenclature INPI n'a pas de code propre pour la
 * SASU ni pour l'EURL : elles se déclarent en SAS (5710) et en SARL (5499)
 * avec l'indicateur d'associé unique. Le code 5720 est refusé par le
 * serveur, et 5498 désigne une société d'attribution d'immeuble.
 */
const FORMES = {
  SAS: { code: '5710', libelle: 'SAS', famille: 'sas' },
  SASU: { code: '5710', libelle: 'SASU', famille: 'sas', unique: true },
  SARL: { code: '5499', libelle: 'SARL', famille: 'sarl' },
  EURL: { code: '5499', libelle: 'EURL', famille: 'sarl', unique: true },
  SA: { code: '5599', libelle: 'SA à conseil d’administration', famille: 'sa' },
  SNC: { code: '5202', libelle: 'SNC', famille: 'snc' },
  SCI: { code: '6540', libelle: 'SCI', famille: 'sc' },
  SC: { code: '6599', libelle: 'Société civile', famille: 'sc' },
};

/**
 * Fonctions proposées selon la forme, avec le code de rôle INPI. Pour une
 * SA, le serveur n'accepte que 51, 53, 60, 64, 65, 66, 67, 70, 71, 72, 99,
 * 130 ou 135 (constaté par dépôt de test).
 */
const ROLES = {
  sas: [['73', 'Président'], ['53', 'Directeur général'], ['70', 'Directeur général délégué']],
  sarl: [['30', 'Gérant']],
  sa: [['60', 'Président-directeur général'], ['51', 'Président du conseil d’administration'], ['53', 'Directeur général'],
    ['70', 'Directeur général délégué'], ['65', 'Administrateur']],
  snc: [['28', 'Gérant associé'], ['30', 'Gérant non associé'], ['74', 'Associé en nom (non gérant)']],
  sc: [['30', 'Gérant']],
};
const ROLES_CAC = [['71', 'Commissaire aux comptes titulaire'], ['72', 'Commissaire aux comptes suppléant']];

function forme(t) { return FORMES[t?.forme_creation] || null; }

function rolesCreation(t) {
  const f = forme(t);
  return f ? [...ROLES[f.famille], ...ROLES_CAC] : [];
}

function libelleRole(code) {
  for (const liste of [...Object.values(ROLES), ROLES_CAC]) {
    const r = liste.find(([c]) => c === String(code));
    if (r) return r[1];
  }
  return null;
}

/** Catégorie de fonction (dirigeant, administrateur, cac…) d'un code de rôle ou d'une fonction. */
function categorieFonction(fonction) {
  const f = String(fonction || '');
  if (['cac', '71', '72'].includes(f)) return 'cac';
  if (['administrateur', '65'].includes(f)) return 'administrateur';
  if (f === 'liquidateur' || f === '40') return 'liquidateur';
  return 'dirigeant';
}

/* -------------------------------------------------------------- questions */

const QUESTIONS = {
  forme_creation: {
    libelle: 'Quelle forme de société ?',
    type: 'choix',
    options: [
      ['SAS', 'SAS'], ['SASU', 'SASU'], ['SARL', 'SARL'], ['EURL', 'EURL'],
      ['SA', 'SA'], ['SNC', 'SNC'], ['SCI', 'SCI'], ['SC', 'Autre société civile'],
    ],
  },
  associe_unique_nature: {
    libelle: 'L’associé unique est-il une personne physique ou une société ?',
    type: 'choix', options: [['PP', 'Une personne physique'], ['PM', 'Une société']],
    si: (t) => Boolean(forme(t)?.unique),
  },
  apports_numeraire: {
    libelle: 'Le capital comprend-il des apports en argent ?',
    aide: 'Les fonds sont déposés en banque ou chez un notaire, qui délivre le certificat du dépositaire.',
    type: 'choix', options: [[true, 'Oui'], [false, 'Non']],
  },
};

/* ---------------------------------------------------------------- pièces */

const ORIGINE_FONDS = { creation: '1', achat: '3', apport: '4', location: '6', gerance_mandat: 'F' };

/** Pièces que la fiche du catalogue ne porte pas et que la situation rend nécessaires. */
const AJOUTS = {
  PJ_33: { condition: 'si le fonds exploité est acheté', regle: (t) => def(t.fonds_origine, () => t.fonds_origine === 'achat') },
  PJ_36: { condition: 'si le fonds exploité est apporté', regle: (t) => def(t.fonds_origine, () => t.fonds_origine === 'apport') },
  PJ_37: { condition: 'si le fonds est pris en location-gérance', regle: (t) => def(t.fonds_origine, () => t.fonds_origine === 'location') },
  PJ_38: { condition: 'si le fonds est exploité en gérance-mandat', regle: (t) => def(t.fonds_origine, () => t.fonds_origine === 'gerance_mandat') },
};

function def(reponse, regle) {
  return reponse === undefined || reponse === null || reponse === '' ? undefined : regle();
}

/* ------------------------------------------------------------------ champs */

/** Sous-champs exigés par le guichet pour un dirigeant ou un bénéficiaire personne physique. */
function sousRequisPersonne(role, f) {
  const l = ['nom', 'prenoms', 'genre', 'date_naissance', 'lieu_naissance', 'adresse.codePostal', 'adresse.commune', 'forme_sociale'];
  // Le guichet demande la situation matrimoniale du gérant de SARL.
  if (f?.famille === 'sarl' && role === '30') l.push('situation_matrimoniale');
  return l;
}
const SOUS_REQUIS_PM = ['denomination', 'siren', 'forme_juridique_code', 'greffe', 'adresse.codePostal', 'adresse.commune'];
const SOUS_REQUIS_BE = ['nom', 'prenoms', 'date_naissance', 'lieu_naissance', 'adresse.codePostal', 'adresse.commune', 'modalites'];

/** Régimes d'imposition proposés : ceux qui concernent une société. */
const REGIMES_BENEFICES = [
  ['114', 'Impôt sur les sociétés — réel simplifié'], ['115', 'Impôt sur les sociétés — réel normal'],
  ['112', 'Impôt sur le revenu — BIC réel simplifié'], ['113', 'Impôt sur le revenu — BIC réel normal'],
  ['111', 'Impôt sur le revenu — BNC déclaration contrôlée'], ['120', 'Impôt sur le revenu — revenus fonciers'],
];
const REGIMES_TVA = [
  ['311', 'Réel simplifié'], ['312', 'Réel normal'], ['313', 'Mini-réel'],
  ['310', 'Franchise en base'], ['316', 'Hors champ ou exonérée'],
];

/**
 * Les groupes de champs d'une création, dans l'ordre où un juriste les
 * remplit. `rep` sert aux champs conditionnels (salariés, domiciliation).
 */
function champsCreation(op, t, rep = {}) {
  const f = forme(t);
  const groupes = [];
  const sansActivite = op === '02M';
  const civile = f?.famille === 'sc';

  groupes.push({
    op: 'c_societe', titre: 'La société',
    champs: [
      { name: 'denomination', label: 'Dénomination sociale', type: 'text', requis: true },
      { name: 'sigle', label: 'Sigle', type: 'text' },
      { name: 'nom_commercial', label: 'Nom commercial', type: 'text' },
      { name: 'capital', label: 'Capital social (€)', type: 'money', requis: true },
      { name: 'capital_variable', label: 'Capital variable', type: 'ouinon', defaut: false },
      { name: 'objet', label: 'Objet social', type: 'textarea', requis: true, aide: 'Tel qu’il figure dans les statuts.' },
      { name: 'duree', label: 'Durée (années)', type: 'number', requis: true, defaut: 99 },
      { name: 'date_cloture', label: 'Clôture de l’exercice (JJ/MM)', type: 'text', requis: true, defaut: '31/12' },
      { name: 'date_premiere_cloture', label: 'Clôture du premier exercice', type: 'date',
        aide: 'Laissez vide pour retenir la première date de clôture qui suit le début d’activité.' },
      { name: 'date_signature_statuts', label: 'Date de signature des statuts', type: 'date', requis: true },
    ],
  });

  const siege = [{ name: 'adresse_siege', label: 'Adresse du siège', type: 'adresse', requis: true }];
  if (t.siege_occupation === 'domiciliation') {
    siege.push(
      { name: 'domiciliataire_denomination', label: 'Société de domiciliation', type: 'text', requis: true },
      { name: 'domiciliataire_siren', label: 'SIREN de la société de domiciliation', type: 'text', requis: true },
    );
  }
  groupes.push({ op: 'c_siege', titre: 'Le siège', champs: siege });

  const activite = sansActivite
    ? [{ name: 'date_debut_activite', label: 'Date de constitution', type: 'date', requis: true }]
    : [
      { name: 'activite_principale', label: 'Activité exercée', type: 'textarea', requis: true,
        aide: 'La description qui figurera au registre, plus précise que l’objet social.' },
      { name: 'categorie', label: 'Catégorie d’activité (nomenclature du guichet)', type: 'categorie', requis: true,
        aide: 'Cherchez un mot de l’activité : la forme d’exercice (commerciale, libérale…) s’en déduit.' },
      { name: 'date_debut_activite', label: 'Date de début d’activité', type: 'date', requis: true },
      { name: 'exercice_activite', label: 'Exercice de l’activité', type: 'choix', options: [['P', 'Permanent'], ['S', 'Saisonnier']], defaut: 'P', requis: true },
      { name: 'emploi_salaries', label: 'La société emploie des salariés dès le début', type: 'ouinon', defaut: false },
    ];
  if (!sansActivite && rep.c_activite?.emploi_salaries === true) {
    activite.push(
      { name: 'date_premiere_embauche', label: 'Date de la première embauche', type: 'date', requis: true },
      { name: 'effectif_salarie', label: 'Nombre de salariés', type: 'number', requis: true },
    );
  }
  groupes.push({ op: 'c_activite', titre: sansActivite ? 'La date de constitution' : 'L’activité', champs: activite });

  const personnes = [];
  for (const [i, e] of (t.entrants || []).entries()) {
    if (!e?.nom) continue;
    const role = libelleRole(e.fonction) || 'fonction à préciser';
    if (e.nature === 'PM') {
      personnes.push({ name: `entrant_${i}`, label: `${e.nom} — ${role}`, type: 'personne_morale', requis: true,
        sous_requis: SOUS_REQUIS_PM, prerempli: { denomination: e.nom },
        // Une société administrateur d'une SA désigne un représentant permanent.
        representant_requis: f?.famille === 'sa' && categorieFonction(e.fonction) === 'administrateur' });
    } else {
      personnes.push({ name: `entrant_${i}`, label: `${e.nom} — ${role}`, type: 'personne', requis: true,
        sous_requis: sousRequisPersonne(String(e.fonction), f), prerempli: separerNom(e.nom), sans_qualite: true });
    }
  }
  if (personnes.length) groupes.push({ op: 'c_dirigeants', titre: 'Les dirigeants', champs: personnes });

  groupes.push({
    op: 'c_be', titre: 'Les bénéficiaires effectifs',
    aide: 'Toute personne qui détient plus de 25 % du capital ou des droits de vote, ou qui contrôle la société par un autre moyen. À défaut, le représentant légal.',
    champs: [{ name: 'beneficiaires', label: 'Bénéficiaires effectifs', type: 'beneficiaires', requis: true, sous_requis: SOUS_REQUIS_BE,
      suggestions: (t.entrants || []).filter((e) => e?.nom && e.nature !== 'PM' && categorieFonction(e.fonction) === 'dirigeant').map((e) => e.nom) }],
  });

  groupes.push({
    op: 'c_fiscal', titre: 'La fiscalité',
    champs: [
      { name: 'regime_benefices', label: 'Imposition des bénéfices', type: 'choix', options: REGIMES_BENEFICES, requis: true, defaut: civile ? '120' : '114' },
      { name: 'regime_tva', label: 'Régime de TVA', type: 'choix', options: REGIMES_TVA, requis: true, defaut: civile ? '316' : '311' },
    ],
  });

  groupes.push({
    op: 'c_publication', titre: 'L’annonce légale et les déclarations',
    champs: [
      { name: 'journal_publication', label: 'Journal d’annonces légales', type: 'journal', requis: true,
        aide: 'Choisissez dans la liste du guichet ; un titre absent sera déclaré en « Autre ».' },
      { name: 'date_publication', label: 'Date de parution', type: 'date', requis: true },
      { name: 'acre', label: 'Demande d’ACRE (aide aux créateurs et repreneurs)', type: 'ouinon', defaut: false },
    ],
  });
  return groupes;
}

/** « Claire MARTIN » → nom MARTIN, prénoms Claire (le nom s'écrit en capitales). */
function separerNom(complet) {
  const mots = String(complet || '').trim().split(/\s+/);
  const nom = mots.filter((m) => m.length > 1 && m === m.toUpperCase() && /\p{L}/u.test(m));
  if (!nom.length || nom.length === mots.length) return { nom: complet };
  return { nom: nom.join(' '), prenoms: mots.filter((m) => !nom.includes(m)).join(' ') };
}

/* ------------------------------------------------------------ catégories */

/** Toutes les feuilles de la nomenclature, avec leur chemin lisible : pour la recherche. */
function feuillesCategories() {
  const out = [];
  const parcourir = (noeuds, chemin, codes) => {
    for (const n of noeuds) {
      const c = [...codes, n.v];
      const ch = [...chemin, n.l];
      if (n.s?.length) parcourir(n.s, ch, c);
      else out.push({ code: c.join('-'), chemin: ch, forme_exercice: n.f || null });
    }
  };
  parcourir(CATEGORIES, [], []);
  return out;
}

let FEUILLES = null;
function categorie(valeur) {
  const r = resoudreCategorie(valeur);
  return r.statut === 'resolue' ? r.categorie : null;
}

const sansAccent = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const CANDIDATS_MAX = 15;
const MOTS_VIDES = new Set(['les', 'des', 'aux', 'une', 'pour', 'avec', 'sans', 'par', 'sur', 'dans', 'autres', 'autre']);

/** Catégorie au format du dossier : codes, libellés des niveaux et forme d'exercice. */
function vueCategorie(f) {
  const codes = f.code.split('-');
  return {
    code: f.code, codes, libelles: f.chemin, chemin: f.chemin.join(' › '),
    forme_exercice: formeExercice(f), forme_exercice_nomenclature: f.forme_exercice,
    ...Object.fromEntries(codes.map((v, i) => [`categorisationActivite${i + 1}`, v])),
  };
}

/**
 * Lit la catégorie d'activité, sous l'une des formes admises :
 *  - le code de la feuille, « 07-02-03-01 », ou ses huit chiffres « 07020301 »
 *    (« 00 » pour un niveau qui n'existe pas : « 01020000 ») ;
 *  - un objet { categorisationActivite1…4 } (ou { code }) ;
 *  - un terme de recherche (« restauration ») : les feuilles qui y répondent
 *    sont rendues comme candidates, aucune n'est retenue d'office.
 * Seule une feuille de la nomenclature est une catégorie : un niveau
 * intermédiaire (« 07-02 ») ne suffit pas au guichet.
 *
 * @returns {{statut: 'resolue', categorie} | {statut: 'candidats', candidats, total, motif} | {statut: 'inconnue', motif}}
 */
function resoudreCategorie(valeur) {
  FEUILLES = FEUILLES || feuillesCategories();
  if (valeur === undefined || valeur === null || valeur === '') return { statut: 'inconnue', motif: 'catégorie non renseignée' };
  let v = valeur;
  if (typeof v === 'string' && /^\s*\{/.test(v)) { try { v = JSON.parse(v); } catch (e) { /* lue comme un terme */ } }
  let codes = null;
  if (v && typeof v === 'object') {
    const aCode = v.code !== undefined && v.code !== null && v.code !== '';
    if (aCode && !v.categorisationActivite1) return resoudreCategorie(String(v.code));
    if (aCode) {
      // Code et niveaux ensemble : ils doivent désigner la même catégorie.
      const parCode = resoudreCategorie(String(v.code));
      const parNiveaux = resoudreCategorie({ ...v, code: null });
      if (parCode.statut === 'resolue' && parNiveaux.statut === 'resolue' && parCode.categorie.code !== parNiveaux.categorie.code) {
        return { statut: 'inconnue', motif: `le code « ${v.code} » et les niveaux ${parNiveaux.categorie.code} ne désignent pas la même catégorie` };
      }
      return parNiveaux;
    }
    codes = [1, 2, 3, 4].map((i) => v[`categorisationActivite${i}`]).map((x) => (x === undefined || x === null ? '' : String(x).trim()));
    if (codes.some((x) => x && !/^\d{1,2}$/.test(x))) return { statut: 'inconnue', motif: 'codes de catégorie à deux chiffres attendus' };
    codes = codes.map((x) => (x ? x.padStart(2, '0') : ''));
  } else {
    const s = String(v).trim();
    if (/^\d{2}([\s.\-]?\d{2}){1,3}$/.test(s)) codes = s.replace(/\D/g, '').match(/\d{2}/g);
  }
  if (codes) {
    // « 00 » ou vide : le niveau n'existe pas pour cette branche.
    while (codes.length && (!codes[codes.length - 1] || codes[codes.length - 1] === '00')) codes.pop();
    if (!codes.length || codes.some((x) => !x || x === '00')) return { statut: 'inconnue', motif: 'codes de catégorie incomplets' };
    const code = codes.join('-');
    const f = FEUILLES.find((x) => x.code === code);
    if (f) return { statut: 'resolue', categorie: vueCategorie(f) };
    const sous = FEUILLES.filter((x) => x.code.startsWith(`${code}-`));
    if (sous.length) {
      return { statut: 'candidats', motif: `« ${code} » est un niveau intermédiaire de la nomenclature : choisissez la catégorie précise`,
        candidats: sous.slice(0, CANDIDATS_MAX).map(vueCategorie), total: sous.length };
    }
    return { statut: 'inconnue', motif: `code « ${code} » absent de la nomenclature du guichet` };
  }
  // Terme de recherche : tous les mots (ou leur racine) doivent figurer dans le chemin de la feuille.
  const mots = sansAccent(v).split(/[^a-z0-9]+/).filter((m) => m.length > 2 && !MOTS_VIDES.has(m));
  if (!mots.length) return { statut: 'inconnue', motif: 'catégorie illisible' };
  const texte = (f) => sansAccent(f.chemin.join(' '));
  // Racine du mot : « restaurant » trouve « restauration ».
  const contient = (f, m) => texte(f).includes(m.slice(0, Math.max(5, m.length - 3)));
  let trouves = FEUILLES.filter((f) => mots.every((m) => contient(f, m)));
  // À défaut, les feuilles qui ont le plus de mots en commun (« Restauration traditionnelle »).
  if (!trouves.length && mots.length > 1) {
    const score = (f) => mots.filter((m) => contient(f, m)).length;
    const max = Math.max(...FEUILLES.map(score));
    if (max) trouves = FEUILLES.filter((f) => score(f) === max);
  }
  if (!trouves.length) {
    return { statut: 'inconnue', motif: `aucune catégorie de la nomenclature ne correspond à « ${String(v).trim()} » : essayez un autre mot, ou donnez le code` };
  }
  return { statut: 'candidats', motif: `« ${String(v).trim()} » n’est pas un code : choisissez une des catégories candidates et renseignez son code`,
    candidats: trouves.slice(0, CANDIDATS_MAX).map(vueCategorie), total: trouves.length };
}

/** Catégorie d'une liasse ; à défaut d'un code de la nomenclature, une erreur claire plutôt qu'un champ omis. */
function categorieExigee(valeur, contexte) {
  const r = resoudreCategorie(valeur);
  if (r.statut === 'resolue') return r.categorie;
  throw Object.assign(new Error(`Catégorie d’activité ${contexte ? `(${contexte}) ` : ''}non reconnue : ${r.motif}. La liasse n’est pas transmise sans elle.`),
    { status: 422, details: r.candidats ? { candidats: r.candidats.map((c) => ({ code: c.code, chemin: c.chemin })) } : undefined });
}

/** Forme d'exercice d'une catégorie, au format du guichet. */
function formeExercice(cat, f) {
  const brut = cat?.forme_exercice || '';
  if (/^ARTISANALE SI JQPA/.test(brut)) return 'COMMERCIALE';
  if (/^AGRICOLE \(NON ACTIF\)/.test(brut)) return 'AGRICOLE_NON_ACTIF';
  if (brut) return brut;
  return f?.famille === 'sc' ? 'GESTION_DE_BIENS' : 'COMMERCIALE';
}

module.exports = {
  FORMES, ROLES, ROLES_CAC, QUESTIONS, AJOUTS, ORIGINE_FONDS,
  forme, rolesCreation, libelleRole, categorieFonction, champsCreation,
  feuillesCategories, categorie, resoudreCategorie, categorieExigee, formeExercice, separerNom,
  VERSION_CATEGORIES: require('./data/categories-activite.json')._source,
};

/* ---------------------------------------------------------- complétude */

const LIBELLES_SOUS = {
  nom: 'nom', prenoms: 'prénoms', genre: 'sexe', date_naissance: 'date de naissance', lieu_naissance: 'commune de naissance',
  code_insee_naissance: 'code INSEE de la commune de naissance', nationalite: 'nationalité', forme_sociale: 'affiliation sociale',
  situation_matrimoniale: 'situation matrimoniale', numero_secu: 'numéro de sécurité sociale', 'adresse.codePostal': 'code postal du domicile',
  'adresse.commune': 'commune du domicile', 'adresse.voie': 'voie du domicile (rue ou lieu-dit)', pays_naissance: 'pays de naissance', denomination: 'dénomination', siren: 'SIREN', greffe: 'greffe d’immatriculation',
  modalites: 'modalités de contrôle', representant: 'représentant permanent', forme_juridique_code: 'forme juridique',
  'volet.organisme_maladie': 'régime d’assurance maladie actuel', 'volet.activite_simultanee': 'activité exercée en parallèle',
  forme_sociale_code: 'affiliation sociale (code attendu : 0 non applicable, 1 sans affiliation, 3 avec affiliation)',
  genre_code: 'sexe (code attendu : 1 masculin, 2 féminin)',
  nationalite_code: 'nationalité (absente du référentiel du guichet)',
};

/**
 * Identité exigée par le portail du guichet pour la personne physique qui
 * représente une personne morale dirigeante (refus de signature constatés :
 * nom de naissance, date, commune et pays de naissance, nationalité, voie et
 * pays du domicile).
 */
const SOUS_REQUIS_REPRESENTANT = ['nom', 'prenoms', 'genre', 'date_naissance', 'lieu_naissance', 'pays_naissance', 'nationalite',
  'adresse.voie', 'adresse.codePostal', 'adresse.commune'];

const lire = (o, chemin) => chemin.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const vide = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const francais = (p) => !p.nationalite || /^fran[cç]aise?$/i.test(String(p.nationalite).trim()) || String(p.nationalite).toUpperCase() === 'FRA';
const neEnFrance = (p) => !p.pays_naissance || /^france$/i.test(String(p.pays_naissance).trim());

/** Clé de contrôle d'un NIR (Corse : 2A → 19, 2B → 18). */
function nirValide(nir) {
  const n = String(nir || '').replace(/\s/g, '').toUpperCase();
  if (!/^[12378]\d{2}(0[1-9]|1[0-2]|[2-9]\d)(\d{2}|2A|2B)\d{6}\d{2}$/.test(n)) return false;
  const corps = n.slice(0, 13).replace('2A', '19').replace('2B', '18');
  return 97 - (Number(BigInt(corps) % 97n)) === Number(n.slice(13));
}

/** Nationalité connue du référentiel du guichet (libellé ou code) : un libellé inconnu partirait sans code. */
function nationaliteConnue(valeur) {
  const { enumeration } = require('./referentiels');
  const table = enumeration('codeNationalite');
  const v = String(valeur).trim();
  return Boolean(table[v.toUpperCase()] || Object.values(table).some((l) => sansAccent(l) === sansAccent(v)));
}

/** Ce qui manque à une personne physique pour que le guichet l'accepte. */
function manquantsPersonne(p = {}, sousRequis = []) {
  const out = sousRequis.filter((k) => vide(lire(p, k)));
  // Valeurs codées : un texte libre (« salarié assimilé ») partirait tel quel et serait refusé.
  if (!vide(p.forme_sociale) && !['0', '1', '3'].includes(String(p.forme_sociale))) out.push('forme_sociale_code');
  if (!vide(p.genre) && !['1', '2'].includes(String(p.genre))) out.push('genre_code');
  if (!vide(p.nationalite) && !nationaliteConnue(p.nationalite)) out.push('nationalite_code');
  if (neEnFrance(p) && vide(p.code_insee_naissance)) out.push('code_insee_naissance');
  // Constaté : le guichet exige le NIR d'un dirigeant affilié de nationalité française.
  if (sousRequis.includes('forme_sociale') && String(p.forme_sociale) === '3') {
    // Travailleur non salarié : le volet social est dû (régime maladie, activité parallèle).
    for (const k of ['volet.organisme_maladie', 'volet.activite_simultanee']) if (vide(lire(p, k))) out.push(k);
    if (francais(p)) {
      if (vide(p.numero_secu)) out.push('numero_secu');
      else if (!nirValide(p.numero_secu)) out.push('numero_secu (clé invalide)');
    }
  }
  return out;
}

/**
 * Sous-champs manquants d'un champ composé, en clair. Vide si le champ est
 * complet. Un champ simple n'en a pas : sa présence suffit.
 */
function manquants(c, v) {
  if (!c.sous_requis) return [];
  const libelle = (k) => LIBELLES_SOUS[k] || k;
  if (c.type === 'personne') return manquantsPersonne(v || {}, c.sous_requis).map(libelle);
  if (c.type === 'personne_morale') {
    const out = c.sous_requis.filter((k) => vide(lire(v || {}, k))).map(libelle);
    if (c.representant_requis) {
      const r = manquantsPersonne(v?.representant || {}, SOUS_REQUIS_REPRESENTANT);
      if (r.length) out.push(`représentant permanent : ${r.map(libelle).join(', ')}`);
    }
    return out;
  }
  if (c.type === 'beneficiaires') {
    const liste = Array.isArray(v) ? v : [];
    if (!liste.length) return ['au moins un bénéficiaire effectif'];
    return liste.flatMap((b, i) => {
      const m = manquantsPersonne(b, c.sous_requis);
      return m.length ? [`${b.prenoms || ''} ${b.nom || `bénéficiaire n° ${i + 1}`}`.trim() + ` : ${m.map(libelle).join(', ')}`] : [];
    });
  }
  return [];
}

module.exports.manquants = manquants;
module.exports.SOUS_REQUIS_REPRESENTANT = SOUS_REQUIS_REPRESENTANT;
module.exports.nirValide = nirValide;
