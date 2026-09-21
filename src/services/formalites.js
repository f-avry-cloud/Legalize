'use strict';

/**
 * Orchestration des dossiers de formalité.
 *
 * Le parcours suit celui du Guichet unique, mais sans jamais le faire porter
 * à l'utilisateur :
 *   1. identifier — un SIREN, et la fiche entreprise est rapatriée du RNE ;
 *   2. répondre   — uniquement ce qui change (le « delta ») ;
 *   3. contrôler  — complétude, cohérence, pièces, délai légal ;
 *   4. déposer    — puis signer, payer et suivre : statut, régularisations,
 *      échéances. À chaque instant le dossier sait quelle est l'action
 *      attendue, et de qui.
 *
 * Chaque étape écrit dans le journal du dossier : le suivi n'est pas un écran
 * de plus à tenir à jour, il se construit tout seul.
 */

const { supabase, q, uploadFile, downloadFile } = require('../supa');
const rne = require('../inpi/rne');
const guichet = require('../inpi/guichet');
const { definition, piecesExigees } = require('../inpi/catalogue');
const { controler, echeance } = require('../inpi/controles');
const { construirePayload } = require('../inpi/payload');
const { versFicheSociete, nettoyerSiren, formaterSiren } = require('../inpi/normalize');
const { statut: statutInfo } = require('../inpi/referentiels');

/**
 * Un dossier importé du compte INPI n'a pas de type au sens du catalogue :
 * l'API ne renvoie que la lettre du contrat d'interface (C, M, R…). On le
 * stocke tel quel, préfixé, et on lui donne un libellé lisible.
 */
const TYPES_IMPORTES = {
  inpi_C: 'Création (importée de l’INPI)',
  inpi_M: 'Modification (importée de l’INPI)',
  inpi_R: 'Cessation (importée de l’INPI)',
  inpi_Y: 'Correction (importée de l’INPI)',
  inpi_Z: 'Complétion (importée de l’INPI)',
  inpi_B: 'Dépôt de comptes (importé de l’INPI)',
  inpi: 'Formalité importée de l’INPI',
};

function estImporte(formalite) {
  return formalite?.origine === 'inpi';
}

function libelleType(code) {
  return definition(code)?.libelle || TYPES_IMPORTES[code] || code;
}

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

function estTerminal(statut) {
  return Boolean(statutInfo(statut).terminal);
}

/* ------------------------------------------------------- création / lecture */

/**
 * Crée un dossier. Le seul élément indispensable est le SIREN (ou une société
 * déjà en base) : la fiche RNE est rapatriée et figée comme instantané de
 * référence, qui servira aussi d'état antérieur lors d'un dépôt de
 * modification.
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
    service: def.service,
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
    r.exercice_debut = `${annee}-01-01`;
  }
  if (type === 'modification_capital') { r.sens = 'augmentation'; r.modalite = 'APPORT_NUMERAIRE'; }
  if (type === 'creation_societe' && fiche.forme_juridique_code) r.forme_juridique_code = fiche.forme_juridique_code;
  return r;
}

/** Rassemble ce qui décrit le dossier, pour les contrôles et le payload. */
function dossierDe(formalite, pieces) {
  return {
    type: formalite.type,
    siren: formalite.siren,
    reference: formalite.reference,
    libelle: formalite.libelle,
    fiche: formalite.fiche,
    reponses: formalite.reponses,
    pieces: (pieces || []).map((p) => ({
      code: p.code, nom: p.filename, chemin: p.filepath, taille: p.taille,
    })),
  };
}

function construireSansEchec(dossier) {
  try { return construirePayload(dossier); } catch { return null; }
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

  const dossier = dossierDe(formalite, pieces);
  const importe = estImporte(formalite);
  // Un dossier importé n'a ni questionnaire ni payload : il reflète ce que
  // l'INPI détient, il ne se rejoue pas depuis l'application.
  const payload = importe ? null : construireSansEchec(dossier);
  const def = definition(formalite.type);
  const info = statutInfo(formalite.statut);

  return {
    ...formalite,
    societe_nom: societe?.denomination || formalite.fiche?.denomination || '',
    definition: def ? {
      code: formalite.type, libelle: def.libelle, categorie: def.categorie,
      resume: def.resume, delai: def.delai, champs: def.champs,
      signature: def.signature, evenement: def.evenement, service: def.service,
    } : null,
    pieces,
    pieces_exigees: piecesExigees(formalite.type, formalite.reponses),
    evenements,
    importe,
    controles: importe ? null : controler({ ...dossier, payload }),
    apercu: (!importe && def?.apercu) ? def.apercu(formalite.reponses || {}, formalite.fiche || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([label, valeur]) => ({ label, valeur: String(valeur) })) : [],
    payload: payload ? payload.corps : null,
    payload_endpoint: payload ? payload.endpoint : null,
    type_libelle: libelleType(formalite.type),
    statut_libelle: info.libelle,
    statut_couleur: info.couleur,
    action_attendue: formalite.statut === 'BROUILLON' ? 'deposer' : info.action,
    // La fiche RNE brute est volumineuse et n'a pas d'usage côté interface.
    fiche: formalite.fiche ? { ...formalite.fiche, brut: undefined } : {},
  };
}

