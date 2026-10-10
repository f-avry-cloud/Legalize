'use strict';

/**
 * Revue quotidienne des mails : lecture, et application des propositions.
 *
 * La revue est déposée par la tâche programmée (scripts/schema-revues.sql,
 * agent_deposer_revue). L'assistant ne fait que proposer : chaque
 * proposition s'applique ici, au clic d'un membre du cabinet, par les mêmes
 * fonctions que les écrans (création de dossier, tâche, échéance…).
 *
 * Un dossier proposé (pas encore créé) est désigné par une clé : à sa
 * validation, les mails et les propositions qui portent cette clé lui sont
 * rattachés.
 */

const { supabase, q, utilisateurCourant } = require('../../supa');
const dossiers = require('../dossiers/service');
const types = require('../dossiers/types');

const erreur = (message, status = 400) => Object.assign(new Error(message), { status });
const PRIORITES = { haute: 0, normale: 1, basse: 2, terminee: 3 };
const LIBELLES = {
  creer_dossier: 'Ouvrir le dossier',
  creer_tache: 'Ajouter la tâche',
  tache_faite: 'Marquer la tâche faite',
  creer_echeance: 'Ajouter l’échéance',
  echeance_tenue: 'Marquer l’échéance tenue',
  etape_faite: 'Marquer l’étape faite',
  ajouter_contact: 'Ajouter le contact',
  changer_statut: 'Changer le statut',
};

/* ------------------------------------------------------------- lecture */

async function liste() {
  const [revues, enAttente] = await Promise.all([
    q(supabase.from('revues').select('id, date_revue, moment, statut, stats, created_at').order('id', { ascending: false }).limit(60)),
    q(supabase.from('propositions').select('id, revue_id').eq('statut', 'proposee')),
  ]);
  return revues.map((r) => ({ ...r, en_attente: enAttente.filter((p) => p.revue_id === r.id).length }));
}

/** Nombre de propositions en attente, pour la pastille du menu. */
async function enAttente() {
  const lignes = await q(supabase.from('propositions').select('id').eq('statut', 'proposee'));
  return { propositions: lignes.length };
}

/** Une revue (la dernière par défaut), organisée par dossier. */
async function lire(id) {
  let revue;
  if (!id || id === 'derniere') {
    [revue] = await q(supabase.from('revues').select('*').order('id', { ascending: false }).limit(1));
    if (!revue) return { revue: null, revues: await liste() };
  } else {
    revue = await q(supabase.from('revues').select('*').eq('id', id).single()).catch(() => { throw erreur('Revue introuvable.', 404); });
  }
  const [blocs, emails, propositions, actifs, revues] = await Promise.all([
    q(supabase.from('revue_dossiers').select('*').eq('revue_id', revue.id)),
    q(supabase.from('emails').select('id, message_id, sens, expediteur, objet, date, resume, lien, dossier_id, dossier_cle, statut')
      .eq('revue_id', revue.id).order('date')),
    q(supabase.from('propositions').select('*').eq('revue_id', revue.id).order('id')),
    q(supabase.from('dossiers').select('id, reference, titre, famille, statut').order('reference', { ascending: false })),
    liste(),
  ]);
  const D = new Map(actifs.map((d) => [d.id, d]));
  const memeDossier = (x, b) => (b.dossier_id ? x.dossier_id === b.dossier_id : (b.cle && x.dossier_cle === b.cle && !x.dossier_id));
  const utiles = emails.filter((e) => e.statut !== 'ignore');
  const sections = blocs
    .sort((a, b) => (PRIORITES[a.priorite] - PRIORITES[b.priorite]) || (a.ordre - b.ordre))
    .map((b) => ({
      ...b,
      dossier: b.dossier_id ? D.get(b.dossier_id) || null : null,
      emails: utiles.filter((e) => memeDossier(e, b)),
      propositions: propositions.filter((p) => memeDossier(p, b)).map(decrire),
    }));
  const pris = new Set(sections.flatMap((s) => s.propositions.map((p) => p.id)));
  const prisMails = new Set(sections.flatMap((s) => s.emails.map((e) => e.id)));
  return {
    revue,
    sections,
    autres_propositions: propositions.filter((p) => !pris.has(p.id)).map(decrire),
    a_rattacher: utiles.filter((e) => !prisMails.has(e.id)),
    ecartes: emails.length - utiles.length,
    dossiers: actifs.filter((d) => ['en_cours', 'en_attente', 'suspendu'].includes(d.statut)),
    revues,
  };
}

