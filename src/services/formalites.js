'use strict';

/**
 * Orchestration des dossiers de formalité.
 *
 * Le parcours tient en quatre temps, et c'est tout l'objet du module :
 *   1. identifier   — un SIREN, et la fiche entreprise est rapatriée du RNE ;
 *   2. répondre     — uniquement ce qui change (le « delta ») ;
 *   3. contrôler    — complétude, cohérence, pièces, délai légal ;
 *   4. déposer/suivre — dépôt au Guichet unique puis suivi automatique du
 *      statut, des régularisations et des échéances.
 *
 * Chaque étape écrit dans le journal du dossier : le suivi n'est pas un écran
 * de plus à tenir à jour à la main, il se construit tout seul.
 */

const { supabase, q, uploadFile, downloadFile } = require('../supa');
const rne = require('../inpi/rne');
const guichet = require('../inpi/guichet');
const { definition, piecesExigees } = require('../inpi/catalogue');
const { controler, echeance } = require('../inpi/controles');
const { construirePayload } = require('../inpi/payload');
const { versFicheSociete, nettoyerSiren, formaterSiren } = require('../inpi/normalize');
const { STATUTS } = require('../inpi/referentiels');

/* ------------------------------------------------------------- utilitaires */

/** Transforme les échecs d'infrastructure en messages actionnables. */
function adapterErreurSchema(e) {
  const message = e.message || '';
  if (/does not exist|schema cache/i.test(message)) {
    const relation = (message.match(/relation ["']?(\w+)/i) || [])[1] || '';
    const err = new Error(/formalite/.test(relation) || !relation
      ? 'Tables des formalités absentes : exécuter scripts/schema-formalites.sql dans le projet Supabase.'
      : `Table « ${relation} » absente de la base Supabase.`);
    err.status = 503;
    return err;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(message)) {
    const err = new Error('Base Supabase injoignable : vérifier que le projet n’est pas en pause et que SUPABASE_URL / SUPABASE_KEY sont corrects.');
    err.status = 503;
    return err;
  }
  return e;
}

async function db(promise) {
  try { return await q(promise); } catch (e) { throw adapterErreurSchema(e); }
}

async function journal(formaliteId, type, message, donnees = null) {
  await db(supabase.from('formalite_evenements')
    .insert({ formalite_id: formaliteId, type, message, donnees }).select());
}

function reference(id) {
  return `LGZ-${new Date().getFullYear()}-${String(id).padStart(5, '0')}`;
}

/* ------------------------------------------------------- création / lecture */

/**
 * Crée un dossier. Le seul élément indispensable est le SIREN (ou une société
 * déjà en base) : la fiche RNE est rapatriée et figée comme instantané de
 * référence du dossier.
 */
async function creer({ societe_id = null, operation_id = null, type, siren = '', libelle = '' }) {
  const def = definition(type);
  if (!def) { const e = new Error(`Type de formalité inconnu : ${type}`); e.status = 400; throw e; }

  let sirenUtilise = nettoyerSiren(siren);
  let societe = null;
  if (societe_id) {
    societe = await db(supabase.from('societes').select('*').eq('id', societe_id).single());
    if (!sirenUtilise) sirenUtilise = nettoyerSiren(societe.siren);
  }

  let fiche = {};
  let avertissement = null;
  if (sirenUtilise && !def.sansSiren) {
    try {
      fiche = await rne.entreprise(sirenUtilise);
    } catch (e) {
      // Le RNE indisponible ne doit pas empêcher d'ouvrir le dossier : on
      // repart alors de la fiche société interne, et on le dit.
      avertissement = `Pré-remplissage RNE indisponible (${e.message}).`;
      fiche = societe ? ficheDepuisSociete(societe) : {};
    }
  } else if (societe) {
    fiche = ficheDepuisSociete(societe);
  }

  const nom = libelle || `${def.libelle} — ${fiche.denomination || societe?.denomination || formaterSiren(sirenUtilise) || 'nouvelle société'}`;

  const formalite = await db(supabase.from('formalites').insert({
    societe_id, operation_id, type, libelle: nom,
    siren: sirenUtilise || null,
    fiche, reponses: prefill(type, fiche),
    statut: 'BROUILLON',
  }).select().single());

  await db(supabase.from('formalites').update({ reference: reference(formalite.id) })
    .eq('id', formalite.id).select());
  formalite.reference = reference(formalite.id);

  await journal(formalite.id, 'creation',
    `Dossier ouvert — ${def.libelle}${fiche.simule ? ' (données RNE simulées)' : ''}.`,
    { siren: sirenUtilise, source_fiche: fiche.source || 'interne' });

  return { ...formalite, avertissement };
}

/** Fiche minimale reconstituée depuis la table `societes` (repli hors ligne). */
function ficheDepuisSociete(s) {
  return {
    source: 'interne',
    siren: nettoyerSiren(s.siren),
    siren_formate: s.siren || '',
    denomination: s.denomination,
    forme_juridique: s.forme_sociale || '',
    capital: s.capital_social ?? null,
    objet: s.objet_social || '',
    adresse: { texte: s.siege_social || '', commune: s.rcs_ville || '' },
    dirigeants: [],
  };
}

/** Valeurs pré-remplies proposées à l'ouverture du questionnaire. */
function prefill(type, fiche) {
  const r = {};
  if (type === 'changement_dirigeant' && fiche.dirigeants?.length) {
    r.nature = 'remplacement';
    r.dirigeant_sortant = fiche.dirigeants[0].nom_complet;
  }
  if (type === 'depot_comptes' && fiche.date_cloture && /^\d{4}$/.test(fiche.date_cloture)) {
    const jour = fiche.date_cloture.slice(0, 2);
    const mois = fiche.date_cloture.slice(2, 4);
    const annee = new Date().getFullYear() - 1;
    r.exercice_clos = `${annee}-${mois}-${jour}`;
  }
  if (type === 'modification_capital') r.sens = 'augmentation';
  return r;
}

/** Dossier complet : réponses, pièces, contrôles, payload, journal. */
async function lire(id) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  const [pieces, evenements, societe] = await Promise.all([
    db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).order('id')),
    db(supabase.from('formalite_evenements').select('*').eq('formalite_id', id).order('created_at', { ascending: false })),
    formalite.societe_id
      ? db(supabase.from('societes').select('id, denomination').eq('id', formalite.societe_id).single())
      : null,
  ]);

  const dossier = {
    type: formalite.type, siren: formalite.siren, reference: formalite.reference,
    libelle: formalite.libelle, fiche: formalite.fiche, reponses: formalite.reponses,
    pieces: pieces.map((p) => ({ code: p.code, nom: p.filename, chemin: p.filepath })),
  };
  const def = definition(formalite.type);

  return {
    ...formalite,
    societe_nom: societe?.denomination || formalite.fiche?.denomination || '',
    definition: def ? {
      code: formalite.type, libelle: def.libelle, categorie: def.categorie,
      resume: def.resume, delai: def.delai, champs: def.champs,
    } : null,
    pieces,
    pieces_exigees: piecesExigees(formalite.type, formalite.reponses),
    evenements,
    controles: controler(dossier),
    apercu: def?.apercu ? def.apercu(formalite.reponses || {}, formalite.fiche || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([label, valeur]) => ({ label, valeur: String(valeur) })) : [],
    payload: construirePayloadSur(dossier),
    statut_libelle: STATUTS[formalite.statut]?.libelle || formalite.statut,
  };
}

