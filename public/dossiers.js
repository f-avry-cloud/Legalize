'use strict';

/* =========================================================================
   Dossiers : le suivi des missions du cabinet.

   Trois vues, une par famille de dossiers :
   — haut de bilan : cartes avec l'avancement par étapes ;
   — secrétariat : tableau par société, étape en cours, prochaine échéance ;
   — conseil : liste des questions et des réponses attendues.
   La fiche d'un dossier réunit étapes, tâches, échéances, sociétés
   concernées, travaux rattachés et chronologie. La fiche client réunit les
   dossiers des trois familles, les contacts et les échéances.
   ========================================================================= */

let dosCat = null;
async function dosCatalogue(force) {
  if (!dosCat || force) dosCat = await api('GET', '/dossiers/catalogue');
  return dosCat;
}
let dosMembresCache = null;
async function dosMembres() {
  if (!dosMembresCache) dosMembresCache = await api('GET', '/membres');
  return dosMembresCache;
}

const DOS_FAMILLES = ['haut_de_bilan', 'secretariat', 'conseil'];
const DOS_STATUTS_ETAPE = { a_faire: 'À faire', en_cours: 'En cours', fait: 'Fait', sans_objet: 'Sans objet' };

/** Retard, proche (15 jours) ou à venir : la couleur d'une date d'échéance. */
function dosClasseDate(iso) {
  if (!iso) return '';
  const jours = Math.round((new Date(`${iso}T00:00:00`) - new Date(new Date().toDateString())) / 86400000);
  if (jours < 0) return 'retard';
  if (jours <= 15) return 'proche';
  return '';
}
function dosDate(iso, libelle) {
  if (!iso) return '<span class="muted">—</span>';
  const c = dosClasseDate(iso);
  const titre = c === 'retard' ? 'Échéance dépassée' : c === 'proche' ? 'Dans moins de 15 jours' : '';
  return `<span class="dos-date ${c}" title="${titre}">${fmtDate(iso)}</span>${libelle ? `<div class="sub">${esc(libelle)}</div>` : ''}`;
}
function dosBadgeStatut(statut, cat) {
  const classe = { en_cours: 'en_cours', en_attente: 'envoye', suspendu: 'envoye', clos: 'finalise', abandonne: 'abandonne' }[statut] || '';
  return `<span class="badge ${classe}">${esc(cat.statuts[statut] || statut)}</span>`;
}
function dosParties(d) {
  return (d.parties || []).map((p) => `<span class="dos-partie">${p.role !== 'concernee' ? `<em>${esc(p.role_libelle)}</em> ` : ''}${esc(p.denomination)}</span>`).join('');
}
/** Petites pastilles d'étapes : faites, en cours, à venir. */
function dosFrise(d) {
  const courante = d.etape_courante?.id;
  return `<div class="dos-frise" aria-label="${d.etapes_faites} étape(s) faite(s) sur ${d.etapes_total}">
    ${(d.etapes || []).map((e) => `<span class="${e.statut}${e.id === courante ? ' courante' : ''}" title="${esc(e.libelle)} — ${DOS_STATUTS_ETAPE[e.statut]}"></span>`).join('')}
  </div>`;
}

/* -------------------------------------------------------------- les vues */

