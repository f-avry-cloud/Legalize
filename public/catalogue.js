/* =========================================================================
   Catalogue des formalités.

   Avant de rédiger les actes, savoir ce que la formalité exigera : les
   informations à transmettre, les pièces à joindre. Une fiche par événement
   du guichet unique, lisible par un juriste, cherchable par pièce.
   ========================================================================= */

const CAT_TYPES = { C: 'Création', M: 'Modification', R: 'Radiation' };

let catDonnees = null;
let catEtat = { recherche: '', toutes: false };

async function vueCatalogueFormalites() {
  if (!catDonnees) catDonnees = await api('GET', '/formalites/evenements');
  const d = catDonnees;

  $main.innerHTML = `
    <div class="entete-vue">
      <div>
        <div class="crumb"><a href="#/formalites">Formalités</a> /</div>
        <h1 class="titre-page">Catalogue des formalités</h1>
        <p class="muted">Ce que chaque formalité exigera : les informations à transmettre et les pièces à joindre.
        À consulter avant de rédiger les actes.</p>
      </div>
    </div>

    <div class="cat-source">
      <strong>Provenance des informations</strong>
      <ul>
        <li><span class="cat-puce sure"></span>La liste des formalités et leurs libellés viennent du référentiel INPI : ils font foi.</li>
        <li><span class="cat-puce sure"></span>Les informations à transmettre sont déduites du dictionnaire INPI.</li>
        <li><span class="cat-puce a-valider"></span><span>Les pièces justificatives sont rattachées aux codes officiels, mais <strong>aucun fichier INPI
        ne dit quelle pièce va avec quelle formalité</strong>. La liste réglementaire relève de l’arrêté prévu à
        l’article R. 123-292 du Code de commerce. Les formalités courantes ont été confrontées au Code de commerce (articles R. 123-103 à R. 123-110 et annexes de la partie Arrêtés, lus via l’API Légifrance) et aux fiches de service-public.gouv.fr ; le fondement est cité dans chaque fiche. Les autres rattachements restent <strong>à valider</strong>.</span></li>
      </ul>
    </div>

    ${d.verifications ? `
    <details class="cat-source cat-sonde">
      <summary><strong>Ce que le serveur de l’INPI exige réellement</strong>
        <span class="muted">— dépôts de test du ${esc(catDate(d.verifications.date))}</span></summary>
      <ul>${d.verifications.constats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <p><strong>Pour toute modification, le serveur exige en plus :</strong></p>
      <ul>${d.verifications.socle_modification.map((c) => `<li>${esc(c.libelle)}</li>`).join('')}</ul>
      ${d.verifications.socle_creation?.length ? `<p><strong>Pour toute création, le serveur exige notamment :</strong></p>
      <ul>${d.verifications.socle_creation.map((c) => `<li>${esc(c.libelle)}</li>`).join('')}</ul>` : ''}
    </details>` : ''}

    <div class="cat-barre">
      <input type="search" id="cat-recherche" placeholder="Chercher une formalité, une pièce, un code (11M, PJ_08, statuts…)"
        value="${esc(catEtat.recherche)}" autocomplete="off">
      <label class="bascule-requis"><input type="checkbox" id="cat-toutes" ${catEtat.toutes ? 'checked' : ''}>
        Inclure entreprises individuelles et exploitations agricoles</label>
      <button class="btn-ghost" id="cat-deplier">Tout déplier</button>
    </div>

    <div class="cat-communes">
      <div><span class="etiquette">Pour toute formalité déposée par un mandataire</span>
        ${d.pieces_communes.map(catPiece).join('')}</div>
      <div><span class="etiquette">Générées par le guichet, à signer — pas à fournir</span>
        ${d.pieces_generees.map(catPiece).join('')}</div>
    </div>

    <div id="cat-resultats"></div>`;

  catAfficher();
  catBrancher();
}

/** Les fiches qui correspondent à la recherche, rangées par famille. */
function catAfficher() {
  const d = catDonnees;
  const terme = catEtat.recherche.trim().toLowerCase();
  const correspond = (f) => {
    if (!catEtat.toutes && f.famille === 'hors_champ') return false;
    if (!terme) return true;
    const texte = [
      f.code, f.libelle, f.quand, f.note,
      ...f.informations.map((i) => i.libelle),
      ...[...f.pieces_obligatoires, ...f.pieces_selon_le_cas].flatMap((p) => [p.code, p.libelle, p.condition]),
    ].filter(Boolean).join(' ').toLowerCase();
    return terme.split(/\s+/).every((mot) => texte.includes(mot));
  };

  const retenues = d.formalites.filter(correspond);
  const parFamille = new Map();
  for (const f of retenues) {
    if (!parFamille.has(f.famille)) parFamille.set(f.famille, []);
    parFamille.get(f.famille).push(f);
  }

  const $r = document.getElementById('cat-resultats');
  if (!retenues.length) {
    $r.innerHTML = '<div class="empty">Aucune formalité ne correspond à cette recherche.</div>';
    return;
  }

  $r.innerHTML = `<p class="muted mb">${retenues.length} formalité(s) sur ${d.formalites.length}</p>`
    + [...parFamille.entries()]
      .sort(([a], [b]) => d.familles[a].ordre - d.familles[b].ordre)
      .map(([famille, fiches]) => `
        <section class="cat-famille">
          <h2>${esc(d.familles[famille].libelle)} <span class="muted">· ${fiches.length}</span></h2>
          ${fiches.map((f) => catFiche(f, Boolean(terme))).join('')}
        </section>`).join('');
}

function catFiche(f, ouverte) {
  const nbOblig = f.pieces_obligatoires.length;
  const nbCas = f.pieces_selon_le_cas.length;
  const resume = f.detaillee
    ? `${nbOblig} pièce(s) toujours requise(s)${nbCas ? ` · ${nbCas} selon le cas` : ''}`
    : 'fiche non détaillée';

  return `<details class="cat-fiche ${f.detaillee ? '' : 'non-detaillee'}" ${ouverte ? 'open' : ''}>
    <summary>
      <span class="cat-code">${esc(f.code)}</span>
      <span class="cat-titre">${esc(f.libelle)}</span>
      ${f.type ? `<span class="badge">${esc(CAT_TYPES[f.type] || f.type)}</span>` : ''}
      <span class="cat-resume muted">${resume}</span>
      ${f.verification_inpi?.statut === 'verifie' ? '<span class="badge cat-badge-teste" title="Vérifiée par un dépôt de test sur le serveur INPI">testée INPI</span>' : ''}
    </summary>
    <div class="cat-corps">
      ${f.emise_par_le_registre ? '<p class="cat-note">Cet événement est émis par le registre lui-même : il ne se dépose pas.</p>' : ''}
      ${f.quand ? `<p class="cat-quand"><strong>Quand ?</strong> ${esc(f.quand)}</p>` : ''}
      ${f.detaillee ? `
        <div class="cat-colonnes">
          <div>
            <h3>Informations à transmettre</h3>
            <ul class="cat-infos">${f.informations.map((i) => `<li>${esc(i.libelle)}</li>`).join('')}</ul>
          </div>
          <div>
            <h3>Pièces toujours requises</h3>
            ${nbOblig ? f.pieces_obligatoires.map(catPiece).join('') : '<p class="muted">Aucune.</p>'}
            ${nbCas ? `<h3 class="mt">Pièces selon le cas</h3>${f.pieces_selon_le_cas.map(catPiece).join('')}` : ''}
            ${f.textes && f.textes.length ? `<p class="cat-textes"><strong>Fondement</strong> : ${f.textes.map(esc).join(' · ')}</p>` : ''}
            ${f.source ? `<p class="cat-verifiee">Pièces vérifiées sur la <a href="${esc(f.source)}" target="_blank" rel="noopener">fiche service-public</a>.</p>` : ''}
            ${f.pieces_a_valider ? '<p class="cat-a-valider">Rattachement des pièces à valider.</p>' : ''}
          </div>
        </div>` : `
        <p class="muted">Formalité hors du droit des sociétés courant, ou trop spécifique pour être détaillée à ce stade.
        Le libellé et les repères INPI ci-dessous sont officiels.</p>`}
      ${f.note ? `<p class="cat-note">${esc(f.note)}</p>` : ''}
      ${catVerification(f.verification_inpi)}
      ${f.inpi.drapeaux.length || f.inpi.champs.length ? `
        <details class="cat-technique">
          <summary>Repères dans le dictionnaire INPI</summary>
          ${f.inpi.drapeaux.length ? `<p><strong>Déclencheur(s)</strong> : ${f.inpi.drapeaux.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}
          ${f.inpi.champs.length ? `<p><strong>Champs que cet événement rend obligatoires</strong> : ${f.inpi.champs.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}
        </details>` : ''}
    </div>
  </details>`;
}

function catDate(iso) {
  return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Résultat du dépôt de test sur le serveur de démonstration de l'INPI. */
function catVerification(v) {
  if (!v) return '';
  if (v.statut !== 'verifie') {
    const titre = v.statut === 'non_testable' ? 'non testable sur le serveur de démonstration' : 'non concluant';
    return `<div class="cat-sonde-fiche non-concluant">
      <h3>Test sur le serveur INPI : ${titre}</h3>
      <p>${esc(v.note || '')}</p>
    </div>`;
  }
  const euros = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  return `<div class="cat-sonde-fiche">
    <h3>Testée sur le serveur INPI le ${esc(catDate(v.date))}</h3>
    <p>Le serveur a reconnu l’événement <strong>${esc(v.evenement_detecte)}</strong> avec ces informations, en plus de celles exigées pour toute formalité :</p>
    <ul class="cat-infos">${v.champs.map((c) => `<li>${esc(c.libelle)}</li>`).join('')}</ul>
    ${v.acte_attendu === true ? '<p><strong>Dépôt d’actes facturé</strong> : le greffe attend un acte (procès-verbal, statuts…).</p>' : ''}
    ${v.acte_attendu === false ? '<p>Aucun dépôt d’actes facturé par le serveur.</p>' : ''}
    ${v.frais.length ? `<p class="muted">Frais calculés, à titre indicatif : ${euros(v.frais_total)}
      (${v.frais.map((x) => `${esc(x.libelle)} ${euros(x.montant)}`).join(' · ')}), hors notification aux greffes des établissements secondaires.</p>` : ''}
    ${v.note ? `<p class="cat-note">${esc(v.note)}</p>` : ''}
  </div>`;
}

function catPiece(p) {
  return `<div class="cat-piece ${p.inconnue ? 'inconnue' : ''}">
    <span class="cat-pj">${esc(p.code)}</span>
    <span>${esc(p.libelle)}${p.condition ? ` <em class="cat-condition">— ${esc(p.condition)}</em>` : ''}
    ${p.nota ? `<span class="cat-nota">${esc(p.nota)}</span>` : ''}</span>
  </div>`;
}

function catBrancher() {
  const $rech = document.getElementById('cat-recherche');
  let minuterie = null;
  $rech.oninput = () => {
    clearTimeout(minuterie);
    minuterie = setTimeout(() => { catEtat.recherche = $rech.value; catAfficher(); }, 120);
  };

  document.getElementById('cat-toutes').onchange = (e) => {
    catEtat.toutes = e.target.checked;
    catAfficher();
  };

  const $deplier = document.getElementById('cat-deplier');
  $deplier.onclick = () => {
    const fiches = document.querySelectorAll('.cat-fiche');
    const toutOuvert = [...fiches].every((d) => d.open);
    fiches.forEach((d) => { d.open = !toutOuvert; });
    $deplier.textContent = toutOuvert ? 'Tout déplier' : 'Tout replier';
  };
}

routes.unshift({ re: /^\/formalites\/catalogue$/, view: vueCatalogueFormalites, nav: 'formalites' });