function construirePayloadSur(dossier) {
  try { return construirePayload(dossier); } catch { return null; }
}

/* ------------------------------------------------------------- mise à jour */

async function enregistrerReponses(id, reponses) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (STATUTS[formalite.statut]?.terminal) {
    const e = new Error('Dossier clos : les réponses ne sont plus modifiables.'); e.status = 409; throw e;
  }
  const fusion = { ...(formalite.reponses || {}), ...reponses };
  const ech = echeance(formalite.type, fusion);
  const maj = await db(supabase.from('formalites')
    .update({ reponses: fusion, echeance: ech?.limite || null, updated_at: new Date().toISOString() })
    .eq('id', id).select().single());
  await journal(id, 'saisie', 'Questionnaire mis à jour.', { champs: Object.keys(reponses) });
  return maj;
}

/* ----------------------------------------------------------------- pièces */

async function ajouterPiece(id, { code, libelle, fichier }) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  const nomFichier = fichier.originalname.replace(/[^\w.\-]+/g, '_');
  const chemin = `formalites/${formalite.id}/${code}_${Date.now()}_${nomFichier}`;
  await uploadFile(chemin, fichier.buffer, fichier.mimetype || 'application/octet-stream');
  const piece = await db(supabase.from('formalite_pieces').insert({
    formalite_id: formalite.id, code, libelle: libelle || '',
    filename: fichier.originalname, filepath: chemin, taille: fichier.size,
  }).select().single());
  await journal(formalite.id, 'piece', `Pièce jointe : ${libelle || code} (${fichier.originalname}).`);
  return piece;
}

