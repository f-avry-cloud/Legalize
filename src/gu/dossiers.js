'use strict';

/**
 * Formalités pilotées par Claude Code : un dossier = un répertoire de travail.
 *
 *   dossiers/<référence>-<société>/
 *     dossier.json   type, SIREN, réponses, pièces (chemins relatifs), résultat INPI
 *     pieces/        les PDF du dossier
 *
 * Ces répertoires ne sont JAMAIS versionnés (voir .gitignore) : ils contiennent
 * des données de clients. Le registre de suivi vit dans OneDrive, pas ici.
 *
 * Le moteur est celui de Legalize (catalogue, contrôles, construction du JSON,
 * client du Guichet unique) ; seules changent l'origine des pièces (fichiers
 * locaux) et la tenue du registre.
 */

const fs = require('fs');
const path = require('path');
const guichet = require('../inpi/guichet');
const rne = require('../inpi/rne');
const { definition, piecesExigees } = require('../inpi/catalogue');
const { controler } = require('../inpi/controles');
const { construirePayload } = require('../inpi/payload');
const { config } = require('../inpi/config');
const { statut: infoStatut } = require('../inpi/referentiels');
const { nettoyerSiren } = require('../inpi/normalize');
const { pdfLisible } = require('../inpi/pdf');
const outils = require('../connecteur/outils');
const jeton = require('../connecteur/jeton');

const ACTIONS_AVOCAT = new Set(['signer', 'payer', 'regulariser', 'corriger']);

