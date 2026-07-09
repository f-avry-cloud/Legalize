'use strict';

/**
 * Construction de fichiers .docx (templates avec balises docxtemplater)
 * et extraction de texte (.docx / .pdf) pour la comparaison de versions.
 */

const PizZip = require('pizzip');

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STYLES = {
  title: { jc: 'center', bold: true, size: 32, spacingBefore: 240, spacingAfter: 360 },
  h1: { jc: 'left', bold: true, size: 26, spacingBefore: 360, spacingAfter: 160 },
  h2: { jc: 'left', bold: true, size: 24, spacingBefore: 240, spacingAfter: 120 },
  p: { jc: 'both', bold: false, size: 22, spacingBefore: 0, spacingAfter: 160 },
  center: { jc: 'center', bold: false, size: 22, spacingBefore: 0, spacingAfter: 120 },
  right: { jc: 'right', bold: false, size: 22, spacingBefore: 0, spacingAfter: 120 },
  sign: { jc: 'left', bold: true, size: 22, spacingBefore: 600, spacingAfter: 120 },
};

function paragraphXml(block) {
  const s = STYLES[block.style] || STYLES.p;
  return (
    '<w:p>' +
    '<w:pPr>' +
    `<w:spacing w:before="${s.spacingBefore}" w:after="${s.spacingAfter}" w:line="276" w:lineRule="auto"/>` +
    `<w:jc w:val="${s.jc}"/>` +
    '</w:pPr>' +
    '<w:r>' +
    `<w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/>${s.bold ? '<w:b/>' : ''}<w:sz w:val="${s.size}"/><w:szCs w:val="${s.size}"/></w:rPr>` +
    `<w:t xml:space="preserve">${esc(block.text)}</w:t>` +
    '</w:r>' +
    '</w:p>'
  );
}

/** Construit un .docx (Buffer) à partir d'une liste de blocs {style, text}. */
function buildDocx(blocks) {
  const body = blocks.map(paragraphXml).join('');
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417"/></w:sectPr>' +
    '</w:body></w:document>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const zip = new PizZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rels);
  zip.file('word/document.xml', documentXml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Extrait le texte d'un .docx : un paragraphe par ligne. */
function extractDocxText(buffer) {
  const zip = new PizZip(buffer);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('Fichier .docx invalide (word/document.xml absent)');
  const xml = doc.asText();
  const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  return paragraphs
    .map((p) => {
      const runs = p.match(/<w:t(?:[^>]*)>([\s\S]*?)<\/w:t>/g) || [];
      return runs
        .map((r) => r.replace(/<[^>]+>/g, ''))
        .join('')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
    })
    .filter((t) => t.trim() !== '')
    .join('\n');
}

/** Extrait le texte d'un .pdf. */
async function extractPdfText(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return (result.text || '').trim();
  } finally {
    if (typeof parser.destroy === 'function') await parser.destroy();
  }
}

module.exports = { buildDocx, extractDocxText, extractPdfText };
