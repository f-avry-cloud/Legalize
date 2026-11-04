#!/usr/bin/env node
'use strict';

/**
 * Analyse d'un dossier de synthèses du Guichet unique (PDF), sans données personnelles.
 *
 *   node scripts/corpus-syntheses.js <dossier> [--sortie <dossier>] [--limite <n>] [--sans-fiches]
 *                                    [--seuil <n>] [--exemples <dossier>]
 *
 * Le dossier est parcouru en entier (sous-dossiers compris). Les PDF qui ne
 * sont pas des synthèses du guichet (reçus, actes…) sont écartés. Les versions
 * successives d'une même formalité (v1, v2, signée…) sont regroupées : on garde
 * la dernière et on note les rubriques modifiées entre deux versions.
 *
 * Écrit dans le dossier de sortie (par défaut ./resultats-syntheses) :
 *   - rapport.md    : synthèse lisible (qualité de lecture, répartition, fiabilité, rubriques, pièces, versions) ;
 *   - agregats.json : les statistiques complètes ;
 *   - fiches.jsonl  : une fiche anonyme par formalité, sauf avec --sans-fiches.
 * Aucun de ces fichiers ne contient de nom, de date de naissance, d'adresse, de numéro
 * ni de nom de fichier ; tout élément présent dans moins de --seuil formalités (3 par
 * défaut) est masqué.
 *
 * --exemples <dossier> : copie, sur le poste seulement, jusqu'à 3 PDF de chaque cas de
 * lecture difficile (écartés, type introuvable, lecture à vérifier), pour mise au point.
 * Ces copies sont les synthèses elles-mêmes : elles contiennent des données personnelles.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  lireSynthese, anonymiser, empreintesContenu, rubriquesModifiees, retenirValeursFrequentes, masquerRares,
  lectureDouteuse, agreger, rapport, SEUIL_FREQUENCE,
} = require('../src/inpi/synthese-gu');

function lireOptions(argv) {
  const o = { dossier: null, sortie: path.resolve('resultats-syntheses'), limite: Infinity, fiches: true, seuil: SEUIL_FREQUENCE, exemples: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sortie') o.sortie = path.resolve(argv[(i += 1)]);
    else if (a === '--limite') o.limite = Number(argv[(i += 1)]);
    else if (a === '--sans-fiches') o.fiches = false;
    else if (a === '--seuil') o.seuil = Math.max(1, Number(argv[(i += 1)]) || SEUIL_FREQUENCE);
    else if (a === '--exemples') o.exemples = path.resolve(argv[(i += 1)]);
    else if (!o.dossier) o.dossier = path.resolve(a);
  }
  return o;
}

/** PDF du dossier, sous-dossiers compris (fichiers et dossiers cachés exclus, dont « ._… » de macOS). */
function listerPdf(dossier, exclus = []) {
  const out = [];
  const pile = [dossier];
  while (pile.length) {
    const d = pile.pop();
    if (exclus.some((x) => path.resolve(d) === x)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) pile.push(p);
      else if (e.isFile() && /\.pdf$/i.test(e.name)) out.push(p);
    }
  }
  return out.sort();
}

function raison(e) {
  if (e?.name === 'PasswordException') return 'protégé par mot de passe';
  if (e?.name === 'InvalidPDFException') return 'PDF invalide';
  return 'illisible';
}

const comparerRang = (a, b) => a[0].localeCompare(b[0]) || a[1] - b[1];

function mode(valeurs) {
  const compte = new Map();
  let meilleure = null;
  let n = 0;
  for (const v of valeurs) {
    const k = (compte.get(v) || 0) + 1;
    compte.set(v, k);
    if (k > n) { meilleure = v; n = k; }
  }
  return meilleure;
}

/** Jusqu'à `max` éléments répartis dans la liste (début, milieu, fin) plutôt que les premiers. */
function repartis(liste, max = 3) {
  if (liste.length <= max) return liste;
  return Array.from({ length: max }, (_, i) => liste[Math.round((i * (liste.length - 1)) / (max - 1))]);
}

function copierExemples(dossier, cas) {
  fs.mkdirSync(dossier, { recursive: true });
  for (const f of fs.readdirSync(dossier)) if (/^(ecarte|type-introuvable|a-verifier)-\d+\.pdf$/.test(f)) fs.rmSync(path.join(dossier, f));
  const bilan = [];
  for (const [nom, sources] of Object.entries(cas)) {
    repartis(sources).forEach((src, i) => fs.copyFileSync(src, path.join(dossier, `${nom}-${i + 1}.pdf`)));
    if (sources.length) bilan.push(`${nom} : ${Math.min(3, sources.length)} sur ${sources.length}`);
  }
  return bilan;
}

