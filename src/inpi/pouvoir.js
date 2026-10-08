'use strict';

/**
 * Pouvoir donné au cabinet pour accomplir les formalités (pièce PJ_51).
 *
 * L'application dépose toujours en qualité de mandataire (« mandataire ayant
 * procuration ») : le guichet exige alors ce pouvoir, signé par le
 * représentant légal. Le texte est prérempli à partir du dossier ; le PDF est
 * produit sans bibliothèque externe (texte simple, police standard).
 */

/* ------------------------------------------------------------- texte */

/** Le représentant légal inscrit au registre, ou le premier dirigeant nommé à la création. */
function representantLegal(dossier) {
  const pouvoirs = dossier.fiche?.brut?.formality?.content?.personneMorale?.composition?.pouvoirs || [];
  const rl = pouvoirs.find((p) => p.isRepresentantLegal !== false && !['71', '72', '65'].includes(String(p.roleEntreprise)))
    || pouvoirs[0];
  const { libelleRole } = require('./parcours-creation');
  const { role } = require('./referentiels');
  const qualite = (code) => libelleRole(code) || role(String(code || ''))?.libelle || 'représentant légal';
  if (rl?.entreprise) {
    // Dirigeant qui change lui-même de dénomination dans ce dossier : il signe sous la nouvelle.
    const ancien = rl.entreprise.denomination;
    const rang = (dossier.typologie?.mises_a_jour || []).findIndex((m) => String(m?.nom || '').trim().toLowerCase() === String(ancien || '').trim().toLowerCase());
    const nouveau = rang >= 0 ? dossier.reponses?.MAJDIR?.[`maj_${rang}`]?.denomination : null;
    const nom = nouveau && nouveau !== ancien ? `${nouveau} (anciennement ${ancien})` : ancien;
    return { nom, qualite: qualite(rl.roleEntreprise), morale: true };
  }
  if (rl?.individu) {
    const d = rl.individu.descriptionPersonne || {};
    return { nom: `${(d.prenoms || []).join(' ')} ${d.nom || ''}`.trim(), qualite: qualite(rl.roleEntreprise) };
  }
  // Création : le premier dirigeant déclaré dans le parcours.
  const e = (dossier.typologie?.entrants || []).find((x) => x?.nom);
  return e ? { nom: e.nom, qualite: qualite(e.fonction), morale: e.nature === 'PM' } : { nom: '', qualite: 'représentant légal' };
}

function societe(dossier) {
  const f = dossier.fiche || {};
  if (f.denomination) {
    return {
      denomination: f.denomination, forme: f.forme_juridique || '', capital: f.capital,
      siege: f.adresse?.texte || '', siren: f.siren_formate || f.siren || '', greffe: f.greffe || '',
    };
  }
  const s = dossier.reponses?.c_societe || {};
  const a = dossier.reponses?.c_siege?.adresse_siege || {};
  const { forme } = require('./parcours-creation');
  return {
    denomination: s.denomination || '[dénomination]', forme: forme(dossier.typologie)?.libelle || '', capital: s.capital,
    siege: [a.numVoie, a.typeVoie, a.voie, a.codePostal, a.commune].filter(Boolean).join(' '), siren: '', greffe: '', enFormation: true,
  };
}

