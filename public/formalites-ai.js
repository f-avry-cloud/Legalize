'use strict';

/* =========================================================================
   Suivi Formalités AI — lecture seule.

   Les formalités menées par Claude via le connecteur « Guichet unique »
   (claude.ai, Claude Code, mobile) : où en est chaque dossier, les pièces
   reçues, ce qui a été déclaré, le journal. Rien ne s'y modifie ; le dossier
   se pilote dans la conversation avec Claude. Seule action : relire le statut
   auprès de l'INPI.
   ========================================================================= */

const FA_COULEURS = { gris: 'brouillon', bleu: 'genere', orange: 'envoye', rouge: 'a_faire', vert: 'finalise' };
const FA_ACTIONS = {
  deposer: 'À vous : vérifier, signer et payer sur le portail',
  signer: 'À vous : signer sur le portail',
  payer: 'À vous : payer sur le portail',
  regulariser: 'Régularisation demandée par le greffe',
  attendre: 'En attente de l’INPI',
};

function faBadge(f) {
  return `<span class="badge ${FA_COULEURS[f.statut_couleur] || 'brouillon'}">${esc(f.statut_libelle || f.statut)}</span>`;
}

function faEcheance(e, enRetard) {
  if (!e) return '<span class="muted">—</span>';
  if (typeof e === 'string') return enRetard ? `<span class="badge a_faire">dépassée le ${fmtDate(e)}</span>` : `<span class="muted">${fmtDate(e)}</span>`;
  if (!e.connue) return `<span class="muted">${esc(e.message || '—')}</span>`;
  const classe = e.etat === 'depassee' ? 'a_faire' : (e.etat === 'imminente' ? 'envoye' : 'finalise');
  const texte = e.etat === 'depassee' ? `dépassée le ${fmtDate(e.limite)}` : `${fmtDate(e.limite)} · ${e.jours_restants} j`;
  return `<span class="badge ${classe}">${esc(texte)}</span>`;
}

function faBandeau(m) {
  if (!m?.guichet_simulation) return '';
  return `<div class="alerte alerte-alerte"><strong>Mode simulation</strong> Rien n’est transmis à l’INPI (${esc(m.motif_simulation || '')}).</div>`;
}

async function vueFormalitesAi() {
  const r = await api('GET', '/formalites-ai');
  const liste = r.formalites;
  $main.innerHTML = `
    <div class="page-head"><h1>Suivi Formalités AI</h1></div>
    <p class="muted">Les formalités préparées par Claude avec le connecteur « Guichet unique ». Cet onglet est en lecture seule : un dossier se pilote dans la conversation avec Claude.</p>
    ${faBandeau(r)}
    <div class="card mt">${liste.length ? `<table>
      <thead><tr><th>Dossier</th><th>Société</th><th>Statut</th><th>Action attendue</th><th>Échéance</th><th>Liasse</th></tr></thead>
      <tbody>${liste.map((f) => `
        <tr class="clickable" onclick="location.hash='#/formalites-ai/${f.id}'">
          <td><strong>${esc(f.libelle || '')}</strong><div class="sub">${esc(f.reference || '')}${f.simule ? ' · simulation' : ''}</div></td>
          <td>${esc(f.societe || '—')}</td>
          <td>${faBadge(f)}</td>
          <td>${f.action_attendue ? esc(FA_ACTIONS[f.action_attendue] || f.action_attendue) : (f.statut === 'BROUILLON' ? '<span class="muted">En préparation avec Claude</span>' : '<span class="muted">—</span>')}
            ${f.regularisations ? `<div class="sub">${f.regularisations} régularisation(s)</div>` : ''}</td>
          <td>${faEcheance(f.echeance, f.en_retard)}</td>
          <td class="nowrap"><span class="ref">${esc(f.numero_liasse || '—')}</span></td>
        </tr>`).join('')}</tbody></table>`
    : vueVide('Aucune formalité préparée par Claude pour l’instant. Dans une conversation où le connecteur « Guichet unique » est activé, demandez par exemple : « Prépare le changement de président de la société X ».')}</div>`;
}

