'use strict';

/**
 * Génération documentaire en un clic : à partir d'une opération (variables
 * saisies une seule fois) et de la fiche société, génère l'intégralité des
 * documents de la checklist en une passe.
 */

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');

const db = require('../db');
const { OPERATION_TYPES } = require('../definitions');
const { buildDocx } = require('../docx');

const STORAGE_DIR = process.env.LEGALIZE_STORAGE_DIR
  || (process.env.VERCEL ? '/tmp/legalize/storage' : path.join(__dirname, '..', '..', 'storage'));
const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'templates', 'generated');

const nbFmt = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

function fmtNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? nbFmt.format(n) : String(v ?? '');
}

function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : dateFmt.format(d);
}

function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'sans-nom';
}

/** Construit le contexte de fusion : société + dirigeant + associés + variables d'opération. */
function buildContext(operation) {
  const societe = db.prepare('SELECT * FROM societes WHERE id = ?').get(operation.societe_id);
  if (!societe) throw new Error('Société introuvable');
  const dirigeant = db.prepare('SELECT * FROM dirigeants WHERE societe_id = ? ORDER BY id LIMIT 1').get(societe.id);
  const associes = db.prepare('SELECT * FROM associes WHERE societe_id = ? ORDER BY nb_titres DESC').all(societe.id);
  const def = OPERATION_TYPES[operation.type];
  if (!def) throw new Error(`Type d'opération inconnu : ${operation.type}`);
  const vars = JSON.parse(operation.variables || '{}');

  const totalTitres = societe.nb_titres || associes.reduce((s, a) => s + a.nb_titres, 0) || 0;

  const ctx = {
    date_jour: dateFmt.format(new Date()),
    societe_denomination: societe.denomination,
    societe_forme: societe.forme_sociale,
    societe_capital: fmtNumber(societe.capital_social),
    societe_siege: societe.siege_social,
    societe_siren: societe.siren,
    societe_rcs: societe.rcs_ville,
    societe_objet: societe.objet_social,
    societe_cloture: societe.date_cloture === '31/12' ? '31 décembre' : societe.date_cloture,
    societe_nb_titres: fmtNumber(societe.nb_titres),
    dirigeant_nom_complet: dirigeant ? `${dirigeant.civilite} ${dirigeant.prenom} ${dirigeant.nom}`.replace(/\s+/g, ' ').trim() : '[dirigeant à renseigner]',
    dirigeant_fonction: dirigeant ? dirigeant.fonction : 'Président',
    dirigeant_fonction_maj: (dirigeant ? dirigeant.fonction : 'Président').toUpperCase(),
    dirigeant_adresse: dirigeant ? dirigeant.adresse : '',
    associes: associes.map((a) => ({
      nom_complet: a.type === 'morale' ? a.denomination : `${a.prenom} ${a.nom}`.trim(),
      nb_titres: fmtNumber(a.nb_titres),
      pourcentage: totalTitres ? fmtNumber((a.nb_titres / totalTitres) * 100) : '0',
      adresse: a.adresse,
    })),
  };

  // Variables d'opération : valeur brute + version formatée (_fmt) selon le type déclaré.
  for (const field of def.variables) {
    const raw = vars[field.name];
    if (field.type === 'list') {
      ctx[field.name] = (Array.isArray(raw) ? raw : []).map((item) => {
        const out = { ...item };
        for (const sub of field.fields) {
          if (sub.type === 'number') out[`${sub.name}_fmt`] = fmtNumber(item[sub.name]);
          if (sub.type === 'date') out[`${sub.name}_fmt`] = fmtDate(item[sub.name]);
        }
        return out;
      });
    } else if (field.type === 'checkbox') {
      ctx[field.name] = Boolean(raw);
    } else {
      ctx[field.name] = raw ?? '';
      if (field.type === 'number') ctx[`${field.name}_fmt`] = raw == null || raw === '' ? '' : fmtNumber(raw);
      if (field.type === 'date') ctx[`${field.name}_fmt`] = fmtDate(raw);
      if (field.type === 'select') {
        // Drapeaux booléens par option pour la logique conditionnelle : affectation_ran, etc.
        for (const opt of field.options || []) ctx[`${field.name}_${opt.value}`] = raw === opt.value;
      }
    }
  }

  // Variables calculées par type d'opération (jamais resaisies).
  if (operation.type === 'cession_titres' && vars.nb_titres_cedes) {
    ctx.prix_unitaire_fmt = fmtNumber((Number(vars.prix_total) || 0) / Number(vars.nb_titres_cedes));
  }
  if (operation.type === 'augmentation_capital') {
    const souscrits = (vars.souscripteurs || []).reduce((s, x) => s + (Number(x.montant) || 0), 0);
    ctx.capital_apres_fmt = fmtNumber((societe.capital_social || 0) + (Number(vars.montant_augmentation) || 0));
    ctx.nb_titres_apres = fmtNumber((societe.nb_titres || 0) + (Number(vars.nb_titres_nouveaux) || 0));
    ctx.total_souscrit_fmt = fmtNumber(souscrits);
  }

  return { ctx, societe };
}

