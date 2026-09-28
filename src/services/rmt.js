'use strict';

/**
 * Registre des mouvements de titres — « le crayon et l'encre ».
 *
 * Toute écriture reste modifiable, déplaçable, supprimable. La sécurité ne
 * vient pas de l'immuabilité mais de l'historique complet des versions et des
 * extraits certifiés, qui figent un état daté et vérifiable.
 *
 * Deux conséquences dans ce fichier :
 *   — aucune écriture n'est jamais mise à jour ni effacée : on ajoute une
 *     version, y compris pour supprimer ;
 *   — le statut crayon / encre n'est jamais écrit : la base le déduit des
 *     extraits qui couvrent l'écriture (vue rmt_etat_mouvements).
 */

const crypto = require('node:crypto');
const { supabase, q: db } = require('../supa');

const FORMES_ADMISES = ['SA', 'SAS', 'SASU', 'SCA'];

const NATURES = {
  souscription: { libelle: 'Souscription', sens: 'credit', justificatif: 'bulletin_souscription' },
  cession: { libelle: 'Cession', sens: 'transfert', justificatif: 'ordre_mouvement' },
  apport: { libelle: 'Apport', sens: 'transfert', justificatif: 'ordre_mouvement' },
  donation: { libelle: 'Donation', sens: 'transfert', justificatif: 'acte_donation' },
  succession: { libelle: 'Succession', sens: 'transfert', justificatif: 'attestation_notariale' },
  fusion_tup: { libelle: 'Fusion / TUP', sens: 'transfert', justificatif: 'proces_verbal' },
  demembrement: { libelle: 'Démembrement', sens: 'transfert', justificatif: 'ordre_mouvement' },
  reunion_usufruit: { libelle: 'Réunion d’usufruit', sens: 'transfert', justificatif: 'ordre_mouvement' },
  conversion: { libelle: 'Conversion de catégorie', sens: 'transfert', justificatif: 'proces_verbal' },
  division_nominal: { libelle: 'Division du nominal', sens: 'neutre', justificatif: 'proces_verbal' },
  regroupement_nominal: { libelle: 'Regroupement du nominal', sens: 'neutre', justificatif: 'proces_verbal' },
  annulation: { libelle: 'Annulation (réduction de capital)', sens: 'debit', justificatif: 'proces_verbal' },
};

const STATUTS = {
  CRAYON: { libelle: 'Crayon', couleur: 'crayon', aide: 'Jamais certifiée. Modifiable et supprimable librement.' },
  ENCRE: { libelle: 'Encre', couleur: 'encre', aide: 'Couverte par un extrait certifié et inchangée depuis.' },
  ENCRE_MODIFIEE: { libelle: 'Encre modifiée', couleur: 'alerte', aide: 'Modifiée après avoir été certifiée. Les extraits concernés sont devenus inexacts.' },
  ENCRE_SUPPRIMEE: { libelle: 'Encre supprimée', couleur: 'danger', aide: 'Supprimée après avoir été certifiée.' },
};

/* ------------------------------------------------------------------ outils */

function erreur(message, status = 400, details) {
  const e = new Error(message);
  e.status = status;
  if (details) e.details = details;
  return e;
}

/** Les champs qui constituent le contenu d'une écriture, hors métadonnées. */
const CHAMPS_CONTENU = [
  'date_inscription', 'date_effet', 'nature', 'categorie_id', 'quantite',
  'numeros', 'compte_debite', 'compte_credite', 'prix_unitaire', 'prix_total',
  'devise', 'observations',
];

function contenuDe(source) {
  const c = {};
  for (const champ of CHAMPS_CONTENU) if (source[champ] !== undefined) c[champ] = source[champ];
  return c;
}

