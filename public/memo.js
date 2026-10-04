/* =========================================================================
   Mémo des formalités.

   La version « coup d'œil » du catalogue : on choisit une opération en
   langage courant, et l'on voit sur une seule page ce qu'il faut demander
   au client et ce que le cabinet prépare. Cases à cocher, liste à copier
   pour le client, impression. Le détail technique reste dans le catalogue.
   ========================================================================= */

/** Les opérations courantes, nommées comme le cabinet les nomme. */
const MEMO_OPERATIONS = [
  { groupe: 'Créer', items: [
    ['01M', 'Créer une société'],
    ['02M', 'Créer une société sans activité (holding passive…)'],
  ] },
  { groupe: 'Faire vivre la société', items: [
    ['11M', 'Transférer le siège social'],
    ['10M', 'Changer de dénomination'],
    ['12M', 'Modifier l’objet social ou l’activité'],
    ['16M', 'Changer la date de clôture ou la durée'],
    ['14M', 'Déclarer un site internet'],
    ['20M', 'Changer la date de début d’activité'],
  ] },
  { groupe: 'Dirigeants et associés', items: [
    ['35M', 'Nommer ou remplacer un dirigeant ou un commissaire aux comptes'],
    ['34M', 'Dirigeants d’une SNC, SCI ou société civile'],
    ['17M', 'Passer à un associé unique (ou en sortir)'],
    ['38F', 'Déclarer ou modifier les bénéficiaires effectifs'],
  ] },
  { groupe: 'Capital et forme', items: [
    ['15M', 'Augmenter ou réduire le capital'],
    ['13M', 'Transformer la société'],
    ['25M', 'Capitaux propres inférieurs à la moitié du capital'],
    ['26M', 'Capitaux propres reconstitués'],
  ] },
  { groupe: 'Établissements et fonds', items: [
    ['54PMF', 'Ouvrir un établissement'],
    ['80PMF', 'Fermer un établissement'],
    ['56PMF', 'Transférer un établissement'],
    ['61PMF', 'Ajouter une activité'],
    ['84M', 'Mettre le fonds en location-gérance'],
  ] },
  { groupe: 'Fin de vie', items: [
    ['22M', 'Dissoudre la société (liquidation amiable)'],
    ['42M', 'Radier après la clôture de la liquidation'],
    ['28M', 'Dissolution-confusion (TUP)'],
    ['41M', 'Fusion : radier la société absorbée'],
  ] },
];

/** Mots que l'on tape pour chercher une opération, au-delà de son intitulé. */
const MEMO_MOTS_CLES = {
  '01M': 'constitution immatriculation creation sas sasu sarl eurl sa sci snc nouvelle societe',
  '02M': 'holding passive sans activite constitution',
  '11M': 'demenagement adresse siege social transfert',
  '10M': 'nom raison sociale denomination sigle',
  '12M': 'objet social activite',
  '16M': 'exercice cloture prorogation duree',
  '14M': 'site web nom de domaine internet',
  '35M': 'gerant president directeur general dg administrateur nomination demission revocation remplacement commissaire aux comptes cac mandataire social',
  '34M': 'gerant snc sci societe civile associe',
  '17M': 'associe unique sasu eurl reunion des parts',
  '38F': 'beneficiaire effectif rbe controle',
  '15M': 'capital augmentation reduction apport',
  '13M': 'transformation changement de forme sarl en sas',
  '25M': 'capitaux propres pertes moitie du capital',
  '26M': 'capitaux propres reconstitution',
  '54PMF': 'etablissement secondaire ouverture succursale',
  '80PMF': 'etablissement fermeture',
  '56PMF': 'etablissement transfert demenagement',
  '61PMF': 'activite nouvelle adjonction',
  '84M': 'location gerance fonds de commerce',
  '22M': 'dissolution anticipee liquidation amiable liquidateur',
  '42M': 'radiation cloture liquidation',
  '28M': 'tup transmission universelle patrimoine dissolution confusion',
  '41M': 'fusion absorption absorbee radiation',
};
const memoSansAccent = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Pièces qui sont des actes à déposer au greffe. */
const MEMO_ACTES = new Set(['PJ_01', 'PJ_02', 'PJ_03', 'PJ_54', 'PJ_108', 'PJ_133', 'PJ_153', 'PJ_155', 'PJ_156', 'PJ_157', 'PJ_161', 'PJ_199', 'PJ_236']);

