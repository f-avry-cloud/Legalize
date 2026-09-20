'use strict';

/* ================================================================
   Module « Formalités INPI » — parcours en trois écrans :
     #/formalites       suivi (ce qui bloque, ce qui presse, ce qui avance)
     #/formalites/new   ouverture : un SIREN + une formalité
     #/formalites/:id   questionnaire, pièces, contrôles, dépôt, journal
   Le formulaire est engendré à partir du catalogue servi par l'API : ajouter
   une formalité côté serveur suffit, le front n'a pas à être touché.
   ================================================================ */

const STATUT_FORMALITE = {
  BROUILLON: 'Brouillon', A_SIGNER: 'À signer', SIGNEE: 'Signée', A_PAYER: 'À payer',
  DEPOSEE: 'Déposée', EN_COURS: 'En cours', REGULARISATION: 'Régularisation',
  VALIDEE: 'Validée', REJETEE: 'Rejetée', ABANDONNEE: 'Abandonnée',
};

const CLASSE_STATUT = {
  BROUILLON: 'brouillon', A_SIGNER: 'envoye', SIGNEE: 'genere', A_PAYER: 'envoye',
  DEPOSEE: 'genere', EN_COURS: 'en_cours', REGULARISATION: 'a_faire',
  VALIDEE: 'finalise', REJETEE: 'a_faire', ABANDONNEE: 'abandonne',
};

let catalogueFormalites = null;
async function getCatalogue() {
  if (!catalogueFormalites) catalogueFormalites = (await api('GET', '/formalites/catalogue')).formalites;
  return catalogueFormalites;
}

let etatInpi = null;
async function getEtatInpi() {
  if (!etatInpi) etatInpi = await api('GET', '/inpi/etat');
  return etatInpi;
}

function bandeauMode(etat) {
  if (etat.guichet.mode === 'live' && etat.guichet.depotReelAutorise) return '';
  const raison = etat.guichet.mode === 'demo'
    ? 'Aucun identifiant Guichet unique configuré'
    : 'Dépôt réel désactivé (INPI_DEPOT_REEL)';
  return `<div class="alerte alerte-info">
    <strong>Mode simulation.</strong> ${esc(raison)} : le parcours complet est disponible
    (pré-remplissage${etat.rne.mode === 'demo' ? ' simulé' : ' RNE réel'}, contrôles, JSON INPI, suivi),
    mais aucune formalité n'est transmise à l'INPI.</div>`;
}

/* ================================================================ suivi */

