'use strict';

/**
 * Serveur MCP du connecteur « Guichet unique » pour Claude.
 *
 * Transport HTTP « streamable », sans état (une instance par requête) : c'est
 * ce qui convient à une fonction serverless Vercel. Chaque outil délègue à
 * src/connecteur/outils.js.
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const { FORMALITES } = require('../inpi/catalogue');
const outils = require('./outils');
const { VERSION } = require('../version');

const TYPES = Object.keys(FORMALITES);

const INSTRUCTIONS = [
  'Connecteur du Guichet unique INPI (formalités d’entreprises), au service d’un avocat mandataire.',
  'Démarche : 1) exigences_formalite pour savoir quoi recueillir ; 2) fiche_entreprise pour l’état actuel au RNE ;',
  '3) controler_formalite avec les réponses tirées des actes ; 4) ouvrir_depot_pieces pour obtenir le lien où l’avocat dépose ses PDF ;',
  '5) récapitulatif présenté à l’avocat puis, après son accord explicite, enregistrer_formalite avec confirmation_avocat = true ;',
  '6) statut_formalite / lister_formalites pour le suivi.',
  'Le connecteur ne signe ni ne paie : l’avocat le fait sur le portail du Guichet unique.',
  'Toujours signaler à l’avocat un mode « simulation » : rien n’est alors transmis à l’INPI.',
].join(' ');

const reponses = z.record(z.string(), z.any())
  .describe('Réponses de la formalité, clés = « nom » des champs renvoyés par exigences_formalite. Ne mettre que ce qui change.');
const type = z.enum(TYPES).describe('Type de formalité (voir lister_types_formalites).');
const siren = z.string().describe('SIREN de la société (9 chiffres, espaces tolérés).');
const reference = z.string().regex(/^GU-[A-Z2-9]{8}$/)
  .describe('Référence du dossier renvoyée par ouvrir_depot_pieces (ex. GU-7K3Q9MZT).');

function texte(objet) {
  return { content: [{ type: 'text', text: JSON.stringify(objet, null, 2) }] };
}

function enErreur(e) {
  const lignes = [e.message || 'Erreur inattendue.'];
  const violations = e.detail?.violations;
  if (Array.isArray(violations) && violations.length) {
    lignes.push('Champs refusés par le Guichet unique :');
    for (const v of violations) lignes.push(`- ${v.propertyPath || '(formalité)'} : ${v.message}`);
  }
  if (e.details?.bloquants) lignes.push(...e.details.bloquants.map((b) => `- ${b.message || b}`));
  return { isError: true, content: [{ type: 'text', text: lignes.join('\n') }] };
}

/** Enveloppe commune : résultat JSON, erreurs en clair. */
const gerer = (fn) => async (args) => {
  try { return texte(await fn(args || {})); } catch (e) { return enErreur(e); }
};

const LECTURE = { readOnlyHint: true, openWorldHint: true };

