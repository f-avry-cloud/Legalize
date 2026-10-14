'use strict';

/**
 * Routes publiques du connecteur Claude, montées AVANT l'authentification de
 * l'application : elles ont leur propre contrôle d'accès.
 *
 *   POST /api/mcp/<CONNECTEUR_SECRET>       protocole MCP (outils pour Claude)
 *   GET  /api/connecteur/pieces?j=<jeton>   page de dépôt des pièces
 *   POST /api/connecteur/pieces/url         URL de téléversement d'un fichier
 *   POST /api/connecteur/pieces/fichier     téléversement direct (tests)
 *   GET  /api/connecteur/pieces/liste       pièces reçues
 *   POST /api/connecteur/pieces/supprimer   retirer une pièce
 *
 * Le secret de l'URL MCP et les jetons signés des liens de dépôt sont les
 * seules clés : sans CONNECTEUR_SECRET, tout répond 404.
 */

const express = require('express');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const jeton = require('./jeton');
const stockage = require('./stockage');
const { construireServeur } = require('./serveur-mcp');
const { pagePieces } = require('./page-pieces');

const router = express.Router();

const PIECE_MAX = 10 * 1024 * 1024;

function introuvable(res) {
  return res.status(404).json({ error: 'Introuvable.' });
}

/** Adresse publique de l'application, pour les liens donnés à l'avocat. */
function baseUrl(req) {
  if (process.env.CONNECTEUR_URL_PUBLIQUE) return process.env.CONNECTEUR_URL_PUBLIQUE.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const hote = process.env.APP_HOST || req.headers['x-forwarded-host'] || req.headers.host;
  return `${String(proto).split(',')[0]}://${hote}`;
}

/* ------------------------------------------------------------------ MCP */

router.post('/mcp/:secret', async (req, res) => {
  if (!jeton.secretValide(req.params.secret)) return introuvable(res);
  const serveur = construireServeur({ baseUrl: baseUrl(req) });
  // Sans état : ni session, ni flux SSE ; une réponse JSON par requête.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); serveur.close(); });
  try {
    await serveur.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[connecteur] MCP', e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erreur interne du connecteur.' }, id: null });
    }
  }
});

// Mode sans état : pas de flux serveur ni de fermeture de session.
router.all('/mcp/:secret', (req, res) => {
  if (!jeton.secretValide(req.params.secret)) return introuvable(res);
  res.set('Allow', 'POST');
  return res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Méthode non autorisée.' }, id: null });
});

/* --------------------------------------------------------- page de dépôt */

/** Contenu d'un jeton de dépôt valide, sinon réponse d'erreur. */
function dossierDuJeton(req, res) {
  const j = req.query.j || req.body?.j;
  const d = jeton.verifier(j);
  if (!d || !jeton.REFERENCE.test(d.ref || '')) {
    res.status(403).json({ error: 'Lien de dépôt invalide ou expiré : demander un nouveau lien à Claude.' });
    return null;
  }
  return d;
}

function entetesPage(res) {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
}

router.get('/connecteur/pieces', (req, res) => {
  entetesPage(res);
  const d = jeton.verifier(req.query.j);
  res.type('html');
  if (!d || !jeton.REFERENCE.test(d.ref || '')) {
    return res.status(403).send(pagePieces({ invalide: true }));
  }
  res.set('Content-Security-Policy', [
    "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    "connect-src 'self' https://*.supabase.co", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'",
  ].join('; '));
  return res.send(pagePieces({ dossier: d }));
});

router.post('/connecteur/pieces/url', async (req, res) => {
  entetesPage(res);
  const d = dossierDuJeton(req, res);
  if (!d) return undefined;
  const { code, nom, taille } = req.body || {};
  if (!d.p.some((p) => p.code === code)) return res.status(400).json({ error: 'Pièce non attendue pour ce dossier.' });
  if (!/\.pdf$/i.test(String(nom || ''))) return res.status(400).json({ error: 'Seuls les fichiers PDF sont acceptés.' });
  if (Number(taille) > PIECE_MAX) return res.status(400).json({ error: 'Fichier de plus de 10 Mo : le Guichet unique le refuserait.' });
  const chemin = stockage.cheminPiece(d.ref, code, nom);
  const moyen = await stockage.urlTeleversement(chemin);
  return res.json({ chemin, ...moyen });
});

router.post('/connecteur/pieces/fichier',
  express.raw({ type: 'application/pdf', limit: PIECE_MAX }),
  async (req, res) => {
    entetesPage(res);
    // Réservé au stockage en mémoire (tests) : en production, le navigateur
    // écrit directement dans le bucket par URL signée.
    if (process.env.CONNECTEUR_STOCKAGE !== 'memoire') return introuvable(res);
    const d = dossierDuJeton(req, res);
    if (!d) return undefined;
    const chemin = String(req.query.chemin || '');
    if (!chemin.startsWith(`${d.ref}/`) || chemin.includes('..')) return res.status(400).json({ error: 'Chemin invalide.' });
    await stockage.ecrire(chemin, req.body);
    return res.json({ ok: true });
  });

router.get('/connecteur/pieces/liste', async (req, res) => {
  entetesPage(res);
  const d = dossierDuJeton(req, res);
  if (!d) return undefined;
  const pieces = await stockage.lister(d.ref);
  return res.json({ pieces: pieces.map((p) => ({ chemin: p.chemin, code: p.code, nom: p.nom, taille: p.taille })) });
});

router.post('/connecteur/pieces/supprimer', async (req, res) => {
  entetesPage(res);
  const d = dossierDuJeton(req, res);
  if (!d) return undefined;
  const chemin = String(req.body?.chemin || '');
  if (!chemin.startsWith(`${d.ref}/`) || chemin.includes('..')) return res.status(400).json({ error: 'Chemin invalide.' });
  await stockage.supprimer([chemin]);
  return res.json({ ok: true });
});

module.exports = router;
