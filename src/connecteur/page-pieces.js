'use strict';

/**
 * Page de dépôt des pièces, ouverte par l'avocat depuis le lien que Claude lui
 * transmet. Autonome (aucune ressource externe), lisible sur téléphone.
 */

const echapper = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const STYLE = `
:root { --fond:#f6f5f2; --carte:#fff; --texte:#1d1d1b; --doux:#6b6a65; --trait:#e3e1db; --accent:#1f3a5f; --ok:#2e6b3f; --ko:#a33a2a; }
@media (prefers-color-scheme: dark) { :root { --fond:#151513; --carte:#1f1f1c; --texte:#ecebe6; --doux:#a3a29b; --trait:#34342f; --accent:#8fb3e0; --ok:#7cc48e; --ko:#e58a7a; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--fond); color:var(--texte); font:16px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
main { max-width:640px; margin:0 auto; padding:24px 16px 48px; }
h1 { font-size:1.35rem; margin:0 0 4px; }
.sous { color:var(--doux); margin:0 0 20px; font-size:.95rem; }
.piece { background:var(--carte); border:1px solid var(--trait); border-radius:12px; padding:14px 16px; margin-bottom:12px; }
.piece h2 { font-size:1rem; margin:0 0 2px; }
.code { color:var(--doux); font-size:.8rem; }
.etiquette { display:inline-block; font-size:.75rem; padding:1px 8px; border-radius:99px; border:1px solid var(--trait); margin-left:6px; color:var(--doux); }
.recus { list-style:none; margin:10px 0 0; padding:0; }
.recus li { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; border-top:1px solid var(--trait); font-size:.9rem; word-break:break-all; }
.recus li::before { content:"✓"; color:var(--ok); margin-right:6px; }
label.choisir { display:inline-block; margin-top:10px; padding:8px 14px; border-radius:8px; background:var(--accent); color:var(--fond); font-weight:600; cursor:pointer; }
label.choisir input { display:none; }
button.retirer { background:none; border:none; color:var(--ko); font-size:.85rem; cursor:pointer; padding:4px; }
.msg { font-size:.85rem; margin-top:6px; min-height:1.2em; }
.msg.ko { color:var(--ko); } .msg.ok { color:var(--ok); }
.note { color:var(--doux); font-size:.85rem; margin-top:24px; }
`;

function pagePieces({ dossier = null, invalide = false } = {}) {
  if (invalide || !dossier) {
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dépôt des pièces</title><style>${STYLE}</style></head><body><main>
<h1>Lien invalide ou expiré</h1><p class="sous">Demandez à Claude, dans la conversation du dossier, un nouveau lien de dépôt.</p>
</main></body></html>`;
  }
  const pieces = dossier.p.map((p) => `
  <section class="piece" data-code="${echapper(p.code)}">
    <h2>${echapper(p.libelle)}${p.obligatoire ? '' : '<span class="etiquette">facultative</span>'}</h2>
    <div class="code">${echapper(p.code)}</div>
    <ul class="recus"></ul>
    <label class="choisir">Ajouter un PDF<input type="file" accept="application/pdf,.pdf" multiple></label>
    <div class="msg" role="status"></div>
  </section>`).join('');

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Pièces — ${echapper(dossier.ref)}</title><style>${STYLE}</style></head>
<body><main>
<h1>Pièces du dossier</h1>
<p class="sous">${echapper([dossier.d, dossier.f].filter(Boolean).join(' — '))} · ${echapper(dossier.ref)}</p>
${pieces}
<p class="note">PDF uniquement, 10 Mo au maximum par fichier. Les pièces sont effacées du serveur dès leur transmission au Guichet unique.
Une fois le dépôt terminé, revenez dans la conversation et indiquez à Claude que les pièces sont déposées.</p>
</main>
<script>
(function () {
  var j = new URLSearchParams(location.search).get('j');
  var MAX = 10 * 1024 * 1024;
  function api(chemin, corps) {
    return fetch('/api/connecteur/pieces/' + chemin, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ j: j }, corps))
    }).then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Échec'); return d; }); });
  }
  function taille(o) { return o == null ? '' : (o / 1048576).toFixed(1).replace('.', ',') + ' Mo'; }
  function afficher(liste) {
    document.querySelectorAll('.piece').forEach(function (s) {
      var ul = s.querySelector('.recus'); ul.textContent = '';
      liste.filter(function (p) { return p.code === s.dataset.code; }).forEach(function (p) {
        var li = document.createElement('li');
        var nom = document.createElement('span'); nom.textContent = p.nom + (p.taille ? ' · ' + taille(p.taille) : '');
        var b = document.createElement('button'); b.className = 'retirer'; b.type = 'button'; b.textContent = 'Retirer';
        b.onclick = function () { b.disabled = true; api('supprimer', { chemin: p.chemin }).then(rafraichir).catch(function (e) { alert(e.message); b.disabled = false; }); };
        li.appendChild(nom); li.appendChild(b); ul.appendChild(li);
      });
    });
  }
  function rafraichir() {
    return fetch('/api/connecteur/pieces/liste?j=' + encodeURIComponent(j))
      .then(function (r) { return r.json(); }).then(function (d) { afficher(d.pieces || []); });
  }
  function envoyer(section, fichier) {
    var msg = section.querySelector('.msg');
    if (!/\\.pdf$/i.test(fichier.name)) { msg.className = 'msg ko'; msg.textContent = fichier.name + ' : PDF uniquement.'; return Promise.resolve(); }
    if (fichier.size > MAX) { msg.className = 'msg ko'; msg.textContent = fichier.name + ' : plus de 10 Mo.'; return Promise.resolve(); }
    msg.className = 'msg'; msg.textContent = 'Envoi de ' + fichier.name + '…';
    return api('url', { code: section.dataset.code, nom: fichier.name, taille: fichier.size }).then(function (d) {
      var cible = d.mode === 'signe' ? d.url
        : '/api/connecteur/pieces/fichier?j=' + encodeURIComponent(j) + '&chemin=' + encodeURIComponent(d.chemin);
      var methode = d.mode === 'signe' ? 'PUT' : 'POST';
      return fetch(cible, { method: methode, headers: { 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: fichier });
    }).then(function (r) {
      if (!r.ok) throw new Error('Envoi refusé (' + r.status + ')');
      msg.className = 'msg ok'; msg.textContent = fichier.name + ' reçu.';
    }).catch(function (e) { msg.className = 'msg ko'; msg.textContent = fichier.name + ' : ' + e.message; });
  }
  document.querySelectorAll('.piece input[type=file]').forEach(function (input) {
    input.addEventListener('change', function () {
      var section = input.closest('.piece'); var fichiers = Array.prototype.slice.call(input.files);
      fichiers.reduce(function (p, f) { return p.then(function () { return envoyer(section, f); }); }, Promise.resolve())
        .then(rafraichir).then(function () { input.value = ''; });
    });
  });
  rafraichir();
})();
</script>
</body></html>`;
}

module.exports = { pagePieces, echapper };