/** Journalise sans jamais faire échouer l'action qu'elle accompagne. */
async function journal(societeId, utilisateurId, action, objetType, objetId, details = {}) {
  try {
    await db(supabase.from('rmt_audit').insert({
      societe_id: societeId, utilisateur_id: utilisateurId || null,
      action, objet_type: objetType, objet_id: objetId, details,
    }));
  } catch { /* un journal muet vaut mieux qu'une écriture perdue */ }
}

/* -------------------------------------------------------------- la société */

/** Ouvre un registre. Refuse explicitement les formes à parts sociales. */
async function activer(societeId, params = {}) {
  const societe = await db(supabase.from('societes').select('*').eq('id', societeId).single());
  const forme = (params.forme || societe.forme_sociale || '').toUpperCase().replace(/[^A-Z]/g, '');

  if (!FORMES_ADMISES.includes(forme)) {
    throw erreur(
      `Forme « ${params.forme || societe.forme_sociale || 'non renseignée'} » hors périmètre. `
      + 'Le registre des mouvements de titres ne concerne que les sociétés par actions '
      + '(SA, SAS, SASU, SCA). Les parts sociales de SARL, SNC ou société civile ne se '
      + 'tiennent pas en comptes de titres : un registre les concernant serait faux.',
      422,
    );
  }

  const existant = await db(supabase.from('rmt_societes').select('societe_id').eq('societe_id', societeId));
  if (existant.length) throw erreur('Un registre existe déjà pour cette société.', 409);

  const cree = await db(supabase.from('rmt_societes').insert({
    societe_id: societeId,
    forme,
    titres_numerotes: Boolean(params.titres_numerotes),
    certifiant_type: params.certifiant_type || 'avocat',
    certifiant_nom: params.certifiant_nom || null,
    certifiant_qualite: params.certifiant_qualite || null,
    seuils_surveilles: params.seuils_surveilles || [],
  }).select().single());

  // Une catégorie d'actions ordinaires évite d'ouvrir sur un écran vide où
  // rien ne peut être saisi.
  await db(supabase.from('rmt_categories').insert({
    societe_id: societeId, code: 'ORD', libelle: 'Actions ordinaires',
    nominal: params.nominal ?? null, ordre: 0,
  }));

  await journal(societeId, params.utilisateur_id, 'registre.ouvert', 'societe', societeId, { forme });
  return cree;
}

/** Fiche registre : paramètres, catégories, comptes, réconciliation du capital. */
async function societe(societeId) {
  const [fiche] = await db(supabase.from('societes').select('*').eq('id', societeId));
  if (!fiche) throw erreur('Société inconnue.', 404);

  const params = (await db(supabase.from('rmt_societes').select('*').eq('societe_id', societeId)))[0] || null;
  if (!params) {
    return { societe: fiche, actif: false, forme_admise: FORMES_ADMISES.includes((fiche.forme_sociale || '').toUpperCase()) };
  }

  const [categories, comptes, titulaires, emissions, capital, extraits] = await Promise.all([
    db(supabase.from('rmt_categories').select('*').eq('societe_id', societeId).order('ordre')),
    db(supabase.from('rmt_comptes').select('*').eq('societe_id', societeId).order('numero')),
    db(supabase.from('rmt_titulaires').select('*').eq('societe_id', societeId).order('id')),
    db(supabase.from('rmt_titres_emis').select('*').eq('societe_id', societeId)),
    db(supabase.from('rmt_coherence_capital').select('*').eq('societe_id', societeId)),
    db(supabase.from('rmt_extraits').select('*').eq('societe_id', societeId).order('certifie_le', { ascending: false })),
  ]);

  return {
    societe: fiche,
    actif: true,
    parametres: params,
    categories,
    comptes: await enrichirComptes(comptes, titulaires),
    titulaires,
    emissions,
    capital: capital[0] || null,
    extraits,
    natures: NATURES,
    statuts: STATUTS,
  };
}

