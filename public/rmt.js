/* =========================================================================
   Registre des mouvements de titres — écran de tenue.

   Le registre papier se tient au crayon : on écrit, on rature, on insère, on
   déplace. L'écran doit permettre la même chose sans jamais bloquer la
   saisie, et montrer en permanence ce qui est déjà passé à l'encre.
   ========================================================================= */

const RMT_STATUTS = {
  CRAYON: { libelle: 'Crayon', classe: 'crayon', icone: '✎' },
  ENCRE: { libelle: 'Encre', classe: 'encre', icone: '✒' },
  ENCRE_MODIFIEE: { libelle: 'Encre modifiée', classe: 'encre-modifiee', icone: '⚠' },
  ENCRE_SUPPRIMEE: { libelle: 'Encre supprimée', classe: 'encre-supprimee', icone: '✕' },
};

const RMT_MOTIFS = [
  ['erreur_saisie', 'Erreur de saisie'],
  ['acte_rectificatif', 'Acte rectificatif'],
  ['ordre_annule', 'Ordre de mouvement annulé'],
  ['decision_rectifiee', 'Décision sociale rectifiée'],
  ['autre', 'Autre motif'],
];

let rmtEtat = { societeId: null, donnees: null, lignes: [], anomalies: null, historique: false };
let rmtDlg = null;

/** Enveloppe la fenêtre modale de l'application, pour n'en avoir qu'une seule. */
function dialogue(titre, html) {
  openDialog(`<h3>${esc(titre)}</h3>${html}`, null, (dlg) => {
    rmtDlg = dlg;
    dlg.querySelectorAll('[data-fermer]').forEach((b) => { b.onclick = () => dlg.close(); });
  });
}

function fermerDialogue() {
  if (rmtDlg) { rmtDlg.close(); rmtDlg = null; }
}

/* ------------------------------------------------------------------ écran */

async function rmtRegistre(societeId) {
  rmtEtat.societeId = Number(societeId);
  const donnees = await api('GET', `/rmt/societes/${societeId}`);

  if (!donnees.actif) return rmtEcranOuverture(donnees);

  const [lignes, anomalies] = await Promise.all([
    api('GET', `/rmt/societes/${societeId}/mouvements${rmtEtat.historique ? '?historique=1' : ''}`),
    api('GET', `/rmt/societes/${societeId}/anomalies`),
  ]);
  rmtEtat = { ...rmtEtat, donnees, lignes, anomalies };

  setTimeout(rmtBrancher, 0);
  return `
    ${rmtEntete(donnees)}
    ${rmtEncartCapital(donnees.capital, anomalies)}
    <div class="grid cols-3-1">
      <div>${rmtTableau(lignes, donnees)}</div>
      <div>${rmtPanneauAnomalies(anomalies)}${rmtPanneauExtraits(donnees.extraits)}</div>
    </div>`;
}

/** Une société hors périmètre doit l'apprendre avant de saisir, pas après. */
function rmtEcranOuverture(donnees) {
  const forme = (donnees.societe.forme_sociale || '').toUpperCase();
  const admise = ['SA', 'SAS', 'SASU', 'SCA'].some((f) => forme.includes(f));
  setTimeout(() => {
    const b = document.getElementById('rmt-ouvrir');
    if (b) b.onclick = async () => {
      b.disabled = true;
      try {
        await api('POST', `/rmt/societes/${rmtEtat.societeId}/activer`, {
          forme, titres_numerotes: document.getElementById('rmt-numerotes')?.checked || false,
          nominal: Number(document.getElementById('rmt-nominal')?.value) || null,
        });
        render();
      } catch (e) { toast(e.message, true); b.disabled = false; }
    };
  }, 0);

  return `<h1 class="titre-page">Registre des mouvements de titres</h1>
    <div class="card">
      <h2>${esc(donnees.societe.denomination)}</h2>
      ${admise ? `
        <p class="muted mb">Aucun registre n'est encore ouvert pour cette société.</p>
        <div class="row">
          <label class="field">Valeur nominale (€)<input id="rmt-nominal" type="number" step="0.000001" placeholder="10"></label>
          <label class="field"><input type="checkbox" id="rmt-numerotes"> Les titres sont numérotés</label>
        </div>
        <button id="rmt-ouvrir" class="btn-primary">Ouvrir le registre</button>
      ` : `
        <div class="alerte alerte-bloquant">
          <strong>Forme juridique hors périmètre</strong>
          <p>Le registre des mouvements de titres ne concerne que les sociétés par actions
          — SA, SAS, SASU, SCA. Les parts sociales de SARL, SNC ou société civile ne se
          tiennent pas en comptes de titres : un registre les concernant serait faux.</p>
          <p class="muted">Forme enregistrée : ${esc(donnees.societe.forme_sociale || 'non renseignée')}.</p>
        </div>`}
    </div>`;
}

