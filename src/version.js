'use strict';

/**
 * Version des fichiers statiques.
 *
 * Un cache navigateur qui sert l'ancien JavaScript après un déploiement rend
 * les nouveautés invisibles, sans le moindre message d'erreur : la page
 * fonctionne, elle est simplement périmée. Plutôt que d'incrémenter un numéro
 * à la main — et de l'oublier — la version est dérivée du contenu réellement
 * servi : empreinte des fichiers de public/, calculée au démarrage.
 *
 * Elle sert à deux choses : suffixer les URL des assets (donc invalider le
 * cache à chaque changement) et permettre à l'interface de détecter qu'une
 * version plus récente est en ligne.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DOSSIER = path.join(__dirname, '..', 'public');
const FICHIERS = ['app.html', 'style.css', 'app.js', 'formalites.js'];

function calculer() {
  // Sur une plateforme de déploiement, le SHA du commit est la source la plus
  // fiable et la moins coûteuse.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 10);

  const empreinte = crypto.createHash('sha1');
  for (const nom of FICHIERS) {
    try {
      empreinte.update(fs.readFileSync(path.join(DOSSIER, nom)));
    } catch (e) {
      empreinte.update(nom); // fichier absent : on ne fait pas échouer le démarrage
    }
  }
  return empreinte.digest('hex').slice(0, 10);
}

const VERSION = calculer();

/**
 * La page d'accueil, URL d'assets suffixées par la version courante.
 *
 * Le gabarit est `public/app.html` et non `public/index.html` : sur une
 * plateforme qui sert d'abord les fichiers statiques, un `index.html` présent
 * dans le dossier publié court-circuiterait la réécriture vers l'application
 * et repartirait sans version.
 */
function pageIndex() {
  const html = fs.readFileSync(path.join(DOSSIER, 'app.html'), 'utf8');
  return html
    .replace(/(href|src)="(style\.css|app\.js|formalites\.js)(\?v=[^"]*)?"/g,
      (_, attr, fichier) => `${attr}="${fichier}?v=${VERSION}"`)
    .replace('</head>', `  <meta name="legalize-version" content="${VERSION}">\n</head>`);
}

module.exports = { VERSION, pageIndex };
