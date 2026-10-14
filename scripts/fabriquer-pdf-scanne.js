'use strict';

/**
 * Fabrique un PDF « scanné » (pages image, sans couche texte) pour éprouver
 * la reconnaissance de caractères : scripts/fixtures/acte-scanne.pdf.
 *
 *   node scripts/fabriquer-pdf-scanne.js
 */

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const PAGES = [
  ['STATUTS', 'SOCIÉTÉ PAR ACTIONS SIMPLIFIÉE', 'AU CAPITAL DE 100 000 EUROS', '',
    'ARTICLE 2 - OBJET', 'La société a pour objet l’accouvage, la sélection', 'et le commerce de volailles.'],
  ['ARTICLE 5 - DURÉE', 'La durée de la société est fixée à', 'quatre-vingt-dix-neuf années.', '', 'Fait à Quimper, le 1er septembre 2026.'],
];

function pageJpeg(lignes) {
  const c = createCanvas(1240, 1754); // A4 à 150 dpi
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 1240, 1754);
  g.fillStyle = '#111'; g.font = '44px serif';
  lignes.forEach((l, i) => g.fillText(l, 120, 200 + i * 80));
  return c.encodeSync('jpeg', 85);
}

/** PDF minimal : une image JPEG pleine page par page, aucun texte. */
function pdfImages(jpegs) {
  const objets = [];
  const ajouter = (corps) => { objets.push(corps); return objets.length; };
  const catalogue = ajouter(null);
  const arbre = ajouter(null);
  const pages = [];
  for (const j of jpegs) {
    const img = ajouter(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.length} >>\nstream\n`), j, Buffer.from('\nendstream')]));
    const dessin = 'q 595 0 0 842 0 0 cm /Im0 Do Q';
    const contenu = ajouter(`<< /Length ${dessin.length} >>\nstream\n${dessin}\nendstream`);
    pages.push(ajouter(`<< /Type /Page /Parent ${arbre} 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${contenu} 0 R >>`));
  }
  objets[catalogue - 1] = `<< /Type /Catalog /Pages ${arbre} 0 R >>`;
  objets[arbre - 1] = `<< /Type /Pages /Kids [${pages.map((p) => `${p} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  const morceaux = [Buffer.from('%PDF-1.4\n')];
  const positions = [];
  let taille = morceaux[0].length;
  objets.forEach((o, i) => {
    positions.push(taille);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from('\nendobj\n')]);
    morceaux.push(b); taille += b.length;
  });
  const xref = `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  morceaux.push(Buffer.from(`${xref}trailer\n<< /Size ${objets.length + 1} /Root ${catalogue} 0 R >>\nstartxref\n${taille}\n%%EOF\n`));
  return Buffer.concat(morceaux);
}

const cible = path.join(__dirname, 'fixtures/acte-scanne.pdf');
fs.writeFileSync(cible, pdfImages(PAGES.map(pageJpeg)));
console.log(cible, fs.statSync(cible).size, 'octets');
