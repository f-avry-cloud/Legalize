'use strict';

/**
 * Routes du module « Formalités INPI ».
 *
 * Deux familles :
 *   /api/inpi/*        — accès direct aux données publiques du RNE (recherche,
 *                        fiche entreprise, import en fiche société) ;
 *   /api/formalites/*  — cycle de vie d'un dossier (ouverture, questionnaire,
 *                        pièces, contrôles, dépôt, suivi).
 */

const express = require('express');
const multer = require('multer');

const formalites = require('./services/formalites');
const rne = require('./inpi/rne');
const { etat } = require('./inpi/config');
const { catalogue } = require('./inpi/catalogue');
const { FORMES_JURIDIQUES } = require('./inpi/referentiels');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/* ------------------------------------------------------------------- INPI */

/** État de la connexion (live / démo) + référentiels utiles au formulaire. */
router.get('/inpi/etat', (req, res) => {
  res.json({
    ...etat(),
    formes_juridiques: Object.entries(FORMES_JURIDIQUES)
      .map(([code, f]) => ({ code, libelle: f.libelle, famille: f.famille })),
  });
});

router.get('/inpi/recherche', async (req, res) => {
  res.json(await rne.rechercher(req.query.q || ''));
});

router.get('/inpi/entreprise/:siren', async (req, res) => {
  const fiche = await rne.entreprise(req.params.siren);
  res.json({ ...fiche, brut: undefined });
});

router.get('/inpi/entreprise/:siren/pieces', async (req, res) => {
  res.json(await rne.pieces(req.params.siren));
});

/** Crée la fiche société du cabinet à partir du seul SIREN. */
router.post('/inpi/importer-societe', async (req, res) => {
  const { siren, groupe_id = null } = req.body;
  if (!siren) return res.status(400).json({ error: 'SIREN requis' });
  const r = await formalites.importerSociete(siren, { groupe_id: groupe_id || null });
  res.status(r.cree ? 201 : 200).json(r);
});

/* ------------------------------------------------------------- formalités */

router.get('/formalites/catalogue', (req, res) => {
  res.json({ formalites: catalogue() });
});

router.get('/formalites/dashboard', async (req, res) => {
  res.json(await formalites.tableauDeBord());
});

/** Synchronisation globale des dossiers en cours auprès de l'INPI. */
router.post('/formalites/synchroniser', async (req, res) => {
  res.json(await formalites.synchroniserToutes());
});

router.get('/formalites', async (req, res) => {
  res.json(await formalites.lister({
    statut: req.query.statut, type: req.query.type,
    societe_id: req.query.societe_id ? Number(req.query.societe_id) : undefined,
  }));
});

router.post('/formalites', async (req, res) => {
  const { societe_id = null, operation_id = null, type, siren = '', libelle = '' } = req.body;
  if (!type) return res.status(400).json({ error: 'Type de formalité requis' });
  const formalite = await formalites.creer({
    societe_id: societe_id || null, operation_id: operation_id || null, type, siren, libelle,
  });
  res.status(201).json(formalite);
});

router.get('/formalites/:id', async (req, res) => {
  res.json(await formalites.lire(Number(req.params.id)));
});

router.put('/formalites/:id/reponses', async (req, res) => {
  const reponses = req.body?.reponses ?? req.body;
  res.json(await formalites.enregistrerReponses(Number(req.params.id), reponses || {}));
});

router.post('/formalites/:id/pieces', upload.single('fichier'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis (champ « fichier »)' });
  if (!req.body.code) return res.status(400).json({ error: 'Code de pièce requis' });
  const piece = await formalites.ajouterPiece(Number(req.params.id), {
    code: req.body.code, libelle: req.body.libelle || '', fichier: req.file,
  });
  res.status(201).json(piece);
});

router.delete('/formalites/pieces/:id', async (req, res) => {
  res.json(await formalites.supprimerPiece(Number(req.params.id)));
});

router.get('/formalites/pieces/:id/download', async (req, res) => {
  const { piece, buffer } = await formalites.telechargerPiece(Number(req.params.id));
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(piece.filename)}"`);
  res.send(buffer);
});

/** Dépôt : bloqué tant que les contrôles ne sont pas levés (422 explicite). */
router.post('/formalites/:id/deposer', async (req, res) => {
  try {
    res.json(await formalites.deposer(Number(req.params.id)));
  } catch (e) {
    if (e.status === 422) return res.status(422).json({ error: e.message, controles: e.details });
    throw e;
  }
});

router.post('/formalites/:id/synchroniser', async (req, res) => {
  res.json(await formalites.synchroniser(Number(req.params.id)));
});

router.delete('/formalites/:id', async (req, res) => {
  res.json(await formalites.supprimer(Number(req.params.id)));
});

module.exports = router;