/** Formalités où l'on déclare un nouveau dirigeant : son identité complète est exigée. */
const MEMO_NOUVEAU_DIRIGEANT = new Set(['01M', '02M', '03M', '34M', '35M', '22M']);
const MEMO_IDENTITE_DIRIGEANT = 'Pour chaque nouveau dirigeant : nom, prénoms, sexe, date et commune de naissance '
  + '(avec code INSEE), nationalité, domicile, affiliation sociale ; situation matrimoniale pour un gérant de SARL';

let memoDonnees = null;
let memoRecherche = '';

async function memoCharger() {
  if (!memoDonnees) memoDonnees = await api('GET', '/formalites/evenements');
  return memoDonnees;
}

function memoNom(code) {
  for (const g of MEMO_OPERATIONS) for (const [c, nom] of g.items) if (c === code) return nom;
  return null;
}

/* ----------------------------------------------------------- choix d'opération */

async function vueMemoListe() {
  const d = await memoCharger();
  $main.innerHTML = `
    <div class="entete-vue">
      <div>
        <div class="crumb"><a href="#/formalites">Formalités</a> /</div>
        <h1 class="titre-page">Que voulez-vous faire ?</h1>
        <p class="muted">Choisissez l’opération : vous obtenez la liste de ce qu’il faut demander au client et de ce que le cabinet prépare.</p>
      </div>
      <a class="btn-ghost" href="#/formalites/catalogue">Catalogue détaillé</a>
    </div>
    <input type="search" id="memo-recherche" class="memo-recherche" autocomplete="off"
      placeholder="Chercher : siège, gérant, capital, dissolution…" value="${esc(memoRecherche)}">
    <div id="memo-choix"></div>`;

  const $r = document.getElementById('memo-recherche');
  $r.oninput = () => { memoRecherche = $r.value; memoAfficherChoix(d); };
  memoAfficherChoix(d);
  $r.focus();
}

function memoAfficherChoix(d) {
  const terme = memoSansAccent(memoRecherche.trim());
  const $c = document.getElementById('memo-choix');
  const parCode = new Map(d.formalites.map((f) => [f.code, f]));
  const correspond = (code, nom) => !terme || terme.split(/\s+/).every((m) =>
    memoSansAccent(`${nom} ${code} ${parCode.get(code)?.libelle || ''} ${MEMO_MOTS_CLES[code] || ''}`).includes(m));

  let html = MEMO_OPERATIONS.map((g) => {
    const items = g.items.filter(([code, nom]) => parCode.has(code) && correspond(code, nom));
    if (!items.length) return '';
    return `<section class="memo-groupe"><h2>${esc(g.groupe)}</h2><div class="memo-tuiles">
      ${items.map(([code, nom]) => `<a class="memo-tuile" href="#/formalites/memo/${esc(code)}">
        <span class="memo-tuile-nom">${esc(nom)}</span><span class="memo-tuile-code">${esc(code)}</span></a>`).join('')}
    </div></section>`;
  }).join('');

  // Au-delà des opérations courantes : toutes les autres formalités de sociétés.
  if (terme) {
    const courantes = new Set(MEMO_OPERATIONS.flatMap((g) => g.items.map(([c]) => c)));
    const autres = d.formalites.filter((f) => f.famille !== 'hors_champ' && !f.emise_par_le_registre
      && !courantes.has(f.code) && correspond(f.code, f.libelle));
    if (autres.length) {
      html += `<section class="memo-groupe"><h2>Autres formalités</h2><div class="memo-tuiles">
        ${autres.map((f) => `<a class="memo-tuile" href="#/formalites/memo/${esc(f.code)}">
          <span class="memo-tuile-nom">${esc(f.libelle)}</span><span class="memo-tuile-code">${esc(f.code)}</span></a>`).join('')}
      </div></section>`;
    }
  }
  $c.innerHTML = html || '<div class="empty">Aucune opération ne correspond. Essayez un autre mot.</div>';
}

