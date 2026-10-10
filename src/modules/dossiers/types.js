'use strict';

/**
 * Catalogue des types de dossiers.
 *
 * Chaque type décrit : sa famille, ses étapes par défaut (le cabinet les
 * remplace dans « Modèles d'étapes » ; chaque dossier garde sa propre copie),
 * les informations qui lui sont propres (rangées dans `dossiers.donnees`) et
 * les rôles que peuvent tenir les sociétés concernées.
 *
 * Ajouter un type ici suffit : la base n'a pas à changer.
 */

const FAMILLES = {
  haut_de_bilan: {
    libelle: 'Haut de bilan',
    description: 'Cessions, acquisitions, transmissions, restructurations, levées de fonds : suivi par étapes.',
  },
  secretariat: {
    libelle: 'Secrétariat juridique',
    description: 'Vie sociale des sociétés clientes : approbation des comptes, décisions de gestion, registres.',
  },
  conseil: {
    libelle: 'Conseil',
    description: 'Consultations, questions ponctuelles de dirigeants, contrats.',
  },
};

const STATUTS = {
  en_cours: 'En cours',
  en_attente: 'En attente du client',
  suspendu: 'Suspendu',
  clos: 'Clos',
  abandonne: 'Abandonné',
};

const ROLES_HAUT_DE_BILAN = {
  cible: 'Cible', cedant: 'Cédant', acquereur: 'Acquéreur', absorbante: 'Absorbante', absorbee: 'Absorbée',
  apporteuse: 'Apporteuse', beneficiaire: 'Bénéficiaire', investisseur: 'Investisseur', holding: 'Holding de reprise',
  concernee: 'Concernée',
};
const ROLES_SIMPLES = { concernee: 'Concernée' };

const COTE = {
  nom: 'cote', libelle: 'Le cabinet intervient pour', type: 'select',
  options: { cedant: 'Le cédant', acquereur: 'L’acquéreur', cible: 'La cible', investisseur: 'L’investisseur', autre: 'Autre' },
};

/** e(code, libellé) : une étape. */
const e = (code, libelle) => ({ code, libelle });