function construireServeur({ baseUrl }) {
  const serveur = new McpServer(
    { name: 'legalize-guichet-unique', version: VERSION || '1.0.0' },
    { instructions: INSTRUCTIONS },
  );

  serveur.registerTool('lister_types_formalites', {
    title: 'Formalités prises en charge',
    description: 'Liste les formalités que le connecteur sait préparer et enregistrer, avec leur code évènement et leur délai légal.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, gerer(() => ({ formalites: outils.formalites() })));

  serveur.registerTool('exigences_formalite', {
    title: 'Champs et pièces d’une formalité',
    description: 'Pour un type de formalité, donne les champs à renseigner (avec valeurs autorisées et formats des adresses et personnes) et les pièces exigées. Rappeler l’outil avec les réponses déjà connues : champs et pièces conditionnels s’ajustent.',
    inputSchema: { type, reponses: reponses.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, gerer(({ type: t, reponses: r }) => outils.exigences(t, r || {})));

  serveur.registerTool('rechercher_entreprise', {
    title: 'Rechercher une entreprise au RNE',
    description: 'Recherche une entreprise au Registre national des entreprises par dénomination ou SIREN.',
    inputSchema: { terme: z.string().min(2).describe('Dénomination ou SIREN.') },
    annotations: LECTURE,
  }, gerer(({ terme }) => outils.rechercherEntreprise(terme)));

  serveur.registerTool('fiche_entreprise', {
    title: 'Fiche RNE d’une entreprise',
    description: 'État actuel de la société au RNE : dénomination, forme, capital, siège, objet, dirigeants en fonction, clôture. Sert de base à toute modification.',
    inputSchema: { siren },
    annotations: LECTURE,
  }, gerer(({ siren: s }) => outils.ficheEntreprise(s)));

  serveur.registerTool('controler_formalite', {
    title: 'Contrôler une formalité avant enregistrement',
    description: 'Exécute les contrôles du Guichet unique avant tout envoi : champs, cohérence, codes de référentiel, pièces reçues, délai légal. Renvoie bloquants, alertes, informations, pièces manquantes, échéance et aperçu lisible. Ne transmet rien à l’INPI.',
    inputSchema: {
      type, siren: siren.optional(), reponses,
      reference: reference.optional().describe('Référence du dossier, pour tenir compte des pièces déjà déposées.'),
    },
    annotations: LECTURE,
  }, gerer((a) => outils.controlerFormalite(a)));

  serveur.registerTool('ouvrir_depot_pieces', {
    title: 'Lien de dépôt des pièces',
    description: 'Crée (ou rouvre) le dossier de pièces et renvoie un lien, valable 7 jours, où l’avocat dépose ses PDF depuis son téléphone ou son ordinateur. Rappeler avec les réponses à jour si la liste des pièces exigées a changé ; garder la même référence.',
    inputSchema: {
      type, reponses: reponses.optional(),
      reference: reference.optional().describe('À fournir pour rouvrir un dossier existant.'),
      denomination: z.string().optional().describe('Dénomination, affichée sur la page de dépôt.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, gerer((a) => outils.ouvrirDepotPieces(a, baseUrl)));

  serveur.registerTool('pieces_recues', {
    title: 'Pièces déposées par l’avocat',
    description: 'Liste les PDF déjà déposés pour un dossier via le lien de dépôt.',
    inputSchema: { reference },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, gerer(({ reference: r }) => outils.listerPiecesRecues(r)));

  serveur.registerTool('enregistrer_formalite', {
    title: 'Enregistrer la formalité au Guichet unique',
    description: 'Transmet la formalité et ses pièces au Guichet unique, au nom du compte mandataire. À n’appeler qu’après avoir présenté le récapitulatif à l’avocat et obtenu son accord explicite. Refuse si un contrôle bloquant subsiste. Ne signe ni ne paie : l’avocat le fait ensuite sur le portail.',
    inputSchema: {
      type, siren: siren.optional(), reponses, reference,
      libelle: z.string().optional().describe('Nom du dossier côté INPI (par défaut : dénomination — formalité).'),
      confirmation_avocat: z.literal(true).describe('true uniquement si l’avocat a validé le récapitulatif dans la conversation.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, gerer((a) => outils.enregistrerFormalite(a)));

  serveur.registerTool('statut_formalite', {
    title: 'Statut d’une formalité',
    description: 'Statut actuel d’une formalité au Guichet unique, action attendue et par qui, montant, demandes de régularisation (motif, pièce, échéance).',
    inputSchema: {
      inpi_id: z.string().describe('Identifiant INPI renvoyé à l’enregistrement.'),
      comptes_annuels: z.boolean().optional().describe('true pour un dépôt de comptes annuels.'),
      historique: z.boolean().optional().describe('true pour joindre l’historique des statuts.'),
    },
    annotations: LECTURE,
  }, gerer((a) => outils.statutFormalite(a)));

  serveur.registerTool('lister_formalites', {
    title: 'Formalités du compte mandataire',
    description: 'Liste les formalités du compte Guichet unique, les plus récentes d’abord, avec statut et action attendue. Sert au suivi général (ex. récapitulatif quotidien).',
    inputSchema: {
      statut: z.string().optional().describe('Code de statut INPI (ex. AMENDMENT_PENDING, SIGNATURE_PENDING).'),
      siren: z.string().optional(),
      reference: z.string().optional().describe('Référence mandataire du dossier.'),
      maximum: z.number().int().min(1).max(100).optional(),
      comptes_annuels: z.boolean().optional(),
    },
    annotations: LECTURE,
  }, gerer((a) => outils.listerFormalites(a)));

  return serveur;
}

module.exports = { construireServeur, INSTRUCTIONS };
