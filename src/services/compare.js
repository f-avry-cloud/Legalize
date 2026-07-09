'use strict';

/**
 * Suivi de versions / markup : extraction du texte des versions (.docx ou
 * .pdf) et comparaison mot à mot (ajouts / suppressions), rendue côté client.
 */

const fs = require('fs');
const path = require('path');
const { diffWordsWithSpace } = require('diff');

const db = require('../db');
const { extractDocxText, extractPdfText } = require('../docx');

async function extractText(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const buffer = fs.readFileSync(filepath);
  if (ext === '.docx') return extractDocxText(buffer);
  if (ext === '.pdf') return extractPdfText(buffer);
  if (ext === '.txt') return buffer.toString('utf8');
  throw new Error(`Format non pris en charge pour la comparaison : ${ext || 'inconnu'}`);
}

/**
 * Compare deux versions d'un document.
 * Retourne des segments [{value, added, removed}] + statistiques.
 */
async function comparerVersions(documentId, versionFromId, versionToId) {
  const get = db.prepare('SELECT * FROM document_versions WHERE id = ? AND document_id = ?');
  const vFrom = get.get(versionFromId, documentId);
  const vTo = get.get(versionToId, documentId);
  if (!vFrom || !vTo) throw new Error('Version introuvable pour ce document');

  const [textFrom, textTo] = await Promise.all([extractText(vFrom.filepath), extractText(vTo.filepath)]);
  const segments = diffWordsWithSpace(textFrom, textTo).map((s) => ({
    value: s.value,
    added: Boolean(s.added),
    removed: Boolean(s.removed),
  }));

  const stats = {
    ajouts: segments.filter((s) => s.added).length,
    suppressions: segments.filter((s) => s.removed).length,
    identique: segments.every((s) => !s.added && !s.removed),
  };

  return {
    from: { id: vFrom.id, numero: vFrom.numero, source: vFrom.source, filename: vFrom.filename },
    to: { id: vTo.id, numero: vTo.numero, source: vTo.source, filename: vTo.filename },
    segments,
    stats,
  };
}

module.exports = { comparerVersions, extractText };