const TYPES = {
  /* ------------------------------------------------------- haut de bilan */
  cession_titres: {
    famille: 'haut_de_bilan',
    libelle: 'Cession de titres',
    etapes: [
      e('mission', 'Lettre de mission'), e('nda', 'Accord de confidentialité'), e('loi', 'Lettre d’intention'),
      e('data_room', 'Data room'), e('audit', 'Audit (due diligence)'), e('spa_gap', 'Négociation du contrat de cession et de la GAP'),
      e('signing', 'Signing'), e('cs', 'Levée des conditions suspensives'), e('closing', 'Closing'), e('post_closing', 'Post-closing (formalités, registres)'),
    ],
    champs: [
      COTE,
      { nom: 'prix', libelle: 'Prix (€)', type: 'number' },
      { nom: 'date_closing_visee', libelle: 'Closing visé le', type: 'date', echeance: true },
      { nom: 'conditions_suspensives', libelle: 'Conditions suspensives', type: 'textarea' },
    ],
    roles: ROLES_HAUT_DE_BILAN,
  },
  acquisition: {
    famille: 'haut_de_bilan',
    libelle: 'Acquisition / LBO',
    etapes: [
      e('mission', 'Lettre de mission'), e('nda', 'Accord de confidentialité'), e('loi', 'Lettre d’intention'),
      e('audit', 'Audit (due diligence)'), e('structuration', 'Structuration et holding de reprise'), e('financement', 'Financement'),
      e('spa_gap', 'Négociation du contrat d’acquisition et de la GAP'), e('signing', 'Signing'), e('closing', 'Closing'),
      e('post_closing', 'Post-closing (formalités, registres)'),
    ],
    champs: [
      COTE,
      { nom: 'valorisation', libelle: 'Valorisation (€)', type: 'number' },
      { nom: 'financement', libelle: 'Financement', type: 'textarea' },
      { nom: 'date_closing_visee', libelle: 'Closing visé le', type: 'date', echeance: true },
    ],
    roles: ROLES_HAUT_DE_BILAN,
  },
  transmission: {
    famille: 'haut_de_bilan',
    libelle: 'Transmission d’entreprise',
    etapes: [
      e('mission', 'Lettre de mission'), e('diagnostic', 'Diagnostic et valorisation'), e('schema', 'Choix du schéma de transmission'),
      e('documentation', 'Rédaction des actes'), e('signature', 'Signature'), e('formalites', 'Formalités et registres'),
    ],
    champs: [
      { nom: 'mode', libelle: 'Mode de transmission', type: 'select', options: { cession: 'Cession', donation: 'Donation', dutreil: 'Pacte Dutreil', obo: 'Cession à soi-même (OBO)', autre: 'Autre' } },
      { nom: 'date_visee', libelle: 'Réalisation visée le', type: 'date', echeance: true },
    ],
    roles: ROLES_HAUT_DE_BILAN,
  },
  restructuration: {
    famille: 'haut_de_bilan',
    libelle: 'Restructuration',
    etapes: [
      e('mission', 'Lettre de mission'), e('schema', 'Schéma et calendrier'), e('projet', 'Projet de traité'),
      e('commissaire', 'Commissaire à la fusion / aux apports'), e('depot_projet', 'Dépôt et publicité du projet'),
      e('opposition', 'Délai d’opposition des créanciers'), e('decisions', 'Décisions des associés'), e('realisation', 'Réalisation'),
      e('formalites', 'Formalités et registres'),
    ],
    champs: [
      { nom: 'operation', libelle: 'Opération', type: 'select', options: { fusion: 'Fusion', scission: 'Scission', apport_partiel: 'Apport partiel d’actif', tup: 'Transmission universelle de patrimoine', autre: 'Autre' } },
      { nom: 'date_effet_visee', libelle: 'Date d’effet visée', type: 'date', echeance: true },
    ],
    roles: ROLES_HAUT_DE_BILAN,
  },
  levee_fonds: {
    famille: 'haut_de_bilan',
    libelle: 'Levée de fonds',
    etapes: [
      e('mission', 'Lettre de mission'), e('term_sheet', 'Term sheet'), e('audit', 'Audit'),
      e('documentation', 'Documentation (augmentation de capital, pacte)'), e('closing', 'Closing'), e('formalites', 'Formalités et registres'),
    ],
    champs: [
      COTE,
      { nom: 'montant', libelle: 'Montant levé (€)', type: 'number' },
      { nom: 'investisseurs', libelle: 'Investisseurs', type: 'text' },
      { nom: 'date_closing_visee', libelle: 'Closing visé le', type: 'date', echeance: true },
    ],
    roles: ROLES_HAUT_DE_BILAN,
  },

  /* --------------------------------------------------------- secrétariat */
  approbation_comptes: {
    famille: 'secretariat',
    libelle: 'Approbation des comptes',
    etapes: [
      e('comptes', 'Réception des comptes'), e('rapport', 'Rapport de gestion'), e('convocation', 'Convocation et documents'),
      e('decision', 'Assemblée ou décision'), e('pv', 'Procès-verbal signé'), e('depot', 'Dépôt des comptes au greffe'),
      e('registres', 'Registres à jour'),
    ],
    champs: [
      { nom: 'exercice_clos_le', libelle: 'Exercice clos le', type: 'date', requis: true },
      { nom: 'mode_decision', libelle: 'Mode de décision', type: 'select', options: { assemblee: 'Assemblée', consultation_ecrite: 'Consultation écrite', acte: 'Acte sous seing privé', associe_unique: 'Décision de l’associé unique' } },
      { nom: 'date_decision_prevue', libelle: 'Décision prévue le', type: 'date', echeance: true },
    ],
    roles: ROLES_SIMPLES,
  },
  decision_gestion: {
    famille: 'secretariat',
    libelle: 'Décision de gestion',
    etapes: [
      e('preparation', 'Préparation'), e('decision', 'Décision'), e('actes', 'Actes signés'),
      e('formalites', 'Formalités'), e('registres', 'Registres à jour'),
    ],
    champs: [
      {
        nom: 'decision', libelle: 'Décision', type: 'select', requis: true,
        options: {
          transfert_siege: 'Transfert de siège', changement_dirigeant: 'Changement de dirigeant', capital: 'Modification du capital',
          statuts: 'Modification des statuts', denomination: 'Changement de dénomination', objet: 'Changement d’objet social',
          cac: 'Nomination ou renouvellement du commissaire aux comptes', dissolution: 'Dissolution-liquidation', autre: 'Autre',
        },
      },
      { nom: 'date_decision_prevue', libelle: 'Décision prévue le', type: 'date', echeance: true },
    ],
    roles: ROLES_SIMPLES,
  },
  tenue_registres: {
    famille: 'secretariat',
    libelle: 'Tenue des registres',
    etapes: [e('collecte', 'Collecte des décisions et mouvements'), e('mise_a_jour', 'Mise à jour des registres'), e('controle', 'Contrôle et signature')],
    champs: [{ nom: 'periode', libelle: 'Période', type: 'text' }],
    roles: ROLES_SIMPLES,
  },

  /* -------------------------------------------------------------- conseil */
  consultation: {
    famille: 'conseil',
    libelle: 'Consultation',
    etapes: [e('reception', 'Question reçue'), e('analyse', 'Analyse'), e('redaction', 'Rédaction'), e('envoi', 'Réponse envoyée')],
    champs: [
      { nom: 'domaine', libelle: 'Domaine', type: 'select', options: { fiscal: 'Fiscal', corporate: 'Droit des sociétés', contrats: 'Contrats', social: 'Social', autre: 'Autre' } },
      { nom: 'question', libelle: 'Question posée', type: 'textarea' },
      { nom: 'reponse_attendue_le', libelle: 'Réponse attendue le', type: 'date', echeance: true },
    ],
    roles: ROLES_SIMPLES,
  },
  question_ponctuelle: {
    famille: 'conseil',
    libelle: 'Question ponctuelle',
    etapes: [e('reception', 'Question reçue'), e('reponse', 'Réponse envoyée')],
    champs: [
      { nom: 'question', libelle: 'Question posée', type: 'textarea' },
      { nom: 'reponse_attendue_le', libelle: 'Réponse attendue le', type: 'date', echeance: true },
    ],
    roles: ROLES_SIMPLES,
  },
  contrat: {
    famille: 'conseil',
    libelle: 'Rédaction ou revue de contrat',
    etapes: [e('reception', 'Demande reçue'), e('projet', 'Projet'), e('negociation', 'Négociation'), e('signature', 'Signature')],
    champs: [
      { nom: 'nature_contrat', libelle: 'Contrat', type: 'text' },
      { nom: 'contrepartie', libelle: 'Cocontractant', type: 'text' },
      { nom: 'signature_visee_le', libelle: 'Signature visée le', type: 'date', echeance: true },
    ],
    roles: ROLES_SIMPLES,
  },
};

