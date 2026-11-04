'use strict';

/**
 * Synthèses du Guichet unique : lecture, anonymisation, statistiques.
 *
 * Les synthèses sont fabriquées ici, avec la mise en page du guichet (libellés
 * à gauche, valeurs à droite alignées sur la dernière ligne du libellé, titres
 * plus grands et tracés deux fois) et des personnes et sociétés fictives :
 * aucune vraie synthèse n'est utilisée. Un PDF minimal est généré pour la
 * lecture de bout en bout, puis le programme du corpus est lancé sur un
 * dossier temporaire.
 *
 *   node scripts/test-synthese-gu.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const s = require('../src/inpi/synthese-gu');

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Mise en page fictive, à l'image des synthèses du guichet
// ---------------------------------------------------------------------------

const X_LIB = 52.8;
const X_VAL = 174.6;
const CORPS = 8.4;
const INTERLIGNE = 10.2;

/** Modèle du guichet observé ; une variante (colonne, tailles) simule une autre version du modèle. */
const MODELE = { xVal: X_VAL, corps: CORPS, titre1: 10.8, titre2: 9.6, interligne: INTERLIGNE, entete: 'Synthèse de dépôt au Guichet Unique', pied: null };

function composer({ liasse, nature = 'principale', date, contenu }, modele = MODELE) {
  const { xVal, corps, titre1, titre2, interligne, entete = MODELE.entete, pied = null } = modele;
  const elements = [];
  let page = 1;
  let y = 735;
  const pose = (x, yy, h, texte, gras = false) => {
    elements.push({ page, x, y: yy, h, w: 0, s: texte });
    if (gras) elements.push({ page, x: x - 0.3, y: yy, h, w: 0, s: texte });
  };
  const intro = corps + 1.8;
  pose(200, 805, intro, 'GUICHET UNIQUE DES ENTREPRISES');
  pose(230, 790, intro, nature === 'beneficiaires' ? 'Synthèse de dépôt des bénéficiaires effectifs' : 'Synthèse de dépôt', true);
  pose(60, 775, intro, 'Ce document récapitule les informations contenues dans la formalité');
  pose(400, 775, intro, liasse, true);
  pose(470, 775, intro, 'concernant la société');
  pose(60, 763, intro, 'EXEMPLE FICTIF', true);
  pose(140, 763, intro, 'à la');
  pose(160, 763, intro, 'date du');
  pose(200, 763, intro, date, true);
  for (const b of contenu) {
    if (b.saut) { page += 1; y = 790; continue; }
    if (b.titre) {
      // Gras du générateur : la ligne entière est tracée, puis retracée 0,3 pt plus à gauche.
      const h = b.niveau === 2 ? titre2 : titre1;
      for (const decalage of [0, -0.3]) {
        let x = X_LIB + decalage;
        for (const m of [].concat(b.titre)) { pose(x, y, h, m); x += m.length * 5.5 + 3; }
      }
      y -= 22;
      continue;
    }
    if (b.mention) { pose(X_LIB, y, corps, b.mention, true); y -= 18; continue; }
    const lib = [].concat(b.libelle);
    const val = [].concat(b.valeur ?? []).filter((v) => v !== '');
    const n = Math.max(lib.length, val.length, 1);
    const bas = y - (n - 1) * interligne;
    // Alignement de la ligne du tableau : en bas (modèle observé) ou en haut (valeur qui déborde vers le bas).
    const haut = b.aligne === 'haut';
    const yLib = (i) => (haut ? y - i * interligne : bas + (lib.length - 1 - i) * interligne);
    const yVal = (i) => (haut ? y - i * interligne : bas + (val.length - 1 - i) * interligne);
    lib.forEach((t, i) => pose(X_LIB, yLib(i), corps, t));
    pose(X_LIB + lib[lib.length - 1].length * 4.2 + 3, yLib(lib.length - 1), corps, ':');
    val.forEach((t, i) => pose(xVal, yVal(i), corps, t));
    y = bas - 20;
    if (y < 60) throw new Error(`page ${page} trop pleine : ajouter un saut de page`);
  }
  for (let p = 1; p <= page; p += 1) {
    elements.push({ page: p, x: X_LIB, y: 815, h: corps, w: 0, s: entete });
    elements.push({ page: p, x: 448.3, y: 815, h: corps, w: 0, s: `Formalité ${liasse}` });
    elements.push({ page: p, x: 448.3, y: 25, h: corps - 0.4, w: 0, s: `Page ${p}/${page}` });
    if (pied) elements.push({ page: p, x: X_LIB, y: 40, h: corps - 0.4, w: 0, s: pied });
  }
  return elements;
}

