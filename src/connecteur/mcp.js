'use strict';

/**
 * Serveur MCP du connecteur « Guichet unique » (transport HTTP « streamable »,
 * sans état) : claude.ai, Claude Code ou l'application mobile l'ajoutent comme
 * connecteur personnalisé à l'adresse https://<application>/mcp/<jeton>.
 *
 * Le jeton de l'adresse (variable MCP_GU_JETON) est le seul secret : qui le
 * détient pilote les dossiers du connecteur. Il se change dans Vercel, ce qui
 * révoque aussitôt l'ancienne adresse.
 */

const crypto = require('crypto');
const express = require('express');
const { clientService, dansContexte } = require('../supa');
const { OUTILS } = require('./service');
const { VERSION } = require('../version');

const VERSIONS_PROTOCOLE = ['2025-06-18', '2025-03-26', '2024-11-05'];

const CONSIGNES = [
  'Connecteur de formalités au Guichet unique de l’INPI pour le cabinet. Vous assistez un avocat mandataire.',
  'Déroulé : fiche_entreprise → exigences_formalite → ouvrir_depot_pieces (lien de dépôt des PDF à donner à l’avocat) → renseigner_formalite → pieces_recues → controler_formalite → récapitulatif de validation → enregistrer_formalite → statut_formalite.',
  'Les PDF joints à la conversation ne peuvent pas être transmis par l’outil : ils passent par le lien de ouvrir_depot_pieces.',
  'N’appelez enregistrer_formalite qu’après l’accord explicite de l’avocat (« je confirme ») sur un récapitulatif complet, avec confirmation_avocat: true. Aucun outil ne signe ni ne paie : la signature et le paiement se font sur le portail.',
  'Si un résultat indique guichet_simulation: true, dites-le à l’avocat : rien n’est transmis à l’INPI.',
  'N’inventez aucune donnée ; ne recopiez pas inutilement les données personnelles (numéro de sécurité sociale, adresse personnelle).',
].join('\n');

function jetonValide(recu) {
  const attendu = process.env.MCP_GU_JETON || '';
  // Un jeton court se devine : le connecteur reste fermé.
  if (attendu.length < 24) return false;
  const a = crypto.createHash('sha256').update(String(recu || '')).digest();
  const b = crypto.createHash('sha256').update(attendu).digest();
  return crypto.timingSafeEqual(a, b);
}

const reponse = (id, result) => ({ jsonrpc: '2.0', id, result });
const echec = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** Exécute un outil ; une erreur métier revient à Claude en clair, pas en panne. */
async function appeler(nom, args) {
  const outil = OUTILS.find((o) => o.name === nom);
  if (!outil) return null;
  try {
    const resultat = await outil.run(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(resultat, null, 1) }] };
  } catch (e) {
    const detail = e.details ? `\nDétail : ${JSON.stringify(e.details)}` : '';
    const violations = Array.isArray(e.detail?.violations)
      ? `\nDonnées refusées par le guichet : ${e.detail.violations.map((v) => `${v.propertyPath} — ${v.message}`).join(' ; ')}` : '';
    if (!e.status || e.status >= 500) console.error('[connecteur]', nom, e);
    return { isError: true, content: [{ type: 'text', text: `${e.message || 'Erreur'}${detail}${violations}` }] };
  }
}

async function traiter(message) {
  const { id, method, params } = message || {};
  if (!method || typeof method !== 'string') return echec(id, -32600, 'Requête invalide');
  // Notification (sans identifiant) : rien à répondre.
  if (id === undefined || id === null) return null;
  switch (method) {
    case 'initialize': {
      const demandee = params?.protocolVersion;
      return reponse(id, {
        protocolVersion: VERSIONS_PROTOCOLE.includes(demandee) ? demandee : VERSIONS_PROTOCOLE[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'guichet-unique-legalize', title: 'Guichet unique (Legalize)', version: String(VERSION || '1') },
        instructions: CONSIGNES,
      });
    }
    case 'ping':
      return reponse(id, {});
    case 'tools/list':
      return reponse(id, { tools: OUTILS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const r = await appeler(params?.name, params?.arguments);
      return r ? reponse(id, r) : echec(id, -32602, `Outil inconnu : ${params?.name}`);
    }
    case 'resources/list':
      return reponse(id, { resources: [] });
    case 'prompts/list':
      return reponse(id, { prompts: [] });
    default:
      return echec(id, -32601, `Méthode non prise en charge : ${method}`);
  }
}

const routeur = express.Router();

routeur.all('/:jeton', async (req, res) => {
  if (!jetonValide(req.params.jeton)) return res.status(404).json({ error: 'Introuvable' });
  if (req.method !== 'POST') return res.set('Allow', 'POST').status(405).json({ error: 'Méthode non autorisée' });
  const service = clientService();
  if (!service) return res.status(503).json(echec(null, -32000, 'Connecteur non configuré : clé de service Supabase absente.'));

  const lot = Array.isArray(req.body) ? req.body : [req.body];
  const reponses = [];
  await dansContexte({ client: service, utilisateur: null }, async () => {
    for (const m of lot) {
      const r = await traiter(m);
      if (r) reponses.push(r);
    }
  });
  if (!reponses.length) return res.status(202).end();
  return res.json(Array.isArray(req.body) ? reponses : reponses[0]);
});

module.exports = { routeur, traiter, jetonValide, CONSIGNES };
