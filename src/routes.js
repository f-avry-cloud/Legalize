'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

const { supabase, q, qCount, uploadFile, downloadFile } = require('./supa');
const { OPERATION_TYPES } = require('./definitions');
const { genererDocuments, operationDir } = require('./services/generation');
const { comparerVersions } = require('./services/compare');

const router = express.Router();

// Module « Formalités INPI » (guichet unique + RNE) : routes /api/inpi/* et
// /api/formalites/*, montées en tête pour rester indépendantes du reste.
router.use(require('./routes-formalites'));
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

router.get('/groupes', async (req, res) => {
  const [groupes, societes] = await Promise.all([
    q(supabase.from('groupes').select('*').order('nom')),
    q(supabase.from('societes').select('id, groupe_id')),
  ]);
  res.json(groupes.map((g) => ({
    ...g,
    nb_societes: societes.filter((s) => s.groupe_id === g.id).length,
  })));
});

router.post('/groupes', async (req, res) => {
  const { nom, description = '' } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom du groupe est requis' });
  const groupe = await q(supabase.from('groupes').insert({ nom, description }).select().single());
  res.status(201).json(groupe);
});

router.delete('/groupes/:id', async (req, res) => {
  await q(supabase.from('groupes').delete().eq('id', req.params.id).select());
  res.json({ ok: true });
});

/**
 * Organigramme du groupe : arbre construit à partir des participations
 * (associés de type société — associes.societe_liee_id).
 */
