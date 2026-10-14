'use strict';

/**
 * Page de dépôt des pièces d'un dossier ouvert par le connecteur : le lien
 * remis par Claude à l'avocat (https://<application>/depot/<jeton>), sans
 * connexion, valable 7 jours.
 *
 * Les PDF vont du navigateur au stockage par une adresse d'envoi signée, à
 * usage unique : ils ne transitent pas par le serveur, dont les requêtes sont
 * limitées à 4,5 Mo sur Vercel alors que le guichet accepte 10 Mo. Le serveur
 * les relit ensuite pour les contrôler (PDF lisible, 10 Mo au plus) avant de
 * les inscrire au dossier.
 */

const express = require('express');
const { supabase, q, BUCKET, SUPABASE_URL, SUPABASE_KEY, clientService, dansContexte, downloadFile, removeFiles } = require('../supa');
const parcoursSvc = require('../services/parcours');
const { pdfLisible, MESSAGE_ILLISIBLE } = require('../inpi/pdf');
const { empreinte, ORIGINE, cataloguePieces } = require('./service');
const { PIECES } = require('../inpi/referentiels');

const MAX_OCTETS = 10 * 1024 * 1024;

function erreur(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Le dossier du lien, s'il est valide et encore ouvert. */
async function dossierDuLien(jeton) {
  if (!/^[\w-]{20,64}$/.test(String(jeton || ''))) throw erreur('Lien invalide.', 404);
  const [f] = await q(supabase.from('formalites').select('*').eq('depot_jeton', empreinte(jeton)));
  if (!f || f.origine !== ORIGINE) throw erreur('Lien invalide ou remplacé par un lien plus récent.', 404);
  if (!f.depot_expire || Date.parse(f.depot_expire) < Date.now()) throw erreur('Ce lien a expiré : demandez-en un nouveau à Claude.', 410);
  return f;
}

/** Ce que la page affiche : la liste des pièces attendues et celles reçues. */
async function etat(f) {
  const d = await parcoursSvc.lire(f.id);
  const ligne = (p, categorie) => ({
    cle: p.cle, code: p.code, piece: p.court || p.libelle, libelle: p.libelle, personne: p.personne || null,
    condition: p.condition || p.raison || null, categorie,
    fichiers: p.fichiers.map((x) => ({ id: x.id, nom: x.nom, taille: x.taille })),
  });
  return {
    reference: d.reference,
    societe: d.societe.denomination || '',
    operations: d.operations.map((o) => o.nom),
    expire: f.depot_expire,
    transmis: Boolean(f.inpi_id),
    pieces: [
      ...d.pieces.obligatoires.map((p) => ligne(p, 'obligatoire')),
      ...d.pieces.a_preciser.map((p) => ligne(p, 'selon_le_cas')),
      ...d.pieces.facultatives.map((p) => ligne(p, 'facultative')),
    ],
    // Pièces reçues hors de la liste (« Autre pièce »), avec leur type.
    autres: d.autres_pieces.map((x) => ({ id: x.id, code: x.code, nom: x.nom, taille: x.taille, type: PIECES[x.code]?.libelle || x.code })),
    types: cataloguePieces().pieces,
  };
}

/**
 * La destination d'un fichier : une ligne de la liste (« cle »), ou une pièce
 * hors liste d'un type officiel du guichet (« code », PJ_xx).
 */
async function destination(f, { cle, code }) {
  const e = await etat(f);
  if (cle) {
    const p = e.pieces.find((x) => x.cle === cle);
    if (!p) throw erreur('Pièce inconnue pour ce dossier.');
    return { cle: p.cle, code: p.code };
  }
  const c = String(code || '').trim().toUpperCase();
  if (!PIECES[c]) throw erreur('Choisissez le type de la pièce.');
  // Un type déjà dans la liste y est rangé, s'il n'y figure qu'une fois.
  const memes = e.pieces.filter((x) => x.code === c);
  return memes.length === 1 ? { cle: memes[0].cle, code: c } : { cle: c, code: c };
}

const routeur = express.Router();

// Toute la suite agit avec le client de service, borné au dossier du lien.
routeur.use((req, res, next) => {
  const service = clientService();
  if (!service) return res.status(503).type('text').send('Dépôt indisponible : connecteur non configuré.');
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
  return dansContexte({ client: service, utilisateur: null }, () => next());
});

routeur.get('/:jeton', (req, res) => res.type('html').send(PAGE));

routeur.get('/:jeton/etat', async (req, res) => res.json(await etat(await dossierDuLien(req.params.jeton))));

/** Adresse d'envoi signée pour un PDF destiné à une pièce de la liste. */
routeur.post('/:jeton/televersement', async (req, res) => {
  const f = await dossierDuLien(req.params.jeton);
  if (f.inpi_id) throw erreur('Le dossier a déjà été transmis au guichet.', 409);
  const { cle, code, nom, taille } = req.body || {};
  const piece = await destination(f, { cle, code });
  if (!/\.pdf$/i.test(String(nom || ''))) throw erreur('Seuls les PDF sont acceptés par le guichet.', 422);
  if (Number(taille) > MAX_OCTETS) throw erreur('Fichier de plus de 10 Mo : le guichet le refuserait.', 422);
  const chemin = parcoursSvc.cheminPiece(f.id, piece.code, nom);
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(chemin);
  if (error) throw erreur(`Stockage : ${error.message}`, 502);
  // Le navigateur envoie avec la bibliothèque Supabase (clé publique : seul
  // le jeton d'envoi, à usage unique, ouvre l'écriture de ce fichier-là).
  res.json({ chemin, jeton_envoi: data.token, stockage: { url: SUPABASE_URL, cle: SUPABASE_KEY, bucket: BUCKET } });
});

/** Le PDF est arrivé dans le stockage : contrôle, puis inscription au dossier. */
routeur.post('/:jeton/confirmer', async (req, res) => {
  const f = await dossierDuLien(req.params.jeton);
  if (f.inpi_id) throw erreur('Le dossier a déjà été transmis au guichet.', 409);
  const { cle, code, chemin, nom } = req.body || {};
  const piece = await destination(f, { cle, code });
  if (typeof chemin !== 'string' || !chemin.startsWith(`formalites/${f.id}/${piece.code}_`) || chemin.includes('..')) throw erreur('Envoi non reconnu.');
  const contenu = await downloadFile(chemin);
  const rejet = contenu.length > MAX_OCTETS ? 'Fichier de plus de 10 Mo : le guichet le refuserait.'
    : (!(await pdfLisible(contenu)) ? MESSAGE_ILLISIBLE : null);
  if (rejet) {
    await removeFiles([chemin]);
    throw erreur(rejet, 422);
  }
  await parcoursSvc.inscrirePiece(f.id, {
    cle: piece.cle, code: piece.code, filename: String(nom || chemin.split('/').pop()).slice(0, 200),
    filepath: chemin, taille: contenu.length, origine: ' par l’avocat (lien de dépôt)',
  });
  res.json(await etat(await dossierDuLien(req.params.jeton)));
});

/** Range un fichier reçu sous une autre pièce de la liste, ou sous un autre type. */
routeur.post('/:jeton/pieces/:pieceId/reclasser', async (req, res) => {
  const f = await dossierDuLien(req.params.jeton);
  if (f.inpi_id) throw erreur('Le dossier a déjà été transmis au guichet.', 409);
  const [p] = await q(supabase.from('formalite_pieces').select('*').eq('id', req.params.pieceId).eq('formalite_id', f.id));
  if (!p) throw erreur('Pièce introuvable.', 404);
  const cible = await destination(f, req.body || {});
  await parcoursSvc.reclasserPiece(p.id, cible.cle === cible.code && !(await etat(f)).pieces.some((x) => x.cle === cible.cle) ? { code: cible.code } : { cle: cible.cle });
  res.json(await etat(f));
});

/** Retire un fichier déposé par erreur, tant que le dossier n'est pas transmis. */
routeur.delete('/:jeton/pieces/:pieceId', async (req, res) => {
  const f = await dossierDuLien(req.params.jeton);
  if (f.inpi_id) throw erreur('Le dossier a déjà été transmis au guichet.', 409);
  const [p] = await q(supabase.from('formalite_pieces').select('*').eq('id', req.params.pieceId).eq('formalite_id', f.id));
  if (!p) throw erreur('Pièce introuvable.', 404);
  await parcoursSvc.retirerPiece(p.id);
  await removeFiles([p.filepath]).catch(() => {});
  res.json(await etat(f));
});

routeur.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error('[dépôt]', err);
  res.status(err.status || 500).json({ error: err.status && err.status < 500 ? err.message : 'Erreur interne : réessayez dans un instant.' });
});

const PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Dépôt des pièces</title>
<style>
  :root { --fond:#f6f5f2; --carte:#fff; --texte:#1d1d1b; --doux:#6b6a66; --trait:#e3e1dc; --accent:#1f4e79; --ok:#2e7d32; --alerte:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --fond:#161615; --carte:#21211f; --texte:#ecebe7; --doux:#a3a29d; --trait:#363532; --accent:#8bb8e8; --ok:#81c784; --alerte:#f28b82; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--fond); color:var(--texte); font:16px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width:720px; margin:0 auto; padding:20px 16px 48px; }
  h1 { font-size:1.35rem; margin:0 0 4px; }
  .sous { color:var(--doux); margin:0 0 16px; }
  .note { background:var(--carte); border:1px solid var(--trait); border-radius:10px; padding:12px 14px; margin:0 0 18px; font-size:.93rem; }
  h2 { font-size:1rem; margin:22px 0 8px; color:var(--doux); text-transform:uppercase; letter-spacing:.04em; }
  .piece { background:var(--carte); border:1px solid var(--trait); border-radius:10px; padding:12px 14px; margin:0 0 10px; }
  .tete { display:flex; gap:10px; align-items:flex-start; justify-content:space-between; }
  .nom { font-weight:600; }
  .detail { color:var(--doux); font-size:.88rem; margin-top:2px; }
  .etat { font-size:.85rem; white-space:nowrap; }
  .etat.ok { color:var(--ok); } .etat.manque { color:var(--alerte); }
  ul.fichiers { list-style:none; padding:0; margin:8px 0 0; font-size:.9rem; }
  ul.fichiers li { display:flex; justify-content:space-between; gap:8px; padding:4px 0; border-top:1px dashed var(--trait); word-break:break-all; }
  button, label.bouton { font:inherit; font-size:.9rem; border-radius:8px; border:1px solid var(--accent); background:transparent; color:var(--accent); padding:7px 12px; cursor:pointer; display:inline-block; margin-top:10px; }
  button.lien { border:none; padding:0; margin:0; color:var(--doux); text-decoration:underline; font-size:.85rem; }
  input[type=file] { position:absolute; left:-9999px; }
  .message { position:sticky; bottom:0; margin:12px -16px 0; padding:12px 16px; background:var(--carte); border-top:1px solid var(--trait); font-size:.9rem; }
  .message:empty { display:none; }
  .message.erreur { color:var(--alerte); }
  .vide { color:var(--doux); }
  .actions { display:flex; gap:10px; align-items:center; flex-shrink:0; }
  select { font:inherit; font-size:.85rem; max-width:220px; border:1px solid var(--trait); border-radius:8px; padding:4px 6px; background:var(--carte); color:var(--texte); }
  select.type-autre { display:block; width:100%; max-width:none; margin-top:10px; padding:8px; font-size:.9rem; }
  ul.fichiers li { flex-wrap:wrap; }
</style>
</head>
<body>
<main>
  <h1>Dépôt des pièces</h1>
  <p class="sous" id="titre">Chargement…</p>
  <div class="note">PDF uniquement, 10 Mo au maximum par fichier. Pour une pièce d’identité : copie portant, avant numérisation, la mention manuscrite de conformité à l’original, la date et la signature. Une fois les pièces déposées, revenez à la conversation avec Claude.</div>
  <div id="liste"></div>
  <p class="message" id="message"></p>
</main>
<script src="/vendor/supabase-2.110.2.js"></script>
<script>
(function () {
  var jeton = location.pathname.split('/').filter(Boolean)[1];
  var base = '/depot/' + encodeURIComponent(jeton);
  var CATEGORIES = [['obligatoire', 'Pièces obligatoires'], ['selon_le_cas', 'Selon le cas'], ['facultative', 'Facultatives']];

  function el(tag, cls, texte) { var e = document.createElement(tag); if (cls) e.className = cls; if (texte !== undefined) e.textContent = texte; return e; }
  function message(t, erreur) { var m = document.getElementById('message'); m.textContent = t || ''; m.className = 'message' + (erreur ? ' erreur' : ''); }
  function json(r) { return r.json().catch(function () { return {}; }).then(function (c) { if (!r.ok) throw new Error(c.error || ('Erreur ' + r.status)); return c; }); }
  function appel(methode, url, corps) {
    return fetch(base + url, { method: methode, headers: corps ? { 'Content-Type': 'application/json' } : undefined, body: corps ? JSON.stringify(corps) : undefined }).then(json);
  }
  function taille(o) { return o ? (o > 1048576 ? (o / 1048576).toFixed(1) + ' Mo' : Math.ceil(o / 1024) + ' Ko') : ''; }

  // dest : { cle } pour une ligne de la liste, { code } pour une pièce hors liste.
  function envoyer(dest, fichier) {
    if (!/\\.pdf$/i.test(fichier.name)) { message('« ' + fichier.name + ' » n’est pas un PDF.', true); return Promise.resolve(); }
    if (fichier.size > 10485760) { message('« ' + fichier.name + ' » dépasse 10 Mo.', true); return Promise.resolve(); }
    message('Envoi de « ' + fichier.name + ' »…');
    return appel('POST', '/televersement', { cle: dest.cle, code: dest.code, nom: fichier.name, taille: fichier.size })
      .then(function (t) {
        var client = window.supabase.createClient(t.stockage.url, t.stockage.cle, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
        return client.storage.from(t.stockage.bucket).uploadToSignedUrl(t.chemin, t.jeton_envoi, fichier, { contentType: 'application/pdf' })
          .then(function (r) { if (r.error) throw new Error('Envoi interrompu (' + r.error.message + '). Réessayez.'); return t; });
      })
      .then(function (t) { return appel('POST', '/confirmer', { cle: dest.cle, code: dest.code, chemin: t.chemin, nom: fichier.name }); })
      .then(function (e) { afficher(e); message('« ' + fichier.name + ' » reçu.'); })
      .catch(function (e) { message(e.message, true); });
  }

  function boutonFichier(id, libelle, choisir) {
    var frag = document.createDocumentFragment();
    var champ = el('input'); champ.type = 'file'; champ.accept = 'application/pdf,.pdf'; champ.multiple = true; champ.id = id;
    champ.onchange = function () {
      var fichiers = Array.prototype.slice.call(champ.files || []);
      champ.value = '';
      var dest = choisir();
      if (!dest) return;
      fichiers.reduce(function (suite, f) { return suite.then(function () { return envoyer(dest, f); }); }, Promise.resolve());
    };
    var bouton = el('label', 'bouton', libelle);
    bouton.htmlFor = id;
    frag.appendChild(champ); frag.appendChild(bouton);
    return frag;
  }

  // Liste déroulante des destinations : les lignes de la liste, puis tous les types du guichet.
  function choixDestination(e, actuel) {
    var sel = el('select', 'reclasser');
    sel.appendChild(new Option('Reclasser…', ''));
    var g1 = el('optgroup'); g1.label = 'Pièces de la liste';
    e.pieces.forEach(function (p) { if (p.cle !== actuel) g1.appendChild(new Option(p.piece + (p.personne ? ' — ' + p.personne : ''), 'cle:' + p.cle)); });
    sel.appendChild(g1);
    var g2 = el('optgroup'); g2.label = 'Autre type de pièce';
    e.types.forEach(function (t) { if (t.code !== actuel) g2.appendChild(new Option(t.libelle + ' (' + t.code + ')', 'code:' + t.code)); });
    sel.appendChild(g2);
    return sel;
  }

  function ligneFichier(e, f, actuel) {
    var li = el('li');
    li.appendChild(el('span', '', f.nom + (f.taille ? ' (' + taille(f.taille) + ')' : '')));
    if (e.transmis) return li;
    var actions = el('span', 'actions');
    var sel = choixDestination(e, actuel);
    sel.onchange = function () {
      if (!sel.value) return;
      var v = sel.value.split(':'); var corps = v[0] === 'cle' ? { cle: v.slice(1).join(':') } : { code: v[1] };
      appel('POST', '/pieces/' + f.id + '/reclasser', corps).then(afficher).then(function () { message('« ' + f.nom + ' » reclassé.'); }).catch(function (x) { message(x.message, true); });
    };
    var retirer = el('button', 'lien', 'Retirer');
    retirer.onclick = function () {
      if (!confirm('Retirer « ' + f.nom + ' » ?')) return;
      appel('DELETE', '/pieces/' + f.id).then(afficher).then(function () { message('Fichier retiré.'); }).catch(function (x) { message(x.message, true); });
    };
    actions.appendChild(sel); actions.appendChild(retirer);
    li.appendChild(actions);
    return li;
  }

  function afficher(e) {
    document.getElementById('titre').textContent = [e.societe, e.operations.join(' + '), 'Réf. ' + e.reference].filter(Boolean).join(' — ');
    var liste = document.getElementById('liste');
    liste.textContent = '';
    if (e.transmis) { liste.appendChild(el('p', 'note', 'Ce dossier a été transmis au guichet unique : le dépôt de pièces est fermé.')); }
    CATEGORIES.forEach(function (c) {
      var pieces = e.pieces.filter(function (p) { return p.categorie === c[0]; });
      if (!pieces.length) return;
      liste.appendChild(el('h2', '', c[1]));
      pieces.forEach(function (p) {
        var bloc = el('div', 'piece');
        var tete = el('div', 'tete');
        var gauche = el('div');
        gauche.appendChild(el('div', 'nom', p.piece + (p.personne ? ' — ' + p.personne : '')));
        if (p.condition) gauche.appendChild(el('div', 'detail', p.condition));
        tete.appendChild(gauche);
        tete.appendChild(el('div', 'etat ' + (p.fichiers.length ? 'ok' : (p.categorie === 'obligatoire' ? 'manque' : '')), p.fichiers.length ? 'Reçue' : (p.categorie === 'obligatoire' ? 'À déposer' : '')));
        bloc.appendChild(tete);
        if (p.fichiers.length) {
          var ul = el('ul', 'fichiers');
          p.fichiers.forEach(function (f) { ul.appendChild(ligneFichier(e, f, p.cle)); });
          bloc.appendChild(ul);
        }
        if (!e.transmis) bloc.appendChild(boutonFichier('f-' + p.cle.replace(/[^\\w-]/g, '_'), p.fichiers.length ? 'Ajouter un autre PDF' : 'Choisir le PDF', function () { return { cle: p.cle }; }));
        liste.appendChild(bloc);
      });
    });
    if (!e.pieces.length) liste.appendChild(el('p', 'vide', 'Aucune pièce attendue pour le moment.'));

    // Autre pièce : hors de la liste, d'un type officiel choisi.
    liste.appendChild(el('h2', '', 'Autre pièce'));
    var autre = el('div', 'piece');
    autre.appendChild(el('div', 'detail', 'Une pièce qui ne figure pas dans la liste : choisissez son type, puis le PDF.'));
    if (e.autres.length) {
      var ua = el('ul', 'fichiers');
      e.autres.forEach(function (f) {
        var li = ligneFichier(e, f, f.code);
        li.firstChild.textContent = f.type + ' — ' + li.firstChild.textContent;
        ua.appendChild(li);
      });
      autre.appendChild(ua);
    }
    if (!e.transmis) {
      var type = el('select', 'type-autre');
      type.appendChild(new Option('Type de la pièce…', ''));
      e.types.forEach(function (t) { type.appendChild(new Option(t.libelle + ' (' + t.code + ')', t.code)); });
      autre.appendChild(type);
      autre.appendChild(boutonFichier('f-autre', 'Choisir le PDF', function () {
        if (!type.value) { message('Choisissez d’abord le type de la pièce.', true); return null; }
        return { code: type.value };
      }));
    }
    liste.appendChild(autre);

    var exp = new Date(e.expire);
    if (!isNaN(exp)) liste.appendChild(el('p', 'detail', 'Lien valable jusqu’au ' + exp.toLocaleDateString('fr-FR') + '.'));
  }

  appel('GET', '/etat').then(afficher).catch(function (e) { document.getElementById('titre').textContent = e.message; });
})();
</script>
</body>
</html>`;

module.exports = { routeur, dossierDuLien, etat };
