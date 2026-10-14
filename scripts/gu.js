#!/usr/bin/env node
'use strict';

/**
 * Formalités au Guichet unique, en ligne de commande — pour Claude Code.
 *
 *   node scripts/gu.js types
 *   node scripts/gu.js exigences <type | dossier>
 *   node scripts/gu.js fiche <siren>
 *   node scripts/gu.js nouveau <type> [--siren 552100554] [--racine dossiers] [--registre registre.json]
 *   node scripts/gu.js controler <dossier>
 *   node scripts/gu.js enregistrer <dossier> --confirme [--registre registre.json]
 *   node scripts/gu.js statut <identifiant INPI> [--comptes] [--historique]
 *   node scripts/gu.js lister [--statut AMENDMENT_PENDING] [--siren …]
 *   node scripts/gu.js inscrire <registre.json> <dossier>
 *   node scripts/gu.js suivi <registre.json> [--sortie suivi]
 *   node scripts/gu.js etat
 *
 * <dossier> : un répertoire de dossier ou son dossier.json.
 * Sortie : JSON sur la sortie standard ; erreurs en clair sur la sortie d'erreur.
 *
 * Sans identifiants INPI, ou sans INPI_DEPOT_REEL=1, tout tourne en
 * SIMULATION : rien n'est transmis à l'INPI, et la sortie le signale.
 */

const fs = require('fs');
const outils = require('../src/connecteur/outils');
const d = require('../src/gu/dossiers');
const { etat } = require('../src/inpi/config');

function options(args) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const cle = a.slice(2);
      const suivant = args[i + 1];
      if (suivant !== undefined && !suivant.startsWith('--')) { opt[cle] = suivant; i += 1; } else opt[cle] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function exiger(valeur, message) {
  if (!valeur) throw Object.assign(new Error(message), { usage: true });
  return valeur;
}

const COMMANDES = {
  types: () => ({ formalites: outils.formalites() }),

  etat: () => ({ inpi: etat(), mode: outils.modeGuichet() }),

  exigences: ({ pos }) => {
    const cible = exiger(pos[0], 'Préciser un type de formalité ou un dossier.');
    if (fs.existsSync(cible)) {
      const { dossier } = d.lireDossier(cible);
      return outils.exigences(dossier.type, dossier.reponses || {});
    }
    return outils.exigences(cible, {});
  },

  fiche: ({ pos }) => outils.ficheEntreprise(exiger(pos[0], 'Préciser le SIREN.')),

  rechercher: ({ pos }) => outils.rechercherEntreprise(exiger(pos.join(' '), 'Préciser une dénomination ou un SIREN.')),

  nouveau: async ({ pos, opt }) => {
    const r = await d.nouveauDossier({
      type: exiger(pos[0], 'Préciser le type de formalité (voir « types »).'),
      siren: opt.siren, racine: opt.racine || 'dossiers', libelle: opt.libelle,
    });
    if (opt.registre) r.entree_registre = await d.inscrire(opt.registre, r.dossier);
    return r;
  },

  controler: ({ pos }) => d.controlerDossier(exiger(pos[0], 'Préciser le dossier.')),

  enregistrer: async ({ pos, opt }) => {
    const cible = exiger(pos[0], 'Préciser le dossier.');
    const r = await d.enregistrerDossier(cible, { confirme: opt.confirme === true });
    if (r.enregistre && opt.registre) r.entree_registre = await d.inscrire(opt.registre, cible);
    return r;
  },

  statut: ({ pos, opt }) => outils.statutFormalite({
    inpi_id: exiger(pos[0], 'Préciser l’identifiant INPI.'),
    comptes_annuels: Boolean(opt.comptes), historique: Boolean(opt.historique),
  }),

  lister: ({ opt }) => outils.listerFormalites({
    statut: opt.statut, siren: opt.siren, reference: opt.reference,
    maximum: opt.maximum ? Number(opt.maximum) : undefined, comptes_annuels: Boolean(opt.comptes),
  }),

  inscrire: ({ pos }) => d.inscrire(
    exiger(pos[0], 'Préciser le registre (registre.json).'),
    exiger(pos[1], 'Préciser le dossier.'),
  ),

  suivi: ({ pos, opt }) => d.suivi(exiger(pos[0], 'Préciser le registre (registre.json).'), { sortie: opt.sortie || 'suivi' }),
};

async function main() {
  const [commande, ...reste] = process.argv.slice(2);
  const fn = COMMANDES[commande];
  if (!fn) {
    process.stderr.write(`Commandes : ${Object.keys(COMMANDES).join(', ')}\nVoir l’en-tête de scripts/gu.js.\n`);
    process.exit(2);
  }
  try {
    const resultat = await fn(options(reste));
    process.stdout.write(`${JSON.stringify(resultat, null, 2)}\n`);
  } catch (e) {
    const lignes = [e.message || String(e)];
    for (const v of e.detail?.violations || []) lignes.push(`- ${v.propertyPath || '(formalité)'} : ${v.message}`);
    process.stderr.write(`${lignes.join('\n')}\n`);
    process.exit(e.usage ? 2 : 1);
  }
}

if (require.main === module) main();

module.exports = { COMMANDES, options };
