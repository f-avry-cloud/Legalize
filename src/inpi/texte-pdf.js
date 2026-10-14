'use strict';

/**
 * Texte d'un PDF déposé au registre (acte, comptes annuels), pour que Claude
 * le lise et l'analyse directement.
 *
 * La couche texte du PDF est lue d'abord. Une page qui n'en a pas (acte
 * numérisé par le greffe, cas fréquent) passe à la reconnaissance de
 * caractères : la page est rendue en image puis lue par Tesseract (français).
 * La reconnaissance coûte quelques secondes par page : elle s'arrête au
 * budget de temps fixé et indique les pages restantes, à demander ensuite.
 */

const path = require('path');

const SEUIL_TEXTE = 40; // caractères utiles en deçà desquels une page est tenue pour scannée

/** Pages « 3-5,8 » ou [3,4,5] → liste triée et bornée. */
function pagesDemandees(demande, total) {
  if (!demande) return null;
  const liste = Array.isArray(demande) ? demande : String(demande).split(',').flatMap((morceau) => {
    const [a, b] = morceau.split('-').map((x) => Number(x.trim()));
    return b ? Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i) : [a];
  });
  return [...new Set(liste.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= total))].sort((x, y) => x - y);
}

let travailleur = null;
async function ocr() {
  if (!travailleur) {
    const { createWorker } = require('tesseract.js');
    const donnees = path.dirname(require.resolve('@tesseract.js-data/fra/package.json'));
    travailleur = await createWorker('fra', 1, {
      langPath: path.join(donnees, '4.0.0_best_int'),
      gzip: true,
      cachePath: require('os').tmpdir(),
    });
  }
  return travailleur;
}

/**
 * @param {Buffer} buffer PDF
 * @param {{ pages?: string|number[], budgetMs?: number }} options
 * @returns {{ pages_total, texte, pages: [{ page, texte, ocr }], scanne, pages_restantes }}
 */
async function textePdf(buffer, { pages: demande, budgetMs = 35000, maxCaracteres = 60000 } = {}) {
  const debut = Date.now();
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const t = await parser.getText();
    const total = t.total || t.pages.length;
    const voulues = pagesDemandees(demande, total) || Array.from({ length: total }, (_, i) => i + 1);
    const resultat = [];
    const restantes = [];
    let ocrisees = 0;
    let longueur = 0;
    for (const n of voulues) {
      // Au-delà du volume ou du temps alloués, les pages sont rendues à la demande suivante.
      if (longueur > maxCaracteres) { restantes.push(n); continue; }
      const brut = (t.pages.find((p) => p.num === n)?.text || '').trim();
      if (brut.replace(/\s/g, '').length >= SEUIL_TEXTE) { resultat.push({ page: n, texte: brut, ocr: false }); longueur += brut.length; continue; }
      if (Date.now() - debut > budgetMs) { restantes.push(n); continue; }
      const image = await parser.getScreenshot({ partial: [n], scale: 2, imageBuffer: true, imageDataUrl: false });
      const donnees = image.pages[0]?.data;
      if (!donnees) { resultat.push({ page: n, texte: '', ocr: true }); continue; }
      const { data } = await (await ocr()).recognize(Buffer.from(donnees));
      resultat.push({ page: n, texte: String(data.text || '').trim(), ocr: true, confiance: Math.round(data.confidence || 0) });
      longueur += String(data.text || '').length;
      ocrisees += 1;
    }
    return {
      pages_total: total,
      scanne: resultat.some((p) => p.ocr) || restantes.length > 0,
      pages_lues_par_ocr: ocrisees,
      pages_restantes: restantes,
      pages: resultat,
      texte: resultat.map((p) => `--- Page ${p.page}${p.ocr ? ' (reconnaissance de caractères)' : ''} ---\n${p.texte}`).join('\n\n'),
    };
  } finally {
    if (typeof parser.destroy === 'function') await parser.destroy();
  }
}

module.exports = { textePdf, pagesDemandees };
