'use strict';

/**
 * Routes du module « Registre des mouvements de titres ».
 *
 * L'identité de l'utilisateur est celle de la session (src/auth.js) : le
 * circuit d'approbation et le journal s'appuient sur une personne réelle.
 */

const express = require('express');
const { supabase, q: db, utilisateurCourant: connecte } = require('./supa');
const rmt = require('./services/rmt');
const controles = require('./services/rmt-controles');
const certification = require('./services/rmt-certification');

const router = express.Router();

async function utilisateurCourant() {
  return connecte();
}

/* ------------------------------------------------------------ utilisateurs */

router.get('/rmt/utilisateurs', async (req, res) => {
  res.json(await db(supabase.from('utilisateurs').select('id, email, nom, prenom, role, actif').order('id')));
});

router.post('/rmt/utilisateurs', async (req, res) => {
  const { email, nom, prenom, role } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Courriel requis.' });
  const cree = await db(supabase.from('utilisateurs').insert({
    email, nom: nom || '', prenom: prenom || '', role: role || 'collaborateur',
  }).select().single());
  res.status(201).json(cree);
});

/* ------------------------------------------------------------- la société */

router.get('/rmt/societes/:id', async (req, res) => {
  res.json(await rmt.societe(Number(req.params.id)));
});

router.post('/rmt/societes/:id/activer', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.status(201).json(await rmt.activer(Number(req.params.id), { ...req.body, utilisateur_id: u?.id }));
});

router.put('/rmt/societes/:id/parametres', async (req, res) => {
  const maj = await db(supabase.from('rmt_societes').update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('societe_id', req.params.id).select().single());
  res.json(maj);
});

/**
 * Corrige l'écart entre la fiche société et le registre. Aucun sens n'est
 * imposé : l'outil ne sait pas lequel des deux chiffres a raison.
 */
router.put('/rmt/societes/:id/capital', async (req, res) => {
  const id = Number(req.params.id);
  const { sens, capital_social, nb_titres, emissions } = req.body || {};
  const u = await utilisateurCourant(req);

  if (sens === 'aligner_fiche') {
    const [coherence] = await db(supabase.from('rmt_coherence_capital').select('*').eq('societe_id', id));
    await db(supabase.from('societes').update({
      capital_social: capital_social ?? coherence.capital_calcule,
      nb_titres: nb_titres ?? coherence.titres_emis,
    }).eq('id', id).select());
  } else if (sens === 'corriger_registre') {
    if (Array.isArray(emissions) && emissions.length) {
      await db(supabase.from('rmt_emissions').insert(emissions.map((e) => ({
        categorie_id: e.categorie_id, date_effet: e.date_effet,
        quantite: e.quantite, decision: e.decision || 'Correction du registre',
      }))));
    }
  } else if (capital_social !== undefined || nb_titres !== undefined) {
    await db(supabase.from('societes').update({
      ...(capital_social !== undefined ? { capital_social } : {}),
      ...(nb_titres !== undefined ? { nb_titres } : {}),
    }).eq('id', id).select());
  }

  await rmt.journal(id, u?.id, 'capital.corrige', 'societe', id, { sens });
  res.json((await db(supabase.from('rmt_coherence_capital').select('*').eq('societe_id', id)))[0]);
});

/* -------------------------------------------- catégories, émissions, comptes */

router.post('/rmt/societes/:id/categories', async (req, res) => {
  res.status(201).json(await db(supabase.from('rmt_categories')
    .insert({ ...req.body, societe_id: Number(req.params.id) }).select().single()));
});

router.put('/rmt/categories/:id', async (req, res) => {
  res.json(await db(supabase.from('rmt_categories').update(req.body).eq('id', req.params.id).select().single()));
});

router.post('/rmt/societes/:id/emissions', async (req, res) => {
  const u = await utilisateurCourant(req);
  const cree = await db(supabase.from('rmt_emissions').insert(req.body).select().single());
  await rmt.journal(Number(req.params.id), u?.id, 'emission.saisie', 'emission', cree.id, req.body);
  res.status(201).json(cree);
});

router.delete('/rmt/emissions/:id', async (req, res) => {
  await db(supabase.from('rmt_emissions').delete().eq('id', req.params.id).select());
  res.json({ supprime: true });
});

router.post('/rmt/societes/:id/titulaires', async (req, res) => {
  res.status(201).json(await db(supabase.from('rmt_titulaires')
    .insert({ ...req.body, societe_id: Number(req.params.id) }).select().single()));
});

