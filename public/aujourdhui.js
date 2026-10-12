'use strict';

/* =========================================================================
   Aujourd'hui.

   Un seul écran pour commencer la journée, sur le modèle des listes
   « Aujourd'hui » des outils de gestion de tâches :
   1. À faire — vos tâches et celles que l'assistant suggère, rangées par
      urgence (en retard, aujourd'hui, cette semaine, plus tard) ; une ligne
      chacune, un clic pour cocher ou accepter, un clic pour déplier ;
   2. Échéances des 14 prochains jours ;
   3. Nouveau dans vos dossiers — une ligne par dossier, dépliable ;
   4. À valider — les autres suggestions de l'assistant ;
   5. En attente des autres — replié.
   ========================================================================= */

const AJ_TRANCHES = [
  ['retard', 'En retard'], ['aujourdhui', 'Aujourd’hui'], ['semaine', 'Cette semaine'], ['plus_tard', 'Plus tard'], ['sans_date', 'Sans date'],
];

function ajDateCourte(iso) {
  if (!iso) return '';
  return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
}
function ajPuceDossier(d) {
  if (!d) return '';
  const titre = d.titre || d.reference || '';
  const nom = titre.split(' — ')[0];
  return d.id ? `<a class="aj-dossier" href="#/dossiers/${d.id}" title="${esc(titre)}">${esc(nom)}</a>`
    : `<span class="aj-dossier propose" title="Dossier proposé, pas encore ouvert">${esc(nom)}</span>`;
}

