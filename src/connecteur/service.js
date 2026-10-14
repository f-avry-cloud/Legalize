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
    ...(p.fichiers ? { recue: p.fichiers.map((f) => f.nom) } : {}),
  };
}

function vueQuestion(qq) {
  return {
    id: qq.id, question: qq.libelle, ...(qq.aide ? { aide: qq.aide } : {}), type: qq.type,
    ...(qq.options ? { options: qq.options.map(([v, l]) => ({ valeur: v, libelle: l })) } : {}),
    ...(qq.dirigeants_actuels ? { dirigeants_au_registre: qq.dirigeants_actuels } : {}),
    ...(qq.attente ? { en_attente: qq.attente } : {}),
    valeur: qq.valeur ?? null,
  };
}

function vueChamp(c, valeur) {
  return {
    name: c.name, label: c.label, type: c.type, requis: Boolean(c.requis),
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
      champs: g.champs.map((c) => ({ ...vueChamp(c, c.valeur), rempli: c.rempli, ...(c.manquants?.length ? { manque: c.manquants } : {}) })),
    })),
    pieces: {
      obligatoires: d.pieces.obligatoires.map(vuePiece),
      a_preciser: d.pieces.a_preciser.map(vuePiece),
      facultatives: d.pieces.facultatives.map(vuePiece),
      autres_recues: d.autres_pieces.map((p) => ({ code: p.code, nom: p.nom })),
    },
    incompatibilites: d.incompatibilites,
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

