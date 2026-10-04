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
  const opts = { method };
  if (body !== undefined && !isForm) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body); } else if (body !== undefined) opts.body = body;
  const res = await fetch(`/api${url}`, opts);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(json?.error || `Erreur ${res.status}`), { details: json?.details, violations: json?.violations });
  return json;
}

let pcDossier = null;
let pcEtape = null;

/* ------------------------------------------------------ nouveau dossier */

async function vueParcoursNouveau(query = '') {
  const [societes, operations] = await Promise.all([api('GET', '/societes'), apiParcours('GET', '/parcours/operations')]);
  const preselection = new Set((new URLSearchParams(query || '').get('ops') || '').split(',').filter(Boolean));
  const parCode = new Map(operations.map((o) => [o.code, o]));
  const groupes = (typeof MEMO_OPERATIONS !== 'undefined' ? MEMO_OPERATIONS : [{ groupe: 'Opérations', items: operations.map((o) => [o.code, o.nom]) }]);

  $main.innerHTML = `
    <div class="entete-vue"><div>
      <div class="crumb"><a href="#/formalites">Formalités</a> /</div>
      <h1 class="titre-page">Nouveau dossier</h1>
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
      <h2><span class="memo-num">2</span> Les opérations <span class="muted pc-compte" id="pc-compte"></span></h2>
      ${groupes.map((g) => `
        <div class="memo-groupe"><h3 class="pc-sous-titre">${esc(g.groupe)}</h3><div class="memo-tuiles">
          ${g.items.filter(([c]) => parCode.has(c)).map(([code, nom]) => `
            <label class="memo-tuile pc-tuile ${preselection.has(code) ? 'choisie' : ''}">
              <input type="checkbox" value="${esc(code)}" ${preselection.has(code) ? 'checked' : ''}>
              <span class="memo-tuile-nom">${esc(nom)}</span>
              <span class="memo-tuile-code">${esc(code)}${parCode.get(code).depot_automatique ? '' : ' · dépôt à finaliser sur le portail'}</span>
            </label>`).join('')}
        </div></div>`).join('')}
    </section>

    <div class="pc-pied-actions">
      <button class="btn btn-primary" id="pc-ouvrir">Ouvrir le dossier</button>
      <span class="muted" id="pc-msg"></span>
    </div>`;

  const compter = () => {
    const n = $main.querySelectorAll('.pc-tuile input:checked').length;
    document.getElementById('pc-compte').textContent = n ? `· ${n} choisie(s)` : '';
  };
  $main.querySelectorAll('.pc-tuile input').forEach((c) => {
    c.onchange = () => { c.closest('.pc-tuile').classList.toggle('choisie', c.checked); compter(); };
  });
  compter();
  document.getElementById('pc-ouvrir').onclick = async () => {
    const operations = [...$main.querySelectorAll('.pc-tuile input:checked')].map((c) => c.value);
    const societe_id = document.getElementById('pc-societe').value || null;
    const siren = document.getElementById('pc-siren').value.trim();
    const $msg = document.getElementById('pc-msg');
    if (!operations.length) { $msg.textContent = 'Choisissez au moins une opération.'; return; }
    $msg.textContent = 'Lecture de la fiche du registre…';
    try {
      const r = await apiParcours('POST', '/parcours', { societe_id, siren, operations });
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
  [pcDossier] = await Promise.all([apiParcours('GET', `/parcours/${id}`), getEtatInpi()]);
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
    </div>
    ${d.incompatibilites.length ? `<div class="alerte alerte-bloquant">${d.incompatibilites.map(esc).join('<br>')}</div>` : ''}
    <nav class="pc-etapes" role="tablist">
      ${PC_ETAPES.map(([nom, titre], i) => `<button role="tab" data-etape="${nom}" class="${pcEtape.nom === nom ? 'actif' : ''}">
        <span class="pc-etape-num">${i + 1}</span> ${titre} ${pcCompteur(nom, d)}</button>`).join('')}
    </nav>
    <div id="pc-contenu"></div>`;
  $main.querySelectorAll('.pc-etapes button').forEach((b) => {
    b.onclick = () => { pcEtape.nom = b.dataset.etape; pcAfficher(); };
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
  const pour = q.pour.length ? `<span class="pc-pour">${esc(q.pour.join(' · '))}</span>` : '';
  if (q.type === 'choix') {
    return `<div class="pc-question">
      <div class="pc-q-libelle">${esc(q.libelle)} ${pour}</div>
      ${q.aide ? `<div class="pc-aide muted">${esc(q.aide)}</div>` : ''}
      <div class="segments pc-choix">${q.options.map(([v, l]) => `<button type="button" data-choix="${q.id}" data-valeur="${esc(String(v))}"
        class="${q.valeur === v ? 'actif' : ''}">${esc(l)}</button>`).join('')}</div>
    </div>`;
  }
  const lignes = Array.isArray(q.valeur) && q.valeur.length ? q.valeur : [{}];
  return `<div class="pc-question">
    <div class="pc-q-libelle">${esc(q.libelle)} ${pour}</div>
    ${q.aide ? `<div class="pc-aide muted">${esc(q.aide)}</div>` : ''}
    <div class="pc-liste" data-type="${q.type}" data-question="${q.id}">
      ${q.type === 'sortants' && q.dirigeants_actuels?.length ? `<datalist id="pc-dirigeants">${q.dirigeants_actuels.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>` : ''}
      <div class="pc-lignes">${lignes.map((l) => pcLignePersonne(q, l)).join('')}</div>
      <div class="pc-liste-actions">
        <button type="button" class="btn-ghost pc-ajouter">+ Ajouter une personne</button>
        <button type="button" class="btn pc-enregistrer">Enregistrer</button>
        ${Array.isArray(q.valeur) ? '' : '<button type="button" class="btn-ghost pc-personne-aucune">Aucune</button>'}
      </div>
    </div>
  </div>`;
}

function pcLignePersonne(q, l) {
  if (q.type === 'sortants') {
    return `<div class="pc-ligne">
      <input class="pc-nom" placeholder="Nom de la personne qui part" value="${esc(l.nom || '')}" list="pc-dirigeants">
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
    <label class="pc-inscrit" ${l.fonction === 'cac' ? '' : 'hidden'}><input type="checkbox" class="pc-inscrit-case" ${l.inscrit === false ? '' : 'checked'}> déjà inscrit sur la liste des CAC</label>
    <button type="button" class="btn-ghost pc-retirer" title="Retirer">×</button>
  </div>`;
}

function pcListePersonnes($l) {
  const q = pcDossier.questions.find((x) => x.id === $l.dataset.question);
  const $lignes = $l.querySelector('.pc-lignes');
  const brancher = () => {
    $lignes.querySelectorAll('.pc-retirer').forEach((b) => { b.onclick = () => b.closest('.pc-ligne').remove(); });
    $lignes.querySelectorAll('.pc-fonction').forEach((s) => {
      s.onchange = () => { s.closest('.pc-ligne').querySelector('.pc-inscrit').hidden = s.value !== 'cac'; };
    });
  };
  brancher();
  $l.querySelector('.pc-ajouter').onclick = () => { $lignes.insertAdjacentHTML('beforeend', pcLignePersonne(q, {})); brancher(); };
  const aucune = $l.querySelector('.pc-personne-aucune');
  if (aucune) aucune.onclick = () => pcMaj('PUT', `/parcours/${pcDossier.id}/typologie`, { [q.id]: [] });
  $l.querySelector('.pc-enregistrer').onclick = () => {
    const valeurs = [...$lignes.querySelectorAll('.pc-ligne')].map((ligne) => {
      const nom = ligne.querySelector('.pc-nom').value.trim();
      if (!nom) return null;
      if (q.type === 'sortants') return { nom, motif: ligne.querySelector('.pc-motif').value };
      const fonction = ligne.querySelector('.pc-fonction').value;
      return {
        nom, nature: ligne.querySelector('.pc-nature').value, fonction,
        ...(fonction === 'cac' ? { inscrit: ligne.querySelector('.pc-inscrit-case').checked } : {}),
      };
    }).filter(Boolean);
    pcMaj('PUT', `/parcours/${pcDossier.id}/typologie`, { [q.id]: valeurs });
  };
}

function pcAllerVers($c) {
  $c.querySelectorAll('[data-aller]').forEach((b) => { b.onclick = () => { pcEtape.nom = b.dataset.aller; pcAfficher(); }; });
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
        form.append('code', ligne.dataset.code);
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
      : `<span class="pc-concerne">Concerné ? <button class="btn-ghost" data-concerne="oui" data-code="${esc(p.code)}">Oui</button><button class="btn-ghost" data-concerne="non" data-code="${esc(p.code)}">Non</button></span>`)
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
        <label class="pc-provisoire-l"><input type="checkbox" class="pc-provisoire"> provisoire</label>
        <label class="btn pc-bouton-charger">${fait ? 'Ajouter' : 'Charger'}<input type="file" accept="application/pdf,.pdf" class="pc-charger" multiple hidden></label>
      </div>` : ''}
    </div>
    ${p.fichiers.map((f) => pcFichier(f)).join('')}
  </div>`;
}

function pcFichier(f) {
  return `<div class="pc-fichier">
    <a href="/api/formalites/pieces/${f.id}/download" target="_blank" rel="noopener">${esc(f.nom)}</a>
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
    <div class="pc-pied-actions"><button class="btn btn-primary" data-aller="depot">Vérifier le dossier</button></div>`;
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
  $c.querySelectorAll('.pc-groupe').forEach(($g) => {
    $g.querySelector('.pc-enregistrer-groupe').onclick = () => {
      const valeurs = {};
      $g.querySelectorAll('[data-champ]').forEach(($f) => { valeurs[$f.dataset.champ] = pcLireChamp($f); });
      pcMaj('PUT', `/parcours/${d.id}/reponses`, { [$g.dataset.op]: valeurs });
    };
  });
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
    ${c.actuel ? `<div class="pc-actuel">Actuellement au registre : ${esc(c.actuel)}</div>` : ''}`;
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
    case 'adresse':
      return `<div class="pc-champ">${tete}<div class="pc-sous" ${attr}>${pcAdresse(v || {})}</div></div>`;
    case 'personne':
      return `<div class="pc-champ">${tete}<div class="pc-sous" ${attr}>${pcPersonne(v || {})}</div></div>`;
    case 'personne_morale':
      return `<div class="pc-champ">${tete}<div class="pc-sous" ${attr}>${pcPersonneMorale(v || {})}</div></div>`;
    default:
      return `<label class="pc-champ">${tete}<input ${attr} value="${esc(v || '')}"></label>`;
  }
}