/** Une proposition telle que l'écran l'affiche. */
function decrire(p) {
  const d = p.donnees || {};
  const texte = {
    creer_dossier: `${d.titre || 'Nouveau dossier'}${d.type && types.type(d.type) ? ` (${types.type(d.type).libelle})` : ''}${d.client_nom ? ` — client : ${d.client_nom}` : ''}`,
    creer_tache: `${d.titre || ''}${d.echeance ? ` — pour le ${d.echeance}` : ''}`,
    tache_faite: d.titre || `Tâche n° ${d.tache_id}`,
    creer_echeance: `${d.libelle || ''}${d.date ? ` — ${d.date}` : ''}`,
    echeance_tenue: d.libelle || `Échéance n° ${d.echeance_id}`,
    etape_faite: d.libelle || `Étape n° ${d.etape_id}`,
    ajouter_contact: [d.prenom, d.nom].filter(Boolean).join(' ') + (d.email ? ` <${d.email}>` : '') + (d.fonction ? ` — ${d.fonction}` : ''),
    changer_statut: types.STATUTS[d.statut] || d.statut || '',
  }[p.nature] || '';
  return { ...p, libelle: LIBELLES[p.nature] || p.nature, texte };
}

/* ---------------------------------------------------------- application */

async function lireProposition(id) {
  return q(supabase.from('propositions').select('*').eq('id', id).single()).catch(() => { throw erreur('Proposition introuvable.', 404); });
}

/** Le dossier visé : celui de la proposition, ou celui créé depuis sa clé. */
function dossierVise(p) {
  if (p.dossier_id) return p.dossier_id;
  throw erreur(p.dossier_cle ? 'Ouvrez d’abord le dossier proposé : cette proposition s’y rattache.' : 'Proposition sans dossier.', 409);
}

/** Rattache au dossier créé tout ce qui portait sa clé. */
async function resoudreCle(cle, dossierId) {
  if (!cle) return;
  await q(supabase.from('emails').update({ dossier_id: dossierId, dossier_cle: null, statut: 'rattache' })
    .eq('dossier_cle', cle).eq('statut', 'propose').select('id'));
  await q(supabase.from('propositions').update({ dossier_id: dossierId }).eq('dossier_cle', cle).eq('statut', 'proposee').select('id'));
  await q(supabase.from('revue_dossiers').update({ dossier_id: dossierId }).eq('cle', cle).select('id'));
}

const APPLIQUER = {
  async creer_dossier(p, modifs) {
    const d = { ...p.donnees, ...modifs };
    const t = types.type(d.type);
    if (!t) throw erreur('Choisissez le type de dossier avant de l’ouvrir.');
    const corps = {
      type: d.type, titre: d.titre, donnees: d.donnees || {}, echeance: d.echeance || null,
      parties: (d.parties || []).map((x) => ({ societe_id: x.societe_id || null, denomination: x.denomination, role: x.role })),
    };
    const clientId = Number(d.client_id) || null;
    if (clientId) corps.client_id = clientId;
    else corps.nouveau_client = { nom: d.client_nom || d.titre, nature: d.client_nature || 'societe' };
    const cree = await dossiers.creer(corps);
    await resoudreCle(p.dossier_cle, cree.id);
    await dossiers.signaler(cree.id, 'ouverture', 'Ouvert à partir de la revue des mails.', { origine: 'agent', objet_table: 'propositions', objet_id: p.id });
    return { dossier_id: cree.id, reference: cree.reference };
  },
  async creer_tache(p) {
    const r = await dossiers.ajouterTache(dossierVise(p), { titre: p.donnees.titre, echeance: p.donnees.echeance, origine: 'agent' });
    return { dossier_id: r.id };
  },
  async tache_faite(p) {
    const r = await dossiers.majTache(p.donnees.tache_id, { statut: 'fait' });
    return { dossier_id: r.id };
  },
  async creer_echeance(p) {
    const r = await dossiers.ajouterEcheance(dossierVise(p), { libelle: p.donnees.libelle, date: p.donnees.date, base_legale: p.donnees.base_legale });
    return { dossier_id: r.id };
  },
  async echeance_tenue(p) {
    await dossiers.majEcheance(p.donnees.echeance_id, { statut: 'faite' });
    return {};
  },
  async etape_faite(p) {
    const r = await dossiers.majEtape(p.donnees.etape_id, { statut: 'fait' });
    return { dossier_id: r.id };
  },
  async ajouter_contact(p) {
    let clientId = Number(p.donnees.client_id) || null;
    if (!clientId) {
      const d = await dossiers.lire(dossierVise(p));
      clientId = d.client_id;
    }
    if (!clientId) throw erreur('Ce dossier n’a pas de client : le contact ne peut pas être rangé.', 409);
    await dossiers.creerContact(clientId, p.donnees);
    return { client_id: clientId };
  },
  async changer_statut(p) {
    const r = await dossiers.modifier(dossierVise(p), { statut: p.donnees.statut });
    return { dossier_id: r.id };
  },
};

async function accepter(id, modifs = {}) {
  const p = await lireProposition(id);
  if (p.statut !== 'proposee') throw erreur('Cette proposition a déjà été traitée.', 409);
  // Ce que l'avocat a corrigé avant de valider prime sur la proposition.
  const resultat = await APPLIQUER[p.nature]({ ...p, donnees: { ...p.donnees, ...modifs } }, modifs);
  await q(supabase.from('propositions').update({
    statut: 'acceptee', resultat, decide_par: utilisateurCourant()?.id || null, decide_le: new Date().toISOString(),
    ...(Object.keys(modifs).length ? { donnees: { ...p.donnees, ...modifs } } : {}),
  }).eq('id', id).select('id'));
  return { ...resultat, proposition_id: Number(id) };
}

