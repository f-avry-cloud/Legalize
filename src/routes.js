'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const db = require('./db');
const { OPERATION_TYPES } = require('./definitions');
const { genererDocuments, slugify, STORAGE_DIR } = require('./services/generation');
const { comparerVersions } = require('./services/compare');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/* ---------------------------------------------------------------- référentiel */

router.get('/referentiel', (req, res) => {
  const types = Object.entries(OPERATION_TYPES).map(([code, def]) => ({
    code,
    libelle: def.libelle,
    variables: def.variables,
    documents: def.documents.map((d) => ({
      code: d.code, nom: d.nom, obligatoire: d.obligatoire, condition: d.condition || null,
    })),
  }));
  res.json({ types });
});

/* ---------------------------------------------------------------- groupes */

router.get('/groupes', (req, res) => {
  const groupes = db.prepare(`
    SELECT g.*, COUNT(s.id) AS nb_societes
    FROM groupes g LEFT JOIN societes s ON s.groupe_id = g.id
    GROUP BY g.id ORDER BY g.nom
  `).all();
  res.json(groupes);
});

router.post('/groupes', (req, res) => {
  const { nom, description = '' } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom du groupe est requis' });
  const info = db.prepare('INSERT INTO groupes (nom, description) VALUES (?, ?)').run(nom, description);
  res.status(201).json(db.prepare('SELECT * FROM groupes WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/groupes/:id', (req, res) => {
  db.prepare('DELETE FROM groupes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * Organigramme du groupe : arbre construit à partir des participations
 * (associés de type société — associes.societe_liee_id).
 */
router.get('/groupes/:id/organigramme', (req, res) => {
  const societes = db.prepare('SELECT * FROM societes WHERE groupe_id = ?').all(req.params.id);
  const ids = new Set(societes.map((s) => s.id));
  const liens = db.prepare(`
    SELECT a.societe_id AS fille_id, a.societe_liee_id AS mere_id, a.nb_titres,
           (SELECT nb_titres FROM societes WHERE id = a.societe_id) AS total_titres
    FROM associes a WHERE a.societe_liee_id IS NOT NULL
  `).all().filter((l) => ids.has(l.fille_id) && ids.has(l.mere_id));

  const fillesDe = new Map();
  const aUneMere = new Set();
  for (const l of liens) {
    if (!fillesDe.has(l.mere_id)) fillesDe.set(l.mere_id, []);
    const pct = l.total_titres ? Math.round((l.nb_titres / l.total_titres) * 1000) / 10 : null;
    fillesDe.get(l.mere_id).push({ id: l.fille_id, pourcentage: pct });
    aUneMere.add(l.fille_id);
  }

  const byId = new Map(societes.map((s) => [s.id, s]));
  const seen = new Set();
  function node(id, pourcentage) {
    const s = byId.get(id);
    const cycle = seen.has(id);
    seen.add(id);
    return {
      id: s.id,
      denomination: s.denomination,
      forme_sociale: s.forme_sociale,
      pourcentage,
      filles: cycle ? [] : (fillesDe.get(id) || []).map((f) => node(f.id, f.pourcentage)),
    };
  }
  const racines = societes.filter((s) => !aUneMere.has(s.id)).map((s) => node(s.id, null));
  res.json({ racines });
});

/* ---------------------------------------------------------------- sociétés */

router.get('/societes', (req, res) => {
  const societes = db.prepare(`
    SELECT s.*, g.nom AS groupe_nom,
      (SELECT COUNT(*) FROM operations o WHERE o.societe_id = s.id AND o.statut = 'en_cours') AS operations_en_cours
    FROM societes s LEFT JOIN groupes g ON g.id = s.groupe_id
    ORDER BY s.denomination
  `).all();
  res.json(societes);
});

const SOCIETE_FIELDS = ['groupe_id', 'denomination', 'forme_sociale', 'capital_social', 'nb_titres',
  'siege_social', 'siren', 'rcs_ville', 'objet_social', 'date_cloture', 'statut', 'notes'];

router.post('/societes', (req, res) => {
  if (!req.body.denomination) return res.status(400).json({ error: 'La dénomination est requise' });
  const defaults = {
    groupe_id: null, forme_sociale: 'SAS', capital_social: 0, nb_titres: 0, siege_social: '',
    siren: '', rcs_ville: '', objet_social: '', date_cloture: '31/12', statut: 'active', notes: '',
  };
  const values = SOCIETE_FIELDS.map((f) => req.body[f] ?? defaults[f] ?? '');
  const info = db.prepare(
    `INSERT INTO societes (${SOCIETE_FIELDS.join(', ')}) VALUES (${SOCIETE_FIELDS.map(() => '?').join(', ')})`
  ).run(...values);
  res.status(201).json(db.prepare('SELECT * FROM societes WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/societes/:id', (req, res) => {
  const societe = db.prepare('SELECT s.*, g.nom AS groupe_nom FROM societes s LEFT JOIN groupes g ON g.id = s.groupe_id WHERE s.id = ?').get(req.params.id);
  if (!societe) return res.status(404).json({ error: 'Société introuvable' });
  societe.dirigeants = db.prepare('SELECT * FROM dirigeants WHERE societe_id = ? ORDER BY id').all(societe.id);
  societe.associes = db.prepare(`
    SELECT a.*, sl.denomination AS societe_liee_nom
    FROM associes a LEFT JOIN societes sl ON sl.id = a.societe_liee_id
    WHERE a.societe_id = ? ORDER BY a.nb_titres DESC
  `).all(societe.id);
  societe.operations = db.prepare('SELECT * FROM operations WHERE societe_id = ? ORDER BY created_at DESC').all(societe.id);
  res.json(societe);
});

router.put('/societes/:id', (req, res) => {
  const sets = SOCIETE_FIELDS.filter((f) => f in req.body);
  if (sets.length) {
    db.prepare(`UPDATE societes SET ${sets.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
      .run(...sets.map((f) => req.body[f]), req.params.id);
  }
  res.json(db.prepare('SELECT * FROM societes WHERE id = ?').get(req.params.id));
});

router.delete('/societes/:id', (req, res) => {
  db.prepare('DELETE FROM societes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/societes/:id/dirigeants', (req, res) => {
  const { civilite = 'M.', nom, prenom = '', fonction = 'Président', adresse = '', date_nomination = '' } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom est requis' });
  const info = db.prepare(
    'INSERT INTO dirigeants (societe_id, civilite, nom, prenom, fonction, adresse, date_nomination) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.id, civilite, nom, prenom, fonction, adresse, date_nomination);
  res.status(201).json(db.prepare('SELECT * FROM dirigeants WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/dirigeants/:id', (req, res) => {
  db.prepare('DELETE FROM dirigeants WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/societes/:id/associes', (req, res) => {
  const { type = 'physique', civilite = 'M.', nom = '', prenom = '', denomination = '',
    societe_liee_id = null, nb_titres = 0, adresse = '' } = req.body;
  if (type === 'physique' && !nom) return res.status(400).json({ error: 'Le nom est requis' });
  if (type === 'morale' && !denomination && !societe_liee_id) return res.status(400).json({ error: 'La dénomination est requise' });
  let deno = denomination;
  if (societe_liee_id) {
    const liee = db.prepare('SELECT denomination FROM societes WHERE id = ?').get(societe_liee_id);
    if (liee) deno = liee.denomination;
  }
  const info = db.prepare(
    'INSERT INTO associes (societe_id, type, civilite, nom, prenom, denomination, societe_liee_id, nb_titres, adresse) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.id, type, civilite, nom, prenom, deno, societe_liee_id, nb_titres, adresse);
  res.status(201).json(db.prepare('SELECT * FROM associes WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/associes/:id', (req, res) => {
  db.prepare('DELETE FROM associes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- opérations */

router.get('/operations', (req, res) => {
  const operations = db.prepare(`
    SELECT o.*, s.denomination AS societe_nom,
      (SELECT COUNT(*) FROM documents d WHERE d.operation_id = o.id AND d.statut = 'a_faire' AND d.obligatoire = 1) AS docs_manquants,
      (SELECT COUNT(*) FROM documents d WHERE d.operation_id = o.id) AS docs_total
    FROM operations o JOIN societes s ON s.id = o.societe_id
    ORDER BY o.created_at DESC
  `).all();
  res.json(operations);
});

router.post('/operations', (req, res) => {
  const { societe_id, type, libelle, variables = {} } = req.body;
  const def = OPERATION_TYPES[type];
  if (!societe_id || !def) return res.status(400).json({ error: "Société et type d'opération valides requis" });
  const societe = db.prepare('SELECT * FROM societes WHERE id = ?').get(societe_id);
  if (!societe) return res.status(400).json({ error: 'Société introuvable' });

  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO operations (societe_id, type, libelle, variables) VALUES (?, ?, ?, ?)')
      .run(societe_id, type, libelle || `${def.libelle} — ${societe.denomination}`, JSON.stringify(variables));
    const opId = info.lastInsertRowid;
    // La checklist du type d'opération instancie automatiquement les documents requis.
    const insertDoc = db.prepare('INSERT INTO documents (operation_id, code, nom, obligatoire) VALUES (?, ?, ?, ?)');
    for (const d of def.documents) insertDoc.run(opId, d.code, d.nom, d.obligatoire ? 1 : 0);
    return opId;
  });
  const opId = create();
  res.status(201).json(db.prepare('SELECT * FROM operations WHERE id = ?').get(opId));
});

router.get('/operations/:id', (req, res) => {
  const operation = db.prepare(`
    SELECT o.*, s.denomination AS societe_nom FROM operations o JOIN societes s ON s.id = o.societe_id WHERE o.id = ?
  `).get(req.params.id);
  if (!operation) return res.status(404).json({ error: 'Opération introuvable' });
  operation.variables = JSON.parse(operation.variables || '{}');
  operation.documents = db.prepare('SELECT * FROM documents WHERE operation_id = ? ORDER BY id').all(operation.id);
  const versions = db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY numero DESC');
  for (const d of operation.documents) d.versions = versions.all(d.id);
  operation.manquants = operation.documents.filter((d) => d.statut === 'a_faire' && d.obligatoire);
  operation.factures = db.prepare('SELECT * FROM factures WHERE operation_id = ? ORDER BY created_at DESC').all(operation.id)
    .map((f) => ({ ...f, lignes: JSON.parse(f.lignes) }));
  res.json(operation);
});

router.put('/operations/:id', (req, res) => {
  const op = db.prepare('SELECT * FROM operations WHERE id = ?').get(req.params.id);
  if (!op) return res.status(404).json({ error: 'Opération introuvable' });
  const { libelle, statut, variables } = req.body;
  db.prepare('UPDATE operations SET libelle = coalesce(?, libelle), statut = coalesce(?, statut), variables = coalesce(?, variables) WHERE id = ?')
    .run(libelle ?? null, statut ?? null, variables !== undefined ? JSON.stringify(variables) : null, req.params.id);
  res.json(db.prepare('SELECT * FROM operations WHERE id = ?').get(req.params.id));
});

router.delete('/operations/:id', (req, res) => {
  db.prepare('DELETE FROM operations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** Génération en un clic : tous les documents de la checklist en une passe. */
router.post('/operations/:id/generer', (req, res) => {
  res.json(genererDocuments(Number(req.params.id)));
});

/* ---------------------------------------------------------------- documents & versions */

const STATUTS_DOC = ['a_faire', 'genere', 'envoye', 'recu_markup', 'signe', 'finalise', 'non_applicable'];

router.put('/documents/:id', (req, res) => {
  const { statut } = req.body;
  if (!STATUTS_DOC.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  db.prepare('UPDATE documents SET statut = ? WHERE id = ?').run(statut, req.params.id);
  res.json(db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id));
});

/** Dépôt d'une version reçue (markup) ou importée — .docx ou .pdf. */
router.post('/documents/:id/versions', upload.single('fichier'), (req, res) => {
  const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!document) return res.status(404).json({ error: 'Document introuvable' });
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ « fichier »)' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.docx', '.pdf'].includes(ext)) return res.status(400).json({ error: 'Formats acceptés : .docx, .pdf' });

  const operation = db.prepare('SELECT * FROM operations WHERE id = ?').get(document.operation_id);
  const societe = db.prepare('SELECT * FROM societes WHERE id = ?').get(operation.societe_id);
  const dir = path.join(STORAGE_DIR, slugify(societe.denomination), `${operation.id}-${slugify(operation.libelle)}`);
  fs.mkdirSync(dir, { recursive: true });

  const source = req.body.source === 'importe' ? 'importe' : 'recu';
  const last = db.prepare('SELECT MAX(numero) AS n FROM document_versions WHERE document_id = ?').get(document.id);
  const numero = (last.n || 0) + 1;
  const filename = `${document.code}_v${numero}_${source}${ext}`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, req.file.buffer);

  const info = db.prepare(
    'INSERT INTO document_versions (document_id, numero, source, filename, filepath) VALUES (?, ?, ?, ?, ?)'
  ).run(document.id, numero, source, filename, filepath);
  if (source === 'recu') db.prepare("UPDATE documents SET statut = 'recu_markup' WHERE id = ?").run(document.id);
  res.status(201).json(db.prepare('SELECT * FROM document_versions WHERE id = ?').get(info.lastInsertRowid));
});

/** Comparaison markup entre deux versions (par défaut : dernière envoyée vs dernière reçue). */
router.get('/documents/:id/compare', async (req, res) => {
  const documentId = Number(req.params.id);
  let { from, to } = req.query;
  if (!from || !to) {
    const versions = db.prepare('SELECT * FROM document_versions WHERE document_id = ? ORDER BY numero').all(documentId);
    const derniereRecue = [...versions].reverse().find((v) => v.source === 'recu');
    const derniereGeneree = [...versions].reverse().find((v) => v.source !== 'recu');
    if (!derniereRecue || !derniereGeneree) {
      return res.status(400).json({ error: 'Il faut au moins une version générée et une version reçue pour comparer' });
    }
    from = derniereGeneree.id;
    to = derniereRecue.id;
  }
  res.json(await comparerVersions(documentId, Number(from), Number(to)));
});

router.get('/versions/:id/download', (req, res) => {
  const version = db.prepare('SELECT * FROM document_versions WHERE id = ?').get(req.params.id);
  if (!version || !fs.existsSync(version.filepath)) return res.status(404).json({ error: 'Fichier introuvable' });
  res.download(version.filepath, version.filename);
});

/* ---------------------------------------------------------------- facturation */

router.get('/factures', (req, res) => {
  const factures = db.prepare(`
    SELECT f.*, o.libelle AS operation_libelle, s.denomination AS societe_nom
    FROM factures f JOIN operations o ON o.id = f.operation_id JOIN societes s ON s.id = o.societe_id
    ORDER BY f.created_at DESC
  `).all().map((f) => ({ ...f, lignes: JSON.parse(f.lignes) }));
  res.json(factures);
});

router.post('/factures', (req, res) => {
  const { operation_id, type = 'devis', mode = 'forfait', lignes = [], taux_tva = 20 } = req.body;
  const operation = db.prepare('SELECT * FROM operations WHERE id = ?').get(operation_id);
  if (!operation) return res.status(400).json({ error: 'Opération introuvable' });
  const annee = new Date().getFullYear();
  const prefix = type === 'facture' ? 'FAC' : 'DEV';
  const count = db.prepare("SELECT COUNT(*) AS n FROM factures WHERE type = ? AND numero LIKE ?")
    .get(type, `${prefix}-${annee}-%`).n;
  const numero = `${prefix}-${annee}-${String(count + 1).padStart(3, '0')}`;
  const info = db.prepare(
    'INSERT INTO factures (operation_id, type, numero, mode, lignes, taux_tva) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(operation_id, type, numero, mode, JSON.stringify(lignes), taux_tva);
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...f, lignes: JSON.parse(f.lignes) });
});

router.put('/factures/:id', (req, res) => {
  const f = db.prepare('SELECT * FROM factures WHERE id = ?').get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Introuvable' });
  const { statut, lignes, mode, taux_tva } = req.body;
  db.prepare('UPDATE factures SET statut = coalesce(?, statut), lignes = coalesce(?, lignes), mode = coalesce(?, mode), taux_tva = coalesce(?, taux_tva) WHERE id = ?')
    .run(statut ?? null, lignes !== undefined ? JSON.stringify(lignes) : null, mode ?? null, taux_tva ?? null, req.params.id);
  const updated = db.prepare('SELECT * FROM factures WHERE id = ?').get(req.params.id);
  res.json({ ...updated, lignes: JSON.parse(updated.lignes) });
});

router.delete('/factures/:id', (req, res) => {
  db.prepare('DELETE FROM factures WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- tableau de bord */

router.get('/dashboard', (req, res) => {
  const compteurs = {
    societes: db.prepare('SELECT COUNT(*) AS n FROM societes').get().n,
    groupes: db.prepare('SELECT COUNT(*) AS n FROM groupes').get().n,
    operations_en_cours: db.prepare("SELECT COUNT(*) AS n FROM operations WHERE statut = 'en_cours'").get().n,
    documents_manquants: db.prepare(`
      SELECT COUNT(*) AS n FROM documents d JOIN operations o ON o.id = d.operation_id
      WHERE d.statut = 'a_faire' AND d.obligatoire = 1 AND o.statut = 'en_cours'
    `).get().n,
  };
  const operations = db.prepare(`
    SELECT o.id, o.libelle, o.type, o.statut, s.denomination AS societe_nom,
      (SELECT COUNT(*) FROM documents d WHERE d.operation_id = o.id AND d.statut = 'a_faire' AND d.obligatoire = 1) AS docs_manquants
    FROM operations o JOIN societes s ON s.id = o.societe_id
    WHERE o.statut = 'en_cours' ORDER BY o.created_at DESC LIMIT 10
  `).all();
  const manquants = db.prepare(`
    SELECT d.id, d.nom, o.id AS operation_id, o.libelle AS operation_libelle, s.denomination AS societe_nom
    FROM documents d JOIN operations o ON o.id = d.operation_id JOIN societes s ON s.id = o.societe_id
    WHERE d.statut = 'a_faire' AND d.obligatoire = 1 AND o.statut = 'en_cours'
    ORDER BY o.created_at DESC LIMIT 15
  `).all();
  res.json({ compteurs, operations, manquants });
});

module.exports = router;
