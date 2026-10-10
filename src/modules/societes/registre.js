'use strict';

/**
 * Fiches société tenues à jour par le Registre national des entreprises.
 *
 * Le registre fait foi pour ce qu'il publie : dénomination, forme, capital,
 * siège, objet, clôture de l'exercice, dirigeants, radiation. Une fiche avec
 * SIREN est relue au plus tard toutes les 24 heures (à l'ouverture, ou sur
 * demande) ; chaque changement constaté est inscrit dans son historique
 * (« Capital : 10 000 → 15 000 »), pour qu'aucune modification au registre ne
 * passe inaperçue.
 */

const rne = require('../../inpi/rne');
const { versFicheSociete, nettoyerSiren, sirenValide } = require('../../inpi/normalize');
const { supabase, q } = require('../../supa');

const FRAICHEUR = 24 * 3600 * 1000;
const CHAMPS = {
  denomination: 'Dénomination', forme_sociale: 'Forme', capital_social: 'Capital', siege_social: 'Siège',
  objet_social: 'Objet', date_cloture: 'Clôture de l’exercice', statut: 'Statut',
};

const normal = (v) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Les dirigeants publiés, sous une forme stable et lisible. */
function dirigeantsRegistre(fiche) {
  return (fiche.dirigeants || []).map((d) => ({
    type: d.type,
    nom_complet: d.nom_complet || d.denomination || [...(d.prenoms || []), d.nom].join(' '),
    nom: d.type === 'physique' ? d.nom : d.denomination,
    prenom: d.type === 'physique' ? (d.prenoms || []).join(' ') : '',
    fonction: d.role_libelle || '',
    siren: d.siren || '',
  })).filter((d) => d.nom_complet);
}

/** Ce qui a changé entre la fiche du cabinet et le registre. */
function comparer(avant, champs, dirigeantsAvant, dirigeantsApres) {
  const ecarts = [];
  for (const [champ, libelle] of Object.entries(CHAMPS)) {
    if (!(champ in champs)) continue;
    const a = avant[champ];
    const b = champs[champ];
    const differe = champ === 'capital_social' ? Number(a || 0) !== Number(b || 0) : normal(a) !== normal(b);
    if (differe && (b !== null && b !== '')) ecarts.push({ champ, libelle, avant: a ?? '', apres: b });
  }
  const cle = (d) => `${normal(d.nom_complet)}|${normal(d.fonction)}`;
  const avantCles = new Set((dirigeantsAvant || []).map(cle));
  const apresCles = new Set(dirigeantsApres.map(cle));
  for (const d of dirigeantsApres) if (!avantCles.has(cle(d))) ecarts.push({ champ: 'dirigeant', libelle: 'Dirigeant', avant: '', apres: `${d.nom_complet} (${d.fonction || 'fonction non précisée'})` });
  for (const d of dirigeantsAvant || []) if (!apresCles.has(cle(d))) ecarts.push({ champ: 'dirigeant', libelle: 'Dirigeant', avant: `${d.nom_complet} (${d.fonction || ''})`, apres: '' });
  return ecarts;
}

/**
 * Relit la société au registre. Sans `force`, une fiche lue depuis moins de
 * 24 heures n'est pas relue.
 */
async function actualiser(societeId, { force = false } = {}) {
  const s = await q(supabase.from('societes').select('*').eq('id', societeId).single());
  const siren = nettoyerSiren(s.siren);
  if (!sirenValide(siren)) return { statut: 'sans_siren', societe: s };
  if (!force && s.rne_maj_le && Date.now() - new Date(s.rne_maj_le).getTime() < FRAICHEUR) return { statut: 'a_jour', societe: s };

  let fiche;
  try {
    fiche = await rne.entreprise(siren);
  } catch (e) {
    await q(supabase.from('societes').update({ rne_erreur: String(e.message || e).slice(0, 300) }).eq('id', s.id).select('id'));
    return { statut: 'erreur', erreur: e.message, societe: s };
  }
  const champs = versFicheSociete(fiche);
  delete champs.rcs_ville; // la commune du siège n'est pas la ville du greffe : on garde la saisie du cabinet
  champs.statut = fiche.radiee ? 'radiee' : 'active';
  const dirigeants = dirigeantsRegistre(fiche);
  const premiere = !s.rne_maj_le;
  const ecarts = premiere ? [] : comparer(s, champs, s.rne_dirigeants, dirigeants);
  const maintenant = new Date().toISOString();
  const historique = [
    ...(premiere ? [{ date: maintenant, ecarts: [], note: 'Fiche alignée sur le registre.' }] : ecarts.length ? [{ date: maintenant, ecarts }] : []),
    ...(s.rne_historique || []),
  ].slice(0, 30);

  const maj = await q(supabase.from('societes').update({
    ...champs, rne_maj_le: maintenant, rne_dirigeants: dirigeants, rne_historique: historique, rne_erreur: null,
  }).eq('id', s.id).select().single());

  // Les dirigeants de la fiche suivent le registre (ils servent à la rédaction des actes).
  if (premiere || ecarts.some((x) => x.champ === 'dirigeant')) {
    await q(supabase.from('dirigeants').delete().eq('societe_id', s.id).select('id'));
    if (dirigeants.length) {
      await q(supabase.from('dirigeants').insert(dirigeants.map((d) => ({
        societe_id: s.id, civilite: '', nom: d.nom, prenom: d.prenom, fonction: d.fonction, adresse: '',
      }))).select('id'));
    }
  }
  return { statut: 'actualise', ecarts, premiere, societe: maj };
}

/** Relit toutes les fiches avec SIREN, dans la limite du temps d'une requête. */
async function actualiserToutes({ force = true, budgetMs = 40000 } = {}) {
  const debut = Date.now();
  const societes = await q(supabase.from('societes').select('id, denomination, siren').order('denomination'));
  const avecSiren = societes.filter((s) => sirenValide(nettoyerSiren(s.siren)));
  const resultats = [];
  for (const s of avecSiren) {
    if (Date.now() - debut > budgetMs) break;
    const r = await actualiser(s.id, { force });
    resultats.push({ id: s.id, denomination: r.societe?.denomination || s.denomination, statut: r.statut, ecarts: r.ecarts || [], erreur: r.erreur });
  }
  return {
    traitees: resultats.length, restantes: avecSiren.length - resultats.length, sans_siren: societes.length - avecSiren.length,
    changements: resultats.filter((r) => r.ecarts.length), erreurs: resultats.filter((r) => r.statut === 'erreur'),
  };
}

/** Crée (ou retrouve) la fiche d'une société à partir de son seul SIREN, alignée sur le registre. */
async function importer(sirenBrut, { groupe_id: groupeId = null } = {}) {
  const siren = nettoyerSiren(sirenBrut);
  if (!sirenValide(siren)) throw Object.assign(new Error('SIREN invalide (9 chiffres).'), { status: 400 });
  const toutes = await q(supabase.from('societes').select('id, siren'));
  const existante = toutes.find((s) => nettoyerSiren(s.siren) === siren);
  let id = existante?.id;
  if (!id) {
    const fiche = await rne.entreprise(siren);
    const cree = await q(supabase.from('societes').insert({ ...versFicheSociete(fiche), rcs_ville: '', groupe_id: groupeId }).select().single());
    id = cree.id;
  }
  const r = await actualiser(id, { force: !existante });
  return { ...r, cree: !existante };
}

module.exports = { actualiser, actualiserToutes, importer, comparer, dirigeantsRegistre };