async function supprimerPiece(pieceId) {
  const piece = await db(supabase.from('formalite_pieces').select('*').eq('id', pieceId).single());
  await db(supabase.from('formalite_pieces').delete().eq('id', pieceId).select());
  await journal(piece.formalite_id, 'piece', `Pièce retirée : ${piece.libelle || piece.code}.`);
  return { ok: true };
}

async function telechargerPiece(pieceId) {
  const piece = await db(supabase.from('formalite_pieces').select('*').eq('id', pieceId).single());
  return { piece, buffer: await downloadFile(piece.filepath) };
}

/* ------------------------------------------------------------------ dépôt */

async function deposer(id) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  const pieces = await db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).order('id'));
  const dossier = {
    type: formalite.type, siren: formalite.siren, reference: formalite.reference,
    libelle: formalite.libelle, fiche: formalite.fiche, reponses: formalite.reponses,
    pieces: pieces.map((p) => ({ code: p.code, nom: p.filename, chemin: p.filepath })),
  };

  const controles = controler(dossier);
  if (!controles.pret) {
    const e = new Error('Dépôt impossible : contrôles bloquants non levés.');
    e.status = 422; e.details = controles;
    throw e;
  }

  const payload = construirePayload(dossier);
  const resultat = await guichet.deposer(payload);

  const maj = await db(supabase.from('formalites').update({
    payload,
    statut: resultat.statut || 'DEPOSEE',
    inpi_id: resultat.inpi_id,
    numero_liasse: resultat.numero_liasse,
    statut_inpi: resultat.statut_brut,
    statut_date: resultat.statut_date || new Date().toISOString(),
    simule: Boolean(resultat.simule),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single());

  await journal(id, 'depot',
    resultat.simule
      ? `Dépôt simulé (${resultat.motif_simulation}) — liasse ${resultat.numero_liasse}.`
      : `Formalité déposée au Guichet unique — liasse ${resultat.numero_liasse}.`,
    { inpi_id: resultat.inpi_id });

  return { ...maj, simule: Boolean(resultat.simule), motif_simulation: resultat.motif_simulation || null, controles };
}

/* ------------------------------------------------------------------ suivi */

/** Interroge l'INPI et journalise tout changement de statut. */
async function synchroniser(id) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (!formalite.inpi_id) return { ...formalite, synchronise: false };

  const etat = await guichet.statut(formalite.inpi_id);
  if (!etat) return { ...formalite, synchronise: false };

  const changement = etat.statut !== formalite.statut;
  const patch = {
    statut: etat.statut,
    statut_inpi: etat.statut_brut,
    statut_date: etat.statut_date || new Date().toISOString(),
    regularisations: etat.regularisations || [],
    updated_at: new Date().toISOString(),
  };
  const maj = await db(supabase.from('formalites').update(patch).eq('id', id).select().single());

  if (changement) {
    await journal(id, 'statut',
      `Statut : ${STATUTS[formalite.statut]?.libelle || formalite.statut} → ${STATUTS[etat.statut]?.libelle || etat.statut}.`);
    if (etat.statut === 'REGULARISATION' && etat.regularisations?.length) {
      await journal(id, 'regularisation',
        `Régularisation demandée : ${etat.regularisations.map((r) => r.motif).join(' | ')}`,
        { regularisations: etat.regularisations });
    }
  }
  return { ...maj, synchronise: true, changement };
}

/** Synchronise tous les dossiers non terminés (appel manuel ou planifié). */
async function synchroniserToutes() {
  const enCours = await db(supabase.from('formalites').select('id, statut, inpi_id')
    .not('inpi_id', 'is', null));
  const aSuivre = enCours.filter((f) => !STATUTS[f.statut]?.terminal);
  const resultats = [];
  for (const f of aSuivre) {
    try { resultats.push(await synchroniser(f.id)); } catch (e) { resultats.push({ id: f.id, erreur: e.message }); }
  }
  return {
    synchronisees: resultats.filter((r) => r.synchronise).length,
    changements: resultats.filter((r) => r.changement).length,
    erreurs: resultats.filter((r) => r.erreur),
  };
}

