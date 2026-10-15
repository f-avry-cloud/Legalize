'use strict';

/**
 * Textes transmis au guichet : le portail signale « des caractères qui ne
 * sont pas acceptés par nos partenaires » (greffes, INSEE) et ne les
 * transmet pas en l'état (constaté en production : apostrophe typographique,
 * points de suspension, tiret long, retours à la ligne de l'objet social).
 * On les remplace par leur équivalent simple, avant l'envoi.
 */

const EQUIVALENTS = [
  [/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, '\''],
  [/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"'],
  [/\u2026/g, '...'],
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/[\u2022\u2023\u2043\u25AA\u25CF\u25E6\u00B7]/g, '-'],
  [/\u0153/g, 'oe'], [/\u0152/g, 'OE'], [/\u00E6/g, 'ae'], [/\u00C6/g, 'AE'],
  [/\u20AC/g, 'EUR'],
  [/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' '],
];

/** Un texte ramené aux caractères acceptés : latin-1 imprimable, sur une ligne. */
function texteGuichet(s) {
  if (typeof s !== 'string') return s;
  let t = s.normalize('NFC');
  for (const [re, par] of EQUIVALENTS) t = t.replace(re, par);
  return t
    .replace(/\s*[\r\n\t]+\s*/g, ' ')
    // Tout autre caractère hors latin-1 imprimable disparaît.
    .replace(/[^\x20-\x7E\u00A1-\u00FF]/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Contenus binaires ou repris du registre : jamais retouchés.
const INTACTS = new Set(['documentBase64', 'previousFormality']);

/** Copie du corps d'une formalité, chaque texte nettoyé. */
function nettoyerTextes(valeur, cle) {
  if (INTACTS.has(cle)) return valeur;
  if (typeof valeur === 'string') return texteGuichet(valeur);
  if (Array.isArray(valeur)) return valeur.map((v) => nettoyerTextes(v));
  if (valeur && typeof valeur === 'object') {
    return Object.fromEntries(Object.entries(valeur).map(([k, v]) => [k, nettoyerTextes(v, k)]));
  }
  return valeur;
}

module.exports = { texteGuichet, nettoyerTextes };