async function enrichirComptes(comptes, titulaires) {
  if (!comptes.length) return [];
  const liens = await db(supabase.from('rmt_comptes_titulaires').select('*')
    .in('compte_id', comptes.map((c) => c.id)));
  const soldes = await db(supabase.from('rmt_soldes').select('*')
    .in('compte_id', comptes.map((c) => c.id)));
  const parId = new Map(titulaires.map((t) => [t.id, t]));

  return comptes.map((c) => ({
    ...c,
    titulaires: liens.filter((l) => l.compte_id === c.id)
      .map((l) => ({ ...parId.get(l.titulaire_id), quote_part: l.quote_part })),
    solde: soldes.filter((s) => s.compte_id === c.id)
      .reduce((total, s) => total + Number(s.solde || 0), 0),
  }));
}

/** Nom lisible d'un compte, pour l'affichage et les libellés d'anomalie. */
function nommerCompte(compte) {
  if (!compte) return '—';
  const noms = (compte.titulaires || []).map((t) => t.denomination || [t.prenoms, t.nom].filter(Boolean).join(' '));
  return noms.length ? `${compte.numero} — ${noms.join(', ')}` : compte.numero;
}

/* ------------------------------------------------------------- les écritures */

/**
 * Le registre tel qu'il se lit : une ligne par écriture, avec son statut
 * déduit et, à la demande, les écritures supprimées.
 */
async function mouvements(societeId, { historique = false, date = null } = {}) {
  const etats = await db(supabase.from('rmt_etat_mouvements').select('*')
    .eq('societe_id', societeId).order('ordre'));
  if (!etats.length) return [];

  const versions = await db(supabase.from('rmt_versions_courantes').select('*')
    .in('mouvement_id', etats.map((e) => e.mouvement_id)));
  const parMouvement = new Map(versions.map((v) => [v.mouvement_id, v]));

  const nombreVersions = await db(supabase.from('rmt_mouvement_versions')
    .select('mouvement_id, numero_version').in('mouvement_id', etats.map((e) => e.mouvement_id)));

  let lignes = etats.map((e, i) => {
    const v = parMouvement.get(e.mouvement_id) || {};
    return {
      ...v,
      mouvement_id: e.mouvement_id,
      ordre: e.ordre,
      numero_affiche: i + 1,
      statut: e.statut,
      statut_libelle: STATUTS[e.statut]?.libelle || e.statut,
      dernier_extrait_id: e.dernier_extrait_id,
      supprimee: e.action === 'suppression',
      nature_libelle: NATURES[v.nature]?.libelle || v.nature,
      nb_versions: nombreVersions.filter((n) => n.mouvement_id === e.mouvement_id).length,
    };
  });

  if (!historique) lignes = lignes.filter((l) => !l.supprimee);
  if (date) lignes = lignes.filter((l) => (l.date_effet || l.date_inscription || '') <= date);

  // Le n° d'affichage se recalcule après filtrage : c'est un rang de lecture,
  // pas une donnée. L'identifiant interne, lui, ne bouge jamais.
  return lignes.map((l, i) => ({ ...l, numero_affiche: i + 1 }));
}

/** Ordre à donner pour insérer après une écriture : la moyenne, sans renuméroter. */
async function ordrePour(societeId, apresId) {
  const tous = await db(supabase.from('rmt_mouvements').select('id, ordre')
    .eq('societe_id', societeId).order('ordre'));
  if (!apresId) return tous.length ? Number(tous[tous.length - 1].ordre) + 1 : 1;

  const index = tous.findIndex((m) => m.id === Number(apresId));
  if (index === -1) return tous.length + 1;
  const avant = Number(tous[index].ordre);
  const apres = tous[index + 1] ? Number(tous[index + 1].ordre) : avant + 2;
  return (avant + apres) / 2;
}

