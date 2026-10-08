'use strict';

/**
 * Dossiers « parcours » : une ou plusieurs opérations, une seule formalité.
 *
 * Le dossier vit dans la table `formalites` (type « parcours »), à côté des
 * dossiers classiques, et en partage le journal, les pièces et le suivi. Ce
 * qui lui est propre : la liste des opérations, les réponses de typologie et
 * des réponses rangées par opération (`reponses.commun`, `reponses['15M']`…).
 */

const { supabase, q, uploadFile, downloadFile } = require('../supa');
const rne = require('../inpi/rne');
const guichet = require('../inpi/guichet');
const parcours = require('../inpi/parcours');
const creationPc = require('../inpi/parcours-creation');
const { construireParcours, deposable } = require('../inpi/payload-parcours');
const { nettoyerSiren, formaterSiren } = require('../inpi/normalize');
const analyse = require('./analyse');
const { pdfLisible, MESSAGE_ILLISIBLE } = require('../inpi/pdf');

const TYPE = 'parcours';

async function db(promise) {
  try {
    return await q(promise);
  } catch (e) {
    if (/column .* does not exist|schema cache/i.test(e.message || '')) {
      throw Object.assign(new Error('Base à mettre à jour : appliquer la migration « formalites_parcours ».'), { status: 503 });
    }
    throw e;
  }
}