/* ------------------------------------------------------------------ le mémo */

function memoCle(code) { return `legalize.memo.${code}`; }
function memoCoches(code) {
  try { return JSON.parse(localStorage.getItem(memoCle(code)) || '{}'); } catch { return {}; }
}
function memoEnregistrer(code, coches) {
  try { localStorage.setItem(memoCle(code), JSON.stringify(coches)); } catch { /* sans stockage : cases non mémorisées */ }
}

/** Ce que le mémo affiche, calculé une fois : sert à l'écran et au texte copié. */
function memoContenu(f) {
  const infos = f.informations.map((i) => i.libelle);
  if (MEMO_NOUVEAU_DIRIGEANT.has(f.code)) infos.push(MEMO_IDENTITE_DIRIGEANT);

  const toutes = [...f.pieces_obligatoires, ...f.pieces_selon_le_cas];
  const client = toutes.filter((p) => !p.par_le_cabinet);
  const cabinet = toutes.filter((p) => p.par_le_cabinet);
  const v = f.verification_inpi;
  return {
    titre: memoNom(f.code) || f.libelle,
    infos,
    client,
    cabinet,
    annonce: toutes.some((p) => p.code === 'PJ_08'),
    // Le frais de dépôt d'actes relevé par le serveur fait foi quand la
    // formalité a été testée ; sinon, la présence d'un acte parmi les pièces.
    acte: v?.statut === 'verifie' && v.acte_attendu !== null && v.acte_attendu !== undefined
      ? v.acte_attendu
      : toutes.some((p) => !p.condition && MEMO_ACTES.has(p.code)),
    frais: v?.statut === 'verifie' && v.frais_total ? v.frais_total : null,
  };
}

