'use strict';

/**
 * Connecteur « Guichet unique » : Claude gestionnaire de formalités, hors de
 * l'application (claude.ai, Claude Code, Claude mobile).
 *
 * Chaque outil reprend le moteur de l'application — règles de pièces,
 * contrôles, dépôt, suivi — sans rien réécrire : un dossier ouvert ici est un
 * dossier « parcours » comme un autre, avec l'origine « assistant ». Il se
 * consulte dans l'onglet « Suivi Formalités AI », en lecture seule.
 *
 * Règles constantes, tenues ici et non seulement dans les consignes données
 * à Claude :
 *   - rien ne part au guichet sans `confirmation_avocat: true` ;
 *   - aucun outil ne signe ni ne paie ;
 *   - le connecteur ne modifie que ses propres dossiers.
 */

const crypto = require('crypto');
const { supabase, q } = require('../supa');
const parcoursSvc = require('../services/parcours');
const formalites = require('../services/formalites');
const moteur = require('../inpi/parcours');
const rne = require('../inpi/rne');
const guichet = require('../inpi/guichet');
const { config } = require('../inpi/config');
const { statut: statutInfo } = require('../inpi/referentiels');
const { ajouterMois } = require('../modules/dossiers/echeances');
const { nettoyerSiren } = require('../inpi/normalize');

const ORIGINE = 'assistant';
const DUREE_LIEN_JOURS = 7;
const JOUR_MS = 24 * 3600 * 1000;