function erreur(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

async function journal(id, type, message, donnees = null) {
  await db(supabase.from('formalite_evenements').insert({ formalite_id: id, type, message, donnees }).select());
}

async function charger(id) {
  const f = await db(supabase.from('formalites').select('*').eq('id', id).single());
  if (f.type !== TYPE) throw erreur('Ce dossier n’est pas un parcours.', 404);
  return f;
}

function verifierOuvert(f) {
  if (f.inpi_id) throw erreur('Dossier déjà déposé : il ne se modifie plus ici.', 409);
}

/* --------------------------------------------------------------- création */

async function creer({ societe_id = null, siren = '', operations = [] }) {
  const ops = [...new Set(operations)].filter((c) => parcours.infoOperation(c));
  if (!ops.length) throw erreur('Choisissez au moins une opération.');

  let sirenUtilise = nettoyerSiren(siren);
  let societe = null;
  if (societe_id) {
    societe = await db(supabase.from('societes').select('*').eq('id', societe_id).single());
    if (!sirenUtilise) sirenUtilise = nettoyerSiren(societe.siren);
  }
  const creation = ops.some((c) => parcours.infoOperation(c).creation);
  if (!creation && !sirenUtilise) throw erreur('Indiquez la société concernée (SIREN) : la fiche du registre sert de point de départ.');

  let fiche = {};
  let avertissement = null;
  if (sirenUtilise) {
    try {
      fiche = await rne.entreprise(sirenUtilise);
    } catch (e) {
      avertissement = `Fiche du registre indisponible (${e.message}).`;
      fiche = societe ? { denomination: societe.denomination, siren: sirenUtilise } : {};
    }
  }

  const nom = `${ops.map((c) => parcours.nomOperation(c)).join(' + ')} — ${fiche.denomination || societe?.denomination || formaterSiren(sirenUtilise) || 'nouvelle société'}`;
  const f = await db(supabase.from('formalites').insert({
    societe_id, type: TYPE, libelle: nom.slice(0, 240), siren: sirenUtilise || null,
    service: 'formalites', fiche, reponses: {}, operations: ops, typologie: {}, statut: 'BROUILLON',
  }).select().single());
  const reference = `LGZ-${new Date().getFullYear()}-${String(f.id).padStart(5, '0')}`;
  await db(supabase.from('formalites').update({ reference }).eq('id', f.id).select());
  await journal(f.id, 'creation', `Parcours ouvert : ${ops.map((c) => parcours.nomOperation(c)).join(', ')}.`, { siren: sirenUtilise });
  return { id: f.id, avertissement };
}

/* ---------------------------------------------------------------- lecture */

/** Le dossier tel que l'écran le présente : étapes, pièces, champs, état. */
async function lire(id) {
  const f = await charger(id);
  const pieces = await db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).order('id'));
  const fiche = f.fiche || {};
  const res = parcours.resoudre(f.operations || [], f.typologie || {}, fiche, f.reponses || {});

  // Rattache les fichiers chargés à leur ligne de la liste.
  const parCle = new Map();
  for (const p of pieces) {
    const k = p.cle || p.code;
    if (!parCle.has(k)) parCle.set(k, []);
    parCle.get(k).push(p);
  }
  const habiller = (item) => ({ ...item, fichiers: (parCle.get(item.cle) || []).map(resumePiece) });
  const listes = {
    obligatoires: res.pieces.obligatoires.map(habiller),
    a_preciser: res.pieces.a_preciser.map(habiller),
    facultatives: res.pieces.facultatives.map(habiller),
  };
  const connues = new Set([...listes.obligatoires, ...listes.a_preciser, ...listes.facultatives].map((p) => p.cle));
  const autres = pieces.filter((p) => !connues.has(p.cle || p.code)).map(resumePiece);

  // Réponses : valeurs saisies, sinon défauts ; chaque champ sait s'il est rempli.
  const rep = f.reponses || {};
  const groupes = res.champs.map((g) => ({
    ...g,
    champs: g.champs.map((c) => {
      const v = rep[g.op]?.[c.name] ?? (c.defaut !== undefined ? c.defaut : (c.prerempli || null));
      const manque = rempli(v, c) ? creationPc.manquants(c, v) : [];
      return { ...c, valeur: v, rempli: rempli(v, c) && !manque.length, manquants: manque, origine: rep._origine?.[`${g.op}.${c.name}`] || null };
    }),
  }));

  const manquantes = listes.obligatoires.filter((p) => !p.fichiers.length);
  const champsManquants = groupes.flatMap((g) => g.champs.filter((c) => c.requis && !c.rempli)
    .map((c) => `${g.titre} : ${c.label}${c.manquants?.length ? ` (${c.manquants.join(', ')})` : ''}`));
  const creation = res.operations.some((o) => parcours.infoOperation(o.code)?.creation);
  const nouvelle = creation ? (rep.c_societe || {}) : {};
  const nonDeposables = res.operations.filter((o) => !deposable(o.code)).map((o) => o.nom);

  return {
    id: f.id,
    reference: f.reference,
    libelle: f.libelle,
    statut: f.statut,
    inpi_id: f.inpi_id,
    numero_liasse: f.numero_liasse,
    montant: f.montant,
    simule: f.simule,
    societe: creation
      ? { denomination: nouvelle.denomination || '', siren: '', forme: creationPc.forme(f.typologie)?.libelle || '', adresse: '', creation: true }
      : { denomination: fiche.denomination || '', siren: fiche.siren_formate || formaterSiren(f.siren || ''), forme: fiche.forme_juridique || '', adresse: fiche.adresse?.texte || '' },
    operations: res.operations,
    questions: res.questions,
    typologie: f.typologie || {},
    pieces: listes,
    autres_pieces: autres,
    champs: groupes,
    incompatibilites: res.incompatibilites,
    analyse: { disponible: analyse.disponible(), derniere: rep._analyse || null },
    etat: {
      // Une liste vide est une réponse (« Aucune ») ; seule l'absence de réponse compte.
      questions_restantes: res.questions.filter((qq) => ((qq.valeur === null || qq.valeur === undefined) && !qq.attente)
        // Une société ne se crée pas sans dirigeant.
        || (qq.id === 'entrants' && qq.creation && Array.isArray(qq.valeur) && !qq.valeur.length)).length,
      pieces_manquantes: manquantes.map((p) => p.court + (p.personne ? ` — ${p.personne}` : '')),
      pieces_a_preciser: listes.a_preciser.length,
      champs_manquants: champsManquants,
      provisoires: pieces.filter((p) => p.version === 'provisoire').length,
      a_signer: pieces.filter((p) => p.a_signer).length,
      non_deposables: nonDeposables,
      pret: !manquantes.length && !champsManquants.length && !listes.a_preciser.length
        && !res.incompatibilites.length && !nonDeposables.length
        && !pieces.some((p) => p.version === 'provisoire'),
    },
  };
}

function resumePiece(p) {
  return { id: p.id, code: p.code, nom: p.filename, taille: p.taille, version: p.version || 'definitive', a_signer: Boolean(p.a_signer), date: p.created_at, analysee: Boolean(p.extraction) };
}

