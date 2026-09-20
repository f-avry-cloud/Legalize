'use strict';

/* ================================================================
   Module « Formalités INPI » — trois écrans :
     #/formalites       suivi : qui doit jouer, et sur quoi
     #/formalites/new   ouverture : un SIREN + une formalité
     #/formalites/:id   questionnaire, pièces, contrôles, dépôt, cycle INPI
   Le formulaire est engendré à partir du catalogue servi par l'API, et les
   libellés de statut viennent du serveur (référentiels officiels INPI).
   ================================================================ */

const COULEUR_BADGE = { gris: 'brouillon', bleu: 'genere', orange: 'envoye', rouge: 'a_faire', vert: 'finalise' };

// Ce que l'application peut faire pour chaque action attendue par le guichet.
const ACTIONS = {
  deposer: { libelle: 'Déposer au guichet unique', classe: 'btn-gold' },
  signer: { libelle: 'Signer le dépôt', classe: 'btn-gold' },
  payer: { libelle: 'Régler les taxes', classe: 'btn-gold' },
  regulariser: { libelle: 'Répondre à la régularisation', classe: 'btn-primary' },
  attendre: { libelle: null, classe: '' },
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

function badgeStatut(f) {
  const classe = COULEUR_BADGE[f.statut_couleur] || 'brouillon';
  return `<span class="badge ${classe}">${esc(f.statut_libelle || f.statut)}</span>`;
}

function bandeauMode(etat) {
  if (etat.guichet.mode === 'reel' && etat.guichet.depotReelAutorise) {
    return `<div class="alerte alerte-ok"><strong>Dépôt réel actif</strong> — compte ${esc(etat.guichet.compte || '')}
      sur l'environnement ${esc(etat.guichet.environnement)}. Les formalités déposées partent à l'INPI.</div>`;
  }
  const raison = etat.guichet.mode === 'simulation'
    ? 'Aucun identifiant guichet unique configuré'
    : 'Dépôt réel désactivé (INPI_DEPOT_REEL)';
  return `<div class="alerte alerte-info">
    <strong>Mode simulation.</strong> ${esc(raison)} : le parcours complet est disponible
    (pré-remplissage ${etat.rne.mode === 'simulation' ? 'simulé' : 'RNE réel'}, contrôles, JSON INPI, dépôt,
    signature, paiement, suivi), mais rien n'est transmis à l'INPI.</div>`;
}

/* ================================================================ suivi */

async function formalitesDashboard() {
  const [d, etat] = await Promise.all([api('GET', '/formalites/dashboard'), getEtatInpi()]);
  const c = d.compteurs;
  $main.innerHTML = `
    <div class="page-head"><h1>Formalités</h1>
      <div>
        <button id="btn-test-inpi">Tester la connexion INPI</button>
        <button id="btn-sync">Synchroniser avec l'INPI</button>
        <a class="btn btn-primary" href="#/formalites/new">Nouvelle formalité</a>
      </div>
    </div>
    ${bandeauMode(etat)}
    <div class="grid cols-4">
      <div class="card"><div class="stat" style="color:${c.a_traiter ? 'var(--gold)' : 'var(--ok)'}">${c.a_traiter}</div><div class="stat-label">En attente de nous</div></div>
      <div class="card"><div class="stat">${c.a_signer}</div><div class="stat-label">À signer</div></div>
      <div class="card"><div class="stat">${c.a_payer}</div><div class="stat-label">À payer</div></div>
      <div class="card"><div class="stat" style="color:${c.regularisations || c.en_retard ? 'var(--danger)' : 'var(--ok)'}">${c.regularisations + c.en_retard}</div><div class="stat-label">Régularisations & retards</div></div>
    </div>
    <div class="grid cols-2 mt">
      <div class="card">
        <h2>À traiter — l'INPI attend une action de notre côté</h2>
        ${listeFormalites(d.a_traiter, 'Rien en attente de notre côté')}
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

  document.getElementById('btn-test-inpi').onclick = async (e) => {
    e.target.disabled = true;
    try {
      testConnexionDialog(await api('POST', '/inpi/test-connexion', {}));
    } catch (err) { toast(err.message, true); } finally { e.target.disabled = false; }
  };

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
    <thead><tr><th>Dossier</th><th>Société</th><th>Statut</th><th>Action</th><th>Échéance</th></tr></thead>
    <tbody>${liste.map((f) => `
      <tr class="clickable" onclick="location.hash='#/formalites/${f.id}'">
        <td><strong>${esc(f.type_libelle)}</strong>
          <div class="sub">${esc(f.reference || '')}${f.numero_liasse ? ` · liasse ${esc(f.numero_liasse)}` : ''}${f.simule ? ' · simulation' : ''}</div></td>
        <td>${esc(f.societe_nom || '—')}</td>
        <td>${badgeStatut(f)}${f.nb_regularisations ? ' <span class="badge a_faire">à régulariser</span>' : ''}</td>
        <td>${f.action_attendue && f.action_attendue !== 'attendre'
    ? `<span class="badge envoye">${esc(ACTIONS[f.action_attendue]?.libelle || f.action_attendue)}</span>`
    : '<span class="muted">côté INPI</span>'}</td>
        <td>${echeanceHtml(f)}</td>
      </tr>`).join('')}</tbody></table>`;
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
              <em class="code-inpi">${f.evenement ? `évènement ${esc(f.evenement)} — ${esc(f.evenement_libelle || '')}` : 'service comptes annuels'}</em>
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
      <div><dt>Dirigeant</dt><dd>${esc(d?.nom_complet || '—')}${d?.role_libelle ? ` <span class="muted">(${esc(d.role_libelle)})</span>` : ''}</dd></div>
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
          ? (contexte.dirigeants || []).map((d) => ({
            value: d.nom_complet, label: `${d.nom_complet}${d.role_libelle ? ` — ${d.role_libelle}` : ''}`,
          }))
          : (champ.options || []);
      const courant = valeur === undefined || valeur === null || valeur === '' ? champ.default : valeur;
      return `<label class="field">${label}
        <select name="${champ.name}" id="${id}" data-pilote="1">
          <option value="">—</option>
          ${options.map((o) => `<option value="${esc(o.value)}" ${String(courant) === String(o.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>${aide}</label>`;
    }
    case 'adresse': {
      const a = valeur || {};
      const types = contexte.typesVoie || {};
      return `<fieldset class="list-field"><legend>${label}</legend>
        <div class="row">
          <label class="field">N°<input name="${champ.name}.numVoie" value="${esc(a.numVoie || '')}"></label>
          <label class="field">Type de voie
            <select name="${champ.name}.typeVoie">
              <option value="">—</option>
              ${Object.entries(types).map(([code, lib]) => `<option value="${esc(code)}" ${a.typeVoie === code ? 'selected' : ''}>${esc(lib)}</option>`).join('')}
            </select>
            <em class="aide">Codes officiels du référentiel INPI.</em>
          </label>
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
  const terminal = ['VALIDATED', 'REJECTED'].includes(f.statut);
  const depose = Boolean(f.inpi_id);

  $main.innerHTML = `
    <div class="page-head">
      <div>
        <div class="crumb"><a href="#/formalites">Formalités</a> › ${esc(f.reference || '')}</div>
        <h1>${esc(def?.libelle || f.type)}</h1>
        <div class="muted">${esc(f.societe_nom || '')} ${f.siren ? `· ${esc(f.fiche?.siren_formate || f.siren)}` : ''}
          ${def?.evenement ? `· évènement ${esc(def.evenement)}` : ''}</div>
      </div>
      <div>${badgeStatut(f)}${f.simule ? ' <span class="badge brouillon">simulation</span>' : ''}</div>
    </div>

    ${f.regularisations?.length ? `<div class="alerte alerte-bloquant">
      <strong>Régularisation demandée par l'INPI.</strong>
      <ul>${f.regularisations.map((r) => `<li>${esc(r.motif)}
        ${r.piece ? ` <span class="muted">(pièce : ${esc(r.piece)})</span>` : ''}
        ${r.echeance ? ` — à traiter avant le ${fmtDate(r.echeance)}` : ''}</li>`).join('')}</ul>
      <div class="sub">Corriger le dossier ci-dessous, puis redéposer : la formalité repart en signature.</div>
    </div>` : ''}

    <div class="grid cols-2">
      <div>
        <div class="card">
          <h2>Ce qui change</h2>
          <p class="muted mb">${esc(def?.resume || '')} Seules les informations que l'INPI ne connaît pas encore sont demandées.</p>
          <form id="form-reponses">
            ${champs.map((c) => champHtml(c, f.reponses[c.name], {
    formes: etat.formes_juridiques, typesVoie: etat.types_voie, dirigeants: f.fiche?.dirigeants || [],
  })).join('')}
            <div class="dialog-actions">
              <button type="submit" class="btn-primary" ${terminal ? 'disabled' : ''}>Enregistrer et contrôler</button>
            </div>
          </form>
        </div>

        <div class="card mt">
          <h2>Pièces justificatives</h2>
          <p class="muted mb">Codes officiels du guichet unique. Format PDF uniquement, 10 Mo maximum par pièce.</p>
          ${f.pieces_exigees.length ? `<table><tbody>${f.pieces_exigees.map((p) => {
    const jointe = f.pieces.find((x) => x.code === p.code);
    return `<tr>
              <td><span class="check-icon">${jointe ? '✓' : (p.obligatoire ? '○' : '·')}</span>
                <span class="code-pj">${esc(p.code)}</span> ${esc(p.libelle)}${p.obligatoire ? ' <span class="requis">*</span>' : ''}
                ${p.aide ? `<div class="sub">${esc(p.aide)}</div>` : ''}
                ${p.nota ? `<div class="sub">${esc(p.nota)}</div>` : ''}
                ${jointe ? `<div class="sub"><a href="${API_ROOT}/formalites/pieces/${jointe.id}/download">${esc(jointe.filename)}</a></div>` : ''}
              </td>
              <td class="right">
                ${jointe
    ? `<button class="btn-sm btn-danger" data-suppr-piece="${jointe.id}" ${terminal ? 'disabled' : ''}>Retirer</button>`
    : `<button class="btn-sm" data-ajout-piece="${esc(p.code)}" data-libelle="${esc(p.libelle)}" ${terminal ? 'disabled' : ''}>Joindre</button>`}
              </td></tr>`;
  }).join('')}</tbody></table>` : '<div class="empty">Aucune pièce requise</div>'}
          <input type="file" id="input-fichier" hidden accept="application/pdf,.pdf">
        </div>
      </div>

      <div>
        <div class="card">
          <h2>${depose ? 'Où en est le dossier' : 'Contrôles avant dépôt'}</h2>
          ${depose ? cycleHtml(f, def) : controlesHtml(f.controles)}
          ${!depose && f.apercu.length ? `<h2 class="mt">Récapitulatif</h2>
            <dl class="recap">${f.apercu.map((a) => `<div><dt>${esc(a.label)}</dt><dd>${esc(valeurLisible(a.valeur))}</dd></div>`).join('')}</dl>` : ''}
          <div class="dialog-actions">${actionHtml(f)}</div>
          ${!depose && !f.controles.pret ? '<p class="muted">Le dépôt se débloque dès que les points bloquants sont levés.</p>' : ''}
        </div>

        ${depose ? `<div class="card mt"><h2>Contrôles du dossier</h2>${controlesHtml(f.controles)}</div>` : ''}

        <div class="card mt">
          <h2>Journal du dossier</h2>
          <ul class="journal">${f.evenements.map((e) => `
            <li><span class="quand">${fmtDate(e.created_at)}</span> ${esc(e.message)}</li>`).join('')}</ul>
        </div>

        <div class="card mt">
          <h2>JSON transmis à l'INPI</h2>
          <p class="muted">Endpoint : <code>${esc(f.payload_endpoint || '—')}</code></p>
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
  // Un champ « pilote » (nature, sens, affectation) réorganise le
  // questionnaire : on enregistre et on redessine immédiatement.
  form.querySelectorAll('select[data-pilote]').forEach((s) => s.addEventListener('change', () => form.requestSubmit()));

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

  /* --- actions du cycle INPI --- */
  const $action = document.getElementById('btn-action');
  if ($action) {
    $action.onclick = async () => {
      const action = $action.dataset.action;
      $action.disabled = true;
      try {
        if (action === 'deposer') {
          const r = await api('POST', `/formalites/${id}/deposer`);
          toast(r.simule ? `Dépôt simulé — liasse ${r.numero_liasse}.` : `Formalité déposée — liasse ${r.numero_liasse}.`);
        } else if (action === 'signer') {
          await api('POST', `/formalites/${id}/signer`, {});
          toast('Dépôt signé.');
        } else if (action === 'payer') {
          await api('POST', `/formalites/${id}/payer`, {});
          toast('Taxes réglées.');
        }
        render();
      } catch (e) { toast(e.message, true); $action.disabled = false; render(); }
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

/** Bouton correspondant à l'action que le guichet unique attend de nous. */
function actionHtml(f) {
  const depose = Boolean(f.inpi_id);
  const action = f.action_attendue;
  const boutons = [];
  if (action && action !== 'attendre' && ACTIONS[action]?.libelle && action !== 'regulariser') {
    boutons.push(`<button class="${ACTIONS[action].classe}" id="btn-action" data-action="${action}"
      ${action === 'deposer' && !f.controles.pret ? 'disabled' : ''}>${esc(ACTIONS[action].libelle)}</button>`);
  }
  if (depose) boutons.push('<button id="btn-sync-un">Actualiser le statut</button>');
  return boutons.join(' ');
}

/** Avancement du dossier dans le cycle du guichet unique. */
function cycleHtml(f, def) {
  const etapes = [
    { cle: 'depot', libelle: 'Dépôt', fait: Boolean(f.inpi_id), date: f.created_at },
    { cle: 'signature', libelle: 'Signature', fait: Boolean(f.signature_date), date: f.signature_date },
    { cle: 'paiement', libelle: 'Paiement', fait: Boolean(f.paiement_date), date: f.paiement_date },
    { cle: 'validation', libelle: 'Validation', fait: f.statut === 'VALIDATED', date: f.statut === 'VALIDATED' ? f.statut_date : null },
  ];
  const attente = f.action_attendue && f.action_attendue !== 'attendre'
    ? `<div class="alerte alerte-alerte"><strong>Action attendue de notre côté :</strong> ${esc(ACTIONS[f.action_attendue]?.libelle || f.action_attendue)}.
       ${f.action_attendue === 'signer' && def?.signature === 'avancee'
    ? `<div class="sub">Signature électronique avancée requise : <a href="${API_ROOT}/formalites/${f.id}/synthese" target="_blank">télécharger le document de synthèse</a>,
       le signer avec un certificat qualifié, puis le redéposer en PJ_115.</div>` : ''}
       ${f.action_attendue === 'payer' && f.montant ? `<div class="sub">Montant des taxes : ${eur.format(f.montant)}.</div>` : ''}
       </div>`
    : `<div class="alerte alerte-info"><strong>En attente côté INPI.</strong> ${esc(f.statut_libelle)}.</div>`;

  return `${attente}
    <ol class="cycle">${etapes.map((e) => `
      <li class="${e.fait ? 'fait' : ''}"><span class="puce">${e.fait ? '✓' : '·'}</span>
        ${esc(e.libelle)}${e.date ? `<span class="quand">${fmtDate(e.date)}</span>` : ''}</li>`).join('')}
    </ol>
    <dl class="recap mt">
      <div><dt>Liasse</dt><dd>${esc(f.numero_liasse || '—')}</dd></div>
      <div><dt>Statut INPI</dt><dd>${esc(f.statut_inpi || f.statut)}</dd></div>
      <div><dt>Taxes</dt><dd>${f.montant != null ? eur.format(f.montant) : '—'}</dd></div>
      <div><dt>N° national</dt><dd>${esc(f.num_nat || '—')}</dd></div>
    </dl>`;
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

/* ================================================ diagnostic des accès INPI */

/**
 * Restitue le diagnostic : pour chaque API, la connexion (identifiant et mot
 * de passe → jeton de session) puis une lecture réelle. Aucun dépôt n'est
 * effectué.
 */
function testConnexionDialog(d) {
  const etape = (titre, r) => {
    if (!r) return '';
    return `<li class="${r.ok ? 'ok' : 'ko'}"><span class="puce">${r.ok ? '✓' : '✗'}</span>
      <span><strong>${esc(titre)}</strong> ${esc(r.message)}
      ${r.cause ? `<em>${esc(r.cause)}</em>` : ''}</span></li>`;
  };
  const bloc = (a) => `<div class="diag">
      <h4>${esc(a.libelle)}</h4>
      <div class="sub">${esc(a.hote)}${a.compte ? ` · compte ${esc(a.compte)}` : ''}</div>
      <ul class="diag-etapes">${etape('Connexion —', a.connexion)}${etape('Lecture —', a.lecture)}</ul>
    </div>`;

  openDialog(`<h3>Connexion aux API de l'INPI</h3>
    <p class="muted mb">Mode RNE : ${esc(d.etat.rne.mode)} · guichet unique : ${esc(d.etat.guichet.mode)}
      (environnement ${esc(d.etat.guichet.environnement)}) ·
      dépôt réel ${d.etat.guichet.depotReelAutorise ? 'autorisé' : 'désactivé'}.</p>
    ${bloc(d.rne)}
    ${bloc(d.guichet)}
    <div class="alerte alerte-${d.ok ? 'ok' : 'alerte'}">
      ${d.ok
    ? '<strong>Les deux accès fonctionnent.</strong> Aucune formalité n’a été déposée : le test est en lecture seule.'
    : '<strong>Au moins un accès est en échec.</strong> Les identifiants se règlent par variables d’environnement (INPI_RNE_* et INPI_GU_*), et un redéploiement est nécessaire pour les prendre en compte.'}
    </div>
    <div class="dialog-actions"><button type="button" data-fermer>Fermer</button></div>`,
  null,
  (dlg) => { dlg.querySelector('[data-fermer]').onclick = () => dlg.close(); });
}

/* ================================================================ routage */

routes.push(
  { re: /^\/formalites$/, view: formalitesDashboard, nav: 'formalites' },
  { re: /^\/formalites\/new$/, view: formaliteNew, nav: 'formalites' },
  { re: /^\/formalites\/(\d+)$/, view: formaliteDetail, nav: 'formalites' },
);