async function vueAujourdhui() {
  const a = await api('GET', '/aujourdhui');
  const parTranche = Object.fromEntries(AJ_TRANCHES.map(([k]) => [k, a.taches.filter((t) => t.tranche === k)]));
  const nbSuggestions = a.taches.filter((t) => t.suggestion).length + a.suggestions.length;
  const echeances = [...a.echeances, ...a.echeances_revue].sort((x, y) => String(x.date).localeCompare(String(y.date)));
  const enAttente = a.nouveautes.flatMap((n) => (n.en_attente || []).map((x) => ({ texte: x, dossier: n.dossier, titre: n.titre })));
  const resume = [
    parTranche.retard.length && `<strong class="aj-rouge">${parTranche.retard.length} en retard</strong>`,
    `<strong>${parTranche.aujourdhui.length}</strong> pour aujourd’hui`,
    `<strong>${parTranche.semaine.length}</strong> cette semaine`,
    echeances.length && `<strong>${echeances.length}</strong> échéance(s) à 14 jours`,
    nbSuggestions && `<strong>${nbSuggestions}</strong> suggestion(s)`,
  ].filter(Boolean).join(' · ');

  $main.innerHTML = `
    <div class="aj">
      <header class="aj-tete">
        <div><h1>Aujourd’hui</h1><p class="muted">${esc(new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }))}</p></div>
        <p class="aj-resume">${resume}</p>
      </header>
      ${(a.revue?.remarques || []).length ? `<div class="alerte alerte-alerte aj-remarques">${a.revue.remarques.map((r) => `<div>${esc(r)}</div>`).join('')}</div>` : ''}

      <section class="aj-section">
        <div class="aj-section-tete"><h2>À faire</h2>
          <button type="button" class="btn btn-sm" id="aj-ajout-ouvrir">+ Tâche</button></div>
        <form class="aj-ajout" id="aj-ajout" hidden>
          <input name="titre" placeholder="Nouvelle tâche" aria-label="Nouvelle tâche" required>
          <select name="dossier" aria-label="Dossier" required><option value="">Dossier…</option>${a.dossiers.map((d) => `<option value="${d.id}">${esc(d.reference)} · ${esc(d.titre)}</option>`).join('')}</select>
          <input type="date" name="echeance" aria-label="Pour le">
          <button class="btn btn-sm btn-primary">Ajouter</button>
        </form>
        ${a.taches.length ? AJ_TRANCHES.filter(([k]) => parTranche[k].length).map(([k, libelle]) => `
          <div class="aj-groupe ${k}"><h3>${libelle} <span>${parTranche[k].length}</span></h3>
            <ul class="aj-liste">${parTranche[k].map((t) => ajLigneTache(t)).join('')}</ul></div>`).join('')
    : '<p class="muted aj-vide">Rien à faire pour l’instant. Les tâches de vos dossiers et celles que suggère la revue des mails apparaissent ici.</p>'}
      </section>

      ${echeances.length ? `<section class="aj-section"><div class="aj-section-tete"><h2>Échéances</h2></div>
        <ul class="aj-liste">${echeances.map((x) => `<li class="aj-ligne"><span class="aj-date ${dosClasseDate(x.date)}">${esc(ajDateCourte(x.date))}</span>
          <span class="aj-titre">${esc(x.libelle)}</span>${ajPuceDossier(x.dossier)}</li>`).join('')}</ul></section>` : ''}

      ${a.nouveautes.length ? `<section class="aj-section"><div class="aj-section-tete"><h2>Nouveau dans vos dossiers</h2>
        <a class="aj-lien" href="#/revue/${a.revue.id}">Revue complète ›</a></div>
        <ul class="aj-liste">${a.nouveautes.map((n) => `
          <li class="aj-ligne aj-depliable" data-deplier>
            <span class="aj-point ${n.priorite}" title="${n.priorite === 'haute' ? 'Prioritaire' : ''}"></span>
            <span class="aj-titre"><strong>${n.dossier ? `<a href="#/dossiers/${n.dossier.id}">${esc(String(n.titre || '').split(' — ')[0])}</a>` : esc(String(n.titre || '').split(' — ')[0])}</strong>
              <span class="aj-sous">${esc(n.resume)}</span></span>
            <span class="aj-chevron" aria-hidden="true">›</span>
            <div class="aj-detail" hidden>
              ${n.faits?.length ? `<h4>Ce qui s’est passé</h4><ul>${n.faits.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
              ${n.en_attente?.length ? `<h4>En attente</h4><ul>${n.en_attente.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
              ${n.emails?.length ? `<h4>Mails</h4><ul>${n.emails.map((e) => `<li>${e.sens === 'envoye' ? '→' : '←'} ${esc(e.objet || '(sans objet)')} <span class="muted">· ${esc(e.expediteur || '')}</span>
                ${e.lien ? ` <a href="${esc(e.lien)}" target="_blank" rel="noopener">Ouvrir</a>` : ''}</li>`).join('')}</ul>` : ''}
            </div>
          </li>`).join('')}</ul></section>` : ''}

      ${a.suggestions.length ? `<section class="aj-section"><div class="aj-section-tete"><h2>À valider <span class="aj-compte">${a.suggestions.length}</span></h2>
        ${a.suggestions.length > 1 ? '<button type="button" class="btn btn-sm" id="aj-tout">Tout accepter</button>' : ''}</div>
        <ul class="aj-liste">${a.suggestions.map((p) => `
          <li class="aj-ligne aj-depliable" data-deplier>
            <span class="aj-icone" aria-hidden="true">${{ creer_dossier: '＋', ajouter_contact: '@', creer_echeance: '◷', echeance_tenue: '✓', etape_faite: '✓', tache_faite: '✓', changer_statut: '◇' }[p.nature] || '•'}</span>
            <span class="aj-titre">${esc(p.libelle)} <span class="aj-sous">${esc(p.texte)}</span></span>
            ${ajPuceDossier(p.dossier)}
            <span class="aj-actions">
              <button type="button" class="aj-oui" data-accepter="${p.id}" title="Accepter" aria-label="Accepter">✓</button>
              ${['creer_dossier', 'creer_echeance', 'ajouter_contact'].includes(p.nature) ? `<button type="button" class="aj-corriger" data-corriger="${p.id}" title="Corriger puis accepter" aria-label="Corriger">✎</button>` : ''}
              <button type="button" class="aj-non" data-refuser="${p.id}" title="Refuser" aria-label="Refuser">✕</button></span>
            ${p.justification ? `<div class="aj-detail" hidden><p class="muted">${esc(p.justification)}</p></div>` : ''}
          </li>`).join('')}</ul></section>` : ''}

      ${enAttente.length ? `<section class="aj-section"><details><summary><h2>En attente des autres <span class="aj-compte">${enAttente.length}</span></h2></summary>
        <ul class="aj-liste">${enAttente.map((x) => `<li class="aj-ligne"><span class="aj-titre">${esc(x.texte)}</span>${ajPuceDossier(x.dossier || { titre: x.titre, cle: true })}</li>`).join('')}</ul>
      </details></section>` : ''}

      <p class="muted aj-pied">${a.revue ? `Dernière revue des mails : ${esc(ajDateCourte(a.revue.date_revue))}, ${esc(RV_MOMENTS[a.revue.moment] || a.revue.moment)}${a.revue.stats?.utiles !== undefined ? ` — ${a.revue.stats.utiles} mail(s) utile(s) sur ${(a.revue.stats.recus || 0) + (a.revue.stats.envoyes || 0)}` : ''}.`
    : 'Aucune revue des mails pour l’instant.'}${a.a_ranger ? ` <a href="#/revue/${a.revue.id}">${a.a_ranger} mail(s) à ranger</a>.` : ''}</p>
    </div>`;

  const suggestions = new Map([...a.suggestions, ...a.taches.filter((t) => t.suggestion).map((t) => ({ id: t.proposition_id, nature: 'creer_tache', libelle: 'Ajouter la tâche', donnees: { titre: t.titre, echeance: t.echeance } }))].map((p) => [String(p.id), p]));
  const agir = async (fn, message) => {
    try { await fn(); if (message) toast(message); majPastilleRevue(); vueAujourdhui(); } catch (e) { toast(e.message, true); }
  };
  $main.querySelectorAll('[data-deplier]').forEach((li) => {
    li.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, select')) return;
      const d = li.querySelector('.aj-detail');
      if (d) { d.hidden = !d.hidden; li.classList.toggle('ouvert', !d.hidden); }
    });
  });
  $main.querySelectorAll('[data-fait]').forEach((b) => {
    b.onclick = () => {
      b.closest('li').classList.add('fait');
      setTimeout(() => agir(() => api('PUT', `/taches/${b.dataset.fait}`, { statut: 'fait' }), 'Tâche faite.'), 250);
    };
  });
  $main.querySelectorAll('[data-accepter]').forEach((b) => { b.onclick = () => agir(() => api('POST', `/propositions/${b.dataset.accepter}/accepter`, {}), 'Accepté.'); });
  $main.querySelectorAll('[data-refuser]').forEach((b) => { b.onclick = () => agir(() => api('POST', `/propositions/${b.dataset.refuser}/refuser`, {}), 'Refusé.'); });
  $main.querySelectorAll('[data-corriger]').forEach((b) => {
    b.onclick = async () => rvCorriger(suggestions.get(b.dataset.corriger), await dosCatalogue(), () => { majPastilleRevue(); vueAujourdhui(); });
  });
  const $tout = document.getElementById('aj-tout');
  if ($tout) {
    $tout.onclick = () => agir(async () => {
      // L'ouverture des dossiers d'abord : le reste peut en dépendre.
      const liste = [...a.suggestions].sort((x, y) => (x.nature === 'creer_dossier' ? -1 : 0) - (y.nature === 'creer_dossier' ? -1 : 0));
      const echecs = [];
      for (const p of liste) await api('POST', `/propositions/${p.id}/accepter`, {}).catch((e) => echecs.push(e.message));
      if (echecs.length) throw new Error(`${liste.length - echecs.length} accepté(s), ${echecs.length} à reprendre : ${echecs[0]}`);
    }, 'Tout est accepté.');
  }
  const $form = document.getElementById('aj-ajout');
  document.getElementById('aj-ajout-ouvrir').onclick = () => { $form.hidden = !$form.hidden; if (!$form.hidden) $form.titre.focus(); };
  $form.onsubmit = (ev) => {
    ev.preventDefault();
    agir(() => api('POST', `/dossiers/${$form.dossier.value}/taches`, { titre: $form.titre.value, echeance: $form.echeance.value || null }), 'Tâche ajoutée.');
  };
}