async function appliquerSaisies(id, { operations, typologie, reponses }) {
  if (Array.isArray(operations) && operations.length) await parcoursSvc.majOperations(id, operations);
  if (typologie && typeof typologie === 'object') await parcoursSvc.majTypologie(id, typologie);
  if (reponses && typeof reponses === 'object') await parcoursSvc.majReponses(id, reponses, { origine: 'saisie' });
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

async function rechercherEntreprise({ terme }) {
  return { resultats: await rne.rechercher(terme), ...modes() };
}

async function ficheEntreprise({ siren }) {
  const f = await rne.entreprise(siren);
  return {
    siren: f.siren_formate || f.siren, denomination: f.denomination, sigle: f.sigle || null,
    forme_juridique: f.forme_juridique, forme_juridique_code: f.forme_juridique_code,
    capital: f.capital ?? null, devise: f.devise_capital || null, adresse: f.adresse?.texte || null,
    objet: f.objet || null, activite_principale: f.activite_principale || null,
    date_immatriculation: f.date_immatriculation || null, date_cloture: f.date_cloture || null,
    radiee: Boolean(f.radiee), dirigeants: (f.dirigeants || []).map((d) => ({ nom: d.nom_complet, fonction: d.role_libelle || d.role || null })),
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
async function ouvrirDepotPieces({ reference, siren, operations, typologie, reponses, dossier_id: dossierId }) {
  let id;
  let avertissement = null;
  if (reference) {
    const f = await chargerModifiable(reference);
    id = f.id;
    if (f.inpi_id) throw erreur('Dossier déjà enregistré au guichet : les pièces ne se complètent plus ici.', 409);
    await appliquerSaisies(id, { operations: operations ? operationsValides(operations) : null, typologie, reponses });
  } else {
    const ops = operationsValides(operations);
    const dossier = await dossierLegalize(dossierId);
    const cree = await parcoursSvc.creer({ siren: siren || '', operations: ops, dossier_id: dossier?.id || null });
    id = cree.id;
    avertissement = cree.avertissement;
    await q(supabase.from('formalites').update({ origine: ORIGINE }).eq('id', id).select('id'));
    await appliquerSaisies(id, { typologie, reponses });
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

async function renseignerFormalite({ reference, operations, typologie, reponses }) {
  const f = await chargerModifiable(reference);
  if (f.inpi_id) throw erreur('Dossier déjà enregistré au guichet : il se modifie sur le portail.', 409);
  await appliquerSaisies(f.id, { operations: operations ? operationsValides(operations) : null, typologie, reponses });
  return vueDossier(f.id);
}

async function piecesRecues({ reference }) {
  const f = await chargerParReference(reference);
  const v = await vueDossier(f.id);
  return { reference: v.reference, pieces: v.pieces, manquantes: v.etat.pieces_manquantes, lien_depot_expire: v.lien_depot_expire };
}

async function controlerFormalite({ reference }) {
  const f = await chargerParReference(reference);
  const v = await vueDossier(f.id);
  const bloquants = [
    ...v.etat.champs_manquants.map((m) => `Information manquante — ${m}`),
    ...v.etat.pieces_manquantes.map((m) => `Pièce obligatoire non reçue — ${m}`),
    ...(v.etat.questions_restantes ? [`${v.etat.questions_restantes} question(s) de qualification sans réponse`] : []),
    ...(v.etat.pieces_a_preciser ? [`${v.etat.pieces_a_preciser} pièce(s) « selon le cas » à trancher (typologie.manuel)`] : []),
    ...v.incompatibilites.map((m) => (typeof m === 'string' ? m : m.message || JSON.stringify(m))),
    ...v.etat.non_deposables.map((m) => `Opération à finaliser sur le portail, non transmissible par l’API : ${m}`),
    ...(v.etat.provisoires ? [`${v.etat.provisoires} pièce(s) en version provisoire`] : []),
  ];
  const alertes = [];
  if (v.echeance.connue && v.echeance.etat !== 'dans_les_temps') {
    alertes.push(v.echeance.etat === 'depassee' ? `Délai de dépôt dépassé depuis le ${v.echeance.limite}.` : `Délai de dépôt imminent : ${v.echeance.limite} (${v.echeance.jours_restants} jour(s)).`);
  }
  if (v.guichet_simulation) alertes.push(`Mode simulation : rien ne sera transmis à l’INPI (${v.motif_simulation}).`);
  if (f.fiche?.radiee) alertes.push('Société radiée au registre.');
  return {
    reference: v.reference, pret: v.etat.pret && !bloquants.length, bloquants, alertes,
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

/* ------------------------------------------------------------ définitions */

const REFERENCE = { type: 'string', description: 'Référence du dossier renvoyée par ouvrir_depot_pieces (ex. LGZ-2026-00012).' };
const OPERATIONS = { type: 'array', items: { type: 'string' }, description: 'Codes évènements (ex. ["35M"], ["11M","35M"]). Voir catalogue_operations.' };
const TYPOLOGIE = {
  type: 'object',
  description: 'Réponses aux questions de qualification, par identifiant de question (voir « questions » dans exigences_formalite). '
    + 'Ex. {"entrants":[{"nom":"Claire MARTIN","nature":"PP","fonction":"dirigeant"}],"sortants":[{"nom":"Jean DUPONT","motif":"demission"}],"statuts_modifies":false}. '
    + 'Pour trancher une pièce « à préciser » sans question : {"manuel":{"<cle de la pièce>":true|false}}.',
};
const REPONSES = {
  type: 'object',
  description: 'Valeurs des champs, rangées par groupe (« groupe » dans exigences_formalite) puis par « name ». '
    + 'Ex. {"commun":{"date_decision":"2026-10-01"},"11M":{"nouvelle_adresse":{"numVoie":"12","typeVoie":"RUE","voie":"de Brest","codePostal":"29000","commune":"Quimper"}}}. '
    + 'Dates au format AAAA-MM-JJ. Une personne : {"nom","prenoms":[…],"genre":"1"(homme)|"2"(femme),"date_naissance","lieu_naissance","code_insee_naissance","nationalite","adresse":{…}} ; '
    + 'travailleur non salarié : "forme_sociale":"3" avec "numero_secu" et "volet":{"organisme_maladie","activite_simultanee"}. '
    + 'Le champ « manque » d’un dossier dit précisément ce qui reste à fournir.',
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
        operations: OPERATIONS, typologie: TYPOLOGIE, reponses: REPONSES,
        dossier_id: { type: 'string', description: 'Facultatif : dossier client Legalize auquel rattacher la formalité (numéro ou référence, ex. 2026-0012).' },
      },
    },
    run: ouvrirDepotPieces,
  },
  {
    name: 'renseigner_formalite',
    description: 'Complète ou corrige un dossier ouvert : opérations, réponses de qualification, valeurs des champs. Renvoie le dossier à jour, avec ce qui manque encore.',
    inputSchema: { type: 'object', properties: { reference: REFERENCE, operations: OPERATIONS, typologie: TYPOLOGIE, reponses: REPONSES }, required: ['reference'] },
    run: renseignerFormalite,
  },
  {
    name: 'pieces_recues',
    description: 'Pièces déposées par l’avocat sur le lien, rapprochées de la liste exigée, et pièces obligatoires encore manquantes.',
    inputSchema: { type: 'object', properties: { reference: REFERENCE }, required: ['reference'] },
    run: piecesRecues,
  },
  {
    name: 'controler_formalite',
    description: 'Contrôles avant transmission : bloquants, alertes, échéance de dépôt, mode simulation. Aucun enregistrement tant qu’il reste un bloquant.',
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
    name: 'lister_formalites',
    description: 'Formalités suivies : celles ouvertes par l’assistant (par défaut) ou toutes celles de Legalize (perimetre: "tous").',
    inputSchema: { type: 'object', properties: { perimetre: { type: 'string', enum: ['assistant', 'tous'] } } },
    run: listerFormalites,
  },
];

module.exports = { OUTILS, ORIGINE, empreinte, echeanceDe, vueDossier, chargerParReference, journalDe, modes };
