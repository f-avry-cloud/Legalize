'use strict';

/**
 * Le guichet refuse une pièce jointe qu'il ne peut pas ouvrir (« La pièce
 * jointe est corrompue », constaté par essai) : on le vérifie au chargement.
 */
async function pdfLisible(buffer) {
  try {
    const { PDFParse } = require('pdf-parse');
    await new PDFParse({ data: buffer }).getInfo();
    return true;
  } catch {
    return false;
  }
}

const MESSAGE_ILLISIBLE = 'Ce PDF est illisible ou abîmé : le guichet le refuserait. Réenregistrez-le (par exemple « Imprimer en PDF ») puis chargez-le à nouveau.';

module.exports = { pdfLisible, MESSAGE_ILLISIBLE };
