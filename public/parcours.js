/* =========================================================================
   Parcours de formalités.

   1. Choisir la société et une ou plusieurs opérations.
   2. Votre situation : quelques questions qui décident des pièces.
   3. Pièces : obligatoires, à préciser, facultatives — chargées, provisoires,
      à signer.
   4. Informations : l'analyse des pièces pré-remplit ; on ne complète que
      ce qui change.
   5. Vérifier et déposer.
   Le formulaire complet et le dossier technique restent accessibles.
   ========================================================================= */

/** Appel d'API qui garde le détail des refus (contrôles, violations du guichet). */
async function apiParcours(method, url, body, isForm) {
  const opts = { method, headers: await enTetesAuth() };
  if (body !== undefined && !isForm) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); } else if (body !== undefined) opts.body = body;
  const res = await fetch(`/api${url}`, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok) refusAcces(res.status, json);
  if (!res.ok) throw Object.assign(new Error(json?.error || `Erreur ${res.status}`), { details: json?.details, violations: json?.violations });
  return json;
}

let pcDossier = null;
let pcEtape = null;
let pcRef = null;

/** Listes du guichet (journaux, nationalités, catégories d'activité), chargées une fois. */
async function pcReferentiels() {
  if (!pcRef) pcRef = await apiParcours('GET', '/parcours/referentiels').catch(() => ({ journaux: [], nationalites: [], types_voie: [], categories: [] }));
  return pcRef;
}

const pcSansAccent = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* ------------------------------------------------------ nouveau dossier */

async function vueParcoursNouveau(query = '') {
  const [societes, operations] = await Promise.all([api('GET', '/societes'), apiParcours('GET', '/parcours/operations')]);
  const params = new URLSearchParams(query || '');
  const preselection = new Set((params.get('ops') || '').split(',').filter(Boolean));
  // Ouvert depuis un dossier : la formalité y sera rattachée.
  const dossierId = params.get('dossier') || null;
  const parCode = new Map(operations.map((o) => [o.code, o]));

  $main.innerHTML = `
    <div class="entete-vue"><div>
      <div class="crumb"><a href="#/formalites">Formalités</a> /</div>
      <h1 class="titre-page">Nouvelle formalité</h1>
      <p class="muted">Choisissez la société, puis toutes les opérations décidées : elles seront déposées ensemble quand c’est possible.</p>
    </div></div>

    <section class="pc-bloc">
      <h2><span class="memo-num">1</span> La société</h2>
      <div class="row">
        <label class="field">Société du cabinet
          <select id="pc-societe">
            <option value="">— choisir —</option>
            ${societes.map((s) => `<option value="${s.id}" data-siren="${esc(s.siren || '')}">${esc(s.denomination)}${s.siren ? ` — ${esc(s.siren)}` : ''}</option>`).join('')}
          </select></label>
        <label class="field">ou SIREN
          <input id="pc-siren" placeholder="123 456 789" maxlength="11" inputmode="numeric"></label>
      </div>
      <p class="muted pc-aide">La fiche du registre sert de point de départ : vous ne saisirez que ce qui change. Pour une création, laissez vide.</p>
    </section>

    <section class="pc-bloc">
      <h2><span class="memo-num">2</span> Les formalités <span class="muted pc-compte" id="pc-compte"></span></h2>
      <div class="pc-choix-ops" id="pc-choix-ops">
        <div class="pc-puces" id="pc-puces"></div>
        <input id="pc-ops-q" type="search" placeholder="Rechercher une formalité : capital, gérant, siège, dissolution, 15M…" autocomplete="off" aria-expanded="false">
        <div class="pc-ops-liste" id="pc-ops-liste" hidden></div>
      </div>
      <p class="muted pc-aide">Plusieurs formalités peuvent être choisies : elles seront déposées ensemble quand c’est possible.
        <span class="pc-legende"><span class="badge pc-b-guidee">guidée</span> questions, pièces et informations ciblées ·
        <span class="badge pc-b-fiche">pièces de la fiche</span> liste des pièces, à compléter vous-même ·
        <span class="badge pc-b-portail">portail INPI</span> dépôt à finaliser sur le portail</span></p>
    </section>

    <div class="pc-pied-actions">
      <button class="btn btn-primary" id="pc-ouvrir">Ouvrir le dossier</button>
      <span class="muted" id="pc-msg"></span>
    </div>`;

  const choisies = new Set([...preselection].filter((c) => parCode.has(c)));
  const motsCles = typeof MEMO_MOTS_CLES !== 'undefined' ? MEMO_MOTS_CLES : {};
  const $q = document.getElementById('pc-ops-q');
  const $liste = document.getElementById('pc-ops-liste');
  let actif = -1;

  const badges = (o) => `${o.guidee ? '<span class="badge pc-b-guidee">guidée</span>' : '<span class="badge pc-b-fiche">pièces de la fiche</span>'}
    ${o.depot_automatique ? '' : '<span class="badge pc-b-portail">portail INPI</span>'}`;
  const puces = () => {
    document.getElementById('pc-puces').innerHTML = [...choisies].map((c) => `<span class="pc-puce">${esc(parCode.get(c).nom)}
      <button type="button" data-retirer-op="${esc(c)}" title="Retirer">×</button></span>`).join('');
    document.getElementById('pc-compte').textContent = choisies.size ? `· ${choisies.size} choisie(s)` : '';
    document.querySelectorAll('[data-retirer-op]').forEach((b) => { b.onclick = () => { choisies.delete(b.dataset.retirerOp); puces(); filtrer(); }; });
  };
  const correspond = (o, mots) => {
    const texte = pcSansAccent(`${o.nom} ${o.libelle_inpi || ''} ${o.code} ${motsCles[o.code] || ''}`);
    // Tolère les variantes d'un même mot : « gérant » trouve aussi « gérance ».
    return mots.every((m) => texte.includes(m.length >= 5 ? m.slice(0, -1) : m));
  };
  const filtrer = () => {
    const mots = pcSansAccent($q.value).split(/\s+/).filter(Boolean);
    const trouvees = operations.filter((o) => correspond(o, mots))
      .sort((a, b) => a.ordre - b.ordre || Number(b.guidee) - Number(a.guidee));
    const groupesVus = [];
    let html = '';
    trouvees.forEach((o, i) => {
      if (!groupesVus.includes(o.groupe)) { groupesVus.push(o.groupe); html += `<div class="pc-ops-groupe">${esc(o.groupe)}</div>`; }
      html += `<label class="pc-ops-item ${i === actif ? 'actif' : ''}" data-i="${i}">
        <input type="checkbox" value="${esc(o.code)}" ${choisies.has(o.code) ? 'checked' : ''}>
        <span class="pc-ops-nom">${esc(o.nom)}${o.libelle_inpi && o.libelle_inpi !== o.nom ? `<span class="muted"> — ${esc(o.libelle_inpi)}</span>` : ''}</span>
        <span class="pc-ops-badges"><span class="pc-ops-code">${esc(o.code)}</span>${badges(o)}</span></label>`;
    });
    $liste.innerHTML = html || '<div class="muted pc-ops-vide">Aucune formalité ne correspond. Essayez un autre mot (capital, dirigeant, siège, dissolution…).</div>';
    $liste.querySelectorAll('.pc-ops-item input').forEach((c) => {
      c.onchange = () => { if (c.checked) choisies.add(c.value); else choisies.delete(c.value); puces(); };
    });
    return trouvees;
  };
  const ouvrir = (oui) => { $liste.hidden = !oui; $q.setAttribute('aria-expanded', String(oui)); };
  $q.onfocus = () => { filtrer(); ouvrir(true); };
  $q.oninput = () => { actif = -1; filtrer(); ouvrir(true); };
  $q.onkeydown = (e) => {
    const items = $liste.querySelectorAll('.pc-ops-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); ouvrir(true);
      actif = Math.max(0, Math.min(items.length - 1, actif + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((x, i) => x.classList.toggle('actif', i === actif));
      items[actif]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && actif >= 0 && items[actif]) {
      e.preventDefault(); items[actif].querySelector('input').click();
    } else if (e.key === 'Escape') ouvrir(false);
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('#pc-choix-ops') && document.getElementById('pc-ops-liste')) ouvrir(false); });
  puces();
  const $societe = document.getElementById('pc-societe');
  if (params.get('societe') && [...$societe.options].some((o) => o.value === params.get('societe'))) {
    $societe.value = params.get('societe');
    $societe.dispatchEvent(new Event('change'));
  }
  document.getElementById('pc-ouvrir').onclick = async () => {
    const operations = [...choisies];
    const societe_id = document.getElementById('pc-societe').value || null;
    const siren = document.getElementById('pc-siren').value.trim();
    const $msg = document.getElementById('pc-msg');
    if (!operations.length) { $msg.textContent = 'Choisissez au moins une opération.'; return; }
    $msg.textContent = 'Lecture de la fiche du registre…';
    try {
      const r = await apiParcours('POST', '/parcours', { societe_id, siren, operations, dossier_id: dossierId });
      if (r.avertissement) toast(r.avertissement, true);
      location.hash = `#/parcours/${r.id}`;
    } catch (e) { $msg.textContent = e.message; }
  };
}