async function vueDossiers(query = '') {
  const params = new URLSearchParams(query || '');
  const famille = DOS_FAMILLES.includes(params.get('vue')) ? params.get('vue') : 'haut_de_bilan';
  const statut = params.get('statut') === 'clos' ? 'clos' : 'actifs';
  const [cat, dossiers, synth] = await Promise.all([
    dosCatalogue(), api('GET', `/dossiers?famille=${famille}&statut=${statut}`), api('GET', '/dossiers/synthese'),
  ]);
  const lien = (f, s) => `#/dossiers?vue=${f}${s === 'clos' ? '&statut=clos' : ''}`;

  $main.innerHTML = `
    <div class="page-head"><h1>Dossiers</h1>
      <div class="dos-actions-tete">
        <a class="btn btn-sm" href="#/dossiers/modeles">Modèles d’étapes</a>
        <a class="btn btn-primary" href="#/dossiers/nouveau?famille=${famille}">Nouveau dossier</a>
      </div></div>
    <div class="dos-barre">
      <div class="segments" role="tablist">
        ${DOS_FAMILLES.map((f) => `<button type="button" role="tab" class="${f === famille ? 'actif' : ''}" aria-selected="${f === famille}" data-lien="${lien(f, statut)}">
          ${esc(cat.familles[f].libelle)} <span class="dos-compte">${synth.par_famille[f] || 0}</span></button>`).join('')}
      </div>
      <div class="dos-filtres">
        <div class="segments">
          <button type="button" class="${statut === 'actifs' ? 'actif' : ''}" data-lien="${lien(famille, 'actifs')}">En cours</button>
          <button type="button" class="${statut === 'clos' ? 'actif' : ''}" data-lien="${lien(famille, 'clos')}">Clos</button>
        </div>
        <input type="search" id="dos-recherche" placeholder="Rechercher (client, société, référence…)" aria-label="Rechercher un dossier">
      </div>
    </div>
    <p class="muted dos-intro">${esc(cat.familles[famille].description)}</p>
    <div id="dos-liste"></div>`;
  $main.querySelectorAll('[data-lien]').forEach((b) => { b.onclick = () => { location.hash = b.dataset.lien; }; });

  const afficher = (filtre) => {
    const f = filtre.trim().toLowerCase();
    const visibles = f ? dossiers.filter((d) => [d.reference, d.titre, d.client_nom, d.type_libelle, ...d.parties.map((p) => p.denomination)]
      .join(' ').toLowerCase().includes(f)) : dossiers;
    const $l = document.getElementById('dos-liste');
    if (!visibles.length) {
      $l.innerHTML = `<div class="card">${vueVide(dossiers.length ? 'Aucun dossier ne correspond à la recherche.' : statut === 'clos' ? 'Aucun dossier clos.' : 'Aucun dossier en cours dans cette famille.')}</div>`;
      return;
    }
    if (famille === 'haut_de_bilan') {
      $l.innerHTML = `<div class="dos-cartes">${visibles.map((d) => `
        <a class="card dos-carte" href="#/dossiers/${d.id}">
          <div class="dos-carte-tete"><span class="dos-ref">${esc(d.reference)}</span><span class="badge">${esc(d.type_libelle)}</span>
            ${d.statut !== 'en_cours' ? dosBadgeStatut(d.statut, cat) : ''}</div>
          <h3>${esc(d.titre)}</h3>
          <div class="sub">${esc(d.client_nom)}</div>
          <div class="dos-parties">${dosParties(d)}</div>
          ${dosFrise(d)}
          <div class="dos-etape">${d.etape_courante ? `Étape : <strong>${esc(d.etape_courante.libelle)}</strong>` : '<strong>Toutes les étapes sont faites</strong>'}
            <span class="muted">${d.etapes_faites}/${d.etapes_total}</span></div>
          <div class="dos-carte-pied">
            <div>${d.prochaine_echeance ? dosDate(d.prochaine_echeance.date, d.prochaine_echeance.libelle) : '<span class="muted">Pas d’échéance</span>'}</div>
            <div class="muted">${esc(d.responsable_nom)}${d.taches_ouvertes ? ` · ${d.taches_ouvertes} tâche(s)` : ''}</div>
          </div>
        </a>`).join('')}</div>`;
    } else if (famille === 'secretariat') {
      $l.innerHTML = `<div class="card"><table>
        <thead><tr><th>Société</th><th>Dossier</th><th>Étape en cours</th><th>Prochaine échéance</th><th>Statut</th></tr></thead>
        <tbody>${visibles.map((d) => `
          <tr class="clickable" onclick="location.hash='#/dossiers/${d.id}'">
            <td><strong>${esc(d.parties.map((p) => p.denomination).join(', ') || d.client_nom)}</strong><div class="sub">${esc(d.client_nom)}</div></td>
            <td>${esc(d.titre)}<div class="sub">${esc(d.reference)} · ${esc(d.type_libelle)}</div></td>
            <td>${d.etape_courante ? esc(d.etape_courante.libelle) : 'Terminé'}<div class="sub">${d.etapes_faites}/${d.etapes_total}</div></td>
            <td>${d.prochaine_echeance ? dosDate(d.prochaine_echeance.date, d.prochaine_echeance.libelle) : '—'}</td>
            <td>${dosBadgeStatut(d.statut, cat)}</td>
          </tr>`).join('')}</tbody></table></div>`;
    } else {
      const domaines = cat.types.find((t) => t.code === 'consultation')?.champs.find((c) => c.nom === 'domaine')?.options || {};
      $l.innerHTML = `<div class="card"><table>
        <thead><tr><th>Client</th><th>Question</th><th>Ouvert le</th><th>Réponse attendue</th><th>Statut</th></tr></thead>
        <tbody>${visibles.map((d) => `
          <tr class="clickable" onclick="location.hash='#/dossiers/${d.id}'">
            <td><strong>${esc(d.client_nom)}</strong><div class="sub">${esc(d.reference)}</div></td>
            <td>${esc(d.titre)}<div class="sub">${esc(d.type_libelle)}${d.donnees?.domaine ? ` · ${esc(domaines[d.donnees.domaine] || d.donnees.domaine)}` : ''}</div></td>
            <td>${fmtDate(d.date_ouverture)}</td>
            <td>${dosDate(d.echeance)}</td>
            <td>${dosBadgeStatut(d.statut, cat)}${d.etape_courante ? `<div class="sub">${esc(d.etape_courante.libelle)}</div>` : ''}</td>
          </tr>`).join('')}</tbody></table></div>`;
    }
  };
  afficher('');
  document.getElementById('dos-recherche').oninput = (e) => afficher(e.target.value);
}

/* --------------------------------------------------------- nouveau dossier */