/* --------------------------------------------------------------- réponses */

async function enregistrerReponses(id, reponses) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (estTerminal(formalite.statut)) {
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
  await uploadFile(chemin, fichier.buffer, fichier.mimetype || 'application/pdf');
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

/** Les pièces partent en base64 dans le JSON de la formalité. */
async function piecesEncodees(pieces) {
  return Promise.all(pieces.map(async (p) => ({
    code: p.code,
    nom: p.filename,
    taille: p.taille,
    base64: (await downloadFile(p.filepath)).toString('base64'),
  })));
}

/* ------------------------------------------------------------------ dépôt */

async function deposer(id) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (formalite.inpi_id) {
    const e = new Error('Ce dossier a déjà été déposé.'); e.status = 409; throw e;
  }
  const pieces = await db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).order('id'));
  const dossier = dossierDe(formalite, pieces);
  const controles = controler({ ...dossier, payload: construireSansEchec(dossier) });
  if (!controles.pret) {
    const e = new Error('Dépôt impossible : contrôles bloquants non levés.');
    e.status = 422; e.details = controles;
    throw e;
  }

  // Les fichiers ne sont encodés qu'au moment du dépôt : inutile de porter
  // des mégaoctets de base64 dans tous les aperçus.
  const requete = construirePayload({ ...dossier, pieces: await piecesEncodees(pieces) });
  const resultat = await guichet.deposer(requete);

  const maj = await db(supabase.from('formalites').update({
    // On conserve le payload sans les base64, pour garder la trace exacte du
    // dépôt sans dupliquer les fichiers déjà présents dans le stockage.
    payload: construirePayload(dossier).corps,
    statut: resultat.statut,
    inpi_id: resultat.inpi_id,
    numero_liasse: resultat.numero_liasse,
    statut_inpi: resultat.statut_brut,
    statut_date: resultat.statut_date || new Date().toISOString(),
    action_attendue: resultat.action_attendue,
    montant: resultat.montant,
    num_nat: resultat.num_nat,
    simule: Boolean(resultat.simule),
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single());

  await journal(id, 'depot',
    resultat.simule
      ? `Dépôt simulé (${resultat.motif_simulation}) — liasse ${resultat.numero_liasse}.`
      : `Formalité déposée au guichet unique — liasse ${resultat.numero_liasse}.`,
    { inpi_id: resultat.inpi_id, endpoint: requete.endpoint, montant: resultat.montant });

  return { ...maj, simule: Boolean(resultat.simule), motif_simulation: resultat.motif_simulation || null, controles };
}

/* -------------------------------------------------- signature et paiement */

/**
 * Signature du dépôt. Une création se signe d'un simple appel ; une
 * modification, une cessation ou un dépôt de comptes exigent une signature
 * électronique avancée : le document de synthèse doit être signé hors ligne
 * avec un certificat qualifié, puis redéposé (PJ_115) avant cet appel.
 */
async function signer(id, { documentSigneId = null } = {}) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (!formalite.inpi_id) { const e = new Error('Dossier non déposé.'); e.status = 409; throw e; }

  const def = definition(formalite.type);
  if (def?.signature === 'avancee' && !documentSigneId && !formalite.simule) {
    const e = new Error(
      'Signature électronique avancée requise : télécharger le document de synthèse, le signer avec un certificat '
      + 'qualifié, le redéposer en PJ_115, puis transmettre l’identifiant de la pièce signée.',
    );
    e.status = 409; throw e;
  }

  const signature = await guichet.signer(formalite.inpi_id, {
    documentSigneId, service: formalite.service,
  });
  await journal(id, 'signature', `Dépôt signé${signature.simule ? ' (simulation)' : ''}.`, signature);
  return synchroniser(id);
}

/** Paiement des taxes : jamais automatique sans configuration dédiée. */
async function payer(id) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (!formalite.inpi_id) { const e = new Error('Dossier non déposé.'); e.status = 409; throw e; }
  const resultat = await guichet.payer(formalite.inpi_id, { service: formalite.service });
  await journal(id, 'paiement',
    `Taxes réglées${resultat.simule ? ' (simulation)' : ''}${formalite.montant ? ` — ${formalite.montant} €` : ''}.`);
  return synchroniser(id);
}