router.post('/rmt/societes/:id/comptes', async (req, res) => {
  const { titulaires = [], ...compte } = req.body || {};
  const cree = await db(supabase.from('rmt_comptes')
    .insert({ ...compte, societe_id: Number(req.params.id) }).select().single());
  if (titulaires.length) {
    await db(supabase.from('rmt_comptes_titulaires').insert(titulaires.map((t) => ({
      compte_id: cree.id, titulaire_id: t.titulaire_id || t, quote_part: t.quote_part || null,
    }))));
  }
  res.status(201).json(cree);
});

/* ------------------------------------------------------------- les écritures */

router.get('/rmt/societes/:id/mouvements', async (req, res) => {
  res.json(await rmt.mouvements(Number(req.params.id), {
    historique: req.query.historique === '1',
    date: req.query.date || null,
  }));
});

router.post('/rmt/societes/:id/mouvements', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.status(201).json(await rmt.creerMouvement(Number(req.params.id), req.body, u?.id));
});

/** Lecture seule : ce que l'écran montre avant d'enregistrer une modification. */
router.get('/rmt/mouvements/:id/impact', async (req, res) => {
  res.json(await rmt.impact(Number(req.params.id)));
});

router.put('/rmt/mouvements/:id', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.json(await rmt.modifierMouvement(Number(req.params.id), req.body, u?.id));
});

router.post('/rmt/mouvements/:id/deplacer', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.json(await rmt.deplacerMouvement(Number(req.params.id), req.body || {}, u?.id));
});

router.delete('/rmt/mouvements/:id', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.json(await rmt.supprimerMouvement(Number(req.params.id), req.body || {}, u?.id));
});

router.get('/rmt/mouvements/:id/versions', async (req, res) => {
  res.json(await rmt.versions(Number(req.params.id)));
});

router.post('/rmt/mouvements/:id/restaurer', async (req, res) => {
  const u = await utilisateurCourant(req);
  const { version_id, motif } = req.body || {};
  res.json(await rmt.restaurerVersion(Number(req.params.id), Number(version_id), u?.id, motif));
});

/* ------------------------------------------ suppression d'une écriture à l'encre */

router.post('/rmt/mouvements/:id/demande-suppression', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.status(201).json(await rmt.demanderSuppression(Number(req.params.id), req.body || {}, u?.id));
});

router.get('/rmt/demandes-suppression', async (req, res) => {
  res.json(await rmt.listerDemandes(req.query.statut || 'en_attente'));
});

router.post('/rmt/demandes-suppression/:id/decider', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.json(await rmt.deciderDemande(Number(req.params.id),
    { approuver: req.body?.approuver === true, motif: req.body?.motif }, u));
});

/* ------------------------------------------------------------- les contrôles */

router.get('/rmt/societes/:id/anomalies', async (req, res) => {
  res.json(await controles.analyser(Number(req.params.id)));
});

router.post('/rmt/societes/:id/alertes/acquitter', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.json(await controles.acquitter({ ...req.body, societe_id: Number(req.params.id) }, u?.id));
});

/* ----------------------------------------------------------- certification */

router.post('/rmt/societes/:id/extraits/previsualiser', async (req, res) => {
  res.json(await certification.previsualiser(Number(req.params.id), req.body || {}));
});

router.post('/rmt/societes/:id/extraits', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.status(201).json(await certification.certifier(Number(req.params.id), req.body || {}, u));
});

router.get('/rmt/extraits/:id', async (req, res) => {
  const [extrait] = await db(supabase.from('rmt_extraits').select('*').eq('id', req.params.id));
  if (!extrait) return res.status(404).json({ error: 'Extrait inconnu.' });
  const u = await utilisateurCourant(req);
  await rmt.journal(extrait.societe_id, u?.id, 'extrait.consulte', 'extrait', extrait.id, {});
  res.json(extrait);
});

router.post('/rmt/extraits/:id/revoquer', async (req, res) => {
  const u = await utilisateurCourant(req);
  res.json(await certification.revoquer(Number(req.params.id), req.body?.motif, u));
});

/* -------------------------------------------------------------- le journal */

router.get('/rmt/societes/:id/audit', async (req, res) => {
  res.json(await db(supabase.from('rmt_audit').select('*')
    .eq('societe_id', req.params.id).order('created_at', { ascending: false }).limit(200)));
});

module.exports = router;
