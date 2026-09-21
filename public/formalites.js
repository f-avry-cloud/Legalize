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

/**
 * Colonnes du pipeline : les statuts du guichet unique regroupés par « qui
 * doit jouer ». La colonne où se trouve un dossier dit tout de suite ce qu'il
 * attend.
 */
const COLONNES = [
  { titre: 'Brouillons', classe: '', statuts: ['BROUILLON'] },
  { titre: 'Déposées', classe: '', statuts: ['RECEIVED', 'SIGNED', 'PAID', 'PAYMENT_VALIDATION_PENDING', 'VALIDATION_PENDING', 'AMENDED'] },
  { titre: 'À signer', classe: 'c-action', statuts: ['SIGNATURE_PENDING', 'AMENDMENT_SIGNATURE_PENDING'] },
  { titre: 'À payer', classe: 'c-action', statuts: ['PAYMENT_PENDING', 'AMENDMENT_PAYMENT_PENDING'] },
  { titre: 'À régulariser', classe: 'c-alerte', statuts: ['AMENDMENT_PENDING', 'EXPIRED', 'ERROR'] },
  { titre: 'Terminées', classe: 'c-ok', statuts: ['VALIDATED', 'REJECTED'] },
];

async function formalitesDashboard() {
  const [d, etat, dossiers] = await Promise.all([
    api('GET', '/formalites/dashboard'),
    getEtatInpi(),
    api('GET', '/formalites'),
  ]);
  const c = d.compteurs;
  $main.innerHTML = `
    <div class="page-head"><h1>Formalités</h1>
      <div>
        <button id="btn-test-inpi">Tester la connexion INPI</button>
        <button id="btn-importer">Importer depuis l'INPI</button>
        <button id="btn-sync">Synchroniser</button>
        <a class="btn btn-primary" href="#/formalites/new">Nouvelle formalité</a>
      </div>
    </div>
    ${bandeauMode(etat)}
    <div class="grid cols-4">
      <div class="card"><div class="stat" style="color:${c.a_traiter ? 'var(--warn)' : 'var(--ok)'}">${c.a_traiter}</div><div class="stat-label">En attente de nous</div></div>
      <div class="card"><div class="stat">${c.a_signer}</div><div class="stat-label">À signer</div></div>
      <div class="card"><div class="stat">${c.a_payer}</div><div class="stat-label">À payer</div></div>
      <div class="card"><div class="stat" style="color:${c.regularisations + c.en_retard ? 'var(--danger)' : 'var(--ok)'}">${c.regularisations + c.en_retard}</div><div class="stat-label">Régularisations & retards</div></div>
    </div>

    <div class="card mt">
      <div class="entete-vue">
        <h2>Dossiers — ${dossiers.length}</h2>
        <div class="segments" role="tablist">
          <button role="tab" data-vue="pipeline">Pipeline</button>
          <button role="tab" data-vue="liste">Liste &amp; recherche</button>
        </div>
      </div>
      <div id="vue-pipeline">${pipelineHtml(dossiers)}</div>
      <div id="vue-liste" hidden>${listeHtml(dossiers)}</div>
    </div>

    <div class="card mt">
      <h2>Prochaines échéances légales</h2>
      ${d.echeances.length ? `<table><tbody>${d.echeances.map((f) => `
        <tr class="clickable" onclick="location.hash='#/formalites/${f.id}'">
          <td><strong>${esc(f.type_libelle)}</strong><div class="sub">${esc(f.societe_nom)}</div></td>
          <td>${badgeStatut(f)}</td>
          <td class="right">${echeanceHtml(f)}</td>
        </tr>`).join('')}</tbody></table>`
    : '<div class="empty">Aucune échéance en cours</div>'}
    </div>`;

  document.getElementById('btn-test-inpi').onclick = async (e) => {
    e.target.disabled = true;
    try {
      testConnexionDialog(await api('POST', '/inpi/test-connexion', {}));
    } catch (err) { toast(err.message, true); } finally { e.target.disabled = false; }
  };

  brancherVues(dossiers);

  document.getElementById('btn-importer').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Import en cours…';
    try {
      const r = await api('POST', '/formalites/importer');
      const detail = [`${r.importees} importée(s)`, `${r.actualisees} actualisée(s)`, `${r.inchangees} déjà à jour`];
      if (r.ignorees) detail.push(`${r.ignorees} ligne(s) illisible(s)`);
      toast(r.erreurs?.length
        ? `${detail.join(', ')}. ${r.erreurs.join(' ; ')}`
        : `${detail.join(', ')}.`,
      Boolean(r.erreurs?.length));
      render();
      majPastilleFormalites();
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
      e.target.textContent = "Importer depuis l'INPI";
    }
  };

  document.getElementById('btn-sync').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const r = await api('POST', '/formalites/synchroniser');
      toast(`${r.synchronisees} dossier(s) interrogé(s), ${r.changements} changement(s) de statut.`);
      render();
      majPastilleFormalites();
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

