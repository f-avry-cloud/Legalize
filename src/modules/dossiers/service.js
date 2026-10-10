'use strict';

/**
 * Dossiers, clients et contacts.
 *
 * Un dossier s'ouvre à partir d'un type (src/modules/dossiers/types.js) :
 * ses étapes sont copiées du modèle du cabinet, ses échéances légales sont
 * calculées quand une règle sûre existe, et tout ce qui s'y passe est inscrit
 * dans sa chronologie (table `evenements`), avec son auteur.
 */

const { supabase, q, utilisateurCourant } = require('../../supa');
const types = require('./types');
const echeancesLegales = require('./echeances');
const actions = require('../actions');

const erreur = (message, status = 400) => Object.assign(new Error(message), { status });
const aujourdhui = () => new Date().toISOString().slice(0, 10);
const ACTIFS = ['en_cours', 'en_attente', 'suspendu'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOuNull = (v) => (DATE.test(String(v || '')) ? String(v) : null);
const texte = (v) => String(v ?? '').trim();
const idOuNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/* ------------------------------------------------------------ chronologie */

/** Inscrit un événement dans la chronologie du dossier. */
async function journal(dossierId, nature, resume, { origine, objet_table = null, objet_id = null, details = {} } = {}) {
  const u = utilisateurCourant();
  await q(supabase.from('evenements').insert({
    dossier_id: dossierId, nature, resume, auteur_id: u?.id || null,
    origine: origine || (u ? 'manuel' : 'systeme'), objet_table, objet_id, details,
  }).select());
}

/* --------------------------------------------------------------- modèles */

async function modeles() {
  return q(supabase.from('modeles_processus').select('*'));
}

async function catalogue() {
  return types.catalogue(await modeles());
}

/** Remplace les étapes types d'un type de dossier (une étape par ligne). */
async function majModele(code, { etapes } = {}) {
  if (!types.type(code)) throw erreur('Type de dossier inconnu.', 404);
  const liste = (Array.isArray(etapes) ? etapes : String(etapes || '').split('\n'))
    .map((x) => (typeof x === 'string' ? { libelle: texte(x) } : { code: texte(x.code), libelle: texte(x.libelle) }))
    .filter((x) => x.libelle)
    .map((x, i) => ({ code: x.code || `etape_${i + 1}`, libelle: x.libelle }));
  if (!liste.length) throw erreur('Au moins une étape.');
  const existant = await q(supabase.from('modeles_processus').select('type').eq('type', code));
  const ligne = { etapes: liste, updated_at: new Date().toISOString() };
  if (existant.length) await q(supabase.from('modeles_processus').update(ligne).eq('type', code).select());
  else await q(supabase.from('modeles_processus').insert({ type: code, ...ligne }).select());
  return catalogue();
}

/** Revient aux étapes proposées par défaut. */
async function reinitialiserModele(code) {
  await q(supabase.from('modeles_processus').delete().eq('type', code).select());
  return catalogue();
}

/* --------------------------------------------------------------- membres */

async function membres() {
  const lignes = await q(supabase.from('utilisateurs').select('id, email, nom, prenom, role, actif').eq('actif', true).order('id'));
  return lignes.filter((u) => u.role !== 'client').map((u) => ({ ...u, nom_complet: nomMembre(u) }));
}

function nomMembre(u) {
  return u ? ([u.prenom, u.nom].filter(Boolean).join(' ') || u.email) : '';
}

/* ------------------------------------------------------------- résumés */

const parId = (lignes, cle = 'id') => new Map(lignes.map((l) => [l[cle], l]));
function grouper(lignes, cle) {
  const m = new Map();
  for (const l of lignes) {
    if (!m.has(l[cle])) m.set(l[cle], []);
    m.get(l[cle]).push(l);
  }
  return m;
}

/** Ce qu'une liste de dossiers affiche : client, parties, avancement, prochaine échéance. */
async function resumer(dossiers) {
  if (!dossiers.length) return [];
  const ids = dossiers.map((d) => d.id);
  const clientsIds = [...new Set(dossiers.map((d) => d.client_id).filter(Boolean))];
  const [etapes, parties, echeances, taches, clients, utilisateurs] = await Promise.all([
    q(supabase.from('etapes').select('id, dossier_id, ordre, libelle, statut, date_prevue').in('dossier_id', ids).order('ordre')),
    q(supabase.from('dossier_parties').select('id, dossier_id, societe_id, denomination, role').in('dossier_id', ids)),
    q(supabase.from('echeances').select('id, dossier_id, libelle, date, statut').in('dossier_id', ids).eq('statut', 'a_venir').order('date')),
    q(supabase.from('taches').select('id, dossier_id, statut').in('dossier_id', ids).eq('statut', 'a_faire')),
    clientsIds.length ? q(supabase.from('clients').select('id, nom, nature').in('id', clientsIds)) : [],
    q(supabase.from('utilisateurs').select('id, nom, prenom, email')),
  ]);
  const E = grouper(etapes, 'dossier_id');
  const P = grouper(parties, 'dossier_id');
  const EC = grouper(echeances, 'dossier_id');
  const T = grouper(taches, 'dossier_id');
  const C = parId(clients);
  const U = parId(utilisateurs);
  return dossiers.map((d) => {
    const es = (E.get(d.id) || []).sort((a, b) => a.ordre - b.ordre);
    const utiles = es.filter((x) => x.statut !== 'sans_objet');
    const courante = utiles.find((x) => x.statut !== 'fait') || null;
    const prochaines = [...(EC.get(d.id) || [])];
    if (d.echeance) prochaines.push({ libelle: 'Échéance du dossier', date: d.echeance });
    prochaines.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return {
      ...d,
      famille_libelle: types.FAMILLES[d.famille]?.libelle || d.famille,
      type_libelle: types.type(d.type)?.libelle || d.type,
      client_nom: C.get(d.client_id)?.nom || '',
      responsable_nom: nomMembre(U.get(d.responsable_id)),
      parties: (P.get(d.id) || []).map((p) => ({ ...p, role_libelle: types.type(d.type)?.roles?.[p.role] || p.role })),
      etapes: es.map((x) => ({ id: x.id, libelle: x.libelle, statut: x.statut })),
      etapes_total: utiles.length,
      etapes_faites: utiles.filter((x) => x.statut === 'fait').length,
      etape_courante: courante ? { id: courante.id, libelle: courante.libelle, date_prevue: courante.date_prevue } : null,
      prochaine_echeance: prochaines[0] || null,
      taches_ouvertes: (T.get(d.id) || []).length,
    };
  });
}

/* --------------------------------------------------------------- dossiers */

async function lister({ famille, statut = 'actifs', client_id } = {}) {
  let requete = supabase.from('dossiers').select('*').order('created_at', { ascending: false });
  if (famille) requete = requete.eq('famille', famille);
  if (client_id) requete = requete.eq('client_id', client_id);
  if (statut === 'actifs') requete = requete.in('statut', ACTIFS);
  else if (statut === 'clos') requete = requete.in('statut', ['clos', 'abandonne']);
  return resumer(await q(requete));
}

async function prochaineReference() {
  const annee = new Date().getFullYear();
  const lignes = await q(supabase.from('dossiers').select('reference').like('reference', `${annee}-%`)
    .order('reference', { ascending: false }).limit(1));
  const numeros = lignes.map((l) => l.reference).filter((r) => r.startsWith(`${annee}-`)).map((r) => Number(r.split('-')[1]) || 0);
  return `${annee}-${String(Math.max(0, ...numeros) + 1).padStart(4, '0')}`;
}

async function lireClient(id) {
  return q(supabase.from('clients').select('*').eq('id', id).single()).catch(() => { throw erreur('Client introuvable.', 404); });
}

/** Parties du dossier : une société de la base (societe_id) ou une simple dénomination. */
async function preparerParties(liste, roles) {
  const sortie = [];
  for (const p of liste || []) {
    const societeId = idOuNull(p.societe_id);
    let denomination = texte(p.denomination);
    if (societeId) {
      const s = await q(supabase.from('societes').select('id, denomination, forme_sociale').eq('id', societeId).single())
        .catch(() => { throw erreur('Société introuvable.', 404); });
      denomination = s.denomination;
    }
    if (!denomination) continue;
    const role = p.role && roles[p.role] ? p.role : 'concernee';
    sortie.push({ societe_id: societeId, denomination, role });
  }
  return sortie;
}

async function creer(payload = {}) {
  const t = types.type(payload.type);
  if (!t) throw erreur('Choisissez le type de dossier.');
  const { donnees, manquants } = types.nettoyerDonnees(payload.type, payload.donnees || {});
  if (manquants.length) throw erreur(`À renseigner : ${manquants.join(', ')}.`);

  let client;
  if (payload.client_id) client = await lireClient(payload.client_id);
  else if (texte(payload.nouveau_client?.nom)) client = await creerClient(payload.nouveau_client);
  else throw erreur('Indiquez le client.');

  const parties = await preparerParties(payload.parties, t.roles);
  const titre = texte(payload.titre) || `${t.libelle} — ${parties[0]?.denomination || client.nom}`;
  const u = utilisateurCourant();

  let dossier = null;
  for (let essai = 0; !dossier; essai += 1) {
    try {
      dossier = await q(supabase.from('dossiers').insert({
        reference: await prochaineReference(), client_id: client.id, famille: t.famille, type: payload.type,
        titre: titre.slice(0, 300), statut: 'en_cours',
        responsable_id: payload.responsable_id !== undefined ? idOuNull(payload.responsable_id) : (u?.id || null),
        echeance: dateOuNull(payload.echeance) || types.echeanceDepuisDonnees(payload.type, donnees),
        donnees, notes: texte(payload.notes),
      }).select().single());
    } catch (e) {
      // Deux ouvertures simultanées : la référence suivante est reprise.
      if (essai < 3 && /duplicate key|unique/i.test(e.message)) continue;
      throw e;
    }
  }

  const etapes = types.etapesModele(payload.type, await modeles());
  if (etapes.length) {
    await q(supabase.from('etapes').insert(etapes.map((x, i) => ({
      dossier_id: dossier.id, ordre: i + 1, code: x.code || '', libelle: x.libelle,
    }))).select());
  }
  if (parties.length) await q(supabase.from('dossier_parties').insert(parties.map((p) => ({ ...p, dossier_id: dossier.id }))).select());

  // Échéances légales, quand une règle sûre existe (forme de la première société de la base).
  const societe = parties.find((p) => p.societe_id);
  const forme = societe ? (await q(supabase.from('societes').select('forme_sociale').eq('id', societe.societe_id).single())).forme_sociale : '';
  const calculees = echeancesLegales.calculer(payload.type, donnees, forme);
  if (calculees.length) {
    await q(supabase.from('echeances').insert(calculees.map((x) => ({
      ...x, dossier_id: dossier.id, societe_id: societe?.societe_id || null, origine: 'calcul',
    }))).select());
  }

  await journal(dossier.id, 'ouverture', `Dossier ouvert : ${dossier.titre}.`, { details: { type: payload.type } });
  return lire(dossier.id);
}

async function lireDossier(id) {
  return q(supabase.from('dossiers').select('*').eq('id', id).single()).catch(() => { throw erreur('Dossier introuvable.', 404); });
}

async function lire(id) {
  id = Number(id);
  const d = await lireDossier(id);
  const [resume] = await resumer([d]);
  const [client, etapes, taches, echeances, evenements, intervenants, operations, formalites, utilisateurs] = await Promise.all([
    d.client_id ? q(supabase.from('clients').select('*').eq('id', d.client_id).single()).catch(() => null) : null,
    q(supabase.from('etapes').select('*').eq('dossier_id', id).order('ordre')),
    q(supabase.from('taches').select('*').eq('dossier_id', id).order('created_at')),
    q(supabase.from('echeances').select('*').eq('dossier_id', id).order('date')),
    q(supabase.from('evenements').select('*').eq('dossier_id', id).order('date', { ascending: false }).limit(200)),
    q(supabase.from('dossier_intervenants').select('*').eq('dossier_id', id)),
    q(supabase.from('operations').select('id, libelle, type, statut, societe_id, created_at').eq('dossier_id', id)),
    q(supabase.from('formalites').select('id, type, libelle, reference, statut, statut_inpi, societe_id, created_at').eq('dossier_id', id)),
    q(supabase.from('utilisateurs').select('id, nom, prenom, email')),
  ]);
  const U = parId(utilisateurs);
  const t = types.type(d.type);

  // Travaux des sociétés du dossier pas encore rattachés : proposés au rattachement.
  const societes = [...new Set(resume.parties.map((p) => p.societe_id).filter(Boolean))];
  const [opsLibres, formLibres] = societes.length ? await Promise.all([
    q(supabase.from('operations').select('id, libelle, societe_id, dossier_id').in('societe_id', societes)),
    q(supabase.from('formalites').select('id, type, libelle, societe_id, dossier_id').in('societe_id', societes)),
  ]) : [[], []];

  return {
    ...resume,
    client,
    type_info: t ? { libelle: t.libelle, champs: t.champs, roles: t.roles } : null,
    etapes,
    taches: taches.map((x) => ({ ...x, responsable_nom: nomMembre(U.get(x.responsable_id)) })),
    echeances,
    evenements: evenements.map((x) => ({ ...x, auteur_nom: x.origine === 'agent' ? 'Assistant' : nomMembre(U.get(x.auteur_id)) || 'Application' })),
    intervenants,
    operations,
    formalites,
    rattachables: {
      operations: opsLibres.filter((o) => !o.dossier_id),
      formalites: formLibres.filter((f) => !f.dossier_id),
    },
    actions: actions.pour(resume),
  };
}

const MODIFIABLES = ['titre', 'statut', 'responsable_id', 'echeance', 'notes', 'client_id'];

async function modifier(id, champs = {}) {
  const avant = await lireDossier(id);
  const maj = {};
  for (const c of MODIFIABLES) if (c in champs) maj[c] = champs[c];
  if ('titre' in maj && !texte(maj.titre)) throw erreur('Le titre ne peut pas être vide.');
  if ('statut' in maj && !types.STATUTS[maj.statut]) throw erreur('Statut inconnu.');
  if ('responsable_id' in maj) maj.responsable_id = idOuNull(maj.responsable_id);
  if ('client_id' in maj) maj.client_id = idOuNull(maj.client_id);
  if ('echeance' in maj) maj.echeance = dateOuNull(maj.echeance);
  if ('notes' in maj) maj.notes = texte(maj.notes);
  if (champs.donnees) {
    const { donnees, manquants } = types.nettoyerDonnees(avant.type, { ...avant.donnees, ...champs.donnees });
    if (manquants.length) throw erreur(`À renseigner : ${manquants.join(', ')}.`);
    maj.donnees = donnees;
  }
  if ('statut' in maj) maj.date_cloture = ['clos', 'abandonne'].includes(maj.statut) ? (avant.date_cloture || aujourdhui()) : null;
  maj.updated_at = new Date().toISOString();
  await q(supabase.from('dossiers').update(maj).eq('id', id).select());
  if ('statut' in maj && maj.statut !== avant.statut) {
    await journal(id, 'statut', `Statut : ${types.STATUTS[avant.statut]} → ${types.STATUTS[maj.statut]}.`);
  }
  if ('responsable_id' in maj && maj.responsable_id !== avant.responsable_id) {
    const u = maj.responsable_id ? (await membres()).find((m) => m.id === maj.responsable_id) : null;
    await journal(id, 'responsable', u ? `Responsable : ${u.nom_complet}.` : 'Dossier sans responsable.');
  }
  return lire(id);
}

async function supprimer(id, { confirmation } = {}) {
  const d = await lireDossier(id);
  if (texte(confirmation) !== d.reference) throw erreur(`Pour supprimer, retapez la référence du dossier (${d.reference}).`, 422);
  await q(supabase.from('dossiers').delete().eq('id', id).select());
  return { supprime: d.reference };
}

/* ------------------------------------------------------------- étapes */

async function ajouterEtape(dossierId, { libelle } = {}) {
  dossierId = Number(dossierId);
  if (!texte(libelle)) throw erreur('Libellé de l’étape requis.');
  await lireDossier(dossierId);
  const existantes = await q(supabase.from('etapes').select('ordre').eq('dossier_id', dossierId));
  const ordre = existantes.reduce((m, x) => Math.max(m, x.ordre), 0) + 1;
  await q(supabase.from('etapes').insert({ dossier_id: dossierId, ordre, libelle: texte(libelle) }).select());
  await journal(dossierId, 'etape', `Étape ajoutée : ${texte(libelle)}.`);
  return lire(dossierId);
}

const STATUTS_ETAPE = { a_faire: 'à faire', en_cours: 'en cours', fait: 'faite', sans_objet: 'sans objet' };

async function majEtape(etapeId, champs = {}) {
  const e = await q(supabase.from('etapes').select('*').eq('id', etapeId).single()).catch(() => { throw erreur('Étape introuvable.', 404); });
  const maj = {};
  if ('libelle' in champs && texte(champs.libelle)) maj.libelle = texte(champs.libelle);
  if ('date_prevue' in champs) maj.date_prevue = dateOuNull(champs.date_prevue);
  if ('date_realisee' in champs) maj.date_realisee = dateOuNull(champs.date_realisee);
  if ('statut' in champs) {
    if (!STATUTS_ETAPE[champs.statut]) throw erreur('Statut d’étape inconnu.');
    maj.statut = champs.statut;
    if (champs.statut === 'fait' && !maj.date_realisee && !e.date_realisee) maj.date_realisee = aujourdhui();
    if (champs.statut !== 'fait') maj.date_realisee = null;
  }
  await q(supabase.from('etapes').update(maj).eq('id', etapeId).select());
  if (maj.statut && maj.statut !== e.statut) {
    await journal(e.dossier_id, 'etape', `Étape « ${maj.libelle || e.libelle} » : ${STATUTS_ETAPE[maj.statut]}.`, { objet_table: 'etapes', objet_id: e.id });
  }
  return lire(e.dossier_id);
}

async function supprimerEtape(etapeId) {
  const e = await q(supabase.from('etapes').select('*').eq('id', etapeId).single()).catch(() => { throw erreur('Étape introuvable.', 404); });
  await q(supabase.from('etapes').delete().eq('id', etapeId).select());
  await journal(e.dossier_id, 'etape', `Étape retirée : ${e.libelle}.`);
  return lire(e.dossier_id);
}

/* -------------------------------------------------------------- tâches */

async function ajouterTache(dossierId, { titre, echeance, responsable_id, etape_id } = {}) {
  dossierId = Number(dossierId);
  if (!texte(titre)) throw erreur('Intitulé de la tâche requis.');
  await lireDossier(dossierId);
  await q(supabase.from('taches').insert({
    dossier_id: dossierId, titre: texte(titre), echeance: dateOuNull(echeance),
    responsable_id: idOuNull(responsable_id) ?? utilisateurCourant()?.id ?? null, etape_id: idOuNull(etape_id),
  }).select());
  return lire(dossierId);
}

async function majTache(tacheId, champs = {}) {
  const t = await q(supabase.from('taches').select('*').eq('id', tacheId).single()).catch(() => { throw erreur('Tâche introuvable.', 404); });
  const maj = {};
  if ('titre' in champs && texte(champs.titre)) maj.titre = texte(champs.titre);
  if ('echeance' in champs) maj.echeance = dateOuNull(champs.echeance);
  if ('responsable_id' in champs) maj.responsable_id = idOuNull(champs.responsable_id);
  if ('statut' in champs) {
    if (!['a_faire', 'fait'].includes(champs.statut)) throw erreur('Statut de tâche inconnu.');
    maj.statut = champs.statut;
    maj.fait_le = champs.statut === 'fait' ? new Date().toISOString() : null;
  }
  await q(supabase.from('taches').update(maj).eq('id', tacheId).select());
  if (maj.statut === 'fait' && t.statut !== 'fait') {
    await journal(t.dossier_id, 'tache', `Tâche faite : ${t.titre}.`, { objet_table: 'taches', objet_id: t.id });
  }
  return lire(t.dossier_id);
}

async function supprimerTache(tacheId) {
  const t = await q(supabase.from('taches').select('dossier_id').eq('id', tacheId).single()).catch(() => { throw erreur('Tâche introuvable.', 404); });
  await q(supabase.from('taches').delete().eq('id', tacheId).select());
  return lire(t.dossier_id);
}

/* ------------------------------------------------------------ échéances */

async function ajouterEcheance(dossierId, { libelle, date, base_legale, nature } = {}) {
  dossierId = Number(dossierId);
  if (!texte(libelle) || !dateOuNull(date)) throw erreur('Libellé et date de l’échéance requis.');
  await lireDossier(dossierId);
  await q(supabase.from('echeances').insert({
    dossier_id: dossierId, libelle: texte(libelle), date, base_legale: texte(base_legale), nature: texte(nature) || 'autre',
  }).select());
  await journal(dossierId, 'echeance', `Échéance ajoutée : ${texte(libelle)} (${date}).`);
  return lire(dossierId);
}

async function majEcheance(echeanceId, champs = {}) {
  const x = await q(supabase.from('echeances').select('*').eq('id', echeanceId).single()).catch(() => { throw erreur('Échéance introuvable.', 404); });
  const maj = {};
  if ('libelle' in champs && texte(champs.libelle)) maj.libelle = texte(champs.libelle);
  if ('date' in champs && dateOuNull(champs.date)) maj.date = champs.date;
  if ('statut' in champs) {
    if (!['a_venir', 'faite', 'sans_objet'].includes(champs.statut)) throw erreur('Statut d’échéance inconnu.');
    maj.statut = champs.statut;
  }
  await q(supabase.from('echeances').update(maj).eq('id', echeanceId).select());
  if (maj.statut === 'faite' && x.statut !== 'faite' && x.dossier_id) {
    await journal(x.dossier_id, 'echeance', `Échéance tenue : ${x.libelle}.`, { objet_table: 'echeances', objet_id: x.id });
  }
  return x.dossier_id ? lire(x.dossier_id) : maj;
}

async function supprimerEcheance(echeanceId) {
  const x = await q(supabase.from('echeances').select('dossier_id').eq('id', echeanceId).single()).catch(() => { throw erreur('Échéance introuvable.', 404); });
  await q(supabase.from('echeances').delete().eq('id', echeanceId).select());
  return lire(x.dossier_id);
}

/* ----------------------------------------------------- parties, notes, liens */

async function ajouterPartie(dossierId, partie = {}) {
  dossierId = Number(dossierId);
  const d = await lireDossier(dossierId);
  const [p] = await preparerParties([partie], types.type(d.type)?.roles || {});
  if (!p) throw erreur('Choisissez une société ou saisissez une dénomination.');
  await q(supabase.from('dossier_parties').insert({ ...p, dossier_id: dossierId }).select());
  await journal(dossierId, 'partie', `Société ajoutée : ${p.denomination}.`);
  return lire(dossierId);
}

async function supprimerPartie(partieId) {
  const p = await q(supabase.from('dossier_parties').select('*').eq('id', partieId).single()).catch(() => { throw erreur('Partie introuvable.', 404); });
  await q(supabase.from('dossier_parties').delete().eq('id', partieId).select());
  await journal(p.dossier_id, 'partie', `Société retirée : ${p.denomination}.`);
  return lire(p.dossier_id);
}

async function ajouterNote(dossierId, { texte: contenu } = {}) {
  dossierId = Number(dossierId);
  if (!texte(contenu)) throw erreur('Note vide.');
  await lireDossier(dossierId);
  await journal(dossierId, 'note', texte(contenu));
  return lire(dossierId);
}

const LIENS = { operations: 'Opération', formalites: 'Formalité' };

/** Rattache (ou détache) une opération ou une formalité existante au dossier. */
async function lier(dossierId, { table, objet_id, rattacher = true } = {}) {
  dossierId = Number(dossierId);
  if (!LIENS[table]) throw erreur('Seules les opérations et les formalités se rattachent.');
  await lireDossier(dossierId);
  const objet = await q(supabase.from(table).select('id, libelle, dossier_id').eq('id', objet_id).single()).catch(() => { throw erreur('Élément introuvable.', 404); });
  await q(supabase.from(table).update({ dossier_id: rattacher ? Number(dossierId) : null }).eq('id', objet_id).select());
  await journal(dossierId, 'lien', `${LIENS[table]} ${rattacher ? 'rattachée' : 'détachée'} : ${objet.libelle}.`, { objet_table: table, objet_id: objet.id });
  return lire(dossierId);
}

/** Inscription par un autre module (opération créée depuis le dossier, formalité…). */
async function signaler(dossierId, nature, resume, objet = {}) {
  if (!dossierId) return;
  await journal(dossierId, nature, resume, objet);
}

async function executerAction(dossierId, actionId, params) {
  const [resume] = await resumer([await lireDossier(dossierId)]);
  return actions.executer(actionId, resume, params);
}

/* ---------------------------------------------------------------- clients */

const NATURES = { groupe: 'Groupe', societe: 'Société', personne: 'Personne physique' };

async function creerClient(champs = {}) {
  const nom = texte(champs.nom);
  if (!nom) throw erreur('Nom du client requis.');
  const nature = NATURES[champs.nature] ? champs.nature : 'societe';
  return q(supabase.from('clients').insert({
    nom, nature, groupe_id: idOuNull(champs.groupe_id), societe_id: idOuNull(champs.societe_id),
    email: texte(champs.email) || null, telephone: texte(champs.telephone) || null,
    adresse: texte(champs.adresse), notes: texte(champs.notes),
  }).select().single());
}

async function modifierClient(id, champs = {}) {
  await lireClient(id);
  const maj = {};
  for (const c of ['nom', 'adresse', 'notes']) if (c in champs) maj[c] = texte(champs[c]);
  for (const c of ['email', 'telephone']) if (c in champs) maj[c] = texte(champs[c]) || null;
  for (const c of ['groupe_id', 'societe_id']) if (c in champs) maj[c] = idOuNull(champs[c]);
  if ('nature' in champs && NATURES[champs.nature]) maj.nature = champs.nature;
  if ('nom' in maj && !maj.nom) throw erreur('Nom du client requis.');
  await q(supabase.from('clients').update(maj).eq('id', id).select());
  return ficheClient(id);
}

async function listerClients() {
  const [clients, dossiers, echeances] = await Promise.all([
    q(supabase.from('clients').select('*').order('nom')),
    q(supabase.from('dossiers').select('id, client_id, statut, echeance')),
    q(supabase.from('echeances').select('dossier_id, date, libelle').eq('statut', 'a_venir').order('date')),
  ]);
  const parDossier = parId(dossiers);
  return clients.map((c) => {
    const siens = dossiers.filter((d) => d.client_id === c.id);
    const actifs = siens.filter((d) => ACTIFS.includes(d.statut));
    const prochaine = echeances.find((x) => parDossier.get(x.dossier_id)?.client_id === c.id && ACTIFS.includes(parDossier.get(x.dossier_id)?.statut));
    return { ...c, nature_libelle: NATURES[c.nature], dossiers_actifs: actifs.length, dossiers_total: siens.length, prochaine_echeance: prochaine || null };
  });
}

/** Fiche client : contacts, dossiers des trois familles, sociétés, échéances. */
async function ficheClient(id) {
  const client = await lireClient(id);
  const [contacts, dossiers] = await Promise.all([
    q(supabase.from('contacts').select('*').eq('client_id', id).order('nom')),
    q(supabase.from('dossiers').select('*').eq('client_id', id).order('created_at', { ascending: false })),
  ]);
  const resumes = await resumer(dossiers);
  const ids = dossiers.map((d) => d.id);
  const echeances = ids.length
    ? await q(supabase.from('echeances').select('*').in('dossier_id', ids).eq('statut', 'a_venir').order('date'))
    : [];
  // Sociétés liées : celle du client, celles de son groupe, celles de ses dossiers.
  const societesIds = new Set();
  if (client.societe_id) societesIds.add(client.societe_id);
  if (client.groupe_id) (await q(supabase.from('societes').select('id').eq('groupe_id', client.groupe_id))).forEach((s) => societesIds.add(s.id));
  resumes.forEach((d) => d.parties.forEach((p) => p.societe_id && societesIds.add(p.societe_id)));
  const societes = societesIds.size
    ? await q(supabase.from('societes').select('id, denomination, forme_sociale, siren, date_cloture').in('id', [...societesIds]))
    : [];
  const titreDossier = parId(dossiers);
  return {
    ...client,
    nature_libelle: NATURES[client.nature],
    contacts,
    dossiers: resumes,
    societes,
    echeances: echeances.map((x) => ({ ...x, dossier_reference: titreDossier.get(x.dossier_id)?.reference, dossier_titre: titreDossier.get(x.dossier_id)?.titre })),
  };
}

async function creerContact(clientId, champs = {}) {
  await lireClient(clientId);
  if (!texte(champs.nom)) throw erreur('Nom du contact requis.');
  await q(supabase.from('contacts').insert({
    client_id: Number(clientId), societe_id: idOuNull(champs.societe_id), civilite: texte(champs.civilite),
    nom: texte(champs.nom), prenom: texte(champs.prenom), fonction: texte(champs.fonction),
    email: texte(champs.email).toLowerCase() || null, telephone: texte(champs.telephone) || null, notes: texte(champs.notes),
  }).select());
  return ficheClient(clientId);
}

async function modifierContact(contactId, champs = {}) {
  const c = await q(supabase.from('contacts').select('*').eq('id', contactId).single()).catch(() => { throw erreur('Contact introuvable.', 404); });
  const maj = {};
  for (const k of ['civilite', 'nom', 'prenom', 'fonction', 'notes']) if (k in champs) maj[k] = texte(champs[k]);
  if ('email' in champs) maj.email = texte(champs.email).toLowerCase() || null;
  if ('telephone' in champs) maj.telephone = texte(champs.telephone) || null;
  if ('nom' in maj && !maj.nom) throw erreur('Nom du contact requis.');
  await q(supabase.from('contacts').update(maj).eq('id', contactId).select());
  return ficheClient(c.client_id);
}

async function supprimerContact(contactId) {
  const c = await q(supabase.from('contacts').select('client_id').eq('id', contactId).single()).catch(() => { throw erreur('Contact introuvable.', 404); });
  await q(supabase.from('contacts').delete().eq('id', contactId).select());
  return ficheClient(c.client_id);
}

/* --------------------------------------------------------------- synthèse */

/** Pour le tableau de bord : dossiers en cours par famille, échéances proches ou dépassées. */
async function synthese({ jours = 30 } = {}) {
  const [dossiers, echeances, taches] = await Promise.all([
    q(supabase.from('dossiers').select('id, reference, titre, famille, statut, echeance').in('statut', ACTIFS)),
    q(supabase.from('echeances').select('id, dossier_id, libelle, date, base_legale').eq('statut', 'a_venir').order('date')),
    q(supabase.from('taches').select('id, dossier_id, titre, echeance, responsable_id').eq('statut', 'a_faire').order('echeance')),
  ]);
  const D = parId(dossiers);
  const limite = new Date(Date.now() + jours * 86400000).toISOString().slice(0, 10);
  const avecDossier = (x) => ({ ...x, dossier_reference: D.get(x.dossier_id)?.reference, dossier_titre: D.get(x.dossier_id)?.titre });
  const u = utilisateurCourant();
  return {
    par_famille: Object.fromEntries(Object.keys(types.FAMILLES).map((f) => [f, dossiers.filter((d) => d.famille === f).length])),
    echeances: echeances.filter((x) => D.has(x.dossier_id) && x.date <= limite).map(avecDossier),
    mes_taches: taches.filter((t) => D.has(t.dossier_id) && (!u || t.responsable_id === u.id)).map(avecDossier),
  };
}

module.exports = {
  catalogue, majModele, reinitialiserModele, membres,
  lister, creer, lire, modifier, supprimer,
  ajouterEtape, majEtape, supprimerEtape,
  ajouterTache, majTache, supprimerTache,
  ajouterEcheance, majEcheance, supprimerEcheance,
  ajouterPartie, supprimerPartie, ajouterNote, lier, signaler, executerAction,
  listerClients, creerClient, modifierClient, ficheClient, creerContact, modifierContact, supprimerContact,
  synthese, NATURES,
};