async function vueMemoFiche(code) {
  const d = await memoCharger();
  const f = d.formalites.find((x) => x.code === code);
  if (!f) { location.hash = '#/formalites/memo'; return; }
  const m = memoContenu(f);
  const coches = memoCoches(code);
  const euros = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

  const ligne = (id, texte, detail = '', titre = '') => `
    <label class="memo-ligne ${coches[id] ? 'fait' : ''}" ${titre ? `title="${esc(titre)}"` : ''}>
      <input type="checkbox" data-id="${esc(id)}" ${coches[id] ? 'checked' : ''}>
      <span>${esc(texte)}${detail ? `<small>${esc(detail)}</small>` : ''}</span>
    </label>`;
  const piece = (p) => ligne(p.code, p.court, p.condition || '', p.libelle);
  const toujours = (l) => l.filter((p) => !p.condition);
  const selonCas = (l) => l.filter((p) => p.condition);

  $main.innerHTML = `
    <div class="memo">
      <div class="entete-vue memo-entete">
        <div>
          <div class="crumb"><a href="#/formalites/memo">Que voulez-vous faire ?</a> /</div>
          <h1 class="titre-page">${esc(m.titre)}</h1>
          ${f.quand ? `<p class="muted">${esc(f.quand)}</p>` : ''}
        </div>
        <div class="memo-actions">
          <a class="btn btn-primary" href="#/parcours/nouveau?ops=${esc(code)}">Ouvrir un dossier</a>
          <button class="btn" id="memo-copier">Copier la liste pour le client</button>
          <button class="btn-ghost" id="memo-imprimer">Imprimer</button>
        </div>
      </div>

      <div class="memo-reperes">
        <span class="memo-repere">${m.annonce ? 'Annonce légale : oui' : 'Pas d’annonce légale'}</span>
        <span class="memo-repere">${m.acte ? 'Acte à déposer au greffe' : 'Pas d’acte à déposer'}</span>
        ${m.frais !== null ? `<span class="memo-repere">Frais de greffe indicatifs : ${euros(m.frais)}</span>` : ''}
        <span class="memo-repere memo-code" title="${esc(f.libelle)}">Formalité INPI ${esc(f.code)}</span>
      </div>

      ${f.detaillee ? `
      <div class="memo-colonnes">
        <section class="memo-col">
          <h2><span class="memo-num">1</span> Informations à demander au client</h2>
          ${m.infos.map((t, i) => ligne(`i${i}`, t)).join('')}
        </section>
        <section class="memo-col">
          <h2><span class="memo-num">2</span> Documents à demander au client</h2>
          ${toujours(m.client).map(piece).join('') || '<p class="muted memo-vide">Aucun document systématique.</p>'}
          ${selonCas(m.client).length ? `<h3>Selon la situation</h3>${selonCas(m.client).map(piece).join('')}` : ''}
        </section>
        <section class="memo-col memo-cabinet">
          <h2><span class="memo-num">3</span> Préparé par le cabinet</h2>
          ${toujours(m.cabinet).map(piece).join('') || '<p class="muted memo-vide">Rien de particulier.</p>'}
          ${selonCas(m.cabinet).length ? `<h3>Selon la situation</h3>${selonCas(m.cabinet).map(piece).join('')}` : ''}
        </section>
      </div>` : `
      <div class="empty">Cette formalité n’est pas encore détaillée. Consultez le <a href="#/formalites/catalogue">catalogue</a>.</div>`}

      ${f.note ? `<p class="memo-note"><strong>Bon à savoir</strong> — ${esc(f.note)}</p>` : ''}

      <p class="memo-pied muted">
        <button class="lien" id="memo-raz">Décocher tout</button> ·
        <a href="#/formalites/catalogue" id="memo-detail">Voir la fiche détaillée (codes INPI, textes, test du serveur)</a>
      </p>
    </div>`;

  $main.querySelectorAll('.memo-ligne input').forEach((c) => {
    c.onchange = () => {
      coches[c.dataset.id] = c.checked;
      c.closest('.memo-ligne').classList.toggle('fait', c.checked);
      memoEnregistrer(code, coches);
    };
  });
  document.getElementById('memo-raz').onclick = () => { memoEnregistrer(code, {}); vueMemoFiche(code); };
  document.getElementById('memo-imprimer').onclick = () => window.print();
  document.getElementById('memo-detail').onclick = () => {
    if (typeof catEtat !== 'undefined') catEtat.recherche = code;
  };
  document.getElementById('memo-copier').onclick = async () => {
    const texte = memoTexteClient(m);
    try {
      await navigator.clipboard.writeText(texte);
      toast('Liste copiée : collez-la dans votre courriel au client.');
    } catch {
      window.prompt('Copiez la liste :', texte);
    }
  };
}

/** Le texte à envoyer au client : seulement ce qu'il doit fournir. */
function memoTexteClient(m) {
  const l = [`${m.titre}`, '', 'Informations à nous communiquer :', ...m.infos.map((t) => `- ${t}`)];
  const toujours = m.client.filter((p) => !p.condition);
  const selon = m.client.filter((p) => p.condition);
  if (toujours.length) l.push('', 'Documents à nous transmettre :', ...toujours.map((p) => `- ${p.court}`));
  if (selon.length) l.push('', 'Selon votre situation :', ...selon.map((p) => `- ${p.court} (${p.condition})`));
  return l.join('\n');
}

routes.unshift(
  { re: /^\/formalites\/memo$/, view: vueMemoListe, nav: 'formalites' },
  { re: /^\/formalites\/memo\/([0-9A-Z]+)$/, view: vueMemoFiche, nav: 'formalites' },
);