function rempli(v, c) {
  if (v === null || v === undefined || v === '') return false;
  if (c.type === 'ouinon') return typeof v === 'boolean';
  if (c.type === 'adresse') return Boolean(v.codePostal && v.commune);
  if (c.type === 'personne') return Boolean(v.nom && (c.sous_requis || v.date_naissance));
  if (c.type === 'personne_morale') return Boolean(v.denomination || v.nom);
  if (c.type === 'beneficiaires') return Array.isArray(v) && v.length > 0;
  return true;
}

/* ---------------------------------------------------------------- saisies */

async function majOperations(id, operations) {
  const f = await charger(id); verifierOuvert(f);
  const ops = [...new Set(operations)].filter((c) => parcours.infoOperation(c));
  if (!ops.length) throw erreur('Gardez au moins une opération.');
  await db(supabase.from('formalites').update({ operations: ops, updated_at: new Date().toISOString() }).eq('id', id).select());
  await journal(id, 'saisie', `Opérations : ${ops.map((c) => parcours.nomOperation(c)).join(', ')}.`);
  return lire(id);
}

async function majTypologie(id, valeurs) {
  const f = await charger(id); verifierOuvert(f);
  const t = { ...(f.typologie || {}), ...valeurs };
  if (valeurs.manuel) t.manuel = { ...(f.typologie?.manuel || {}), ...valeurs.manuel };
  await db(supabase.from('formalites').update({ typologie: t, updated_at: new Date().toISOString() }).eq('id', id).select());
  return lire(id);
}

/** Réponses par opération ; `origine` note ce qui vient de l'analyse. */
async function majReponses(id, valeurs, { origine = 'saisie' } = {}) {
  const f = await charger(id); verifierOuvert(f);
  const rep = { ...(f.reponses || {}) };
  rep._origine = { ...(rep._origine || {}) };
  for (const [op, champs] of Object.entries(valeurs || {})) {
    if (op === '_origine' || op === '_analyse') continue;
    rep[op] = { ...(rep[op] || {}), ...champs };
    for (const name of Object.keys(champs)) rep._origine[`${op}.${name}`] = origine;
  }
  await db(supabase.from('formalites').update({ reponses: rep, updated_at: new Date().toISOString() }).eq('id', id).select());
  return lire(id);
}

/* ----------------------------------------------------------------- pièces */

async function ajouterPiece(id, { cle, code, version = 'definitive', a_signer = false, fichier }) {
  const f = await charger(id); verifierOuvert(f);
  if (!fichier) throw erreur('Aucun fichier reçu.');
  if (!/pdf$/i.test(fichier.mimetype || '') && !/\.pdf$/i.test(fichier.originalname)) {
    throw erreur('Le guichet n’accepte que des PDF.', 422);
  }
  if (fichier.size > 10 * 1024 * 1024) throw erreur('Fichier de plus de 10 Mo : le guichet le refuserait.', 422);
  // Constaté par essai : le guichet refuse un PDF abîmé (« pièce jointe corrompue »).
  if (!(await pdfLisible(fichier.buffer))) throw erreur(MESSAGE_ILLISIBLE, 422);
  const nom = fichier.originalname.replace(/[^\w.\-]+/g, '_');
  const chemin = `formalites/${id}/${code}_${Date.now()}_${nom}`;
  await uploadFile(chemin, fichier.buffer, 'application/pdf');
  const piece = await db(supabase.from('formalite_pieces').insert({
    formalite_id: id, code, cle: cle || code, libelle: '', filename: fichier.originalname, filepath: chemin,
    taille: fichier.size, version: version === 'provisoire' ? 'provisoire' : 'definitive', a_signer: a_signer === true || a_signer === 'true',
  }).select().single());
  await journal(id, 'piece', `Pièce chargée : ${code} (${fichier.originalname})${piece.version === 'provisoire' ? ', version provisoire' : ''}.`);
  // Une version définitive remplace les brouillons de la même pièce (pouvoir rédigé, acte provisoire…).
  if (piece.version === 'definitive') {
    const brouillons = (await db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).eq('cle', cle || code)))
      .filter((p) => p.version === 'provisoire' && p.id !== piece.id);
    for (const p of brouillons) {
      await db(supabase.from('formalite_pieces').delete().eq('id', p.id).select());
      await journal(id, 'piece', `Version provisoire remplacée : ${p.filename}.`);
    }
  }
  return lire(id);
}

