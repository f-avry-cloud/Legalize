'use strict';

/**
 * Jeu de démonstration : un groupe de trois sociétés, deux opérations, un devis.
 * Idempotent : ne fait rien si la base contient déjà des sociétés.
 */

const { supabase, q, qCount } = require('./supa');
const { OPERATION_TYPES } = require('./definitions');

async function seedIfEmpty() {
  const n = await qCount(supabase.from('societes').select('id', { count: 'exact', head: true }));
  if (n > 0) return false;

  const groupe = await q(supabase.from('groupes')
    .insert({ nom: 'Groupe Horizon', description: 'Groupe familial — holding et deux filiales opérationnelles' })
    .select().single());

  const [holding, filiale1, filiale2] = await q(supabase.from('societes').insert([
    {
      groupe_id: groupe.id, denomination: 'Horizon Holding', forme_sociale: 'SAS',
      capital_social: 100000, nb_titres: 10000, siege_social: '12 rue de la Paix, 75002 Paris',
      siren: '901 234 567', rcs_ville: 'Paris',
      objet_social: 'la prise de participations dans toutes sociétés, la gestion et l’animation de ses filiales',
    },
    {
      groupe_id: groupe.id, denomination: 'Horizon Tech', forme_sociale: 'SAS',
      capital_social: 50000, nb_titres: 5000, siege_social: '4 avenue Foch, 69006 Lyon',
      siren: '902 345 678', rcs_ville: 'Lyon',
      objet_social: 'l’édition de logiciels et le conseil en systèmes informatiques',
    },
    {
      groupe_id: groupe.id, denomination: 'Horizon Immo', forme_sociale: 'SARL',
      capital_social: 20000, nb_titres: 2000, siege_social: '12 rue de la Paix, 75002 Paris',
      siren: '903 456 789', rcs_ville: 'Paris',
      objet_social: 'l’acquisition, la gestion et la location de tous biens immobiliers',
    },
  ]).select());

  await q(supabase.from('dirigeants').insert([
    { societe_id: holding.id, civilite: 'Mme', nom: 'Durand', prenom: 'Claire', fonction: 'Présidente', adresse: '8 rue des Lilas, 75011 Paris' },
    { societe_id: filiale1.id, civilite: 'M.', nom: 'Martin', prenom: 'Paul', fonction: 'Président', adresse: '15 quai Saint-Antoine, 69002 Lyon' },
    { societe_id: filiale2.id, civilite: 'Mme', nom: 'Durand', prenom: 'Claire', fonction: 'Gérante', adresse: '8 rue des Lilas, 75011 Paris' },
  ]).select());

  await q(supabase.from('associes').insert([
    // Holding détenue par deux personnes physiques.
    { societe_id: holding.id, type: 'physique', civilite: 'Mme', nom: 'Durand', prenom: 'Claire', nb_titres: 7000, adresse: '8 rue des Lilas, 75011 Paris' },
    { societe_id: holding.id, type: 'physique', civilite: 'M.', nom: 'Durand', prenom: 'Antoine', nb_titres: 3000, adresse: '3 place Bellecour, 69002 Lyon' },
    // Filiales détenues par la holding (participations → organigramme).
    { societe_id: filiale1.id, type: 'morale', civilite: '', denomination: 'Horizon Holding', societe_liee_id: holding.id, nb_titres: 4000, adresse: '12 rue de la Paix, 75002 Paris' },
    { societe_id: filiale1.id, type: 'physique', civilite: 'M.', nom: 'Martin', prenom: 'Paul', nb_titres: 1000, adresse: '15 quai Saint-Antoine, 69002 Lyon' },
    { societe_id: filiale2.id, type: 'morale', civilite: '', denomination: 'Horizon Holding', societe_liee_id: holding.id, nb_titres: 2000, adresse: '12 rue de la Paix, 75002 Paris' },
  ]).select());

  async function operation(societeId, type, libelle, variables) {
    const op = await q(supabase.from('operations')
      .insert({ societe_id: societeId, type, libelle, variables })
      .select().single());
    await q(supabase.from('documents').insert(OPERATION_TYPES[type].documents.map((d) => ({
      operation_id: op.id, code: d.code, nom: d.nom, obligatoire: Boolean(d.obligatoire),
    }))).select());
    return op;
  }

  const opAgo = await operation(filiale1.id, 'approbation_comptes', 'AGO 2025 — Horizon Tech', {
    exercice_clos: '2025-12-31',
    date_ago: '2026-06-25',
    resultat: 184500,
    affectation: 'dividendes',
    montant_dividendes: 100000,
    conventions_reglementees: true,
    quitus: true,
  });

  await operation(filiale1.id, 'cession_titres', 'Cession Martin → Holding', {
    cedant_nom: 'M. Paul Martin',
    cedant_adresse: '15 quai Saint-Antoine, 69002 Lyon',
    cessionnaire_nom: 'Horizon Holding',
    cessionnaire_adresse: '12 rue de la Paix, 75002 Paris',
    nb_titres_cedes: 500,
    prix_total: 75000,
    date_cession: '2026-09-15',
    clause_agrement: true,
    garantie_ap: false,
    date_agrement: '2026-09-10',
  });

  await q(supabase.from('factures').insert({
    operation_id: opAgo.id, type: 'devis', numero: 'DEV-2026-001', mode: 'forfait',
    taux_tva: 20, statut: 'envoye',
    lignes: [{ description: 'Approbation des comptes 2025 — forfait (convocation, rapport, PV, formalités)', quantite: 1, prix_unitaire: 950 }],
  }).select());

  return true;
}

module.exports = { seedIfEmpty };
