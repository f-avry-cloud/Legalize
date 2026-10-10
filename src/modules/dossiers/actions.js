'use strict';

/**
 * Actions proposées sur les dossiers par les modules existants.
 * (Le registre est décrit dans src/modules/actions.js.)
 */

const { enregistrer } = require('../actions');

/** Première société de la base parmi les parties du dossier. */
const societeDe = (d) => (d.parties || []).find((p) => p.societe_id)?.societe_id || null;
const avecSociete = (d) => (societeDe(d) ? `&societe=${societeDe(d)}` : '');

enregistrer({
  id: 'generer-actes',
  libelle: 'Générer des actes',
  description: 'Production documentaire en un clic pour une société du dossier ; l’opération est rattachée au dossier.',
  familles: ['haut_de_bilan', 'secretariat'],
  lien: (d) => `#/operations/new?dossier=${d.id}${avecSociete(d)}`,
});

enregistrer({
  id: 'preparer-formalite',
  libelle: 'Préparer une formalité',
  description: 'Parcours de formalités au guichet unique ; le dossier de formalité est rattaché à ce dossier.',
  familles: ['haut_de_bilan', 'secretariat'],
  lien: (d) => `#/parcours/nouveau?dossier=${d.id}${avecSociete(d)}`,
});
