#!/usr/bin/env node
'use strict';

/**
 * Analyse d'un dossier de synthèses du Guichet unique (PDF), sans données personnelles.
 *
 *   node scripts/corpus-syntheses.js <dossier> [--sortie <dossier>] [--limite <n>] [--sans-fiches]
 *
 * Le dossier est parcouru en entier (sous-dossiers compris). Les PDF qui ne
 * sont pas des synthèses du guichet (reçus, actes…) sont écartés. Les versions
 * successives d'une même formalité (v1, v2, signée…) sont regroupées : on garde
 * la dernière et on note les rubriques modifiées entre deux versions.
 *
 * Écrit dans le dossier de sortie (par défaut ./resultats-syntheses) :
 *   - rapport.md    : synthèse lisible (répartition, fiabilité, rubriques, pièces, versions) ;
 *   - agregats.json : les statistiques complètes ;
 *   - fiches.jsonl  : une fiche anonyme par formalité (structure et valeurs de liste),
 *                     sauf avec --sans-fiches.
 * Aucun de ces fichiers ne contient de nom, de date de naissance, d'adresse, de numéro
 * ni de nom de fichier. Les fichiers illisibles sont seulement listés à l'écran.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lireSynthese, anonymiser, empreintesContenu, rubriquesModifiees, agreger, rapport } = require('../src/inpi/synthese-gu');

function lireOptions(argv) {
  const o = { dossier: null, sortie: path.resolve('resultats-syntheses'), limite: Infinity, fiches: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sortie') o.sortie = path.resolve(argv[(i += 1)]);
    else if (a === '--limite') o.limite = Number(argv[(i += 1)]);
    else if (a === '--sans-fiches') o.fiches = false;
    else if (!o.dossier) o.dossier = path.resolve(a);
  }
  return o;
}

/** PDF du dossier, sous-dossiers compris (fichiers et dossiers cachés exclus, dont « ._… » de macOS). */
function listerPdf(dossier) {
  const out = [];
  const pile = [dossier];
  while (pile.length) {
    const d = pile.pop();
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

async function main() {
  const o = lireOptions(process.argv.slice(2));
  if (!o.dossier || !fs.existsSync(o.dossier) || !fs.statSync(o.dossier).isDirectory()) {
    console.error('Usage : node scripts/corpus-syntheses.js <dossier des PDF> [--sortie <dossier>] [--limite <n>] [--sans-fiches]');
    process.exit(2);
  }
  const fichiers = listerPdf(o.dossier).slice(0, o.limite);
  const sel = crypto.randomBytes(16); // pseudonymes propres à cette exécution, jamais écrits
  const groupes = new Map();
  const erreurs = {};
  const enErreur = [];
  let ignores = 0;
  const debut = Date.now();

  for (let i = 0; i < fichiers.length; i += 1) {
    const f = fichiers[i];
    let analyse;
    try {
      analyse = await lireSynthese(fs.readFileSync(f));
    } catch (e) {
      const r = raison(e);
      erreurs[r] = (erreurs[r] || 0) + 1;
      enErreur.push(`${r} : ${path.relative(o.dossier, f)}`);
      continue;
    }
    if (!analyse.est_synthese || !analyse.liasse || analyse.rubriques.length < 5) { ignores += 1; continue; }

    const k = `${analyse.liasse}|${analyse.nature}`;
    const g = groupes.get(k) || { versions: [], meilleure: null };
    groupes.set(k, g);
    const globale = crypto.createHash('sha256').update(JSON.stringify(analyse.rubriques.map((r) => [r.bloc, r.libelle, r.valeur]))).digest('hex');
    // Deux fichiers identiques (même synthèse téléchargée deux fois) ne font qu'une version.
    if (!g.versions.some((v) => v.globale === globale)) {
      g.versions.push({ rang: [analyse.date_synthese || '', analyse.rubriques.length], globale, empreintes: empreintesContenu(analyse) });
    }
    const rang = [analyse.date_synthese || '', analyse.rubriques.length];
    if (!g.meilleure || comparerRang(rang, g.meilleure.rang) > 0) g.meilleure = { rang, fiche: anonymiser(analyse, { sel }) };

    if ((i + 1) % 100 === 0 || i + 1 === fichiers.length) {
      process.stderr.write(`\r${i + 1}/${fichiers.length} PDF traités (${Math.round((Date.now() - debut) / 1000)} s)`);
    }
  }
  process.stderr.write('\n');

  const fiches = [];
  for (const g of groupes.values()) {
    const v = g.versions.sort((a, b) => comparerRang(a.rang, b.rang));
    const modifiees = new Set();
    for (let i = 1; i < v.length; i += 1) rubriquesModifiees(v[i - 1].empreintes, v[i].empreintes).forEach((x) => modifiees.add(x));
    fiches.push({ ...g.meilleure.fiche, versions: { nombre: v.length, rubriques_modifiees: [...modifiees].sort() } });
  }

  const agregats = agreger(fiches, { lus: fichiers.length, ignores, erreurs });
  fs.mkdirSync(o.sortie, { recursive: true });
  fs.writeFileSync(path.join(o.sortie, 'agregats.json'), `${JSON.stringify(agregats, null, 1)}\n`);
  fs.writeFileSync(path.join(o.sortie, 'rapport.md'), rapport(agregats));
  if (o.fiches) fs.writeFileSync(path.join(o.sortie, 'fiches.jsonl'), fiches.map((x) => JSON.stringify(x)).join('\n') + (fiches.length ? '\n' : ''));

  console.log(`${fichiers.length} PDF lus en ${Math.round((Date.now() - debut) / 1000)} s : ${fiches.length} formalités retenues, ${ignores} PDF écartés (pas une synthèse), ${enErreur.length} illisibles.`);
  console.log(`Résultats : ${o.sortie}`);
  if (enErreur.length) {
    console.log('\nFichiers illisibles (liste affichée ici seulement, écrite nulle part) :');
    enErreur.forEach((x) => console.log(`  ${x}`));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
