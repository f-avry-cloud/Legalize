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
const SOUS_REQUIS_PM = ['denomination', 'siren', 'greffe', 'adresse.codePostal', 'adresse.commune'];
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
function categorie(code) {
  FEUILLES = FEUILLES || feuillesCategories();
  return FEUILLES.find((f) => f.code === code) || null;
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
  feuillesCategories, categorie, formeExercice, separerNom,
};

/* ---------------------------------------------------------- complétude */

const LIBELLES_SOUS = {
  nom: 'nom', prenoms: 'prénoms', genre: 'sexe', date_naissance: 'date de naissance', lieu_naissance: 'commune de naissance',
  code_insee_naissance: 'code INSEE de la commune de naissance', nationalite: 'nationalité', forme_sociale: 'affiliation sociale',
  situation_matrimoniale: 'situation matrimoniale', numero_secu: 'numéro de sécurité sociale', 'adresse.codePostal': 'code postal du domicile',
  'adresse.commune': 'commune du domicile', denomination: 'dénomination', siren: 'SIREN', greffe: 'greffe d’immatriculation',
  modalites: 'modalités de contrôle', representant: 'représentant permanent',
};

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

/** Ce qui manque à une personne physique pour que le guichet l'accepte. */
function manquantsPersonne(p = {}, sousRequis = []) {
  const out = sousRequis.filter((k) => vide(lire(p, k)));
  if (neEnFrance(p) && vide(p.code_insee_naissance)) out.push('code_insee_naissance');
  // Constaté : le guichet exige le NIR d'un dirigeant affilié de nationalité française.
  if (sousRequis.includes('forme_sociale') && String(p.forme_sociale) === '3' && francais(p)) {
    if (vide(p.numero_secu)) out.push('numero_secu');
    else if (!nirValide(p.numero_secu)) return [...out, 'numero_secu (clé invalide)'];
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
      const r = manquantsPersonne(v?.representant || {}, ['nom', 'prenoms', 'genre', 'date_naissance', 'lieu_naissance', 'adresse.codePostal', 'adresse.commune']);
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
module.exports.nirValide = nirValide;