/* --------------------------------------------------------------- listes */

async function lister(filtres = {}) {
  let requete = supabase.from('formalites').select('*').order('created_at', { ascending: false });
  if (filtres.statut) requete = requete.eq('statut', filtres.statut);
  if (filtres.societe_id) requete = requete.eq('societe_id', filtres.societe_id);
  if (filtres.type) requete = requete.eq('type', filtres.type);
  const [formalites, societes] = await Promise.all([
    db(requete),
    db(supabase.from('societes').select('id, denomination')),
  ]);
  const aujourdhui = new Date().toISOString().slice(0, 10);
  return formalites.map((f) => ({
    ...f,
    societe_nom: societes.find((s) => s.id === f.societe_id)?.denomination || f.fiche?.denomination || '',
    statut_libelle: STATUTS[f.statut]?.libelle || f.statut,
    statut_couleur: STATUTS[f.statut]?.couleur || 'gris',
    type_libelle: definition(f.type)?.libelle || f.type,
    en_retard: Boolean(f.echeance && f.echeance < aujourdhui && !STATUTS[f.statut]?.terminal),
    nb_regularisations: Array.isArray(f.regularisations) ? f.regularisations.length : 0,
  }));
}

/** Tableau de bord du suivi : ce qui bloque, ce qui presse, ce qui avance. */
async function tableauDeBord() {
  const formalites = await lister();
  const parStatut = {};
  for (const f of formalites) parStatut[f.statut] = (parStatut[f.statut] || 0) + 1;

  const actives = formalites.filter((f) => !STATUTS[f.statut]?.terminal);
  return {
    compteurs: {
      total: formalites.length,
      en_cours: actives.length,
      brouillons: formalites.filter((f) => f.statut === 'BROUILLON').length,
      regularisations: formalites.filter((f) => f.statut === 'REGULARISATION').length,
      en_retard: formalites.filter((f) => f.en_retard).length,
      validees: formalites.filter((f) => f.statut === 'VALIDEE').length,
    },
    par_statut: parStatut,
    a_traiter: actives
      .filter((f) => f.statut === 'REGULARISATION' || f.en_retard || f.statut === 'BROUILLON')
      .sort((a, b) => (a.echeance || '9999').localeCompare(b.echeance || '9999'))
      .slice(0, 15),
    echeances: actives.filter((f) => f.echeance).sort((a, b) => a.echeance.localeCompare(b.echeance)).slice(0, 15),
    recentes: formalites.slice(0, 10),
  };
}

async function supprimer(id) {
  const formalite = await db(supabase.from('formalites').select('statut').eq('id', id).single());
  if (formalite.statut !== 'BROUILLON') {
    const e = new Error('Seul un brouillon peut être supprimé ; un dossier déposé reste tracé.');
    e.status = 409; throw e;
  }
  await db(supabase.from('formalites').delete().eq('id', id).select());
  return { ok: true };
}

/* ------------------------------------- passerelle avec la fiche société */

/** Crée (ou met à jour) une fiche société à partir du seul SIREN. */
async function importerSociete(sirenBrut, { groupe_id = null } = {}) {
  const fiche = await rne.entreprise(sirenBrut);
  const champs = versFicheSociete(fiche);
  const existante = await db(supabase.from('societes').select('*').eq('siren', champs.siren));
  let societe;
  if (existante.length) {
    societe = await db(supabase.from('societes').update(champs).eq('id', existante[0].id).select().single());
  } else {
    societe = await db(supabase.from('societes').insert({ ...champs, groupe_id }).select().single());
    for (const d of fiche.dirigeants.filter((x) => x.type === 'physique')) {
      await db(supabase.from('dirigeants').insert({
        societe_id: societe.id, civilite: '', nom: d.nom,
        prenom: (d.prenoms || []).join(' '), fonction: '', adresse: d.adresse?.texte || '',
      }).select());
    }
  }
  return { societe, fiche, cree: !existante.length };
}

module.exports = {
  creer, lire, lister, enregistrerReponses, ajouterPiece, supprimerPiece, telechargerPiece,
  deposer, synchroniser, synchroniserToutes, tableauDeBord, supprimer, importerSociete,
};