async function creerMouvement(societeId, donnees, utilisateurId) {
  if (!NATURES[donnees.nature]) throw erreur(`Nature d’opération inconnue : ${donnees.nature}.`);

  const ordre = await ordrePour(societeId, donnees.apres_id);
  const mouvement = await db(supabase.from('rmt_mouvements')
    .insert({ societe_id: societeId, ordre }).select().single());

  await db(supabase.from('rmt_mouvement_versions').insert({
    mouvement_id: mouvement.id,
    numero_version: 1,
    action: 'creation',
    ...contenuDe(donnees),
    ordre_affiche: ordre,
    auteur_id: utilisateurId || null,
    motif_code: donnees.motif_code || null,
    motif: donnees.motif || null,
  }));

  await journal(societeId, utilisateurId, 'mouvement.cree', 'mouvement', mouvement.id, { nature: donnees.nature });
  return { mouvement_id: mouvement.id };
}

/** Statut courant et extraits qui couvrent une écriture. */
async function etat(mouvementId) {
  const [e] = await db(supabase.from('rmt_etat_mouvements').select('*').eq('mouvement_id', mouvementId));
  if (!e) throw erreur('Écriture inconnue.', 404);
  return e;
}

/**
 * Ce que l'utilisateur doit voir AVANT d'enregistrer : les extraits certifiés
 * qui couvrent l'écriture et leurs destinataires déclarés. Sans effet.
 */
async function impact(mouvementId) {
  const e = await etat(mouvementId);
  const couvertures = await db(supabase.from('rmt_extrait_mouvements').select('*').eq('mouvement_id', mouvementId));
  if (!couvertures.length) return { statut: e.statut, extraits: [], motif_requis: false };

  const extraits = await db(supabase.from('rmt_extraits').select('*')
    .in('id', couvertures.map((c) => c.extrait_id)).order('certifie_le', { ascending: false }));
  const destinataires = await db(supabase.from('rmt_extrait_destinataires').select('*')
    .in('extrait_id', extraits.map((x) => x.id)));

  return {
    statut: e.statut,
    motif_requis: e.statut !== 'CRAYON',
    extraits: extraits.map((x) => ({
      ...x,
      destinataires: destinataires.filter((d) => d.extrait_id === x.id),
    })),
  };
}

/** Ajoute une version. Le seul chemin d'écriture : rien n'est jamais écrasé. */
async function nouvelleVersion(mouvementId, action, contenu, meta = {}) {
  const versions = await db(supabase.from('rmt_mouvement_versions')
    .select('*').eq('mouvement_id', mouvementId).order('numero_version', { ascending: false }));
  const courante = versions[0];
  if (!courante) throw erreur('Écriture inconnue.', 404);

  const version = await db(supabase.from('rmt_mouvement_versions').insert({
    mouvement_id: mouvementId,
    numero_version: courante.numero_version + 1,
    action,
    // Une version porte le contenu COMPLET : on repart de la version courante
    // et on n'applique que la différence. Un contenu partiel rendrait
    // l'historique illisible et la comparaison impossible.
    ...contenuDe(courante),
    ...contenu,
    ordre_affiche: meta.ordre_affiche ?? courante.ordre_affiche,
    auteur_id: meta.utilisateur_id || null,
    motif_code: meta.motif_code || null,
    motif: meta.motif || null,
  }).select().single());

  // Les extraits qui couvraient une version antérieure deviennent inexacts.
  const couvertures = await db(supabase.from('rmt_extrait_mouvements').select('extrait_id').eq('mouvement_id', mouvementId));
  if (couvertures.length) {
    await db(supabase.from('rmt_extraits')
      .update({ statut: 'devenu_inexact', devenu_inexact_le: new Date().toISOString() })
      .in('id', couvertures.map((c) => c.extrait_id))
      .eq('statut', 'a_jour')
      .select());
  }
  return version;
}