function rmtEntete(d) {
  const n = { crayon: 0, encre: 0, modifiee: 0 };
  for (const l of rmtEtat.lignes) {
    if (l.statut === 'CRAYON') n.crayon += 1;
    else if (l.statut === 'ENCRE') n.encre += 1;
    else n.modifiee += 1;
  }
  return `<div class="entete-vue">
      <div>
        <h1 class="titre-page">${esc(d.societe.denomination)} — registre des titres</h1>
        <p class="muted">${n.crayon} au crayon · ${n.encre} à l'encre${n.modifiee ? ` · <strong class="txt-alerte">${n.modifiee} modifiée(s) après certification</strong>` : ''}</p>
      </div>
      <div class="actions-vue">
        <label class="bascule-requis"><input type="checkbox" id="rmt-historique" ${rmtEtat.historique ? 'checked' : ''}> Afficher l'historique</label>
        <button id="rmt-certifier" class="btn-gold">Certifier un extrait</button>
      </div>
    </div>
    <p class="mention-registre">Registre de travail — ne constitue pas le registre légal de la société.</p>`;
}

/* ------------------------------------------------------ encart du capital */

function rmtEncartCapital(cap, anomalies) {
  if (!cap) return '';
  const ecart = Number(cap.ecart_capital || 0) !== 0 || Number(cap.ecart_titres || 0) !== 0;
  return `<div class="card carte-capital ${ecart ? 'en-ecart' : ''}">
      <div class="capital-grille">
        <div><span class="etiquette">Capital — fiche société</span>
          <strong>${cap.capital_fiche != null ? fmtEuro(cap.capital_fiche) : '—'}</strong></div>
        <div><span class="etiquette">Capital — calculé par le registre</span>
          <strong>${cap.capital_calcule != null ? fmtEuro(cap.capital_calcule) : '<em class="muted">nominal indéterminé</em>'}</strong></div>
        <div><span class="etiquette">Titres — fiche / émis / détenus</span>
          <strong>${cap.titres_fiche ?? '—'} / ${cap.titres_emis} / ${cap.titres_detenus}</strong></div>
        <div class="capital-ecart">
          ${ecart
    ? `<span class="badge alerte">Écart de ${fmtEuro(cap.ecart_capital || 0)} et ${cap.ecart_titres ?? 0} titre(s)</span>
               <div class="capital-actions">
                 <button class="btn-ghost" id="rmt-aligner-fiche">Aligner la fiche sur le registre</button>
                 <button class="btn-ghost" id="rmt-corriger-registre">Corriger le registre</button>
               </div>`
    : '<span class="badge ok">Fiche et registre concordent</span>'}
        </div>
      </div>
    </div>`;
}