/* ------------------------------------------------------------- dossier */

const PC_ETAPES = [
  ['situation', 'Votre situation'],
  ['pieces', 'Pièces'],
  ['informations', 'Informations'],
  ['depot', 'Vérifier et déposer'],
];

async function vueParcours(id) {
  [pcDossier] = await Promise.all([apiParcours('GET', `/parcours/${id}`), getEtatInpi(), pcReferentiels()]);
  if (!pcEtape || pcEtape.id !== id) pcEtape = { id, nom: etapeConseillee(pcDossier) };
  pcAfficher();
}

/** La première étape qui attend quelque chose. */
function etapeConseillee(d) {
  if (d.inpi_id) return 'depot';
  if (d.etat.questions_restantes) return 'situation';
  if (d.etat.pieces_manquantes.length || d.etat.pieces_a_preciser) return 'pieces';
  if (d.etat.champs_manquants.length) return 'informations';
  return 'depot';
}

function pcCompteur(nom, d) {
  const e = d.etat;
  const n = {
    situation: e.questions_restantes,
    pieces: e.pieces_manquantes.length + e.pieces_a_preciser,
    informations: e.champs_manquants.length,
    depot: e.pret ? 0 : null,
  }[nom];
  if (nom === 'depot') return d.inpi_id ? '<span class="pc-pastille ok">déposé</span>' : (e.pret ? '<span class="pc-pastille ok">prêt</span>' : '');
  return n ? `<span class="pc-pastille">${n}</span>` : '<span class="pc-pastille ok">✓</span>';
}

function pcAfficher() {
  const d = pcDossier;
  $main.innerHTML = `
    <div class="entete-vue pc-entete">
      <div>
        <div class="crumb"><a href="#/formalites">Formalités</a> / ${esc(d.reference || '')}</div>
        <h1 class="titre-page">${esc(d.operations.map((o) => o.nom).join(' + '))}</h1>
        <p class="muted">${esc(d.societe.denomination || 'Nouvelle société')}${d.societe.siren ? ` · ${esc(d.societe.siren)}` : ''}${d.societe.forme ? ` · ${esc(d.societe.forme)}` : ''}</p>
      </div>
      <div>${boutonSupprimerFormalite({ id: d.id, statut: d.statut })}</div>
    </div>
    ${d.fiche_absente ? `<div class="alerte alerte-bloquant pc-fiche-absente"><strong>La fiche du registre n’a pas pu être lue.</strong>
      Sans elle, l’application ne connaît pas les dirigeants ni les données actuelles de la société.
      <button class="btn" id="pc-relire-fiche">Relire la fiche du registre</button></div>` : ''}
    ${d.incompatibilites.length ? `<div class="alerte alerte-bloquant">${d.incompatibilites.map(esc).join('<br>')}</div>` : ''}
    <nav class="pc-etapes" role="tablist">
      ${PC_ETAPES.map(([nom, titre], i) => `<button role="tab" data-etape="${nom}" class="${pcEtape.nom === nom ? 'actif' : ''}">
        <span class="pc-etape-num">${i + 1}</span> ${titre} ${pcCompteur(nom, d)}</button>`).join('')}
    </nav>
    <div id="pc-contenu"></div>`;
  const $relire = document.getElementById('pc-relire-fiche');
  if ($relire) $relire.onclick = async () => { $relire.disabled = true; $relire.textContent = 'Lecture…'; await pcMaj('POST', `/parcours/${d.id}/fiche`); };
  $main.querySelectorAll('.pc-etapes button').forEach((b) => {
    b.onclick = async () => { await pcSauverSiBesoin(); pcEtape.nom = b.dataset.etape; pcAfficher(); };
  });
  ({ situation: pcSituation, pieces: pcPieces, informations: pcInformations, depot: pcDepot })[pcEtape.nom]();
}

async function pcMaj(method, url, body, isForm) {
  try {
    pcDossier = await apiParcours(method, url, body, isForm);
    pcAfficher();
  } catch (e) { toast(e.message, true); }
}

/* --------------------------------------------------- étape 1 : situation */

function pcSituation() {
  const d = pcDossier;
  const $c = document.getElementById('pc-contenu');
  if (!d.questions.length) {
    $c.innerHTML = `<div class="pc-bloc"><p>Aucune question à vous poser pour ces opérations : passez aux pièces.</p>
      <button class="btn btn-primary" data-aller="pieces">Voir les pièces</button></div>`;
    pcAllerVers($c);
    return;
  }
  $c.innerHTML = `<div class="pc-bloc">
    <p class="muted">Ces réponses déterminent les pièces à réunir. Elles ne sont pas transmises au guichet.</p>
    ${d.questions.map(pcQuestion).join('')}
    <div class="pc-pied-actions"><button class="btn btn-primary" data-aller="pieces">Continuer vers les pièces</button></div>
  </div>`;
  pcAllerVers($c);

  $c.querySelectorAll('[data-choix]').forEach((b) => {
    b.onclick = () => {
      const brut = b.dataset.valeur;
      const v = brut === 'true' ? true : brut === 'false' ? false : brut;
      pcMaj('PUT', `/parcours/${d.id}/typologie`, { [b.dataset.choix]: v });
    };
  });
  $c.querySelectorAll('.pc-liste').forEach((l) => pcListePersonnes(l));
}