async function modifierMouvement(mouvementId, donnees, utilisateurId) {
  const info = await impact(mouvementId);
  if (info.motif_requis && !(donnees.motif && donnees.motif_code)) {
    throw erreur(
      'Cette écriture est couverte par un extrait certifié : un motif est obligatoire pour la modifier.',
      422, { statut: info.statut, extraits: info.extraits },
    );
  }

  const version = await nouvelleVersion(mouvementId, 'modification', contenuDe(donnees), {
    utilisateur_id: utilisateurId, motif_code: donnees.motif_code, motif: donnees.motif,
  });
  const e = await etat(mouvementId);
  await journal(e.societe_id, utilisateurId, 'mouvement.modifie', 'mouvement', mouvementId,
    { motif: donnees.motif || null, extraits_impactes: info.extraits.map((x) => x.reference) });

  return { version, statut: e.statut, extraits_devenus_inexacts: info.extraits.map((x) => x.reference) };
}

/** Réordonnancement. C'est une version : un déplacement fait partie de l'histoire. */
async function deplacerMouvement(mouvementId, { apres_id = null }, utilisateurId) {
  const e = await etat(mouvementId);
  const ordre = await ordrePour(e.societe_id, apres_id);
  await db(supabase.from('rmt_mouvements').update({ ordre }).eq('id', mouvementId).select());
  await nouvelleVersion(mouvementId, 'deplacement', {}, { utilisateur_id: utilisateurId, ordre_affiche: ordre });
  await journal(e.societe_id, utilisateurId, 'mouvement.deplace', 'mouvement', mouvementId, { ordre });
  return { ordre };
}

/**
 * Suppression. Une écriture au crayon s'efface d'un geste ; une écriture à
 * l'encre exige l'approbation d'un associé, et le refus le dit plutôt que de
 * laisser l'utilisateur deviner.
 */
async function supprimerMouvement(mouvementId, { motif_code, motif } = {}, utilisateurId) {
  const info = await impact(mouvementId);
  if (info.statut !== 'CRAYON') {
    throw erreur(
      'Cette écriture est couverte par un extrait certifié : sa suppression demande '
      + 'l’approbation d’un associé. Utilisez « Demander la suppression ».',
      403, { statut: info.statut, extraits: info.extraits, voie: 'demande_suppression' },
    );
  }
  await nouvelleVersion(mouvementId, 'suppression', {}, { utilisateur_id: utilisateurId, motif_code, motif });
  const e = await etat(mouvementId);
  await journal(e.societe_id, utilisateurId, 'mouvement.supprime', 'mouvement', mouvementId, { motif: motif || null });
  return { supprime: true };
}

async function versions(mouvementId) {
  const lignes = await db(supabase.from('rmt_mouvement_versions').select('*')
    .eq('mouvement_id', mouvementId).order('numero_version'));
  const auteurs = await db(supabase.from('utilisateurs').select('id, nom, prenom, role'));
  const parId = new Map(auteurs.map((a) => [a.id, a]));
  return lignes.map((v) => ({
    ...v,
    auteur: parId.get(v.auteur_id) || null,
    nature_libelle: NATURES[v.nature]?.libelle || v.nature,
  }));
}

/** Restaurer, c'est avancer : on ajoute une version, on n'en retire aucune. */
async function restaurerVersion(mouvementId, versionId, utilisateurId, motif) {
  const [ancienne] = await db(supabase.from('rmt_mouvement_versions').select('*').eq('id', versionId));
  if (!ancienne || ancienne.mouvement_id !== Number(mouvementId)) {
    throw erreur('Version introuvable pour cette écriture.', 404);
  }
  const version = await nouvelleVersion(mouvementId, 'restauration', contenuDe(ancienne), {
    utilisateur_id: utilisateurId,
    motif_code: 'restauration',
    motif: motif || `Restauration de la version ${ancienne.numero_version}.`,
  });
  const e = await etat(mouvementId);
  await journal(e.societe_id, utilisateurId, 'mouvement.restaure', 'mouvement', mouvementId,
    { version_restauree: ancienne.numero_version });
  return version;
}

