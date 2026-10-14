'use strict';

/**
 * Onglet « Suivi Formalités AI » : les dossiers menés par Claude via le
 * connecteur Guichet unique, en lecture seule. Seule action offerte : relire
 * le statut auprès de l'INPI.
 */

const express = require('express');
const { supabase, q } = require('./supa');
const formalites = require('./services/formalites');
const parcours = require('./services/parcours');
const { ORIGINE, echeanceDe, journalDe, modes } = require('./connecteur/service');
const { statut: statutInfo } = require('./inpi/referentiels');

const router = express.Router();

async function dossierAssistant(id) {
  const [f] = await q(supabase.from('formalites').select('*').eq('id', id));
  if (!f || f.origine !== ORIGINE) throw Object.assign(new Error('Dossier introuvable dans le suivi de l’assistant.'), { status: 404 });
  return f;
}

router.get('/formalites-ai', async (req, res) => {
  const liste = await formalites.lister({ origine: ORIGINE });
  res.json({
    formalites: liste.map((f) => ({
      id: f.id, reference: f.reference, libelle: f.libelle, societe: f.societe_nom, siren: f.siren,
      statut: f.statut, statut_libelle: f.statut_libelle, statut_couleur: f.statut_couleur,
      action_attendue: f.inpi_id ? f.action_attendue : null, echeance: f.echeance, en_retard: f.en_retard,
      numero_liasse: f.numero_liasse, simule: f.simule, regularisations: f.nb_regularisations,
      depot_expire: f.depot_expire, maj: f.updated_at || f.created_at, dossier_id: f.dossier_id,
    })),
    ...modes(),
  });
});

router.get('/formalites-ai/:id', async (req, res) => {
  const f = await dossierAssistant(req.params.id);
  const d = await parcours.lire(f.id);
  let dossier = null;
  if (f.dossier_id) [dossier] = await q(supabase.from('dossiers').select('id, reference, titre').eq('id', f.dossier_id));
  res.json({
    ...d,
    statut_libelle: statutInfo(f.statut).libelle,
    statut_couleur: statutInfo(f.statut).couleur,
    action_attendue: f.inpi_id ? f.action_attendue : null,
    regularisations: f.regularisations || [],
    echeance: echeanceDe(f.operations || [], f.reponses || {}),
    depot_expire: f.depot_expire,
    dossier: dossier || null,
    journal: await journalDe(f.id, 100),
    ...modes(),
  });
});

router.post('/formalites-ai/:id/actualiser', async (req, res) => {
  const f = await dossierAssistant(req.params.id);
  if (!f.inpi_id) return res.json({ synchronise: false, message: 'Dossier pas encore enregistré au guichet.' });
  const r = await formalites.synchroniser(f.id);
  res.json({ synchronise: true, changement: Boolean(r.changement), statut_libelle: statutInfo(r.statut).libelle });
});

module.exports = router;
