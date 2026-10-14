'use strict';

/**
 * Pièces déposées au registre (actes, comptes annuels) via le connecteur :
 * liste, téléchargement, texte (reconnaissance de caractères), comptes saisis,
 * confidentialité et erreurs. L'API INPI est simulée : aucun appel réel.
 *
 *   node scripts/test-registre.js
 */

process.env.MCP_GU_JETON = 'jeton-de-test-suffisamment-long-0123456789';
process.env.INPI_RNE_USERNAME = 'essai@cabinet.test';
process.env.INPI_RNE_PASSWORD = 'mot-de-passe-essai';

const fs = require('fs');
const path = require('path');
const { tables, fichiers } = require('./fake-supa');
const express = require('express');
const client = require('../src/inpi/client');
const mcp = require('../src/connecteur/mcp');

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
    process.exitCode = 1;
  }
}

const SCANNE = fs.readFileSync(path.join(__dirname, 'fixtures/acte-scanne.pdf'));
const SIREN = '552100554';
const appels = [];
const ATTACHMENTS = {
  actes: [
    { siren: SIREN, denomination: 'FARANDOLE DÉVELOPPEMENT', dateDepot: '2024-04-11', confidentiality: 'Public', deleted: false, id: 'acte-recent',
      typeRdd: [{ typeActe: 'Décision(s) de l\'actionnaire unique', decision: 'Modification(s) statutaire(s) ' }, { typeActe: 'Statuts mis à jour' }] },
    { siren: SIREN, dateDepot: '2019-02-01', confidentiality: 'Public', deleted: false, id: 'acte-ancien', typeRdd: [{ typeActe: 'Statuts constitutifs' }] },
    { siren: SIREN, dateDepot: '2023-05-12', confidentiality: 'Public', deleted: true, id: 'acte-supprime' },
    { siren: SIREN, dateDepot: '2022-01-01', confidentiality: 'Non public', deleted: false, id: 'acte-confidentiel', typeRdd: [{ typeActe: 'Liste des bénéficiaires effectifs' }] },
  ],
  bilans: [
    { siren: SIREN, denomination: 'FARANDOLE DÉVELOPPEMENT', dateDepot: '2023-03-14', confidentiality: 'Public', deleted: false, id: 'bilan-2022', dateCloture: '2022-12-31', typeBilan: 'C' },
    { siren: SIREN, dateDepot: '2024-06-01', confidentiality: 'Confidentiel', deleted: false, id: 'bilan-2023', dateCloture: '2023-12-31', typeBilan: 'S' },
  ],
  bilansSaisis: [{ id: 'saisi-2022', deleted: false, confidentiality: 'Public', bilanSaisi: { bilan: {
    identite: { dateClotureExercice: '2022-12-31', dateClotureExerciceNMoins1: '2021-12-31', dureeExerciceN: '12', codeSaisie: '00', codeTypeBilan: 'C', codeDevise: 'EUR', codeConfidentialite: '0' },
    detail: { pages: [
      { numero: 1, liasses: [{ code: 'CO', m1: '000000000150000', m2: '000000000010000', m3: '000000000140000', m4: '000000000120000' }] },
      { numero: 2, liasses: [{ code: 'DI', m1: '000000000012500', m2: '-000000000003000', m3: '', m4: '' }, { code: 'DL', m1: '000000000090000', m2: '000000000077500' },
        { code: 'EE', m1: '000000000140000', m2: '000000000120000' }] },
      { numero: 3, liasses: [{ code: 'FJ', m1: '000000000300000', m2: '000000000050000', m3: '000000000350000', m4: '000000000310000' }] },
    ] } } } }],
};