function dosChampHtml(c, valeur, prefixe = 'd_') {
  const v = valeur ?? '';
  const nom = `${prefixe}${c.nom}`;
  const requis = c.requis ? ' required' : '';
  const libelle = `${esc(c.libelle)}${c.requis ? ' *' : ''}`;
  if (c.type === 'select') {
    return `<label class="field">${libelle}<select name="${nom}"${requis}><option value="">—</option>
      ${Object.entries(c.options).map(([k, l]) => `<option value="${esc(k)}" ${String(v) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  }
  if (c.type === 'textarea') return `<label class="field dos-large">${libelle}<textarea name="${nom}"${requis}>${esc(v)}</textarea></label>`;
  const type = c.type === 'number' ? 'text" inputmode="decimal' : c.type;
  return `<label class="field">${libelle}<input type="${type}" name="${nom}" value="${esc(v)}"${requis}></label>`;
}
function dosLireChamps(form, champs, prefixe = 'd_') {
  return Object.fromEntries(champs.map((c) => [c.nom, form.elements[`${prefixe}${c.nom}`]?.value ?? '']));
}

async function vueDossierNouveau(query = '') {
  const params = new URLSearchParams(query || '');
  const [cat, clients, societes, membres] = await Promise.all([dosCatalogue(), api('GET', '/clients'), api('GET', '/societes'), dosMembres()]);
  const moi = await api('GET', '/moi').catch(() => null);
  let famille = DOS_FAMILLES.includes(params.get('famille')) ? params.get('famille') : 'haut_de_bilan';
  const societeInitiale = params.get('societe');

  $main.innerHTML = `
    <div class="page-head"><div><div class="crumb"><a href="#/dossiers">Dossiers</a> /</div><h1>Nouveau dossier</h1></div></div>
    <form id="dos-form" class="dos-form" novalidate>
      <div class="dos-familles">${DOS_FAMILLES.map((f) => `
        <button type="button" class="dos-famille ${f === famille ? 'actif' : ''}" data-famille="${f}">
          <strong>${esc(cat.familles[f].libelle)}</strong><span>${esc(cat.familles[f].description)}</span></button>`).join('')}
      </div>
      <div class="card">
        <div class="row">
          <label class="field">Type de dossier *<select name="type" id="dos-type" required></select></label>
          <label class="field">Client *<select name="client_id" id="dos-client" required>
            <option value="">— Choisir —</option>
            <option value="nouveau">+ Nouveau client</option>
            ${clients.map((c) => `<option value="${c.id}" ${String(c.id) === params.get('client') ? 'selected' : ''}>${esc(c.nom)}</option>`).join('')}
          </select></label>
        </div>
        <div class="row" id="dos-nouveau-client" hidden>
          <label class="field">Nom du client *<input name="nc_nom" placeholder="ex. Groupe Martin, Jean Dupont"></label>
          <label class="field">Nature<select name="nc_nature">
            <option value="societe">Société</option><option value="groupe">Groupe</option><option value="personne">Personne physique</option></select></label>
        </div>
        <p class="sub" id="dos-etapes-apercu"></p>
      </div>
      <div class="card mt">
        <h2>Sociétés concernées</h2>
        <div id="dos-parties"></div>
        <button type="button" class="btn btn-sm" id="dos-ajout-partie">Ajouter une société</button>
      </div>
      <div class="card mt">
        <h2>Informations du dossier</h2>
        <div class="row" id="dos-champs"></div>
        <div class="row">
          <label class="field dos-large">Intitulé<input name="titre" id="dos-titre" placeholder="Proposé automatiquement"></label>
        </div>
        <div class="row">
          <label class="field">Responsable<select name="responsable_id">
            ${membres.map((m) => `<option value="${m.id}" ${m.id === moi?.id ? 'selected' : ''}>${esc(m.nom_complet)}</option>`).join('')}</select></label>
          <label class="field" id="dos-echeance-libre">Échéance du dossier<input type="date" name="echeance"></label>
        </div>
      </div>
      <p class="alerte alerte-bloquant" id="dos-erreur" hidden></p>
      <div class="dos-pied"><a class="btn" href="#/dossiers">Annuler</a><button class="btn btn-primary" type="submit">Ouvrir le dossier</button></div>
    </form>`;

  const $form = document.getElementById('dos-form');
  const $type = document.getElementById('dos-type');
  const $parties = document.getElementById('dos-parties');
  const typeCourant = () => cat.types.find((t) => t.code === $type.value);

  const lignePartie = (p = {}) => {
    const roles = typeCourant()?.roles || { concernee: 'Concernée' };
    const div = document.createElement('div');
    div.className = 'row dos-ligne-partie';
    div.innerHTML = `
      <label class="field">Société<select data-societe>
        <option value="">— Choisir —</option><option value="autre">Autre (sans fiche) …</option>
        ${societes.map((s) => `<option value="${s.id}" ${String(s.id) === String(p.societe_id || '') ? 'selected' : ''}>${esc(s.denomination)}</option>`).join('')}</select></label>
      <label class="field" data-libre hidden>Dénomination<input data-denomination></label>
      <label class="field">Rôle<select data-role>${Object.entries(roles).map(([k, l]) => `<option value="${k}" ${k === (p.role || 'concernee') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <button type="button" class="btn btn-sm btn-danger dos-retirer" title="Retirer">Retirer</button>`;
    const $s = div.querySelector('[data-societe]');
    $s.onchange = () => { div.querySelector('[data-libre]').hidden = $s.value !== 'autre'; proposerTitre(); };
    div.querySelector('.dos-retirer').onclick = () => { div.remove(); proposerTitre(); };
    $parties.appendChild(div);
  };

  const proposerTitre = () => {
    const t = typeCourant();
    const premiere = [...$parties.querySelectorAll('[data-societe]')].map((s) => (s.value && s.value !== 'autre' ? s.selectedOptions[0].textContent : s.closest('.dos-ligne-partie').querySelector('[data-denomination]').value)).find(Boolean);
    const client = $form.client_id.value === 'nouveau' ? $form.nc_nom.value : ($form.client_id.selectedOptions[0]?.value ? $form.client_id.selectedOptions[0].textContent : '');
    document.getElementById('dos-titre').placeholder = t ? `${t.libelle} — ${premiere || client || '…'}` : 'Proposé automatiquement';
  };

  const majType = () => {
    const t = typeCourant();
    document.getElementById('dos-champs').innerHTML = (t?.champs || []).map((c) => dosChampHtml(c)).join('');
    document.getElementById('dos-etapes-apercu').innerHTML = t ? `Étapes : ${t.etapes.map((e) => esc(e.libelle)).join(' → ')}` : '';
    document.getElementById('dos-echeance-libre').hidden = Boolean(t?.champs.some((c) => c.echeance));
    // Les rôles possibles changent avec le type.
    $parties.querySelectorAll('.dos-ligne-partie').forEach((l) => {
      const actuel = l.querySelector('[data-role]').value;
      const roles = t?.roles || { concernee: 'Concernée' };
      l.querySelector('[data-role]').innerHTML = Object.entries(roles).map(([k, lib]) => `<option value="${k}" ${k === actuel ? 'selected' : ''}>${esc(lib)}</option>`).join('');
    });
    proposerTitre();
  };
  const majFamille = () => {
    $form.querySelectorAll('.dos-famille').forEach((b) => b.classList.toggle('actif', b.dataset.famille === famille));
    $type.innerHTML = cat.types.filter((t) => t.famille === famille).map((t) => `<option value="${t.code}">${esc(t.libelle)}</option>`).join('');
    majType();
  };
  $form.querySelectorAll('.dos-famille').forEach((b) => { b.onclick = () => { famille = b.dataset.famille; majFamille(); }; });
  $type.onchange = majType;
  document.getElementById('dos-client').onchange = (e) => { document.getElementById('dos-nouveau-client').hidden = e.target.value !== 'nouveau'; proposerTitre(); };
  $form.nc_nom.oninput = proposerTitre;
  document.getElementById('dos-ajout-partie').onclick = () => lignePartie();
  lignePartie(societeInitiale ? { societe_id: societeInitiale } : {});
  majFamille();

  $form.onsubmit = async (ev) => {
    ev.preventDefault();
    const $err = document.getElementById('dos-erreur');
    $err.hidden = true;
    const t = typeCourant();
    const parties = [...$parties.querySelectorAll('.dos-ligne-partie')].map((l) => {
      const s = l.querySelector('[data-societe]').value;
      return { societe_id: s && s !== 'autre' ? Number(s) : null, denomination: s === 'autre' ? l.querySelector('[data-denomination]').value : '', role: l.querySelector('[data-role]').value };
    }).filter((p) => p.societe_id || p.denomination.trim());
    const corps = {
      type: t.code, parties, titre: $form.titre.value, responsable_id: $form.responsable_id.value || null,
      echeance: $form.echeance.value || null, donnees: dosLireChamps($form, t.champs),
    };
    if ($form.client_id.value === 'nouveau') corps.nouveau_client = { nom: $form.nc_nom.value, nature: $form.nc_nature.value };
    else corps.client_id = $form.client_id.value || null;
    const $btn = $form.querySelector('button[type=submit]');
    $btn.disabled = true;
    try {
      const d = await api('POST', '/dossiers', corps);
      toast(`Dossier ${d.reference} ouvert.`);
      location.hash = `#/dossiers/${d.id}`;
    } catch (e) {
      $err.textContent = e.message;
      $err.hidden = false;
    } finally { $btn.disabled = false; }
  };
}

/* -------------------------------------------------------- fiche dossier */

const DOS_ICONES_EVT = { ouverture: '◆', statut: '◇', etape: '✓', tache: '☐', echeance: '◷', note: '✎', lien: '↗', partie: '◎', responsable: '◉' };

async function vueDossier(id) {
  const [d, cat, membres, societes] = await Promise.all([api('GET', `/dossiers/${id}`), dosCatalogue(), dosMembres(), api('GET', '/societes')]);
  dosAfficherDossier(d, cat, membres, societes, cat.familles[d.famille]);
}

function dosAfficherDossier(d, cat, membres, societes, famille) {
  const maj = async (methode, url, corps, message) => {
    try {
      const nouveau = await api(methode, url, corps);
      if (message) toast(message);
      dosAfficherDossier(nouveau, cat, membres, societes, famille);
    } catch (e) { toast(e.message, true); }
  };
  const optionsMembres = (choisi) => `<option value="">—</option>${membres.map((m) => `<option value="${m.id}" ${m.id === choisi ? 'selected' : ''}>${esc(m.nom_complet)}</option>`).join('')}`;
  const ouvertes = d.taches.filter((t) => t.statut !== 'fait');
  const faites = d.taches.filter((t) => t.statut === 'fait');
  const echeancesAVenir = d.echeances.filter((x) => x.statut === 'a_venir');
  const echeancesPassees = d.echeances.filter((x) => x.statut !== 'a_venir');
  const pct = d.etapes_total ? Math.round((d.etapes_faites / d.etapes_total) * 100) : 0;
  const lienFormalite = (f) => (f.type === 'parcours' ? `#/parcours/${f.id}` : `#/formalites/${f.id}`);

  $main.innerHTML = `
    <div class="page-head dos-tete">
      <div>
        <div class="crumb"><a href="#/dossiers?vue=${d.famille}">Dossiers</a> / ${esc(famille.libelle)} /</div>
        <h1>${esc(d.titre)}</h1>
        <div class="dos-meta">
          <span class="dos-ref">${esc(d.reference)}</span><span class="badge">${esc(d.type_libelle)}</span>
          ${d.client ? `<a href="#/clients/${d.client.id}">${esc(d.client.nom)}</a>` : ''}
          <span class="muted">Ouvert le ${fmtDate(d.date_ouverture)}</span>
        </div>
      </div>
      <div class="dos-tete-droite">
        <label class="field">Statut<select id="dos-statut">${Object.entries(cat.statuts).map(([k, l]) => `<option value="${k}" ${k === d.statut ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="field">Responsable<select id="dos-responsable">${optionsMembres(d.responsable_id)}</select></label>
        <label class="field">Échéance<input type="date" id="dos-echeance" value="${esc(d.echeance || '')}"></label>
      </div>
    </div>
    ${d.actions.length ? `<div class="dos-actions">${d.actions.map((a) => (a.lien
    ? `<a class="btn btn-sm" href="${esc(a.lien)}" title="${esc(a.description)}">${esc(a.libelle)}</a>`
    : `<button type="button" class="btn btn-sm" data-action="${esc(a.id)}" title="${esc(a.description)}">${esc(a.libelle)}</button>`)).join('')}</div>` : ''}
    <div class="grid cols-3-1">
      <div class="dos-colonne">
        <div class="card">
          <h2>Étapes <span class="muted dos-h2-info">${d.etapes_faites}/${d.etapes_total}</span></h2>
          <div class="dos-progression"><span style="width:${pct}%"></span></div>
          <ol class="dos-etapes">${d.etapes.map((e) => `
            <li class="${e.statut}${e.id === d.etape_courante?.id ? ' courante' : ''}">
              <button type="button" class="dos-coche" data-etape-fait="${e.id}" title="${e.statut === 'fait' ? 'Marquer à faire' : 'Marquer faite'}" aria-label="${esc(e.libelle)} : ${DOS_STATUTS_ETAPE[e.statut]}"></button>
              <div class="dos-etape-corps">
                <span class="dos-etape-libelle">${esc(e.libelle)}</span>
                <span class="sub">${e.statut === 'fait' && e.date_realisee ? `Faite le ${fmtDate(e.date_realisee)}` : e.date_prevue ? `Prévue le ${fmtDate(e.date_prevue)}` : ''}</span>
              </div>
              <select data-etape-statut="${e.id}" aria-label="Statut de l’étape">${Object.entries(DOS_STATUTS_ETAPE).map(([k, l]) => `<option value="${k}" ${k === e.statut ? 'selected' : ''}>${l}</option>`).join('')}</select>
              <input type="date" data-etape-date="${e.id}" value="${esc(e.date_prevue || '')}" aria-label="Date prévue" title="Date prévue">
              <button type="button" class="btn-sm dos-suppr" data-etape-suppr="${e.id}" title="Retirer l’étape" aria-label="Retirer l’étape">×</button>
            </li>`).join('')}</ol>
          <form class="dos-ajout" id="dos-ajout-etape"><input name="libelle" placeholder="Ajouter une étape" aria-label="Nouvelle étape"><button class="btn btn-sm">Ajouter</button></form>
        </div>

        <div class="card mt">
          <h2>Tâches ${ouvertes.length ? `<span class="muted dos-h2-info">${ouvertes.length} ouverte(s)</span>` : ''}</h2>
          ${ouvertes.length ? `<ul class="dos-taches">${ouvertes.map((t) => `
            <li><button type="button" class="dos-coche" data-tache-fait="${t.id}" aria-label="Marquer faite : ${esc(t.titre)}"></button>
              <div class="dos-etape-corps"><span>${esc(t.titre)}</span><span class="sub">${t.echeance ? dosDate(t.echeance) : ''} ${esc(t.responsable_nom || '')}</span></div>
              <button type="button" class="btn-sm dos-suppr" data-tache-suppr="${t.id}" aria-label="Supprimer la tâche">×</button></li>`).join('')}</ul>` : '<p class="muted">Aucune tâche ouverte.</p>'}
          <form class="dos-ajout" id="dos-ajout-tache">
            <input name="titre" placeholder="Nouvelle tâche" aria-label="Nouvelle tâche" required>
            <input type="date" name="echeance" aria-label="Pour le">
            <select name="responsable_id" aria-label="Confiée à">${optionsMembres(null)}</select>
            <button class="btn btn-sm">Ajouter</button></form>
          ${faites.length ? `<details class="dos-faites"><summary>${faites.length} tâche(s) faite(s)</summary><ul class="dos-taches">${faites.map((t) => `
            <li class="fait"><button type="button" class="dos-coche" data-tache-rouvrir="${t.id}" aria-label="Rouvrir : ${esc(t.titre)}"></button>
              <div class="dos-etape-corps"><span>${esc(t.titre)}</span><span class="sub">Faite le ${fmtDate(t.fait_le)}</span></div></li>`).join('')}</ul></details>` : ''}
        </div>

        <div class="card mt">
          <h2>Chronologie</h2>
          <form class="dos-note" id="dos-ajout-note"><textarea name="texte" placeholder="Ajouter une note (appel, rendez-vous, point d’étape…)" aria-label="Note"></textarea>
            <button class="btn btn-sm">Ajouter la note</button></form>
          <ol class="dos-chrono">${d.evenements.map((e) => `
            <li class="${esc(e.nature)}"><span class="dos-chrono-icone" aria-hidden="true">${DOS_ICONES_EVT[e.nature] || '•'}</span>
              <div><div class="${e.nature === 'note' ? 'dos-note-texte' : ''}">${esc(e.resume)}</div>
              <div class="sub">${new Date(e.date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(e.auteur_nom)}</div></div></li>`).join('')}</ol>
        </div>
      </div>

      <div class="dos-colonne">
        <div class="card">
          <h2>Échéances</h2>
          ${echeancesAVenir.length ? `<ul class="dos-echeances">${echeancesAVenir.map((x) => `
            <li><div>${dosDate(x.date)}</div>
              <div class="dos-etape-corps"><span>${esc(x.libelle)}</span>${x.base_legale ? `<span class="sub">${esc(x.base_legale)}</span>` : ''}</div>
              <div class="dos-boutons"><button type="button" class="btn btn-sm" data-echeance-faite="${x.id}">Tenue</button>
                <button type="button" class="btn-sm dos-suppr" data-echeance-suppr="${x.id}" aria-label="Supprimer l’échéance">×</button></div></li>`).join('')}</ul>` : '<p class="muted">Aucune échéance à venir.</p>'}
          <form class="dos-ajout" id="dos-ajout-echeance">
            <input name="libelle" placeholder="Nouvelle échéance" aria-label="Libellé de l’échéance" required>
            <input type="date" name="date" aria-label="Date" required><button class="btn btn-sm">Ajouter</button></form>
          ${echeancesPassees.length ? `<details class="dos-faites"><summary>${echeancesPassees.length} échéance(s) tenue(s) ou sans objet</summary>
            <ul class="dos-echeances">${echeancesPassees.map((x) => `<li class="fait"><div>${fmtDate(x.date)}</div><div class="dos-etape-corps"><span>${esc(x.libelle)}</span></div></li>`).join('')}</ul></details>` : ''}
        </div>

        ${d.type_info?.champs?.length ? `<div class="card mt">
          <h2>Informations</h2>
          <form id="dos-donnees" class="dos-donnees">${d.type_info.champs.map((c) => dosChampHtml(c, d.donnees?.[c.nom])).join('')}
            <button class="btn btn-sm">Enregistrer</button></form>
        </div>` : ''}

        <div class="card mt">
          <h2>Sociétés concernées</h2>
          ${d.parties.length ? `<ul class="dos-liste-simple">${d.parties.map((p) => `
            <li><div>${p.societe_id ? `<a href="#/societes/${p.societe_id}">${esc(p.denomination)}</a>` : esc(p.denomination)}
              ${p.role !== 'concernee' ? `<span class="sub">${esc(p.role_libelle)}</span>` : ''}</div>
              <button type="button" class="btn-sm dos-suppr" data-partie-suppr="${p.id}" aria-label="Retirer ${esc(p.denomination)}">×</button></li>`).join('')}</ul>` : '<p class="muted">Aucune société.</p>'}
          <form class="dos-ajout dos-ajout-partie" id="dos-ajout-partie">
            <select name="societe_id" aria-label="Société"><option value="">Société de la base…</option>${societes.map((s) => `<option value="${s.id}">${esc(s.denomination)}</option>`).join('')}</select>
            <input name="denomination" placeholder="ou dénomination libre" aria-label="Dénomination libre">
            <select name="role" aria-label="Rôle">${Object.entries(d.type_info?.roles || { concernee: 'Concernée' }).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
            <button class="btn btn-sm">Ajouter</button></form>
        </div>

        <div class="card mt">
          <h2>Travaux rattachés</h2>
          ${d.operations.length || d.formalites.length ? `<ul class="dos-liste-simple">
            ${d.operations.map((o) => `<li><div><a href="#/operations/${o.id}">${esc(o.libelle)}</a><span class="sub">Actes · ${esc(STATUT_OP[o.statut] || o.statut || '')}</span></div></li>`).join('')}
            ${d.formalites.map((f) => `<li><div><a href="${lienFormalite(f)}">${esc(f.libelle)}</a><span class="sub">Formalité · ${esc(f.statut_inpi || f.statut || '')}</span></div></li>`).join('')}
          </ul>` : '<p class="muted">Aucune opération ni formalité rattachée.</p>'}
          ${d.rattachables.operations.length || d.rattachables.formalites.length ? `<details class="dos-faites"><summary>Rattacher un travail existant des sociétés du dossier</summary>
            <ul class="dos-liste-simple">
            ${d.rattachables.operations.map((o) => `<li><div>${esc(o.libelle)}<span class="sub">Actes</span></div><button type="button" class="btn btn-sm" data-lier="operations:${o.id}">Rattacher</button></li>`).join('')}
            ${d.rattachables.formalites.map((f) => `<li><div>${esc(f.libelle)}<span class="sub">Formalité</span></div><button type="button" class="btn btn-sm" data-lier="formalites:${f.id}">Rattacher</button></li>`).join('')}
            </ul></details>` : ''}
        </div>

        <div class="card mt dos-danger">
          <button type="button" class="btn btn-sm btn-danger" id="dos-supprimer">Supprimer le dossier</button>
        </div>
      </div>
    </div>`;

  const $ = (sel) => $main.querySelector(sel);
  $('#dos-statut').onchange = (e) => maj('PUT', `/dossiers/${d.id}`, { statut: e.target.value }, 'Statut enregistré.');
  $('#dos-responsable').onchange = (e) => maj('PUT', `/dossiers/${d.id}`, { responsable_id: e.target.value || null }, 'Responsable enregistré.');
  $('#dos-echeance').onchange = (e) => maj('PUT', `/dossiers/${d.id}`, { echeance: e.target.value || null }, 'Échéance enregistrée.');

  $main.querySelectorAll('[data-etape-fait]').forEach((b) => {
    const e = d.etapes.find((x) => String(x.id) === b.dataset.etapeFait);
    b.onclick = () => maj('PUT', `/etapes/${e.id}`, { statut: e.statut === 'fait' ? 'a_faire' : 'fait' });
  });
  $main.querySelectorAll('[data-etape-statut]').forEach((s) => { s.onchange = () => maj('PUT', `/etapes/${s.dataset.etapeStatut}`, { statut: s.value }); });
  $main.querySelectorAll('[data-etape-date]').forEach((i) => { i.onchange = () => maj('PUT', `/etapes/${i.dataset.etapeDate}`, { date_prevue: i.value || null }); });
  $main.querySelectorAll('[data-etape-suppr]').forEach((b) => {
    b.onclick = () => { if (confirm('Retirer cette étape du dossier ?')) maj('DELETE', `/etapes/${b.dataset.etapeSuppr}`); };
  });
  $('#dos-ajout-etape').onsubmit = (ev) => { ev.preventDefault(); maj('POST', `/dossiers/${d.id}/etapes`, { libelle: ev.target.libelle.value }); };

  $main.querySelectorAll('[data-tache-fait]').forEach((b) => { b.onclick = () => maj('PUT', `/taches/${b.dataset.tacheFait}`, { statut: 'fait' }); });
  $main.querySelectorAll('[data-tache-rouvrir]').forEach((b) => { b.onclick = () => maj('PUT', `/taches/${b.dataset.tacheRouvrir}`, { statut: 'a_faire' }); });
  $main.querySelectorAll('[data-tache-suppr]').forEach((b) => { b.onclick = () => maj('DELETE', `/taches/${b.dataset.tacheSuppr}`); });
  $('#dos-ajout-tache').onsubmit = (ev) => {
    ev.preventDefault();
    const f = ev.target;
    maj('POST', `/dossiers/${d.id}/taches`, { titre: f.titre.value, echeance: f.echeance.value || null, responsable_id: f.responsable_id.value || undefined });
  };

  $('#dos-ajout-note').onsubmit = (ev) => { ev.preventDefault(); maj('POST', `/dossiers/${d.id}/notes`, { texte: ev.target.texte.value }, 'Note ajoutée.'); };

  $main.querySelectorAll('[data-echeance-faite]').forEach((b) => { b.onclick = () => maj('PUT', `/echeances/${b.dataset.echeanceFaite}`, { statut: 'faite' }); });
  $main.querySelectorAll('[data-echeance-suppr]').forEach((b) => {
    b.onclick = () => { if (confirm('Supprimer cette échéance ?')) maj('DELETE', `/echeances/${b.dataset.echeanceSuppr}`); };
  });
  $('#dos-ajout-echeance').onsubmit = (ev) => { ev.preventDefault(); maj('POST', `/dossiers/${d.id}/echeances`, { libelle: ev.target.libelle.value, date: ev.target.date.value }); };

  const $donnees = $('#dos-donnees');
  if ($donnees) {
    $donnees.onsubmit = (ev) => { ev.preventDefault(); maj('PUT', `/dossiers/${d.id}`, { donnees: dosLireChamps($donnees, d.type_info.champs) }, 'Informations enregistrées.'); };
  }

  $main.querySelectorAll('[data-partie-suppr]').forEach((b) => { b.onclick = () => maj('DELETE', `/parties/${b.dataset.partieSuppr}`); });
  $('#dos-ajout-partie').onsubmit = (ev) => {
    ev.preventDefault();
    const f = ev.target;
    maj('POST', `/dossiers/${d.id}/parties`, { societe_id: f.societe_id.value || null, denomination: f.denomination.value, role: f.role.value });
  };
  $main.querySelectorAll('[data-lier]').forEach((b) => {
    const [table, objetId] = b.dataset.lier.split(':');
    b.onclick = () => maj('PUT', `/dossiers/${d.id}/liens`, { table, objet_id: Number(objetId) }, 'Rattaché au dossier.');
  });
  $main.querySelectorAll('[data-action]').forEach((b) => { b.onclick = () => maj('POST', `/dossiers/${d.id}/actions/${b.dataset.action}`, {}); });

  $('#dos-supprimer').onclick = () => openDialog(`
    <form method="dialog"><h2>Supprimer le dossier ${esc(d.reference)}</h2>
      <p>Étapes, tâches, échéances et chronologie seront effacées. Les opérations et formalités rattachées sont conservées, détachées du dossier.</p>
      <label class="field">Retapez la référence du dossier pour confirmer<input name="confirmation" autocomplete="off" required></label>
      <div class="dialog-actions"><button type="button" class="btn" value="annuler" onclick="this.closest('dialog').close()">Annuler</button>
        <button class="btn btn-danger">Supprimer</button></div></form>`, async (form) => {
    await api('DELETE', `/dossiers/${d.id}`, { confirmation: form.confirmation.value });
    toast(`Dossier ${d.reference} supprimé.`);
    location.hash = `#/dossiers?vue=${d.famille}`;
  });
}

/* ---------------------------------------------------------------- clients */

async function vueClients() {
  const clients = await api('GET', '/clients');
  $main.innerHTML = `
    <div class="page-head"><h1>Clients</h1><button class="btn-primary" id="cl-nouveau">Nouveau client</button></div>
    <div class="card">
      ${clients.length ? `<table>
        <thead><tr><th>Client</th><th>Nature</th><th>Dossiers en cours</th><th>Prochaine échéance</th></tr></thead>
        <tbody>${clients.map((c) => `
          <tr class="clickable" onclick="location.hash='#/clients/${c.id}'">
            <td><strong>${esc(c.nom)}</strong>${c.email ? `<div class="sub">${esc(c.email)}</div>` : ''}</td>
            <td>${esc(c.nature_libelle)}</td>
            <td>${c.dossiers_actifs || '—'}${c.dossiers_total > c.dossiers_actifs ? `<span class="sub"> · ${c.dossiers_total} au total</span>` : ''}</td>
            <td>${c.prochaine_echeance ? dosDate(c.prochaine_echeance.date, c.prochaine_echeance.libelle) : '—'}</td>
          </tr>`).join('')}</tbody></table>` : vueVide('Aucun client. Un client est aussi créé à l’ouverture d’un dossier.')}
    </div>`;
  document.getElementById('cl-nouveau').onclick = () => dosDialogClient();
}

function dosDialogClient(client) {
  openDialog(`
    <form><h2>${client ? 'Modifier le client' : 'Nouveau client'}</h2>
      <label class="field">Nom *<input name="nom" value="${esc(client?.nom || '')}" required></label>
      <label class="field">Nature<select name="nature">${[['societe', 'Société'], ['groupe', 'Groupe'], ['personne', 'Personne physique']].map(([k, l]) => `<option value="${k}" ${client?.nature === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Courriel<input type="email" name="email" value="${esc(client?.email || '')}"></label>
      <label class="field">Téléphone<input name="telephone" value="${esc(client?.telephone || '')}"></label>
      <label class="field">Adresse<input name="adresse" value="${esc(client?.adresse || '')}"></label>
      <label class="field">Notes<textarea name="notes">${esc(client?.notes || '')}</textarea></label>
      <div class="dialog-actions"><button type="button" class="btn" onclick="this.closest('dialog').close()">Annuler</button><button class="btn btn-primary">Enregistrer</button></div>
    </form>`, async (form) => {
    const corps = Object.fromEntries(['nom', 'nature', 'email', 'telephone', 'adresse', 'notes'].map((k) => [k, form[k].value]));
    const r = client ? await api('PUT', `/clients/${client.id}`, corps) : await api('POST', '/clients', corps);
    location.hash = `#/clients/${r.id}`;
    if (client) render();
  });
}

async function vueClient(id) {
  const [c, cat] = await Promise.all([api('GET', `/clients/${id}`), dosCatalogue()]);
  const parFamille = (f) => c.dossiers.filter((d) => d.famille === f);
  $main.innerHTML = `
    <div class="page-head">
      <div><div class="crumb"><a href="#/clients">Clients</a> /</div><h1>${esc(c.nom)}</h1>
        <div class="dos-meta"><span class="badge">${esc(c.nature_libelle)}</span>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.telephone ? `<span>${esc(c.telephone)}</span>` : ''}</div></div>
      <div class="dos-actions-tete"><button class="btn btn-sm" id="cl-modifier">Modifier</button>
        <a class="btn btn-primary" href="#/dossiers/nouveau?client=${c.id}">Nouveau dossier</a></div>
    </div>
    <div class="grid cols-3-1">
      <div class="dos-colonne">
        ${DOS_FAMILLES.map((f) => `<div class="card ${f === 'haut_de_bilan' ? '' : 'mt'}">
          <h2>${esc(cat.familles[f].libelle)} <span class="muted dos-h2-info">${parFamille(f).length}</span></h2>
          ${parFamille(f).length ? `<table><tbody>${parFamille(f).map((d) => `
            <tr class="clickable" onclick="location.hash='#/dossiers/${d.id}'">
              <td><strong>${esc(d.titre)}</strong><div class="sub">${esc(d.reference)} · ${esc(d.type_libelle)}</div></td>
              <td>${d.etape_courante ? esc(d.etape_courante.libelle) : 'Terminé'}<div class="sub">${d.etapes_faites}/${d.etapes_total}</div></td>
              <td>${d.prochaine_echeance ? dosDate(d.prochaine_echeance.date) : '—'}</td>
              <td class="right">${dosBadgeStatut(d.statut, cat)}</td>
            </tr>`).join('')}</tbody></table>` : '<p class="muted">Aucun dossier.</p>'}
        </div>`).join('')}
        ${c.notes ? `<div class="card mt"><h2>Notes</h2><p class="dos-note-texte">${esc(c.notes)}</p></div>` : ''}
      </div>
      <div class="dos-colonne">
        <div class="card">
          <h2>Échéances à venir</h2>
          ${c.echeances.length ? `<ul class="dos-echeances">${c.echeances.map((x) => `
            <li><div>${dosDate(x.date)}</div><div class="dos-etape-corps"><span>${esc(x.libelle)}</span>
              <a class="sub" href="#/dossiers/${x.dossier_id}">${esc(x.dossier_reference)} · ${esc(x.dossier_titre)}</a></div></li>`).join('')}</ul>` : '<p class="muted">Aucune.</p>'}
        </div>
        <div class="card mt">
          <h2>Contacts</h2>
          ${c.contacts.length ? `<ul class="dos-liste-simple">${c.contacts.map((p) => `
            <li><div><strong>${esc([p.prenom, p.nom].filter(Boolean).join(' '))}</strong>${p.fonction ? `<span class="sub">${esc(p.fonction)}</span>` : ''}
              ${p.email ? `<a class="sub" href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}${p.telephone ? `<span class="sub">${esc(p.telephone)}</span>` : ''}</div>
              <button type="button" class="btn-sm dos-suppr" data-contact-suppr="${p.id}" aria-label="Supprimer le contact">×</button></li>`).join('')}</ul>` : '<p class="muted">Aucun contact.</p>'}
          <form class="dos-ajout dos-ajout-contact" id="cl-ajout-contact">
            <input name="prenom" placeholder="Prénom" aria-label="Prénom"><input name="nom" placeholder="Nom *" aria-label="Nom" required>
            <input name="fonction" placeholder="Fonction" aria-label="Fonction"><input type="email" name="email" placeholder="Courriel" aria-label="Courriel">
            <input name="telephone" placeholder="Téléphone" aria-label="Téléphone"><button class="btn btn-sm">Ajouter</button></form>
          <p class="sub">L’adresse d’un contact permettra de rattacher automatiquement ses courriels au client.</p>
        </div>
        <div class="card mt">
          <h2>Sociétés</h2>
          ${c.societes.length ? `<ul class="dos-liste-simple">${c.societes.map((s) => `<li><div><a href="#/societes/${s.id}">${esc(s.denomination)}</a><span class="sub">${esc(s.forme_sociale || '')} ${esc(s.siren || '')}</span></div></li>`).join('')}</ul>` : '<p class="muted">Aucune société liée.</p>'}
        </div>
      </div>
    </div>`;
  document.getElementById('cl-modifier').onclick = () => dosDialogClient(c);
  document.getElementById('cl-ajout-contact').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('POST', `/clients/${c.id}/contacts`, Object.fromEntries(['prenom', 'nom', 'fonction', 'email', 'telephone'].map((k) => [k, f[k].value])));
      toast('Contact ajouté.');
      render();
    } catch (e) { toast(e.message, true); }
  };
  $main.querySelectorAll('[data-contact-suppr]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Supprimer ce contact ?')) return;
      try { await api('DELETE', `/contacts/${b.dataset.contactSuppr}`); render(); } catch (e) { toast(e.message, true); }
    };
  });
}

/* ------------------------------------------------------ modèles d'étapes */

async function vueModeles() {
  const cat = await dosCatalogue(true);
  $main.innerHTML = `
    <div class="page-head"><div><div class="crumb"><a href="#/dossiers">Dossiers</a> /</div><h1>Modèles d’étapes</h1>
      <p class="muted">Les étapes proposées à l’ouverture d’un dossier, une par ligne. Chaque dossier garde ensuite sa propre liste, modifiable.</p></div></div>
    ${DOS_FAMILLES.map((f) => `
      <h2 class="dos-titre-famille">${esc(cat.familles[f].libelle)}</h2>
      <div class="dos-modeles">${cat.types.filter((t) => t.famille === f).map((t) => `
        <form class="card dos-modele" data-type="${t.code}">
          <h3>${esc(t.libelle)} ${t.personnalise ? '<span class="badge en_cours">Personnalisé</span>' : ''}</h3>
          <textarea name="etapes" rows="${Math.max(4, t.etapes.length + 1)}" aria-label="Étapes : ${esc(t.libelle)}">${esc(t.etapes.map((e) => e.libelle).join('\n'))}</textarea>
          <div class="dos-boutons"><button class="btn btn-sm btn-primary">Enregistrer</button>
            ${t.personnalise ? '<button type="button" class="btn btn-sm" data-reinitialiser>Revenir aux étapes proposées</button>' : ''}</div>
        </form>`).join('')}</div>`).join('')}`;
  $main.querySelectorAll('.dos-modele').forEach((f) => {
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      try { dosCat = await api('PUT', `/dossiers/modeles/${f.dataset.type}`, { etapes: f.etapes.value }); toast('Modèle enregistré.'); render(); } catch (e) { toast(e.message, true); }
    };
    const r = f.querySelector('[data-reinitialiser]');
    if (r) r.onclick = async () => { dosCat = await api('DELETE', `/dossiers/modeles/${f.dataset.type}`); toast('Étapes proposées rétablies.'); render(); };
  });
}

/* ------------------------------------------------- tableau de bord */

/** Bloc « dossiers » du tableau de bord : en cours par famille, échéances, mes tâches. */
async function dosBlocTableauDeBord() {
  const [s, cat] = await Promise.all([api('GET', '/dossiers/synthese'), dosCatalogue()]);
  return `
    <div class="grid cols-4">
      ${DOS_FAMILLES.map((f) => `<a class="card dos-stat" href="#/dossiers?vue=${f}"><div class="stat">${s.par_famille[f] || 0}</div><div class="stat-label">${esc(cat.familles[f].libelle)}</div></a>`).join('')}
      <div class="card"><div class="stat" style="color:${s.echeances.some((x) => dosClasseDate(x.date) === 'retard') ? 'var(--danger)' : 'inherit'}">${s.echeances.length}</div><div class="stat-label">Échéances en retard ou à 30 jours</div></div>
    </div>
    <div class="grid cols-2 mt">
      <div class="card"><h2>Échéances en retard ou à 30 jours</h2>
        ${s.echeances.length ? `<table><tbody>${s.echeances.slice(0, 8).map((x) => `
          <tr class="clickable" onclick="location.hash='#/dossiers/${x.dossier_id}'"><td>${dosDate(x.date)}</td>
            <td>${esc(x.libelle)}<div class="sub">${esc(x.dossier_reference)} · ${esc(x.dossier_titre)}</div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Rien dans les 30 prochains jours</div>'}
      </div>
      <div class="card"><h2>Mes tâches</h2>
        ${s.mes_taches.length ? `<table><tbody>${s.mes_taches.slice(0, 8).map((t) => `
          <tr class="clickable" onclick="location.hash='#/dossiers/${t.dossier_id}'"><td>${t.echeance ? dosDate(t.echeance) : '—'}</td>
            <td>${esc(t.titre)}<div class="sub">${esc(t.dossier_reference)} · ${esc(t.dossier_titre)}</div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">Aucune tâche ouverte</div>'}
      </div>
    </div>`;
}

routes.unshift(
  { re: /^\/dossiers(?:\?(.*))?$/, view: vueDossiers, nav: 'dossiers' },
  { re: /^\/dossiers\/nouveau(?:\?(.*))?$/, view: vueDossierNouveau, nav: 'dossiers' },
  { re: /^\/dossiers\/modeles$/, view: vueModeles, nav: 'dossiers' },
  { re: /^\/dossiers\/(\d+)$/, view: vueDossier, nav: 'dossiers' },
  { re: /^\/clients$/, view: vueClients, nav: 'clients' },
  { re: /^\/clients\/(\d+)$/, view: vueClient, nav: 'clients' },
);
