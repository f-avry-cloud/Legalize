'use strict';

/**
 * Diagnostic des accès INPI en ligne de commande, sans rien déposer.
 *
 * L'INPI ne délivrant pas de clé d'API, la seule façon de vérifier une
 * configuration est de tenter une connexion, puis une lecture. Ce script fait
 * les deux, sur les deux API, et explique chaque échec.
 *
 *   npm run inpi:test
 *   node scripts/inpi-connexion.js --siren 552100554
 */

const { diagnostiquerTout } = require('../src/inpi/diagnostic');

const args = process.argv.slice(2);
const siren = args.includes('--siren') ? args[args.indexOf('--siren') + 1] : undefined;

const vert = (t) => `\x1b[32m${t}\x1b[0m`;
const rouge = (t) => `\x1b[31m${t}\x1b[0m`;
const gris = (t) => `\x1b[90m${t}\x1b[0m`;

function ligne(etape, resultat) {
  if (!resultat) return;
  const puce = resultat.ok ? vert('✓') : rouge('✗');
  console.log(`  ${puce} ${etape.padEnd(11)} ${resultat.message}`);
  if (resultat.cause) console.log(`    ${gris(resultat.cause)}`);
}

(async () => {
  const d = await diagnostiquerTout({ siren });

  console.log('\nDiagnostic des accès INPI');
  console.log(gris(`Mode RNE : ${d.etat.rne.mode} · Mode guichet unique : ${d.etat.guichet.mode} `
    + `(environnement ${d.etat.guichet.environnement}) · dépôt réel `
    + `${d.etat.guichet.depotReelAutorise ? 'AUTORISÉ' : 'désactivé'}`));

  for (const api of [d.rne, d.guichet]) {
    console.log(`\n${api.libelle}\n${'─'.repeat(api.libelle.length)}`);
    console.log(`  hôte        ${api.hote}`);
    console.log(`  compte      ${api.compte || '—'}`);
    ligne('connexion', api.connexion);
    ligne('lecture', api.lecture);
  }

  console.log(`\n${d.ok ? vert('Les deux accès fonctionnent.') : rouge('Au moins un accès est en échec (détail ci-dessus).')}`);
  if (d.ok && !d.etat.guichet.depotReelAutorise) {
    console.log(gris('Le dépôt réel reste désactivé : ajouter INPI_DEPOT_REEL=1 pour l’autoriser.'));
  }
  console.log();
  process.exitCode = d.ok ? 0 : 1;
})();
