'use strict';

/**
 * Le guichet refuse une pièce jointe qu'il ne peut pas ouvrir (« La pièce
 * jointe est corrompue », constaté par essai) : on le vérifie au chargement.
 *
 * Contrôle de structure, sans bibliothèque de rendu (celle-ci ne fonctionne
 * pas sur l'hébergement, constaté en production) : en-tête PDF, marque de
 * fin, et table des objets (« startxref ») qui pointe bien sur une table ou
 * un flux de références à l'intérieur du fichier.
 */
function pdfLisible(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 64) return false;
  if (buffer.subarray(0, 1024).indexOf('%PDF-') === -1) return false;
  const fin = buffer.subarray(Math.max(0, buffer.length - 2048)).toString('latin1');
  if (!fin.includes('%%EOF')) return false;
  const m = /startxref\s+(\d+)\s+%%EOF/.exec(fin);
  if (!m) return false;
  const position = Number(m[1]);
  if (!position || position >= buffer.length) return false;
  const cible = buffer.subarray(position, position + 32).toString('latin1');
  return /^\s*(xref|\d+\s+\d+\s+obj)/.test(cible);
}

const MESSAGE_ILLISIBLE = 'Ce PDF est illisible ou abîmé : le guichet le refuserait. Réenregistrez-le (par exemple « Imprimer en PDF ») puis chargez-le à nouveau.';

module.exports = { pdfLisible, MESSAGE_ILLISIBLE };
