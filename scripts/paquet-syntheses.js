#!/usr/bin/env node
'use strict';

/**
 * Fabrique le paquet autonome d'analyse des synthèses, à lancer sur un poste
 * Windows hors du projet (double-clic sur LANCER.cmd) :
 *
 *   node scripts/paquet-syntheses.js [chemin du zip]   (par défaut ./analyse-syntheses-legalize.zip)
 *
 * Le zip contient le lanceur (outils/analyse-syntheses), le programme du corpus
 * et le module de lecture tels qu'ils sont dans le projet, et pdf.js (Apache 2.0).
 * Il n'a besoin que de Node.js : pas d'installation de paquets, pas de réseau.
 */

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const racine = path.join(__dirname, '..');
const cible = path.resolve(process.argv[2] || 'analyse-syntheses-legalize.zip');
const dossier = 'analyse-syntheses-legalize';
const pdfjs = path.dirname(require.resolve('pdfjs-dist/package.json', { paths: [racine] }));

const contenu = [
  ['LANCER.cmd', path.join(racine, 'outils/analyse-syntheses/LANCER.cmd')],
  ['LISEZ-MOI.txt', path.join(racine, 'outils/analyse-syntheses/LISEZ-MOI.txt')],
  ['analyse.js', path.join(racine, 'outils/analyse-syntheses/analyse.js')],
  ['scripts/corpus-syntheses.js', path.join(racine, 'scripts/corpus-syntheses.js')],
  ['src/inpi/synthese-gu.js', path.join(racine, 'src/inpi/synthese-gu.js')],
  ['node_modules/pdfjs-dist/package.json', path.join(pdfjs, 'package.json')],
  ['node_modules/pdfjs-dist/LICENSE', path.join(pdfjs, 'LICENSE')],
  ['node_modules/pdfjs-dist/legacy/build/pdf.mjs', path.join(pdfjs, 'legacy/build/pdf.mjs')],
  ['node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', path.join(pdfjs, 'legacy/build/pdf.worker.mjs')],
];

const zip = new PizZip();
for (const [nom, source] of contenu) {
  let donnees = fs.readFileSync(source);
  // Fins de ligne Windows pour le lanceur ; marque UTF-8 pour que le Bloc-notes affiche les accents.
  if (nom.endsWith('.cmd')) donnees = Buffer.from(donnees.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
  if (nom.endsWith('.txt') && donnees[0] !== 0xef) donnees = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), donnees]);
  zip.file(`${dossier}/${nom}`, donnees);
}
fs.writeFileSync(cible, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Paquet écrit : ${cible} (${Math.round(fs.statSync(cible).size / 1024)} Ko)`);