function ajLigneTache(t) {
  const date = t.echeance ? `<span class="aj-date ${dosClasseDate(t.echeance)}">${esc(ajDateCourte(t.echeance))}</span>` : '';
  if (t.suggestion) {
    return `<li class="aj-ligne suggestion aj-depliable" data-deplier>
      <span class="aj-coche suggestion" aria-hidden="true"></span>
      <span class="aj-titre">${esc(t.titre)} <span class="aj-badge">suggérée</span></span>
      ${ajPuceDossier(t.dossier)}${date}
      <span class="aj-actions"><button type="button" class="aj-oui" data-accepter="${t.proposition_id}" title="Ajouter à mes tâches" aria-label="Accepter">✓</button>
        <button type="button" class="aj-non" data-refuser="${t.proposition_id}" title="Écarter" aria-label="Refuser">✕</button></span>
      ${t.justification ? `<div class="aj-detail" hidden><p class="muted">${esc(t.justification)}</p></div>` : ''}
    </li>`;
  }
  return `<li class="aj-ligne">
    <button type="button" class="aj-coche" data-fait="${t.id}" title="Marquer faite" aria-label="Marquer faite : ${esc(t.titre)}"></button>
    <span class="aj-titre">${esc(t.titre)}${t.origine === 'agent' ? ' <span class="aj-badge discret">assistant</span>' : ''}</span>
    ${ajPuceDossier(t.dossier)}${date}
  </li>`;
}

routes.unshift({ re: /^\/?$/, view: vueAujourdhui, nav: 'aujourdhui' });
