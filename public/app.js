'use strict';

/* ================================================================ utils */

const $main = document.getElementById('main');

async function api(method, url, body, isForm) {
  const opts = { method };
  if (body !== undefined && !isForm) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  } else if (body !== undefined) {
    opts.body = body;
  }
  const res = await fetch(`/api${url}`, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Erreur ${res.status}`);
  return json;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const eur = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const num = new Intl.NumberFormat('fr-FR');
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('fr-FR');
}

let toastTimer;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

const STATUT_DOC = {
  a_faire: 'À faire', genere: 'Généré', envoye: 'Envoyé', recu_markup: 'Reçu en markup',
  signe: 'Signé', finalise: 'Finalisé', non_applicable: 'Sans objet',
};
const STATUT_OP = { en_cours: 'En cours', termine: 'Terminée', abandonne: 'Abandonnée' };
const STATUT_FACTURE = { brouillon: 'Brouillon', envoye: 'Envoyé', accepte: 'Accepté', paye: 'Payé' };

function badge(value, labels) {
  return `<span class="badge ${esc(value)}">${esc(labels[value] || value)}</span>`;
}

let referentiel = null;
async function getReferentiel() {
  if (!referentiel) referentiel = await api('GET', '/referentiel');
  return referentiel;
}

/* ================================================================ routeur */

const routes = [
  { re: /^\/?$/, view: dashboard, nav: 'dashboard' },
  { re: /^\/societes$/, view: societesList, nav: 'societes' },
  { re: /^\/societes\/(\d+)$/, view: societeDetail, nav: 'societes' },
  { re: /^\/groupes$/, view: groupesList, nav: 'groupes' },
  { re: /^\/operations$/, view: operationsList, nav: 'operations' },
  { re: /^\/operations\/new$/, view: operationNew, nav: 'operations' },
  { re: /^\/operations\/(\d+)$/, view: operationDetail, nav: 'operations' },
  { re: /^\/factures$/, view: facturesList, nav: 'factures' },
];

async function render() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const route = routes.find((r) => r.re.test(hash));
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === (route?.nav || ''));
  });
  if (!route) { $main.innerHTML = '<div class="empty">Page introuvable</div>'; return; }
  const params = hash.match(route.re).slice(1);
  $main.innerHTML = '<div class="empty">Chargement…</div>';
  try {
    await route.view(...params);
  } catch (e) {
    $main.innerHTML = `<div class="empty">Erreur : ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

/* ================================================================ tableau de bord */

async function dashboard() {
  const d = await api('GET', '/dashboard');
  $main.innerHTML = `
    <div class="page-head"><h1>Tableau de bord</h1>
      <a class="btn btn-primary" href="#/operations/new">Nouvelle opération</a></div>
    <div class="grid cols-4">
      <div class="card"><div class="stat">${d.compteurs.societes}</div><div class="stat-label">Sociétés</div></div>
      <div class="card"><div class="stat">${d.compteurs.groupes}</div><div class="stat-label">Groupes</div></div>
      <div class="card"><div class="stat">${d.compteurs.operations_en_cours}</div><div class="stat-label">Opérations en cours</div></div>
      <div class="card"><div class="stat" style="color:${d.compteurs.documents_manquants ? 'var(--danger)' : 'var(--ok)'}">${d.compteurs.documents_manquants}</div><div class="stat-label">Documents manquants</div></div>
    </div>
    <div class="grid cols-2 mt">
      <div class="card">
        <h2>Opérations en cours</h2>
        ${d.operations.length ? `<table><tbody>${d.operations.map((o) => `
          <tr class="clickable" onclick="location.hash='#/operations/${o.id}'">
            <td>${esc(o.libelle)}<div class="sub">${esc(o.societe_nom)}</div></td>
            <td class="right">${o.docs_manquants ? `<span class="badge a_faire">${o.docs_manquants} doc(s) manquant(s)</span>` : '<span class="badge finalise">complet</span>'}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Aucune opération en cours</div>'}
      </div>
      <div class="card">
        <h2>Documents manquants</h2>
        ${d.manquants.length ? `<table><tbody>${d.manquants.map((m) => `
          <tr class="clickable" onclick="location.hash='#/operations/${m.operation_id}'">
            <td>${esc(m.nom)}<div class="sub">${esc(m.operation_libelle)} — ${esc(m.societe_nom)}</div></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Rien à signaler</div>'}
      </div>
    </div>`;
}

/* ================================================================ sociétés */

async function societesList() {
  const [societes, groupes] = await Promise.all([api('GET', '/societes'), api('GET', '/groupes')]);
  $main.innerHTML = `
    <div class="page-head"><h1>Sociétés</h1>
      <button class="btn-primary" id="btn-new">Nouvelle société</button></div>
    <div class="card">
      ${societes.length ? `<table>
        <thead><tr><th>Dénomination</th><th>Forme</th><th>Capital</th><th>Groupe</th><th>Statut</th><th>Opérations en cours</th></tr></thead>
        <tbody>${societes.map((s) => `
          <tr class="clickable" onclick="location.hash='#/societes/${s.id}'">
            <td><strong>${esc(s.denomination)}</strong><div class="sub">${esc(s.siren || 'SIREN à renseigner')} ${s.rcs_ville ? `RCS ${esc(s.rcs_ville)}` : ''}</div></td>
            <td>${esc(s.forme_sociale)}</td>
            <td>${eur.format(s.capital_social)}</td>
            <td>${esc(s.groupe_nom || '—')}</td>
            <td>${badge(s.statut, { active: 'Active', en_constitution: 'En constitution', radiee: 'Radiée' })}</td>
            <td>${s.operations_en_cours || '—'}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Aucune société. Créez la première fiche.</div>'}
    </div>`;
  document.getElementById('btn-new').onclick = () => societeDialog(groupes);
}

function societeDialog(groupes, societe) {
  const s = societe || {};
  openDialog(`
    <h3>${s.id ? 'Modifier la société' : 'Nouvelle société'}</h3>
    <form id="f">
      <div class="row">
        <label class="field">Dénomination *<input name="denomination" required value="${esc(s.denomination || '')}"></label>
        <label class="field">Forme sociale<select name="forme_sociale">
          ${['SAS', 'SASU', 'SARL', 'EURL', 'SA', 'SCI', 'SNC'].map((f) => `<option ${s.forme_sociale === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select></label>
        <label class="field">Statut<select name="statut">
          <option value="active" ${s.statut === 'active' ? 'selected' : ''}>Active</option>
          <option value="en_constitution" ${s.statut === 'en_constitution' ? 'selected' : ''}>En constitution</option>
          <option value="radiee" ${s.statut === 'radiee' ? 'selected' : ''}>Radiée</option>
        </select></label>
      </div>
      <div class="row">
        <label class="field">Capital social (€)<input name="capital_social" type="number" step="0.01" value="${s.capital_social ?? ''}"></label>
        <label class="field">Nombre de titres<input name="nb_titres" type="number" value="${s.nb_titres ?? ''}"></label>
        <label class="field">Groupe<select name="groupe_id">
          <option value="">— Aucun —</option>
          ${groupes.map((g) => `<option value="${g.id}" ${s.groupe_id === g.id ? 'selected' : ''}>${esc(g.nom)}</option>`).join('')}
        </select></label>
      </div>
      <div class="row">
        <label class="field">Siège social<input name="siege_social" value="${esc(s.siege_social || '')}"></label>
        <label class="field">SIREN<input name="siren" value="${esc(s.siren || '')}"></label>
        <label class="field">Ville du RCS<input name="rcs_ville" value="${esc(s.rcs_ville || '')}"></label>
      </div>
      <label class="field">Objet social (utilisé dans les statuts : « La société a pour objet… »)<textarea name="objet_social">${esc(s.objet_social || '')}</textarea></label>
      <div class="dialog-actions">
        <button type="button" onclick="this.closest('dialog').close()">Annuler</button>
        <button class="btn-primary" type="submit">Enregistrer</button>
      </div>
    </form>`, async (form) => {
    const data = Object.fromEntries(new FormData(form));
    data.groupe_id = data.groupe_id ? Number(data.groupe_id) : null;
    data.capital_social = Number(data.capital_social) || 0;
    data.nb_titres = Number(data.nb_titres) || 0;
    const saved = s.id ? await api('PUT', `/societes/${s.id}`, data) : await api('POST', '/societes', data);
    toast('Société enregistrée');
    location.hash = `#/societes/${saved.id}`;
    if (s.id) render();
  });
}

async function societeDetail(id) {
  const [s, groupes] = await Promise.all([api('GET', `/societes/${id}`), api('GET', '/groupes')]);
  $main.innerHTML = `
    <div class="page-head">
      <div><div class="crumb"><a href="#/societes">Sociétés</a> /</div>
        <h1>${esc(s.denomination)}</h1></div>
      <div>
        <button id="btn-edit">Modifier</button>
        <a class="btn btn-primary" href="#/operations/new?societe=${s.id}">Nouvelle opération</a>
      </div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <h2>Identité</h2>
        <table><tbody>
          <tr><td class="muted">Forme / statut</td><td>${esc(s.forme_sociale)} · ${badge(s.statut, { active: 'Active', en_constitution: 'En constitution', radiee: 'Radiée' })}</td></tr>
          <tr><td class="muted">Capital</td><td>${eur.format(s.capital_social)} — ${num.format(s.nb_titres)} titres</td></tr>
          <tr><td class="muted">Siège</td><td>${esc(s.siege_social || '—')}</td></tr>
          <tr><td class="muted">Immatriculation</td><td>${esc(s.siren || '—')} ${s.rcs_ville ? `RCS ${esc(s.rcs_ville)}` : ''}</td></tr>
          <tr><td class="muted">Groupe</td><td>${esc(s.groupe_nom || '—')}</td></tr>
          <tr><td class="muted">Objet social</td><td>${esc(s.objet_social || '—')}</td></tr>
        </tbody></table>
      </div>
      <div class="card">
        <h2>Dirigeants <button class="btn-sm" id="btn-dirigeant" style="float:right">+ Ajouter</button></h2>
        ${s.dirigeants.length ? `<table><tbody>${s.dirigeants.map((d) => `
          <tr><td>${esc(d.civilite)} ${esc(d.prenom)} ${esc(d.nom)}<div class="sub">${esc(d.adresse || '')}</div></td>
          <td>${esc(d.fonction)}</td>
          <td class="right"><button class="btn-sm btn-danger" data-del-dirigeant="${d.id}">Retirer</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="empty">Aucun dirigeant — requis pour la génération des actes</div>'}
        <h2 class="mt">Associés / actionnaires <button class="btn-sm" id="btn-associe" style="float:right">+ Ajouter</button></h2>
        ${s.associes.length ? `<table><tbody>${s.associes.map((a) => {
          const nom = a.type === 'morale' ? (a.societe_liee_nom || a.denomination) : `${a.civilite} ${a.prenom} ${a.nom}`;
          const pct = s.nb_titres ? Math.round((a.nb_titres / s.nb_titres) * 1000) / 10 : null;
          return `<tr><td>${a.societe_liee_id ? `<a href="#/societes/${a.societe_liee_id}">${esc(nom)}</a>` : esc(nom)}
            <div class="sub">${a.type === 'morale' ? 'Personne morale' : 'Personne physique'}</div></td>
            <td>${num.format(a.nb_titres)} titres${pct !== null ? ` <span class="muted">(${pct} %)</span>` : ''}</td>
            <td class="right"><button class="btn-sm btn-danger" data-del-associe="${a.id}">Retirer</button></td></tr>`;
        }).join('')}</tbody></table>` : '<div class="empty">Aucun associé renseigné</div>'}
      </div>
    </div>
    <div class="card mt">
      <h2>Historique des opérations</h2>
      ${s.operations.length ? `<table>
        <thead><tr><th>Opération</th><th>Statut</th><th>Créée le</th></tr></thead>
        <tbody>${s.operations.map((o) => `
          <tr class="clickable" onclick="location.hash='#/operations/${o.id}'">
            <td>${esc(o.libelle)}</td><td>${badge(o.statut, STATUT_OP)}</td><td>${fmtDate(o.created_at)}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Aucune opération pour cette société</div>'}
    </div>`;

  document.getElementById('btn-edit').onclick = () => societeDialog(groupes, s);
  document.getElementById('btn-dirigeant').onclick = () => openDialog(`
    <h3>Nouveau dirigeant</h3>
    <form id="f">
      <div class="row">
        <label class="field">Civilité<select name="civilite"><option>M.</option><option>Mme</option></select></label>
        <label class="field">Prénom<input name="prenom"></label>
        <label class="field">Nom *<input name="nom" required></label>
      </div>
      <div class="row">
        <label class="field">Fonction<select name="fonction">
          ${['Président', 'Présidente', 'Directeur général', 'Directrice générale', 'Gérant', 'Gérante'].map((f) => `<option>${f}</option>`).join('')}
        </select></label>
        <label class="field">Adresse<input name="adresse"></label>
      </div>
      <div class="dialog-actions">
        <button type="button" onclick="this.closest('dialog').close()">Annuler</button>
        <button class="btn-primary" type="submit">Ajouter</button>
      </div>
    </form>`, async (form) => {
    await api('POST', `/societes/${s.id}/dirigeants`, Object.fromEntries(new FormData(form)));
    toast('Dirigeant ajouté'); render();
  });

  document.getElementById('btn-associe').onclick = async () => {
    const societes = await api('GET', '/societes');
    openDialog(`
      <h3>Nouvel associé</h3>
      <form id="f">
        <label class="check"><input type="radio" name="type" value="physique" checked> Personne physique</label>
        <label class="check"><input type="radio" name="type" value="morale"> Personne morale (société)</label>
        <div class="row" data-if="physique">
          <label class="field">Civilité<select name="civilite"><option>M.</option><option>Mme</option></select></label>
          <label class="field">Prénom<input name="prenom"></label>
          <label class="field">Nom<input name="nom"></label>
        </div>
        <div class="row" data-if="morale" hidden>
          <label class="field">Société du référentiel (alimente l’organigramme)<select name="societe_liee_id">
            <option value="">— Société externe —</option>
            ${societes.filter((x) => x.id !== s.id).map((x) => `<option value="${x.id}">${esc(x.denomination)}</option>`).join('')}
          </select></label>
          <label class="field">Ou dénomination externe<input name="denomination"></label>
        </div>
        <div class="row">
          <label class="field">Nombre de titres *<input name="nb_titres" type="number" required></label>
          <label class="field">Adresse<input name="adresse"></label>
        </div>
        <div class="dialog-actions">
          <button type="button" onclick="this.closest('dialog').close()">Annuler</button>
          <button class="btn-primary" type="submit">Ajouter</button>
        </div>
      </form>`, async (form) => {
      const data = Object.fromEntries(new FormData(form));
      data.nb_titres = Number(data.nb_titres) || 0;
      data.societe_liee_id = data.societe_liee_id ? Number(data.societe_liee_id) : null;
      await api('POST', `/societes/${s.id}/associes`, data);
      toast('Associé ajouté'); render();
    }, (dlg) => {
      dlg.querySelectorAll('input[name=type]').forEach((r) => r.addEventListener('change', () => {
        const val = dlg.querySelector('input[name=type]:checked').value;
        dlg.querySelectorAll('[data-if]').forEach((el) => { el.hidden = el.dataset.if !== val; });
      }));
    });
  };

  $main.querySelectorAll('[data-del-dirigeant]').forEach((b) => {
    b.onclick = async (e) => { e.stopPropagation(); await api('DELETE', `/dirigeants/${b.dataset.delDirigeant}`); render(); };
  });
  $main.querySelectorAll('[data-del-associe]').forEach((b) => {
    b.onclick = async (e) => { e.stopPropagation(); await api('DELETE', `/associes/${b.dataset.delAssocie}`); render(); };
  });
}

/* ================================================================ groupes */

function orgNode(n) {
  return `<li>
    <span class="org-node">
      ${n.pourcentage != null ? `<span class="pct">${n.pourcentage} %</span>` : ''}
      <a href="#/societes/${n.id}">${esc(n.denomination)}</a>
      <span class="forme">${esc(n.forme_sociale)}</span>
    </span>
    ${n.filles.length ? `<ul>${n.filles.map(orgNode).join('')}</ul>` : ''}
  </li>`;
}

async function groupesList() {
  const groupes = await api('GET', '/groupes');
  $main.innerHTML = `
    <div class="page-head"><h1>Groupes</h1>
      <button class="btn-primary" id="btn-new">Nouveau groupe</button></div>
    <div id="groupes" class="grid"></div>`;
  const container = document.getElementById('groupes');
  if (!groupes.length) container.innerHTML = '<div class="card empty">Aucun groupe. Un groupe rassemble des sociétés liées et donne la vision consolidée.</div>';
  for (const g of groupes) {
    const orga = await api('GET', `/groupes/${g.id}/organigramme`);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h2>${esc(g.nom)} <span class="muted" style="text-transform:none">— ${g.nb_societes} société(s)</span></h2>
      ${g.description ? `<p class="muted" style="margin-bottom:12px">${esc(g.description)}</p>` : ''}
      ${orga.racines.length
        ? `<div class="org-tree"><ul style="border:none;padding-left:0;margin:0">${orga.racines.map(orgNode).join('')}</ul></div>`
        : '<div class="empty">Rattachez des sociétés à ce groupe (fiche société), puis déclarez les participations comme associés de type « personne morale ».</div>'}`;
    container.appendChild(card);
  }
  document.getElementById('btn-new').onclick = () => openDialog(`
    <h3>Nouveau groupe</h3>
    <form id="f">
      <label class="field">Nom *<input name="nom" required></label>
      <label class="field">Description<textarea name="description"></textarea></label>
      <div class="dialog-actions">
        <button type="button" onclick="this.closest('dialog').close()">Annuler</button>
        <button class="btn-primary" type="submit">Créer</button>
      </div>
    </form>`, async (form) => {
    await api('POST', '/groupes', Object.fromEntries(new FormData(form)));
    toast('Groupe créé'); render();
  });
}

/* ================================================================ opérations */

async function operationsList() {
  const [operations, ref] = await Promise.all([api('GET', '/operations'), getReferentiel()]);
  const typeLabel = Object.fromEntries(ref.types.map((t) => [t.code, t.libelle]));
  $main.innerHTML = `
    <div class="page-head"><h1>Opérations</h1>
      <a class="btn btn-primary" href="#/operations/new">Nouvelle opération</a></div>
    <div class="card">
      ${operations.length ? `<table>
        <thead><tr><th>Opération</th><th>Type</th><th>Société</th><th>Checklist</th><th>Statut</th></tr></thead>
        <tbody>${operations.map((o) => `
          <tr class="clickable" onclick="location.hash='#/operations/${o.id}'">
            <td><strong>${esc(o.libelle)}</strong><div class="sub">${fmtDate(o.created_at)}</div></td>
            <td>${esc(typeLabel[o.type] || o.type)}</td>
            <td>${esc(o.societe_nom)}</td>
            <td>${o.docs_manquants ? `<span class="badge a_faire">${o.docs_manquants} / ${o.docs_total} manquant(s)</span>` : `<span class="badge finalise">${o.docs_total} / ${o.docs_total}</span>`}</td>
            <td>${badge(o.statut, STATUT_OP)}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Aucune opération</div>'}
    </div>`;
}

/* --- formulaire de variables généré depuis le référentiel --- */

function fieldHtml(f, value) {
  const v = value ?? f.default ?? '';
  if (f.type === 'checkbox') {
    return `<label class="check" data-var="${f.name}"><input type="checkbox" name="var:${f.name}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
  }
  if (f.type === 'select') {
    return `<label class="field" data-var="${f.name}">${esc(f.label)}${f.required ? ' *' : ''}
      <select name="var:${f.name}" ${f.required ? 'required' : ''}>
        ${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${v === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select></label>`;
  }
  const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
  return `<label class="field" data-var="${f.name}">${esc(f.label)}${f.required ? ' *' : ''}
    <input type="${type}" ${type === 'number' ? 'step="any"' : ''} name="var:${f.name}" value="${esc(v)}" ${f.required ? 'required' : ''}></label>`;
}

function listFieldHtml(f, values) {
  const rows = (values && values.length ? values : [{}]);
  return `<fieldset class="list-field" data-var="${f.name}" data-list="${f.name}">
    <legend>${esc(f.label)}${f.required ? ' *' : ''}</legend>
    <div class="list-items">${rows.map((row) => listRowHtml(f, row)).join('')}</div>
    <button type="button" class="btn-sm" data-add-row="${f.name}">+ Ajouter une ligne</button>
  </fieldset>`;
}

function listRowHtml(f, row) {
  return `<div class="list-item">
    ${f.fields.map((sub) => `<label class="field">${esc(sub.label)}
      <input type="${sub.type === 'number' ? 'number' : sub.type === 'date' ? 'date' : 'text'}" ${sub.type === 'number' ? 'step="any"' : ''} data-sub="${sub.name}" value="${esc(row[sub.name] ?? '')}"></label>`).join('')}
    <button type="button" class="btn-sm btn-danger" data-del-row title="Supprimer la ligne">×</button>
  </div>`;
}

function variablesFormHtml(typeDef, values = {}) {
  return typeDef.variables.map((f) => (
    f.type === 'list' ? listFieldHtml(f, values[f.name]) : fieldHtml(f, values[f.name])
  )).join('');
}

function wireVariablesForm(container, typeDef) {
  // Lignes dynamiques des champs liste.
  container.querySelectorAll('[data-add-row]').forEach((btn) => {
    btn.onclick = () => {
      const f = typeDef.variables.find((x) => x.name === btn.dataset.addRow);
      btn.previousElementSibling.insertAdjacentHTML('beforeend', listRowHtml(f, {}));
      wireRowDeletes(container);
    };
  });
  wireRowDeletes(container);
  // Affichage conditionnel (showIf: 'variable' ou 'variable:valeur').
  const applyShowIf = () => {
    for (const f of typeDef.variables) {
      if (!f.showIf) continue;
      const [dep, expected] = f.showIf.split(':');
      const input = container.querySelector(`[name="var:${dep}"]`);
      if (!input) continue;
      const current = input.type === 'checkbox' ? input.checked : input.value;
      const visible = expected !== undefined ? current === expected : Boolean(current);
      const el = container.querySelector(`[data-var="${f.name}"]`);
      if (el) el.hidden = !visible;
    }
  };
  container.addEventListener('change', applyShowIf);
  applyShowIf();
}

function wireRowDeletes(container) {
  container.querySelectorAll('[data-del-row]').forEach((btn) => {
    btn.onclick = () => {
      const items = btn.closest('.list-items');
      btn.closest('.list-item').remove();
      if (!items.children.length) items.insertAdjacentHTML('beforeend', '<div class="muted" style="padding:6px">Aucune ligne</div>');
    };
  });
}

function collectVariables(container, typeDef) {
  const out = {};
  for (const f of typeDef.variables) {
    if (f.type === 'list') {
      out[f.name] = [...container.querySelectorAll(`[data-list="${f.name}"] .list-item`)].map((row) => {
        const item = {};
        for (const sub of f.fields) {
          const input = row.querySelector(`[data-sub="${sub.name}"]`);
          item[sub.name] = sub.type === 'number' ? Number(input.value) || 0 : input.value;
        }
        return item;
      }).filter((item) => Object.values(item).some((v) => v !== '' && v !== 0));
    } else {
      const input = container.querySelector(`[name="var:${f.name}"]`);
      if (!input) continue;
      if (f.type === 'checkbox') out[f.name] = input.checked;
      else if (f.type === 'number') out[f.name] = input.value === '' ? '' : Number(input.value);
      else out[f.name] = input.value;
    }
  }
  return out;
}

async function operationNew() {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const [societes, ref] = await Promise.all([api('GET', '/societes'), getReferentiel()]);
  if (!societes.length) {
    $main.innerHTML = '<div class="card empty">Créez d’abord une <a href="#/societes">fiche société</a>.</div>';
    return;
  }
  $main.innerHTML = `
    <div class="page-head">
      <div><div class="crumb"><a href="#/operations">Opérations</a> /</div><h1>Nouvelle opération</h1></div>
    </div>
    <div class="card">
      <form id="f">
        <div class="row">
          <label class="field">Société *<select name="societe_id" required>
            ${societes.map((s) => `<option value="${s.id}" ${String(s.id) === query.get('societe') ? 'selected' : ''}>${esc(s.denomination)}</option>`).join('')}
          </select></label>
          <label class="field">Type d’opération *<select name="type" id="sel-type" required>
            ${ref.types.map((t) => `<option value="${t.code}">${esc(t.libelle)}</option>`).join('')}
          </select></label>
          <label class="field">Libellé du dossier<input name="libelle" placeholder="ex. Cession Martin → Holding"></label>
        </div>
        <div class="card" style="background:#faf9f5">
          <h2>Variables de l’opération <span class="muted" style="text-transform:none">— saisies une seule fois, réutilisées dans tous les documents</span></h2>
          <div id="vars"></div>
        </div>
        <div class="card mt" style="background:#faf9f5">
          <h2>Documents qui seront produits</h2>
          <div id="doclist"></div>
        </div>
        <div class="dialog-actions">
          <a class="btn" href="#/operations">Annuler</a>
          <button class="btn-primary" type="submit">Créer l’opération</button>
        </div>
      </form>
    </div>`;

  const selType = document.getElementById('sel-type');
  const varsEl = document.getElementById('vars');
  const docsEl = document.getElementById('doclist');
  const refresh = () => {
    const typeDef = ref.types.find((t) => t.code === selType.value);
    varsEl.innerHTML = variablesFormHtml(typeDef);
    wireVariablesForm(varsEl, typeDef);
    docsEl.innerHTML = `<table><tbody>${typeDef.documents.map((d) => `
      <tr><td>${esc(d.nom)}</td>
      <td class="right muted">${d.condition ? `si « ${esc(labelOfVar(typeDef, d.condition))} »` : d.obligatoire ? 'obligatoire' : 'optionnel'}</td></tr>`).join('')}</tbody></table>`;
  };
  selType.addEventListener('change', refresh);
  refresh();

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const typeDef = ref.types.find((t) => t.code === selType.value);
    const form = e.target;
    try {
      const op = await api('POST', '/operations', {
        societe_id: Number(form.societe_id.value),
        type: selType.value,
        libelle: form.libelle.value || undefined,
        variables: collectVariables(varsEl, typeDef),
      });
      toast('Opération créée — vous pouvez générer les documents');
      location.hash = `#/operations/${op.id}`;
    } catch (err) { toast(err.message, true); }
  });
}

function labelOfVar(typeDef, name) {
  return typeDef.variables.find((v) => v.name === name)?.label || name;
}

async function operationDetail(id) {
  const [op, ref] = await Promise.all([api('GET', `/operations/${id}`), getReferentiel()]);
  const typeDef = ref.types.find((t) => t.code === op.type);
  const manquants = op.manquants.length;

  $main.innerHTML = `
    <div class="page-head">
      <div><div class="crumb"><a href="#/operations">Opérations</a> / ${esc(typeDef?.libelle || op.type)} /</div>
        <h1>${esc(op.libelle)}</h1>
        <div class="muted">Société : <a href="#/societes/${op.societe_id}">${esc(op.societe_nom)}</a> · ${badge(op.statut, STATUT_OP)}</div></div>
      <div>
        <button id="btn-vars">Variables de l’opération</button>
        <select id="sel-statut" title="Statut de l’opération">
          ${Object.entries(STATUT_OP).map(([v, l]) => `<option value="${v}" ${op.statut === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="gen-banner">
      <div>
        <strong>Génération en un clic</strong>
        <div class="hint">Produit l’intégralité des documents de la checklist à partir des variables saisies et de la fiche société.</div>
      </div>
      <button class="btn-gold" id="btn-generer">Générer tous les documents</button>
    </div>

    <div class="card">
      <h2>Checklist — ${manquants ? `<span style="color:var(--danger)">${manquants} document(s) obligatoire(s) manquant(s)</span>` : '<span style="color:var(--ok)">complète</span>'}</h2>
      <table>
        <thead><tr><th></th><th>Document</th><th>Statut</th><th>Versions</th><th>Actions</th></tr></thead>
        <tbody>
          ${op.documents.map((d) => {
            const done = !['a_faire'].includes(d.statut);
            const na = d.statut === 'non_applicable';
            const last = d.versions[0];
            return `<tr ${na ? 'style="opacity:.55"' : ''}>
              <td><span class="check-icon">${na ? '—' : done ? '✅' : '⬜'}</span></td>
              <td>${esc(d.nom)}${d.obligatoire ? '' : ' <span class="muted">(optionnel)</span>'}</td>
              <td><select data-statut-doc="${d.id}" class="btn-sm">
                ${Object.entries(STATUT_DOC).map(([v, l]) => `<option value="${v}" ${d.statut === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></td>
              <td>${d.versions.length ? d.versions.map((v) => `
                <div><a href="/api/versions/${v.id}/download">v${v.numero}</a>
                <span class="muted">· ${v.source === 'genere' ? 'générée' : v.source === 'recu' ? 'reçue' : 'importée'} · ${fmtDate(v.created_at)}</span></div>`).join('')
                : '<span class="muted">—</span>'}</td>
              <td style="white-space:nowrap">
                ${last ? `<a class="btn btn-sm" href="/api/versions/${last.id}/download">Télécharger</a>` : ''}
                <button class="btn-sm" data-upload="${d.id}">Déposer une version</button>
                ${d.versions.filter((v) => v.source === 'recu').length && d.versions.filter((v) => v.source !== 'recu').length
                  ? `<button class="btn-sm" data-compare="${d.id}">Comparer le markup</button>` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div id="diff-zone"></div>

    <div class="card mt">
      <h2>Devis / factures de l’opération <button class="btn-sm" id="btn-facture" style="float:right">+ Nouveau</button></h2>
      ${op.factures.length ? factureTable(op.factures, false) : '<div class="empty">Aucun devis ni facture</div>'}
    </div>
    <input type="file" id="file-input" accept=".docx,.pdf" hidden>`;

  document.getElementById('sel-statut').onchange = async (e) => {
    await api('PUT', `/operations/${op.id}`, { statut: e.target.value });
    toast('Statut mis à jour'); render();
  };

  document.getElementById('btn-generer').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Génération…';
    try {
      const r = await api('POST', `/operations/${op.id}/generer`);
      toast(`${r.generes.length} document(s) généré(s)${r.non_applicables.length ? ` — ${r.non_applicables.length} sans objet` : ''}`);
      render();
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
      e.target.textContent = 'Générer tous les documents';
    }
  };

  document.getElementById('btn-vars').onclick = () => openDialog(`
    <h3>Variables de l’opération</h3>
    <p class="muted" style="margin-bottom:14px">Saisies une seule fois : chaque document généré les réutilise. Regénérez après modification.</p>
    <form id="f"><div id="dlg-vars">${variablesFormHtml(typeDef, op.variables)}</div>
      <div class="dialog-actions">
        <button type="button" onclick="this.closest('dialog').close()">Annuler</button>
        <button class="btn-primary" type="submit">Enregistrer</button>
      </div>
    </form>`, async (form) => {
    await api('PUT', `/operations/${op.id}`, { variables: collectVariables(form.querySelector('#dlg-vars'), typeDef) });
    toast('Variables enregistrées — pensez à regénérer les documents');
    render();
  }, (dlg) => wireVariablesForm(dlg.querySelector('#dlg-vars'), typeDef));

  const fileInput = document.getElementById('file-input');
  $main.querySelectorAll('[data-upload]').forEach((btn) => {
    btn.onclick = () => {
      fileInput.onchange = async () => {
        if (!fileInput.files.length) return;
        const fd = new FormData();
        fd.append('fichier', fileInput.files[0]);
        fd.append('source', 'recu');
        try {
          await api('POST', `/documents/${btn.dataset.upload}/versions`, fd, true);
          toast('Version déposée (reçue en markup)');
          render();
        } catch (err) { toast(err.message, true); }
        fileInput.value = '';
      };
      fileInput.click();
    };
  });

  $main.querySelectorAll('[data-statut-doc]').forEach((sel) => {
    sel.onchange = async () => {
      await api('PUT', `/documents/${sel.dataset.statutDoc}`, { statut: sel.value });
      toast('Statut du document mis à jour'); render();
    };
  });

  $main.querySelectorAll('[data-compare]').forEach((btn) => {
    btn.onclick = async () => {
      const zone = document.getElementById('diff-zone');
      zone.innerHTML = '<div class="card mt empty">Comparaison en cours…</div>';
      try {
        const cmp = await api('GET', `/documents/${btn.dataset.compare}/compare`);
        const doc = op.documents.find((d) => d.id === Number(btn.dataset.compare));
        zone.innerHTML = `
          <div class="card mt">
            <h2>Markup — ${esc(doc.nom)} <button class="btn-sm" style="float:right" onclick="document.getElementById('diff-zone').innerHTML=''">Fermer</button></h2>
            <p class="muted" style="margin-bottom:12px">
              Version envoyée v${cmp.from.numero} (${esc(cmp.from.filename)}) → version reçue v${cmp.to.numero} (${esc(cmp.to.filename)}) ·
              ${cmp.stats.identique ? 'aucune modification détectée' : `<ins style="background:#d8f2e0;text-decoration:none">&nbsp;${cmp.stats.ajouts} ajout(s)&nbsp;</ins> <del style="background:#fadada">&nbsp;${cmp.stats.suppressions} suppression(s)&nbsp;</del>`}
            </p>
            <div class="diff">${cmp.segments.map((s) => s.added ? `<ins>${esc(s.value)}</ins>` : s.removed ? `<del>${esc(s.value)}</del>` : esc(s.value)).join('')}</div>
          </div>`;
        zone.scrollIntoView({ behavior: 'smooth' });
      } catch (err) {
        zone.innerHTML = '';
        toast(err.message, true);
      }
    };
  });

  document.getElementById('btn-facture').onclick = () => factureDialog(op.id, () => render());
}

/* ================================================================ facturation */

function totaux(f) {
  const ht = f.lignes.reduce((s, l) => s + (Number(l.quantite) || 0) * (Number(l.prix_unitaire) || 0), 0);
  const tva = ht * (f.taux_tva / 100);
  return { ht, tva, ttc: ht + tva };
}

function factureTable(factures, withContext) {
  return `<table>
    <thead><tr><th>Numéro</th>${withContext ? '<th>Client / opération</th>' : ''}<th>Mode</th><th>Total HT</th><th>Total TTC</th><th>Statut</th><th></th></tr></thead>
    <tbody>${factures.map((f) => {
      const t = totaux(f);
      return `<tr>
        <td><strong>${esc(f.numero)}</strong><div class="sub">${f.type === 'devis' ? 'Devis' : 'Facture'} · ${fmtDate(f.created_at)}</div></td>
        ${withContext ? `<td>${esc(f.societe_nom)}<div class="sub"><a href="#/operations/${f.operation_id}">${esc(f.operation_libelle)}</a></div></td>` : ''}
        <td>${f.mode === 'forfait' ? 'Forfait' : 'Temps passé'}</td>
        <td>${eur.format(t.ht)}</td>
        <td>${eur.format(t.ttc)}</td>
        <td><select data-statut-facture="${f.id}" class="btn-sm">
          ${Object.entries(STATUT_FACTURE).map(([v, l]) => `<option value="${v}" ${f.statut === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></td>
        <td class="right" style="white-space:nowrap">
          <button class="btn-sm" data-print-facture="${f.id}">Imprimer</button>
          <button class="btn-sm btn-danger" data-del-facture="${f.id}">Supprimer</button>
        </td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function wireFactureActions(factures, onChange) {
  $main.querySelectorAll('[data-statut-facture]').forEach((sel) => {
    sel.onchange = async () => {
      await api('PUT', `/factures/${sel.dataset.statutFacture}`, { statut: sel.value });
      toast('Statut mis à jour'); onChange();
    };
  });
  $main.querySelectorAll('[data-del-facture]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Supprimer ce document de facturation ?')) return;
      await api('DELETE', `/factures/${btn.dataset.delFacture}`);
      toast('Supprimé'); onChange();
    };
  });
  $main.querySelectorAll('[data-print-facture]').forEach((btn) => {
    btn.onclick = () => {
      const f = factures.find((x) => x.id === Number(btn.dataset.printFacture));
      if (f) printFacture(f);
    };
  });
}

function printFacture(f) {
  const t = totaux(f);
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${esc(f.numero)}</title>
    <style>body{font-family:Georgia,serif;max-width:720px;margin:48px auto;color:#1c1c1a}
    h1{font-size:22px;margin-bottom:4px}.muted{color:#6d6d66}table{width:100%;border-collapse:collapse;margin:24px 0}
    th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}td.r,th.r{text-align:right}
    .tot{margin-top:12px;text-align:right;font-size:15px}</style></head><body>
    <h1>${f.type === 'devis' ? 'Devis' : 'Facture'} ${esc(f.numero)}</h1>
    <div class="muted">${esc(f.societe_nom || '')} — ${esc(f.operation_libelle || '')} · ${fmtDate(f.created_at)} · ${f.mode === 'forfait' ? 'forfait' : 'temps passé'}</div>
    <table><thead><tr><th>Description</th><th class="r">${f.mode === 'forfait' ? 'Qté' : 'Heures'}</th><th class="r">PU HT</th><th class="r">Total HT</th></tr></thead>
    <tbody>${f.lignes.map((l) => `<tr><td>${esc(l.description)}</td><td class="r">${l.quantite}</td>
      <td class="r">${eur.format(l.prix_unitaire)}</td><td class="r">${eur.format((l.quantite || 0) * (l.prix_unitaire || 0))}</td></tr>`).join('')}</tbody></table>
    <div class="tot">Total HT : ${eur.format(t.ht)}<br>TVA ${f.taux_tva} % : ${eur.format(t.tva)}<br><strong>Total TTC : ${eur.format(t.ttc)}</strong></div>
    <script>window.print()<\/script></body></html>`);
  w.document.close();
}

function factureDialog(operationId, onDone) {
  openDialog(`
    <h3>Nouveau devis / facture</h3>
    <form id="f">
      <div class="row">
        <label class="field">Type<select name="type"><option value="devis">Devis</option><option value="facture">Facture</option></select></label>
        <label class="field">Mode<select name="mode"><option value="forfait">Forfait</option><option value="temps">Temps passé</option></select></label>
        <label class="field">TVA (%)<input name="taux_tva" type="number" step="0.1" value="20"></label>
      </div>
      <fieldset class="list-field"><legend>Lignes</legend>
        <div class="list-items" id="lignes">
          <div class="list-item">
            <label class="field" style="grid-column:span 2">Description<input data-sub="description"></label>
            <label class="field">Qté / heures<input data-sub="quantite" type="number" step="any" value="1"></label>
            <label class="field">PU HT (€)<input data-sub="prix_unitaire" type="number" step="any"></label>
            <button type="button" class="btn-sm btn-danger" data-del-row>×</button>
          </div>
        </div>
        <button type="button" class="btn-sm" id="add-ligne">+ Ajouter une ligne</button>
      </fieldset>
      <div class="dialog-actions">
        <button type="button" onclick="this.closest('dialog').close()">Annuler</button>
        <button class="btn-primary" type="submit">Créer</button>
      </div>
    </form>`, async (form) => {
    const lignes = [...form.querySelectorAll('#lignes .list-item')].map((row) => ({
      description: row.querySelector('[data-sub=description]').value,
      quantite: Number(row.querySelector('[data-sub=quantite]').value) || 0,
      prix_unitaire: Number(row.querySelector('[data-sub=prix_unitaire]').value) || 0,
    })).filter((l) => l.description);
    await api('POST', '/factures', {
      operation_id: operationId,
      type: form.type.value,
      mode: form.mode.value,
      taux_tva: Number(form.taux_tva.value) || 20,
      lignes,
    });
    toast('Créé'); onDone();
  }, (dlg) => {
    dlg.querySelector('#add-ligne').onclick = () => {
      dlg.querySelector('#lignes').insertAdjacentHTML('beforeend', `
        <div class="list-item">
          <label class="field" style="grid-column:span 2">Description<input data-sub="description"></label>
          <label class="field">Qté / heures<input data-sub="quantite" type="number" step="any" value="1"></label>
          <label class="field">PU HT (€)<input data-sub="prix_unitaire" type="number" step="any"></label>
          <button type="button" class="btn-sm btn-danger" data-del-row>×</button>
        </div>`);
      wireRowDeletes(dlg);
    };
    wireRowDeletes(dlg);
  });
}

async function facturesList() {
  const factures = await api('GET', '/factures');
  const totalEncours = factures.filter((f) => f.type === 'facture' && f.statut !== 'paye').reduce((s, f) => s + totaux(f).ttc, 0);
  const totalPaye = factures.filter((f) => f.statut === 'paye').reduce((s, f) => s + totaux(f).ttc, 0);
  $main.innerHTML = `
    <div class="page-head"><h1>Facturation</h1></div>
    <div class="grid cols-2">
      <div class="card"><div class="stat">${eur.format(totalEncours)}</div><div class="stat-label">Factures en attente de paiement (TTC)</div></div>
      <div class="card"><div class="stat">${eur.format(totalPaye)}</div><div class="stat-label">Encaissé (TTC)</div></div>
    </div>
    <div class="card mt">
      ${factures.length ? factureTable(factures, true) : '<div class="empty">Aucun devis ni facture. Créez-les depuis la page d’une opération.</div>'}
    </div>`;
  wireFactureActions(factures, render);
}

/* ================================================================ dialog helper */

function openDialog(html, onSubmit, onOpen) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const form = dlg.querySelector('form');
  if (form && onSubmit) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await onSubmit(form);
        dlg.close();
      } catch (err) { toast(err.message, true); }
    });
  }
  if (onOpen) onOpen(dlg);
  dlg.showModal();
}