function fmtEuro(v) {
  const n = Number(v || 0);
  return `${n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;
}

/* --------------------------------------------------------------- tableau */

function rmtTableau(lignes, d) {
  const comptes = new Map(d.comptes.map((c) => [c.id, c]));
  const nomCompte = (id) => {
    const c = comptes.get(id);
    if (!c) return '<span class="muted">—</span>';
    const noms = (c.titulaires || []).map((t) => t.denomination || [t.prenoms, t.nom].filter(Boolean).join(' '));
    return `<span title="${esc(noms.join(', '))}">${esc(c.numero)}</span>`;
  };

  return `<div class="card">
    <div class="entete-carte">
      <h2>Écritures</h2>
      <button class="btn-primary" id="rmt-nouvelle">+ Nouvelle écriture</button>
    </div>
    <table class="table-registre">
      <thead><tr>
        <th>N°</th><th>Inscription</th><th>Effet</th><th>Nature</th>
        <th>Débité</th><th>Crédité</th><th class="num">Quantité</th><th class="num">Prix</th>
        <th>Statut</th><th></th>
      </tr></thead>
      <tbody>
        ${lignes.length ? lignes.map((l) => rmtLigne(l, nomCompte)).join('')
    : '<tr><td colspan="10" class="empty">Aucune écriture. Le registre est vierge.</td></tr>'}
      </tbody>
    </table>
  </div>`;
}

function rmtLigne(l, nomCompte) {
  const s = RMT_STATUTS[l.statut] || RMT_STATUTS.CRAYON;
  return `<tr class="ligne-registre ${l.supprimee ? 'supprimee' : ''}" data-mouvement="${l.mouvement_id}">
    <td class="num-ordre">${l.numero_affiche}</td>
    <td>${fmtDate(l.date_inscription)}</td>
    <td>${fmtDate(l.date_effet)}</td>
    <td>${esc(l.nature_libelle || '')}</td>
    <td>${nomCompte(l.compte_debite)}</td>
    <td>${nomCompte(l.compte_credite)}</td>
    <td class="num">${l.quantite ?? ''}</td>
    <td class="num">${l.prix_total != null ? fmtEuro(l.prix_total) : ''}</td>
    <td><span class="badge-statut ${s.classe}" title="${esc(s.libelle)}">${s.icone} ${esc(s.libelle)}</span></td>
    <td class="actions-ligne">
      <button class="lien-action" data-action="modifier">Modifier</button>
      <button class="lien-action" data-action="versions">Historique${l.nb_versions > 1 ? ` (${l.nb_versions})` : ''}</button>
      ${l.supprimee ? '' : '<button class="lien-action danger" data-action="supprimer">Supprimer</button>'}
    </td>
  </tr>`;
}

/* ------------------------------------------------------ panneaux latéraux */

function rmtPanneauAnomalies(a) {
  if (!a) return '';
  const bloc = (titre, items, classe) => (items.length ? `
    <div class="alerte alerte-${classe}">
      <strong>${titre}</strong>
      <ul class="liste-controles">${items.map((x) => `
        <li><button type="button" class="lien-controle" data-cible-mouvement="${x.mouvement_id || ''}">
          ${esc(x.message)}${x.acquittee ? ' <em class="muted">(acquittée)</em>' : ''}
          ${x.mouvement_id ? '<span class="fleche-controle">Voir</span>' : ''}
        </button>
        ${classe === 'alerte' && !x.acquittee && x.version_id
    ? `<button class="lien-action" data-acquitter="${x.code}" data-version="${x.version_id}" data-mouvement="${x.mouvement_id}">Acquitter</button>`
    : ''}</li>`).join('')}</ul>
    </div>` : '');

  return `<div class="card">
    <h2>Anomalies</h2>
    <p class="muted mb">La saisie reste libre. Seule la certification est refusée tant qu'un point bloquant subsiste.</p>
    ${bloc(`${a.bloquants.length} point(s) bloquant(s) pour la certification`, a.bloquants, 'bloquant')}
    ${bloc(`${a.alertes.length} point(s) à apprécier`, a.alertes, 'alerte')}
    ${a.certifiable ? '<div class="alerte alerte-ok"><strong>Registre cohérent</strong> — certification possible.</div>' : ''}
  </div>`;
}

function rmtPanneauExtraits(extraits) {
  return `<div class="card mt">
    <h2>Extraits certifiés</h2>
    ${extraits.length ? `<ul class="liste-extraits">${extraits.map((x) => `
      <li>
        <div><strong>${esc(x.reference)}</strong> <span class="badge-statut ${x.statut}">${esc({
    a_jour: 'À jour', devenu_inexact: 'Devenu inexact', revoque: 'Révoqué',
  }[x.statut])}</span></div>
        <div class="muted">${fmtDate(x.certifie_le)} · ${esc(x.certifiant_nom)}</div>
        <code class="empreinte">${esc(String(x.empreinte).slice(0, 16))}…</code>
      </li>`).join('')}</ul>`
    : '<p class="muted">Aucun extrait. Toutes les écritures sont au crayon.</p>'}
  </div>`;
}

/* ---------------------------------------------------------- interactions */

function rmtBrancher() {
  const $hist = document.getElementById('rmt-historique');
  if ($hist) $hist.onchange = () => { rmtEtat.historique = $hist.checked; render(); };

  const $nouv = document.getElementById('rmt-nouvelle');
  if ($nouv) $nouv.onclick = () => rmtFormulaire(null);

  document.querySelectorAll('.ligne-registre .lien-action').forEach((b) => {
    b.onclick = () => {
      const id = Number(b.closest('.ligne-registre').dataset.mouvement);
      if (b.dataset.action === 'modifier') rmtFormulaire(id);
      if (b.dataset.action === 'versions') rmtVersions(id);
      if (b.dataset.action === 'supprimer') rmtSupprimer(id);
    };
  });

  document.querySelectorAll('[data-cible-mouvement]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.cibleMouvement;
      if (!id) return;
      const ligne = document.querySelector(`.ligne-registre[data-mouvement="${id}"]`);
      if (!ligne) return;
      ligne.scrollIntoView({ behavior: 'smooth', block: 'center' });
      ligne.classList.add('surligne');
      setTimeout(() => ligne.classList.remove('surligne'), 1600);
    };
  });

  document.querySelectorAll('[data-acquitter]').forEach((b) => {
    b.onclick = async () => {
      const commentaire = prompt('Commentaire sur cet acquittement (facultatif) :') ?? '';
      try {
        await api('POST', `/rmt/societes/${rmtEtat.societeId}/alertes/acquitter`, {
          code: b.dataset.acquitter,
          version_id: Number(b.dataset.version),
          mouvement_id: Number(b.dataset.mouvement),
          commentaire,
        });
        toast('Alerte acquittée. L’acquittement est tracé.');
        render();
      } catch (e) { toast(e.message, true); }
    };
  });

  const $cert = document.getElementById('rmt-certifier');
  if ($cert) $cert.onclick = rmtCertifier;

  const $aligner = document.getElementById('rmt-aligner-fiche');
  if ($aligner) $aligner.onclick = async () => {
    try {
      await api('PUT', `/rmt/societes/${rmtEtat.societeId}/capital`, { sens: 'aligner_fiche' });
      toast('Fiche société alignée sur le registre.');
      render();
    } catch (e) { toast(e.message, true); }
  };

  const $corriger = document.getElementById('rmt-corriger-registre');
  if ($corriger) $corriger.onclick = () => rmtFormulaireEmission();
}

/** Formulaire d'écriture, en création comme en modification. */
async function rmtFormulaire(mouvementId) {
  const d = rmtEtat.donnees;
  const ligne = mouvementId ? rmtEtat.lignes.find((l) => l.mouvement_id === mouvementId) : null;
  let impact = { motif_requis: false, extraits: [] };
  if (mouvementId) {
    try { impact = await api('GET', `/rmt/mouvements/${mouvementId}/impact`); } catch { /* écran dégradé */ }
  }

  const options = (liste, valeur, cle = 'id', lib = 'libelle') => liste.map((o) =>
    `<option value="${o[cle]}" ${String(valeur) === String(o[cle]) ? 'selected' : ''}>${esc(o[lib])}</option>`).join('');
  const comptes = d.comptes.map((c) => ({ id: c.id, libelle: `${c.numero} — ${(c.titulaires || []).map((t) => t.denomination || [t.prenoms, t.nom].filter(Boolean).join(' ')).join(', ') || 'sans titulaire'}` }));
  const natures = Object.entries(d.natures).map(([k, v]) => ({ id: k, libelle: v.libelle }));

  dialogue(`${mouvementId ? 'Modifier' : 'Nouvelle'} écriture`, `
    ${impact.motif_requis ? `
      <div class="alerte alerte-alerte">
        <strong>Écriture déjà certifiée</strong>
        <p>Elle est couverte par ${impact.extraits.length} extrait(s) certifié(s). La modifier les rendra
        « devenus inexacts ». Un motif est obligatoire.</p>
        <ul>${impact.extraits.map((x) => `<li>${esc(x.reference)} du ${fmtDate(x.certifie_le)}${
    x.destinataires?.length ? ` — remis à ${esc(x.destinataires.map((r) => r.nom).join(', '))}` : ''}</li>`).join('')}</ul>
      </div>` : ''}
    <form id="rmt-form">
      <div class="row">
        <label class="field">Date d'inscription<input type="date" name="date_inscription" value="${ligne?.date_inscription || ''}"></label>
        <label class="field">Date d'effet<input type="date" name="date_effet" value="${ligne?.date_effet || ''}"></label>
        <label class="field">Nature<select name="nature">${options(natures, ligne?.nature)}</select></label>
      </div>
      <div class="row">
        <label class="field">Catégorie<select name="categorie_id">${options(d.categories, ligne?.categorie_id, 'id', 'libelle')}</select></label>
        <label class="field">Quantité<input type="number" name="quantite" value="${ligne?.quantite ?? ''}"></label>
        <label class="field">Numéros de titres<input name="numeros" value="${esc(ligne?.numeros || '')}" placeholder="{[1,100]}"></label>
      </div>
      <div class="row">
        <label class="field">Compte débité<select name="compte_debite"><option value="">—</option>${options(comptes, ligne?.compte_debite)}</select></label>
        <label class="field">Compte crédité<select name="compte_credite"><option value="">—</option>${options(comptes, ligne?.compte_credite)}</select></label>
      </div>
      <div class="row">
        <label class="field">Prix unitaire<input type="number" step="0.000001" name="prix_unitaire" value="${ligne?.prix_unitaire ?? ''}"></label>
        <label class="field">Prix total<input type="number" step="0.01" name="prix_total" value="${ligne?.prix_total ?? ''}"></label>
      </div>
      <label class="field">Observations<textarea name="observations">${esc(ligne?.observations || '')}</textarea></label>
      ${impact.motif_requis ? `
        <div class="row">
          <label class="field">Motif<select name="motif_code">${RMT_MOTIFS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
          <label class="field">Précision<input name="motif" required placeholder="Obligatoire"></label>
        </div>` : ''}
      <div class="dialog-actions">
        <button type="button" class="btn-ghost" data-fermer>Annuler</button>
        <button type="submit" class="btn-primary">${mouvementId ? 'Enregistrer la modification' : 'Inscrire au registre'}</button>
      </div>
    </form>`);

  document.getElementById('rmt-form').onsubmit = async (e) => {
    e.preventDefault();
    const corps = Object.fromEntries(new FormData(e.target));
    for (const cle of ['quantite', 'categorie_id', 'compte_debite', 'compte_credite', 'prix_unitaire', 'prix_total']) {
      corps[cle] = corps[cle] === '' ? null : Number(corps[cle]);
    }
    if (!corps.numeros) corps.numeros = null;
    try {
      if (mouvementId) {
        const r = await api('PUT', `/rmt/mouvements/${mouvementId}`, corps);
        toast(r.extraits_devenus_inexacts?.length
          ? `Modification enregistrée. ${r.extraits_devenus_inexacts.length} extrait(s) devenu(s) inexact(s).`
          : 'Modification enregistrée.');
      } else {
        await api('POST', `/rmt/societes/${rmtEtat.societeId}/mouvements`, corps);
        toast('Écriture inscrite au registre.');
      }
      fermerDialogue();
      render();
    } catch (err) { toast(err.message, true); }
  };
}

/** Saisie d'une décision de capital, pour corriger le registre côté émissions. */
function rmtFormulaireEmission() {
  const d = rmtEtat.donnees;
  dialogue('Décision modifiant le capital', `
    <p class="muted mb">Le nombre de titres émis découle des décisions sociales. Ajouter la décision
    manquante corrige le registre sans toucher à la fiche société.</p>
    <form id="rmt-form-emission">
      <div class="row">
        <label class="field">Catégorie<select name="categorie_id">${d.categories.map((c) =>
    `<option value="${c.id}">${esc(c.libelle)}</option>`).join('')}</select></label>
        <label class="field">Variation du nombre de titres<input type="number" name="quantite" required placeholder="+1000 ou -500"></label>
        <label class="field">Date d'effet<input type="date" name="date_effet" required></label>
      </div>
      <label class="field">Décision<input name="decision" required placeholder="AGE du 12/03/2026 — augmentation de capital"></label>
      <div class="dialog-actions">
        <button type="button" class="btn-ghost" data-fermer>Annuler</button>
        <button type="submit" class="btn-primary">Enregistrer la décision</button>
      </div>
    </form>`);

  document.getElementById('rmt-form-emission').onsubmit = async (e) => {
    e.preventDefault();
    const corps = Object.fromEntries(new FormData(e.target));
    corps.categorie_id = Number(corps.categorie_id);
    corps.quantite = Number(corps.quantite);
    try {
      await api('POST', `/rmt/societes/${rmtEtat.societeId}/emissions`, corps);
      toast('Décision enregistrée.');
      fermerDialogue();
      render();
    } catch (err) { toast(err.message, true); }
  };
}

async function rmtVersions(mouvementId) {
  const versions = await api('GET', `/rmt/mouvements/${mouvementId}/versions`);
  dialogue('Historique de l’écriture', `
    <p class="muted mb">Rien n'est jamais effacé : chaque intervention ajoute une version.</p>
    <ol class="liste-versions">
      ${versions.map((v) => `
        <li>
          <div class="version-entete">
            <strong>Version ${v.numero_version}</strong>
            <span class="badge">${esc(v.action)}</span>
            <span class="muted">${fmtDate(v.cree_le)}${v.auteur ? ` · ${esc([v.auteur.prenom, v.auteur.nom].filter(Boolean).join(' '))}` : ''}</span>
          </div>
          <div class="muted">${esc(v.nature_libelle || '')} · ${v.quantite ?? '—'} titre(s)${v.prix_total ? ` · ${fmtEuro(v.prix_total)}` : ''}</div>
          ${v.motif ? `<div class="version-motif">Motif : ${esc(v.motif)}</div>` : ''}
          ${v.numero_version < versions.length
    ? `<button class="lien-action" data-restaurer="${v.id}">Restaurer cette version</button>` : ''}
        </li>`).join('')}
    </ol>
    <div class="dialog-actions"><button type="button" class="btn-ghost" data-fermer>Fermer</button></div>`);

  document.querySelectorAll('[data-restaurer]').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('POST', `/rmt/mouvements/${mouvementId}/restaurer`, { version_id: Number(b.dataset.restaurer) });
        toast('Version restaurée — une nouvelle version a été créée, l’historique reste intact.');
        fermerDialogue();
        render();
      } catch (e) { toast(e.message, true); }
    };
  });
}

/** Suppression : directe au crayon, soumise à un associé à l'encre. */
async function rmtSupprimer(mouvementId) {
  const impact = await api('GET', `/rmt/mouvements/${mouvementId}/impact`);

  if (impact.statut === 'CRAYON') {
    if (!confirm('Supprimer cette écriture ? Elle restera consultable dans l’historique.')) return;
    try {
      await api('DELETE', `/rmt/mouvements/${mouvementId}`, {});
      toast('Écriture supprimée. Elle reste visible en mode historique.');
      render();
    } catch (e) { toast(e.message, true); }
    return;
  }

  dialogue('Demander la suppression', `
    <div class="alerte alerte-alerte">
      <strong>Écriture certifiée</strong>
      <p>Sa suppression demande l'approbation d'un associé. ${impact.extraits.length} extrait(s)
      deviendront inexacts.</p>
      <ul>${impact.extraits.map((x) => `<li>${esc(x.reference)}${
    x.destinataires?.length ? ` — remis à ${esc(x.destinataires.map((r) => r.nom).join(', '))}` : ''}</li>`).join('')}</ul>
    </div>
    <form id="rmt-form-suppression">
      <div class="row">
        <label class="field">Motif<select name="motif_code">${RMT_MOTIFS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
        <label class="field">Précision<input name="motif" required placeholder="Obligatoire"></label>
      </div>
      <div class="dialog-actions">
        <button type="button" class="btn-ghost" data-fermer>Annuler</button>
        <button type="submit" class="btn-primary">Soumettre à un associé</button>
      </div>
    </form>`);

  document.getElementById('rmt-form-suppression').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/rmt/mouvements/${mouvementId}/demande-suppression`,
        Object.fromEntries(new FormData(e.target)));
      toast('Demande enregistrée. Un associé doit l’approuver.');
      fermerDialogue();
      render();
    } catch (err) { toast(err.message, true); }
  };
}