async function majPiece(pieceId, { version, a_signer }) {
  const p = await db(supabase.from('formalite_pieces').select('*').eq('id', pieceId).single());
  const maj = {};
  if (version) maj.version = version === 'provisoire' ? 'provisoire' : 'definitive';
  if (a_signer !== undefined) maj.a_signer = Boolean(a_signer);
  await db(supabase.from('formalite_pieces').update(maj).eq('id', pieceId).select());
  return lire(p.formalite_id);
}

async function retirerPiece(pieceId) {
  const p = await db(supabase.from('formalite_pieces').select('*').eq('id', pieceId).single());
  await db(supabase.from('formalite_pieces').delete().eq('id', pieceId).select());
  await journal(p.formalite_id, 'piece', `Pièce retirée : ${p.code} (${p.filename}).`);
  return lire(p.formalite_id);
}

/**
 * Rédige le pouvoir du cabinet (PJ_51) à partir du dossier et le joint en
 * version provisoire, à faire signer : la version signée le remplacera.
 */
async function redigerPouvoir(id, { mandataire = {} } = {}) {
  const f = await charger(id); verifierOuvert(f);
  const { genererPouvoir } = require('../inpi/pouvoir');
  const res = parcours.resoudre(f.operations || [], f.typologie || {}, f.fiche || {}, f.reponses || {});
  const buffer = genererPouvoir({ fiche: f.fiche || {}, typologie: f.typologie || {}, reponses: f.reponses || {} }, {
    mandataire, operations: res.operations.map((o) => o.nom),
  });
  const chemin = `formalites/${id}/PJ_51_${Date.now()}_pouvoir.pdf`;
  await uploadFile(chemin, buffer, 'application/pdf');
  await db(supabase.from('formalite_pieces').insert({
    formalite_id: id, code: 'PJ_51', cle: 'PJ_51', libelle: 'Pouvoir du mandataire', filename: 'pouvoir-a-signer.pdf', filepath: chemin,
    taille: buffer.length, version: 'provisoire', a_signer: true,
  }).select().single());
  await journal(id, 'piece', `Pouvoir rédigé pour ${mandataire.nom || 'le cabinet'} : à faire signer par le représentant légal.`);
  return lire(id);
}

/* ---------------------------------------------------------------- analyse */

async function analyser(id) {
  const f = await charger(id); verifierOuvert(f);
  const pieces = await db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).order('id'));
  const res = parcours.resoudre(f.operations || [], f.typologie || {}, f.fiche || {}, f.reponses || {});
  const documents = await Promise.all(pieces.slice(0, 12).map(async (p) => ({ nom: p.filename, buffer: await downloadFile(p.filepath) })));
  const r = await analyse.extraire({
    documents, groupes: res.champs, fiche: f.fiche || {}, operations: res.operations.map((o) => o.nom),
  });

  // Les valeurs proposées ne remplacent pas ce que l'utilisateur a saisi.
  const rep = f.reponses || {};
  const proposees = {};
  let nb = 0;
  for (const [op, champs] of Object.entries(r.valeurs)) {
    for (const [name, v] of Object.entries(champs)) {
      if (rep._origine?.[`${op}.${name}`] === 'saisie') continue;
      (proposees[op] = proposees[op] || {})[name] = v;
      nb += 1;
    }
  }
  await majReponses(id, proposees, { origine: 'analyse' });
  const f2 = await charger(id);
  const rep2 = { ...(f2.reponses || {}), _analyse: { date: new Date().toISOString(), champs: nb, incoherences: r.incoherences, documents: r.documents, modele: r.modele } };
  await db(supabase.from('formalites').update({ reponses: rep2 }).eq('id', id).select());
  await db(supabase.from('formalite_pieces').update({ extraction: { date: new Date().toISOString() } }).eq('formalite_id', id).select());
  await journal(id, 'saisie', `Analyse des pièces : ${nb} information(s) proposée(s).`, { incoherences: r.incoherences });
  return lire(id);
}

/* ------------------------------------------------------------------ dépôt */

async function apercu(id) {
  const f = await charger(id);
  const pieces = await db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).order('id'));
  return construireParcours(dossierDe(f, pieces)).corps;
}