function echeanceHtml(f) {
  if (!f.echeance) return '<span class="muted">—</span>';
  return f.en_retard
    ? `<span class="badge a_faire">dépassée le ${fmtDate(f.echeance)}</span>`
    : `<span class="muted">${fmtDate(f.echeance)}</span>`;
}

/** Le pipeline : une colonne par étape, une carte par dossier. */
function pipelineHtml(dossiers) {
  if (!dossiers.length) return '<div class="empty">Aucun dossier. Ouvrez la première formalité.</div>';
  let rang = 0;
  return `<div class="pipeline">${COLONNES.map((col) => {
    const lot = dossiers.filter((f) => col.statuts.includes(f.statut));
    return `<section class="colonne ${col.classe}">
      <header><span class="pt"></span>${esc(col.titre)}<em>${lot.length}</em></header>
      <div class="cartes">
        ${lot.length
    ? lot.map((f) => { rang += 1; return carteDossierHtml(f, rang); }).join('')
    : '<div class="vide">—</div>'}
      </div>
    </section>`;
  }).join('')}</div>`;
}

/**
 * Vue liste : le pipeline montre le travail en cours, la liste sert d'archive.
 * Un dossier validé il y a deux ans n'a pas sa place dans une colonne — il se
 * retrouve par recherche.
 */
function listeHtml(dossiers) {
  return `<div class="filtres">
      <label class="field recherche">
        <input id="q-dossiers" type="search" placeholder="Rechercher : société, type, référence, liasse, SIREN…" autocomplete="off">
      </label>
      <label class="field">
        <select id="f-statut">
          <option value="">Tous les statuts</option>
          <option value="__encours">En cours seulement</option>
          <option value="VALIDATED">Validées</option>
          <option value="REJECTED">Rejetées</option>
          <option value="BROUILLON">Brouillons</option>
          <option value="AMENDMENT_PENDING">À régulariser</option>
        </select>
      </label>
    </div>
    <div id="resultats-liste">${lignesListeHtml(dossiers)}</div>`;
}

function lignesListeHtml(dossiers) {
  if (!dossiers.length) return '<div class="empty">Aucun dossier ne correspond</div>';
  return `<table>
    <thead><tr><th>Dossier</th><th>Société</th><th>Statut</th><th>Liasse</th><th>Échéance</th></tr></thead>
    <tbody>${dossiers.map((f) => `
      <tr class="clickable" onclick="location.hash='#/formalites/${f.id}'">
        <td><strong>${esc(f.type_libelle)}</strong>
          <div class="sub">${esc(f.reference || '')}${f.importe ? ' · importée' : ''}${f.simule ? ' · simulation' : ''}</div></td>
        <td>${esc(f.societe_nom || '—')}</td>
        <td>${badgeStatut(f)}</td>
        <td class="nowrap"><span class="ref">${esc(f.numero_liasse || '—')}</span></td>
        <td>${echeanceHtml(f)}</td>
      </tr>`).join('')}</tbody></table>`;
}