/**
 * Dépose le document de synthèse signé hors ligne (PJ_115) puis déclenche la
 * signature. Voie du certificat qualifié : le PDF doit porter une signature
 * PAdES dont l'autorité figure sur la liste de confiance eIDAS, sans quoi
 * l'INPI le refuse.
 */
async function deposerDocumentSigne(id, fichier) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (!formalite.inpi_id) { const e = new Error('Dossier non déposé.'); e.status = 409; throw e; }
  if (!/\.pdf$/i.test(fichier.originalname)) {
    const e = new Error('Le document de synthèse signé doit être un PDF.'); e.status = 400; throw e;
  }

  const piece = await guichet.ajouterPiece(formalite.inpi_id, {
    code: 'PJ_115',
    nom: fichier.originalname,
    base64: fichier.buffer.toString('base64'),
  });
  await journal(id, 'signature', `Document de synthèse signé déposé (PJ_115 — ${fichier.originalname}).`);

  const signature = await guichet.signer(formalite.inpi_id, {
    documentSigneId: piece.id, service: formalite.service,
  });
  await journal(id, 'signature', `Signature transmise au guichet unique${signature.simule ? ' (simulation)' : ''}.`);
  return synchroniser(id);
}

/** Document de synthèse à signer (PDF). */
async function synthese(id) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (!formalite.inpi_id) { const e = new Error('Dossier non déposé.'); e.status = 409; throw e; }
  return { formalite, buffer: await guichet.synthese(formalite.inpi_id) };
}

/* ------------------------------------------------------------------ suivi */

/** Interroge l'INPI et journalise tout changement de statut. */
async function synchroniser(id) {
  const formalite = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (!formalite.inpi_id) return { ...formalite, synchronise: false };

  const etat = await guichet.lire(formalite.inpi_id, formalite.service);
  if (!etat) return { ...formalite, synchronise: false };

  // Capturé avant la mise à jour : c'est cette valeur qui est journalisée.
  const statutPrecedent = formalite.statut;
  const changement = etat.statut !== statutPrecedent;
  const maj = await db(supabase.from('formalites').update({
    statut: etat.statut,
    statut_inpi: etat.statut_brut,
    statut_date: etat.statut_date || new Date().toISOString(),
    action_attendue: etat.action_attendue,
    montant: etat.montant ?? formalite.montant,
    num_nat: etat.num_nat ?? formalite.num_nat,
    signature_date: etat.signature_date ?? formalite.signature_date,
    paiement_date: etat.paiement_date ?? formalite.paiement_date,
    regularisations: etat.regularisations || [],
    updated_at: new Date().toISOString(),
  }).eq('id', id).select().single());

  if (changement) {
    await journal(id, 'statut',
      `Statut : ${statutInfo(statutPrecedent).libelle} → ${statutInfo(etat.statut).libelle}.`);
    if (etat.regularisations?.length) {
      await journal(id, 'regularisation',
        `Régularisation demandée : ${etat.regularisations.map((r) => r.motif).join(' | ')}`,
        { regularisations: etat.regularisations });
    }
  }
  return { ...maj, synchronise: true, changement };
}

/** Synchronise tous les dossiers non terminés (appel manuel ou planifié). */
async function synchroniserToutes() {
  const deposees = await db(supabase.from('formalites').select('id, statut, inpi_id')
    .not('inpi_id', 'is', null));
  const aSuivre = deposees.filter((f) => !estTerminal(f.statut));
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

/* ---------------------------------------------------------------- listes */

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
  return formalites.map((f) => {
    const info = statutInfo(f.statut);
    return {
      ...f,
      fiche: undefined,
      payload: undefined,
      societe_nom: societes.find((s) => s.id === f.societe_id)?.denomination || f.fiche?.denomination || '',
      statut_libelle: info.libelle,
      statut_couleur: info.couleur,
      action_attendue: f.statut === 'BROUILLON' ? 'deposer' : info.action,
      type_libelle: libelleType(f.type),
      importe: estImporte(f),
      en_retard: Boolean(f.echeance && f.echeance < aujourdhui && !info.terminal),
      nb_regularisations: Array.isArray(f.regularisations) ? f.regularisations.length : 0,
    };
  });
}