/** Charge le template .docx d'un document : fichier personnalisé si présent, sinon défini en code. */
function loadTemplate(operationType, docDef) {
  const file = path.join(TEMPLATES_DIR, `${operationType}__${docDef.code}.docx`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  return buildDocx(docDef.template);
}

function renderDocx(templateBuffer, ctx) {
  const zip = new PizZip(templateBuffer);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    nullGetter: () => '[À COMPLÉTER]',
  });
  doc.render(ctx);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Génère tous les documents d'une opération en une seule fois.
 * Retourne { generes: [...], non_applicables: [...] }.
 */
function genererDocuments(operationId) {
  const operation = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
  if (!operation) throw new Error('Opération introuvable');
  const def = OPERATION_TYPES[operation.type];
  const { ctx, societe } = buildContext(operation);

  const dir = path.join(STORAGE_DIR, slugify(societe.denomination), `${operation.id}-${slugify(operation.libelle)}`);
  fs.mkdirSync(dir, { recursive: true });

  const generes = [];
  const nonApplicables = [];

  for (const docDef of def.documents) {
    const document = db
      .prepare('SELECT * FROM documents WHERE operation_id = ? AND code = ?')
      .get(operation.id, docDef.code);
    if (!document) continue;

    // Clause conditionnelle : document sans objet si la variable pilote est décochée.
    if (docDef.condition && !ctx[docDef.condition]) {
      db.prepare("UPDATE documents SET statut = 'non_applicable' WHERE id = ?").run(document.id);
      nonApplicables.push(docDef.nom);
      continue;
    }

    const rendered = renderDocx(loadTemplate(operation.type, docDef), ctx);
    const last = db
      .prepare('SELECT MAX(numero) AS n FROM document_versions WHERE document_id = ?')
      .get(document.id);
    const numero = (last.n || 0) + 1;
    const filename = `${docDef.code}_v${numero}.docx`;
    const filepath = path.join(dir, filename);
    fs.writeFileSync(filepath, rendered);

    db.prepare(
      "INSERT INTO document_versions (document_id, numero, source, filename, filepath) VALUES (?, ?, 'genere', ?, ?)"
    ).run(document.id, numero, filename, filepath);
    // Ne rétrograde pas un document déjà plus avancé dans le circuit.
    if (['a_faire', 'non_applicable', 'genere'].includes(document.statut)) {
      db.prepare("UPDATE documents SET statut = 'genere' WHERE id = ?").run(document.id);
    }
    generes.push({ document: docDef.nom, version: numero, filename });
  }

  return { generes, non_applicables: nonApplicables, dossier: dir };
}

module.exports = { genererDocuments, buildContext, loadTemplate, renderDocx, slugify, STORAGE_DIR, TEMPLATES_DIR };