function faValeur(v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (Array.isArray(v)) return v.length ? v.map(faValeur).join('<br>') : '<span class="muted">Aucun</span>';
  if (typeof v === 'object') {
    if (v.codePostal || v.commune) return esc([v.numVoie, v.typeVoie, v.voie, v.codePostal, v.commune].filter(Boolean).join(' '));
    if (v.nom || v.denomination) {
      return esc([v.prenoms, v.nom || v.denomination].flat().filter(Boolean).join(' ')
        + (v.fonction ? ` (${v.fonction})` : '') + (v.motif ? ` — ${v.motif}` : ''));
    }
    return esc(Object.entries(v).filter(([k]) => !k.startsWith('_')).map(([k, x]) => `${k} : ${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' · '));
  }
  return esc(v);
}

/** Valeur d'un champ en clair : libellé du choix, date à la française, NIR jamais affiché. */
function faChamp(c) {
  const v = c.valeur;
  if (Array.isArray(c.options) && !Array.isArray(v) && typeof v !== 'object') {
    const o = c.options.find((x) => String(Array.isArray(x) ? x[0] : x) === String(v));
    if (o) return esc(Array.isArray(o) ? o[1] : o);
  }
  if (c.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) return esc(fmtDate(v));
  if (v && typeof v === 'object' && !Array.isArray(v) && v.numero_secu) return faValeur({ ...v, numero_secu: undefined });
  return faValeur(v);
}

function faPieces(titre, pieces) {
  if (!pieces.length) return '';
  return `<h3>${esc(titre)}</h3><ul class="fa-pieces">${pieces.map((p) => `
    <li><span>${esc(p.court || p.libelle)}${p.personne ? ` — ${esc(p.personne)}` : ''} <span class="muted">(${esc(p.code)})</span></span>
      ${p.fichiers.length ? `<span class="badge finalise">${p.fichiers.map((x) => esc(x.nom)).join(', ')}</span>` : '<span class="badge a_faire">non reçue</span>'}</li>`).join('')}</ul>`;
}

async function vueFormaliteAi(id) {
  const d = await api('GET', `/formalites-ai/${id}`);
  const champs = d.champs.flatMap((g) => g.champs.filter((c) => c.valeur !== null && c.valeur !== undefined && c.valeur !== '')
    .map((c) => ({ groupe: g.titre, ...c })));
  const etat = d.etat;
  $main.innerHTML = `
    <div class="page-head"><div><h1>${esc(d.libelle || d.reference)}</h1>
      <div class="sub">${esc(d.reference)} · ${faBadge(d)}${d.dossier ? ` · dossier <a href="#/dossiers/${d.dossier.id}">${esc(d.dossier.reference)}</a>` : ''}</div></div>
      <div><a class="btn-ghost" href="#/formalites-ai">Retour</a>${d.inpi_id ? '<button id="fa-actualiser">Actualiser auprès de l’INPI</button>' : ''}</div>
    </div>
    ${faBandeau(d)}
    <div class="alerte alerte-info">Lecture seule : ce dossier se pilote dans la conversation avec Claude (connecteur « Guichet unique »).</div>
    <div class="grid cols-2 mt">
      <section class="card"><h2>Situation</h2><dl class="recap">
        <div><dt>Société</dt><dd>${esc(d.societe.denomination || '—')}</dd></div>
        <div><dt>SIREN</dt><dd>${esc(d.societe.siren || (d.societe.creation ? 'création' : '—'))}</dd></div>
        <div><dt>Formalité</dt><dd>${d.operations.map((o) => `${esc(o.nom)} <span class="muted">(${esc(o.code)})</span>`).join('<br>')}</dd></div>
        <div><dt>Échéance</dt><dd>${faEcheance(d.echeance)}</dd></div>
        <div><dt>Action attendue</dt><dd>${d.action_attendue ? esc(FA_ACTIONS[d.action_attendue] || d.action_attendue) : (d.inpi_id ? '—' : 'En préparation')}</dd></div>
        ${d.inpi_id ? `<div><dt>Guichet unique</dt><dd>Liasse ${esc(d.numero_liasse || '—')}${d.montant ? ` · ${eur.format(d.montant)}` : ''}${d.simule ? ' · simulation' : ''}</dd></div>` : ''}
        ${d.depot_expire && !d.inpi_id ? `<div><dt>Lien de dépôt</dt><dd>${Date.parse(d.depot_expire) > Date.now() ? `valable jusqu’au ${fmtDate(d.depot_expire)}` : 'expiré'}</dd></div>` : ''}
      </dl></section>
      <section class="card"><h2>Avant transmission</h2>
        ${d.inpi_id ? '<p>Dossier enregistré au guichet unique.</p>'
    : (etat.pret ? '<p class="badge finalise">Complet : prêt pour la validation de l’avocat</p>'
      : `<ul>${[
        ...etat.champs_manquants.map((m) => `Information manquante — ${m}`),
        ...etat.pieces_manquantes.map((m) => `Pièce non reçue — ${m}`),
        ...(etat.questions_restantes ? [`${etat.questions_restantes} question(s) sans réponse`] : []),
        ...(etat.pieces_a_preciser ? [`${etat.pieces_a_preciser} pièce(s) à préciser`] : []),
        ...etat.non_deposables.map((m) => `À finaliser sur le portail : ${m}`),
      ].map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`)}
        ${d.regularisations.length ? `<div class="alerte alerte-bloquant"><strong>Régularisation</strong><ul>${d.regularisations.map((r) => `<li>${esc(r.motif || JSON.stringify(r))}</li>`).join('')}</ul></div>` : ''}
      </section>
    </div>
    <section class="card mt"><h2>Pièces</h2>
      ${faPieces('Obligatoires', d.pieces.obligatoires)}${faPieces('Selon le cas', d.pieces.a_preciser)}${faPieces('Facultatives', d.pieces.facultatives)}
      ${d.autres_pieces.length ? `<h3>Autres</h3><ul class="fa-pieces">${d.autres_pieces.map((p) => `<li><span>${esc(p.nom)} <span class="muted">(${esc(p.code)})</span></span></li>`).join('')}</ul>` : ''}
    </section>
    <section class="card mt"><h2>Ce qui est déclaré</h2>
      ${d.questions.filter((qq) => qq.valeur !== null && qq.valeur !== undefined).length ? `<table><tbody>${d.questions.filter((qq) => qq.valeur !== null && qq.valeur !== undefined).map((qq) => `
        <tr><td>${esc(qq.libelle)}</td><td>${faValeur(Array.isArray(qq.options) && !Array.isArray(qq.valeur) ? ((qq.options.find((o) => o[0] === qq.valeur) || [])[1] ?? qq.valeur) : qq.valeur)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${champs.length ? `<table class="mt"><tbody>${champs.map((c) => `
        <tr><td>${esc(c.label)}<div class="sub">${esc(c.groupe)}</div></td><td>${faChamp(c)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Rien de renseigné pour l’instant.</p>'}
    </section>
    <section class="card mt"><h2>Journal</h2>
      ${d.journal.length ? `<table><tbody>${d.journal.map((e) => `<tr><td class="nowrap muted">${esc(new Date(e.date).toLocaleString('fr-FR'))}</td><td>${esc(e.message)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">—</p>'}
    </section>`;
  const b = document.getElementById('fa-actualiser');
  if (b) {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api('POST', `/formalites-ai/${id}/actualiser`);
        toast(r.changement ? `Nouveau statut : ${r.statut_libelle}` : 'Statut inchangé.');
        render();
      } catch (e) { toast(e.message, true); b.disabled = false; }
    };
  }
}

routes.unshift(
  { re: /^\/formalites-ai$/, view: vueFormalitesAi, nav: 'formalites-ai' },
  { re: /^\/formalites-ai\/(\d+)$/, view: vueFormaliteAi, nav: 'formalites-ai' },
);
