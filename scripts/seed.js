'use strict';

/** Données de démonstration : un groupe de trois sociétés, opérations, facture. */

const db = require('../src/db');

const deja = db.prepare('SELECT COUNT(*) AS n FROM societes').get().n;
if (deja > 0) {
  console.log('Base non vide — seed ignoré.');
  process.exit(0);
}

const groupeId = db.prepare("INSERT INTO groupes (nom, description) VALUES ('Groupe Horizon', 'Groupe familial — holding et deux filiales opérationnelles')").run().lastInsertRowid;

function societe(s) {
  return db.prepare(`
    INSERT INTO societes (groupe_id, denomination, forme_sociale, capital_social, nb_titres, siege_social, siren, rcs_ville, objet_social)
    VALUES (@groupe_id, @denomination, @forme_sociale, @capital_social, @nb_titres, @siege_social, @siren, @rcs_ville, @objet_social)
  `).run(s).lastInsertRowid;
}

const holdingId = societe({
  groupe_id: groupeId, denomination: 'Horizon Holding', forme_sociale: 'SAS',
  capital_social: 100000, nb_titres: 10000, siege_social: '12 rue de la Paix, 75002 Paris',
  siren: '901 234 567', rcs_ville: 'Paris',
  objet_social: 'la prise de participations dans toutes sociétés, la gestion et l’animation de ses filiales',
});
const filiale1Id = societe({
  groupe_id: groupeId, denomination: 'Horizon Tech', forme_sociale: 'SAS',
  capital_social: 50000, nb_titres: 5000, siege_social: '4 avenue Foch, 69006 Lyon',
  siren: '902 345 678', rcs_ville: 'Lyon',
  objet_social: 'l’édition de logiciels et le conseil en systèmes informatiques',
});
const filiale2Id = societe({
  groupe_id: groupeId, denomination: 'Horizon Immo', forme_sociale: 'SARL',
  capital_social: 20000, nb_titres: 2000, siege_social: '12 rue de la Paix, 75002 Paris',
  siren: '903 456 789', rcs_ville: 'Paris',
  objet_social: 'l’acquisition, la gestion et la location de tous biens immobiliers',
});

const dirigeant = db.prepare(`
  INSERT INTO dirigeants (societe_id, civilite, nom, prenom, fonction, adresse)
  VALUES (?, ?, ?, ?, ?, ?)
`);
dirigeant.run(holdingId, 'Mme', 'Durand', 'Claire', 'Présidente', '8 rue des Lilas, 75011 Paris');
dirigeant.run(filiale1Id, 'M.', 'Martin', 'Paul', 'Président', '15 quai Saint-Antoine, 69002 Lyon');
dirigeant.run(filiale2Id, 'Mme', 'Durand', 'Claire', 'Gérante', '8 rue des Lilas, 75011 Paris');

const associe = db.prepare(`
  INSERT INTO associes (societe_id, type, civilite, nom, prenom, denomination, societe_liee_id, nb_titres, adresse)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
// Holding détenue par deux personnes physiques.
associe.run(holdingId, 'physique', 'Mme', 'Durand', 'Claire', '', null, 7000, '8 rue des Lilas, 75011 Paris');
associe.run(holdingId, 'physique', 'M.', 'Durand', 'Antoine', '', null, 3000, '3 place Bellecour, 69002 Lyon');
// Filiales détenues par la holding (participations → organigramme).
associe.run(filiale1Id, 'morale', '', '', '', 'Horizon Holding', holdingId, 4000, '12 rue de la Paix, 75002 Paris');
associe.run(filiale1Id, 'physique', 'M.', 'Martin', 'Paul', '', null, 1000, '15 quai Saint-Antoine, 69002 Lyon');
associe.run(filiale2Id, 'morale', '', '', '', 'Horizon Holding', holdingId, 2000, '12 rue de la Paix, 75002 Paris');

// Une opération d'approbation des comptes prête à générer.
const { OPERATION_TYPES } = require('../src/definitions');
function operation(societeId, type, libelle, variables) {
  const opId = db.prepare('INSERT INTO operations (societe_id, type, libelle, variables) VALUES (?, ?, ?, ?)')
    .run(societeId, type, libelle, JSON.stringify(variables)).lastInsertRowid;
  const insertDoc = db.prepare('INSERT INTO documents (operation_id, code, nom, obligatoire) VALUES (?, ?, ?, ?)');
  for (const d of OPERATION_TYPES[type].documents) insertDoc.run(opId, d.code, d.nom, d.obligatoire ? 1 : 0);
  return opId;
}

const opAgoId = operation(filiale1Id, 'approbation_comptes', 'AGO 2025 — Horizon Tech', {
  exercice_clos: '2025-12-31',
  date_ago: '2026-06-25',
  resultat: 184500,
  affectation: 'dividendes',
  montant_dividendes: 100000,
  conventions_reglementees: true,
  quitus: true,
});

operation(filiale1Id, 'cession_titres', 'Cession Martin → Holding', {
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

db.prepare(`
  INSERT INTO factures (operation_id, type, numero, mode, lignes, taux_tva, statut)
  VALUES (?, 'devis', 'DEV-2026-001', 'forfait', ?, 20, 'envoye')
`).run(opAgoId, JSON.stringify([
  { description: 'Approbation des comptes 2025 — forfait (convocation, rapport, PV, formalités)', quantite: 1, prix_unitaire: 950 },
]));

console.log('Seed terminé : Groupe Horizon (3 sociétés), 2 opérations, 1 devis.');