/** Refus, éventuellement mémorisé comme règle (ignorer un expéditeur…). */
async function refuser(id, { regle } = {}) {
  const p = await lireProposition(id);
  if (p.statut !== 'proposee') throw erreur('Cette proposition a déjà été traitée.', 409);
  await q(supabase.from('propositions').update({
    statut: 'refusee', decide_par: utilisateurCourant()?.id || null, decide_le: new Date().toISOString(),
  }).eq('id', id).select('id'));
  if (regle?.nature && regle?.valeur) await ajouterRegle(regle);
  // Refuser l'ouverture d'un dossier, c'est aussi refuser ce qui s'y rattachait.
  if (p.nature === 'creer_dossier' && p.dossier_cle) {
    await q(supabase.from('propositions').update({ statut: 'refusee', decide_par: utilisateurCourant()?.id || null, decide_le: new Date().toISOString() })
      .eq('dossier_cle', p.dossier_cle).eq('statut', 'proposee').select('id'));
  }
  return { refusee: Number(id) };
}

/** Valide d'un coup un bloc : l'ouverture du dossier d'abord, puis le reste. */
async function accepterTout(revueId, { dossier_id: dossierId, cle } = {}) {
  const props = (await q(supabase.from('propositions').select('*').eq('revue_id', revueId).eq('statut', 'proposee').order('id')))
    .filter((p) => (dossierId ? p.dossier_id === Number(dossierId) : p.dossier_cle === cle));
  const ordre = [...props.filter((p) => p.nature === 'creer_dossier'), ...props.filter((p) => p.nature !== 'creer_dossier')];
  const faits = [];
  const echecs = [];
  for (const p of ordre) {
    try {
      faits.push(await accepter(p.id));
    } catch (e) { echecs.push({ id: p.id, erreur: e.message }); }
  }
  if (dossierId) await confirmerEmails(revueId, { dossier_id: dossierId });
  return { faits, echecs };
}

/* ------------------------------------------------------------------ mails */

async function confirmerEmails(revueId, { dossier_id: dossierId } = {}) {
  if (!dossierId) throw erreur('Dossier requis.');
  const lignes = await q(supabase.from('emails').update({ statut: 'rattache' })
    .eq('revue_id', revueId).eq('dossier_id', dossierId).eq('statut', 'propose').select('id'));
  return { rattaches: lignes.length };
}

/** Range un mail dans un dossier, ou l'écarte. */
async function rangerEmail(id, { dossier_id: dossierId, ignorer } = {}) {
  const maj = ignorer ? { statut: 'ignore', dossier_id: null, dossier_cle: null, resume: null }
    : { statut: 'rattache', dossier_id: Number(dossierId), dossier_cle: null };
  if (!ignorer && !dossierId) throw erreur('Choisissez le dossier.');
  const [ligne] = await q(supabase.from('emails').update(maj).eq('id', id).select('id, dossier_id, objet'));
  if (!ligne) throw erreur('Mail introuvable.', 404);
  if (!ignorer) await dossiers.signaler(ligne.dossier_id, 'lien', `Mail rattaché : ${ligne.objet || '(sans objet)'}.`, { objet_table: 'emails', objet_id: ligne.id });
  return ligne;
}

/* ----------------------------------------------------------------- règles */

const NATURES_REGLE = { ignorer_expediteur: 'Expéditeur', ignorer_domaine: 'Domaine', ignorer_objet: 'Objet contenant' };

async function regles() {
  return q(supabase.from('regles_agent').select('*').order('created_at', { ascending: false }));
}

async function ajouterRegle({ nature, valeur } = {}) {
  if (!NATURES_REGLE[nature] || !String(valeur || '').trim()) throw erreur('Règle incomplète.');
  const v = String(valeur).trim().toLowerCase();
  const existe = await q(supabase.from('regles_agent').select('id').eq('nature', nature).eq('valeur', v));
  if (!existe.length) await q(supabase.from('regles_agent').insert({ nature, valeur: v, cree_par: utilisateurCourant()?.id || null }).select('id'));
  return regles();
}

async function supprimerRegle(id) {
  await q(supabase.from('regles_agent').delete().eq('id', id).select('id'));
  return regles();
}

async function supprimerRevue(id) {
  await q(supabase.from('revues').delete().eq('id', id).select('id'));
  return { supprimee: Number(id) };
}

module.exports = {
  liste, enAttente, lire, accepter, refuser, accepterTout, confirmerEmails, rangerEmail,
  regles, ajouterRegle, supprimerRegle, supprimerRevue, NATURES_REGLE,
};