function erreur(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const empreinte = (jeton) => crypto.createHash('sha256').update(String(jeton)).digest('hex');

function adresseApplication() {
  return process.env.APP_URL || `https://${process.env.APP_HOST || 'legalize-rho.vercel.app'}`;
}

/** Ce que Claude doit dire à l'avocat sur la portée réelle des envois. */
function modes() {
  return {
    guichet_simulation: guichet.simulationActive(),
    motif_simulation: guichet.simulationActive() ? guichet.motifSimulation() : null,
    registre_simulation: config.modeRne === 'simulation',
    environnement_guichet: config.guichet?.environnement || null,
    portail_signature: config.guichet?.portailUrl || null,
  };
}

/* ---------------------------------------------------------------- dossiers */

/** Un dossier par sa référence (LGZ-2026-00012) ou son numéro. */
async function chargerParReference(reference) {
  const ref = String(reference || '').trim();
  if (!ref) throw erreur('Indiquez la référence du dossier (par exemple LGZ-2026-00012).');
  const lignes = /^\d+$/.test(ref)
    ? await q(supabase.from('formalites').select('*').eq('id', ref))
    : await q(supabase.from('formalites').select('*').eq('reference', ref.toUpperCase()));
  if (!lignes.length) throw erreur(`Aucun dossier sous la référence ${ref}.`, 404);
  return lignes[0];
}

/** Le connecteur ne touche qu'à ses propres dossiers ; ceux de l'application se modifient dans l'application. */
async function chargerModifiable(reference) {
  const f = await chargerParReference(reference);
  if (f.origine !== ORIGINE || f.type !== parcoursSvc.TYPE) {
    throw erreur(`Le dossier ${f.reference} a été ouvert dans Legalize : il se modifie dans l'application, pas depuis le connecteur.`, 403);
  }
  return f;
}

/** Le dossier Legalize (client) auquel rattacher la formalité : numéro ou référence (2026-0012). */
async function dossierLegalize(valeur) {
  if (valeur === undefined || valeur === null || valeur === '') return null;
  const v = String(valeur).trim();
  const lignes = /^\d+$/.test(v)
    ? await q(supabase.from('dossiers').select('id, reference, titre').eq('id', v))
    : await q(supabase.from('dossiers').select('id, reference, titre').eq('reference', v));
  if (!lignes.length) throw erreur(`Aucun dossier Legalize sous « ${v} ».`, 404);
  return lignes[0];
}

/* ---------------------------------------------------------------- échéance */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Délai de dépôt : un mois de la décision pour une modification ou une
 * dissolution (art. R. 123-66 C. com.), quinze jours du début d'activité
 * pour une création. Le mois se compte de quantième à quantième.
 */
function echeanceDe(operations = [], reponses = {}, maintenant = new Date()) {
  const creation = operations.some((c) => moteur.infoOperation(c)?.creation);
  let depart = null;
  let limite = null;
  let texte;
  if (creation) {
    depart = Object.values(reponses).map((g) => g?.date_debut_activite).find((v) => DATE.test(String(v || '')));
    if (depart) limite = new Date(Date.parse(depart) + 15 * JOUR_MS).toISOString().slice(0, 10);
    texte = '15 jours à compter du début d’activité';
  } else if (operations.includes('28M')) {
    // TUP : la radiation suit la transmission du patrimoine, pas la décision.
    depart = DATE.test(String(reponses['28M']?.date_transmission || '')) ? reponses['28M'].date_transmission : null;
    if (depart) limite = ajouterMois(depart, 1);
    texte = '1 mois à compter de la transmission du patrimoine (expiration du délai d’opposition)';
    if (!depart) return { connue: false, regle: texte, message: 'Date de réalisation de la transmission du patrimoine à renseigner.' };
  } else {
    depart = DATE.test(String(reponses.commun?.date_decision || '')) ? reponses.commun.date_decision : null;
    if (depart) limite = ajouterMois(depart, 1);
    texte = '1 mois à compter de la décision (art. R. 123-66 C. com.)';
  }
  if (!limite) return { connue: false, regle: texte, message: creation ? 'Date de début d’activité à renseigner.' : 'Date de la décision à renseigner.' };
  const jours = Math.ceil((Date.parse(limite) - Date.parse(maintenant.toISOString().slice(0, 10))) / JOUR_MS);
  return {
    connue: true, regle: texte, depart, limite, jours_restants: jours,
    etat: jours < 0 ? 'depassee' : (jours <= 7 ? 'imminente' : 'dans_les_temps'),
  };
}

/* ---------------------------------------------------------------- vues */

function vuePiece(p) {
  return {
    cle: p.cle, code: p.code, piece: p.court || p.libelle, libelle: p.libelle,
    ...(p.personne ? { personne: p.personne } : {}),
    ...(p.raison ? { raison: p.raison } : {}),
    ...(p.condition ? { condition: p.condition } : {}),
    ...(p.variantes?.length ? { documents_acceptes: p.variantes } : {}),
    ...(p.fichiers ? { recue: p.fichiers.map((f) => ({ id: f.id, nom: f.nom })) } : {}),
  };
}

/** Forme attendue des réponses de qualification, pour que Claude les transmette sans erreur. */
const FORMATS = {
  entrants: 'Liste : [{"nom": "Prénom NOM ou dénomination", "nature": "PP" (personne physique) ou "PM" (personne morale), "fonction": valeur d’une des options}]',
  sortants: 'Liste : [{"nom": "tel qu’inscrit au registre (voir dirigeants_au_registre)", "motif": valeur d’une des options}]',
  maj: 'Liste : [{"nom": un des dirigeants_au_registre, "motif": valeur d’une des options}]. Renseignez ensuite le champ « maj_<rang> » du groupe MAJDIR (pré-rempli depuis le registre : corrigez seulement ce qui change, par exemple la nouvelle dénomination).',
  choix: 'Une des valeurs des options (true / false pour oui / non).',
};

function vueQuestion(qq) {
  return {
    id: qq.id, question: qq.libelle, ...(qq.aide ? { aide: qq.aide } : {}), type: qq.type,
    ...(qq.options ? { options: qq.options.map(([v, l]) => ({ valeur: v, libelle: l })) } : {}),
    ...(qq.dirigeants_actuels ? { dirigeants_au_registre: qq.dirigeants_actuels } : {}),
    ...(qq.attente ? { en_attente: qq.attente } : {}),
    ...(FORMATS[qq.type] ? { format: FORMATS[qq.type] } : {}),
    valeur: qq.valeur ?? null,
  };
}

/** Forme attendue des champs composés (personne, adresse). */
const FORMATS_CHAMPS = {
  personne: 'Objet : {"nom": nom de naissance, "prenoms", "genre": "1" (masculin) ou "2" (féminin), "date_naissance": "AAAA-MM-JJ", "lieu_naissance": commune, '
    + '"code_insee_naissance" (si né en France), "pays_naissance": "FRANCE", "nationalite": "Française", '
    + '"adresse": {"numVoie", "typeVoie", "voie": nom de la rue ou lieu-dit, "codePostal", "commune"}}',
  adresse: 'Objet : {"numVoie", "typeVoie", "voie": nom de la rue ou lieu-dit, "codePostal", "commune"}',
};

function vueChamp(c, valeur) {
  return {
    name: c.name, label: c.label, type: c.type, requis: Boolean(c.requis),
    ...(c.aide ? { aide: c.aide } : {}),
    ...(FORMATS_CHAMPS[c.type] ? { format: FORMATS_CHAMPS[c.type] } : {}),
    ...(c.sous_requis ? { sous_champs_requis: c.sous_requis } : {}),
    ...(c.chemin_inpi ? { chemin_inpi: c.chemin_inpi } : {}),
    ...(c.options ? { options: c.options } : {}),
    ...(c.actuel !== undefined && c.actuel !== null && c.actuel !== '' ? { valeur_au_registre: c.actuel } : {}),
    ...(valeur !== undefined ? { valeur } : {}),
  };
}

/** Exigences d'un jeu d'opérations, sans dossier. */
function exigences(ops, typologie, fiche, reponses) {
  const r = moteur.resoudre(ops, typologie || {}, fiche || {}, reponses || {});
  return {
    operations: r.operations.map((o) => ({ code: o.code, nom: o.nom })),
    questions: r.questions.map(vueQuestion),
    champs: r.champs.map((g) => ({ groupe: g.op, titre: g.titre, champs: g.champs.map((c) => vueChamp(c, reponses?.[g.op]?.[c.name])) })),
    pieces: {
      obligatoires: r.pieces.obligatoires.map(vuePiece),
      a_preciser: r.pieces.a_preciser.map(vuePiece),
      facultatives: r.pieces.facultatives.map(vuePiece),
    },
    incompatibilites: r.incompatibilites,
  };
}

/** Le dossier tel que Claude le présente à l'avocat. */
async function vueDossier(id) {
  const d = await parcoursSvc.lire(id);
  const [f] = await q(supabase.from('formalites').select('*').eq('id', id));
  return {
    reference: d.reference,
    libelle: d.libelle,
    statut: statutInfo(d.statut).libelle,
    societe: d.societe,
    operations: d.operations.map((o) => ({ code: o.code, nom: o.nom })),
    questions: d.questions.map(vueQuestion),
    champs: d.champs.map((g) => ({
      groupe: g.op, titre: g.titre,
      champs: g.champs.map((c) => ({
        ...vueChamp(c, c.valeur), rempli: c.rempli, ...(c.manquants?.length ? { manque: c.manquants } : {}),
        ...(c.leve ? { exigence_levee: c.leve } : {}), ...(c.levee_inoperante ? { exigence_levee_inoperante: c.levee_inoperante } : {}),
      })),
    })),
    pieces: {
      obligatoires: d.pieces.obligatoires.map(vuePiece),
      a_preciser: d.pieces.a_preciser.map(vuePiece),
      facultatives: d.pieces.facultatives.map(vuePiece),
      autres_recues: d.autres_pieces.map((p) => ({ code: p.code, nom: p.nom })),
    },
    incompatibilites: d.incompatibilites,
    ...(d.fiche_absente ? { fiche_absente: true } : {}),
    etat: d.etat,
    echeance: echeanceDe(f.operations || [], f.reponses || {}),
    lien_depot_expire: f.depot_expire || null,
    inpi: d.inpi_id ? { identifiant: d.inpi_id, liasse: d.numero_liasse, montant: d.montant, simule: d.simule } : null,
    ...modes(),
  };
}

/** Garde l'échéance du dossier à jour : l'onglet de suivi la classe par là. */
async function memoriserEcheance(f) {
  const e = echeanceDe(f.operations || [], f.reponses || {});
  const valeur = e.connue ? e.limite : null;
  if ((f.echeance || null) !== valeur) {
    await q(supabase.from('formalites').update({ echeance: valeur }).eq('id', f.id).select('id'));
  }
}

/**
 * Contrôle les réponses de qualification avant de les enregistrer. Une réponse
 * mal formée était jusqu'ici ignorée en silence (une mise à jour de dirigeant
 * mal désignée faisait disparaître son justificatif) : elle est désormais
 * refusée, avec la forme attendue.
 */
function validerTypologie(ops, typologie, fiche = {}, existante = {}) {
  if (typologie === undefined || typologie === null) return null;
  if (typeof typologie !== 'object' || Array.isArray(typologie)) throw erreur('« typologie » doit être un objet : { identifiant_de_question: réponse }.', 422);
  const fusion = moteur.normaliserTypologie({ ...existante, ...typologie });
  const questions = moteur.resoudre(ops, fusion, fiche, {}).questions;
  const connues = new Set([...Object.keys(moteur.QUESTIONS), 'manuel']);
  const fautes = [];
  const valeurs = (qq) => (qq?.options || []).map(([v]) => v);
  const dans = (v, liste) => liste.some((x) => x === v || String(x) === String(v));
  for (const [cle, v] of Object.entries(typologie)) {
    if (!connues.has(cle)) { fautes.push(`« ${cle} » n’est pas une question connue (questions possibles : ${[...connues].join(', ')}).`); continue; }
    if (cle === 'manuel') {
      if (!v || typeof v !== 'object' || Object.values(v).some((x) => typeof x !== 'boolean')) fautes.push('« manuel » : { "<cle de la pièce>": true | false }.');
      continue;
    }
    const qq = questions.find((x) => x.id === cle);
    if (!qq) continue; // question sans objet pour ces opérations : sans effet
    const lignes = fusion[cle];
    if (['entrants', 'sortants', 'maj'].includes(qq.type)) {
      if (!Array.isArray(v)) { fautes.push(`« ${cle} » : ${FORMATS[qq.type]}`); continue; }
      lignes.forEach((l, i) => {
        const ou = `« ${cle} » ligne ${i + 1}`;
        if (!l.nom) fautes.push(`${ou} : « nom » manquant. ${FORMATS[qq.type]}`);
        if (qq.type === 'entrants') {
          if (!['PP', 'PM'].includes(l.nature)) fautes.push(`${ou} : « nature » doit valoir "PP" ou "PM".`);
          if (valeurs(qq).length && !dans(l.fonction, valeurs(qq))) fautes.push(`${ou} : « fonction » parmi ${valeurs(qq).join(', ')}.`);
        } else if (!dans(l.motif, valeurs(qq))) {
          fautes.push(`${ou} : « motif » parmi ${valeurs(qq).join(', ')}.`);
        }
        if (qq.type === 'maj' && l.nom && fiche?.brut && !moteur.pouvoirActuel(fiche, l.nom)) {
          fautes.push(`${ou} : « ${l.nom} » ne figure pas parmi les dirigeants du registre (${(qq.dirigeants_actuels || []).join(', ')}).`);
        }
      });
    } else if (qq.type === 'choix' && valeurs(qq).length && !dans(v, valeurs(qq))) {
      fautes.push(`« ${cle} » : une des valeurs ${valeurs(qq).map((x) => JSON.stringify(x)).join(', ')}.`);
    }
  }
  if (fautes.length) throw erreur(`Réponses de qualification refusées :\n- ${fautes.join('\n- ')}`, 422);
  return typologie;
}

async function appliquerSaisies(id, { operations, typologie, reponses, exigences_champs: exigencesChamps }) {
  if (Array.isArray(operations) && operations.length) await parcoursSvc.majOperations(id, operations);
  if (typologie && typeof typologie === 'object') {
    const [f0] = await q(supabase.from('formalites').select('*').eq('id', id));
    validerTypologie(f0.operations || [], typologie, f0.fiche || {}, f0.typologie || {});
    await parcoursSvc.majTypologie(id, typologie);
  }
  if (reponses && typeof reponses === 'object') await parcoursSvc.majReponses(id, reponses, { origine: 'saisie' });
  if (exigencesChamps !== undefined && exigencesChamps !== null) {
    // Certains clients transmettent la liste sous forme de texte JSON.
    if (typeof exigencesChamps === 'string') { try { exigencesChamps = JSON.parse(exigencesChamps); } catch (e) { /* refusée ci-dessous */ } }
    if (!Array.isArray(exigencesChamps)) throw erreur('« exigences_champs » : liste [{"champ": "<groupe>.<name>", "requis": false, "motif": "…"}].', 422);
    await parcoursSvc.majExigences(id, exigencesChamps);
  }
  const [f] = await q(supabase.from('formalites').select('*').eq('id', id));
  await memoriserEcheance(f);
}

/* ------------------------------------------------------------------ outils */

function operationsValides(operations) {
  const ops = [...new Set((operations || []).map((c) => String(c).trim().toUpperCase()))];
  const inconnues = ops.filter((c) => !moteur.infoOperation(c));
  if (inconnues.length) throw erreur(`Opération(s) inconnue(s) : ${inconnues.join(', ')}. Voir catalogue_operations.`);
  if (!ops.length) throw erreur('Indiquez au moins une opération (code évènement, par exemple 35M).');
  return ops;
}

/** Un refus d'accès du registre dit en clair ce que l'avocat doit faire. */
async function registre403(appel) {
  try {
    return await appel();
  } catch (e) {
    if (e.status === 403 && /pour\s+API/i.test(e.message || '')) {
      throw erreur('Le compte INPI utilisé pour lire le registre (variable INPI_RNE_USERNAME dans Vercel) n’a pas l’accès API au registre national des entreprises. '
        + 'Remettre un compte disposant de cet accès, ou demander l’accès API pour ce compte à l’INPI. Ne préparez pas de modification sans la fiche du registre.', 403);
    }
    throw e;
  }
}

async function rechercherEntreprise({ terme }) {
  return { resultats: await registre403(() => rne.rechercher(terme)), ...modes() };
}

async function ficheEntreprise({ siren }) {
  const f = await registre403(() => rne.entreprise(siren));
  return {
    siren: f.siren_formate || f.siren, denomination: f.denomination, sigle: f.sigle || null,
    forme_juridique: f.forme_juridique, forme_juridique_code: f.forme_juridique_code,
    capital: f.capital ?? null, devise: f.devise_capital || null, adresse: f.adresse?.texte || null,
    objet: f.objet || null, activite_principale: f.activite_principale || null,
    date_immatriculation: f.date_immatriculation || null, date_cloture: f.date_cloture || null,
    radiee: Boolean(f.radiee), ...(f.date_radiation ? { date_radiation: f.date_radiation } : {}), dirigeants: (f.dirigeants || []).map((d) => ({ nom: d.nom_complet, fonction: d.role_libelle || d.role || null })),
    ...modes(),
  };
}

function catalogueOperations() {
  return {
    operations: Object.keys(moteur.OPERATIONS).map((code) => ({
      code, nom: moteur.nomOperation(code),
      ...(moteur.infoOperation(code)?.creation ? { creation: true } : {}),
      ...(moteur.infoOperation(code)?.cessation ? { cessation: true } : {}),
    })),
  };
}

async function exigencesFormalite({ operations, siren, typologie = {}, reponses = {} }) {
  const ops = operationsValides(operations);
  let fiche = {};
  let avertissement = null;
  if (siren && nettoyerSiren(siren)) {
    try { fiche = await rne.entreprise(siren); } catch (e) { avertissement = `Fiche du registre indisponible : ${e.message}`; }
  }
  validerTypologie(ops, typologie, fiche);
  return {
    ...exigences(ops, typologie, fiche, reponses),
    echeance: echeanceDe(ops, reponses),
    ...(avertissement ? { avertissement } : {}),
    ...modes(),
  };
}

/**
 * Ouvre (ou met à jour) le dossier et émet un lien de dépôt des PDF, valable
 * 7 jours. Rappelé avec la même référence, il remplace le lien précédent.
 */
async function ouvrirDepotPieces({ reference, siren, operations, typologie, reponses, exigences_champs: exigencesChamps, dossier_id: dossierId }) {
  let id;
  let avertissement = null;
  if (reference) {
    const f = await chargerModifiable(reference);
    id = f.id;
    if (f.inpi_id) throw erreur('Dossier déjà enregistré au guichet : les pièces ne se complètent plus ici.', 409);
    await appliquerSaisies(id, { operations: operations ? operationsValides(operations) : null, typologie, reponses, exigences_champs: exigencesChamps });
  } else {
    const ops = operationsValides(operations);
    if (typologie) {
      let fiche = {};
      if (siren && nettoyerSiren(siren)) { try { fiche = await rne.entreprise(siren); } catch (e) { fiche = {}; } }
      validerTypologie(ops, typologie, fiche);
    }
    const dossier = await dossierLegalize(dossierId);
    const cree = await parcoursSvc.creer({ siren: siren || '', operations: ops, dossier_id: dossier?.id || null });
    id = cree.id;
    avertissement = cree.avertissement;
    await q(supabase.from('formalites').update({ origine: ORIGINE }).eq('id', id).select('id'));
    await appliquerSaisies(id, { typologie, reponses, exigences_champs: exigencesChamps });
  }
  const jeton = crypto.randomBytes(24).toString('base64url');
  const expire = new Date(Date.now() + DUREE_LIEN_JOURS * JOUR_MS).toISOString();
  await q(supabase.from('formalites').update({ depot_jeton: empreinte(jeton), depot_expire: expire }).eq('id', id).select('id'));
  await q(supabase.from('formalite_evenements').insert({ formalite_id: id, type: 'note', message: `Lien de dépôt des pièces émis par l’assistant (valable jusqu’au ${expire.slice(0, 10)}).` }).select('id'));
  const vue = await vueDossier(id);
  return {
    lien_depot: `${adresseApplication()}/depot/${jeton}`,
    lien_valable_jusqu_au: expire,
    consigne: 'Donnez ce lien à l’avocat : il y dépose les PDF (10 Mo maximum chacun), depuis son téléphone ou son ordinateur. Vérifiez ensuite avec pieces_recues.',
    ...(avertissement ? { avertissement } : {}),
    dossier: vue,
  };
}

async function renseignerFormalite({ reference, operations, typologie, reponses, exigences_champs: exigencesChamps }) {
  const f = await chargerModifiable(reference);
  if (f.inpi_id) throw erreur('Dossier déjà enregistré au guichet : il se modifie sur le portail.', 409);
  await appliquerSaisies(f.id, { operations: operations ? operationsValides(operations) : null, typologie, reponses, exigences_champs: exigencesChamps });
  return vueDossier(f.id);
}

async function piecesRecues({ reference }) {
  const f = await chargerParReference(reference);
  const v = await vueDossier(f.id);
  return { reference: v.reference, pieces: v.pieces, manquantes: v.etat.pieces_manquantes, lien_depot_expire: v.lien_depot_expire };
}

/** Une pièce reçue du dossier, par son numéro ou son nom de fichier. */
function trouverFichier(v, fichier) {
  const tous = [
    ...[...v.pieces.obligatoires, ...v.pieces.a_preciser, ...v.pieces.facultatives].flatMap((l) => (l.recue || []).map((x) => ({ ...x, cle: l.cle, code: l.code }))),
    ...v.pieces.autres_recues,
  ];
  const cle = String(fichier ?? '').trim();
  const trouves = /^\d+$/.test(cle) ? tous.filter((x) => String(x.id) === cle)
    : tous.filter((x) => x.nom === cle).concat(tous.filter((x) => x.nom !== cle && x.nom.toLowerCase().includes(cle.toLowerCase())));
  if (!cle || !trouves.length) throw erreur(`Aucune pièce reçue ne correspond à « ${cle} ». Pièces reçues : ${tous.map((x) => `${x.id} — ${x.nom}`).join(' ; ') || 'aucune'}.`, 404);
  if (new Set(trouves.map((x) => x.id)).size > 1 && trouves[0].nom !== cle) throw erreur(`Plusieurs pièces correspondent à « ${cle} » : précisez son numéro (${trouves.map((x) => `${x.id} — ${x.nom}`).join(' ; ')}).`, 409);
  return trouves[0];
}

async function reclasserPiece({ reference, fichier, cle, code_pj: codePj }) {
  const f = await chargerModifiable(reference);
  if (f.inpi_id) throw erreur('Dossier déjà enregistré au guichet : les pièces se gèrent sur le portail.', 409);
  const x = trouverFichier(await vueDossier(f.id), fichier);
  await parcoursSvc.reclasserPiece(x.id, { cle, code: codePj ? String(codePj).trim().toUpperCase() : undefined });
  const v = await vueDossier(f.id);
  return { reference: v.reference, reclassee: x.nom, pieces: v.pieces, manquantes: v.etat.pieces_manquantes };
}

async function retirerPiece({ reference, fichier }) {
  const f = await chargerModifiable(reference);
  if (f.inpi_id) throw erreur('Dossier déjà enregistré au guichet : les pièces se gèrent sur le portail.', 409);
  const x = trouverFichier(await vueDossier(f.id), fichier);
  await parcoursSvc.retirerPiece(x.id);
  const v = await vueDossier(f.id);
  return { reference: v.reference, retiree: x.nom, pieces: v.pieces, manquantes: v.etat.pieces_manquantes };
}

/** Types de pièces acceptés par le guichet pour une société (pièces hors liste). */
function cataloguePieces() {
  const usage = require('../inpi/data/pieces-guichet.json').valeurs;
  const { PIECES } = require('../inpi/referentiels');
  return {
    pieces: Object.entries(PIECES)
      .filter(([code]) => !usage[code] || (usage[code].types || []).includes('PM'))
      .map(([code, p]) => ({ code, libelle: p.libelle })),
  };
}

async function controlerFormalite({ reference }) {
  const f = await chargerParReference(reference);
  const v = await vueDossier(f.id);
  const bloquants = [
    // Sans la fiche du registre, les dirigeants en place, l'objet et les greffes sont inconnus : le dossier serait faux.
    ...(v.fiche_absente ? ['Fiche de la société au registre (RNE) indisponible : dirigeants, objet et greffes inconnus. Vérifier l’accès API du compte INPI du registre, puis rouvrir le dossier.'] : []),
    ...v.etat.champs_manquants.map((m) => `Information manquante — ${m}`),
    ...v.etat.pieces_manquantes.map((m) => `Pièce obligatoire non reçue — ${m}`),
    ...(v.etat.questions_restantes ? [`${v.etat.questions_restantes} question(s) de qualification sans réponse`] : []),
    ...(v.etat.pieces_a_preciser ? [`${v.etat.pieces_a_preciser} pièce(s) « selon le cas » à trancher (typologie.manuel)`] : []),
    ...v.incompatibilites.map((m) => (typeof m === 'string' ? m : m.message || JSON.stringify(m))),
    ...v.etat.non_deposables.map((m) => `Opération à finaliser sur le portail, non transmissible par l’API : ${m}`),
    ...(v.etat.provisoires ? [`${v.etat.provisoires} pièce(s) en version provisoire`] : []),
  ];
  const levees = v.etat.exigences_levees || [];
  for (const l of levees.filter((x) => x.etat === 'inoperante')) {
    bloquants.push(`Donnée erronée — ${l.groupe} : ${l.label} (${(l.manque || []).join(', ')}) : l’exigence levée ne couvre pas une donnée invalide, corrigez-la.`);
  }
  const alertes = [];
  if (v.echeance.connue && v.echeance.etat !== 'dans_les_temps') {
    alertes.push(v.echeance.etat === 'depassee' ? `Délai de dépôt dépassé depuis le ${v.echeance.limite}.` : `Délai de dépôt imminent : ${v.echeance.limite} (${v.echeance.jours_restants} jour(s)).`);
  }
  if (v.guichet_simulation) alertes.push(`Mode simulation : rien ne sera transmis à l’INPI (${v.motif_simulation}).`);
  if (f.fiche?.radiee) alertes.push('Société radiée au registre.');
  for (const l of levees.filter((x) => x.etat !== 'inoperante')) {
    const etat = l.etat === 'renseigne' ? 'renseigné (transmis)' : l.etat === 'partiel' ? 'renseigné en partie (non transmis)' : 'non renseigné';
    alertes.push(`Champ « ${l.label} » ${etat} : exigence levée à la demande de l’avocat — motif : ${l.motif}`);
  }
  // Bloquants que l'avocat peut décider de lever : l'assistant doit savoir que l'option existe.
  const levables = v.champs.flatMap((g) => g.champs.filter((c) => c.requis && !c.rempli && !c.exigence_levee && !c.exigence_levee_inoperante
    && !parcoursSvc.refusLevee(g.groupe, c))
    .map((c) => ({
      champ: `${g.groupe}.${c.name}`, libelle: c.label,
      ...(/^representant_/.test(c.name) && !/commissaire aux comptes/i.test(c.label)
        ? { attention: 'Le portail a exigé cette identité pour signer (constaté pour une société présidente) : la lever expose à un brouillon non signable.' } : {}),
    })));
  return {
    reference: v.reference, pret: v.etat.pret && !bloquants.length, bloquants, alertes,
    ...(levables.length ? {
      exigences_levables: levables,
      levee_possible: 'Si l’avocat décide expressément qu’une de ces données n’est pas exigée pour ce dossier, levez-la avec renseigner_formalite '
        + '(exigences_champs : [{"champ", "requis": false, "motif"}]) ; elle deviendra une alerte. Ne le faites jamais de votre propre initiative.',
    } : {}),
    exigences_levees: levees.map((l) => ({ champ: l.champ, libelle: l.label, motif: l.motif, date: l.date, etat: l.etat, transmis: l.transmis })),
    echeance: v.echeance, guichet_simulation: v.guichet_simulation, motif_simulation: v.motif_simulation,
    deja_enregistre: Boolean(f.inpi_id),
  };
}

async function enregistrerFormalite({ reference, confirmation_avocat: confirmation }) {
  if (confirmation !== true) {
    throw erreur('Enregistrement refusé : l’avocat doit d’abord confirmer expressément (confirmation_avocat: true, après son accord explicite).', 412);
  }
  const f = await chargerModifiable(reference);
  if (f.inpi_id) {
    return { deja_enregistre: true, message: 'Dossier déjà enregistré au guichet : ne pas relancer, passer au suivi.', inpi: { identifiant: f.inpi_id, liasse: f.numero_liasse, montant: f.montant, simule: f.simule } };
  }
  await parcoursSvc.deposer(f.id);
  const [apres] = await q(supabase.from('formalites').select('*').eq('id', f.id));
  return {
    enregistre: true,
    simule: Boolean(apres.simule),
    ...(apres.simule ? { motif_simulation: guichet.motifSimulation(), message: 'Simulation : rien n’a été transmis à l’INPI.' } : {}),
    inpi: { identifiant: apres.inpi_id, liasse: apres.numero_liasse, montant: apres.montant },
    statut: statutInfo(apres.statut).libelle,
    suite: 'L’avocat signe puis paie sur le portail du guichet unique ; la formalité y reste modifiable ou supprimable tant qu’elle n’est pas payée.',
  };
}

async function journalDe(id, n = 15) {
  const ev = await q(supabase.from('formalite_evenements').select('*').eq('formalite_id', id).order('created_at', { ascending: false }));
  return ev.slice(0, n).map((e) => ({ date: e.created_at, type: e.type, message: e.message }));
}

const ACTIONS = {
  deposer: 'Avocat : vérifier puis déposer, signer et payer sur le portail',
  signer: 'Avocat : signer sur le portail',
  payer: 'Avocat : payer sur le portail',
  regulariser: 'Préparer la régularisation demandée, puis la faire valider',
  attendre: 'Attendre le traitement',
};

async function statutFormalite({ reference }) {
  const f = await chargerParReference(reference);
  let synchro = null;
  if (f.inpi_id) {
    try { synchro = await formalites.synchroniser(f.id); } catch (e) { synchro = { erreur: e.message }; }
  }
  const [a] = await q(supabase.from('formalites').select('*').eq('id', f.id));
  const info = statutInfo(a.statut);
  const action = a.statut === 'BROUILLON' && !a.inpi_id ? null : (a.action_attendue || info.action);
  return {
    reference: a.reference, libelle: a.libelle, statut: info.libelle, statut_inpi: a.statut_inpi || null,
    action_attendue: action ? (ACTIONS[action] || action) : (a.inpi_id ? null : 'Dossier pas encore enregistré au guichet'),
    inpi: a.inpi_id ? { identifiant: a.inpi_id, liasse: a.numero_liasse, montant: a.montant, simule: a.simule, numero_national: a.num_nat || null } : null,
    regularisations: a.regularisations || [],
    echeance: echeanceDe(a.operations || [], a.reponses || {}),
    ...(synchro?.erreur ? { avertissement: `Lecture du guichet impossible : ${synchro.erreur}` } : {}),
    ...(synchro?.changement ? { changement: true } : {}),
    journal: await journalDe(a.id),
  };
}

async function listerFormalites({ perimetre = 'assistant' } = {}) {
  const toutes = await formalites.lister({});
  const liste = perimetre === 'tous' ? toutes : toutes.filter((f) => f.origine === ORIGINE);
  return {
    perimetre,
    formalites: liste.map((f) => ({
      reference: f.reference, libelle: f.libelle, societe: f.societe_nom, statut: f.statut_libelle,
      action_attendue: f.action_attendue ? (ACTIONS[f.action_attendue] || f.action_attendue) : null,
      echeance: f.echeance || null, en_retard: f.en_retard, regularisations: f.nb_regularisations,
      liasse: f.numero_liasse || null, origine: f.origine, mis_a_jour: f.updated_at || f.created_at,
    })),
  };
}

/* ------------------------------------------- pièces déposées au registre */

const registre = require('../inpi/rne-documents');
const PDF_JOINT_MAX = 1.5 * 1024 * 1024;

/**
 * Le PDF est conservé dans le stockage du cabinet et remis par un lien
 * temporaire (1 heure) ; joint en plus à la réponse s'il est léger.
 */
async function remettrePdf(pdf, chemin, nom) {
  const { BUCKET } = require('../supa');
  let lien = null;
  try {
    const envoi = await supabase.storage.from(BUCKET).upload(chemin, pdf, { contentType: 'application/pdf', upsert: true });
    if (!envoi.error) {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrl(chemin, 3600, { download: nom });
      lien = data?.signedUrl || null;
    }
  } catch (e) { lien = null; }
  return {
    pdf: { nom, taille_octets: pdf.length, lien_telechargement: lien, lien_valable: lien ? '1 heure' : null, joint: pdf.length <= PDF_JOINT_MAX },
    _contenus: pdf.length <= PDF_JOINT_MAX
      ? [{ type: 'resource', resource: { uri: `inpi-rne://${chemin}`, mimeType: 'application/pdf', blob: pdf.toString('base64') } }] : [],
  };
}

function vueTexte(t) {
  if (!t) return null;
  return {
    pages_total: t.pages_total,
    scanne: t.scanne,
    pages_lues_par_ocr: t.pages_lues_par_ocr,
    ...(t.pages_lues_par_ocr ? { avertissement_ocr: 'Texte obtenu par reconnaissance de caractères : à vérifier sur le PDF pour les chiffres, les noms et les dates.' } : {}),
    ...(t.pages_restantes.length ? { pages_restantes: t.pages_restantes.join(','), suite: `Rappelez l’outil avec pages: "${t.pages_restantes.join(',')}" pour lire la suite.` } : {}),
    contenu: t.texte,
  };
}

async function listerPiecesDeposees({ siren }) {
  return registre.piecesDeposees(siren);
}

async function telechargerActe({ id, pages }) {
  const r = await registre.acte(String(id).trim(), { pages });
  const nom = `acte-${r.meta.siren ? r.meta.siren.replace(/\s/g, '') : 'rne'}-${r.meta.date_depot || ''}-${String(id).slice(0, 12)}.pdf`.replace(/-+\./, '.');
  const remise = await remettrePdf(r.pdf, `registre/actes/${String(id).replace(/[^\w-]/g, '_')}.pdf`, nom);
  return { acte: r.meta, ...remise, texte: vueTexte(r.texte) };
}

async function telechargerComptes({ id, pages }) {
  const r = await registre.comptes(String(id).trim(), { pages });
  if (r.meta.confidentiel) {
    return {
      comptes: r.meta,
      message: `Comptes annuels confidentiels (${r.meta.confidentialite}) : ni le PDF ni les données ne sont récupérés.`,
    };
  }
  const nom = `comptes-${r.meta.siren ? r.meta.siren.replace(/\s/g, '') : 'rne'}-${r.meta.date_cloture || ''}.pdf`;
  const remise = await remettrePdf(r.pdf, `registre/comptes/${String(id).replace(/[^\w-]/g, '_')}.pdf`, nom);
  return { comptes: r.meta, ...remise, donnees_saisies: r.saisis || { disponibles: false }, texte: vueTexte(r.texte) };
}

/* --------------------------------------------- formalité vue du guichet */

/** Valeurs vides d'un objet, avec leur chemin : ce que le portail demandera de compléter. */
function champsVides(o, prefixe = '', out = [], profondeur = 0) {
  if (!o || typeof o !== 'object' || profondeur > 8 || out.length > 200) return out;
  for (const [k, v] of Object.entries(o)) {
    const ch = prefixe ? (Array.isArray(o) ? `${prefixe}[${k}]` : `${prefixe}.${k}`) : k;
    if (v === null || v === '') out.push(ch);
    else if (typeof v === 'object') champsVides(v, ch, out, profondeur + 1);
  }
  return out;
}

/**
 * La formalité telle que le guichet l'a enregistrée : statut, frais, pièces,
 * données vides, et le texte du document de synthèse que le portail présente
 * à la signature. Lecture seule.
 */
async function consulterFormaliteGuichet({ reference }) {
  const f = await chargerParReference(reference);
  if (!f.inpi_id) throw erreur('Ce dossier n’a pas encore été enregistré au guichet.', 409);
  if (String(f.inpi_id).startsWith('SIM-')) throw erreur('Dossier simulé : il n’existe pas au guichet.', 409);
  // La synchronisation retrouve et corrige au besoin l'identifiant de la formalité.
  try { await formalites.synchroniser(f.id); } catch (e) { /* lecture directe ci-dessous */ }
  const [a] = await q(supabase.from('formalites').select('inpi_id').eq('id', f.id));
  f.inpi_id = a?.inpi_id || f.inpi_id;
  let brut;
  try {
    brut = await guichet.brut(f.inpi_id);
  } catch (e) {
    if (e.status !== 404) throw e;
    // Introuvable sous cet identifiant : ce que le compte mandataire voit pour la société.
    let visibles = [];
    try {
      visibles = await guichet.lister({ siren: f.siren });
      if (!visibles.length) visibles = await guichet.lister({ itemsPerPage: 10 });
    } catch (e2) { visibles = [{ erreur: e2.message }]; }
    return {
      reference: f.reference,
      introuvable: `Le guichet ne trouve pas la formalité n° ${f.inpi_id} (liasse ${f.numero_liasse || '—'}) sur le compte du connecteur.`,
      formalites_visibles_du_compte: visibles.map((x) => (x.erreur ? x : {
        identifiant: x.inpi_id, liasse: x.numero_liasse, societe: x.denomination || x.brut?.companyName || null, siren: x.siren || x.brut?.siren || null,
        statut: statutInfo(x.statut).libelle, statut_brut: x.statut_brut, date: x.statut_date, montant: x.montant,
      })),
    };
  }
  const norm = guichet.normaliserFormalite(brut, f.inpi_id);
  const panier = Array.isArray(brut?.carts) ? brut.carts[0] : brut?.carts;
  const frais = (panier?.cartRates || []).map((r) => ({
    libelle: r.rate?.label || r.rate?.libelle || r.label || r.rate?.code || null,
    code: r.rate?.code || r.code || null,
    montant: typeof r.amount === 'number' ? r.amount / 100 : null,
  }));
  let pieces = [];
  try { pieces = await guichet.listerPieces(f.inpi_id); } catch (e) { pieces = [{ erreur: e.message }]; }
  let synthese = null;
  try {
    const pdf = await guichet.synthese(f.inpi_id);
    const t = await require('../inpi/texte-pdf').textePdf(pdf, { budgetMs: 20000, maxCaracteres: 40000 });
    synthese = { pages: t.pages_total, texte: t.texte, ...(t.pages_restantes.length ? { pages_non_lues: t.pages_restantes.join(',') } : {}) };
  } catch (e) { synthese = { indisponible: e.message }; }
  const contenu = brut?.content || {};
  return {
    reference: f.reference,
    inpi: { identifiant: f.inpi_id, liasse: norm.numero_liasse, statut: statutInfo(norm.statut).libelle, statut_brut: norm.statut_brut },
    frais: { total_ttc: norm.montant, detail: frais },
    evenements_reconnus: brut?.events || [],
    pieces_au_guichet: pieces,
    donnees_vides: {
      formalite: champsVides(Object.fromEntries(Object.entries(brut || {}).filter(([k]) => !['content', 'carts', 'attachments'].includes(k)))).slice(0, 60),
      contenu: champsVides(contenu).slice(0, 150),
    },
    synthese_portail: synthese,
  };
}

/* ------------------------------------------------------------ définitions */

const REFERENCE = { type: 'string', description: 'Référence du dossier renvoyée par ouvrir_depot_pieces (ex. LGZ-2026-00012).' };
const OPERATIONS = { type: 'array', items: { type: 'string' }, description: 'Codes évènements (ex. ["35M"], ["11M","35M"]). Voir catalogue_operations.' };
const TYPOLOGIE = {
  type: 'object',
  description: 'Réponses aux questions de qualification, par identifiant de question (voir « questions » dans exigences_formalite). '
    + 'Ex. {"entrants":[{"nom":"Claire MARTIN","nature":"PP","fonction":"dirigeant"}],"sortants":[{"nom":"Jean DUPONT","motif":"demission"}],"statuts_modifies":false}. '
    + 'Mise à jour d’un dirigeant en place (MAJDIR) : {"mises_a_jour":[{"nom":"BD France","motif":"denomination"}]} (motif : denomination, adresse ou representant). '
    + 'Chaque question renvoyée par exigences_formalite donne son « format » ; une réponse mal formée est refusée. '
    + 'Pour rendre due ou écarter une pièce de la liste : {"manuel":{"<cle de la pièce>":true|false}}.',
};
const REPONSES = {
  type: 'object',
  description: 'Valeurs des champs, rangées par groupe (« groupe » dans exigences_formalite) puis par « name ». '
    + 'Ex. {"commun":{"date_decision":"2026-10-01"},"11M":{"nouvelle_adresse":{"numVoie":"12","typeVoie":"RUE","voie":"de Brest","codePostal":"29000","commune":"Quimper"}}}. '
    + 'Dates au format AAAA-MM-JJ. Une personne : {"nom","prenoms":[…],"genre":"1"(homme)|"2"(femme),"date_naissance","lieu_naissance","code_insee_naissance","nationalite","adresse":{…}} ; '
    + 'travailleur non salarié : "forme_sociale":"3" avec "numero_secu" et "volet":{"organisme_maladie","activite_simultanee"}. '
    + 'Le champ « manque » d’un dossier dit précisément ce qui reste à fournir.',
};

const EXIGENCES_CHAMPS = {
  type: 'array',
  description: 'UNIQUEMENT sur instruction expresse de l’avocat, jamais de votre propre initiative : lève l’exigence d’un champ requis '
    + 'que le guichet n’exige pas pour ce dossier (ex. représentant d’un commissaire aux comptes personne morale inchangé). '
    + '[{"champ": "<groupe>.<name>", "requis": false, "motif": "décision de l’avocat et sa raison"}] ; {"champ", "requis": true} rétablit l’exigence. '
    + 'Seules les « Données du registre à compléter » (groupe _registre) peuvent être levées ; jamais le SIREN, la date de décision, '
    + 'ni la donnée qui fait l’objet du changement, ni une pièce (voir typologie.manuel), ni une donnée erronée. '
    + 'La levée devient une alerte de controler_formalite, à reprendre dans le récapitulatif de validation ; un champ levé et vide n’est pas transmis.',
  items: {
    type: 'object',
    properties: { champ: { type: 'string' }, requis: { type: 'boolean' }, motif: { type: 'string' } },
    required: ['champ'],
  },
};

const OUTILS = [
  {
    name: 'rechercher_entreprise',
    description: 'Recherche une société au registre national des entreprises (RNE) par dénomination ou SIREN.',
    inputSchema: { type: 'object', properties: { terme: { type: 'string', description: 'Dénomination ou SIREN.' } }, required: ['terme'] },
    run: rechercherEntreprise,
  },
  {
    name: 'fiche_entreprise',
    description: 'État actuel d’une société au RNE : dénomination, forme, capital, siège, objet, dirigeants en fonction. La formalité ne déclare que ce qui change par rapport à cette fiche.',
    inputSchema: { type: 'object', properties: { siren: { type: 'string' } }, required: ['siren'] },
    run: ficheEntreprise,
  },
  {
    name: 'catalogue_operations',
    description: 'Liste des opérations (codes évènements du guichet unique) que le connecteur sait préparer.',
    inputSchema: { type: 'object', properties: {} },
    run: catalogueOperations,
  },
  {
    name: 'exigences_formalite',
    description: 'Pour un jeu d’opérations : questions de qualification, champs à renseigner (avec la valeur actuelle au registre) et pièces exigées (obligatoires, à préciser, facultatives). '
      + 'Rappelez-le avec les réponses connues : les éléments conditionnels s’ajustent. Ne crée aucun dossier.',
    inputSchema: {
      type: 'object',
      properties: { operations: OPERATIONS, siren: { type: 'string', description: 'SIREN (sauf création).' }, typologie: TYPOLOGIE, reponses: REPONSES },
      required: ['operations'],
    },
    run: exigencesFormalite,
  },
  {
    name: 'ouvrir_depot_pieces',
    description: 'Ouvre le dossier de la formalité (ou le met à jour si « reference » est donnée) et renvoie un lien, valable 7 jours, où l’avocat dépose les PDF. '
      + 'Rappelé avec la même référence, il remplace le lien précédent. Renvoie la référence du dossier, à noter dans la fiche dossier.',
    inputSchema: {
      type: 'object',
      properties: {
        reference: REFERENCE, siren: { type: 'string', description: 'SIREN de la société (sauf création).' },
        operations: OPERATIONS, typologie: TYPOLOGIE, reponses: REPONSES, exigences_champs: EXIGENCES_CHAMPS,
        dossier_id: { type: 'string', description: 'Facultatif : dossier client Legalize auquel rattacher la formalité (numéro ou référence, ex. 2026-0012).' },
      },
    },
    run: ouvrirDepotPieces,
  },
  {
    name: 'renseigner_formalite',
    description: 'Complète ou corrige un dossier ouvert : opérations, réponses de qualification, valeurs des champs. Renvoie le dossier à jour, avec ce qui manque encore. '
      + '« exigences_champs » lève l’exigence d’un champ, uniquement sur instruction expresse de l’avocat.',
    inputSchema: { type: 'object', properties: { reference: REFERENCE, operations: OPERATIONS, typologie: TYPOLOGIE, reponses: REPONSES, exigences_champs: EXIGENCES_CHAMPS }, required: ['reference'] },
    run: renseignerFormalite,
  },
  {
    name: 'pieces_recues',
    description: 'Pièces déposées par l’avocat sur le lien, rapprochées de la liste exigée, et pièces obligatoires encore manquantes.',
    inputSchema: { type: 'object', properties: { reference: REFERENCE }, required: ['reference'] },
    run: piecesRecues,
  },
  {
    name: 'reclasser_piece',
    description: 'Range une pièce déjà reçue sous la bonne ligne de la liste (« cle », ex. PJ_20:m0) ou sous un autre type officiel (« code_pj », ex. PJ_20). Désignez la pièce par son numéro ou son nom de fichier (voir pieces_recues).',
    inputSchema: {
      type: 'object',
      properties: {
        reference: REFERENCE, fichier: { type: 'string', description: 'Numéro de la pièce ou nom du fichier reçu.' },
        cle: { type: 'string', description: 'Ligne de la liste des pièces (« cle »), à préférer quand plusieurs lignes ont le même type.' },
        code_pj: { type: 'string', description: 'Type officiel de la pièce (PJ_xx), voir catalogue_pieces.' },
      },
      required: ['reference', 'fichier'],
    },
    run: reclasserPiece,
  },
  {
    name: 'retirer_piece',
    description: 'Retire du dossier une pièce reçue par erreur (désignée par son numéro ou son nom de fichier).',
    inputSchema: { type: 'object', properties: { reference: REFERENCE, fichier: { type: 'string' } }, required: ['reference', 'fichier'] },
    run: retirerPiece,
  },
  {
    name: 'catalogue_pieces',
    description: 'Types de pièces justificatives acceptés par le guichet pour une société (codes PJ_xx), pour une pièce hors de la liste exigée.',
    inputSchema: { type: 'object', properties: {} },
    run: cataloguePieces,
  },
  {
    name: 'controler_formalite',
    description: 'Contrôles avant transmission : bloquants, alertes, échéance de dépôt, mode simulation, exigences levées à la demande de l’avocat (à reprendre dans le récapitulatif de validation). Aucun enregistrement tant qu’il reste un bloquant.',
    inputSchema: { type: 'object', properties: { reference: REFERENCE }, required: ['reference'] },
    run: controlerFormalite,
  },
  {
    name: 'enregistrer_formalite',
    description: 'Transmet la formalité au guichet unique (sans la signer ni la payer). À n’appeler qu’après l’accord explicite de l’avocat sur le récapitulatif de validation, avec confirmation_avocat: true.',
    inputSchema: {
      type: 'object',
      properties: { reference: REFERENCE, confirmation_avocat: { type: 'boolean', description: 'true uniquement après l’accord explicite de l’avocat (« je confirme »).' } },
      required: ['reference', 'confirmation_avocat'],
    },
    run: enregistrerFormalite,
  },
  {
    name: 'statut_formalite',
    description: 'Statut à jour d’un dossier (relu auprès du guichet s’il est enregistré), action attendue et par qui, régularisations demandées, journal.',
    inputSchema: { type: 'object', properties: { reference: REFERENCE }, required: ['reference'] },
    run: statutFormalite,
  },
  {
    name: 'consulter_formalite_guichet',
    description: 'La formalité telle que le guichet unique l’a enregistrée : statut, détail des frais, pièces reçues, données restées vides, '
      + 'et le texte du document de synthèse présenté à la signature. À utiliser quand le portail réclame des informations avant de signer. Lecture seule.',
    inputSchema: { type: 'object', properties: { reference: REFERENCE }, required: ['reference'] },
    run: consulterFormaliteGuichet,
  },
  {
    name: 'lister_pieces_deposees',
    description: 'Pièces déposées au registre national des entreprises pour une société : actes (statuts, PV d’assemblée, décisions…) et comptes annuels, '
      + 'du plus récent au plus ancien, avec leur identifiant, leur date et leur confidentialité. Lecture seule.',
    inputSchema: { type: 'object', properties: { siren: { type: 'string', description: 'SIREN de la société.' } }, required: ['siren'] },
    run: listerPiecesDeposees,
  },
  {
    name: 'telecharger_acte',
    description: 'Télécharge un acte déposé au registre (identifiant donné par lister_pieces_deposees) : le PDF et son texte, '
      + 'obtenu par reconnaissance de caractères si l’acte est numérisé. Un acte long se lit par tranches de pages (« pages »). Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Identifiant de l’acte.' }, pages: { type: 'string', description: 'Facultatif : pages à lire, par exemple "1-5" ou "6,7,8".' } },
      required: ['id'],
    },
    run: telechargerActe,
  },
  {
    name: 'telecharger_comptes',
    description: 'Télécharge des comptes annuels déposés au registre (identifiant donné par lister_pieces_deposees) : le PDF, son texte et, si l’INPI les a saisies, '
      + 'les données du bilan et du compte de résultat (postes libellés et chiffres clés). Des comptes confidentiels ne sont pas récupérés. Lecture seule.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Identifiant des comptes annuels.' }, pages: { type: 'string', description: 'Facultatif : pages du PDF à lire, par exemple "1-4".' } },
      required: ['id'],
    },
    run: telechargerComptes,
  },
  {
    name: 'lister_formalites',
    description: 'Formalités suivies : celles ouvertes par l’assistant (par défaut) ou toutes celles de Legalize (perimetre: "tous").',
    inputSchema: { type: 'object', properties: { perimetre: { type: 'string', enum: ['assistant', 'tous'] } } },
    run: listerFormalites,
  },
];

module.exports = { OUTILS, ORIGINE, empreinte, echeanceDe, vueDossier, chargerParReference, journalDe, modes, validerTypologie, cataloguePieces };