/** Bascule pipeline / liste, et filtrage de la liste. */
function brancherVues(dossiers) {
  const $pipeline = document.getElementById('vue-pipeline');
  const $liste = document.getElementById('vue-liste');
  const onglets = document.querySelectorAll('.segments [data-vue]');

  const activer = (vue) => {
    $pipeline.hidden = vue !== 'pipeline';
    $liste.hidden = vue !== 'liste';
    onglets.forEach((o) => o.classList.toggle('actif', o.dataset.vue === vue));
    try { localStorage.setItem('legalize-vue-formalites', vue); } catch (e) { /* stockage indisponible */ }
  };
  onglets.forEach((o) => { o.onclick = () => activer(o.dataset.vue); });
  let choix = 'pipeline';
  try { choix = localStorage.getItem('legalize-vue-formalites') || 'pipeline'; } catch (e) { /* idem */ }
  activer(choix);

  const $q = document.getElementById('q-dossiers');
  const $statut = document.getElementById('f-statut');
  const TERMINES = ['VALIDATED', 'REJECTED'];
  const filtrer = () => {
    const terme = ($q.value || '').trim().toLowerCase();
    const statut = $statut.value;
    const lot = dossiers.filter((f) => {
      if (statut === '__encours' && TERMINES.includes(f.statut)) return false;
      if (statut && statut !== '__encours' && f.statut !== statut) return false;
      if (!terme) return true;
      return [f.type_libelle, f.societe_nom, f.reference, f.numero_liasse, f.siren, f.libelle]
        .some((v) => String(v || '').toLowerCase().includes(terme));
    });
    document.getElementById('resultats-liste').innerHTML = lignesListeHtml(lot);
  };
  $q.addEventListener('input', filtrer);
  $statut.addEventListener('change', filtrer);
}