function erreur(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'dossier';

/* ------------------------------------------------------------- lecture */

function lireDossier(chemin) {
  const fichier = fs.statSync(chemin).isDirectory() ? path.join(chemin, 'dossier.json') : chemin;
  if (!fs.existsSync(fichier)) throw erreur(`Dossier introuvable : ${fichier}`);
  const dossier = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  outils.exigerType(dossier.type);
  return { dossier, fichier, dir: path.dirname(fichier) };
}

function ecrireDossier(fichier, dossier) {
  fs.writeFileSync(fichier, `${JSON.stringify(dossier, null, 2)}\n`);
}

/** Pièces déclarées dans dossier.json : [{ code, fichier }] → fichiers lus. */
function piecesLocales(dossier, dir) {
  return (dossier.pieces || []).map((p) => {
    if (!p.code || !p.fichier) throw erreur('Chaque pièce doit avoir un « code » (PJ_xx) et un « fichier ».');
    const chemin = path.resolve(dir, p.fichier);
    if (!fs.existsSync(chemin)) throw erreur(`Pièce introuvable : ${p.fichier}`);
    const buffer = fs.readFileSync(chemin);
    return { code: p.code, nom: path.basename(chemin), chemin, taille: buffer.length, buffer };
  });
}

/* ------------------------------------------------------------ création */

/**
 * Ouvre un dossier de travail. Pour une modification, la fiche RNE est lue
 * tout de suite : elle donne la dénomination et l'état actuel.
 */
async function nouveauDossier({ type, siren, racine = 'dossiers', libelle }) {
  const def = outils.exigerType(type);
  let fiche = null;
  if (!def.sansSiren) {
    if (!siren) throw erreur('SIREN requis pour cette formalité.');
    fiche = await rne.entreprise(siren);
  }
  const reference = jeton.nouvelleReference();
  const denomination = fiche?.denomination || '';
  const dir = path.resolve(racine, `${reference}-${slug(denomination || def.libelle)}`);
  fs.mkdirSync(path.join(dir, 'pieces'), { recursive: true });
  const dossier = {
    reference,
    type,
    siren: siren ? nettoyerSiren(siren) : undefined,
    societe: denomination || undefined,
    libelle: libelle || [denomination, def.libelle].filter(Boolean).join(' — '),
    ouvert_le: new Date().toISOString().slice(0, 10),
    reponses: {},
    pieces: [],
  };
  const fichier = path.join(dir, 'dossier.json');
  ecrireDossier(fichier, dossier);
  return {
    dossier: fichier,
    reference,
    societe: fiche ? { denomination, siren: fiche.siren_formate || fiche.siren } : null,
    fiche_rne: fiche ? { ...fiche, brut: undefined } : null,
    exigences: outils.exigences(type, {}),
    consigne: 'Renseigner « reponses » et « pieces » dans dossier.json (PDF à placer dans pieces/), puis lancer controler.',
  };
}

/* ----------------------------------------------------------- contrôles */

async function assembler(chemin) {
  const { dossier, fichier, dir } = lireDossier(chemin);
  const def = definition(dossier.type);
  const sirenPropre = nettoyerSiren(dossier.siren || '');
  if (!def.sansSiren && !sirenPropre) throw erreur('SIREN absent de dossier.json.');
  const fiche = def.sansSiren ? null : await rne.entreprise(sirenPropre);
  const pieces = piecesLocales(dossier, dir);
  const moteur = {
    type: dossier.type,
    siren: sirenPropre,
    reference: dossier.reference,
    libelle: dossier.libelle,
    fiche,
    reponses: dossier.reponses || {},
    pieces: pieces.map((p) => ({ code: p.code, nom: p.nom, taille: p.taille })),
  };
  return { dossier, fichier, def, fiche, pieces, moteur };
}

/** Vérifications propres aux fichiers, que le moteur ne voit pas. */
function controlerFichiers(pieces) {
  const bloquants = [];
  for (const p of pieces) {
    if (!/\.pdf$/i.test(p.nom)) bloquants.push(`« ${p.nom} » (${p.code}) : seul le PDF est accepté.`);
    else if (!pdfLisible(p.buffer)) bloquants.push(`« ${p.nom} » (${p.code}) n’est pas un PDF lisible : le remplacer.`);
    if (p.taille > config.pieceMaxOctets) bloquants.push(`« ${p.nom} » (${p.code}) dépasse 10 Mo.`);
  }
  return bloquants;
}

async function controlerDossier(chemin) {
  const { dossier, def, fiche, pieces, moteur } = await assembler(chemin);
  let payload = null;
  let erreurConstruction = null;
  try { payload = construirePayload(moteur); } catch (e) { erreurConstruction = e.message; }
  const c = controler({ ...moteur, payload });
  const resultat = outils.synthese(c);
  resultat.bloquants.push(...controlerFichiers(pieces));
  if (erreurConstruction) resultat.bloquants.push(`Formalité impossible à construire : ${erreurConstruction}`);
  resultat.pret = resultat.bloquants.length === 0;
  return {
    reference: dossier.reference,
    formalite: def.libelle,
    societe: fiche ? { denomination: fiche.denomination, siren: fiche.siren_formate || fiche.siren, radiee: Boolean(fiche.radiee) } : null,
    apercu: outils.apercu(def, dossier.reponses, fiche),
    pieces: pieces.map((p) => ({ code: p.code, fichier: p.nom, taille: p.taille })),
    pieces_exigees: piecesExigees(dossier.type, dossier.reponses || {}).map((p) => ({ code: p.code, libelle: p.libelle, obligatoire: p.obligatoire })),
    controles: resultat,
    mode: outils.modeGuichet(),
  };
}

/* ------------------------------------------------------- enregistrement */

async function enregistrerDossier(chemin, { confirme = false } = {}) {
  if (!confirme) {
    throw erreur('Enregistrement refusé : ajouter --confirme, uniquement après validation explicite du récapitulatif par l’avocat.');
  }
  const { dossier, fichier, def, pieces, moteur } = await assembler(chemin);
  if (dossier.inpi?.inpi_id && !dossier.inpi.simule) {
    return { enregistre: false, motif: `Dossier déjà enregistré (identifiant ${dossier.inpi.inpi_id}).`, inpi: dossier.inpi };
  }
  const c = controler({ ...moteur, payload: construirePayload(moteur) });
  const bloquantsFichiers = controlerFichiers(pieces);
  if (!c.pret || bloquantsFichiers.length) {
    const s = outils.synthese(c);
    s.bloquants.push(...bloquantsFichiers);
    s.pret = false;
    return { enregistre: false, motif: 'Contrôles bloquants non levés.', controles: s };
  }

  // Double envoi : la référence du dossier part comme référence mandataire.
  if (!guichet.simulationActive()) {
    const service = def.service === 'comptes_annuels' ? 'comptes_annuels' : 'formalites';
    const deja = (await guichet.lister({ itemsPerPage: 50 }, service))
      .find((f) => f.reference_mandataire === dossier.reference);
    if (deja) {
      dossier.inpi = { inpi_id: deja.inpi_id, numero_liasse: deja.numero_liasse, statut: deja.statut };
      ecrireDossier(fichier, dossier);
      return { enregistre: false, motif: `Déjà enregistré au Guichet unique (identifiant ${deja.inpi_id}).`, inpi: dossier.inpi };
    }
  }

  const encodees = pieces.map((p) => ({ code: p.code, nom: p.nom, taille: p.taille, base64: p.buffer.toString('base64') }));
  const r = await guichet.deposer(construirePayload({ ...moteur, pieces: encodees }));
  const info = infoStatut(r.statut);
  dossier.inpi = {
    inpi_id: r.inpi_id,
    numero_liasse: r.numero_liasse,
    statut: r.statut,
    montant: r.montant,
    enregistre_le: new Date().toISOString(),
    simule: Boolean(r.simule) || undefined,
  };
  ecrireDossier(fichier, dossier);

  return {
    enregistre: true,
    simule: Boolean(r.simule),
    motif_simulation: r.motif_simulation || undefined,
    reference: dossier.reference,
    formalite: def.libelle,
    inpi_id: r.inpi_id,
    numero_liasse: r.numero_liasse,
    statut: info.libelle,
    action_attendue: outils.ACTIONS[r.action_attendue] || info.libelle,
    montant_a_payer: r.montant,
    pieces_transmises: pieces.map((p) => `${p.nom} (${p.code})`),
    portail_signature: config.guichet.portailUrl,
    echeance: c.echeance,
    alertes: c.alertes.map((a) => a.message),
    entree_registre: entreeRegistre(dossier, def, c.echeance),
  };
}

/* ---------------------------------------------------------------- registre */

/**
 * Le registre est un tableau JSON d'entrées, une par dossier. Claude le lit
 * dans OneDrive, le met à jour ici, puis le redépose.
 */
function entreeRegistre(dossier, def, echeance) {
  const info = dossier.inpi ? infoStatut(dossier.inpi.statut) : null;
  return {
    reference: dossier.reference,
    societe: dossier.societe || null,
    siren: dossier.siren || null,
    formalite: def.libelle,
    type: dossier.type,
    ouvert_le: dossier.ouvert_le || null,
    echeance: echeance?.limite || dossier.echeance || null,
    inpi_id: dossier.inpi?.inpi_id || null,
    numero_liasse: dossier.inpi?.numero_liasse || null,
    statut: dossier.inpi?.statut || 'PREPARATION',
    statut_libelle: info ? info.libelle : 'En préparation',
    action_attendue: info ? (outils.ACTIONS[info.action] || null) : 'Préparer et faire valider le dossier.',
    montant: dossier.inpi?.montant ?? null,
    regularisations: [],
    simule: dossier.inpi?.simule || undefined,
    mis_a_jour: new Date().toISOString(),
  };
}

function lireRegistre(chemin) {
  if (!fs.existsSync(chemin)) return [];
  const contenu = fs.readFileSync(chemin, 'utf8').trim();
  if (!contenu) return [];
  const data = JSON.parse(contenu);
  return Array.isArray(data) ? data : (data.dossiers || []);
}

function ecrireRegistre(chemin, entrees) {
  fs.writeFileSync(chemin, `${JSON.stringify(entrees, null, 2)}\n`);
}

/** Ajoute ou remplace l'entrée d'un dossier dans le registre. */
async function inscrire(registre, cheminDossier) {
  const { dossier } = lireDossier(cheminDossier);
  const def = definition(dossier.type);
  let echeance = null;
  try {
    const { moteur } = await assembler(cheminDossier);
    echeance = controler({ ...moteur }).echeance;
  } catch { /* dossier encore incomplet : pas d'échéance calculable */ }
  const entree = entreeRegistre(dossier, def, echeance);
  const entrees = lireRegistre(registre).filter((e) => e.reference !== entree.reference);
  entrees.push(entree);
  ecrireRegistre(registre, entrees);
  return entree;
}

/* ------------------------------------------------------------------- suivi */

const TERMINAUX = new Set(['VALIDATED', 'REJECTED']);

function joursAvant(date, maintenant = new Date()) {
  if (!date) return null;
  return Math.ceil((new Date(date) - maintenant) / 86400000);
}

/**
 * Met à jour le statut de chaque dossier ouvert, puis produit le registre à
 * jour, le corps de l'e-mail de suivi (HTML) et un tableau Excel.
 */
async function suivi(cheminRegistre, { sortie = '.' } = {}) {
  const entrees = lireRegistre(cheminRegistre);
  const erreurs = [];
  for (const e of entrees) {
    if (!e.inpi_id || TERMINAUX.has(e.statut)) continue;
    try {
      const service = e.type === 'depot_comptes' ? 'comptes_annuels' : 'formalites';
      const f = await guichet.lire(e.inpi_id, service);
      const l = outils.lisible(f);
      Object.assign(e, {
        statut: l.statut_code,
        statut_libelle: l.statut,
        action_attendue: l.action_attendue,
        montant: l.montant ?? e.montant,
        numero_liasse: l.numero_liasse || e.numero_liasse,
        regularisations: l.regularisations,
        statut_depuis: l.depuis,
        mis_a_jour: new Date().toISOString(),
      });
    } catch (err) {
      erreurs.push({ reference: e.reference, message: err.message });
    }
  }
  ecrireRegistre(cheminRegistre, entrees);

  const groupes = grouper(entrees);
  fs.mkdirSync(sortie, { recursive: true });
  const html = path.join(sortie, 'suivi-formalites.html');
  fs.writeFileSync(html, emailHtml(groupes, erreurs));
  const xlsx = path.join(sortie, 'Suivi des formalités.xlsx');
  await tableurExcel(entrees, xlsx);

  return {
    date: new Date().toISOString().slice(0, 10),
    a_faire: groupes.aFaire.length,
    en_cours: groupes.enCours.length,
    en_preparation: groupes.preparation.length,
    termines: groupes.termines.length,
    objet_email: objetEmail(groupes),
    fichiers: { registre: cheminRegistre, email_html: html, excel: xlsx },
    erreurs,
    mode: outils.modeGuichet(),
  };
}

function grouper(entrees) {
  const aFaire = [];
  const enCours = [];
  const preparation = [];
  const termines = [];
  for (const e of entrees) {
    const action = Object.entries(outils.ACTIONS).find(([, v]) => v === e.action_attendue)?.[0];
    if (TERMINAUX.has(e.statut)) termines.push(e);
    else if (e.statut === 'PREPARATION') preparation.push(e);
    else if (ACTIONS_AVOCAT.has(action) || (e.regularisations || []).length) aFaire.push(e);
    else enCours.push(e);
  }
  const parEcheance = (a, b) => String(a.echeance || '9999').localeCompare(String(b.echeance || '9999'));
  [aFaire, enCours, preparation].forEach((l) => l.sort(parEcheance));
  return { aFaire, enCours, preparation, termines };
}

function objetEmail(g) {
  const n = g.aFaire.length;
  const parties = [n ? `${n} action${n > 1 ? 's' : ''} à faire` : 'rien à faire aujourd’hui'];
  const proches = [...g.preparation, ...g.aFaire].filter((e) => {
    const j = joursAvant(e.echeance);
    return j !== null && j <= 7;
  }).length;
  if (proches) parties.push(`${proches} échéance${proches > 1 ? 's' : ''} sous 7 jours`);
  return `Formalités — ${parties.join(', ')}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function dateFr(d) {
  if (!d) return '—';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? esc(d) : x.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Le corps de l'e-mail passe par le filtre HTML d'Outlook (connecteur
// Microsoft 365) : titres, paragraphes, tableaux et mise en forme simple
// seulement. Ni <span>, ni <div>, ni couleurs indispensables à la lecture.
function ligne(e) {
  const j = joursAvant(e.echeance);
  const delai = j === null ? '' : (j < 0 ? ` — <strong>dépassée de ${-j} j</strong>` : (j <= 7 ? ` — <strong>J-${j}</strong>` : ` — J-${j}`));
  const echeance = e.echeance ? `${dateFr(e.echeance)}${delai}` : '—';
  const regs = (e.regularisations || []).map((r) => `<br><em>Régularisation : ${esc(r.motif || r.champ || r.piece || 'demande du greffe')}${r.echeance ? `, avant le ${dateFr(r.echeance)}` : ''}</em>`).join('');
  return `<tr>
<td><strong>${esc(e.societe || '—')}</strong><br>${esc(e.formalite)}${e.numero_liasse ? ` · liasse ${esc(e.numero_liasse)}` : ''}</td>
<td>${esc(e.statut_libelle)}<br>${esc(e.action_attendue || '')}${regs}</td>
<td>${echeance}</td>
</tr>`;
}

function section(titre, liste, vide) {
  const entete = '<tr><th align="left">Dossier</th><th align="left">Statut et action</th><th align="left">Échéance</th></tr>';
  return `<h2>${esc(titre)} (${liste.length})</h2>${liste.length
    ? `<table border="1" cellpadding="6" cellspacing="0" width="100%">${entete}${liste.map(ligne).join('')}</table>`
    : `<p>${esc(vide)}</p>`}`;
}

function emailHtml(g, erreurs) {
  const simu = g.aFaire.concat(g.enCours).some((e) => e.simule)
    ? '<p><strong>Attention :</strong> certains dossiers sont en simulation, rien n’a été transmis à l’INPI pour eux.</p>' : '';
  const errs = erreurs.length
    ? `<p><strong>Statut non actualisé</strong> pour : ${erreurs.map((x) => esc(x.reference)).join(', ')}.</p>` : '';
  return `<!doctype html><html lang="fr"><body>
<h1>Suivi des formalités — ${dateFr(new Date())}</h1>${simu}${errs}
${section('À faire par toi', g.aFaire, 'Aucune signature, aucun paiement, aucune régularisation en attente.')}
${section('En préparation', g.preparation, 'Aucun dossier en préparation.')}
${section('En cours au Guichet unique', g.enCours, 'Aucun dossier en cours de traitement.')}
${g.termines.length ? section('Terminés', g.termines.slice(-10), '') : ''}
<p><em>Signature et paiement : portail du Guichet unique. Le détail de chaque dossier est dans sa session Claude Code ; le tableau complet est dans OneDrive, Formalités / Suivi des formalités.xlsx.</em></p>
</body></html>`;
}

async function tableurExcel(entrees, chemin) {
  const ExcelJS = require('exceljs');
  const classeur = new ExcelJS.Workbook();
  const feuille = classeur.addWorksheet('Formalités', { views: [{ state: 'frozen', ySplit: 1 }] });
  feuille.columns = [
    { header: 'Société', key: 'societe', width: 28 },
    { header: 'SIREN', key: 'siren', width: 12 },
    { header: 'Formalité', key: 'formalite', width: 30 },
    { header: 'Statut', key: 'statut_libelle', width: 26 },
    { header: 'Action attendue', key: 'action_attendue', width: 44 },
    { header: 'Échéance', key: 'echeance', width: 12 },
    { header: 'Régularisations', key: 'regs', width: 40 },
    { header: 'Liasse', key: 'numero_liasse', width: 18 },
    { header: 'Montant (€)', key: 'montant', width: 12 },
    { header: 'Référence', key: 'reference', width: 14 },
    { header: 'Mis à jour', key: 'mis_a_jour', width: 12 },
  ];
  for (const e of entrees) {
    feuille.addRow({
      ...e,
      echeance: e.echeance ? new Date(e.echeance) : null,
      mis_a_jour: e.mis_a_jour ? new Date(e.mis_a_jour) : null,
      regs: (e.regularisations || []).map((r) => r.motif || r.champ || r.piece).filter(Boolean).join(' ; '),
    });
  }
  feuille.getRow(1).font = { bold: true };
  feuille.getColumn('echeance').numFmt = 'dd/mm/yyyy';
  feuille.getColumn('mis_a_jour').numFmt = 'dd/mm/yyyy';
  feuille.autoFilter = { from: 'A1', to: 'K1' };
  await classeur.xlsx.writeFile(chemin);
}

module.exports = {
  lireDossier, nouveauDossier, controlerDossier, enregistrerDossier,
  lireRegistre, inscrire, suivi, entreeRegistre, grouper,
};