/** Les paragraphes du pouvoir. */
function texte(dossier, { mandataire = {}, operations = [] } = {}) {
  const s = societe(dossier);
  const rl = representantLegal(dossier);
  const capital = s.capital ? ` au capital de ${Number(s.capital).toLocaleString('fr-FR')} euros` : '';
  const identification = s.enFormation
    ? `de la société ${s.denomination}, ${s.forme}${capital} en cours de constitution, dont le siège sera ${s.siege}`
    : `de la société ${s.denomination}, ${s.forme}${capital}, dont le siège est ${s.siege}, immatriculée sous le numéro ${s.siren}${s.greffe ? ` au RCS de ${s.greffe}` : ''}`;
  const signataire = rl.morale
    ? `La société ${rl.nom || '[représentant légal]'}, représentée par [nom du représentant], agissant en qualité de ${rl.qualite.toLowerCase()}`
    : `${rl.nom || '[nom du représentant légal]'}, agissant en qualité de ${rl.qualite.toLowerCase()}`;
  return [
    { titre: 'POUVOIR' },
    `${signataire} ${identification},`,
    `donne pouvoir à ${mandataire.nom || '[nom du mandataire]'}${mandataire.adresse ? `, ${mandataire.adresse}` : ''},`,
    'à l\'effet d\'accomplir, au nom et pour le compte de la société, auprès du guichet unique des formalités des entreprises (INPI) et de tout organisme destinataire, les formalités suivantes :',
    ...operations.map((o) => `- ${o}`),
    'et, à cette fin, de remplir et signer toute déclaration, déposer toutes pièces, acquitter tous frais, répondre à toute demande de régularisation et, plus généralement, faire le nécessaire.',
    '',
    'Fait à ____________________, le ____________________',
    '',
    'Signature, précédée de la mention manuscrite « Bon pour pouvoir » :',
  ];
}

/* --------------------------------------------------------------- PDF */

// Caractères hors WinAnsi remplacés par un équivalent lisible.
const EQUIVALENTS = { '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ', ' ': ' ', 'œ': 'oe', 'Œ': 'OE' };

function enLatin1(t) {
  return Buffer.from(String(t).replace(/[’‘“”–—…  œŒ]/g, (c) => EQUIVALENTS[c]).replace(/[^\x00-\xff]/g, '?'), 'latin1');
}

function echapper(buffer) {
  let out = '';
  for (const b of buffer) {
    const c = String.fromCharCode(b);
    out += c === '(' || c === ')' || c === '\\' ? `\\${c}` : (b < 32 || b > 126 ? `\\${b.toString(8).padStart(3, '0')}` : c);
  }
  return out;
}

/** Découpe un paragraphe en lignes d'environ `largeur` caractères. */
function couper(t, largeur) {
  const lignes = [];
  let l = '';
  for (const mot of String(t).split(/\s+/)) {
    if ((`${l} ${mot}`).trim().length > largeur) { if (l) lignes.push(l); l = mot; } else l = (`${l} ${mot}`).trim();
  }
  lignes.push(l);
  return lignes;
}

/** PDF A4 d'une ou plusieurs pages, texte en Helvetica. */
function pdf(paragraphes) {
  const pages = [[]];
  let y = 770;
  const ecrire = (ligne, taille, gras) => {
    if (y < 70) { pages.push([]); y = 770; }
    pages[pages.length - 1].push(`BT /${gras ? 'F2' : 'F1'} ${taille} Tf 60 ${y} Td (${echapper(enLatin1(ligne))}) Tj ET`);
    y -= taille + 5;
  };
  for (const p of paragraphes) {
    if (p && p.titre) { ecrire(p.titre, 16, true); y -= 14; continue; }
    if (!p) { y -= 10; continue; }
    for (const l of couper(p, 88)) ecrire(l, 11, false);
    y -= 7;
  }
  const objets = [];
  const ajouter = (o) => { objets.push(o); return objets.length; };
  const catalogue = ajouter(null);
  const racinePages = ajouter(null);
  const f1 = ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = ajouter('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = pages.map((contenu) => {
    const flux = contenu.join('\n');
    const c = ajouter(`<< /Length ${Buffer.byteLength(flux, 'latin1')} >>\nstream\n${flux}\nendstream`);
    return ajouter(`<< /Type /Page /Parent ${racinePages} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`);
  });
  objets[catalogue - 1] = `<< /Type /Catalog /Pages ${racinePages} 0 R >>`;
  objets[racinePages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const positions = [];
  objets.forEach((o, i) => { positions.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objets.length + 1} /Root ${catalogue} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function genererPouvoir(dossier, options) {
  return pdf(texte(dossier, options));
}

module.exports = { genererPouvoir, texte, representantLegal };
