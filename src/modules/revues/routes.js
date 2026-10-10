'use strict';

/**
 * Routes de la revue quotidienne (/api/revues, /api/propositions…).
 */

const express = require('express');
const service = require('./service');

const router = express.Router();
const corps = (req) => req.body || {};

router.get('/revues', async (req, res) => res.json(await service.liste()));
router.get('/revues/en-attente', async (req, res) => res.json(await service.enAttente()));
router.get('/revues/regles', async (req, res) => res.json(await service.regles()));
router.post('/revues/regles', async (req, res) => res.status(201).json(await service.ajouterRegle(corps(req))));
router.delete('/revues/regles/:id', async (req, res) => res.json(await service.supprimerRegle(req.params.id)));
router.get('/revues/:id', async (req, res) => res.json(await service.lire(req.params.id)));
router.delete('/revues/:id', async (req, res) => res.json(await service.supprimerRevue(req.params.id)));
router.post('/revues/:id/accepter-tout', async (req, res) => res.json(await service.accepterTout(req.params.id, corps(req))));
router.post('/revues/:id/confirmer-emails', async (req, res) => res.json(await service.confirmerEmails(req.params.id, corps(req))));

router.post('/propositions/:id/accepter', async (req, res) => res.json(await service.accepter(req.params.id, corps(req))));
router.post('/propositions/:id/refuser', async (req, res) => res.json(await service.refuser(req.params.id, corps(req))));
router.put('/emails/:id', async (req, res) => res.json(await service.rangerEmail(req.params.id, corps(req))));

module.exports = router;