async function formalitesDashboard() {
  const [d, etat] = await Promise.all([api('GET', '/formalites/dashboard'), getEtatInpi()]);
  const c = d.compteurs;
  $main.innerHTML = `
    <div class="page-head"><h1>Formalités</h1>
      <div>
        <button id="btn-sync">Synchroniser avec l'INPI</button>
        <a class="btn btn-primary" href="#/formalites/new">Nouvelle formalité</a>
      </div>
    </div>
    ${bandeauMode(etat)}
    <div class="grid cols-4">
      <div class="card"><div class="stat">${c.en_cours}</div><div class="stat-label">En cours</div></div>
      <div class="card"><div class="stat">${c.brouillons}</div><div class="stat-label">Brouillons</div></div>
      <div class="card"><div class="stat" style="color:${c.regularisations ? 'var(--danger)' : 'var(--ok)'}">${c.regularisations}</div><div class="stat-label">Régularisations</div></div>
      <div class="card"><div class="stat" style="color:${c.en_retard ? 'var(--danger)' : 'var(--ok)'}">${c.en_retard}</div><div class="stat-label">Hors délai</div></div>
    </div>
    <div class="grid cols-2 mt">
      <div class="card">
        <h2>À traiter en priorité</h2>
        ${listeFormalites(d.a_traiter, 'Rien à traiter')}
      </div>
      <div class="card">
        <h2>Prochaines échéances légales</h2>
        ${d.echeances.length ? `<table><tbody>${d.echeances.map((f) => `
          <tr class="clickable" onclick="location.hash='#/formalites/${f.id}'">
            <td>${esc(f.type_libelle)}<div class="sub">${esc(f.societe_nom)}</div></td>
            <td class="right">${echeanceHtml(f)}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Aucune échéance en cours</div>'}
      </div>
    </div>
    <div class="card mt">
      <h2>Tous les dossiers</h2>
      ${listeFormalites(d.recentes, 'Aucun dossier. Ouvrez la première formalité.')}
    </div>`;

  document.getElementById('btn-sync').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/formalites/synchroniser');
      toast(`${r.synchronisees} dossier(s) interrogé(s), ${r.changements} changement(s) de statut.`);
      render();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

function echeanceHtml(f) {
  if (!f.echeance) return '<span class="muted">—</span>';
  return f.en_retard
    ? `<span class="badge a_faire">dépassée le ${fmtDate(f.echeance)}</span>`
    : `<span class="muted">${fmtDate(f.echeance)}</span>`;
}

function listeFormalites(liste, vide) {
  if (!liste.length) return `<div class="empty">${esc(vide)}</div>`;
  return `<table>
    <thead><tr><th>Dossier</th><th>Société</th><th>Statut</th><th>Échéance</th></tr></thead>
    <tbody>${liste.map((f) => `
      <tr class="clickable" onclick="location.hash='#/formalites/${f.id}'">
        <td><strong>${esc(f.type_libelle)}</strong><div class="sub">${esc(f.reference || '')}${f.simule ? ' · simulation' : ''}</div></td>
        <td>${esc(f.societe_nom || '—')}</td>
        <td>${badgeStatut(f.statut)}${f.nb_regularisations ? ' <span class="badge a_faire">à régulariser</span>' : ''}</td>
        <td>${echeanceHtml(f)}</td>
      </tr>`).join('')}</tbody></table>`;
}

function badgeStatut(statut) {
  return `<span class="badge ${CLASSE_STATUT[statut] || 'brouillon'}">${esc(STATUT_FORMALITE[statut] || statut)}</span>`;
}

/* ================================================== ouverture d'un dossier */

async function formaliteNew() {
  const [cat, etat, societes] = await Promise.all([getCatalogue(), getEtatInpi(), api('GET', '/societes')]);
  const groupes = { creation: 'Créer', modification: 'Modifier', cessation: 'Cesser', depot: 'Déposer' };

  $main.innerHTML = `
    <div class="page-head">
      <div><div class="crumb"><a href="#/formalites">Formalités</a> ›</div><h1>Nouvelle formalité</h1></div>
    </div>
    ${bandeauMode(etat)}
    <div class="card">
      <h2>1. Quelle entreprise ?</h2>
      <div class="row">
        <label class="field">SIREN
          <input id="siren" placeholder="9 chiffres" autocomplete="off">
        </label>
        <label class="field">ou une société du cabinet
          <select id="societe"><option value="">—</option>
            ${societes.map((s) => `<option value="${s.id}" data-siren="${esc(s.siren || '')}">${esc(s.denomination)}</option>`).join('')}
          </select>
        </label>
        <label class="field">ou une recherche par nom
          <input id="recherche" placeholder="Dénomination" autocomplete="off">
        </label>
      </div>
      <div id="resultat-siren"></div>
    </div>

    <div class="card mt">
      <h2>2. Quelle formalité ?</h2>
      <div class="choix-formalites">
        ${cat.map((f) => `
          <label class="choix" data-code="${f.code}">
            <input type="radio" name="type" value="${f.code}">
            <span>
              <strong>${esc(groupes[f.categorie] || '')} · ${esc(f.libelle)}</strong>
              <em>${esc(f.resume)}</em>
              <em class="delai">${esc(f.delai?.texte || '')}</em>
            </span>
          </label>`).join('')}
      </div>
    </div>

    <div class="page-head mt">
      <span class="muted" id="recap-choix">Sélectionnez une entreprise et une formalité.</span>
      <button class="btn-gold" id="btn-ouvrir" disabled>Ouvrir le dossier</button>
    </div>`;

  const $siren = document.getElementById('siren');
  const $societe = document.getElementById('societe');
  const $recherche = document.getElementById('recherche');
  const $resultat = document.getElementById('resultat-siren');
  const $bouton = document.getElementById('btn-ouvrir');
  const $recap = document.getElementById('recap-choix');
  let fiche = null;

  function majBouton() {
    const type = document.querySelector('input[name="type"]:checked')?.value;
    const def = cat.find((f) => f.code === type);
    const pret = Boolean(type) && (def?.sansSiren || fiche);
    $bouton.disabled = !pret;
    $recap.textContent = pret
      ? `${def.libelle}${fiche ? ` — ${fiche.denomination}` : ''}`
      : 'Sélectionnez une entreprise et une formalité.';
  }

  async function chargerSiren(valeur) {
    const siren = String(valeur || '').replace(/\D/g, '');
    if (siren.length !== 9) { fiche = null; $resultat.innerHTML = ''; majBouton(); return; }
    $resultat.innerHTML = '<div class="empty">Interrogation du registre national des entreprises…</div>';
    try {
      fiche = await api('GET', `/inpi/entreprise/${siren}`);
      $resultat.innerHTML = fichePreviewHtml(fiche);
    } catch (e) {
      fiche = null;
      $resultat.innerHTML = `<div class="alerte alerte-bloquant">${esc(e.message)}</div>`;
    }
    majBouton();
  }

  $siren.addEventListener('change', () => chargerSiren($siren.value));
  $siren.addEventListener('blur', () => chargerSiren($siren.value));
  $societe.addEventListener('change', () => {
    const siren = $societe.selectedOptions[0]?.dataset.siren || '';
    $siren.value = siren;
    chargerSiren(siren);
  });

  let minuteur;
  $recherche.addEventListener('input', () => {
    clearTimeout(minuteur);
    const terme = $recherche.value.trim();
    if (terme.length < 3) return;
    minuteur = setTimeout(async () => {
      try {
        const res = await api('GET', `/inpi/recherche?q=${encodeURIComponent(terme)}`);
        $resultat.innerHTML = res.length ? `<table><tbody>${res.map((r) => `
          <tr class="clickable" data-siren="${r.siren}">
            <td><strong>${esc(r.denomination)}</strong><div class="sub">${esc(r.siren_formate)} · ${esc(r.commune || '')}</div></td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty">Aucun résultat</div>';
        $resultat.querySelectorAll('tr[data-siren]').forEach((tr) => {
          tr.onclick = () => { $siren.value = tr.dataset.siren; chargerSiren(tr.dataset.siren); };
        });
      } catch (e) { toast(e.message, true); }
    }, 400);
  });

  document.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', majBouton));

  $bouton.onclick = async () => {
    $bouton.disabled = true;
    try {
      const formalite = await api('POST', '/formalites', {
        type: document.querySelector('input[name="type"]:checked').value,
        siren: fiche?.siren || '',
        societe_id: $societe.value ? Number($societe.value) : null,
      });
      if (formalite.avertissement) toast(formalite.avertissement, true);
      location.hash = `#/formalites/${formalite.id}`;
    } catch (e) { toast(e.message, true); $bouton.disabled = false; }
  };
}

function fichePreviewHtml(f) {
  const d = (f.dirigeants || [])[0];
  return `<div class="fiche-rne">
    <div class="fiche-head"><strong>${esc(f.denomination)}</strong>
      <span class="badge ${f.radiee ? 'radiee' : 'active'}">${f.radiee ? 'Radiée' : 'Active'}</span>
      ${f.simule ? '<span class="badge brouillon">données simulées</span>' : '<span class="badge finalise">RNE</span>'}
    </div>
    <dl>
      <div><dt>SIREN</dt><dd>${esc(f.siren_formate)}</dd></div>
      <div><dt>Forme</dt><dd>${esc(f.forme_juridique || '—')}</dd></div>
      <div><dt>Capital</dt><dd>${f.capital != null ? eur.format(f.capital) : '—'}</dd></div>
      <div><dt>Siège</dt><dd>${esc(f.adresse?.texte || '—')}</dd></div>
      <div><dt>Immatriculation</dt><dd>${fmtDate(f.date_immatriculation)}</dd></div>
      <div><dt>Dirigeant</dt><dd>${esc(d?.nom_complet || '—')}</dd></div>
    </dl>
    <p class="muted">Ces données proviennent du registre : elles ne seront pas ressaisies.</p>
  </div>`;
}

/* ================================================== dossier : questionnaire */

function champHtml(champ, valeur, contexte) {
  const id = `champ-${champ.name}`;
  const aide = champ.aide ? `<em class="aide">${esc(champ.aide)}</em>` : '';
  const requis = champ.required ? ' <span class="requis">*</span>' : '';
  const label = `${esc(champ.label)}${requis}`;

  switch (champ.type) {
    case 'textarea':
      return `<label class="field wide">${label}<textarea name="${champ.name}" id="${id}">${esc(valeur || '')}</textarea>${aide}</label>`;
    case 'checkbox': {
      // Une case non encore enregistrée prend la valeur par défaut du catalogue.
      const coche = valeur === undefined || valeur === null ? champ.default : valeur;
      return `<label class="check"><input type="checkbox" name="${champ.name}" id="${id}" ${coche ? 'checked' : ''}> ${label}${aide}</label>`;
    }
    case 'select': {
      const options = champ.source === 'formes'
        ? (contexte.formes || []).map((f) => ({ value: f.code, label: f.libelle }))
        : champ.source === 'dirigeants_rne'
          ? (contexte.dirigeants || []).map((d) => ({ value: d.nom_complet, label: `${d.nom_complet}` }))
          : (champ.options || []);
      return `<label class="field">${label}
        <select name="${champ.name}" id="${id}" data-pilote="1">
          <option value="">—</option>
          ${options.map((o) => `<option value="${esc(o.value)}" ${String(valeur) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>${aide}</label>`;
    }
    case 'adresse': {
      const a = valeur || {};
      return `<fieldset class="list-field"><legend>${label}</legend>
        <div class="row">
          <label class="field">N°<input name="${champ.name}.numVoie" value="${esc(a.numVoie || '')}"></label>
          <label class="field">Type de voie<input name="${champ.name}.typeVoie" value="${esc(a.typeVoie || '')}" placeholder="RUE, AVENUE…"></label>
          <label class="field">Voie<input name="${champ.name}.voie" value="${esc(a.voie || '')}"></label>
        </div>
        <div class="row">
          <label class="field">Complément<input name="${champ.name}.complementLocalisation" value="${esc(a.complementLocalisation || '')}"></label>
          <label class="field">Code postal<input name="${champ.name}.codePostal" value="${esc(a.codePostal || '')}" maxlength="5"></label>
          <label class="field">Commune<input name="${champ.name}.commune" value="${esc(a.commune || '')}"></label>
        </div>${aide}</fieldset>`;
    }
    case 'personne': {
      const p = valeur || {};
      const a = p.adresse || {};
      return `<fieldset class="list-field"><legend>${label}</legend>
        <div class="row">
          <label class="field">Nom<input name="${champ.name}.nom" value="${esc(p.nom || '')}"></label>
          <label class="field">Prénoms<input name="${champ.name}.prenoms" value="${esc(Array.isArray(p.prenoms) ? p.prenoms.join(' ') : (p.prenoms || ''))}"></label>
          <label class="field">Fonction<input name="${champ.name}.fonction" value="${esc(p.fonction || '')}"></label>
        </div>
        <div class="row">
          <label class="field">Date de naissance<input type="date" name="${champ.name}.date_naissance" value="${esc(p.date_naissance || '')}"></label>
          <label class="field">Lieu de naissance<input name="${champ.name}.lieu_naissance" value="${esc(p.lieu_naissance || '')}"></label>
          <label class="field">Nationalité<input name="${champ.name}.nationalite" value="${esc(p.nationalite || 'Française')}"></label>
        </div>
        <div class="row">
          <label class="field">Adresse — n° et voie<input name="${champ.name}.adresse.voie" value="${esc(a.voie || '')}"></label>
          <label class="field">Code postal<input name="${champ.name}.adresse.codePostal" value="${esc(a.codePostal || '')}" maxlength="5"></label>
          <label class="field">Commune<input name="${champ.name}.adresse.commune" value="${esc(a.commune || '')}"></label>
        </div>${aide}</fieldset>`;
    }
    default: {
      const type = champ.type === 'date' ? 'date' : (champ.type === 'number' || champ.type === 'money' ? 'number' : 'text');
      const pas = champ.type === 'money' ? ' step="0.01"' : '';
      return `<label class="field">${label}
        <input type="${type}"${pas} name="${champ.name}" id="${id}" value="${esc(valeur ?? champ.default ?? '')}">${aide}</label>`;
    }
  }
}

/** Reconstitue l'objet de réponses depuis le formulaire (clés pointées). */
function collecterReponses(form, champs) {
  const r = {};
  for (const champ of champs) {
    if (champ.type === 'checkbox') {
      r[champ.name] = form.querySelector(`[name="${champ.name}"]`)?.checked || false;
      continue;
    }
    if (champ.type === 'adresse' || champ.type === 'personne') {
      const objet = {};
      form.querySelectorAll(`[name^="${champ.name}."]`).forEach((input) => {
        const cle = input.name.slice(champ.name.length + 1);
        if (cle.includes('.')) {
          const [parent, enfant] = cle.split('.');
          objet[parent] = objet[parent] || {};
          objet[parent][enfant] = input.value;
        } else {
          objet[cle] = input.value;
        }
      });
      if (champ.type === 'personne') {
        objet.prenoms = String(objet.prenoms || '').split(/[\s,]+/).filter(Boolean);
        objet.nom_complet = [objet.prenoms.join(' '), objet.nom].filter(Boolean).join(' ');
      } else {
        objet.texte = [
          [objet.numVoie, objet.typeVoie, objet.voie].filter(Boolean).join(' '),
          objet.complementLocalisation,
          [objet.codePostal, objet.commune].filter(Boolean).join(' '),
        ].filter(Boolean).join(', ');
      }
      r[champ.name] = objet;
      continue;
    }
    const input = form.querySelector(`[name="${champ.name}"]`);
    if (!input) continue;
    r[champ.name] = champ.type === 'number' || champ.type === 'money'
      ? (input.value === '' ? null : Number(input.value))
      : input.value;
  }
  return r;
}

/* ============================================================ dossier : vue */

async function formaliteDetail(id) {
  const [f, etat] = await Promise.all([api('GET', `/formalites/${id}`), getEtatInpi()]);
  const def = f.definition;
  const champs = (def?.champs || []).filter((c) => !c.depend || c.depend.valeurs.includes(f.reponses[c.depend.name]));
  const terminal = ['VALIDEE', 'REJETEE', 'ABANDONNEE'].includes(f.statut);
  const depose = f.statut !== 'BROUILLON';

  $main.innerHTML = `
    <div class="page-head">
      <div>
        <div class="crumb"><a href="#/formalites">Formalités</a> › ${esc(f.reference || '')}</div>
        <h1>${esc(def?.libelle || f.type)}</h1>
        <div class="muted">${esc(f.societe_nom || '')} ${f.siren ? `· ${esc(f.fiche?.siren_formate || f.siren)}` : ''}</div>
      </div>
      <div>${badgeStatut(f.statut)}${f.simule ? ' <span class="badge brouillon">simulation</span>' : ''}</div>
    </div>

    ${f.regularisations?.length ? `<div class="alerte alerte-bloquant">
      <strong>Régularisation demandée par l'INPI.</strong>
      <ul>${f.regularisations.map((r) => `<li>${esc(r.motif)}${r.delai_reponse_jours ? ` — à traiter sous ${r.delai_reponse_jours} jours` : ''}</li>`).join('')}</ul>
    </div>` : ''}

    <div class="grid cols-2">
      <div>
        <div class="card">
          <h2>Ce qui change</h2>
          <p class="muted mb">${esc(def?.resume || '')} Seules les informations que l'INPI ne connaît pas encore sont demandées.</p>
          <form id="form-reponses">
            ${champs.map((c) => champHtml(c, f.reponses[c.name], {
    formes: etat.formes_juridiques, dirigeants: f.fiche?.dirigeants || [],
  })).join('')}
            <div class="dialog-actions">
              <button type="submit" class="btn-primary" ${terminal ? 'disabled' : ''}>Enregistrer et contrôler</button>
            </div>
          </form>
        </div>

        <div class="card mt">
          <h2>Pièces justificatives</h2>
          ${f.pieces_exigees.length ? `<table><tbody>${f.pieces_exigees.map((p) => {
    const jointe = f.pieces.find((x) => x.code === p.code);
    return `<tr>
              <td><span class="check-icon">${jointe ? '✓' : (p.obligatoire ? '○' : '·')}</span>
                ${esc(p.libelle)}${p.obligatoire ? ' <span class="requis">*</span>' : ''}
                ${p.aide ? `<div class="sub">${esc(p.aide)}</div>` : ''}
                ${jointe ? `<div class="sub"><a href="${API_ROOT}/formalites/pieces/${jointe.id}/download">${esc(jointe.filename)}</a></div>` : ''}
              </td>
              <td class="right">
                ${jointe
    ? `<button class="btn-sm btn-danger" data-suppr-piece="${jointe.id}" ${terminal ? 'disabled' : ''}>Retirer</button>`
    : `<button class="btn-sm" data-ajout-piece="${esc(p.code)}" data-libelle="${esc(p.libelle)}" ${terminal ? 'disabled' : ''}>Joindre</button>`}
              </td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">Aucune pièce requise</div>'}
          <input type="file" id="input-fichier" hidden accept=".pdf,.docx,.doc,.jpg,.jpeg,.png">
        </div>
      </div>

      <div>
        <div class="card">
          <h2>Contrôles avant dépôt</h2>
          ${controlesHtml(f.controles)}
          ${f.apercu.length ? `<h2 class="mt">Récapitulatif</h2>
            <dl class="recap">${f.apercu.map((a) => `<div><dt>${esc(a.label)}</dt><dd>${esc(valeurLisible(a.valeur))}</dd></div>`).join('')}</dl>` : ''}
          <div class="dialog-actions">
            ${depose
    ? `<button id="btn-sync-un">Actualiser le statut</button>`
    : `<button class="btn-gold" id="btn-deposer" ${f.controles.pret ? '' : 'disabled'}>Déposer au guichet unique</button>`}
          </div>
          ${!depose && !f.controles.pret ? '<p class="muted">Le dépôt se débloque dès que les points bloquants sont levés.</p>' : ''}
          ${depose ? `<p class="muted">Liasse ${esc(f.numero_liasse || '—')}${f.simule ? ' (simulation)' : ''} · statut INPI au ${fmtDate(f.statut_date)}.
            Le dossier reste modifiable pour préparer une réponse à régularisation, mais une modification n'est pas retransmise automatiquement à l'INPI.</p>` : ''}
        </div>

        <div class="card mt">
          <h2>Journal du dossier</h2>
          <ul class="journal">${f.evenements.map((e) => `
            <li><span class="quand">${fmtDate(e.created_at)}</span> ${esc(e.message)}</li>`).join('')}</ul>
        </div>

        <div class="card mt">
          <h2>JSON transmis à l'INPI</h2>
          <details><summary>Afficher le payload</summary>
            <pre class="json">${esc(JSON.stringify(f.payload, null, 2))}</pre>
          </details>
        </div>
      </div>
    </div>`;

  /* --- enregistrement du questionnaire --- */
  const form = document.getElementById('form-reponses');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', `/formalites/${id}/reponses`, { reponses: collecterReponses(form, champs) });
      toast('Réponses enregistrées.');
      render();
    } catch (err) { toast(err.message, true); }
  });
  // Un champ « pilote » (nature, modalité, affectation) réorganise le
  // questionnaire : on enregistre et on redessine immédiatement.
  form.querySelectorAll('select[data-pilote]').forEach((s) => s.addEventListener('change', () => {
    form.requestSubmit();
  }));

  /* --- pièces --- */
  const $fichier = document.getElementById('input-fichier');
  document.querySelectorAll('[data-ajout-piece]').forEach((b) => {
    b.onclick = () => {
      $fichier.dataset.code = b.dataset.ajoutPiece;
      $fichier.dataset.libelle = b.dataset.libelle;
      $fichier.click();
    };
  });
  $fichier.onchange = async () => {
    if (!$fichier.files[0]) return;
    const fd = new FormData();
    fd.append('fichier', $fichier.files[0]);
    fd.append('code', $fichier.dataset.code);
    fd.append('libelle', $fichier.dataset.libelle);
    try {
      await api('POST', `/formalites/${id}/pieces`, fd, true);
      toast('Pièce jointe.');
      render();
    } catch (e) { toast(e.message, true); }
  };
  document.querySelectorAll('[data-suppr-piece]').forEach((b) => {
    b.onclick = async () => {
      try { await api('DELETE', `/formalites/pieces/${b.dataset.supprPiece}`); render(); } catch (e) { toast(e.message, true); }
    };
  });

  /* --- dépôt / suivi --- */
  const $dep = document.getElementById('btn-deposer');
  if ($dep) {
    $dep.onclick = async () => {
      $dep.disabled = true;
      try {
        const r = await api('POST', `/formalites/${id}/deposer`);
        toast(r.simule ? `Dépôt simulé — liasse ${r.numero_liasse}.` : `Formalité déposée — liasse ${r.numero_liasse}.`);
        render();
      } catch (e) { toast(e.message, true); $dep.disabled = false; render(); }
    };
  }
  const $sync = document.getElementById('btn-sync-un');
  if ($sync) {
    $sync.onclick = async () => {
      $sync.disabled = true;
      try { await api('POST', `/formalites/${id}/synchroniser`); render(); } catch (e) { toast(e.message, true); $sync.disabled = false; }
    };
  }
}

/** Les dates ISO du récapitulatif sont affichées au format français. */
function valeurLisible(valeur) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valeur)) ? fmtDate(valeur) : valeur;
}

function controlesHtml(c) {
  if (!c) return '';
  const bloc = (titre, items, classe) => (items.length ? `<div class="alerte alerte-${classe}">
      <strong>${titre}</strong><ul>${items.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>` : '');
  const echeance = c.echeance ? `<div class="alerte alerte-${c.echeance.etat === 'depasse' ? 'bloquant' : (c.echeance.etat === 'imminent' ? 'alerte' : 'info')}">
      <strong>Délai légal</strong> — dépôt attendu au plus tard le ${fmtDate(c.echeance.limite)}
      (${c.echeance.jours_restants >= 0 ? `${c.echeance.jours_restants} jour(s) restants` : `dépassé de ${Math.abs(c.echeance.jours_restants)} jour(s)`}).
      <div class="sub">${esc(c.echeance.texte)}</div></div>` : '';
  return `${bloc(`${c.bloquants.length} point(s) bloquant(s)`, c.bloquants, 'bloquant')}
    ${bloc(`${c.alertes.length} point(s) de vigilance`, c.alertes, 'alerte')}
    ${echeance}
    ${bloc('Pour mémoire', c.infos, 'info')}
    ${c.pret ? '<div class="alerte alerte-ok"><strong>Dossier complet</strong> — prêt pour le dépôt.</div>' : ''}`;
}

/* ================================================================ routage */

routes.push(
  { re: /^\/formalites$/, view: formalitesDashboard, nav: 'formalites' },
  { re: /^\/formalites\/new$/, view: formaliteNew, nav: 'formalites' },
  { re: /^\/formalites\/(\d+)$/, view: formaliteDetail, nav: 'formalites' },
);
