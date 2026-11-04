'use strict';

/**
 * Documents de synthèse du Guichet unique : lecture, anonymisation, statistiques.
 *
 * Le guichet produit pour chaque formalité un PDF de synthèse (et un second
 * pour les bénéficiaires effectifs). C'est une suite de rubriques
 * « libellé : valeur » rangées sous des titres :
 *   - le libellé occupe la colonne de gauche, parfois sur plusieurs lignes ;
 *   - la valeur occupe la colonne de droite (abscisse 174,6 pt) et s'aligne
 *     sur la dernière ligne du libellé, celle qui porte les deux-points ;
 *   - les titres sont en plus gros caractères (9,6 à 10,8 pt contre 8,4) et,
 *     comme tout texte en gras, tracés deux fois au même endroit.
 *
 * Ce module :
 *   1. lit le texte du PDF avec sa position (pdf.js) ;
 *   2. reconstitue titres, rubriques, pièces jointes et mentions ;
 *   3. anonymise : ne sortent que la structure (titres, libellés, présence
 *      d'une valeur) et les valeurs de liste (type de formalité, forme
 *      juridique, rôle, journal, catégories d'activité, oui / non…). Noms,
 *      dates de naissance, adresses, téléphones, courriels, noms de fichiers
 *      et numéros (liasse, SIREN) ne sortent jamais ;
 *   4. agrège un corpus : fréquence des rubriques et des pièces par type de
 *      formalité, valeurs retenues, rubriques modifiées d'une version à
 *      l'autre (signe probable d'une régularisation).
 *
 * Usage : scripts/corpus-syntheses.js, pour régler le connecteur sur la
 * pratique réelle du cabinet.
 */

const crypto = require('crypto');

const COLONNE_VALEUR = 170;   // pt : à droite, la valeur ; à gauche, le libellé
const HAUTEUR_TITRE = 9.3;    // corps du texte 8,4 pt ; titres 9,6 (niveau 2) et 10,2 à 10,8 (niveau 1)
const HAUTEUR_TITRE_1 = 10;
const TOLERANCE_LIGNE = 1.5;  // pt : écart vertical toléré entre morceaux d'une même ligne

const MOIS = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

const norm = (s) => String(s ?? '').replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
const sansAccents = (s) => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Forme de comparaison d'un libellé : minuscules, sans accents ni deux-points final. */
const cle = (s) => sansAccents(s).toLowerCase().replace(/\s*:$/, '');
const condense = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

const EN_TETE = /^(synthese de depot au guichet unique|formalite j\d{6,}|page \d+\s*\/\s*\d+)$/;

// ---------------------------------------------------------------------------
// 1. Lecture du PDF
// ---------------------------------------------------------------------------

/** Texte positionné d'un PDF : { pages, elements: [{ page, x, y, h, w, s }] }. */
async function elementsPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false }).promise;
  try {
    const elements = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const contenu = await page.getTextContent();
      for (const it of contenu.items) {
        const s = norm(it.str);
        if (s) elements.push({ page: n, x: it.transform[4], y: it.transform[5], h: it.height, w: it.width, s });
      }
      page.cleanup();
    }
    return { pages: doc.numPages, elements };
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// 2. Reconstitution des rubriques
// ---------------------------------------------------------------------------

/** Le gras est obtenu en traçant deux fois le texte : on ne garde qu'un exemplaire, marqué « gras ». */
function dedoublonner(elements) {
  const vus = new Map();
  const gardes = [];
  for (const e of elements) {
    const k = `${e.page}|${e.s}`;
    const memes = vus.get(k) || [];
    const double = memes.find((g) => Math.abs(g.y - e.y) < 0.8 && Math.abs(g.x - e.x) < 1.5);
    if (double) { double.gras = true; continue; }
    const copie = { ...e, gras: false };
    memes.push(copie);
    vus.set(k, memes);
    gardes.push(copie);
  }
  return gardes;
}

/** Regroupe les morceaux en lignes, de haut en bas puis de gauche à droite. */
function lignes(elements) {
  const tries = [...elements].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const res = [];
  for (const e of tries) {
    const der = res[res.length - 1];
    if (der && der.page === e.page && Math.abs(der.y - e.y) <= TOLERANCE_LIGNE) der.items.push(e);
    else res.push({ page: e.page, y: e.y, items: [e] });
  }
  for (const l of res) l.items.sort((a, b) => a.x - b.x);
  return res;
}