client.appel = async (cible, { chemin }) => {
  appels.push(chemin);
  if (chemin === `/api/companies/${SIREN}/attachments`) return JSON.parse(JSON.stringify(ATTACHMENTS));
  if (chemin === '/api/companies/732829320/attachments') throw Object.assign(new Error('Not found'), { status: 404, api: 'rne' });
  if (chemin === '/api/companies/542107651/attachments') throw Object.assign(new Error('Too many requests'), { status: 429, api: 'rne' });
  const acte = ATTACHMENTS.actes.find((a) => chemin === `/api/actes/${a.id}`);
  if (acte) return acte;
  const bilan = ATTACHMENTS.bilans.find((b) => chemin === `/api/bilans/${b.id}`);
  if (bilan) return bilan;
  if (chemin === '/api/actes/acte-interdit') return { id: 'acte-interdit', confidentiality: 'Public', deleted: false, dateDepot: '2020-01-01' };
  throw Object.assign(new Error('Not found'), { status: 404, api: 'rne' });
};
client.telecharger = async (cible, { chemin }) => {
  appels.push(chemin);
  if (chemin === '/api/actes/acte-interdit/download') throw Object.assign(new Error('Forbidden'), { status: 403, api: 'rne' });
  if (/^\/api\/(actes|bilans)\/[\w-]+\/download$/.test(chemin)) return SCANNE;
  throw Object.assign(new Error('Not found'), { status: 404, api: 'rne' });
};