/** Tableau de bord : ce qui attend une action de notre côté d'abord. */
async function tableauDeBord() {
  const formalites = await lister();
  const parStatut = {};
  for (const f of formalites) parStatut[f.statut] = (parStatut[f.statut] || 0) + 1;

  const actives = formalites.filter((f) => !statutInfo(f.statut).terminal);
  // Une action « à nous » est tout ce qui n'est pas de l'attente côté INPI.
  const aNous = actives.filter((f) => f.action_attendue && f.action_attendue !== 'attendre');

  return {
    compteurs: {
      total: formalites.length,
      en_cours: actives.length,
      a_traiter: aNous.length,
      brouillons: formalites.filter((f) => f.statut === 'BROUILLON').length,
      a_signer: formalites.filter((f) => f.action_attendue === 'signer').length,
      a_payer: formalites.filter((f) => f.action_attendue === 'payer').length,
      regularisations: formalites.filter((f) => f.action_attendue === 'regulariser').length,
      en_retard: formalites.filter((f) => f.en_retard).length,
      validees: formalites.filter((f) => f.statut === 'VALIDATED').length,
    },
    par_statut: parStatut,
    a_traiter: aNous
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

/* ------------------------------------------- import du compte mandataire */

/**
 * Rapatrie les formalités déjà présentes sur le compte INPI — celles déposées
 * avant la mise en service de l'application, ou depuis l'interface web du
 * guichet unique. Sans cela, l'application ne montre que ce qu'elle a
 * elle-même déposé, ce qui donne une vue partielle du cabinet.
 *
 * Les dossiers importés sont des miroirs en lecture seule : statut, liasse,
 * dates et montant. Ceux que l'application a déposés sont reconnus par leur
 * identifiant INPI et mis à jour plutôt que dupliqués.
 */
async function importerDepuisInpi({ services = ['formalites', 'comptes_annuels'] } = {}) {
  const connus = await db(supabase.from('formalites').select('id, inpi_id, statut').not('inpi_id', 'is', null));
  const parInpiId = new Map(connus.map((f) => [String(f.inpi_id), f]));

  const bilan = { importees: 0, actualisees: 0, inchangees: 0, ignorees: 0, erreurs: [] };

  for (const service of services) {
    let distantes = [];
    try {
      distantes = await guichet.listerTout({ service });
    } catch (e) {
      bilan.erreurs.push(`${service} : ${e.message}`);
      continue;
    }

    for (const d of distantes) {
      // Une ligne sans identifiant ne peut pas être rapprochée : on la compte
      // plutôt que de l'ignorer en silence, un import qui ne ramène rien sans
      // rien dire étant indiscernable d'un compte vide.
      if (!d.inpi_id) { bilan.ignorees += 1; continue; }
      const existante = parInpiId.get(String(d.inpi_id));

      const champs = {
        statut: d.statut,
        statut_inpi: d.statut_brut,
        statut_date: d.statut_date || null,
        action_attendue: d.action_attendue,
        numero_liasse: d.numero_liasse,
        montant: d.montant,
        num_nat: d.num_nat,
        signature_date: d.signature_date,
        paiement_date: d.paiement_date,
        regularisations: d.regularisations || [],
        updated_at: new Date().toISOString(),
      };

      if (existante) {
        if (existante.statut === d.statut) { bilan.inchangees += 1; continue; }
        await db(supabase.from('formalites').update(champs).eq('id', existante.id).select());
        await journal(existante.id, 'statut',
          `Statut actualisé depuis le compte INPI : ${statutInfo(existante.statut).libelle} → ${statutInfo(d.statut).libelle}.`);
        bilan.actualisees += 1;
        continue;
      }

      const societe = d.siren
        ? (await db(supabase.from('societes').select('id').eq('siren', formaterSiren(d.siren))))[0]
        : null;

      const creee = await db(supabase.from('formalites').insert({
        ...champs,
        origine: 'inpi',
        service: service === 'comptes_annuels' ? 'comptes_annuels' : 'formalites',
        type: service === 'comptes_annuels' ? 'inpi_B' : `inpi_${d.type_formalite || ''}`.replace(/_$/, ''),
        libelle: d.nom_dossier || d.company_name || `Liasse ${d.numero_liasse || d.inpi_id}`,
        reference: d.reference_mandataire || null,
        siren: nettoyerSiren(d.siren) || null,
        societe_id: societe?.id || null,
        inpi_id: String(d.inpi_id),
        fiche: { source: 'INPI', denomination: d.company_name || '', forme_juridique_code: d.forme_juridique || '' },
        reponses: {},
        simule: false,
      }).select().single());

      await journal(creee.id, 'creation',
        `Dossier importé du compte INPI — liasse ${d.numero_liasse || d.inpi_id}, statut ${statutInfo(d.statut).libelle}.`);
      parInpiId.set(String(d.inpi_id), creee);
      bilan.importees += 1;
    }
  }
  return bilan;
}

/* -------------------------------------- passerelle avec la fiche société */

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
        prenom: (d.prenoms || []).join(' '), fonction: d.role_libelle || '', adresse: d.adresse?.texte || '',
      }).select());
    }
  }
  return { societe, fiche: { ...fiche, brut: undefined }, cree: !existante.length };
}

module.exports = {
  creer, lire, lister, enregistrerReponses, ajouterPiece, supprimerPiece, telechargerPiece,
  deposer, signer, payer, synthese, deposerDocumentSigne, synchroniser, synchroniserToutes,
  tableauDeBord, supprimer, importerSociete, importerDepuisInpi,
};
