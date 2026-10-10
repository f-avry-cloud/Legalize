'use strict';

/* =========================================================================
   Revue du jour.

   Chaque matin (et en début d'après-midi), l'assistant lit la boîte mail et
   dépose une revue : par dossier, ce qui s'est passé, ce qui est attendu de
   vous et des autres, et des propositions. Rien ne change dans un dossier
   tant que vous n'avez pas validé.
   ========================================================================= */

const RV_MOMENTS = { matin: 'matin', apres_midi: 'après-midi', reprise: 'reprise des 4 dernières semaines', manuelle: 'à la demande' };
const RV_PRIORITES = { haute: 'Prioritaire', normale: '', basse: 'Pour information', terminee: 'Terminé' };

async function majPastilleRevue() {
  const $p = document.getElementById('nav-badge-revue');
  if (!$p) return;
  try {
    const { propositions } = await api('GET', '/revues/en-attente');
    $p.textContent = propositions;
    $p.hidden = propositions === 0;
  } catch (e) { $p.hidden = true; }
}

function rvDateLongue(iso) {
  if (!iso) return '';
  return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function rvHeure(iso) {
  return iso ? new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}
function rvListe(items) {
  return items?.length ? `<ul>${items.map((x) => `<li>${esc(typeof x === 'string' ? x : x.texte || JSON.stringify(x))}</li>`).join('')}</ul>` : '<p class="muted">—</p>';
}

function rvProposition(p) {
  const fait = p.statut !== 'proposee';
  const corrigeable = ['creer_dossier', 'creer_tache', 'creer_echeance', 'ajouter_contact'].includes(p.nature);
  return `<li class="rv-prop ${p.statut}">
    <div class="dos-etape-corps"><span><strong>${esc(p.libelle)}</strong> — ${esc(p.texte)}</span>
      ${p.justification ? `<span class="sub">${esc(p.justification)}</span>` : ''}</div>
    ${fait ? `<span class="badge ${p.statut === 'acceptee' ? 'finalise' : 'abandonne'}">${p.statut === 'acceptee' ? 'Validée' : 'Refusée'}</span>`
    : `<div class="dos-boutons">
        <button type="button" class="btn btn-sm btn-primary" data-valider="${p.id}">Valider</button>
        ${corrigeable ? `<button type="button" class="btn btn-sm" data-corriger="${p.id}">Corriger</button>` : ''}
        <button type="button" class="btn-sm dos-suppr" data-refuser="${p.id}" title="Refuser" aria-label="Refuser">×</button></div>`}
  </li>`;
}

function rvMail(e) {
  return `<li><span class="rv-sens" title="${e.sens === 'envoye' ? 'Envoyé' : 'Reçu'}">${e.sens === 'envoye' ? '→' : '←'}</span>
    <div class="dos-etape-corps"><span>${esc(e.objet || '(sans objet)')}</span>
      <span class="sub">${esc(rvHeure(e.date))} · ${esc(e.expediteur || '')}${e.statut === 'propose' && e.dossier_id ? ' · rattachement à confirmer' : ''}</span>
      ${e.resume ? `<span class="sub">${esc(e.resume)}</span>` : ''}</div>
    ${e.lien ? `<a class="btn btn-sm" href="${esc(e.lien)}" target="_blank" rel="noopener">Ouvrir</a>` : ''}</li>`;
}

async function vueRevue(id) {
  const [r, cat] = await Promise.all([api('GET', `/revues/${id || 'derniere'}`), dosCatalogue()]);
  if (!r.revue) {
    $main.innerHTML = `<div class="page-head"><h1>Revue du jour</h1></div>
      <div class="card">${vueVide('Aucune revue pour l’instant. L’assistant lit la boîte mail chaque jour ouvré à 7 h 50 et 13 h 50 ; la revue apparaît ici.')}</div>`;
    return;
  }
  const { revue } = r;
  const s = revue.stats || {};
  const D = new Map(r.dossiers.map((d) => [d.id, d]));
  const titreCle = Object.fromEntries(r.sections.filter((x) => x.cle).map((x) => [x.cle, x.titre]));
  const lienDossier = (x) => (x.dossier_id ? `<a href="#/dossiers/${x.dossier_id}">${esc(D.get(x.dossier_id)?.titre || `Dossier ${x.dossier_id}`)}</a>`
    : esc(titreCle[x.dossier_cle] || x.dossier_cle || ''));
  const enAttente = (sec) => sec.propositions.filter((p) => p.statut === 'proposee').length;

  $main.innerHTML = `
    <div class="page-head rv-tete">
      <div><h1>Revue du ${esc(rvDateLongue(revue.date_revue))}</h1>
        <div class="dos-meta"><span class="badge">${esc(RV_MOMENTS[revue.moment] || revue.moment)}</span>
          <span class="muted">Mails ${revue.periode_debut ? `du ${esc(rvHeure(revue.periode_debut))} ` : ''}au ${esc(rvHeure(revue.periode_fin))}</span>
          ${revue.statut === 'partielle' ? '<span class="badge envoye">Revue partielle</span>' : ''}</div></div>
      <label class="field">Autres revues<select id="rv-choix">${r.revues.map((x) => `<option value="${x.id}" ${x.id === revue.id ? 'selected' : ''}>
        ${esc(fmtDate(x.date_revue))} · ${esc(RV_MOMENTS[x.moment] || x.moment)}${x.en_attente ? ` · ${x.en_attente} à valider` : ''}</option>`).join('')}</select></label>
    </div>
    <div class="rv-chiffres">
      <span><strong>${s.recus ?? '—'}</strong> reçus</span><span><strong>${s.envoyes ?? '—'}</strong> envoyés</span>
      <span><strong>${s.utiles ?? '—'}</strong> utiles</span><span><strong>${s.ecartes ?? r.ecartes}</strong> écartés</span>
    </div>
    ${(revue.remarques || []).length ? `<div class="alerte alerte-alerte"><strong>Points d’attention</strong>${rvListe(revue.remarques)}</div>` : ''}
    ${(revue.echeances || []).length ? `<div class="card mt"><h2>Échéances</h2><table><tbody>${revue.echeances.map((x) => `
      <tr><td>${dosDate(x.date)}</td><td>${esc(x.libelle)}</td><td class="right">${lienDossier(x)}</td></tr>`).join('')}</tbody></table></div>` : ''}

    ${r.sections.map((sec) => `
      <section class="card mt rv-bloc ${sec.priorite}">
        <div class="rv-bloc-tete">
          <h2>${sec.dossier ? `<a href="#/dossiers/${sec.dossier.id}">${esc(sec.titre)}</a>` : esc(sec.titre)}
            ${sec.dossier ? `<span class="dos-ref">${esc(sec.dossier.reference)}</span>` : (sec.cle ? '<span class="badge envoye">Dossier proposé</span>' : '')}
            ${RV_PRIORITES[sec.priorite] ? `<span class="badge ${sec.priorite === 'haute' ? 'a_faire' : ''}">${RV_PRIORITES[sec.priorite]}</span>` : ''}</h2>
          ${enAttente(sec) > 1 ? `<button type="button" class="btn btn-sm" data-tout="${sec.dossier_id || ''}" data-cle="${esc(sec.cle || '')}">Tout valider (${enAttente(sec)})</button>` : ''}
        </div>
        <div class="rv-colonnes">
          <div><h3>Ce qui s’est passé</h3>${rvListe(sec.faits)}</div>
          <div><h3>À faire de votre côté</h3>${rvListe(sec.a_faire)}</div>
          <div><h3>En attente des autres</h3>${rvListe(sec.en_attente)}</div>
        </div>
        ${sec.propositions.length ? `<h3>Propositions</h3><ul class="dos-liste-simple rv-props">${sec.propositions.map(rvProposition).join('')}</ul>` : ''}
        ${sec.emails.length ? `<details class="dos-faites"><summary>${sec.emails.length} mail(s)</summary>
          <ul class="dos-taches rv-mails">${sec.emails.map(rvMail).join('')}</ul>
          ${sec.dossier && sec.emails.some((e) => e.statut === 'propose') ? `<button type="button" class="btn btn-sm" data-confirmer="${sec.dossier.id}">Confirmer le rattachement de ces mails</button>` : ''}
        </details>` : ''}
      </section>`).join('')}

    ${r.autres_propositions.length ? `<div class="card mt"><h2>Autres propositions</h2><ul class="dos-liste-simple rv-props">${r.autres_propositions.map(rvProposition).join('')}</ul></div>` : ''}

    ${r.a_rattacher.length ? `<div class="card mt"><h2>Mails à ranger</h2><ul class="dos-taches rv-mails">${r.a_rattacher.map((e) => `
      <li><span class="rv-sens">${e.sens === 'envoye' ? '→' : '←'}</span>
        <div class="dos-etape-corps"><span>${esc(e.objet || '(sans objet)')}</span><span class="sub">${esc(rvHeure(e.date))} · ${esc(e.expediteur || '')}</span>
          ${e.resume ? `<span class="sub">${esc(e.resume)}</span>` : ''}</div>
        <select data-ranger-choix="${e.id}" aria-label="Dossier"><option value="">Dossier…</option>${r.dossiers.map((d) => `<option value="${d.id}">${esc(d.reference)} · ${esc(d.titre)}</option>`).join('')}</select>
        <button type="button" class="btn btn-sm" data-ranger="${e.id}">Ranger</button>
        <button type="button" class="btn btn-sm" data-ecarter="${e.id}" data-expediteur="${esc(e.expediteur || '')}">Écarter</button></li>`).join('')}</ul></div>` : ''}

    <p class="muted rv-pied">${r.ecartes} mail(s) écarté(s) : publicités, notifications automatiques, codes. <a href="#/revue/regles">Expéditeurs ignorés</a></p>`;

  const recharger = () => { majPastilleRevue(); vueRevue(revue.id); };
  const agir = async (fn, message) => {
    try { await fn(); if (message) toast(message); recharger(); } catch (e) { toast(e.message, true); }
  };
  document.getElementById('rv-choix').onchange = (e) => { location.hash = `#/revue/${e.target.value}`; };
  const toutes = [...r.sections.flatMap((x) => x.propositions), ...r.autres_propositions];
  $main.querySelectorAll('[data-valider]').forEach((b) => { b.onclick = () => agir(() => api('POST', `/propositions/${b.dataset.valider}/accepter`, {}), 'Validé.'); });
  $main.querySelectorAll('[data-refuser]').forEach((b) => { b.onclick = () => agir(() => api('POST', `/propositions/${b.dataset.refuser}/refuser`, {}), 'Refusé.'); });
  $main.querySelectorAll('[data-corriger]').forEach((b) => {
    b.onclick = () => rvCorriger(toutes.find((p) => String(p.id) === b.dataset.corriger), cat, () => recharger());
  });
  $main.querySelectorAll('[data-tout]').forEach((b) => {
    b.onclick = () => agir(async () => {
      const res = await api('POST', `/revues/${revue.id}/accepter-tout`, b.dataset.tout ? { dossier_id: Number(b.dataset.tout) } : { cle: b.dataset.cle });
      if (res.echecs.length) toast(`${res.faits.length} validée(s), ${res.echecs.length} à reprendre : ${res.echecs[0].erreur}`, true);
    }, 'Propositions validées.');
  });
  $main.querySelectorAll('[data-confirmer]').forEach((b) => {
    b.onclick = () => agir(() => api('POST', `/revues/${revue.id}/confirmer-emails`, { dossier_id: Number(b.dataset.confirmer) }), 'Mails rattachés.');
  });
  $main.querySelectorAll('[data-ranger]').forEach((b) => {
    b.onclick = () => {
      const choix = $main.querySelector(`[data-ranger-choix="${b.dataset.ranger}"]`).value;
      if (!choix) { toast('Choisissez le dossier.', true); return; }
      agir(() => api('PUT', `/emails/${b.dataset.ranger}`, { dossier_id: Number(choix) }), 'Mail rangé.');
    };
  });
  $main.querySelectorAll('[data-ecarter]').forEach((b) => {
    b.onclick = () => openDialog(`
      <form><h2>Écarter ce mail</h2>
        <label class="dos-case"><input type="checkbox" name="toujours"> Toujours ignorer ${esc(b.dataset.expediteur || 'cet expéditeur')}</label>
        <div class="dialog-actions"><button type="button" class="btn" onclick="this.closest('dialog').close()">Annuler</button><button class="btn btn-primary">Écarter</button></div>
      </form>`, async (form) => {
      await api('PUT', `/emails/${b.dataset.ecarter}`, { ignorer: true });
      if (form.toujours.checked && b.dataset.expediteur) await api('POST', '/revues/regles', { nature: 'ignorer_expediteur', valeur: b.dataset.expediteur });
      toast('Mail écarté.');
      recharger();
    });
  });
}

/** Corriger une proposition avant de la valider. */
async function rvCorriger(p, cat, apres) {
  const d = p.donnees || {};
  let champs = '';
  if (p.nature === 'creer_dossier') {
    const clients = await api('GET', '/clients');
    champs = `
      <label class="field">Type de dossier<select name="type">${DOS_FAMILLES.map((f) => `<optgroup label="${esc(cat.familles[f].libelle)}">
        ${cat.types.filter((t) => t.famille === f).map((t) => `<option value="${t.code}" ${t.code === d.type ? 'selected' : ''}>${esc(t.libelle)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label class="field">Intitulé<input name="titre" value="${esc(d.titre || '')}"></label>
      <label class="field">Client<select name="client_id"><option value="">Nouveau client : ${esc(d.client_nom || '')}</option>
        ${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(d.client_id || '') ? 'selected' : ''}>${esc(c.nom)}</option>`).join('')}</select></label>
      <label class="field">Nom du nouveau client<input name="client_nom" value="${esc(d.client_nom || '')}"></label>`;
  } else if (p.nature === 'creer_tache') {
    champs = `<label class="field">Tâche<input name="titre" value="${esc(d.titre || '')}"></label>
      <label class="field">Pour le<input type="date" name="echeance" value="${esc(d.echeance || '')}"></label>`;
  } else if (p.nature === 'creer_echeance') {
    champs = `<label class="field">Échéance<input name="libelle" value="${esc(d.libelle || '')}"></label>
      <label class="field">Date<input type="date" name="date" value="${esc(d.date || '')}"></label>`;
  } else if (p.nature === 'ajouter_contact') {
    champs = ['prenom', 'nom', 'fonction', 'email', 'telephone'].map((k) => `<label class="field">${{ prenom: 'Prénom', nom: 'Nom', fonction: 'Fonction', email: 'Courriel', telephone: 'Téléphone' }[k]}
      <input name="${k}" value="${esc(d[k] || '')}"></label>`).join('');
  }
  openDialog(`<form><h2>${esc(p.libelle)}</h2>${champs}
    <div class="dialog-actions"><button type="button" class="btn" onclick="this.closest('dialog').close()">Annuler</button><button class="btn btn-primary">Valider</button></div></form>`,
  async (form) => {
    const modifs = Object.fromEntries([...form.elements].filter((x) => x.name).map((x) => [x.name, x.value]));
    if (p.nature === 'creer_dossier' && !modifs.client_id) delete modifs.client_id;
    await api('POST', `/propositions/${p.id}/accepter`, modifs);
    toast('Validé.');
    apres();
  });
}

/** Expéditeurs, domaines et objets que l'assistant ignore. */
async function vueReglesRevue() {
  const regles = await api('GET', '/revues/regles');
  const natures = { ignorer_expediteur: 'Expéditeur', ignorer_domaine: 'Domaine', ignorer_objet: 'Objet contenant' };
  $main.innerHTML = `
    <div class="page-head"><div><div class="crumb"><a href="#/revue">Revue du jour</a> /</div><h1>Mails ignorés</h1>
      <p class="muted">L’assistant écarte ces mails sans les lire.</p></div></div>
    <div class="card">
      ${regles.length ? `<ul class="dos-liste-simple">${regles.map((x) => `<li><div><strong>${esc(x.valeur)}</strong><span class="sub">${esc(natures[x.nature])}</span></div>
        <button type="button" class="btn-sm dos-suppr" data-suppr="${x.id}" aria-label="Retirer">×</button></li>`).join('')}</ul>` : '<p class="muted">Aucune règle.</p>'}
      <form class="dos-ajout" id="rg-ajout"><select name="nature">${Object.entries(natures).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
        <input name="valeur" placeholder="ex. newsletter@exemple.fr, exemple.fr" required><button class="btn btn-sm">Ajouter</button></form>
    </div>`;
  $main.querySelectorAll('[data-suppr]').forEach((b) => { b.onclick = async () => { await api('DELETE', `/revues/regles/${b.dataset.suppr}`); render(); }; });
  document.getElementById('rg-ajout').onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/revues/regles', { nature: ev.target.nature.value, valeur: ev.target.valeur.value }); render(); } catch (e) { toast(e.message, true); }
  };
}

routes.unshift(
  { re: /^\/revue$/, view: () => vueRevue(), nav: 'revue' },
  { re: /^\/revue\/regles$/, view: vueReglesRevue, nav: 'revue' },
  { re: /^\/revue\/(\d+)$/, view: vueRevue, nav: 'revue' },
);