(async () => {
  const serveur = express();
  serveur.use(express.json());
  serveur.use('/mcp', mcp.routeur);
  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}`;
  let n = 0;
  const outil = async (name, args) => {
    const res = await fetch(`${base}/mcp/${process.env.MCP_GU_JETON}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
    });
    const r = (await res.json()).result;
    return { erreur: Boolean(r.isError), texte: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text), contenus: r.content.slice(1) };
  };

  console.log('\nOutils');
  const liste = await (await fetch(`${base}/mcp/${process.env.MCP_GU_JETON}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) })).json();
  const noms = liste.result.tools.map((t) => t.name);
  verifier('trois outils du registre exposés', ['lister_pieces_deposees', 'telecharger_acte', 'telecharger_comptes'].every((x) => noms.includes(x)), noms);
  verifier('descriptions en français, lecture seule annoncée',
    liste.result.tools.filter((t) => /pieces_deposees|telecharger_/.test(t.name)).every((t) => /Lecture seule/.test(t.description)));

  console.log('\nlister_pieces_deposees');
  const l = await outil('lister_pieces_deposees', { siren: '552 100 554' });
  verifier('actes du plus récent au plus ancien, supprimés écartés', l.json.actes.map((a) => a.id).join() === 'acte-recent,acte-confidentiel,acte-ancien', l.json.actes.map((a) => a.id));
  verifier('types d’actes et libellé lisibles', l.json.actes[0].types.length === 2 && /Statuts mis à jour/.test(l.json.actes[0].libelle) && /Modification\(s\) statutaire\(s\)\)/.test(l.json.actes[0].libelle), l.json.actes[0]);
  verifier('acte confidentiel signalé', l.json.actes.find((a) => a.id === 'acte-confidentiel').confidentiel === true);
  verifier('bilans du plus récent au plus ancien, type et confidentialité',
    l.json.bilans.map((b) => b.id).join() === 'bilan-2023,bilan-2022' && l.json.bilans[0].confidentiel === true && l.json.bilans[1].type_comptes === 'Comptes annuels complets', l.json.bilans);
  verifier('exercices sans comptes visibles signalés (aucun trou ici)', !l.json.exercices_sans_comptes_visibles);
  ATTACHMENTS.bilans.push({ siren: SIREN, dateDepot: '2020-05-01', confidentiality: 'Public', deleted: false, id: 'bilan-2019', dateCloture: '2019-12-31', typeBilan: 'C' });
  const trou = await outil('lister_pieces_deposees', { siren: SIREN });
  ATTACHMENTS.bilans.pop();
  verifier('trou entre 2019 et 2022 : exercices 2020 et 2021 signalés', JSON.stringify(trou.json.exercices_sans_comptes_visibles) === '[2020,2021]' && /confidentiels/.test(trou.json.remarque_comptes), trou.json);
  verifier('données saisies signalées pour l’exercice qui en a', l.json.bilans[1].donnees_saisies.disponibles === true && l.json.bilans[0].donnees_saisies.disponibles === false);
  verifier('SIREN invalide refusé sans appel', (await outil('lister_pieces_deposees', { siren: '123456789' })).erreur && !appels.some((c) => c.includes('123456789')));
  const inconnu = await outil('lister_pieces_deposees', { siren: '732829320' });
  verifier('SIREN inconnu : message clair', inconnu.erreur && /introuvable au registre/.test(inconnu.texte), inconnu.texte);
  const quota = await outil('lister_pieces_deposees', { siren: '542107651' });
  verifier('quota dépassé : message clair', quota.erreur && /Quota journalier/.test(quota.texte), quota.texte);

  console.log('\ntelecharger_acte');
  const a = await outil('telecharger_acte', { id: 'acte-recent' });
  verifier('métadonnées de l’acte', a.json.acte.date_depot === '2024-04-11' && a.json.acte.types[1].type === 'Statuts mis à jour', a.json.acte);
  verifier('PDF joint (ressource) et lien de téléchargement', a.contenus[0]?.resource?.mimeType === 'application/pdf'
    && Buffer.from(a.contenus[0].resource.blob, 'base64').equals(SCANNE) && /registre\/actes\/acte-recent\.pdf/.test(a.json.pdf.lien_telechargement), a.json.pdf);
  verifier('acte scanné : texte obtenu par reconnaissance de caractères', a.json.texte.scanne && a.json.texte.pages_lues_par_ocr === 2
    && /accouvage/i.test(a.json.texte.contenu) && /quatre-vingt-dix-neuf/i.test(a.json.texte.contenu), a.json.texte);
  verifier('avertissement : texte à vérifier sur le PDF', /vérifier/.test(a.json.texte.avertissement_ocr || ''));
  const p2 = await outil('telecharger_acte', { id: 'acte-recent', pages: '2' });
  verifier('lecture par tranche de pages', !/accouvage/i.test(p2.json.texte.contenu) && /DURÉE/.test(p2.json.texte.contenu), p2.json.texte.contenu);
  const conf = await outil('telecharger_acte', { id: 'acte-confidentiel' });
  verifier('acte confidentiel : non récupéré', conf.erreur && /confidentiel/i.test(conf.texte) && !appels.includes('/api/actes/acte-confidentiel/download'), conf.texte);
  const interdit = await outil('telecharger_acte', { id: 'acte-interdit' });
  verifier('habilitation manquante : message explicite', interdit.erreur && /habilitation/.test(interdit.texte), interdit.texte);
  verifier('acte absent : message clair', /introuvable au registre/.test((await outil('telecharger_acte', { id: 'nexistepas' })).texte));

  console.log('\ntelecharger_comptes');
  const cConf = await outil('telecharger_comptes', { id: 'bilan-2023' });
  verifier('comptes confidentiels : signalés, rien n’est téléchargé', cConf.json.comptes.confidentiel === true && /confidentiels/.test(cConf.json.message)
    && !appels.includes('/api/bilans/bilan-2023/download') && !cConf.contenus.length, cConf.json);
  const c = await outil('telecharger_comptes', { id: 'bilan-2022' });
  verifier('PDF des comptes joint', c.contenus[0]?.resource?.mimeType === 'application/pdf' && c.json.comptes.date_cloture === '2022-12-31');
  const ds = c.json.donnees_saisies;
  verifier('chiffres clés tirés des données saisies', ds.chiffres_cles.chiffre_affaires.N === 350000 && ds.chiffres_cles.chiffre_affaires['N-1'] === 310000
    && ds.chiffres_cles.resultat.N === 12500 && ds.chiffres_cles.resultat['N-1'] === -3000 && ds.chiffres_cles.capitaux_propres.N === 90000 && ds.chiffres_cles.total_bilan.N === 140000, ds.chiffres_cles);
  const cr = ds.detail.find((p) => p.page === '03');
  verifier('postes libellés, colonnes nommées', cr.rubrique === 'COMPTE DE RESULTAT' && cr.postes[0].libelle === 'Chiffres d’affaires nets' && cr.postes[0].valeurs['export N'] === 50000, cr);
  verifier('saisie et confidentialité en clair', ds.saisie === 'saisis sans anomalie' && /aucune déclaration/.test(ds.confidentialite), ds);

  const { lireSaisis } = require('../src/inpi/rne-documents');
  verifier('code de confidentialité absent (null) : non affirmé comme « aucune déclaration »',
    lireSaisis({ bilanSaisi: { bilan: { identite: { codeTypeBilan: 'C', codeConfidentialite: null }, detail: { pages: [] } } } }).confidentialite === null);
  verifier('comptes confidentiels (code 1) décrits en clair',
    /seules les données d’identité/.test(lireSaisis({ bilanSaisi: { bilan: { identite: { codeTypeBilan: 'S', codeConfidentialite: '1' } } } }).confidentialite));

  console.log('\nRadiation');
  const { normaliserEntreprise } = require('../src/inpi/normalize');
  const ficheBrute = (extra) => ({ formality: { siren: SIREN, content: { ...extra, personneMorale: { identite: { entreprise: { siren: SIREN, denomination: 'X', formeJuridique: '5710' } }, ...(extra.pm || {}) } } } });
  verifier('radiation lue dans natureCessationEntreprise', normaliserEntreprise(ficheBrute({ natureCessationEntreprise: { dateRadiation: '2024-05-02' } })).date_radiation === '2024-05-02');
  verifier('radiation lue dans detailCessationEntreprise', normaliserEntreprise(ficheBrute({ pm: { detailCessationEntreprise: { dateRadiation: '2023-01-10', dateCessationTotaleActivite: '2022-12-31' } } })).radiee === true);
  verifier('société sans radiation : active', normaliserEntreprise(ficheBrute({})).radiee === false);

  console.log('\nIdentifiant INPI erroné après un dépôt de modification');
  const guichetMod = require('../src/inpi/guichet');
  const formalitesSvc = require('../src/services/formalites');
  const lireOrig = guichetMod.lire; const retrouverOrig = guichetMod.retrouver;
  guichetMod.lire = async (id) => { if (String(id) === '22049302') throw Object.assign(new Error('Not Found'), { status: 404 }); return { statut: 'SIGNATURE_PENDING', statut_brut: 'SIGNATURE_PENDING', regularisations: [], montant: 72.81 }; };
  guichetMod.retrouver = async ({ liasse }) => (liasse === 'J00291446433' ? { inpi_id: '7654321', numero_liasse: liasse } : null);
  tables.formalites.push({ id: 900, type: 'parcours', reference: 'LGZ-2026-00900', inpi_id: '22049302', numero_liasse: 'J00291446433', siren: '310427562', statut: 'RECEIVED', service: 'formalites', regularisations: [] });
  const sync = await formalitesSvc.synchroniser(900);
  guichetMod.lire = lireOrig; guichetMod.retrouver = retrouverOrig;
  const f900 = tables.formalites.find((x) => x.id === 900);
  verifier('formalité retrouvée par sa liasse, identifiant corrigé et statut relu', f900.inpi_id === '7654321' && sync.synchronise && f900.statut === 'SIGNATURE_PENDING', f900);
  verifier('correction journalisée', tables.formalite_evenements.some((e) => e.formalite_id === 900 && /Identifiant INPI corrigé/.test(e.message)));
  tables.formalites.splice(tables.formalites.indexOf(f900), 1);
  tables.formalite_evenements.splice(0, tables.formalite_evenements.length);
  const { normaliserFormalite } = guichetMod;
  verifier('montant du panier converti des centimes en euros', normaliserFormalite({ id: 1, carts: { total: 7281 } }).montant === 72.81);

  console.log('\nLecture seule');
  verifier('aucun dossier de formalité créé ni modifié', tables.formalites.length === 0 && tables.formalite_pieces.length === 0 && tables.formalite_evenements.length === 0);
  verifier('seuls des appels de lecture (GET) au registre', appels.every((ch) => !/sso|formalit/.test(ch)));
  verifier('PDF conservés dans le stockage du cabinet', fichiers.has('registre/actes/acte-recent.pdf') && fichiers.has('registre/comptes/bilan-2022.pdf'));

  instance.close();
  console.log(`\n${ok} vérifications${process.exitCode ? ' — ÉCHECS ci-dessus' : ' — tout est vert'}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