router.get('/groupes/:id/organigramme', async (req, res) => {
  const societes = await q(supabase.from('societes').select('*').eq('groupe_id', req.params.id));
  const ids = new Set(societes.map((s) => s.id));
  const liens = (await q(supabase.from('associes').select('societe_id, societe_liee_id, nb_titres').not('societe_liee_id', 'is', null)))
    .filter((l) => ids.has(l.societe_id) && ids.has(l.societe_liee_id));

  const byId = new Map(societes.map((s) => [s.id, s]));
  const fillesDe = new Map();
  const aUneMere = new Set();
  for (const l of liens) {
    if (!fillesDe.has(l.societe_liee_id)) fillesDe.set(l.societe_liee_id, []);
    const total = byId.get(l.societe_id).nb_titres;
    const pct = total ? Math.round((l.nb_titres / total) * 1000) / 10 : null;
    fillesDe.get(l.societe_liee_id).push({ id: l.societe_id, pourcentage: pct });
    aUneMere.add(l.societe_id);
  }

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

router.get('/societes', async (req, res) => {
  const [societes, groupes, operations] = await Promise.all([
    q(supabase.from('societes').select('*').order('denomination')),
    q(supabase.from('groupes').select('id, nom')),
    q(supabase.from('operations').select('id, societe_id, statut')),
  ]);
  res.json(societes.map((s) => ({
    ...s,
    groupe_nom: groupes.find((g) => g.id === s.groupe_id)?.nom || null,
    operations_en_cours: operations.filter((o) => o.societe_id === s.id && o.statut === 'en_cours').length,
  })));
});

const SOCIETE_FIELDS = ['groupe_id', 'denomination', 'forme_sociale', 'capital_social', 'nb_titres',
  'siege_social', 'siren', 'rcs_ville', 'objet_social', 'date_cloture', 'statut', 'notes'];

router.post('/societes', async (req, res) => {
  if (!req.body.denomination) return res.status(400).json({ error: 'La dénomination est requise' });
  const record = {};
  for (const f of SOCIETE_FIELDS) if (req.body[f] !== undefined && req.body[f] !== null) record[f] = req.body[f];
  if (record.groupe_id === '') record.groupe_id = null;
  const societe = await q(supabase.from('societes').insert(record).select().single());
  res.status(201).json(societe);
});

router.get('/societes/:id', async (req, res) => {
  const societe = await q(supabase.from('societes').select('*').eq('id', req.params.id).single());
  const [groupe, dirigeants, associes, operations, societesLiees] = await Promise.all([
    societe.groupe_id ? q(supabase.from('groupes').select('nom').eq('id', societe.groupe_id).single()) : null,
    q(supabase.from('dirigeants').select('*').eq('societe_id', societe.id).order('id')),
    q(supabase.from('associes').select('*').eq('societe_id', societe.id).order('nb_titres', { ascending: false })),
    q(supabase.from('operations').select('*').eq('societe_id', societe.id).order('created_at', { ascending: false })),
    q(supabase.from('societes').select('id, denomination')),
  ]);
  societe.groupe_nom = groupe ? groupe.nom : null;
  societe.dirigeants = dirigeants;
  societe.associes = associes.map((a) => ({
    ...a,
    societe_liee_nom: societesLiees.find((x) => x.id === a.societe_liee_id)?.denomination || null,
  }));
  societe.operations = operations;
  res.json(societe);
});

router.put('/societes/:id', async (req, res) => {
  const patch = {};
  for (const f of SOCIETE_FIELDS) if (f in req.body) patch[f] = req.body[f] === '' && f === 'groupe_id' ? null : req.body[f];
  const societe = Object.keys(patch).length
    ? await q(supabase.from('societes').update(patch).eq('id', req.params.id).select().single())
    : await q(supabase.from('societes').select('*').eq('id', req.params.id).single());
  res.json(societe);
});

router.delete('/societes/:id', async (req, res) => {
  await q(supabase.from('societes').delete().eq('id', req.params.id).select());
  res.json({ ok: true });
});

router.post('/societes/:id/dirigeants', async (req, res) => {
  const { civilite = 'M.', nom, prenom = '', fonction = 'Président', adresse = '', date_nomination = '' } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom est requis' });
  const dirigeant = await q(supabase.from('dirigeants')
    .insert({ societe_id: Number(req.params.id), civilite, nom, prenom, fonction, adresse, date_nomination })
    .select().single());
  res.status(201).json(dirigeant);
});

router.delete('/dirigeants/:id', async (req, res) => {
  await q(supabase.from('dirigeants').delete().eq('id', req.params.id).select());
  res.json({ ok: true });
});

router.post('/societes/:id/associes', async (req, res) => {
  const { type = 'physique', civilite = 'M.', nom = '', prenom = '', denomination = '',
    societe_liee_id = null, nb_titres = 0, adresse = '' } = req.body;
  if (type === 'physique' && !nom) return res.status(400).json({ error: 'Le nom est requis' });
  if (type === 'morale' && !denomination && !societe_liee_id) return res.status(400).json({ error: 'La dénomination est requise' });
  let deno = denomination;
  if (societe_liee_id) {
    const liee = await q(supabase.from('societes').select('denomination').eq('id', societe_liee_id).single());
    if (liee) deno = liee.denomination;
  }
  const associe = await q(supabase.from('associes')
    .insert({ societe_id: Number(req.params.id), type, civilite, nom, prenom, denomination: deno, societe_liee_id, nb_titres, adresse })
    .select().single());
  res.status(201).json(associe);
});

router.delete('/associes/:id', async (req, res) => {
  await q(supabase.from('associes').delete().eq('id', req.params.id).select());
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- opérations */

router.get('/operations', async (req, res) => {
  const [operations, societes, documents] = await Promise.all([
    q(supabase.from('operations').select('*').order('created_at', { ascending: false })),
    q(supabase.from('societes').select('id, denomination')),
    q(supabase.from('documents').select('id, operation_id, statut, obligatoire')),
  ]);
  res.json(operations.map((o) => {
    const docs = documents.filter((d) => d.operation_id === o.id);
    return {
      ...o,
      societe_nom: societes.find((s) => s.id === o.societe_id)?.denomination || '',
      docs_manquants: docs.filter((d) => d.statut === 'a_faire' && d.obligatoire).length,
      docs_total: docs.length,
    };
  }));
});

router.post('/operations', async (req, res) => {
  const { societe_id, type, libelle, variables = {} } = req.body;
  const def = OPERATION_TYPES[type];
  if (!societe_id || !def) return res.status(400).json({ error: "Société et type d'opération valides requis" });
  const societe = await q(supabase.from('societes').select('denomination').eq('id', societe_id).single());

  const operation = await q(supabase.from('operations')
    .insert({ societe_id, type, libelle: libelle || `${def.libelle} — ${societe.denomination}`, variables })
    .select().single());
  // La checklist du type d'opération instancie automatiquement les documents requis.
  await q(supabase.from('documents').insert(def.documents.map((d) => ({
    operation_id: operation.id, code: d.code, nom: d.nom, obligatoire: Boolean(d.obligatoire),
  }))).select());
  res.status(201).json(operation);
});

router.get('/operations/:id', async (req, res) => {
  const operation = await q(supabase.from('operations').select('*').eq('id', req.params.id).single());
  const [societe, documents, factures] = await Promise.all([
    q(supabase.from('societes').select('denomination').eq('id', operation.societe_id).single()),
    q(supabase.from('documents').select('*').eq('operation_id', operation.id).order('id')),
    q(supabase.from('factures').select('*').eq('operation_id', operation.id).order('created_at', { ascending: false })),
  ]);
  const versions = documents.length
    ? await q(supabase.from('document_versions').select('*').in('document_id', documents.map((d) => d.id)))
    : [];
  operation.societe_nom = societe.denomination;
  operation.documents = documents.map((d) => ({
    ...d,
    versions: versions.filter((v) => v.document_id === d.id).sort((a, b) => b.numero - a.numero),
  }));
  operation.manquants = operation.documents.filter((d) => d.statut === 'a_faire' && d.obligatoire);
  operation.factures = factures;
  res.json(operation);
});

router.put('/operations/:id', async (req, res) => {
  const patch = {};
  for (const f of ['libelle', 'statut', 'variables']) if (req.body[f] !== undefined) patch[f] = req.body[f];
  const operation = Object.keys(patch).length
    ? await q(supabase.from('operations').update(patch).eq('id', req.params.id).select().single())
    : await q(supabase.from('operations').select('*').eq('id', req.params.id).single());
  res.json(operation);
});

router.delete('/operations/:id', async (req, res) => {
  await q(supabase.from('operations').delete().eq('id', req.params.id).select());
  res.json({ ok: true });
});

/** Génération en un clic : tous les documents de la checklist en une passe. */
router.post('/operations/:id/generer', async (req, res) => {
  res.json(await genererDocuments(Number(req.params.id)));
});
// Alias GET (tests / intégrations simples) — même effet que le POST.
router.get('/operations/:id/generer', async (req, res) => {
  res.json(await genererDocuments(Number(req.params.id)));
});

/* ---------------------------------------------------------------- documents & versions */

const STATUTS_DOC = ['a_faire', 'genere', 'envoye', 'recu_markup', 'signe', 'finalise', 'non_applicable'];

router.put('/documents/:id', async (req, res) => {
  const { statut } = req.body;
  if (!STATUTS_DOC.includes(statut)) return res.status(400).json({ error: 'Statut invalide' });
  const document = await q(supabase.from('documents').update({ statut }).eq('id', req.params.id).select().single());
  res.json(document);
});

/** Dépôt d'une version reçue (markup) ou importée — .docx ou .pdf. */
router.post('/documents/:id/versions', upload.single('fichier'), async (req, res) => {
  const document = await q(supabase.from('documents').select('*').eq('id', req.params.id).single());
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ « fichier »)' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!['.docx', '.pdf'].includes(ext)) return res.status(400).json({ error: 'Formats acceptés : .docx, .pdf' });

  const operation = await q(supabase.from('operations').select('*').eq('id', document.operation_id).single());
  const societe = await q(supabase.from('societes').select('*').eq('id', operation.societe_id).single());

  const source = req.body.source === 'importe' ? 'importe' : 'recu';
  const existantes = await q(supabase.from('document_versions').select('numero').eq('document_id', document.id));
  const numero = existantes.reduce((max, v) => Math.max(max, v.numero), 0) + 1;
  const filename = `${document.code}_v${numero}_${source}${ext}`;
  const filepath = `${operationDir(societe, operation)}/${filename}`;
  await uploadFile(filepath, req.file.buffer, req.file.mimetype || 'application/octet-stream');

  const version = await q(supabase.from('document_versions')
    .insert({ document_id: document.id, numero, source, filename, filepath })
    .select().single());
  if (source === 'recu') await q(supabase.from('documents').update({ statut: 'recu_markup' }).eq('id', document.id).select());
  res.status(201).json(version);
});

/** Comparaison markup entre deux versions (par défaut : dernière envoyée vs dernière reçue). */
router.get('/documents/:id/compare', async (req, res) => {
  const documentId = Number(req.params.id);
  let { from, to } = req.query;
  if (!from || !to) {
    const versions = await q(supabase.from('document_versions').select('*').eq('document_id', documentId).order('numero'));
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

router.get('/versions/:id/download', async (req, res) => {
  const version = await q(supabase.from('document_versions').select('*').eq('id', req.params.id).single());
  const buffer = await downloadFile(version.filepath);
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(version.filename)}"`);
  res.set('Content-Type', version.filename.endsWith('.pdf') ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.send(buffer);
});

/* ---------------------------------------------------------------- facturation */

router.get('/factures', async (req, res) => {
  const [factures, operations, societes] = await Promise.all([
    q(supabase.from('factures').select('*').order('created_at', { ascending: false })),
    q(supabase.from('operations').select('id, libelle, societe_id')),
    q(supabase.from('societes').select('id, denomination')),
  ]);
  res.json(factures.map((f) => {
    const op = operations.find((o) => o.id === f.operation_id);
    return {
      ...f,
      operation_libelle: op?.libelle || '',
      societe_nom: op ? societes.find((s) => s.id === op.societe_id)?.denomination || '' : '',
    };
  }));
});

router.post('/factures', async (req, res) => {
  const { operation_id, type = 'devis', mode = 'forfait', lignes = [], taux_tva = 20 } = req.body;
  await q(supabase.from('operations').select('id').eq('id', operation_id).single());
  const annee = new Date().getFullYear();
  const prefix = type === 'facture' ? 'FAC' : 'DEV';
  const count = await qCount(supabase.from('factures')
    .select('id', { count: 'exact', head: true })
    .eq('type', type).like('numero', `${prefix}-${annee}-%`));
  const numero = `${prefix}-${annee}-${String(count + 1).padStart(3, '0')}`;
  const facture = await q(supabase.from('factures')
    .insert({ operation_id, type, numero, mode, lignes, taux_tva })
    .select().single());
  res.status(201).json(facture);
});

router.put('/factures/:id', async (req, res) => {
  const patch = {};
  for (const f of ['statut', 'lignes', 'mode', 'taux_tva']) if (req.body[f] !== undefined) patch[f] = req.body[f];
  const facture = Object.keys(patch).length
    ? await q(supabase.from('factures').update(patch).eq('id', req.params.id).select().single())
    : await q(supabase.from('factures').select('*').eq('id', req.params.id).single());
  res.json(facture);
});

router.delete('/factures/:id', async (req, res) => {
  await q(supabase.from('factures').delete().eq('id', req.params.id).select());
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- tableau de bord */

router.get('/dashboard', async (req, res) => {
  const [societes, groupes, operations, documents] = await Promise.all([
    q(supabase.from('societes').select('id, denomination')),
    q(supabase.from('groupes').select('id')),
    q(supabase.from('operations').select('*').order('created_at', { ascending: false })),
    q(supabase.from('documents').select('id, operation_id, nom, statut, obligatoire')),
  ]);
  const enCours = operations.filter((o) => o.statut === 'en_cours');
  const enCoursIds = new Set(enCours.map((o) => o.id));
  const manquantsDocs = documents.filter((d) => d.statut === 'a_faire' && d.obligatoire && enCoursIds.has(d.operation_id));

  res.json({
    compteurs: {
      societes: societes.length,
      groupes: groupes.length,
      operations_en_cours: enCours.length,
      documents_manquants: manquantsDocs.length,
    },
    operations: enCours.slice(0, 10).map((o) => ({
      id: o.id,
      libelle: o.libelle,
      type: o.type,
      statut: o.statut,
      societe_nom: societes.find((s) => s.id === o.societe_id)?.denomination || '',
      docs_manquants: manquantsDocs.filter((d) => d.operation_id === o.id).length,
    })),
    manquants: manquantsDocs.slice(0, 15).map((d) => {
      const op = operations.find((o) => o.id === d.operation_id);
      return {
        id: d.id,
        nom: d.nom,
        operation_id: d.operation_id,
        operation_libelle: op?.libelle || '',
        societe_nom: societes.find((s) => s.id === op?.societe_id)?.denomination || '',
      };
    }),
  });
});

module.exports = router;