function type(code) {
  return TYPES[code] || null;
}

/** Les étapes du modèle : celles du cabinet si elles existent, sinon celles par défaut. */
function etapesModele(code, modeles = []) {
  const m = modeles.find((x) => x.type === code);
  return Array.isArray(m?.etapes) && m.etapes.length ? m.etapes : TYPES[code]?.etapes || [];
}

/** Contrôle et nettoyage des informations propres au type. */
function nettoyerDonnees(code, donnees = {}) {
  const t = TYPES[code];
  const propres = {};
  const manquants = [];
  for (const c of t?.champs || []) {
    let v = donnees[c.nom];
    if (v === '' || v === undefined || v === null) {
      if (c.requis) manquants.push(c.libelle);
      continue;
    }
    if (c.type === 'number') v = Number(String(v).replace(/\s/g, '').replace(',', '.'));
    if (c.type === 'number' && !Number.isFinite(v)) continue;
    if (c.type === 'select' && !(String(v) in c.options)) continue;
    if (c.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) continue;
    propres[c.nom] = c.type === 'number' ? v : String(v);
  }
  return { donnees: propres, manquants };
}

/** La date qui sert d'échéance au dossier, quand le type en désigne une. */
function echeanceDepuisDonnees(code, donnees = {}) {
  const champ = (TYPES[code]?.champs || []).find((c) => c.echeance);
  return champ ? donnees[champ.nom] || null : null;
}

/** Catalogue servi à l'écran. */
function catalogue(modeles = []) {
  return {
    familles: FAMILLES,
    statuts: STATUTS,
    types: Object.entries(TYPES).map(([code, t]) => ({
      code, famille: t.famille, libelle: t.libelle, champs: t.champs, roles: t.roles,
      etapes: etapesModele(code, modeles),
      etapes_par_defaut: t.etapes,
      personnalise: modeles.some((m) => m.type === code && Array.isArray(m.etapes) && m.etapes.length),
    })),
  };
}

module.exports = { FAMILLES, STATUTS, TYPES, type, etapesModele, nettoyerDonnees, echeanceDepuisDonnees, catalogue };