async function main() {
  const o = lireOptions(process.argv.slice(2));
  if (!o.dossier || !fs.existsSync(o.dossier) || !fs.statSync(o.dossier).isDirectory()) {
    console.error('Usage : node scripts/corpus-syntheses.js <dossier des PDF> [--sortie <dossier>] [--limite <n>] [--sans-fiches] [--seuil <n>] [--exemples <dossier>]');
    process.exit(2);
  }
  const fichiers = listerPdf(o.dossier, [o.sortie, o.exemples].filter(Boolean)).slice(0, o.limite);
  const sel = crypto.randomBytes(16); // pseudonymes propres à cette exécution, jamais écrits
  const groupes = new Map();
  const erreurs = {};
  const enErreur = [];
  const ecartes = [];
  const debut = Date.now();

  for (let i = 0; i < fichiers.length; i += 1) {
    const f = fichiers[i];
    let analyse;
    try {
      analyse = await lireSynthese(fs.readFileSync(f));
    } catch (e) {
      const r = raison(e);
      erreurs[r] = (erreurs[r] || 0) + 1;
      enErreur.push(`${r} : ${path.relative(o.dossier, f)} (${String(e?.message || e).split('\n')[0].slice(0, 160)})`);
      continue;
    }
    if (!analyse.est_synthese || !analyse.liasse || analyse.rubriques.length < 5) { ecartes.push(f); continue; }

    const k = `${analyse.liasse}|${analyse.nature}`;
    const g = groupes.get(k) || { versions: [], meilleure: null };
    groupes.set(k, g);
    const globale = crypto.createHash('sha256').update(JSON.stringify(analyse.rubriques.map((r) => [r.bloc, r.libelle, r.valeur]))).digest('hex');
    // Deux fichiers identiques (même synthèse téléchargée deux fois) ne font qu'une version.
    if (!g.versions.some((v) => v.globale === globale)) {
      g.versions.push({ rang: [analyse.date_synthese || '', analyse.rubriques.length], globale, empreintes: empreintesContenu(analyse) });
    }
    const rang = [analyse.date_synthese || '', analyse.rubriques.length];
    if (!g.meilleure || comparerRang(rang, g.meilleure.rang) > 0) g.meilleure = { rang, fiche: anonymiser(analyse, { sel }), source: f };

    if ((i + 1) % 100 === 0 || i + 1 === fichiers.length) {
      process.stderr.write(`\r${i + 1}/${fichiers.length} PDF traités (${Math.round((Date.now() - debut) / 1000)} s)`);
    }
  }
  process.stderr.write('\n');

  const fiches = [];
  const sources = [];
  for (const g of groupes.values()) {
    const v = g.versions.sort((a, b) => comparerRang(a.rang, b.rang));
    const modifiees = new Set();
    for (let i = 1; i < v.length; i += 1) rubriquesModifiees(v[i - 1].empreintes, v[i].empreintes).forEach((x) => modifiees.add(x));
    fiches.push({ ...g.meilleure.fiche, versions: { nombre: v.length, rubriques_modifiees: [...modifiees].sort() } });
    sources.push(g.meilleure.source);
  }

  // Cas de lecture difficile, relevés avant le masquage (chemins en mémoire seulement).
  const colonneUsuelle = mode(fiches.map((f) => f.lecture?.colonne_valeur).filter((x) => x !== null && x !== undefined));
  const cas = { ecarte: ecartes, 'type-introuvable': [], 'a-verifier': [] };
  fiches.forEach((f, i) => {
    if (!f.type) cas['type-introuvable'].push(sources[i]);
    else if (lectureDouteuse(f.lecture, colonneUsuelle)) cas['a-verifier'].push({ source: sources[i], mois: f.mois || '' });
  });
  cas['a-verifier'] = cas['a-verifier'].sort((a, b) => b.mois.localeCompare(a.mois)).map((x) => x.source);

  // Valeurs des rubriques inconnues, puis tout élément rare : masqués avant toute écriture.
  retenirValeursFrequentes(fiches, { seuil: o.seuil });
  const masquage = { seuil: o.seuil, ...masquerRares(fiches, { seuil: o.seuil }) };
  const agregats = agreger(fiches, { lus: fichiers.length, ignores: ecartes.length, erreurs, masquage });
  fs.mkdirSync(o.sortie, { recursive: true });
  fs.writeFileSync(path.join(o.sortie, 'agregats.json'), `${JSON.stringify(agregats, null, 1)}\n`);
  fs.writeFileSync(path.join(o.sortie, 'rapport.md'), rapport(agregats));
  const ancienne = path.join(o.sortie, 'fiches.jsonl');
  if (o.fiches) fs.writeFileSync(ancienne, fiches.map((x) => JSON.stringify(x)).join('\n') + (fiches.length ? '\n' : ''));
  else if (fs.existsSync(ancienne)) fs.rmSync(ancienne);

  console.log(`${fichiers.length} PDF lus en ${Math.round((Date.now() - debut) / 1000)} s : ${fiches.length} formalités retenues, ${ecartes.length} PDF écartés (pas une synthèse), ${enErreur.length} illisibles.`);
  console.log(`Résultats : ${o.sortie}`);
  if (o.exemples) {
    const bilan = copierExemples(o.exemples, cas);
    console.log(`\nExemples de lecture difficile copiés dans ${o.exemples}${bilan.length ? ` (${bilan.join(' ; ')})` : ' : aucun'}.`);
    console.log('Ce sont les synthèses elles-mêmes, avec leurs données personnelles.');
  }
  if (enErreur.length) {
    console.log('\nFichiers illisibles (liste affichée ici seulement, écrite nulle part) :');
    enErreur.forEach((x) => console.log(`  ${x}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
