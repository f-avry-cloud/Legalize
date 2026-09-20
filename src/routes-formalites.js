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
const guichet = require('./inpi/guichet');
const { etat } = require('./inpi/config');
const { catalogue } = require('./inpi/catalogue');
const { formesCreation, enumeration } = require('./inpi/referentiels');
const { diagnostiquer, diagnostiquerTout } = require('./inpi/diagnostic');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/* ------------------------------------------------------------------- INPI */

/** État des connexions + référentiels officiels utiles au formulaire. */
router.get('/inpi/etat', (req, res) => {
  res.json({
    ...etat(),
    formes_juridiques: formesCreation(),
    types_voie: enumeration('typeVoie'),
  });
});

/**
 * Teste les accès INPI : connexion (identifiant + mot de passe → jeton de
 * session) puis lecture réelle sur chaque API. L'INPI ne délivrant pas de clé
 * d'API, c'est le seul moyen de vérifier une configuration — et il ne dépose
 * rien. Sans paramètre, les deux API sont testées.
 */
router.post('/inpi/test-connexion', async (req, res) => {
  const { api, siren } = req.body || {};
  if (api === 'rne' || api === 'guichet') {
    return res.json(await diagnostiquer(api, { siren }));
  }
  return res.json(await diagnostiquerTout({ siren }));
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

/** Demandes de régularisation en attente sur tout le compte mandataire. */
router.get('/formalites/regularisations', async (req, res) => {
  res.json(await guichet.regularisations(null));
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

/** Signature du dépôt (simple pour une création, avancée sinon). */
router.post('/formalites/:id/signer', async (req, res) => {
  res.json(await formalites.signer(Number(req.params.id), {
    documentSigneId: req.body?.documentSigneId || null,
  }));
});

/** Paiement des taxes — nécessite une configuration dédiée. */
router.post('/formalites/:id/payer', async (req, res) => {
  res.json(await formalites.payer(Number(req.params.id)));
});

/** Document de synthèse à signer (PDF produit par le guichet unique). */
router.get('/formalites/:id/synthese', async (req, res) => {
  const { formalite, buffer } = await formalites.synthese(Number(req.params.id));
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="synthese-${formalite.reference || formalite.id}.pdf"`);
  res.send(buffer);
});


router.delete('/formalites/:id', async (req, res) => {
  res.json(await formalites.supprimer(Number(req.params.id)));
});

module.exports = router;
