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
const { empreinte, ORIGINE } = require('./service');

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
  };
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
  const { cle, nom, taille } = req.body || {};
  const piece = (await etat(f)).pieces.find((p) => p.cle === cle);
  if (!piece) throw erreur('Pièce inconnue pour ce dossier.');
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
  const { cle, chemin, nom } = req.body || {};
  const piece = (await etat(f)).pieces.find((p) => p.cle === cle);
  if (!piece) throw erreur('Pièce inconnue pour ce dossier.');
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

  function envoyer(piece, fichier) {
    if (!/\\.pdf$/i.test(fichier.name)) { message('« ' + fichier.name + ' » n’est pas un PDF.', true); return Promise.resolve(); }
    if (fichier.size > 10485760) { message('« ' + fichier.name + ' » dépasse 10 Mo.', true); return Promise.resolve(); }
    message('Envoi de « ' + fichier.name + ' »…');
    return appel('POST', '/televersement', { cle: piece.cle, nom: fichier.name, taille: fichier.size })
      .then(function (t) {
        var client = window.supabase.createClient(t.stockage.url, t.stockage.cle, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
        return client.storage.from(t.stockage.bucket).uploadToSignedUrl(t.chemin, t.jeton_envoi, fichier, { contentType: 'application/pdf' })
          .then(function (r) { if (r.error) throw new Error('Envoi interrompu (' + r.error.message + '). Réessayez.'); return t; });
      })
      .then(function (t) { return appel('POST', '/confirmer', { cle: piece.cle, chemin: t.chemin, nom: fichier.name }); })
      .then(function (e) { afficher(e); message('« ' + fichier.name + ' » reçu.'); })
      .catch(function (e) { message(e.message, true); });
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
          p.fichiers.forEach(function (f) {
            var li = el('li');
            li.appendChild(el('span', '', f.nom + (f.taille ? ' (' + taille(f.taille) + ')' : '')));
            if (!e.transmis) {
              var retirer = el('button', 'lien', 'Retirer');
              retirer.onclick = function () {
                if (!confirm('Retirer « ' + f.nom + ' » ?')) return;
                appel('DELETE', '/pieces/' + f.id).then(afficher).then(function () { message('Fichier retiré.'); }).catch(function (x) { message(x.message, true); });
              };
              li.appendChild(retirer);
            }
            ul.appendChild(li);
          });
          bloc.appendChild(ul);
        }
        if (!e.transmis) {
          var id = 'f-' + p.cle.replace(/[^\\w-]/g, '_');
          var champ = el('input'); champ.type = 'file'; champ.accept = 'application/pdf,.pdf'; champ.multiple = true; champ.id = id;
          champ.onchange = function () {
            var fichiers = Array.prototype.slice.call(champ.files || []);
            champ.value = '';
            fichiers.reduce(function (suite, f) { return suite.then(function () { return envoyer(p, f); }); }, Promise.resolve());
          };
          var bouton = el('label', 'bouton', p.fichiers.length ? 'Ajouter un autre PDF' : 'Choisir le PDF');
          bouton.htmlFor = id;
          bloc.appendChild(champ); bloc.appendChild(bouton);
        }
        liste.appendChild(bloc);
      });
    });
    if (!e.pieces.length) liste.appendChild(el('p', 'vide', 'Aucune pièce attendue pour le moment.'));
    var exp = new Date(e.expire);
    if (!isNaN(exp)) liste.appendChild(el('p', 'detail', 'Lien valable jusqu’au ' + exp.toLocaleDateString('fr-FR') + '.'));
  }

  appel('GET', '/etat').then(afficher).catch(function (e) { document.getElementById('titre').textContent = e.message; });
})();
</script>
</body>
</html>`;

module.exports = { routeur, dossierDuLien, etat };