function carteDossierHtml(f, rang) {
  return `<article class="carte-dossier ${f.en_retard ? 'retard' : ''}"
      style="animation-delay:${Math.min(rang * 40, 500)}ms"
      onclick="location.hash='#/formalites/${f.id}'">
    <h4>${esc(f.type_libelle)}</h4>
    <div class="societe">${esc(f.societe_nom || '—')}</div>
    <div class="pied">
      <span class="ref">${esc(f.reference || '')}</span>
      ${f.nb_regularisations ? '<span class="badge a_faire">à régulariser</span>' : ''}
      ${f.echeance ? `<span class="${f.en_retard ? 'echeance-retard' : ''}">${f.en_retard ? 'dépassée' : 'avant'} ${fmtDate(f.echeance)}</span>` : ''}
      ${f.simule ? '<span class="badge brouillon">simulation</span>' : ''}
      ${f.importe ? '<span class="badge non_applicable">importée</span>' : ''}
    </div>
  </article>`;
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

/** Un champ de liste porte un nom indexé : `associes[0].nom`. */
function champIndexe(sous, nomListe, rang) {
  return { ...sous, name: `${nomListe}[${rang}].${sous.name}` };
}

function ligneListeHtml(champ, valeur, rang, contexte) {
  const v = valeur || {};
  return `<div class="ligne-liste" data-rang="${rang}">
    <div class="ligne-liste-corps">
      ${champ.champs.map((sous) => champHtml(champIndexe(sous, champ.name, rang), v[sous.name], contexte)).join('')}
    </div>
    <button type="button" class="btn-ghost retirer-ligne" title="Retirer">Retirer</button>
  </div>`;
}

/** Vrai si la valeur saisie ne compte pas comme renseignée. */
function champVide(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return true;
  if (Array.isArray(valeur)) return valeur.length === 0;
  if (typeof valeur === 'object') return Object.values(valeur).every(champVide);
  return false;
}

/**
 * Enveloppe chaque champ : c'est elle qui porte le caractère obligatoire,
 * l'état rempli et l'ancre vers laquelle un contrôle peut renvoyer.
 */
function champHtml(champ, valeur, contexte) {
  const corps = champCorps(champ, valeur, contexte);
  if (champ.type === 'section') {
    return `<div class="champ-bloc bloc-section" data-section="${esc(champ.name)}">${corps}</div>`;
  }
  const classes = ['champ-bloc'];
  if (champ.required) classes.push('champ-requis');
  if (champ.required && !champVide(valeur)) classes.push('rempli');
  return `<div class="${classes.join(' ')}" data-champ="${esc(champ.name)}">${corps}</div>`;
}

function champCorps(champ, valeur, contexte) {
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
    case 'section':
      return `<h3 class="section-form">${label}</h3>${champ.aide ? `<p class="muted mb">${esc(champ.aide)}</p>` : ''}`;
    case 'liste': {
      const lignes = Array.isArray(valeur) && valeur.length ? valeur : [{}];
      return `<fieldset class="list-field liste-repetable" data-liste="${champ.name}"><legend>${label}</legend>
        <div class="lignes-liste">${lignes.map((v, i) => ligneListeHtml(champ, v, i, contexte)).join('')}</div>
        <button type="button" class="btn-ghost ajouter-ligne">+ Ajouter</button>${aide}</fieldset>`;
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

/** Pose une valeur sur un chemin pointé : poser(o, 'adresse.voie', 'x'). */
function poser(objet, chemin, valeur) {
  const parts = chemin.split('.');
  let courant = objet;
  while (parts.length > 1) {
    const cle = parts.shift();
    courant[cle] = courant[cle] || {};
    courant = courant[cle];
  }
  courant[parts[0]] = valeur;
}

/**
 * Reconstitue un tableau depuis les champs indexés `nom[rang].chemin`.
 * Les lignes entièrement vides sont écartées : une liste répétable affiche
 * toujours une ligne, même quand l'utilisateur n'a rien à y mettre.
 */
function collecterListe(form, champ) {
  const parRang = new Map();
  const motif = new RegExp(`^${champ.name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\[(\\d+)\\]\\.(.+)$`);
  form.querySelectorAll(`[name^="${champ.name}["]`).forEach((input) => {
    const m = input.name.match(motif);
    if (!m) return;
    const [, rang, chemin] = m;
    if (!parRang.has(rang)) parRang.set(rang, {});
    poser(parRang.get(rang), chemin, input.type === 'checkbox' ? input.checked : input.value);
  });
  const vide = (o) => Object.values(o).every((v) => (
    v === '' || v === false || v === null || v === undefined
      || (typeof v === 'object' && vide(v))));
  return [...parRang.values()].filter((ligne) => !vide(ligne));
}

/** Reconstitue l'objet de réponses depuis le formulaire (clés pointées). */
function collecterReponses(form, champs) {
  const r = {};
  for (const champ of champs) {
    if (champ.type === 'section') continue;
    if (champ.type === 'liste') {
      r[champ.name] = collecterListe(form, champ);
      continue;
    }
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
  if (f.importe) return detailImporte(f, etat);
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
          <div class="barre-progression" id="progression-form">
            <div class="jauge"><span id="jauge-remplie"></span></div>
            <span class="compteur" id="compteur-requis"></span>
            <label class="bascule-requis">
              <input type="checkbox" id="filtre-requis"> Obligatoires seulement
            </label>
          </div>
          <nav class="sommaire-sections" id="sommaire-sections"></nav>
          <form id="form-reponses">
            ${champs.map((c) => champHtml(c, f.reponses[c.name], {
    formes: etat.formes_juridiques, typesVoie: etat.types_voie, dirigeants: f.fiche?.dirigeants || [],
  })).join('')}
            <div class="dialog-actions">
              <button type="submit" class="btn-primary" ${terminal ? 'disabled' : ''}>Enregistrer et contrôler</button>
            </div>
          </form>
        </div>

        <div class="card mt" id="bloc-pieces">
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
          ${depose ? cycleHtml(f, def, etat) : controlesHtml(f.controles)}
          ${!depose && f.apercu.length ? `<h2 class="mt">Récapitulatif</h2>
            <dl class="recap">${f.apercu.map((a) => `<div><dt>${esc(a.label)}</dt><dd>${esc(valeurLisible(a.valeur))}</dd></div>`).join('')}</dl>` : ''}
          <div class="dialog-actions">${actionHtml(f, def)}</div>
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

  brancherProgression(form);

  // « Corriger » depuis un contrôle : on ouvre le filtre si l'encart visé est
  // masqué, sinon le clic n'aurait aucun effet visible.
  document.querySelectorAll('.lien-controle').forEach((lien) => {
    lien.onclick = () => {
      const cible = lien.dataset.cible;
      if (cible === '_pieces') {
        allerA(document.getElementById('bloc-pieces') || document.querySelector('[data-ajout-piece]')?.closest('.card'));
        return;
      }
      const bloc = form.querySelector(`.champ-bloc[data-champ="${cible}"]`);
      if (!bloc) return;
      if (bloc.offsetParent === null) {
        const filtre = document.getElementById('filtre-requis');
        if (filtre?.checked) { filtre.checked = false; filtre.dispatchEvent(new Event('change')); }
      }
      allerA(bloc);
    };
  });

  // Listes répétables : on clone la première ligne plutôt que de redessiner
  // tout le questionnaire, pour ne pas perdre la saisie en cours.
  form.addEventListener('click', (e) => {
    const ajout = e.target.closest('.ajouter-ligne');
    if (ajout) {
      const bloc = ajout.closest('.liste-repetable');
      const lignes = bloc.querySelector('.lignes-liste');
      const modele = lignes.firstElementChild;
      if (!modele) return;
      const rang = lignes.children.length;
      const copie = modele.cloneNode(true);
      copie.dataset.rang = String(rang);
      copie.querySelectorAll('[name]').forEach((champ) => {
        champ.name = champ.name.replace(/\[\d+\]/, `[${rang}]`);
        if (champ.id) champ.id = `${champ.id}-${rang}`;
        if (champ.type === 'checkbox') champ.checked = false;
        else if (champ.tagName === 'SELECT') champ.selectedIndex = 0;
        else champ.value = '';
      });
      lignes.appendChild(copie);
      return;
    }
    const retrait = e.target.closest('.retirer-ligne');
    if (retrait) {
      const lignes = retrait.closest('.lignes-liste');
      if (lignes.children.length > 1) retrait.closest('.ligne-liste').remove();
      else lignes.querySelectorAll('[name]').forEach((c) => {
        if (c.type === 'checkbox') c.checked = false; else c.value = '';
      });
    }
  });

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
        majPastilleFormalites();
      } catch (e) { toast(e.message, true); $action.disabled = false; render(); }
    };
  }
  for (const cle of ['btn-sync-un', 'btn-signe-fait']) {
    const $b = document.getElementById(cle);
    if (!$b) continue;
    $b.onclick = async () => {
      $b.disabled = true;
      try {
        const r = await api('POST', `/formalites/${id}/synchroniser`);
        if (cle === 'btn-signe-fait' && r.statut === 'SIGNATURE_PENDING') {
          toast('Le guichet unique attend toujours la signature.', true);
        }
        render();
      } catch (e) { toast(e.message, true); $b.disabled = false; }
    };
  }

  /* --- signature : copie de la liasse et dépôt du document signé --- */
  const $copier = document.getElementById('btn-copier-liasse');
  if ($copier) {
    $copier.onclick = async () => {
      const valeur = document.getElementById('liasse-valeur').textContent.trim();
      try {
        await navigator.clipboard.writeText(valeur);
        $copier.textContent = 'Copié';
        setTimeout(() => { $copier.textContent = 'Copier'; }, 1800);
      } catch (e) { toast('Copie impossible : sélectionnez le numéro manuellement.', true); }
    };
  }

  const $docSigne = document.getElementById('input-doc-signe');
  const $btnDocSigne = document.getElementById('btn-doc-signe');
  if ($btnDocSigne && $docSigne) {
    $btnDocSigne.onclick = () => $docSigne.click();
    $docSigne.onchange = async () => {
      if (!$docSigne.files[0]) return;
      $btnDocSigne.disabled = true;
      $btnDocSigne.textContent = 'Dépôt en cours…';
      const fd = new FormData();
      fd.append('fichier', $docSigne.files[0]);
      try {
        await api('POST', `/formalites/${id}/document-signe`, fd, true);
        toast('Document signé déposé — la formalité est signée.');
        render();
      } catch (e) {
        toast(e.message, true);
        $btnDocSigne.disabled = false;
        $btnDocSigne.textContent = 'Déposer le document signé (PJ_115)';
      }
    };
  }
}

/**
 * Dossier importé du compte INPI : miroir en lecture seule. L'application n'a
 * pas le questionnaire d'origine — la formalité a pu être déposée avant sa
 * mise en service, ou depuis l'interface web — donc elle n'affiche que ce que
 * l'INPI détient, et renvoie au portail pour le détail complet.
 */
function detailImporte(f, etat) {
  const portail = etat?.guichet?.portailUrl || 'https://procedures.inpi.fr';
  $main.innerHTML = `
    <div class="page-head">
      <div>
        <div class="crumb"><a href="#/formalites">Formalités</a> › importée</div>
        <h1>${esc(f.type_libelle || 'Formalité')}</h1>
        <div class="muted">${esc(f.libelle || '')}${f.siren ? ` · ${esc(f.siren)}` : ''}</div>
      </div>
      <div>${badgeStatut(f)}<span class="badge non_applicable">importée</span></div>
    </div>

    <div class="alerte alerte-info">
      <strong>Dossier repris du compte INPI.</strong> Il n'a pas été déposé depuis cette application :
      son questionnaire et ses pièces restent sur le guichet unique. Le suivi ci-dessous est actualisé
      à chaque synchronisation.
    </div>

    <div class="grid cols-2">
      <div class="card">
        <h2>Suivi</h2>
        <dl class="recap">
          <div><dt>Liasse</dt><dd>${esc(f.numero_liasse || '—')}</dd></div>
          <div><dt>Statut INPI</dt><dd>${esc(f.statut_inpi || f.statut)}</dd></div>
          <div><dt>Dernier changement</dt><dd>${fmtDate(f.statut_date)}</dd></div>
          <div><dt>Taxes</dt><dd>${f.montant != null ? eur.format(f.montant) : '—'}</dd></div>
          <div><dt>N° national</dt><dd>${esc(f.num_nat || '—')}</dd></div>
          <div><dt>Référence mandataire</dt><dd>${esc(f.reference || '—')}</dd></div>
          <div><dt>Signée le</dt><dd>${f.signature_date ? fmtDate(f.signature_date) : '—'}</dd></div>
          <div><dt>Payée le</dt><dd>${f.paiement_date ? fmtDate(f.paiement_date) : '—'}</dd></div>
        </dl>
        ${f.regularisations?.length ? `<div class="alerte alerte-bloquant mt">
          <strong>Régularisation demandée.</strong>
          <ul>${f.regularisations.map((r) => `<li>${esc(r.motif)}</li>`).join('')}</ul></div>` : ''}
        <div class="dialog-actions">
          <a class="btn" href="${esc(portail)}" target="_blank" rel="noopener noreferrer">Ouvrir sur le guichet unique</a>
          <button id="btn-sync-un">Actualiser le statut</button>
        </div>
      </div>

      <div class="card">
        <h2>Journal du dossier</h2>
        <ul class="journal">${f.evenements.map((e) => `
          <li><span class="quand">${fmtDate(e.created_at)}</span> ${esc(e.message)}</li>`).join('')}</ul>
      </div>
    </div>`;

  const $sync = document.getElementById('btn-sync-un');
  $sync.onclick = async () => {
    $sync.disabled = true;
    try { await api('POST', `/formalites/${f.id}/synchroniser`); render(); } catch (e) { toast(e.message, true); $sync.disabled = false; }
  };
}

/** Bouton correspondant à l'action que le guichet unique attend de nous. */
function actionHtml(f, def) {
  const depose = Boolean(f.inpi_id);
  const action = f.action_attendue;
  const boutons = [];
  // La signature avancée a son propre panneau : pas de bouton direct, qui
  // échouerait faute de document signé.
  const signatureDeleguee = action === 'signer' && def?.signature !== 'simple';
  if (action && action !== 'attendre' && action !== 'regulariser' && !signatureDeleguee && ACTIONS[action]?.libelle) {
    boutons.push(`<button class="${ACTIONS[action].classe}" id="btn-action" data-action="${action}"
      ${action === 'deposer' && !f.controles.pret ? 'disabled' : ''}>${esc(ACTIONS[action].libelle)}</button>`);
  }
  if (depose && !signatureDeleguee) boutons.push('<button id="btn-sync-un">Actualiser le statut</button>');
  return boutons.join(' ');
}

/** Avancement du dossier dans le cycle du guichet unique. */
function cycleHtml(f, def, etat) {
  const etapes = [
    { cle: 'deposer', libelle: 'Dépôt', fait: Boolean(f.inpi_id), date: f.created_at },
    { cle: 'signer', libelle: 'Signature', fait: Boolean(f.signature_date), date: f.signature_date },
    { cle: 'payer', libelle: 'Paiement', fait: Boolean(f.paiement_date), date: f.paiement_date },
    { cle: 'validation', libelle: 'Validation', fait: f.statut === 'VALIDATED', date: f.statut === 'VALIDATED' ? f.statut_date : null },
  ];

  const attente = f.action_attendue && f.action_attendue !== 'attendre'
    ? `<div class="alerte alerte-alerte"><strong>Action attendue de notre côté :</strong>
        ${esc(ACTIONS[f.action_attendue]?.libelle || f.action_attendue)}.
        ${f.action_attendue === 'payer' && f.montant ? `<div class="sub">Montant des taxes : ${eur.format(f.montant)}.</div>` : ''}
       </div>`
    : `<div class="alerte alerte-info"><strong>En attente côté INPI.</strong> ${esc(f.statut_libelle)}.</div>`;

  return `${attente}
    <ol class="cycle">${etapes.map((e) => `
      <li class="${e.fait ? 'fait' : (f.action_attendue === e.cle ? 'courant' : '')}">
        <span class="puce">${e.fait ? '✓' : (f.action_attendue === e.cle ? '●' : '·')}</span>
        ${esc(e.libelle)}${e.date ? `<span class="quand">${fmtDate(e.date)}</span>` : ''}</li>`).join('')}
    </ol>
    ${f.action_attendue === 'signer' ? signatureHtml(f, def, etat) : ''}
    <dl class="recap mt">
      <div><dt>Liasse</dt><dd>${esc(f.numero_liasse || '—')}</dd></div>
      <div><dt>Statut INPI</dt><dd>${esc(f.statut_inpi || f.statut)}</dd></div>
      <div><dt>Taxes</dt><dd>${f.montant != null ? eur.format(f.montant) : '—'}</dd></div>
      <div><dt>N° national</dt><dd>${esc(f.num_nat || '—')}</dd></div>
    </dl>`;
}

/**
 * Écran de signature. Deux voies, la gratuite mise en avant :
 *  - FranceConnect+ (Identité Numérique La Poste) sur le portail de l'INPI :
 *    la formalité a été déposée par API, le signataire s'y connecte et signe ;
 *  - certificat qualifié : synthèse téléchargée, signée hors ligne, redéposée
 *    en PJ_115, ce qui vaut signature.
 * Une création se signe d'un simple clic et n'affiche pas ce panneau.
 */
function signatureHtml(f, def, etat) {
  if (def?.signature === 'simple') return '';
  const portail = etat?.guichet?.portailUrl || 'https://procedures.inpi.fr';
  return `<div class="signature">
    <div class="voie-principale">
      <div class="voie-tete">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16c3 0 4-9 7-9s3 9 6 9c2 0 3-1.6 5-2.6"/><path d="M4 20h16"/></svg>
        <div>
          <h4>Signature gratuite via FranceConnect+</h4>
          <p class="muted">Le dossier est déposé. Le signataire se connecte au guichet unique avec
            son identité numérique (La Poste) et signe : aucun certificat à acheter.</p>
        </div>
      </div>
      <div class="liasse-copie">
        <span class="etiquette">N° de liasse</span>
        <code id="liasse-valeur">${esc(f.numero_liasse || '—')}</code>
        <button class="btn-sm btn-ghost" id="btn-copier-liasse" type="button">Copier</button>
      </div>
      <div class="voie-actions">
        <a class="btn-gold" href="${esc(portail)}" target="_blank" rel="noopener noreferrer">
          Ouvrir le guichet unique
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
        </a>
        <button id="btn-signe-fait" type="button">J'ai signé — actualiser le statut</button>
      </div>
    </div>

    <details class="voie-secondaire">
      <summary>Ou signer avec un certificat électronique qualifié</summary>
      <ol class="etapes-signature">
        <li><a href="${API_ROOT}/formalites/${f.id}/synthese" target="_blank" rel="noopener">Télécharger le document de synthèse</a> (PJ_99).</li>
        <li>Le signer avec un certificat qualifié eIDAS (signature PAdES).</li>
        <li>Le redéposer ci-dessous : le dépôt vaut signature.</li>
      </ol>
      <div class="voie-actions">
        <button id="btn-doc-signe" type="button">Déposer le document signé (PJ_115)</button>
        <input type="file" id="input-doc-signe" hidden accept="application/pdf,.pdf">
      </div>
      <p class="muted">L'INPI refuse le document si l'autorité de certification n'est pas reconnue par eIDAS.</p>
    </details>
  </div>`;
}

/** Les dates ISO du récapitulatif sont affichées au format français. */
function valeurLisible(valeur) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valeur)) ? fmtDate(valeur) : valeur;
}