/** Recolle les morceaux d'une ligne ; pas d'espace entre deux morceaux accolés. */
function joindre(items) {
  let out = '';
  let fin = null;
  for (const it of items) {
    const accole = fin !== null && it.x - fin < 0.8;
    out += (out && !accole ? ' ' : '') + it.s;
    fin = Number.isFinite(it.w) && it.w > 0 ? it.x + it.w : null;
  }
  return norm(out);
}

function dateFr(texte) {
  const m = /date du (\d{1,2})(?:er)? ([a-z]+) (\d{4})/.exec(cle(texte));
  if (!m || !MOIS[m[2]]) return null;
  return `${m[3]}-${String(MOIS[m[2]]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * Analyse le texte positionné d'une synthèse.
 * @returns {{ est_synthese, nature, liasse, date_synthese, titres, rubriques, mentions }}
 *   rubriques : [{ section, bloc, libelle, valeur, page }] (section = dernier titre
 *   de niveau 1, bloc = dernier titre, quel que soit son niveau) ;
 *   mentions : phrases hors rubrique (« La modification effectuée ne porte pas… »).
 */
function analyserElements(elements) {
  const items = dedoublonner((elements || []).filter((e) => e && e.s));
  let liasse = null;
  const corps = [];
  for (const it of items) {
    const m = /^Formalité (J\d{6,})$/i.exec(it.s);
    if (m) { liasse = liasse || m[1].toUpperCase(); continue; }
    if (EN_TETE.test(cle(it.s))) continue;
    corps.push(it);
  }

  // Zone de titre (page 1) : au-dessus du premier titre « Résumé de votre formalité »,
  // ou à défaut au-dessus du premier texte courant.
  const resume = corps.find((it) => it.page === 1 && it.h >= HAUTEUR_TITRE && cle(it.s) === 'resume de votre formalite');
  const premierCourant = corps.filter((it) => it.page === 1 && it.h < HAUTEUR_TITRE).sort((a, b) => b.y - a.y)[0];
  const limite = resume ? resume.y + TOLERANCE_LIGNE : (premierCourant ? premierCourant.y + TOLERANCE_LIGNE : Infinity);
  const zoneTitre = corps.filter((it) => it.page === 1 && it.y > limite);
  const reste = corps.filter((it) => !(it.page === 1 && it.y > limite));
  const texteTitre = lignes(zoneTitre).map((l) => joindre(l.items)).join(' ');
  if (!liasse) liasse = (/\b(J\d{11})\b/.exec(texteTitre) || [])[1] || null;

  const titres = [];
  const rubriques = [];
  const mentions = [];
  let section = null;
  let bloc = null;
  let attente = { libelle: [], valeur: [], textes: [], page: null };
  const vider = () => {
    if (attente.textes.length) mentions.push({ section, bloc, texte: norm(attente.textes.join(' ')), page: attente.page });
    attente = { libelle: [], valeur: [], textes: [], page: null };
  };

  for (const l of lignes(reste)) {
    if (l.items.some((it) => it.h >= HAUTEUR_TITRE)) {
      vider();
      const texte = joindre(l.items);
      const niveau = Math.max(...l.items.map((it) => it.h)) >= HAUTEUR_TITRE_1 ? 1 : 2;
      if (niveau === 1) section = texte;
      bloc = texte;
      titres.push({ niveau, texte, page: l.page });
      continue;
    }
    const gauche = l.items.filter((it) => it.x < COLONNE_VALEUR);
    const droite = l.items.filter((it) => it.x >= COLONNE_VALEUR);
    const deuxPoints = gauche.some((it) => /:$/.test(it.s));
    // Phrase en gras sans deux-points : mention, pas un début de libellé.
    if (!deuxPoints && l.items.every((it) => it.gras)) {
      vider();
      mentions.push({ section, bloc, texte: joindre(l.items), page: l.page });
      continue;
    }
    if (attente.page === null) attente.page = l.page;
    attente.textes.push(joindre(l.items));
    if (droite.length) attente.valeur.push(joindre(droite));
    const morceaux = gauche.map((it) => it.s.replace(/\s*:$/, '')).filter(Boolean);
    if (morceaux.length) attente.libelle.push(morceaux.join(' '));
    if (deuxPoints) {
      rubriques.push({ section, bloc, libelle: norm(attente.libelle.join(' ')), valeur: norm(attente.valeur.join(' ')), page: l.page });
      attente = { libelle: [], valeur: [], textes: [], page: null };
    }
  }
  vider();

  return {
    est_synthese: /synthese de depot/.test(cle(texteTitre)) || rubriques.some((r) => cle(r.libelle) === 'numero de liasse'),
    nature: /beneficiaires effectifs/.test(cle(texteTitre)) ? 'beneficiaires' : 'principale',
    liasse,
    date_synthese: dateFr(texteTitre),
    titres,
    rubriques,
    mentions,
  };
}

async function lireSynthese(buffer) {
  const { pages, elements } = await elementsPdf(buffer);
  return { pages, ...analyserElements(elements) };
}

/** Pièces jointes : couples « Intitulé de la pièce jointe demandée » / « Nom du fichier ». */
function piecesJointes(rubriques) {
  const out = [];
  let courante = null;
  for (const r of rubriques) {
    const k = cle(r.libelle);
    if (k === 'intitule de la piece jointe demandee') {
      courante = { intitule: norm(r.valeur) || null, fichier: null };
      out.push(courante);
    } else if (k === 'nom du fichier' && courante && courante.fichier === null) {
      courante.fichier = norm(r.valeur) || '';
      courante = null;
    }
  }
  return out;
}

/** Qui a versé la pièce : le déposant, le guichet (synthèses, reçu) ou le greffe. */
function originePiece(fichier) {
  const f = String(fichier || '');
  if (!f) return 'inconnue';
  if (/^document_de_synthese/i.test(f) || /^recu_de_paiement/i.test(f)) return 'guichet';
  if (/^C\d{4}A\d{4}L\d+D\d{8}H\d{6}/i.test(f)) return 'greffe';
  return 'deposant';
}

// ---------------------------------------------------------------------------
// 3. Anonymisation
// ---------------------------------------------------------------------------

/** Valeurs de liste conservées telles quelles (libellés comparés sans accents). */
const VALEURS_LISTE = new Set([
  'type de formalite', 'forme juridique', "extension d'une entreprise etrangere", 'reliee a une entreprise agricole',
  'entreprise agricole', 'traitement de la formalite par', 'figure au registre des actifs agricoles (raa)', 'duree',
  "date de cloture de l'exercice social", "demarche d'economie sociale et solidaire (ess)", 'societe a mission',
  'capital variable', 'associe unique', 'origine fusion / scission', 'journal de publication',
  'situation de ce dirigeant dans le cadre de cette formalite', "role pour l'entreprise", 'autre role', 'type de personne',
  'beneficiaire effectif', "role de l'etablissement pour l'entreprise", "sans activite autre que l'activite du siege",
  "regime d'imposition des benefices", "regime d'imposition de la tva", "activite principale de l'entreprise",
  "exercice de l'activite", 'activite non sedentaire', "activite dans le prolongement d'une activite agricole",
  "nature d'activite", "categorisation niveau 1 de l'activite", "categorisation niveau 2 de l'activite",
  "categorisation niveau 3 de l'activite", "categorisation niveau 4 de l'activite", "type d'origine",
  "contrat d'appui declare", 'diffusion insee', 'diffusion commerciale', 'document signe',
  "nature de l'activite principale", 'code ape', "moyen d'exercice du pouvoir", 'intitule de la piece jointe demandee',
]);

/** Sigles admis dans un titre, un libellé ou une mention (le reste en capitales évoque un nom). */
const SIGLES = new Set([
  'SAS', 'SASU', 'SARL', 'EURL', 'SA', 'SCI', 'SNC', 'SCS', 'SCA', 'SCP', 'SEL', 'SELARL', 'SELAS', 'SELAFA', 'GIE', 'GAEC',
  'EARL', 'SCEA', 'RCS', 'RNE', 'RSAC', 'RAA', 'RM', 'TVA', 'INSEE', 'INPI', 'ESS', 'NIC', 'SIRET', 'SIREN', 'APE', 'NAF',
  'IS', 'IR', 'BIC', 'BNC', 'BA', 'JAL', 'BODACC', 'EI', 'EIRL', 'UE', 'CFE', 'URSSAF', 'MSA', 'DGFIP', 'PJ', 'CMA', 'CCI',
  'BE', 'CAC', 'NIR', 'TCO', 'TC', 'TJ', 'TAE', 'OUI', 'NON', 'II', 'III', 'IV', 'VI', 'SPE', 'SICAV', 'FCP', 'SPFPL',
]);

/** Texte libre qui pourrait porter une donnée personnelle (nom en capitales, date, numéro, courriel). */
function semblePersonnel(texte) {
  const t = String(texte || '');
  if (/@|\d{2}[/.]\d{2}[/.]\d{2,4}|\d{5,}|\+\d{2}\s?\d/.test(t)) return true;
  const capitales = (t.match(/[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'-]+/g) || []).filter((m) => !SIGLES.has(m.replace(/['-]/g, '')));
  return capitales.length > 0;
}

/** Titre sans sa partie nominative (« Composition - Président de SAS - DUPONT Jean » → « Composition »). */
function titrePublic(titre) {
  if (!titre) return '(sans titre)';
  const premier = norm(titre).split(/\s+-\s+/)[0].replace(/\d+/g, 'N');
  return semblePersonnel(premier) ? '[titre masqué]' : premier;
}

function libellePublic(libelle) {
  const l = norm(libelle);
  if (!l) return '(sans libellé)';
  return semblePersonnel(l) ? '[libellé masqué]' : l;
}

const nombre = (v) => Number(String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));

function trancheCapital(v) {
  const n = nombre(v);
  if (!Number.isFinite(n)) return 'illisible';
  if (n < 1000) return 'moins de 1 000 €';
  if (n < 10000) return '1 000 à 9 999 €';
  if (n < 100000) return '10 000 à 99 999 €';
  if (n < 1000000) return '100 000 à 999 999 €';
  return '1 000 000 € et plus';
}

function tranchePourcentage(v) {
  const n = nombre(v);
  if (!Number.isFinite(n)) return 'illisible';
  if (n < 25) return 'moins de 25 %';
  if (n <= 50) return '25 à 50 %';
  if (n < 100) return 'plus de 50 %';
  return '100 %';
}

const SUSPECT = /@|\d{2}\/\d{2}\/\d{4}|\d{6,}|\+\d{2}\s?\d/;

/** Ce qui peut sortir d'une valeur : la valeur elle-même (liste, oui / non, tranche) ou sa seule présence. */
function valeurPublique(libelle, valeur) {
  const k = cle(libelle);
  const v = norm(valeur);
  if (!v) return { renseigne: false };
  if (/^(oui|non)$/i.test(v)) return { valeur: v[0].toUpperCase() + v.slice(1).toLowerCase() };
  if (k === 'date de depot') {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
    return m ? { valeur: `${m[3]}-${m[2]}` } : { renseigne: true };
  }
  if (k === 'montant capital') return { valeur: trancheCapital(v) };
  if (k.startsWith('detention') && /%$/.test(v)) return { valeur: tranchePourcentage(v) };
  if (k.startsWith('nombre de') && /^\d+$/.test(v)) return { valeur: v };
  if (VALEURS_LISTE.has(k)) return SUSPECT.test(v) ? { renseigne: true, masquee: true } : { valeur: v.slice(0, 200) };
  return { renseigne: true };
}

const premiere = (rubriques, libelle) => rubriques.find((r) => cle(r.libelle) === libelle)?.valeur || null;

/** Blocs et libellés propres au dépôt (signature, paiement, pièces) : exclus de la comparaison des versions. */
const BLOCS_HORS_CONTENU = new Set([
  'resume de votre formalite', 'informations complementaires', 'pieces jointes', 'pieces jointes deposees pour traitement', 'observations',
]);
const LIBELLES_HORS_CONTENU = new Set(['diffusion insee', 'diffusion commerciale', 'numero national', 'document signe', 'date signature']);

/** Empreintes des valeurs de contenu (en mémoire seulement) : repérer ce qui change d'une version à l'autre. */
function empreintesContenu(analyse) {
  const m = new Map();
  const rang = new Map();
  for (const r of analyse.rubriques) {
    const bloc = titrePublic(r.bloc);
    if (BLOCS_HORS_CONTENU.has(cle(bloc)) || LIBELLES_HORS_CONTENU.has(cle(r.libelle))) continue;
    const base = `${bloc} › ${libellePublic(r.libelle)}`;
    const i = (rang.get(base) || 0) + 1;
    rang.set(base, i);
    m.set(`${base}#${i}`, condense(norm(r.valeur)));
  }
  return m;
}

