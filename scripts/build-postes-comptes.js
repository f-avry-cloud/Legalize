'use strict';

/**
 * Construit src/inpi/data/postes-comptes.json — libellés des postes des comptes
 * annuels saisis, par type de comptes et par page — à partir du texte de la
 * documentation INPI « Accéder aux comptes annuels PDF et saisis » (v5, juin
 * 2025), section E « Postes transmis / Signification des codes cerfa ».
 *
 *   node scripts/build-postes-comptes.js <texte-de-la-documentation.txt>
 */

const fs = require('fs');
const path = require('path');

const lignes = fs.readFileSync(process.argv[2], 'utf8').split('\n').map((l) => l.trim());
const debut = lignes.findIndex((l, i) => i > 100 && /^► Postes transmis/.test(l));
const fin = lignes.findIndex((l, i) => i > debut && /^F\. CODES DE SAISIE/.test(l));

const TYPES = { C: 'Comptes annuels complets', S: 'Comptes annuels simplifiés', K: 'Comptes consolidés', B: 'Comptes annuels de banques', A: 'Comptes annuels d’assurances', AC: 'Comptes annuels agricoles complets', AS: 'Comptes annuels agricoles simplifiés' };
const out = { _source: 'INPI, « Accéder aux comptes annuels PDF et saisis », version 5, juin 2025, section E', types: TYPES, postes: {} };
let type = null; let page = null; let rubrique = null; let attente = '';
const POSTE = /^(.*?)\s*\b([A-Z0-9]{2,3})\s+([1-4](?:\s*-\s*[1-4])*)\s*\*?$/;
for (const brute of lignes.slice(debut, fin)) {
  const l = brute.replace(/\s+/g, ' ');
  if (!l || /^-- \d+ of \d+ --$/.test(l) || /Accéder aux comptes annuels\/ Version/.test(l) || /^Libellé du poste|^m1,m2,m3,m4$|^Colonnes/.test(l)) continue;
  let m = /Type [Bb]ilan = "([A-Z]+)"/.exec(l);
  if (m) { type = m[1]; out.postes[type] = out.postes[type] || {}; page = '*'; out.postes[type][page] = { rubrique: null, codes: {} }; attente = ''; continue; }
  if (/Postes associés aux comptes annuels d.assurance/.test(l)) { type = 'A'; out.postes.A = out.postes.A || {}; page = '*'; out.postes.A[page] = { rubrique: null, codes: {} }; continue; }
  if (/Postes associés/.test(l)) continue;
  m = /^(.*?)= page "(\d+)"/.exec(l);
  if (m && type) { rubrique = m[1].trim(); page = m[2].padStart(2, '0'); out.postes[type][page] = out.postes[type][page] || { rubrique, codes: {} }; attente = ''; continue; }
  if (!type || !page) continue;
  m = POSTE.exec(l);
  // Comptes consolidés : rubriques sans numéro de page (« ACTIF (bilan) »…).
  if (!m && page === '*' && /^[A-ZÉÈ]{4,}/.test(l)) { out.postes[type]['*'].rubrique = l; attente = ''; continue; }
  if (m) {
    const libelle = `${attente} ${m[1]}`.replace(/\s+/g, ' ').trim();
    if (libelle) out.postes[type][page].codes[m[2]] = { libelle, colonnes: m[3].replace(/\s/g, '').split('-').map(Number) };
    attente = '';
  } else {
    attente = `${attente} ${l}`;
  }
}
const cible = path.join(__dirname, '../src/inpi/data/postes-comptes.json');
fs.writeFileSync(cible, `${JSON.stringify(out, null, 1)}\n`);
for (const pages of Object.values(out.postes)) if (pages['*'] && !Object.keys(pages['*'].codes).length) delete pages['*'];
for (const [t, pages] of Object.entries(out.postes)) console.log(t, Object.entries(pages).map(([p, v]) => `${p}:${Object.keys(v.codes).length}`).join(' '));
