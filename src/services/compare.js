'use strict';

/**
 * Suivi de versions / markup : extraction du texte des versions (.docx ou
 * .pdf, stockées dans Supabase Storage) et comparaison mot à mot.
 */

const path = require('path');
const { diffWordsWithSpace } = require('diff');

const { supabase, q, downloadFile } = require('../supa');
const { extractDocxText, extractPdfText } = require('../docx');

async function extractText(version) {
  const ext = path.extname(version.filename).toLowerCase();
  const buffer = await downloadFile(version.filepath);
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
  const vFrom = await q(supabase.from('document_versions').select('*').eq('id', versionFromId).eq('document_id', documentId).single());
  const vTo = await q(supabase.from('document_versions').select('*').eq('id', versionToId).eq('document_id', documentId).single());

  const [textFrom, textTo] = await Promise.all([extractText(vFrom), extractText(vTo)]);
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
