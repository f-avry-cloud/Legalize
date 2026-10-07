'use strict';

/**
 * Routes du parcours de formalités : choisir les opérations, qualifier,
 * charger les pièces, laisser l'analyse remplir, compléter, déposer.
 */

const express = require('express');
const multer = require('multer');
const parcours = require('./services/parcours');
const { operationsProposees } = require('./inpi/parcours');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

router.get('/parcours/operations', (req, res) => res.json(operationsProposees()));
router.get('/parcours/referentiels', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.json(parcours.referentiels());
});
router.post('/parcours', async (req, res) => res.status(201).json(await parcours.creer(req.body || {})));
router.get('/parcours/:id', async (req, res) => res.json(await parcours.lire(req.params.id)));
router.put('/parcours/:id/operations', async (req, res) => res.json(await parcours.majOperations(req.params.id, req.body?.operations || [])));
router.put('/parcours/:id/typologie', async (req, res) => res.json(await parcours.majTypologie(req.params.id, req.body || {})));
router.put('/parcours/:id/reponses', async (req, res) => res.json(await parcours.majReponses(req.params.id, req.body || {})));
router.post('/parcours/:id/pieces', upload.single('fichier'), async (req, res) => {
  res.json(await parcours.ajouterPiece(req.params.id, { ...req.body, fichier: req.file }));
});
router.put('/parcours/pieces/:pieceId', async (req, res) => res.json(await parcours.majPiece(req.params.pieceId, req.body || {})));
router.delete('/parcours/pieces/:pieceId', async (req, res) => res.json(await parcours.retirerPiece(req.params.pieceId)));
router.post('/parcours/:id/analyser', async (req, res) => res.json(await parcours.analyser(req.params.id)));
router.get('/parcours/:id/apercu', async (req, res) => res.json(await parcours.apercu(req.params.id)));
router.post('/parcours/:id/deposer', async (req, res) => res.json(await parcours.deposer(req.params.id)));

module.exports = router;