/** Rubriques ajoutées, retirées ou modifiées entre deux versions (sans les valeurs). */
function rubriquesModifiees(avant, apres) {
  const cles = new Set([...avant.keys(), ...apres.keys()]);
  const out = new Set();
  for (const k of cles) if (avant.get(k) !== apres.get(k)) out.add(k.replace(/#\d+$/, ''));
  return [...out].sort();
}

/**
 * Fiche anonyme d'une synthèse : structure et valeurs de liste uniquement.
 * @param {object} analyse résultat de analyserElements / lireSynthese
 * @param {{ sel: Buffer|string }} options sel du pseudonyme (aléatoire, propre à l'exécution)
 */
function anonymiser(analyse, { sel }) {
  const r = analyse.rubriques;
  const champs = r.map((x) => ({ cle: `${titrePublic(x.bloc)} › ${libellePublic(x.libelle)}`, ...valeurPublique(x.libelle, x.valeur) }));
  const modifications = r
    .filter((x) => cle(titrePublic(x.section)) === 'liste des modifications signalees' && /^oui$/i.test(norm(x.valeur)))
    .map((x) => `${titrePublic(x.bloc)} › ${libellePublic(x.libelle)}`);
  const depot = valeurPublique('date de depot', premiere(r, 'date de depot')).valeur;
  const forme = premiere(r, 'forme juridique');
  const greffe = premiere(r, 'traitement de la formalite par');
  return {
    doc: analyse.liasse ? crypto.createHmac('sha256', sel).update(analyse.liasse).digest('hex').slice(0, 12) : null,
    nature: analyse.nature,
    mois: depot || (analyse.date_synthese ? analyse.date_synthese.slice(0, 7) : null),
    type: valeurPublique('type de formalite', premiere(r, 'type de formalite')).valeur || null,
    forme: forme && !SUSPECT.test(forme) ? norm(forme) : null,
    greffe: greffe && !SUSPECT.test(greffe) ? norm(greffe) : null,
    modifications,
    signe: /^oui$/i.test(norm(premiere(r, 'document signe'))),
    numero_national: Boolean(premiere(r, 'numero national')),
    pages: analyse.pages || null,
    sections: [...new Set(analyse.titres.filter((t) => t.niveau === 1).map((t) => titrePublic(t.texte)))],
    champs,
    pieces: piecesJointes(r).map((p) => ({
      intitule: p.intitule ? (SUSPECT.test(p.intitule) ? '[intitulé masqué]' : p.intitule) : null,
      origine: originePiece(p.fichier),
    })),
    mentions: analyse.mentions.map((m) => (semblePersonnel(m.texte) ? '[mention masquée]' : m.texte.slice(0, 300))),
  };
}

// ---------------------------------------------------------------------------
// 4. Statistiques sur le corpus
// ---------------------------------------------------------------------------

/** Seuils retenus : 60 exemplaires par type pour un résultat fiable, 30 pour une indication. */
function fiabilite(n) {
  if (n >= 60) return 'fiable';
  if (n >= 30) return 'indicatif';
  return 'insuffisant';
}

/** Strates d'un document : son type, croisé avec la forme juridique et avec chaque modification déclarée. */
function strates(d) {
  if (d.nature === 'beneficiaires') return [`Bénéficiaires effectifs · ${d.type || 'type inconnu'}`];
  const base = d.type || 'Type inconnu';
  const out = [base];
  if (d.forme) out.push(`${base} · ${d.forme}`);
  for (const m of new Set(d.modifications)) out.push(`${base} · ${m}`);
  return out;
}

const plus = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const classer = (o, max = Infinity) => Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
const pourcent = (x, n) => (n ? Math.round((1000 * x) / n) / 10 : 0);

/**
 * @param {object[]} documents fiches anonymes, une par formalité et par nature (dernière version),
 *   chacune avec versions: { nombre, rubriques_modifiees: [] }
 */
function agreger(documents, { lus = documents.length, ignores = 0, erreurs = {} } = {}) {
  const repartition = { nature: {}, type: {}, forme: {}, greffe: {}, annee: {} };
  const modifications = {};
  const combinaisons = {};
  const accus = new Map();
  const accu = (nom) => {
    if (!accus.has(nom)) accus.set(nom, { n: 0, champs: new Map(), pieces: {}, piecesDeposees: 0, plusieurs: 0, modifiees: 0, rubriques: {} });
    return accus.get(nom);
  };

  for (const d of documents) {
    plus(repartition.nature, d.nature === 'beneficiaires' ? 'Bénéficiaires effectifs' : 'Synthèse principale');
    plus(repartition.annee, (d.mois || 'inconnue').slice(0, 4));
    if (d.nature === 'principale') {
      plus(repartition.type, d.type || 'inconnu');
      plus(repartition.forme, d.forme || 'inconnue');
      plus(repartition.greffe, d.greffe || 'inconnu');
      const mods = [...new Set(d.modifications)];
      mods.forEach((m) => plus(modifications, m));
      if (mods.length) plus(combinaisons, mods.sort().join(' + '));
    }
    for (const nom of strates(d)) {
      const a = accu(nom);
      a.n += 1;
      const vus = new Map();
      for (const c of d.champs) {
        const st = a.champs.get(c.cle) || { docs: 0, vides: 0, valeurs: {} };
        a.champs.set(c.cle, st);
        const plein = c.renseigne === true || c.valeur !== undefined;
        vus.set(c.cle, (vus.get(c.cle) || false) || plein);
        if (c.valeur !== undefined) plus(st.valeurs, c.valeur);
      }
      for (const [k, plein] of vus) {
        const st = a.champs.get(k);
        if (plein) st.docs += 1; else st.vides += 1;
      }
      const deposees = d.pieces.filter((p) => p.origine === 'deposant');
      a.piecesDeposees += deposees.length;
      for (const intitule of new Set(deposees.map((p) => p.intitule || '(sans intitulé)'))) plus(a.pieces, intitule);
      if ((d.versions?.nombre || 1) > 1) a.plusieurs += 1;
      if (d.versions?.rubriques_modifiees?.length) {
        a.modifiees += 1;
        d.versions.rubriques_modifiees.forEach((k) => plus(a.rubriques, k));
      }
    }
  }

  const resultat = {};
  for (const [nom, a] of [...accus].sort((x, y) => y[1].n - x[1].n || x[0].localeCompare(y[0]))) {
    resultat[nom] = {
      n: a.n,
      fiabilite: fiabilite(a.n),
      pieces_deposees_par_dossier: Math.round((10 * a.piecesDeposees) / a.n) / 10,
      champs: [...a.champs]
        .map(([k, st]) => ({
          cle: k,
          taux: pourcent(st.docs, a.n),
          dossiers: st.docs,
          vides: st.vides,
          valeurs: Object.keys(st.valeurs).length ? Object.fromEntries(classer(st.valeurs, 25)) : undefined,
          valeurs_distinctes: Object.keys(st.valeurs).length || undefined,
        }))
        .sort((x, y) => y.dossiers - x.dossiers || x.cle.localeCompare(y.cle)),
      pieces: classer(a.pieces).map(([intitule, docs]) => ({ intitule, taux: pourcent(docs, a.n), dossiers: docs })),
      versions: {
        plusieurs_versions: a.plusieurs,
        contenu_modifie: a.modifiees,
        rubriques_modifiees: Object.fromEntries(classer(a.rubriques, 30)),
      },
    };
  }

  return {
    genere_le: new Date().toISOString(),
    documents_lus: lus,
    documents_ignores: ignores,
    erreurs,
    formalites: documents.length,
    repartition: Object.fromEntries(Object.entries(repartition).map(([k, v]) => [k, Object.fromEntries(classer(v))])),
    modifications: Object.fromEntries(classer(modifications)),
    combinaisons: Object.fromEntries(classer(combinaisons, 50)),
    strates: resultat,
  };
}

// ---------------------------------------------------------------------------
// 5. Rapport lisible
// ---------------------------------------------------------------------------

const LIBELLES_FIABILITE = { fiable: 'fiable', indicatif: 'indicatif', insuffisant: 'insuffisant' };

function rapport(agregats, { stratesDetaillees = 12 } = {}) {
  const a = agregats;
  const out = [];
  const tableau = (entetes, rangs) => {
    out.push(`| ${entetes.join(' | ')} |`, `|${entetes.map(() => '---').join('|')}|`);
    for (const r of rangs) out.push(`| ${r.join(' | ')} |`);
    out.push('');
  };
  out.push('# Corpus des synthèses du Guichet unique', '');
  out.push(`Généré le ${a.genere_le.slice(0, 10)}. Aucune donnée personnelle : seules la structure des synthèses et les valeurs de liste sont conservées.`, '');
  out.push(`- PDF lus : ${a.documents_lus}`);
  out.push(`- PDF écartés (pas une synthèse du guichet) : ${a.documents_ignores}`);
  out.push(`- PDF illisibles : ${Object.values(a.erreurs).reduce((s, n) => s + n, 0)}`);
  out.push(`- Formalités retenues (dernière version, synthèse principale ou des bénéficiaires effectifs) : ${a.formalites}`, '');

  out.push('## Répartition', '');
  tableau(['Type de formalité', 'Nombre'], classer(a.repartition.type).map(([k, v]) => [k, v]));
  tableau(['Forme juridique', 'Nombre'], classer(a.repartition.forme, 15).map(([k, v]) => [k, v]));
  tableau(['Greffe', 'Nombre'], classer(a.repartition.greffe, 15).map(([k, v]) => [k, v]));
  tableau(['Année', 'Nombre'], Object.entries(a.repartition.annee).sort().map(([k, v]) => [k, v]));

  if (Object.keys(a.modifications).length) {
    out.push('## Modifications déclarées', '');
    tableau(['Modification', 'Formalités'], classer(a.modifications, 30).map(([k, v]) => [k, v]));
    out.push('Combinaisons les plus fréquentes :', '');
    tableau(['Combinaison', 'Formalités'], classer(a.combinaisons, 15).map(([k, v]) => [k, v]));
  }

  out.push('## Fiabilité par strate', '');
  out.push('Seuils : 60 exemplaires ou plus, fiable ; 30 à 59, indicatif ; moins de 30, insuffisant.', '');
  tableau(['Strate', 'Exemplaires', 'Fiabilité'], Object.entries(a.strates).map(([k, s]) => [k, s.n, LIBELLES_FIABILITE[s.fiabilite]]));

  const detaillees = Object.entries(a.strates).filter(([, s]) => s.n >= 30).slice(0, stratesDetaillees);
  for (const [nom, s] of detaillees) {
    out.push(`## ${nom} (${s.n} formalités, ${LIBELLES_FIABILITE[s.fiabilite]})`, '');
    const toujours = s.champs.filter((c) => c.taux >= 95);
    const parfois = s.champs.filter((c) => c.taux >= 5 && c.taux < 95);
    out.push(`**Rubriques présentes dans au moins 95 % des dossiers** (${toujours.length}) :`, '');
    out.push(toujours.map((c) => c.cle).join(' ; ') || '—', '');
    out.push(`**Rubriques présentes dans 5 à 95 % des dossiers** (${parfois.length}) :`, '');
    tableau(['Rubrique', 'Présence'], parfois.slice(0, 60).map((c) => [c.cle, `${c.taux} %`]));
    const listes = s.champs.filter((c) => c.valeurs && c.valeurs_distinctes > 1 && c.valeurs_distinctes <= 40);
    if (listes.length) {
      out.push('**Valeurs relevées** :', '');
      tableau(['Rubrique', 'Valeurs (nombre)'], listes.slice(0, 40).map((c) => [c.cle, classer(c.valeurs, 6).map(([v, n]) => `${v} (${n})`).join(' ; ')]));
    }
    out.push(`**Pièces versées par le déposant** (${s.pieces_deposees_par_dossier} par dossier en moyenne) :`, '');
    tableau(['Pièce', 'Présence'], s.pieces.slice(0, 30).map((p) => [p.intitule, `${p.taux} %`]));
    if (s.versions.contenu_modifie) {
      out.push(`**Versions** : ${s.versions.plusieurs_versions} formalités à plusieurs versions, dont ${s.versions.contenu_modifie} au contenu modifié. Rubriques le plus souvent modifiées :`, '');
      tableau(['Rubrique', 'Formalités'], classer(s.versions.rubriques_modifiees, 15).map(([k, v]) => [k, v]));
    }
  }
  return `${out.join('\n')}\n`;
}

module.exports = {
  elementsPdf,
  analyserElements,
  lireSynthese,
  piecesJointes,
  originePiece,
  anonymiser,
  valeurPublique,
  semblePersonnel,
  titrePublic,
  empreintesContenu,
  rubriquesModifiees,
  agreger,
  fiabilite,
  rapport,
  COLONNE_VALEUR,
};
