'use strict';

/**
 * Matérialise les templates .docx dans templates/generated/.
 *
 * Ces fichiers servent de point de personnalisation : un template modifié à la
 * main (mise en forme du cabinet, clauses maison) est utilisé en priorité par
 * le moteur de génération, tant que les balises {variable} sont conservées.
 */

const fs = require('fs');
const path = require('path');

const { OPERATION_TYPES } = require('../src/definitions');
const { buildDocx } = require('../src/docx');

const OUT_DIR = path.join(__dirname, '..', 'templates', 'generated');
fs.mkdirSync(OUT_DIR, { recursive: true });

let count = 0;
for (const [type, def] of Object.entries(OPERATION_TYPES)) {
  for (const doc of def.documents) {
    const file = path.join(OUT_DIR, `${type}__${doc.code}.docx`);
    fs.writeFileSync(file, buildDocx(doc.template));
    count += 1;
    console.log(`✓ ${path.relative(process.cwd(), file)}`);
  }
}
console.log(`${count} templates générés dans ${path.relative(process.cwd(), OUT_DIR)}/`);