function pcQuestion(q) {
  // Le rappel de l'opération n'a d'intérêt que s'il y en a plusieurs.
  const pour = q.pour.length && pcDossier.operations.length > 1 ? `<span class="pc-pour">${esc(q.pour.join(' · '))}</span>` : '';
  if (q.type === 'choix') {
    return `<div class="pc-question">
      <div class="pc-q-libelle">${esc(q.libelle)} ${pour}</div>
      ${q.aide ? `<div class="pc-aide muted">${esc(q.aide)}</div>` : ''}
      <div class="segments pc-choix">${q.options.map(([v, l]) => `<button type="button" data-choix="${q.id}" data-valeur="${esc(String(v))}"
        class="${q.valeur === v ? 'actif' : ''}">${esc(l)}</button>`).join('')}</div>
    </div>`;
  }
  if (q.attente) {
    return `<div class="pc-question pc-attente"><div class="pc-q-libelle">${esc(q.libelle)} ${pour}</div><div class="pc-aide muted">${esc(q.attente)}</div></div>`;
  }
  const lignes = Array.isArray(q.valeur) && q.valeur.length ? q.valeur : [{}];
  return `<div class="pc-question">
    <div class="pc-q-libelle">${esc(q.libelle)} ${pour}</div>
    ${q.aide ? `<div class="pc-aide muted">${esc(q.aide)}</div>` : ''}
    <div class="pc-liste" data-type="${q.type}" data-question="${q.id}">
      ${(q.type === 'sortants' || q.type === 'maj') && q.dirigeants_actuels?.length ? `<datalist id="pc-dirigeants">${q.dirigeants_actuels.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>` : ''}
      <div class="pc-lignes">${lignes.map((l) => pcLignePersonne(q, l)).join('')}</div>
      <div class="pc-liste-actions">
        <button type="button" class="btn-ghost pc-ajouter">+ Ajouter une personne</button>
        <button type="button" class="btn pc-enregistrer">Enregistrer</button>
        ${Array.isArray(q.valeur) || q.creation ? '' : '<button type="button" class="btn-ghost pc-personne-aucune">Aucune</button>'}
      </div>
    </div>
  </div>`;
}

function pcLignePersonne(q, l) {
  if ((q.type === 'sortants' || q.type === 'maj')) {
    return `<div class="pc-ligne">
      <input class="pc-nom" placeholder="${q.type === 'maj' ? 'Dirigeant concerné (nom ou dénomination au registre)' : 'Nom de la personne qui part'}" value="${esc(l.nom || '')}" list="pc-dirigeants">
      <select class="pc-motif">${q.options.map(([v, lab]) => `<option value="${v}" ${l.motif === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>
      <button type="button" class="btn-ghost pc-retirer" title="Retirer">×</button>
    </div>`;
  }
  return `<div class="pc-ligne">
    <input class="pc-nom" placeholder="Nom ou dénomination" value="${esc(l.nom || '')}">
    <select class="pc-nature">
      <option value="PP" ${l.nature !== 'PM' ? 'selected' : ''}>Personne physique</option>
      <option value="PM" ${l.nature === 'PM' ? 'selected' : ''}>Personne morale</option>
    </select>
    <select class="pc-fonction">${q.options.map(([v, lab]) => `<option value="${v}" ${l.fonction === v ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>
    <label class="pc-inscrit" ${pcEstCac(l.fonction) ? '' : 'hidden'}><input type="checkbox" class="pc-inscrit-case" ${l.inscrit === false ? '' : 'checked'}> déjà inscrit sur la liste des CAC</label>
    <label class="pc-hors-ue" ${l.nature === 'PM' || pcEstCac(l.fonction) ? 'hidden' : ''} title="Un titre de séjour peut être demandé"><input type="checkbox" class="pc-hors-ue-case" ${l.hors_ue ? 'checked' : ''}> nationalité hors Union européenne</label>
    <button type="button" class="btn-ghost pc-retirer" title="Retirer">×</button>
  </div>`;
}

function pcListePersonnes($l) {
  const q = pcDossier.questions.find((x) => x.id === $l.dataset.question);
  const $lignes = $l.querySelector('.pc-lignes');
  const brancher = () => {
    $lignes.querySelectorAll('.pc-retirer').forEach((b) => { b.onclick = () => b.closest('.pc-ligne').remove(); });
    const visibilite = (ligne) => {
      const fonction = ligne.querySelector('.pc-fonction').value;
      ligne.querySelector('.pc-inscrit').hidden = !pcEstCac(fonction);
      ligne.querySelector('.pc-hors-ue').hidden = pcEstCac(fonction) || ligne.querySelector('.pc-nature').value === 'PM';
    };
    $lignes.querySelectorAll('.pc-fonction, .pc-nature').forEach((s) => { s.onchange = () => visibilite(s.closest('.pc-ligne')); });
  };
  brancher();
  $l.querySelector('.pc-ajouter').onclick = () => { $lignes.insertAdjacentHTML('beforeend', pcLignePersonne(q, {})); brancher(); };
  const aucune = $l.querySelector('.pc-personne-aucune');
  if (aucune) aucune.onclick = () => pcMaj('PUT', `/parcours/${pcDossier.id}/typologie`, { [q.id]: [] });
  $l.querySelector('.pc-enregistrer').onclick = () => {
    const valeurs = [...$lignes.querySelectorAll('.pc-ligne')].map((ligne) => {
      const nom = ligne.querySelector('.pc-nom').value.trim();
      if (!nom) return null;
      if ((q.type === 'sortants' || q.type === 'maj')) return { nom, motif: ligne.querySelector('.pc-motif').value };
      const fonction = ligne.querySelector('.pc-fonction').value;
      const nature = ligne.querySelector('.pc-nature').value;
      return {
        nom, nature, fonction,
        ...(pcEstCac(fonction) ? { inscrit: ligne.querySelector('.pc-inscrit-case').checked } : {}),
        ...(nature === 'PP' && !pcEstCac(fonction) && ligne.querySelector('.pc-hors-ue-case').checked ? { hors_ue: true } : {}),
      };
    }).filter(Boolean);
    pcMaj('PUT', `/parcours/${pcDossier.id}/typologie`, { [q.id]: valeurs });
  };
}

function pcEstCac(fonction) { return ['cac', '71', '72'].includes(String(fonction || '')); }

function pcAllerVers($c) {
  $c.querySelectorAll('[data-aller]').forEach((b) => { b.onclick = async () => { await pcSauverSiBesoin(); pcEtape.nom = b.dataset.aller; pcAfficher(); }; });
}

/* Saisies de l'étape « Informations » pas encore enregistrées. */
let pcSale = false;

/** Toutes les rubriques en une fois : rien ne se perd en changeant d'étape. */
async function pcSauverInformations() {
  const valeurs = {};
  document.querySelectorAll('#pc-contenu .pc-groupe').forEach(($g) => {
    const v = {};
    $g.querySelectorAll('[data-champ]').forEach(($f) => { v[$f.dataset.champ] = pcLireChamp($f); });
    if (Object.keys(v).length) valeurs[$g.dataset.op] = v;
  });
  pcSale = false;
  await pcMaj('PUT', `/parcours/${pcDossier.id}/reponses`, valeurs);
}

async function pcSauverSiBesoin() {
  if (pcSale && pcEtape?.nom === 'informations') await pcSauverInformations();
}

/* ------------------------------------------------------ étape 2 : pièces */

function pcPieces() {
  const d = pcDossier;
  const $c = document.getElementById('pc-contenu');
  const bloc = (titre, liste, aide, ouvert = true) => (liste.length ? `
    <details class="pc-bloc pc-pieces" ${ouvert ? 'open' : ''}><summary><h2>${titre} <span class="muted">· ${liste.length}</span></h2></summary>
      ${aide ? `<p class="muted pc-aide">${aide}</p>` : ''}
      ${liste.map(pcPiece).join('')}
    </details>` : '');
  $c.innerHTML = `
    ${bloc('Pièces obligatoires', d.pieces.obligatoires, 'Chargez chaque pièce en PDF. Une version provisoire peut être déposée ici en attendant la signature : elle bloque seulement le dépôt final.')}
    ${bloc('À préciser', d.pieces.a_preciser, 'Ces pièces dépendent de votre situation. Répondez à la question correspondante, ou indiquez si vous êtes concerné.')}
    ${bloc('Facultatives', d.pieces.facultatives, null, false)}
    ${d.autres_pieces.length ? `<div class="pc-bloc"><h2>Autres pièces chargées</h2>${d.autres_pieces.map((f) => pcFichier(f)).join('')}</div>` : ''}
    <div class="pc-pied-actions"><button class="btn btn-primary" data-aller="informations">Continuer vers les informations</button></div>`;
  pcAllerVers($c);

  $c.querySelectorAll('.pc-charger').forEach((input) => {
    input.onchange = async () => {
      const ligne = input.closest('.pc-piece');
      for (const fichier of input.files) {
        const form = new FormData();
        form.append('cle', ligne.dataset.cle);
        form.append('code', ligne.querySelector('.pc-variante')?.value || ligne.dataset.code);
        form.append('version', ligne.querySelector('.pc-provisoire')?.checked ? 'provisoire' : 'definitive');
        form.append('fichier', fichier);
        await pcMaj('POST', `/parcours/${d.id}/pieces`, form, true);
      }
    };
  });
  $c.querySelectorAll('[data-version]').forEach((b) => {
    b.onclick = () => pcMaj('PUT', `/parcours/pieces/${b.dataset.piece}`, { version: b.dataset.version });
  });
  $c.querySelectorAll('[data-signer]').forEach((b) => {
    b.onclick = () => pcMaj('PUT', `/parcours/pieces/${b.dataset.piece}`, { a_signer: b.dataset.signer === 'true' });
  });
  $c.querySelectorAll('[data-retirer]').forEach((b) => {
    b.onclick = () => { if (confirm('Retirer cette pièce ?')) pcMaj('DELETE', `/parcours/pieces/${b.dataset.retirer}`); };
  });
  $c.querySelectorAll('.pc-rediger-pouvoir').forEach((b) => {
    b.onclick = () => {
      const $d = b.closest('.pc-pouvoir');
      const mandataire = { nom: $d.querySelector('.pc-mand-nom').value.trim(), adresse: $d.querySelector('.pc-mand-adresse').value.trim() };
      if (!mandataire.nom) { toast('Indiquez le nom du mandataire.', true); return; }
      try { localStorage.setItem('legalize.mandataire', JSON.stringify(mandataire)); } catch { /* sans mémoire, tant pis */ }
      pcMaj('POST', `/parcours/${d.id}/pouvoir`, { mandataire });
    };
  });
  $c.querySelectorAll('[data-concerne]').forEach((b) => {
    b.onclick = () => pcMaj('PUT', `/parcours/${d.id}/typologie`, { manuel: { [b.dataset.code]: b.dataset.concerne === 'oui' } });
  });
  $c.querySelectorAll('[data-question-lien]').forEach((b) => {
    b.onclick = () => { pcEtape.nom = 'situation'; pcAfficher(); };
  });
}

function pcPiece(p) {
  const fait = p.fichiers.length > 0;
  const precision = p.categorie === 'a_preciser'
    ? (p.question
      ? `<button class="lien" data-question-lien="${esc(p.question)}">Répondre à la question qui en décide</button>`
      : `<span class="pc-concerne">Concerné ? <button class="btn-ghost" data-concerne="oui" data-code="${esc(p.cle)}">Oui</button><button class="btn-ghost" data-concerne="non" data-code="${esc(p.cle)}">Non</button></span>`)
    : '';
  return `<div class="pc-piece ${fait ? 'fait' : ''}" data-cle="${esc(p.cle)}" data-code="${esc(p.code)}">
    <div class="pc-piece-tete">
      <span class="pc-statut">${fait ? '✓' : ''}</span>
      <div class="pc-piece-nom">
        <strong title="${esc(p.libelle)}">${esc(p.court)}</strong>${p.personne ? ` <span class="pc-personne">— ${esc(p.personne)}</span>` : ''}
        ${p.par_le_cabinet ? '<span class="badge">préparée par le cabinet</span>' : ''}
        <div class="muted pc-piece-detail">${esc(p.condition || p.raison || '')}${p.pour.length > 1 ? ` · pour ${esc(p.pour.join(', '))}` : ''}</div>
        ${precision}
      </div>
      ${p.categorie !== 'a_preciser' ? `<div class="pc-piece-actions">
        ${p.variantes?.length ? `<select class="pc-variante" title="Document fourni"><option value="${esc(p.code)}">${esc(p.court)}</option>
          ${p.variantes.map((v) => `<option value="${esc(v.code)}" title="${esc(v.libelle)}">ou : ${esc(v.court)}</option>`).join('')}</select>` : ''}
        <label class="pc-provisoire-l"><input type="checkbox" class="pc-provisoire"> provisoire</label>
        <label class="btn pc-bouton-charger">${fait ? 'Ajouter' : 'Charger'}<input type="file" accept="application/pdf,.pdf" class="pc-charger" multiple hidden></label>
      </div>` : ''}
    </div>
    ${p.redigeable ? pcRedactionPouvoir(p) : ''}
    ${p.fichiers.map((f) => pcFichier(f, f.code !== p.code ? [p, ...(p.variantes || [])].find((v) => v.code === f.code)?.court : null)).join('')}
  </div>`;
}

/** Le cabinet, mémorisé sur ce poste pour les pouvoirs suivants. */
function pcMandataire() {
  try { return JSON.parse(localStorage.getItem('legalize.mandataire') || '{}'); } catch { return {}; }
}

function pcRedactionPouvoir(p) {
  const m = pcMandataire();
  return `<details class="pc-pouvoir" ${p.fichiers.length ? '' : 'open'}>
    <summary>Rédiger le pouvoir automatiquement</summary>
    <p class="muted pc-aide">Prérempli avec la société, son représentant légal et les formalités du dossier. Il est joint en version provisoire, « à faire signer » : chargez ensuite la version signée.</p>
    <div class="row">
      <label class="field">Mandataire (cabinet ou avocat)<input class="pc-mand-nom" value="${esc(m.nom || '')}" placeholder="Cabinet …, avocats"></label>
      <label class="field">Adresse du mandataire<input class="pc-mand-adresse" value="${esc(m.adresse || '')}" placeholder="N°, voie, code postal, ville"></label>
    </div>
    <button type="button" class="btn pc-rediger-pouvoir">Rédiger le pouvoir</button>
  </details>`;
}

function pcFichier(f, variante = null) {
  return `<div class="pc-fichier">
    <a href="/api/formalites/pieces/${f.id}/download" target="_blank" rel="noopener">${esc(f.nom)}</a>${variante ? ` <span class="badge">${esc(variante)}</span>` : ''}
    ${f.version === 'provisoire'
      ? `<span class="badge pc-badge-provisoire">provisoire</span> <button class="lien" data-version="definitive" data-piece="${f.id}">passer en définitive</button>`
      : `<button class="lien" data-version="provisoire" data-piece="${f.id}">marquer provisoire</button>`}
    ${f.a_signer
      ? `<span class="badge">à signer</span> <button class="lien" data-signer="false" data-piece="${f.id}">signée</button>`
      : `<button class="lien" data-signer="true" data-piece="${f.id}">à faire signer</button>`}
    <button class="lien pc-retirer-fichier" data-retirer="${f.id}">retirer</button>
  </div>`;
}

/* ------------------------------------------------- étape 3 : informations */

function pcInformations() {
  const d = pcDossier;
  const $c = document.getElementById('pc-contenu');
  const a = d.analyse;
  const derniere = a.derniere;
  $c.innerHTML = `
    <div class="pc-bloc pc-analyse">
      ${a.disponible ? `
        <div><strong>Pré-remplir à partir des pièces</strong>
          <p class="muted">Les actes chargés sont lus automatiquement ; les informations trouvées sont proposées ci-dessous, à vérifier. Rien de ce que vous avez saisi n’est écrasé.</p></div>
        <button class="btn btn-primary" id="pc-analyser">Analyser les pièces</button>`
        : `<div><strong>Analyse automatique des pièces</strong>
          <p class="muted">Non activée sur cette installation : il faut renseigner la clé ANTHROPIC_API_KEY dans les réglages de l’hébergement. En attendant, complétez les champs ci-dessous.</p></div>`}
      ${derniere ? `<p class="muted pc-aide">Dernière analyse : ${new Date(derniere.date).toLocaleString('fr-FR')} — ${derniere.champs} information(s) proposée(s), ${derniere.documents.length} pièce(s) lue(s).</p>
        ${derniere.incoherences?.length ? `<div class="alerte"><strong>Points à vérifier relevés dans les pièces</strong><ul>${derniere.incoherences.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}` : ''}
    </div>
    ${d.champs.map(pcGroupe).join('') || '<div class="pc-bloc"><p>Aucune information à saisir pour ces opérations.</p></div>'}
    <details class="pc-bloc pc-technique"><summary>Prendre la main : dossier complet transmis au guichet</summary>
      <p class="muted">Le contenu exact qui sera déposé, généré à partir de la fiche du registre et de vos réponses. Pour un cas que le parcours ne couvre pas, le dossier peut aussi être finalisé sur le portail de l’INPI.</p>
      <button class="btn" id="pc-apercu">Afficher le dossier complet</button>
      <pre id="pc-json" class="pc-json" hidden></pre>
    </details>
    <div class="pc-pied-actions"><button class="btn btn-primary" data-aller="depot">Vérifier le dossier</button></div>
    <div class="pc-barre-enregistrer" id="pc-barre-enregistrer"><span>Modifications non enregistrées</span><button class="btn btn-primary" id="pc-enregistrer-tout">Enregistrer</button></div>`;
  pcAllerVers($c);

  const $an = document.getElementById('pc-analyser');
  if ($an) {
    $an.onclick = async () => {
      $an.disabled = true; $an.textContent = 'Lecture des pièces… (jusqu’à une minute)';
      await pcMaj('POST', `/parcours/${d.id}/analyser`);
    };
  }
  document.getElementById('pc-apercu').onclick = async () => {
    const $j = document.getElementById('pc-json');
    try {
      const corps = await apiParcours('GET', `/parcours/${d.id}/apercu`);
      $j.textContent = JSON.stringify(corps, null, 2); $j.hidden = false;
    } catch (e) { $j.textContent = e.message; $j.hidden = false; }
  };
  pcSuggestionsActivite($c.querySelector('.pc-groupe[data-op="c_activite"]'));
  pcSale = false;
  const salir = () => { pcSale = true; document.getElementById('pc-barre-enregistrer')?.classList.add('visible'); };
  $c.addEventListener('input', salir);
  $c.addEventListener('change', salir);
  $c.addEventListener('click', (e) => { if (e.target.closest('.segments button, .pc-cat-res button, .pc-suggestions button, .pc-be-retirer, .pc-be-ajouter, .pc-be-reprendre')) salir(); });
  $c.querySelectorAll('.pc-enregistrer-groupe, #pc-enregistrer-tout').forEach((b) => { b.onclick = () => pcSauverInformations(); });
}

function pcGroupe(g) {
  const manquants = g.champs.filter((c) => c.requis && !c.rempli).length;
  return `<div class="pc-bloc pc-groupe" data-op="${esc(g.op)}">
    <h2>${esc(g.titre)} ${manquants ? `<span class="pc-pastille">${manquants}</span>` : '<span class="pc-pastille ok">✓</span>'}</h2>
    ${g.aide ? `<p class="muted pc-aide">${esc(g.aide)}</p>` : ''}
    ${g.champs.map(pcChamp).join('')}
    ${g.champs.some((c) => c.type !== 'renvoi') ? '<div class="pc-pied-actions"><button class="btn pc-enregistrer-groupe">Enregistrer</button></div>' : ''}
  </div>`;
}

function pcChamp(c) {
  const v = c.valeur;
  const tete = `<div class="pc-champ-tete"><span>${esc(c.label)}${c.requis ? ' <span class="pc-requis">obligatoire</span>' : ''}</span>
    ${c.origine === 'analyse' ? '<span class="badge pc-badge-analyse">proposé par l’analyse</span>' : ''}</div>
    ${c.actuel ? `<div class="pc-actuel">Actuellement au registre : ${esc(c.actuel)}</div>` : ''}
    ${c.aide ? `<div class="pc-aide muted">${esc(c.aide)}</div>` : ''}`;
  const manque = c.manquants?.length ? `<div class="pc-manque">À compléter : ${c.manquants.map(esc).join(' · ')}</div>` : '';
  const attr = `data-champ="${esc(c.name)}" data-type="${esc(c.type)}"`;
  switch (c.type) {
    case 'renvoi':
      return `<div class="pc-champ">${tete}<a class="btn" href="#/formalites/new">Ouvrir le formulaire de création</a></div>`;
    case 'textarea':
      return `<label class="pc-champ">${tete}<textarea ${attr} rows="3">${esc(v || '')}</textarea></label>`;
    case 'date':
      return `<label class="pc-champ">${tete}<input type="date" ${attr} value="${esc(v || '')}"></label>`;
    case 'money': case 'number':
      return `<label class="pc-champ">${tete}<input type="number" step="0.01" ${attr} value="${esc(v ?? '')}"></label>`;
    case 'ouinon':
      return `<div class="pc-champ">${tete}<div class="segments" ${attr} data-valeur="${v === true ? 'true' : v === false ? 'false' : ''}">
        <button type="button" class="${v === true ? 'actif' : ''}" data-v="true">Oui</button><button type="button" class="${v === false ? 'actif' : ''}" data-v="false">Non</button></div></div>`;
    case 'choix':
      return `<label class="pc-champ">${tete}<select ${attr}><option value=""></option>${(c.options || []).map(([o, l]) => `<option value="${esc(o)}" ${String(v) === String(o) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    case 'forme':
      return `<label class="pc-champ">${tete}<select ${attr}><option value=""></option>${(etatInpi?.formes_juridiques || []).map((f) => `<option value="${esc(f.code)}" ${v === f.code ? 'selected' : ''}>${esc(f.libelle)}</option>`).join('')}</select></label>`;
    case 'journal':
      return `<label class="pc-champ">${tete}<input ${attr} value="${esc(v || '')}" list="pc-journaux" placeholder="Tapez le nom du journal…" autocomplete="off">
        ${pcDatalistes()}</label>`;
    case 'categorie':
      return `<div class="pc-champ">${tete}${pcCategorie(c, v)}</div>`;
    case 'adresse':
      return `<div class="pc-champ">${tete}<div class="pc-sous" ${attr}>${pcAdresse(v || {})}</div></div>`;
    case 'personne':
      return `<div class="pc-champ">${tete}${manque}<div class="pc-sous" ${attr}>${pcPersonne(v || {}, '', c)}</div></div>`;
    case 'personne_morale':
      return `<div class="pc-champ">${tete}${manque}<div class="pc-sous" ${attr}>${pcPersonneMorale(v || {}, c)}</div></div>`;
    case 'beneficiaires':
      return `<div class="pc-champ">${tete}${manque}${pcBeneficiaires(c, v)}</div>`;
    default:
      return `<label class="pc-champ">${tete}<input ${attr} value="${esc(v || '')}"></label>`;
  }
}

/** Listes de suggestions partagées par les champs : journaux, nationalités. */
function pcDatalistes() {
  if (document.getElementById('pc-journaux')) return '';
  return `<datalist id="pc-journaux">${(pcRef?.journaux || []).map((j) => `<option value="${esc(j)}">`).join('')}</datalist>
    <datalist id="pc-nationalites">${(pcRef?.nationalites || []).map(([, l]) => `<option value="${esc(l)}">`).join('')}</datalist>`;
}

const pcIn = (k, label, v, extra = '') => `<label class="field">${label}<input data-k="${k}" value="${esc(v ?? '')}" ${extra}></label>`;

/**
 * Adresse : une recherche dans la base adresse nationale remplit les champs
 * (voie, code postal, commune, code INSEE). Ils restent modifiables.
 */
function pcAdresse(a, prefixe = '') {
  return `<div class="pc-adr" data-prefixe="${esc(prefixe)}"><div class="pc-adr-recherche"><input class="pc-adr-q" placeholder="Rechercher l’adresse (ex. 10 rue de la Paix Paris)" autocomplete="off">
      <div class="pc-suggestions" hidden></div></div>
    <div class="row">${pcIn(`${prefixe}numVoie`, 'N°', a.numVoie, 'maxlength="6"')}${pcIn(`${prefixe}typeVoie`, 'Type de voie', a.typeVoie, 'placeholder="RUE, AV, BD…"')}${pcIn(`${prefixe}voie`, 'Voie', a.voie)}</div>
    <div class="row">${pcIn(`${prefixe}complementLocalisation`, 'Complément', a.complementLocalisation)}${pcIn(`${prefixe}codePostal`, 'Code postal', a.codePostal, 'maxlength="5"')}${pcIn(`${prefixe}commune`, 'Commune', a.commune)}</div>
    <input type="hidden" data-k="${prefixe}codeInseeCommune" value="${esc(a.codeInseeCommune || '')}"></div>`;
}

function pcSelect(k, label, v, options) {
  return `<label class="field">${label}<select data-k="${k}"><option value=""></option>${options.map(([o, l]) => `<option value="${o}" ${String(v ?? '') === o ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
}

const PC_AFFILIATION = [['3', 'Travailleur non salarié (gérant majoritaire de SARL, gérant de SNC ou de société civile…)'], ['1', 'Non affilié comme TNS (président de SAS, gérant minoritaire, mandat non rémunéré…)'], ['0', 'Sans objet']];
const PC_ORGANISMES = [['R', 'Régime général'], ['N', 'Non salarié non agricole (SSI)'], ['A', 'Agricole (MSA)'], ['E', 'ENIM (marins)'], ['X', 'Autre'], ['aucun', 'Aucun']];
const PC_SIMULTANEE = [['aucune', 'Aucune'], ['1', 'Salarié'], ['2', 'Salarié agricole'], ['A', 'Non salarié non agricole'], ['B', 'Retraité'], ['C', 'Pensionné d’invalidité'], ['9', 'Autre']];
const PC_SITUATIONS = [['1', 'Célibataire'], ['4', 'Marié(e)'], ['5', 'Pacsé(e)'], ['6', 'En concubinage'], ['2', 'Divorcé(e)'], ['3', 'Veuf(ve)']];

/** Identité d'une personne physique. `p` préfixe les clés (représentant permanent). */
function pcPersonne(p, prefixe = '', c = {}) {
  const k = (x) => `${prefixe}${x}`;
  const sarl = (c.sous_requis || []).includes('situation_matrimoniale');
  const identite = `<div class="row">${pcIn(k('nom'), 'Nom', p.nom)}${pcIn(k('prenoms'), 'Prénoms', Array.isArray(p.prenoms) ? p.prenoms.join(' ') : p.prenoms)}
      ${c.sans_qualite || prefixe ? '' : pcIn(k('qualite'), 'Fonction exacte', p.qualite, 'placeholder="Président, Directeur général…"')}
      ${pcSelect(k('genre'), 'Sexe', p.genre, [['1', 'Masculin'], ['2', 'Féminin']])}</div>
    <div class="row">${pcIn(k('date_naissance'), 'Date de naissance', p.date_naissance, 'type="date"')}
      <label class="field">Commune de naissance<span class="pc-commune"><input data-k="${k('lieu_naissance')}" value="${esc(p.lieu_naissance || '')}" class="pc-commune-q" autocomplete="off"><span class="pc-suggestions" hidden></span></span></label>
      ${pcIn(k('code_insee_naissance'), 'Code INSEE', p.code_insee_naissance, 'maxlength="5" class="pc-insee" placeholder="trouvé automatiquement"')}
      ${pcIn(k('pays_naissance'), 'Pays de naissance', p.pays_naissance || 'FRANCE')}</div>
    <div class="row">${pcIn(k('nationalite'), 'Nationalité', p.nationalite || 'Française', 'list="pc-nationalites"')}
      ${prefixe ? '' : pcSelect(k('forme_sociale'), 'Affiliation sociale', p.forme_sociale, PC_AFFILIATION)}
      ${prefixe ? '' : pcIn(k('numero_secu'), 'N° de sécurité sociale (si TNS)', p.numero_secu, 'maxlength="21" inputmode="numeric"')}
      ${prefixe || !sarl ? '' : pcSelect(k('situation_matrimoniale'), 'Situation matrimoniale', p.situation_matrimoniale, PC_SITUATIONS)}</div>
    ${prefixe ? '' : `<div class="pc-tns" ${String(p.forme_sociale) === '3' ? '' : 'hidden'}><div class="pc-sous-titre">Volet social du travailleur non salarié</div>
      <div class="row">${pcSelect(k('volet.organisme_maladie'), 'Régime d’assurance maladie actuel', p.volet?.organisme_maladie, PC_ORGANISMES)}
        ${pcSelect(k('volet.activite_simultanee'), 'Activité exercée en parallèle', p.volet?.activite_simultanee, PC_SIMULTANEE)}
        ${pcIn(k('volet.activite_anterieure'), 'Activité non salariée antérieure (le cas échéant)', p.volet?.activite_anterieure)}
        ${pcIn(k('volet.activite_anterieure_fin'), 'Fin de cette activité', p.volet?.activite_anterieure_fin, 'type="date"')}</div></div>`}
    <div class="pc-sous-titre">Domicile</div>${pcAdresse(p.adresse || {}, k('adresse.'))}`;
  return identite + pcDatalistes();
}

function pcPersonneMorale(p, c = {}) {
  return `<div class="row">${pcIn('denomination', 'Dénomination', p.denomination || p.nom)}${pcIn('siren', 'SIREN', p.siren, 'inputmode="numeric"')}
      ${pcSelect('forme_juridique_code', 'Forme juridique', p.forme_juridique_code, (etatInpi?.formes_juridiques || []).map((f) => [f.code, esc(f.libelle)]))}
      ${pcIn('greffe', 'Greffe d’immatriculation', p.greffe, 'placeholder="PARIS, NANTERRE…"')}</div>
    <div class="pc-sous-titre">Siège</div>${pcAdresse(p.adresse || {}, 'adresse.')}
    ${c.representant_requis ? `<div class="pc-sous-titre">Représentant permanent</div>${pcPersonne(p.representant || {}, 'representant.')}` : ''}`;
}

/* ---- catégorie d'activité : recherche dans la nomenclature du guichet ---- */

const PC_FORMES_EXERCICE = {
  COMMERCIALE: 'commerciale', ARTISANALE: 'artisanale', ARTISANALE_REGLEMENTEE: 'artisanale réglementée', LIBERALE_REGLEMENTEE: 'libérale réglementée',
  INDEPENDANTE: 'libérale non réglementée', AGENT_COMMERCIAL: 'agent commercial', GESTION_DE_BIENS: 'gestion de biens',
  ACTIF_AGRICOLE: 'agricole', AGRICOLE_NON_ACTIF: 'agricole (non actif)',
};

function pcCategorie(c, v) {
  const choisie = (pcRef?.categories || []).find((x) => x.code === v);
  return `<div class="pc-cat" data-champ="${esc(c.name)}" data-type="categorie" data-valeur="${esc(v || '')}">
    <div class="pc-cat-choisie" ${choisie ? '' : 'hidden'}>${choisie ? `<strong>${esc(pcNomCategorie(choisie))}</strong>
      <div class="muted">${esc(choisie.chemin)} · activité ${esc(PC_FORMES_EXERCICE[choisie.forme] || choisie.forme)}</div>` : ''}</div>
    <input class="pc-cat-q" placeholder="${choisie ? 'Changer : ' : ''}conseil, holding, restauration, location…" autocomplete="off">
    <div class="pc-cat-res"></div>
  </div>`;
}

const PC_MOTS_VIDES = new Set(['dans', 'pour', 'avec', 'sans', 'tous', 'toutes', 'autres', 'autre', 'activite', 'activites', 'societe', 'entreprises', 'entreprise', 'service', 'services', 'general', 'generale', 'ainsi', 'ceux', 'celles']);

/* Mots courants des cabinets que la nomenclature exprime autrement. */
const PC_SYNONYMES = { holding: ['siege'], strategie: ['affaire'], management: ['affaire'], organisation: ['affaire'], restaurant: ['restauration'], informatique: ['programmation'] };

/** Catégories proches d'un texte libre (l'activité exercée) : au moins un mot en commun, les plus riches d'abord. */
function pcSuggererCategories(texte) {
  const base = [...new Set(pcSansAccent(texte).split(/[^a-z]+/).filter((m) => m.length > 3 && !PC_MOTS_VIDES.has(m)))]
    .map((m) => m.replace(/s$/, ''));
  const mots = [...new Set([...base, ...base.flatMap((m) => PC_SYNONYMES[m] || [])])];
  if (!mots.length) return [];
  return (pcRef?.categories || [])
    .map((c) => {
      const niveaux = c.chemin.split(' › ');
      const proche = pcSansAccent(niveaux.slice(-2).join(' '));
      const score = mots.reduce((n, m) => n + (proche.includes(m) ? 2 : pcSansAccent(c.chemin).includes(m) ? 0.5 : 0), 0);
      return { c, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.c.chemin.length - b.c.chemin.length)
    .slice(0, 6)
    .map((x) => x.c);
}

/** Intitulé lisible : une feuille trop vague (« Commerciale », « A titre indépendant ») garde son parent. */
function pcNomCategorie(c) {
  const n = c.chemin.split(' › ');
  const feuille = n[n.length - 1];
  return n.length > 2 && (feuille.length < 25 || /^(a titre|proposant|secteur)/i.test(feuille)) ? `${n[n.length - 2]} — ${feuille}` : feuille;
}

function pcBoutonsCategories(liste) {
  return liste.map((c) => `<button type="button" data-code="${esc(c.code)}"><strong>${esc(pcNomCategorie(c))}</strong>
      <span class="muted">${esc(c.chemin.split(' › ').slice(0, -1).join(' › '))} · ${esc(PC_FORMES_EXERCICE[c.forme] || c.forme)}</span></button>`).join('');
}

/** Affiche une liste de catégories dans le bloc et branche le choix. */
function pcProposerCategories($cat, liste, titre = '') {
  const $res = $cat.querySelector('.pc-cat-res');
  $res.innerHTML = (liste.length && titre ? `<div class="muted pc-cat-titre">${esc(titre)}</div>` : '') + pcBoutonsCategories(liste);
  $res.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      $cat.dataset.valeur = b.dataset.code;
      const c = pcRef.categories.find((x) => x.code === b.dataset.code);
      const $ch = $cat.querySelector('.pc-cat-choisie');
      $ch.innerHTML = `<strong>${esc(pcNomCategorie(c))}</strong><div class="muted">${esc(c.chemin)} · activité ${esc(PC_FORMES_EXERCICE[c.forme] || c.forme)}</div>`;
      $ch.hidden = false; $cat.querySelector('.pc-cat-q').value = ''; $res.innerHTML = '';
    };
  });
}

/** Sans catégorie choisie, propose celles qui collent à l'activité exercée. */
function pcSuggestionsActivite($groupe) {
  const $cat = $groupe?.querySelector('.pc-cat');
  if (!$cat || $cat.dataset.valeur || $cat.querySelector('.pc-cat-q').value.trim()) return;
  const texte = $groupe.querySelector('[data-champ="activite_principale"]')?.value || '';
  pcProposerCategories($cat, pcSuggererCategories(texte), 'D’après l’activité exercée :');
}

/**
 * Recherche dans la nomenclature : tous les mots doivent figurer dans le
 * chemin ; on classe d'abord ce qui les porte dans l'intitulé lui-même (et son
 * niveau parent), puis les intitulés courts.
 */
function pcChercherCategories(q) {
  const mots = pcSansAccent(q).split(/\s+/).filter((m) => m.length > 1);
  if (!mots.length) return [];
  return (pcRef?.categories || [])
    .map((c) => {
      const t = pcSansAccent(c.chemin);
      if (!mots.every((m) => t.includes(m))) return null;
      const niveaux = c.chemin.split(' › ');
      const proche = pcSansAccent(niveaux.slice(-2).join(' '));
      const feuille = pcSansAccent(niveaux[niveaux.length - 1]);
      const score = mots.reduce((n, m) => n + (feuille.includes(m) ? 3 : proche.includes(m) ? 2 : 0)
        + (new RegExp(`(^|[^a-z])${m}`).test(proche) ? 1 : 0), 0);
      return { c, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.c.chemin.length - b.c.chemin.length)
    .slice(0, 12)
    .map((x) => x.c);
}

/* ------------------------- bénéficiaires effectifs : une ligne par personne */

const PC_MODALITES = [
  ['3', 'Plus de 25 % du capital'], ['1', 'Plus de 25 % des droits de vote'],
  ['5', 'Pouvoir de nommer ou révoquer la majorité des dirigeants'], ['6', 'Autre moyen de contrôle'],
  ['0', 'Représentant légal, à défaut d’autre bénéficiaire'],
];

function pcBeneficiaires(c, v) {
  const liste = Array.isArray(v) && v.length ? v : [];
  return `<div class="pc-be" data-champ="${esc(c.name)}" data-type="beneficiaires">
    <div class="pc-be-lignes">${liste.map(pcBeneficiaire).join('')}</div>
    <div class="pc-liste-actions">
      ${(c.suggestions || []).filter((n) => !liste.some((b) => pcSansAccent(`${b.prenoms || ''} ${b.nom || ''}`).includes(pcSansAccent(n.split(' ').pop())))).map((n) => `<button type="button" class="btn-ghost pc-be-reprendre" data-nom="${esc(n)}">+ ${esc(n)} (dirigeant)</button>`).join('')}
      <button type="button" class="btn-ghost pc-be-ajouter">+ Autre bénéficiaire</button>
    </div>
  </div>`;
}

function pcBeneficiaire(b = {}) {
  const m = new Set([].concat(b.modalites || []).map(String));
  return `<div class="pc-be-ligne pc-sous">
    <div class="pc-be-tete"><strong>${esc(`${b.prenoms || ''} ${b.nom || ''}`.trim() || 'Nouveau bénéficiaire')}</strong><button type="button" class="btn-ghost pc-be-retirer" title="Retirer">×</button></div>
    ${pcPersonne(b, '', { sans_qualite: true }).replace(/<label class="field">Affiliation sociale[\s\S]*?<\/label>/, '').replace(/<label class="field">N° de sécurité sociale[\s\S]*?<\/label>/, '')}
    <div class="pc-sous-titre">Contrôle exercé</div>
    <div class="pc-be-modalites">${PC_MODALITES.map(([code, l]) => `<label><input type="checkbox" class="pc-be-modalite" value="${code}" ${m.has(code) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>
    <div class="row">${pcIn('pourcentage_capital', '% du capital', b.pourcentage_capital, 'type="number" step="0.01" min="0" max="100"')}
      ${pcIn('pourcentage_votes', '% des droits de vote', b.pourcentage_votes, 'type="number" step="0.01" min="0" max="100"')}
      ${pcSelect('detention', 'Détention', b.detention || 'directe', [['directe', 'Directe'], ['indirecte', 'Indirecte (par une société)'], ['les_deux', 'Directe et indirecte']])}</div>
  </div>`;
}

/** Lit un bloc de sous-champs `data-k` (chemins « a.b.c ») en objet. */
function pcLireSous($bloc) {
  const o = {};
  $bloc.querySelectorAll('[data-k]').forEach(($i) => {
    if ($i.closest('.pc-be-ligne') && !$bloc.classList.contains('pc-be-ligne')) return;
    const v = $i.value.trim();
    if (!v) return;
    const parts = $i.dataset.k.split('.');
    let cible = o;
    parts.slice(0, -1).forEach((p) => { cible[p] = cible[p] || {}; cible = cible[p]; });
    cible[parts[parts.length - 1]] = v;
  });
  return o;
}

function pcLireChamp($f) {
  const type = $f.dataset.type;
  if (type === 'ouinon') return $f.dataset.valeur === 'true' ? true : $f.dataset.valeur === 'false' ? false : null;
  if (type === 'categorie') return $f.dataset.valeur || null;
  if (type === 'beneficiaires') {
    return [...$f.querySelectorAll('.pc-be-ligne')].map(($l) => ({
      ...pcLireSous($l),
      modalites: [...$l.querySelectorAll('.pc-be-modalite:checked')].map((x) => x.value),
    })).filter((b) => b.nom);
  }
  if (['adresse', 'personne', 'personne_morale'].includes(type)) return pcLireSous($f);
  return $f.value === '' ? null : $f.value;
}

/* ------------------------------------------- recherches : adresse, commune */

let pcMinuteur = null;
function pcDiffere(fn) { clearTimeout(pcMinuteur); pcMinuteur = setTimeout(fn, 280); }

function pcSuggestions($zone, items, choisir) {
  $zone.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}">${esc(it.label)}</button>`).join('');
  $zone.hidden = !items.length;
  $zone.querySelectorAll('button').forEach((b) => { b.onclick = () => { choisir(items[Number(b.dataset.i)]); $zone.hidden = true; }; });
}

/** Type de voie au référentiel du guichet (« Rue » → RUE, « Avenue » → AV). */
function pcTypeVoie(rue) {
  const premier = pcSansAccent(String(rue || '').split(/\s+/)[0]).toUpperCase();
  const t = (pcRef?.types_voie || []).find(([code, l]) => pcSansAccent(l).toUpperCase() === premier || code === premier);
  return t ? { typeVoie: t[0], voie: String(rue).split(/\s+/).slice(1).join(' ') } : { typeVoie: '', voie: rue };
}

document.addEventListener('input', (e) => {
  const $q = e.target;
  if ($q.classList.contains('pc-adr-q')) {
    const $zone = $q.nextElementSibling;
    const bloc = $q.closest('.pc-adr');
    pcDiffere(async () => {
      if ($q.value.trim().length < 4) { $zone.hidden = true; return; }
      try {
        const r = await fetch(`https://data.geopf.fr/geocodage/search?q=${encodeURIComponent($q.value)}&limit=6`).then((x) => x.json());
        pcSuggestions($zone, (r.features || []).map((f) => ({ label: f.properties.label, p: f.properties })), ({ p }) => {
          const { prefixe } = bloc.dataset;
          const set = (k, v) => { const $i = bloc.querySelector(`[data-k="${prefixe}${k}"]`); if ($i) $i.value = v || ''; };
          const voie = pcTypeVoie(p.street || p.name);
          set('numVoie', p.housenumber); set('typeVoie', voie.typeVoie); set('voie', voie.voie);
          set('codePostal', p.postcode); set('commune', p.city); set('codeInseeCommune', p.citycode);
        });
      } catch { $zone.hidden = true; }
    });
  }
  if ($q.classList.contains('pc-commune-q')) {
    const $zone = $q.nextElementSibling;
    const $insee = $q.closest('.row').querySelector('.pc-insee');
    pcDiffere(async () => {
      if ($q.value.trim().length < 2) { $zone.hidden = true; return; }
      try {
        const r = await fetch(`https://geo.api.gouv.fr/communes?nom=${encodeURIComponent($q.value)}&fields=nom,code,departement&boost=population&limit=6`).then((x) => x.json());
        pcSuggestions($zone, r.map((c) => ({ label: `${c.nom} (${c.departement?.code || ''})`, c })), ({ c }) => { $q.value = c.nom; if ($insee) $insee.value = c.code; });
      } catch { $zone.hidden = true; }
    });
  }
  if ($q.classList.contains('pc-cat-q')) {
    const $cat = $q.closest('.pc-cat');
    if (!$q.value.trim()) { pcSuggestionsActivite($cat.closest('.pc-groupe')); return; }
    const res = pcChercherCategories($q.value);
    pcProposerCategories($cat, res);
    if (!res.length && $q.value.trim().length > 2) {
      $cat.querySelector('.pc-cat-res').innerHTML = '<div class="muted">Aucune catégorie : essayez un autre mot (ex. « conseil », « immobilier », « commerce »).</div>';
    }
  }
  if ($q.dataset?.champ === 'activite_principale') pcDiffere(() => pcSuggestionsActivite($q.closest('.pc-groupe')));
});

document.addEventListener('change', (e) => {
  if (e.target.dataset?.k === 'forme_sociale') {
    const $tns = e.target.closest('.pc-sous')?.querySelector('.pc-tns');
    if ($tns) $tns.hidden = e.target.value !== '3';
  }
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('.pc-champ .segments button');
  if (b) {
    const $s = b.closest('.segments');
    $s.dataset.valeur = b.dataset.v;
    $s.querySelectorAll('button').forEach((x) => x.classList.toggle('actif', x === b));
    return;
  }
  const $be = e.target.closest('.pc-be');
  if (!$be) return;
  if (e.target.closest('.pc-be-retirer')) { e.target.closest('.pc-be-ligne').remove(); return; }
  if (e.target.closest('.pc-be-ajouter')) { $be.querySelector('.pc-be-lignes').insertAdjacentHTML('beforeend', pcBeneficiaire({})); return; }
  const rep = e.target.closest('.pc-be-reprendre');
  if (rep) {
    // Reprend l'identité déjà saisie pour ce dirigeant, s'il y en a une.
    const groupe = pcDossier.champs.find((g) => g.op === 'c_dirigeants');
    const dirigeant = groupe?.champs.find((c) => c.label.startsWith(`${rep.dataset.nom} —`))?.valeur || {};
    const base = dirigeant.nom ? { ...dirigeant } : { nom: rep.dataset.nom };
    delete base.forme_sociale; delete base.numero_secu; delete base.situation_matrimoniale;
    $be.querySelector('.pc-be-lignes').insertAdjacentHTML('beforeend', pcBeneficiaire({ ...base, modalites: [] }));
    rep.remove();
  }
});

/* ---------------------------------------------- étape 4 : vérifier, déposer */

function pcDepot() {
  const d = pcDossier;
  const e = d.etat;
  const $c = document.getElementById('pc-contenu');
  if (d.inpi_id) {
    $c.innerHTML = `<div class="pc-bloc"><h2>Dossier déposé ${d.simule ? '<span class="badge">simulation</span>' : ''}</h2>
      <p>Liasse ${esc(d.numero_liasse || d.inpi_id)}${d.montant ? ` · ${eur.format(d.montant)}` : ''}. La suite (signature, paiement, suivi) se gère depuis le <a href="#/formalites">tableau des formalités</a>.</p></div>`;
    return;
  }
  const ligne = (ok, texte, aller) => `<li class="${ok ? 'ok' : ''}"><span>${ok ? '✓' : '•'}</span> ${texte}${!ok && aller ? ` <button class="lien" data-aller="${aller}">compléter</button>` : ''}</li>`;
  $c.innerHTML = `<div class="pc-bloc">
    <h2>Avant de déposer</h2>
    <ul class="pc-check">
      ${ligne(!e.questions_restantes, e.questions_restantes ? `${e.questions_restantes} question(s) sur votre situation sans réponse` : 'Situation renseignée', 'situation')}
      ${ligne(!e.pieces_a_preciser, e.pieces_a_preciser ? `${e.pieces_a_preciser} pièce(s) à préciser` : 'Toutes les pièces sont qualifiées', 'pieces')}
      ${ligne(!e.pieces_manquantes.length, e.pieces_manquantes.length ? `Pièces manquantes : ${e.pieces_manquantes.map(esc).join(', ')}` : 'Toutes les pièces obligatoires sont chargées', 'pieces')}
      ${ligne(!e.provisoires, e.provisoires ? `${e.provisoires} pièce(s) encore en version provisoire` : 'Aucune pièce provisoire', 'pieces')}
      ${ligne(!e.champs_manquants.length, e.champs_manquants.length ? `Informations à compléter : ${e.champs_manquants.map(esc).join(' ; ')}` : 'Informations complètes', 'informations')}
      ${e.a_signer ? `<li><span>!</span> ${e.a_signer} pièce(s) marquée(s) « à faire signer » : vérifiez qu’elles sont signées.</li>` : ''}
      ${d.incompatibilites.map((x) => `<li><span>•</span> ${esc(x)}</li>`).join('')}
      ${e.non_deposables.length ? `<li><span>•</span> Dépôt automatique pas encore disponible pour : ${esc(e.non_deposables.join(', '))}. Le dossier (pièces et informations) reste prêt à être finalisé sur le portail de l’INPI.</li>` : ''}
    </ul>
    <div class="pc-pied-actions">
      <button class="btn btn-primary" id="pc-deposer" ${e.pret ? '' : 'disabled'}>Déposer au guichet unique</button>
      <span class="muted">${e.pret ? 'Une seule formalité regroupera toutes les opérations.' : ''}</span>
    </div>
    <div id="pc-refus"></div>
  </div>`;
  pcAllerVers($c);
  document.getElementById('pc-deposer').onclick = async () => {
    const $b = document.getElementById('pc-deposer');
    $b.disabled = true; $b.textContent = 'Dépôt en cours…';
    try {
      pcDossier = await apiParcours('POST', `/parcours/${d.id}/deposer`);
      toast('Dossier déposé.');
      pcAfficher();
    } catch (err) {
      $b.disabled = false; $b.textContent = 'Déposer au guichet unique';
      document.getElementById('pc-refus').innerHTML = `<div class="alerte alerte-bloquant"><strong>${esc(err.message)}</strong>
        ${err.violations?.length ? `<ul>${err.violations.map((v) => `<li>${esc(pcChampLisible(v.champ))} : ${esc(v.message)}</li>`).join('')}</ul>
        <p>Les données du registre en cause ont été ajoutées à l’étape « Informations ».</p>` : ''}</div>`;
      pcDossier = await apiParcours('GET', `/parcours/${d.id}`);
    }
  };
}

/** Rend lisible un chemin de champ du guichet. */
function pcChampLisible(chemin) {
  return String(chemin || '')
    .replace(/^content\.personneMorale\./, '')
    .replace(/composition\.pouvoirs\[(\d+)\]/, (_, i) => `dirigeant n° ${Number(i) + 1}`)
    .replace(/identite\.description\./, 'description de la société : ')
    .replace(/\./g, ' › ');
}

routes.unshift(
  { re: /^\/parcours\/nouveau(?:\?(.*))?$/, view: vueParcoursNouveau, nav: 'formalites' },
  { re: /^\/parcours\/(\d+)$/, view: vueParcours, nav: 'formalites' },
);
