'use strict';

/**
 * Routes des dossiers, clients et contacts (/api/dossiers, /api/clients…).
 */

const express = require('express');
const service = require('./service');

require('./actions');

const router = express.Router();
const corps = (req) => req.body || {};

/* ----------------------------------------------------------- catalogue */

router.get('/dossiers/catalogue', async (req, res) => res.json(await service.catalogue()));
router.put('/dossiers/modeles/:type', async (req, res) => res.json(await service.majModele(req.params.type, corps(req))));
router.delete('/dossiers/modeles/:type', async (req, res) => res.json(await service.reinitialiserModele(req.params.type)));
router.get('/dossiers/synthese', async (req, res) => res.json(await service.synthese()));
router.get('/membres', async (req, res) => res.json(await service.membres()));

/* ------------------------------------------------------------- dossiers */

router.get('/dossiers', async (req, res) => {
  const { famille, statut, client_id: clientId } = req.query;
  res.json(await service.lister({ famille, statut, client_id: clientId }));
});
router.post('/dossiers', async (req, res) => res.status(201).json(await service.creer(corps(req))));
router.get('/dossiers/:id', async (req, res) => res.json(await service.lire(req.params.id)));
router.put('/dossiers/:id', async (req, res) => res.json(await service.modifier(req.params.id, corps(req))));
router.delete('/dossiers/:id', async (req, res) => res.json(await service.supprimer(req.params.id, corps(req))));

router.post('/dossiers/:id/etapes', async (req, res) => res.json(await service.ajouterEtape(req.params.id, corps(req))));
router.put('/etapes/:id', async (req, res) => res.json(await service.majEtape(req.params.id, corps(req))));
router.delete('/etapes/:id', async (req, res) => res.json(await service.supprimerEtape(req.params.id)));

router.post('/dossiers/:id/taches', async (req, res) => res.json(await service.ajouterTache(req.params.id, corps(req))));
router.put('/taches/:id', async (req, res) => res.json(await service.majTache(req.params.id, corps(req))));
router.delete('/taches/:id', async (req, res) => res.json(await service.supprimerTache(req.params.id)));

router.post('/dossiers/:id/echeances', async (req, res) => res.json(await service.ajouterEcheance(req.params.id, corps(req))));
router.put('/echeances/:id', async (req, res) => res.json(await service.majEcheance(req.params.id, corps(req))));
router.delete('/echeances/:id', async (req, res) => res.json(await service.supprimerEcheance(req.params.id)));

router.post('/dossiers/:id/parties', async (req, res) => res.json(await service.ajouterPartie(req.params.id, corps(req))));
router.delete('/parties/:id', async (req, res) => res.json(await service.supprimerPartie(req.params.id)));
router.post('/dossiers/:id/notes', async (req, res) => res.json(await service.ajouterNote(req.params.id, corps(req))));
router.put('/dossiers/:id/liens', async (req, res) => res.json(await service.lier(req.params.id, corps(req))));
router.post('/dossiers/:id/actions/:action', async (req, res) => {
  res.json(await service.executerAction(req.params.id, req.params.action, corps(req)));
});

/* -------------------------------------------------------------- clients */

router.get('/clients', async (req, res) => res.json(await service.listerClients()));
router.post('/clients', async (req, res) => res.status(201).json(await service.creerClient(corps(req))));
router.get('/clients/:id', async (req, res) => res.json(await service.ficheClient(req.params.id)));
router.put('/clients/:id', async (req, res) => res.json(await service.modifierClient(req.params.id, corps(req))));
router.post('/clients/:id/contacts', async (req, res) => res.status(201).json(await service.creerContact(req.params.id, corps(req))));
router.put('/contacts/:id', async (req, res) => res.json(await service.modifierContact(req.params.id, corps(req))));
router.delete('/contacts/:id', async (req, res) => res.json(await service.supprimerContact(req.params.id)));

module.exports = router;