function controlesHtml(c) {
  if (!c) return '';
  // Chaque constat renvoie sur l'encart fautif : sur un questionnaire de
  // cinquante champs, retrouver « Commune manquante » à la main est pénible.
  const item = (c2) => {
    const message = esc(c2.message || c2);
    return c2.champ
      ? `<li><button type="button" class="lien-controle" data-cible="${esc(c2.champ)}">${message}<span class="fleche-controle">Corriger</span></button></li>`
      : `<li>${message}</li>`;
  };
  const bloc = (titre, items, classe) => (items.length ? `<div class="alerte alerte-${classe}">
      <strong>${titre}</strong><ul class="liste-controles">${items.map(item).join('')}</ul></div>` : '');
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


/* ------------------------------------------- questionnaire progressif */

/**
 * Rattache chaque champ à la section qui le précède, compte les obligatoires
 * restants, et pilote le filtre « obligatoires seulement ».
 *
 * Sur un CERFA de création — onze sections, cinquante-six champs — dérouler
 * un formulaire d'un seul tenant est décourageant : le sommaire dit où l'on
 * en est, et chaque contrôle renvoie sur l'encart à corriger.
 */
function brancherProgression(form) {
  const sections = [];
  let courante = null;
  for (const bloc of form.querySelectorAll('.champ-bloc')) {
    if (bloc.classList.contains('bloc-section')) {
      courante = { titre: bloc.textContent.trim(), noeud: bloc, champs: [] };
      sections.push(courante);
      continue;
    }
    if (!courante) {
      courante = { titre: 'Informations', noeud: null, champs: [] };
      sections.push(courante);
    }
    courante.champs.push(bloc);
    bloc.dataset.section = String(sections.length - 1);
  }

  const $sommaire = document.getElementById('sommaire-sections');
  const $jauge = document.getElementById('jauge-remplie');
  const $compteur = document.getElementById('compteur-requis');
  const $filtre = document.getElementById('filtre-requis');
  if (!$sommaire) return;

  $sommaire.innerHTML = sections.map((s, i) => `
    <button type="button" class="onglet-section" data-section="${i}">
      <span class="nom">${esc(s.titre)}</span>
      <span class="etat" data-etat="${i}"></span>
    </button>`).join('');

  function rafraichir() {
    let requis = 0;
    let remplis = 0;
    sections.forEach((s, i) => {
      const r = s.champs.filter((c) => c.classList.contains('champ-requis'));
      const f = r.filter((c) => c.classList.contains('rempli'));
      requis += r.length;
      remplis += f.length;
      const etat = $sommaire.querySelector(`[data-etat="${i}"]`);
      if (etat) {
        etat.textContent = r.length ? `${f.length}/${r.length}` : '—';
        etat.classList.toggle('complet', r.length > 0 && f.length === r.length);
      }
      // Une section dont aucun champ n'est visible n'a pas lieu d'être.
      const visible = s.champs.some((c) => c.offsetParent !== null || !form.classList.contains('requis-seuls'));
      if (s.noeud) s.noeud.hidden = form.classList.contains('requis-seuls') && !visible;
    });
    if ($jauge) $jauge.style.width = requis ? `${Math.round((remplis / requis) * 100)}%` : '100%';
    if ($compteur) {
      $compteur.textContent = requis
        ? `${remplis} sur ${requis} information(s) obligatoire(s)`
        : 'Aucune information obligatoire';
    }
  }

  // Un champ devient « rempli » dès la saisie, sans attendre l'enregistrement.
  form.addEventListener('input', (e) => {
    const bloc = e.target.closest('.champ-bloc');
    if (!bloc) return;
    const rempli = [...bloc.querySelectorAll('input, select, textarea')]
      .some((c) => (c.type === 'checkbox' ? c.checked : String(c.value || '').trim() !== ''));
    bloc.classList.toggle('rempli', rempli);
    rafraichir();
  });
  form.addEventListener('change', () => rafraichir());

  $sommaire.addEventListener('click', (e) => {
    const onglet = e.target.closest('.onglet-section');
    if (onglet) allerA(sections[Number(onglet.dataset.section)]?.noeud || sections[0].champs[0]);
  });

  if ($filtre) {
    $filtre.addEventListener('change', () => {
      form.classList.toggle('requis-seuls', $filtre.checked);
      rafraichir();
    });
  }

  rafraichir();
}

/** Amène un encart à l'écran et le signale brièvement. */
function allerA(noeud) {
  if (!noeud) return;
  noeud.scrollIntoView({ behavior: 'smooth', block: 'center' });
  noeud.classList.add('surligne');
  setTimeout(() => noeud.classList.remove('surligne'), 1600);
  const premier = noeud.querySelector('input, select, textarea');
  if (premier) setTimeout(() => premier.focus({ preventScroll: true }), 400);
}