async function rmtCertifier() {
  const apercu = await api('POST', `/rmt/societes/${rmtEtat.societeId}/extraits/previsualiser`,
    { type: 'registre_complet' });

  dialogue('Certifier un extrait', `
    ${apercu.certifiable
    ? `<div class="alerte alerte-ok"><strong>Registre cohérent</strong> — ${apercu.contenu.ecritures.length} écriture(s) passeront à l'encre.</div>`
    : `<div class="alerte alerte-bloquant"><strong>Certification impossible</strong>
         <p>La saisie reste libre, mais un extrait ne peut pas certifier un état incohérent.</p>
         <ul>${apercu.bloquants.map((b) => `<li>${esc(b.message)}</li>`).join('')}</ul></div>`}
    <form id="rmt-form-certif">
      <label class="field">Type d'extrait
        <select name="type">
          <option value="registre_complet">Registre complet</option>
          <option value="table_capitalisation">Table de capitalisation</option>
        </select>
      </label>
      <label class="field">Destinataires déclarés (facultatif)
        <input name="destinataires" placeholder="Banque X, acquéreur Y — séparés par des virgules"></label>
      <p class="muted">${esc(apercu.contenu.mention_legale)}</p>
      <div class="dialog-actions">
        <button type="button" class="btn-ghost" data-fermer>Annuler</button>
        <button type="submit" class="btn-gold" ${apercu.certifiable ? '' : 'disabled'}>Certifier</button>
      </div>
    </form>`);

  document.getElementById('rmt-form-certif').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('POST', `/rmt/societes/${rmtEtat.societeId}/extraits`, {
        type: f.type,
        destinataires: String(f.destinataires || '').split(',').map((s) => s.trim()).filter(Boolean)
          .map((nom) => ({ nom })),
      });
      toast(`Extrait ${r.reference} certifié — ${r.ecritures_couvertes} écriture(s) passées à l'encre.`);
      fermerDialogue();
      render();
    } catch (err) { toast(err.message, true); }
  };
}

routes.push({ re: /^\/societes\/(\d+)\/registre$/, view: rmtRegistre, nav: 'societes' });