function dossierDe(f, pieces) {
  return {
    operations: f.operations, typologie: f.typologie, reponses: f.reponses, fiche: f.fiche,
    siren: f.siren, reference: f.reference, libelle: f.libelle,
    pieces: pieces.map((p) => ({ code: p.code, nom: p.filename })),
  };
}

async function deposer(id) {
  const f = await charger(id); verifierOuvert(f);
  const etat = (await lire(id)).etat;
  if (!etat.pret) throw erreur('Le dossier n’est pas complet : voir la liste de ce qui manque.', 422, { details: etat });
  const pieces = await db(supabase.from('formalite_pieces').select('*').eq('formalite_id', id).order('id'));
  const encodees = await Promise.all(pieces.map(async (p) => ({ code: p.code, nom: p.filename, base64: (await downloadFile(p.filepath)).toString('base64') })));
  const requete = construireParcours({ ...dossierDe(f, pieces), pieces: encodees });
  let r;
  try {
    r = await guichet.deposer(requete);
  } catch (e) {
    // Le refus du guichet nomme les champs en cause : on les garde, pour
    // que le formulaire ciblé propose aussitôt de les corriger.
    const violations = (e.detail?.violations || []).map((v) => ({ champ: v.propertyPath, message: v.message }));
    if (violations.length) {
      await db(supabase.from('formalites').update({ typologie: { ...(f.typologie || {}), _rejets: violations } }).eq('id', id).select());
      await journal(id, 'depot', `Dépôt refusé par le guichet : ${violations.length} donnée(s) à corriger.`, { violations });
    }
    throw e;
  }
  await db(supabase.from('formalites').update({
    payload: construireParcours(dossierDe(f, pieces)).corps,
    statut: r.statut, inpi_id: r.inpi_id, numero_liasse: r.numero_liasse, statut_inpi: r.statut_brut,
    statut_date: r.statut_date || new Date().toISOString(), action_attendue: r.action_attendue,
    montant: r.montant, simule: Boolean(r.simule), updated_at: new Date().toISOString(),
  }).eq('id', id).select());
  await db(supabase.from('formalites').update({ typologie: { ...(f.typologie || {}), _rejets: [] } }).eq('id', id).select());
  // Le guichet dit quels événements il a reconnus : un écart signale une
  // opération qui ne serait pas inscrite, à vérifier avant de signer.
  const attendus = (f.operations || []).map((c) => parcours.evenementAttendu(c, f.fiche?.forme_juridique_code));
  const nonReconnus = r.simule ? [] : attendus.filter((e) => !(r.evenements || []).includes(e));
  if (nonReconnus.length) {
    await journal(id, 'depot', `Attention : le guichet n’a pas reconnu ${nonReconnus.join(', ')}. Vérifier le dossier avant de le signer.`, { reconnus: r.evenements });
  }
  await journal(id, 'depot', r.simule ? `Dépôt simulé (${r.motif_simulation}).` : `Déposé au guichet unique — liasse ${r.numero_liasse}.`, { inpi_id: r.inpi_id, montant: r.montant });
  return lire(id);
}

/** Listes de référence du guichet pour les écrans : journaux, nationalités, catégories d'activité. */
let REFERENTIELS = null;
function referentiels() {
  if (!REFERENTIELS) {
    const { enumeration } = require('../inpi/referentiels');
    REFERENTIELS = {
      journaux: Object.keys(enumeration('journalPublication')).filter((j) => j !== 'Autre').sort((a, b) => a.localeCompare(b, 'fr')),
      nationalites: Object.entries(enumeration('codeNationalite')).map(([code, libelle]) => [code, libelle]).sort((a, b) => a[1].localeCompare(b[1], 'fr')),
      types_voie: Object.entries(enumeration('typeVoie')),
      categories: creationPc.feuillesCategories().map((c) => ({ code: c.code, chemin: c.chemin.join(' › '), forme: creationPc.formeExercice(c) })),
    };
  }
  return REFERENTIELS;
}

module.exports = {
  TYPE, creer, referentiels, redigerPouvoir, lire, majOperations, majTypologie, majReponses,
  ajouterPiece, majPiece, retirerPiece, analyser, apercu, deposer,
};