/** PDF minimal (Helvetica, WinAnsi) reproduisant les éléments à leur position. */
function pdfDepuisElements(elements) {
  const speciaux = { '€': 0x80, '’': 0x92, 'œ': 0x9c, '–': 0x96 };
  const enc = (texte) => [...texte].map((ch) => {
    const c = speciaux[ch] ?? ch.codePointAt(0);
    const car = String.fromCharCode(c < 256 ? c : 0x3f);
    return car === '\\' || car === '(' || car === ')' ? `\\${car}` : car;
  }).join('');
  const nbPages = Math.max(...elements.map((e) => e.page));
  const objets = [];
  objets[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objets[2] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  const kids = [];
  for (let p = 1; p <= nbPages; p += 1) {
    const flux = elements.filter((e) => e.page === p)
      .map((e) => `BT /F1 ${e.h} Tf 1 0 0 1 ${e.x} ${e.y} Tm (${enc(e.s)}) Tj ET`).join('\n');
    const nPage = 4 + (p - 1) * 2;
    kids.push(`${nPage} 0 R`);
    objets[nPage - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${nPage + 1} 0 R >>`;
    objets[nPage] = `<< /Length ${flux.length} >>\nstream\n${flux}\nendstream`;
  }
  objets[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${nbPages} >>`;
  let pdf = '%PDF-1.4\n';
  const positions = [];
  objets.forEach((o, i) => { positions.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${positions.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// ---------------------------------------------------------------------------
// Dossiers fictifs
// ---------------------------------------------------------------------------

const L1 = 'J00000000001';
const L2 = 'J00000000002';

const resume = ({ type, forme, depot, liasse }) => [
  { titre: 'Résumé de votre formalité' },
  { libelle: 'Référence client', valeur: 'DUPONT/ESSAI' },
  { libelle: 'Type de formalité', valeur: type },
  { libelle: 'Forme juridique', valeur: forme },
  { libelle: ["Extension d'une entreprise", 'étrangère'], valeur: 'Non' },
  { libelle: 'Date de dépôt', valeur: depot },
  { libelle: 'Numéro de liasse', valeur: liasse },
];

/** Création de SAS ; la version 2 est signée, payée, et porte un capital différent. */
function creation(version, modele = MODELE) {
  const v2 = version === 2;
  return composer({
    liasse: L1,
    date: v2 ? '9 janvier 2024' : '3 janvier 2024',
    contenu: [
      ...resume({ type: 'Création', forme: 'SAS, société par actions simplifiée', depot: '03/01/2024', liasse: L1 }),
      { titre: 'Informations complémentaires' },
      { libelle: ['Traitement de la formalité', 'par'], valeur: 'TCO DE PARIS' },
      ...(v2 ? [
        { libelle: 'Numéro national', valeur: 'ENT24-000000001' },
        { libelle: 'Document signé', valeur: 'Oui' },
        { libelle: 'Nom signataire', valeur: 'DURAND' },
        { libelle: 'Courriel du signataire', valeur: 'durand@exemple.test' },
      ] : []),
      { titre: "Identité de l'entreprise" },
      { libelle: 'Dénomination', valeur: 'EXEMPLE FICTIF' },
      { libelle: 'Forme juridique', valeur: 'SAS, société par actions simplifiée' },
      { libelle: ['Principales activités de', "l'objet social"], valeur: ['Conseil en essais fictifs, formation', 'et toute activité connexe.'] },
      { libelle: 'Montant capital', valeur: v2 ? '5 000,00€' : '3 000,00€' },
      { saut: true },
      { titre: 'Publication Légale' },
      { libelle: 'Journal de publication', valeur: 'Gazette Fictive' },
      { libelle: 'Date de publication', valeur: '02/01/2024' },
      { titre: ['Composition', '- Président de SAS', '- DUPONT Jean'] },
      { libelle: ['Situation de ce dirigeant', 'dans le cadre de cette', 'formalité'], valeur: 'Ajout' },
      { titre: 'Description du mandat', niveau: 2 },
      { libelle: "Rôle pour l'entreprise", valeur: 'Président de SAS' },
      { libelle: 'Type de personne', valeur: 'Personne Physique' },
      { libelle: 'Bénéficiaire effectif', valeur: 'Oui' },
      { titre: "Description du mandataire agissant pour le compte de l'entreprise", niveau: 2 },
      { libelle: 'Nom de Naissance', valeur: 'DUPONT' },
      { libelle: 'Prénom', valeur: 'Jean, Marcel' },
      { libelle: 'Date de naissance', valeur: '01/02/1980' },
      { libelle: 'Commune de naissance', valeur: 'Lyon' },
      { libelle: 'Nationalité', valeur: 'Française' },
      { libelle: 'Adresse', valeur: '12 RUE DES ESSAIS 75001 PARIS FRANCE' },
      { libelle: 'Téléphone', valeur: '0601020304' },
      { saut: true },
      { titre: 'Pièces jointes' },
      { titre: 'Pièces jointes déposées pour traitement', niveau: 2 },
      { libelle: ['Nombre de pièces jointes', 'déposées'], valeur: v2 ? '5' : '3' },
      { libelle: ['Intitulé de la pièce jointe', 'demandée'], valeur: ['Statuts, paraphé, daté et signé par tous les', 'associés'] },
      { libelle: 'Nom du fichier', valeur: 'STATUTS_DUPONT.pdf' },
      { libelle: ['Intitulé de la pièce jointe', 'demandée'], valeur: "Justificatif d'identité du dirigeant" },
      { libelle: 'Nom du fichier', valeur: 'CNI_JEAN_DUPONT.pdf' },
      { libelle: ['Intitulé de la pièce jointe', 'demandée'], valeur: '' },
      { libelle: 'Nom du fichier', valeur: `Document_de_Synthese_${L1}_v1.pdf` },
      ...(v2 ? [
        { libelle: ['Intitulé de la pièce jointe', 'demandée'], valeur: '' },
        { libelle: 'Nom du fichier', valeur: 'Recu_de_paiement_1234567.pdf' },
        { libelle: ['Intitulé de la pièce jointe', 'demandée'], valeur: '' },
        { libelle: 'Nom du fichier', valeur: 'C0002A0082L159907D20240105H140026TPIJTES002PINPI.pdf' },
      ] : []),
      { titre: 'Observations' },
      { libelle: 'Observations', valeur: ["Merci d'adresser le Kbis à Maître DUPONT,", 'durand@exemple.test'] },
      ...(v2 ? [{ libelle: 'Diffusion INSEE', valeur: 'Oui' }] : []),
    ],
  }, modele);
}

function beneficiaires() {
  return composer({
    liasse: L1,
    nature: 'beneficiaires',
    date: '3 janvier 2024',
    contenu: [
      ...resume({ type: 'Création', forme: 'SAS, société par actions simplifiée', depot: '03/01/2024', liasse: L1 }),
      { titre: 'Bénéficiaires effectifs' },
      { libelle: ['Nombre de bénéficiaires', 'effectifs déclarés'], valeur: '1' },
      { titre: ['Bénéficiaires effectifs', '- DUPONT Jean'], niveau: 2 },
      { libelle: 'Nom de Naissance', valeur: 'DUPONT' },
      { libelle: 'Date de naissance', valeur: '01/02/1980' },
      { titre: 'Modalités de contrôle', niveau: 2 },
      { libelle: ["Moyen d'exercice du", 'pouvoir'], valeur: ['Détention de plus de 25% du capital ou du', 'droit de vote'] },
      { libelle: 'Détention du capital', valeur: '33.33%' },
      { libelle: 'Détention directe capital', valeur: 'Oui' },
    ],
  });
}

const MENTION = 'La modification effectuée ne porte pas sur le ou les représentants dont les données sont inchangées.';

function modification() {
  return composer({
    liasse: L2,
    date: '5 février 2024',
    contenu: [
      ...resume({ type: 'Modification', forme: 'SARL, société à responsabilité limitée', depot: '05/02/2024', liasse: L2 }),
      { titre: 'Liste des modifications signalées' },
      { titre: "En lien avec l'identité de l'entreprise", niveau: 2 },
      { libelle: ['Je souhaite déclarer la prise', "ou la reprise d'activité de", 'ma société'], valeur: 'Oui' },
      { titre: 'Composition' },
      { mention: MENTION },
      { libelle: ['Nombre de pouvoirs', 'définis'], valeur: '0' },
      { titre: ['Etablissements', '- 00016'] },
      { libelle: ["Rôle de l'établissement pour", "l'entreprise"], valeur: 'Siège et établissement principal' },
      { titre: "Description de l'activité numéro 1", niveau: 2 },
      { libelle: ['Catégorisation niveau 1 de', "l'activité"], valeur: 'Activités de services' },
      { libelle: "Type d'origine", valeur: 'Achat' },
      { saut: true },
      { titre: 'Pièces jointes' },
      { libelle: ['Intitulé de la pièce jointe', 'demandée'], valeur: "Attestation de parution de l'avis de modification" },
      { libelle: 'Nom du fichier', valeur: 'jal_dupont.pdf' },
      { libelle: ['Intitulé de la pièce jointe', 'demandée'], valeur: '' },
      { libelle: 'Nom du fichier', valeur: 'RECEPISSE_ESSAI.pdf' },
    ],
  });
}

const PERSONNEL = [
  'DUPONT', 'Dupont', 'Jean', 'Marcel', 'DURAND', '1980', '0601020304', 'exemple.test', 'RUE DES ESSAIS', 'Lyon',
  'STATUTS_', 'CNI_', 'jal_', L1, L2, 'ENT24', 'Conseil en essais', 'EXEMPLE FICTIF', '02/01/2024', '03/01/2024', 'DUPONT/ESSAI',
];
const fuites = (texte) => PERSONNEL.filter((t) => texte.includes(t));

const rubrique = (a, libelle) => a.rubriques.find((r) => r.libelle === libelle);

async function main() {
  // -------------------------------------------------------------------------
  console.log('Lecture de la mise en page');
  const a1 = s.analyserElements(creation(1));
  const a2 = s.analyserElements(creation(2));
  const b = s.analyserElements(beneficiaires());
  const c = s.analyserElements(modification());

  verifier('liasse, nature et date de la synthèse', a1.liasse === L1 && a1.nature === 'principale' && a1.date_synthese === '2024-01-03' && a1.est_synthese, { liasse: a1.liasse, nature: a1.nature, date: a1.date_synthese });
  verifier('synthèse des bénéficiaires effectifs reconnue', b.nature === 'beneficiaires' && b.liasse === L1);
  verifier('libellé sur deux lignes recollé', rubrique(a1, "Extension d'une entreprise étrangère")?.valeur === 'Non', a1.rubriques.slice(0, 6));
  verifier('libellé sur trois lignes recollé', rubrique(a1, 'Situation de ce dirigeant dans le cadre de cette formalité')?.valeur === 'Ajout');
  verifier('valeur sur deux lignes recollée', rubrique(a1, "Principales activités de l'objet social")?.valeur === 'Conseil en essais fictifs, formation et toute activité connexe.');
  verifier('titre de niveau 1 avec rôle et nom', a1.titres.some((t) => t.niveau === 1 && t.texte === 'Composition - Président de SAS - DUPONT Jean'), a1.titres);
  verifier('titre de niveau 2', a1.titres.some((t) => t.niveau === 2 && t.texte === 'Description du mandat'));
  const role = rubrique(a1, "Rôle pour l'entreprise");
  verifier('rubrique rangée sous son bloc et sa section', role?.bloc === 'Description du mandat' && role?.section === 'Composition - Président de SAS - DUPONT Jean', role);
  const texteA1 = JSON.stringify([a1.rubriques, a1.mentions]);
  verifier('en-têtes et pieds de page écartés', !/Page \d|Guichet Unique|Formalité J/.test(texteA1));
  verifier('aucune mention parasite dans la création', a1.mentions.length === 0, a1.mentions);
  const pj = s.piecesJointes(a2.rubriques);
  verifier('pièces jointes : intitulé sur deux lignes et nom du fichier', pj.length === 5 && pj[0].intitule === 'Statuts, paraphé, daté et signé par tous les associés' && pj[0].fichier === 'STATUTS_DUPONT.pdf', pj);
  verifier('origine des pièces : déposant, guichet, greffe', JSON.stringify(pj.map((p) => s.originePiece(p.fichier))) === JSON.stringify(['deposant', 'deposant', 'guichet', 'guichet', 'greffe']));
  verifier('phrase en gras : mention, pas début de libellé', c.mentions.some((m) => m.texte === MENTION) && rubrique(c, 'Nombre de pouvoirs définis')?.valeur === '0', { mentions: c.mentions, r: c.rubriques.map((r) => r.libelle) });

  // -------------------------------------------------------------------------
  console.log('Indépendance envers la version du modèle du guichet');
  verifier('mise en page mesurée : texte 8,4 pt, colonne des valeurs à 174,5 pt, aucune ligne hors rubrique',
    a1.lecture.corps === 8.4 && a1.lecture.colonne_valeur === 174.5 && a1.lecture.orphelines === 0 && a1.lecture.sans_libelle === 0 && a1.lecture.rubriques === a1.rubriques.length, a1.lecture);
  const VARIANTE = { xVal: 210, corps: 9, titre1: 11.4, titre2: 10.2, interligne: 11 };
  const variante = s.analyserElements(creation(1, VARIANTE));
  const essentiel = (a) => JSON.stringify({ r: a.rubriques.map((r) => [r.bloc, r.libelle, r.valeur]), t: a.titres.map((t) => [t.niveau, t.texte]), m: a.mentions.map((m) => m.texte) });
  verifier('autre version du modèle (colonne à 210 pt, texte 9 pt, titres 10,2 et 11,4 pt) : même lecture', essentiel(variante) === essentiel(a1) && variante.lecture.colonne_valeur === 210 && variante.lecture.corps === 9,
    { lecture: variante.lecture, rubriques: variante.rubriques.slice(0, 4) });
  verifier('lecture douteuse signalée : colonne inhabituelle, ligne hors rubrique, trop peu de rubriques',
    !s.lectureDouteuse(a1.lecture, 174.5) && s.lectureDouteuse(variante.lecture, 174.5)
    && s.lectureDouteuse({ ...a1.lecture, orphelines: 1 }, 174.5) && s.lectureDouteuse({ ...a1.lecture, rubriques: 4 }, 174.5));

  // Modèle récent : en-tête « Synthèse définitive », valeur qui déborde vers le bas
  // (référence client sur deux lignes), libellé sur deux lignes aligné en haut.
  const recente = s.analyserElements(composer({
    liasse: 'J00000000009',
    date: '1 mars 2026',
    contenu: [
      { titre: 'Résumé de votre formalité' },
      { libelle: 'Référence client', valeur: ['TA/ESSAI', 'NOMCLIENT SUITE'], aligne: 'haut' },
      { libelle: 'Type de formalité', valeur: 'Création' },
      { libelle: ['Reliée à une entreprise', 'agricole'], valeur: 'Non', aligne: 'haut' },
      { libelle: 'Entreprise agricole', valeur: 'Non' },
      { libelle: 'Numéro de liasse', valeur: 'J00000000009' },
    ],
  }, { ...MODELE, entete: 'Synthèse définitive au Guichet Unique' }));
  verifier('valeur débordant vers le bas : rattachée à sa rubrique, la suivante intacte',
    rubrique(recente, 'Référence client')?.valeur === 'TA/ESSAI NOMCLIENT SUITE' && rubrique(recente, 'Type de formalité')?.valeur === 'Création'
    && rubrique(recente, 'Reliée à une entreprise agricole')?.valeur === 'Non' && recente.lecture.orphelines === 0, recente.rubriques);
  verifier('en-tête « Synthèse définitive » écarté, synthèse reconnue', recente.est_synthese && !JSON.stringify(recente.rubriques).includes('définitive'));
  const pied = s.analyserElements(creation(1, { ...MODELE, pied: 'Document édité par le guichet' }));
  verifier('pied de page répété sur chaque page écarté', essentiel(pied) === essentiel(a1), pied.mentions);

  // -------------------------------------------------------------------------
  console.log('Anonymisation');
  const sel = 'sel-de-test';
  const f1 = s.anonymiser(a1, { sel });
  const f2 = s.anonymiser(a2, { sel });
  const fb = s.anonymiser(b, { sel });
  const fc = s.anonymiser(c, { sel });
  const tout = JSON.stringify([f1, f2, fb, fc]);
  verifier('aucune donnée personnelle ni numéro dans les fiches', fuites(tout).length === 0, fuites(tout));
  const val = (f, k) => f.champs.find((x) => x.cle === k)?.valeur;
  verifier('type, forme, greffe et mois de dépôt conservés', f1.type === 'Création' && f1.forme === 'SAS, société par actions simplifiée' && f1.greffe === 'TCO DE PARIS' && f1.mois === '2024-01', { type: f1.type, forme: f1.forme, greffe: f1.greffe, mois: f1.mois });
  verifier('valeurs de liste conservées', val(f1, "Description du mandat › Rôle pour l'entreprise") === 'Président de SAS'
    && val(f1, 'Publication Légale › Journal de publication') === 'Gazette Fictive'
    && val(f1, 'Composition › Situation de ce dirigeant dans le cadre de cette formalité') === 'Ajout');
  verifier('capital en tranche, date de dépôt au mois', val(f1, "Identité de l'entreprise › Montant capital") === '1 000 à 9 999 €' && val(f1, 'Résumé de votre formalité › Date de dépôt') === '2024-01');
  verifier('données personnelles réduites à leur présence', f1.champs.find((x) => x.cle.endsWith('› Nom de Naissance'))?.renseigne === true
    && f1.champs.find((x) => x.cle.endsWith('› Nom de Naissance'))?.valeur === undefined);
  verifier('titres sans la partie nominative', f1.sections.includes('Composition') && !f1.sections.some((t) => /DUPONT|Président/.test(t)), f1.sections);
  verifier('pourcentage de détention en tranche, mode de contrôle conservé', val(fb, 'Modalités de contrôle › Détention du capital') === '25 à 50 %'
    && val(fb, "Modalités de contrôle › Moyen d'exercice du pouvoir") === 'Détention de plus de 25% du capital ou du droit de vote');
  verifier('modification déclarée relevée', JSON.stringify(fc.modifications) === JSON.stringify(["En lien avec l'identité de l'entreprise › Je souhaite déclarer la prise ou la reprise d'activité de ma société"]), fc.modifications);
  verifier('numéro d’établissement retiré du titre', fc.sections.includes('Etablissements') && fc.champs.some((x) => x.cle.startsWith("Description de l'activité numéro N ›")));
  verifier('pseudonyme : même formalité, même pseudonyme ; autre exécution, autre pseudonyme', f1.doc === fb.doc && /^[0-9a-f]{12}$/.test(f1.doc) && s.anonymiser(a1, { sel: 'autre' }).doc !== f1.doc);
  verifier('pièces : intitulé et origine seulement', JSON.stringify(f2.pieces) === JSON.stringify([
    { intitule: 'Statuts, paraphé, daté et signé par tous les associés', origine: 'deposant' },
    { intitule: "Justificatif d'identité du dirigeant", origine: 'deposant' },
    { intitule: null, origine: 'guichet' }, { intitule: null, origine: 'guichet' }, { intitule: null, origine: 'greffe' },
  ]), f2.pieces);
  verifier('nom propre repéré dans un texte libre', s.semblePersonnel('Maître DUPONT') && s.semblePersonnel('né le 01/02/1980') && !s.semblePersonnel(MENTION) && !s.semblePersonnel('Régime TVA des SAS'));
  verifier('titre nominatif masqué', s.titrePublic('DUPONT Jean') === '[titre masqué]' && s.titrePublic("Description de l'activité numéro 2") === "Description de l'activité numéro N");

  // -------------------------------------------------------------------------
  console.log('Règle de fréquence pour les rubriques inconnues');
  const analyseCessation = (i, motif) => ({
    liasse: `J1000000${String(i).padStart(4, '0')}`, nature: 'principale', date_synthese: '2024-03-01', titres: [], mentions: [], lecture: null,
    rubriques: [
      { section: 'Résumé de votre formalité', bloc: 'Résumé de votre formalité', libelle: 'Type de formalité', valeur: 'Cessation' },
      { section: 'Cessation', bloc: 'Cessation', libelle: 'Motif de la cessation', valeur: motif },
      { section: 'Cessation', bloc: 'Cessation', libelle: 'Nom du déclarant', valeur: 'DURAND' },
      { section: 'Cessation', bloc: 'Cessation', libelle: 'Genre', valeur: 'Masculin' },
      { section: 'Cessation', bloc: 'Cessation', libelle: 'Destination du fonds', valeur: `vente au repreneur ${i}` },
    ],
  });
  const fichesCessation = Array.from({ length: 25 }, (_, i) => s.anonymiser(analyseCessation(i, i === 0 ? 'Motif très rare' : 'Dissolution anticipée'), { sel }));
  const rendues = s.retenirValeursFrequentes(fichesCessation, { seuil: 20 });
  const motifs = fichesCessation.map((f) => f.champs.find((x) => x.cle === 'Cessation › Motif de la cessation'));
  verifier('valeur inconnue présente dans 24 formalités (seuil 20) : rendue ; valeur rare : présence seulement',
    motifs.filter((m) => m.valeur === 'Dissolution anticipée').length === 24 && motifs[0].valeur === undefined && motifs[0].renseigne === true && rendues === 24, motifs.slice(0, 2));
  verifier('jamais de valeur pour un nom ou le genre, même présents partout ; valeur unique effacée ; aucune candidate laissée',
    !/DURAND|Masculin|repreneur|_candidat|Motif très rare/.test(JSON.stringify(fichesCessation)));
  verifier('seuil de fréquence par défaut : 3 formalités', s.SEUIL_FREQUENCE === 3);

  // Garde-fou indépendant de la lecture : ce qui ne revient pas dans 3 formalités est masqué.
  const fiche = (doc, type, champs, autres = {}) => ({
    doc, nature: 'principale', type, forme: 'SAS', greffe: 'TCO DE PARIS', modifications: [], sections: ['Identité'],
    champs, pieces: [{ intitule: 'Statuts', origine: 'deposant' }], mentions: [], versions: { nombre: 1, rubriques_modifiees: [] }, ...autres,
  });
  const corpus = [
    ...['a', 'b', 'c', 'd'].map((d) => fiche(d, 'Création', [{ cle: 'Identité › Forme juridique', valeur: 'SAS' }, { cle: 'Publication › Journal de publication', valeur: d === 'a' ? 'Journal unique' : 'Gazette' }])),
    fiche('e', 'NOMCLIENT Création', [{ cle: 'Identité › 16 Rue Exemple Adresse du siège', renseigne: true }, { cle: 'Inconnu Total › Libellé', valeur: 'X' }]),
  ];
  const bilanMasquage = s.masquerRares(corpus, { seuil: 3 });
  verifier('type, rubrique et valeur rares masqués ; rubriques et valeurs fréquentes conservées',
    corpus[4].type === '[rare]' && corpus[4].champs[0].cle === 'Identité › [rubrique rare]' && corpus[4].champs[1].cle === '[bloc rare] › [rubrique rare]'
    && corpus[0].champs[1].valeur === undefined && corpus[0].champs[1].renseigne === true && corpus[1].champs[1].valeur === 'Gazette'
    && corpus[0].champs[0].valeur === 'SAS' && corpus[0].type === 'Création', { corpus: corpus.map((f) => [f.type, f.champs]), bilanMasquage });
  verifier('bilan du masquage', bilanMasquage.rubriques === 2 && bilanMasquage.valeurs === 2 && bilanMasquage.autres === 1, bilanMasquage);

  // -------------------------------------------------------------------------
  console.log('Versions');
  const modifiees = s.rubriquesModifiees(s.empreintesContenu(a1), s.empreintesContenu(a2));
  verifier('seule la rubrique de contenu modifiée est relevée (pas la signature, le paiement ni les pièces)', JSON.stringify(modifiees) === JSON.stringify(["Identité de l'entreprise › Montant capital"]), modifiees);
  verifier('deux synthèses identiques : rien de modifié', s.rubriquesModifiees(s.empreintesContenu(a1), s.empreintesContenu(s.analyserElements(creation(1)))).length === 0);

  // -------------------------------------------------------------------------
  console.log('Statistiques et rapport');
  const fiches = [
    { ...f2, versions: { nombre: 2, rubriques_modifiees: modifiees } },
    { ...fb, versions: { nombre: 1, rubriques_modifiees: [] } },
    { ...fc, versions: { nombre: 1, rubriques_modifiees: [] } },
  ];
  const ag = s.agreger(fiches, { lus: 4, ignores: 1, erreurs: { illisible: 1 } });
  const cr = ag.strates['Création'];
  verifier('strates : création, forme, modification déclarée, bénéficiaires', cr?.n === 1 && cr.fiabilite === 'insuffisant'
    && ag.strates['Création · SAS, société par actions simplifiée']?.n === 1
    && ag.strates["Modification · En lien avec l'identité de l'entreprise › Je souhaite déclarer la prise ou la reprise d'activité de ma société"]?.n === 1
    && ag.strates['Bénéficiaires effectifs · Création']?.n === 1, Object.keys(ag.strates));
  verifier('présence des rubriques et valeurs relevées', cr.champs.find((x) => x.cle === "Description du mandat › Rôle pour l'entreprise")?.taux === 100
    && cr.champs.find((x) => x.cle === "Description du mandat › Rôle pour l'entreprise")?.valeurs?.['Président de SAS'] === 1);
  verifier('pièces du déposant seulement, avec leur fréquence', cr.pieces.length === 2 && cr.pieces[0].taux === 100 && cr.pieces_deposees_par_dossier === 2, cr.pieces);
  verifier('versions : contenu modifié et rubrique comptés', cr.versions.plusieurs_versions === 1 && cr.versions.contenu_modifie === 1
    && cr.versions.rubriques_modifiees["Identité de l'entreprise › Montant capital"] === 1);
  verifier('répartition par type et combinaisons de modifications', ag.repartition.type['Création'] === 1 && ag.repartition.type.Modification === 1 && Object.keys(ag.combinaisons).length === 1);
  verifier('pièce du déposant sans intitulé comptée à part', ag.strates.Modification.pieces_sans_intitule_par_dossier === 1 && ag.strates.Modification.pieces.length === 1, ag.strates.Modification.pieces);
  verifier('qualité de la lecture par année et par type', ag.lecture.colonne_usuelle === 174.5 && ag.lecture.par_annee['2024']?.documents === 3
    && ag.lecture.par_annee['2024'].a_verifier === 0 && ag.lecture.par_type['Création']?.documents === 1, ag.lecture);
  verifier('seuils de fiabilité (60 fiable, 30 indicatif)', s.fiabilite(60) === 'fiable' && s.fiabilite(59) === 'indicatif' && s.fiabilite(30) === 'indicatif' && s.fiabilite(29) === 'insuffisant');
  const md = s.rapport(ag);
  verifier('rapport lisible, sans donnée personnelle', md.startsWith('# Corpus des synthèses du Guichet unique') && md.includes('## Fiabilité par strate')
    && md.includes('## Qualité de la lecture') && fuites(md).length === 0, fuites(md));

  // -------------------------------------------------------------------------
  console.log('Lecture d’un PDF de bout en bout');
  const pdf = pdfDepuisElements(creation(1));
  const lu = await s.lireSynthese(pdf);
  const resumer = (a) => JSON.stringify({ r: a.rubriques.map((r) => [r.bloc, r.libelle, r.valeur]), t: a.titres.map((t) => [t.niveau, t.texte]), m: a.mentions.map((m) => m.texte) });
  verifier('le PDF donne les mêmes rubriques, titres et mentions que la mise en page', resumer(lu) === resumer(a1), { pdf: lu.rubriques.slice(0, 5), attendu: a1.rubriques.slice(0, 5) });
  verifier('pages, liasse et nature lues dans le PDF', lu.pages === 3 && lu.liasse === L1 && lu.nature === 'principale' && lu.date_synthese === '2024-01-03');

  // -------------------------------------------------------------------------
  console.log('Programme du corpus sur un dossier');
  const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-syntheses-'));
  try {
    const dossier = path.join(racine, 'pdf');
    const sous = path.join(dossier, 'sous-dossier');
    fs.mkdirSync(sous, { recursive: true });
    fs.writeFileSync(path.join(dossier, 'creation_v1.pdf'), pdf);
    fs.writeFileSync(path.join(dossier, 'creation_v2.pdf'), pdfDepuisElements(creation(2)));
    fs.writeFileSync(path.join(sous, 'creation_v2_copie.pdf'), pdfDepuisElements(creation(2)));
    fs.writeFileSync(path.join(dossier, 'creation_BE.pdf'), pdfDepuisElements(beneficiaires()));
    fs.writeFileSync(path.join(sous, 'modification.PDF'), pdfDepuisElements(modification()));
    fs.writeFileSync(path.join(dossier, 'recu.pdf'), pdfDepuisElements([{ page: 1, x: 60, y: 700, h: 12, s: 'Reçu de paiement' }]));
    fs.writeFileSync(path.join(dossier, 'casse.pdf'), Buffer.from('ceci n’est pas un PDF'));
    fs.writeFileSync(path.join(dossier, '._creation_v1.pdf'), Buffer.from('fichier caché macOS'));
    const sortie = path.join(racine, 'resultats');
    // Seuil 1 : corpus de trois formalités, rien ne doit être masqué pour vérifier le contenu.
    const console_ = execFileSync(process.execPath, [path.join(__dirname, 'corpus-syntheses.js'), dossier, '--sortie', sortie, '--seuil', '1'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    verifier('bilan : 7 PDF lus, 3 formalités, 1 écarté, 1 illisible', /7 PDF lus .*: 3 formalités retenues, 1 PDF écartés \(pas une synthèse\), 1 illisibles\./.test(console_), console_);
    verifier('le fichier illisible est nommé à l’écran seulement', /casse\.pdf/.test(console_));
    const lignes = fs.readFileSync(path.join(sortie, 'fiches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const creationFiche = lignes.find((x) => x.nature === 'principale' && x.type === 'Création');
    verifier('versions regroupées (copie identique comptée une fois), dernière version retenue', lignes.length === 3 && creationFiche?.versions?.nombre === 2
      && creationFiche.signe === true && creationFiche.numero_national === true
      && JSON.stringify(creationFiche.versions.rubriques_modifiees) === JSON.stringify(["Identité de l'entreprise › Montant capital"]), creationFiche?.versions);
    const ecrits = ['agregats.json', 'rapport.md', 'fiches.jsonl'].map((f) => fs.readFileSync(path.join(sortie, f), 'utf8')).join('\n');
    verifier('aucune donnée personnelle, aucun nom de fichier, aucune valeur candidate dans les résultats',
      fuites(ecrits).length === 0 && !/casse|creation_v|RECEPISSE|\.pdf|_candidat/i.test(ecrits.replace(/Document_de_Synthese/g, '')), fuites(ecrits));

    // Réglages du paquet Windows : seuil par défaut (3), sans fiches, exemples mis de côté.
    const exemples = path.join(racine, 'exemples');
    const sortie2 = path.join(racine, 'resultats2');
    const console2 = execFileSync(process.execPath, [path.join(__dirname, 'corpus-syntheses.js'), dossier, '--sortie', sortie2, '--sans-fiches', '--exemples', exemples], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const ag2 = JSON.parse(fs.readFileSync(path.join(sortie2, 'agregats.json'), 'utf8'));
    verifier('seuil par défaut : sur deux formalités distinctes, tout libellé est masqué', ag2.masquage?.seuil === 3 && ag2.masquage.rubriques > 0
      && !JSON.stringify(ag2).includes('Montant capital') && JSON.stringify(ag2).includes('[rubrique rare]'), ag2.masquage);
    verifier('sans fiches : fichier absent', !fs.existsSync(path.join(sortie2, 'fiches.jsonl')));
    verifier('exemples : le PDF écarté mis de côté, dans le dossier d’exemples seulement', JSON.stringify(fs.readdirSync(exemples)) === JSON.stringify(['ecarte-1.pdf'])
      && /Exemples de lecture difficile copiés .*ecarte : 1 sur 1/.test(console2), { fichiers: fs.readdirSync(exemples), console2 });

    // Poste sans la bibliothèque graphique native de pdf.js (analyse lancée hors du projet, sous Windows) :
    // la lecture du texte doit fonctionner quand même, sans avertissement à l'écran.
    const bloqueur = path.join(racine, 'sans-canvas.js');
    fs.writeFileSync(bloqueur, `const M = require('module'); const r = M._resolveFilename;
M._resolveFilename = function (req, ...a) { if (String(req).startsWith('@napi-rs/canvas')) { const e = new Error('Cannot find module ' + req); e.code = 'MODULE_NOT_FOUND'; throw e; } return r.call(this, req, ...a); };`);
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'inpi', 'synthese-gu.js'))})
  .lireSynthese(require('fs').readFileSync(${JSON.stringify(path.join(dossier, 'creation_v1.pdf'))}))
  .then((a) => console.log('rubriques=' + a.rubriques.length + ' matrice=' + (globalThis.DOMMatrix && globalThis.DOMMatrix.name)));`;
    const lecture = spawnSync(process.execPath, ['-r', bloqueur, '-e', script], { encoding: 'utf8' });
    verifier('lecture sans la bibliothèque graphique native, sans avertissement affiché',
      lecture.status === 0 && lecture.stdout.trim() === `rubriques=${a1.rubriques.length} matrice=MatriceMinimale` && !/Warning/.test(lecture.stderr),
      { sortie: lecture.stdout, erreurs: lecture.stderr });
  } finally {
    fs.rmSync(racine, { recursive: true, force: true });
  }

  console.log(`\n${ok} vérifications réussies${process.exitCode ? ', des échecs ci-dessus' : ''}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