/* ------------------------------------------------- demandes de suppression */

async function demanderSuppression(mouvementId, { motif_code, motif }, utilisateurId) {
  if (!motif_code || !motif) throw erreur('Un motif est obligatoire pour demander une suppression.', 422);
  const info = await impact(mouvementId);
  const enCours = await db(supabase.from('rmt_demandes_suppression').select('id')
    .eq('mouvement_id', mouvementId).eq('statut', 'en_attente'));
  if (enCours.length) throw erreur('Une demande est déjà en attente sur cette écriture.', 409);

  const e = await etat(mouvementId);
  const demande = await db(supabase.from('rmt_demandes_suppression').insert({
    mouvement_id: mouvementId,
    demandeur_id: utilisateurId,
    motif_code, motif,
    extraits_impactes: info.extraits.map((x) => ({ id: x.id, reference: x.reference })),
  }).select().single());
  await journal(e.societe_id, utilisateurId, 'suppression.demandee', 'mouvement', mouvementId, { motif });
  return demande;
}

async function listerDemandes(statut = 'en_attente') {
  const demandes = await db(supabase.from('rmt_demandes_suppression').select('*')
    .eq('statut', statut).order('created_at', { ascending: false }));
  if (!demandes.length) return [];
  const etats = await db(supabase.from('rmt_etat_mouvements').select('*')
    .in('mouvement_id', demandes.map((d) => d.mouvement_id)));
  const versions2 = await db(supabase.from('rmt_versions_courantes').select('*')
    .in('mouvement_id', demandes.map((d) => d.mouvement_id)));
  const utilisateurs = await db(supabase.from('utilisateurs').select('id, nom, prenom, role'));
  const parId = new Map(utilisateurs.map((u) => [u.id, u]));

  return demandes.map((d) => ({
    ...d,
    demandeur: parId.get(d.demandeur_id) || null,
    etat: etats.find((e) => e.mouvement_id === d.mouvement_id) || null,
    ecriture: versions2.find((v) => v.mouvement_id === d.mouvement_id) || null,
  }));
}

/** L'approbation est réservée aux associés : c'est la garantie, pas une formalité. */
async function deciderDemande(demandeId, { approuver, motif }, utilisateur) {
  if (!utilisateur || utilisateur.role !== 'associe') {
    throw erreur('Seul un associé peut statuer sur une demande de suppression.', 403,
      { role_requis: 'associe', role_actuel: utilisateur?.role || null });
  }
  const [demande] = await db(supabase.from('rmt_demandes_suppression').select('*').eq('id', demandeId));
  if (!demande) throw erreur('Demande inconnue.', 404);
  if (demande.statut !== 'en_attente') throw erreur('Cette demande a déjà été traitée.', 409);

  await db(supabase.from('rmt_demandes_suppression').update({
    statut: approuver ? 'approuvee' : 'refusee',
    decideur_id: utilisateur.id,
    decision_le: new Date().toISOString(),
    decision_motif: motif || null,
  }).eq('id', demandeId).select());

  if (approuver) {
    await nouvelleVersion(demande.mouvement_id, 'suppression', {}, {
      utilisateur_id: utilisateur.id, motif_code: demande.motif_code, motif: demande.motif,
    });
  }
  const e = await etat(demande.mouvement_id);
  await journal(e.societe_id, utilisateur.id,
    approuver ? 'suppression.approuvee' : 'suppression.refusee', 'mouvement', demande.mouvement_id, { motif });
  return { statut: approuver ? 'approuvee' : 'refusee' };
}

module.exports = {
  FORMES_ADMISES, NATURES, STATUTS,
  activer, societe, nommerCompte,
  mouvements, creerMouvement, modifierMouvement, deplacerMouvement, supprimerMouvement,
  impact, etat, versions, restaurerVersion,
  demanderSuppression, listerDemandes, deciderDemande,
  journal, erreur, contenuDe,
};
