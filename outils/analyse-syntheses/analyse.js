'use strict';

/**
 * Analyse des synthèses du Guichet unique, sur ce PC, sans données personnelles.
 *
 * Par défaut : lit « Téléchargements\Documents de synthèse pour Legalize » et
 * écrit les résultats dans « Téléchargements\Resultats syntheses Legalize ».
 * Un autre dossier de synthèses peut être glissé sur LANCER.cmd.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const [majeur, mineur] = process.versions.node.split('.').map(Number);
if (majeur < 20 || (majeur === 20 && mineur < 16) || (majeur === 22 && mineur < 3)) {
  console.error(`Node.js ${process.versions.node} est trop ancien : installez la version LTS depuis https://nodejs.org puis relancez.`);
  process.exit(2);
}

const telechargements = path.join(os.homedir(), 'Downloads');
const dossier = process.argv[2] ? path.resolve(process.argv[2]) : path.join(telechargements, 'Documents de synthèse pour Legalize');
const sortie = path.join(telechargements, 'Resultats syntheses Legalize');

if (!fs.existsSync(dossier) || !fs.statSync(dossier).isDirectory()) {
  console.error(`Dossier introuvable : ${dossier}`);
  console.error('Glissez le dossier des synthèses sur LANCER.cmd, ou placez-le dans Téléchargements sous ce nom.');
  process.exit(2);
}

console.log('Analyse des synthèses du Guichet unique');
console.log(`  Synthèses : ${dossier}`);
console.log(`  Résultats : ${sortie}`);
console.log('  Les PDF ne sont ni modifiés ni copiés ; les résultats ne contiennent aucune donnée personnelle.\n');

process.argv = [process.argv[0], path.join(__dirname, 'scripts', 'corpus-syntheses.js'), dossier, '--sortie', sortie];
require('./scripts/corpus-syntheses.js');