const pcIn = (k, label, v, extra = '') => `<label class="field">${label}<input data-k="${k}" value="${esc(v || '')}" ${extra}></label>`;

function pcAdresse(a, prefixe = '') {
  return `<div class="row">${pcIn(`${prefixe}numVoie`, 'N°', a.numVoie, 'maxlength="6"')}${pcIn(`${prefixe}typeVoie`, 'Type de voie', a.typeVoie, 'placeholder="RUE, AV, BD…"')}${pcIn(`${prefixe}voie`, 'Voie', a.voie)}</div>
    <div class="row">${pcIn(`${prefixe}complementLocalisation`, 'Complément', a.complementLocalisation)}${pcIn(`${prefixe}codePostal`, 'Code postal', a.codePostal, 'maxlength="5"')}${pcIn(`${prefixe}commune`, 'Commune', a.commune)}</div>`;
}

function pcSelect(k, label, v, options) {
  return `<label class="field">${label}<select data-k="${k}"><option value=""></option>${options.map(([o, l]) => `<option value="${o}" ${String(v ?? '') === o ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`;
}

function pcPersonne(p) {
  return `<div class="row">${pcIn('nom', 'Nom', p.nom)}${pcIn('prenoms', 'Prénoms', Array.isArray(p.prenoms) ? p.prenoms.join(' ') : p.prenoms)}${pcIn('qualite', 'Fonction exacte', p.qualite, 'placeholder="Président, Directeur général…"')}</div>
    <div class="row">${pcSelect('genre', 'Sexe', p.genre, [['1', 'Masculin'], ['2', 'Féminin']])}${pcIn('date_naissance', 'Date de naissance', p.date_naissance, 'type="date"')}${pcIn('lieu_naissance', 'Commune de naissance', p.lieu_naissance)}${pcIn('code_insee_naissance', 'Code INSEE de la commune', p.code_insee_naissance, 'maxlength="5"')}</div>
    <div class="row">${pcIn('nationalite', 'Nationalité', p.nationalite || 'Française')}${pcSelect('forme_sociale', 'Affiliation sociale', p.forme_sociale, [['0', 'Non applicable'], ['1', 'Sans affiliation sociale'], ['3', 'Avec affiliation sociale']])}${pcSelect('situation_matrimoniale', 'Situation matrimoniale (gérant de SARL)', p.situation_matrimoniale, [['1', 'Célibataire'], ['4', 'Marié(e)'], ['5', 'Pacsé(e)'], ['6', 'En concubinage'], ['2', 'Divorcé(e)'], ['3', 'Veuf(ve)']])}</div>
    <div class="pc-sous-titre">Domicile</div>${pcAdresse(p.adresse || {}, 'adresse.')}`;
}

function pcPersonneMorale(p) {
  return `<div class="row">${pcIn('denomination', 'Dénomination', p.denomination || p.nom)}${pcIn('siren', 'SIREN', p.siren)}${pcIn('greffe', 'Greffe d’immatriculation', p.greffe)}</div>
    <div class="row">${pcIn('representant', 'Représentant permanent (le cas échéant)', p.representant)}</div>
    <div class="pc-sous-titre">Siège</div>${pcAdresse(p.adresse || {}, 'adresse.')}`;
}

function pcLireChamp($f) {
  const type = $f.dataset.type;
  if (type === 'ouinon') return $f.dataset.valeur === 'true' ? true : $f.dataset.valeur === 'false' ? false : null;
  if (['adresse', 'personne', 'personne_morale'].includes(type)) {
    const o = {};
    $f.querySelectorAll('[data-k]').forEach(($i) => {
      const v = $i.value.trim();
      if (!v) return;
      const parts = $i.dataset.k.split('.');
      if (parts.length === 2) { o[parts[0]] = o[parts[0]] || {}; o[parts[0]][parts[1]] = v; } else o[parts[0]] = v;
    });
    return o;
  }
  return $f.value === '' ? null : $f.value;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('.pc-champ .segments button');
  if (!b) return;
  const $s = b.closest('.segments');
  $s.dataset.valeur = b.dataset.v;
  $s.querySelectorAll('button').forEach((x) => x.classList.toggle('actif', x === b));
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
