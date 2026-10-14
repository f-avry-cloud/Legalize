'use strict';

/**
 * Logique des outils du connecteur Claude, indépendante du protocole.
 *
 * Le connecteur ne réinvente rien : il réutilise le moteur INPI de Legalize
 * (catalogue, contrôles, construction du JSON, client du Guichet unique) et le
 * rend pilotable depuis une conversation. Il est SANS ÉTAT : Claude fournit à
 * chaque appel le type de formalité, le SIREN et les réponses ; seules les
 * pièces transitent par un stockage temporaire, le temps de l'enregistrement.
 *
 * Ce qu'il ne fait PAS, volontairement : signer, payer, supprimer. Ces gestes
 * restent à l'avocat, sur le portail du Guichet unique.
 */

const rne = require('../inpi/rne');
const guichet = require('../inpi/guichet');
const { FORMALITES, definition, piecesExigees, champsActifs } = require('../inpi/catalogue');
const { controler } = require('../inpi/controles');
const { construirePayload } = require('../inpi/payload');
const { config } = require('../inpi/config');
const { statut: infoStatut, STATUTS } = require('../inpi/referentiels');
const { nettoyerSiren } = require('../inpi/normalize');
const { pdfLisible } = require('../inpi/pdf');
const jeton = require('./jeton');
const stockage = require('./stockage');

const DUREE_LIEN_PIECES = 7 * 24 * 3600;

const ACTIONS = {
  deposer: 'Formalité non encore transmise.',
  attendre: 'Rien à faire : traitement en cours au Guichet unique.',
  signer: 'À signer par l’avocat sur le portail du Guichet unique.',
  payer: 'À payer par l’avocat sur le portail du Guichet unique.',
  corriger: 'Erreur de contrôle à corriger, puis nouvel enregistrement.',
  regulariser: 'Régularisation demandée : préparer la réponse et les pièces.',
};

function erreur(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function exigerType(type) {
  const def = definition(type);
  if (!def) {
    throw erreur(`Formalité inconnue « ${type} ». Valeurs possibles : ${Object.keys(FORMALITES).join(', ')}.`);
  }
  return def;
}

/* ------------------------------------------------------------- catalogue */

function formalites() {
  return Object.entries(FORMALITES).map(([code, f]) => ({
    type: code,
    libelle: f.libelle,
    evenement: f.evenement,
    resume: f.resume,
    siren_requis: !f.sansSiren,
    delai: f.delai?.texte || null,
  }));
}

/** Champs à renseigner pour une formalité, au format attendu par les outils. */
function decrireChamp(c) {
  if (c.type === 'section') return null;
  const d = { nom: c.name, libelle: c.label, type: c.type, obligatoire: Boolean(c.required) };
  if (c.aide) d.aide = c.aide;
  if (c.default !== undefined) d.defaut = c.default;
  if (c.options) d.valeurs = c.options.map((o) => ({ code: o.value, libelle: o.label }));
  if (c.depend) d.uniquement_si = { champ: c.depend.name, valeurs: c.depend.valeurs };
  if (c.champs) d.elements = c.champs.map(decrireChamp).filter(Boolean);
  return d;
}

const FORMATS = {
  date: 'AAAA-MM-JJ',
  money: 'nombre, en euros (ex. 15000)',
  adresse: {
    numVoie: 'numéro (ex. "12")', indiceRepetition: 'B, T, Q… (facultatif)',
    typeVoie: 'code du référentiel INPI : RUE, AV, BD, ALL, CHE, IMP, PL, QUAI, RTE…',
    voie: 'libellé de la voie, sans le type (ex. "Victor Hugo")',
    complementLocalisation: 'bâtiment, étage… (facultatif)',
    codePostal: '5 chiffres', commune: 'nom de la commune', codeInseeCommune: 'facultatif',
    texte: 'adresse complète sur une ligne, pour les récapitulatifs',
  },
  personne: {
    nom: 'nom de naissance', nom_usage: 'facultatif', prenoms: 'tableau ou chaîne, dans l’ordre de l’état civil',
    genre: '"1" masculin, "2" féminin',
    date_naissance: 'AAAA-MM-JJ', lieu_naissance: 'commune de naissance', pays_naissance: 'FRANCE par défaut',
    code_insee_naissance: 'code INSEE de la commune de naissance (obligatoire si né en France)',
    nationalite: 'ex. "Française"',
    adresse: 'adresse personnelle (même format que ci-dessus)',
    forme_sociale: '"0" non applicable, "1" sans affiliation, "3" avec affiliation sociale du dirigeant (travailleur non salarié)',
    numero_secu: 'NIR, exigé pour un travailleur non salarié de nationalité française',
    volet: '{ organisme_maladie, activite_simultanee } pour un travailleur non salarié',
    fonction: 'ex. Président, Gérant, Directeur général',
    nom_complet: 'Prénom NOM, pour les récapitulatifs',
  },
};

function exigences(type, reponses = {}) {
  const def = exigerType(type);
  return {
    type,
    libelle: def.libelle,
    evenement: def.evenement,
    siren_requis: !def.sansSiren,
    delai: def.delai || null,
    champs: champsActifs(type, reponses).map(decrireChamp).filter(Boolean),
    pieces: piecesExigees(type, reponses).map((p) => ({
      code: p.code, libelle: p.libelle, obligatoire: p.obligatoire, aide: p.aide || undefined, nota: p.nota || undefined,
    })),
    formats: FORMATS,
    rappel: 'Ne renseigner que ce qui change : l’état actuel de la société vient du RNE à partir du SIREN.',
  };
}

/* ------------------------------------------------------------------- RNE */

/** Fiche lisible (sans le contenu brut, volumineux). */
function ficheLisible(f) {
  if (!f) return null;
  const { brut, ...reste } = f;
  return reste;
}

async function rechercherEntreprise(terme) {
  return { resultats: await rne.rechercher(terme), simule: config.modeRne === 'simulation' };
}

async function ficheEntreprise(siren) {
  return { fiche: ficheLisible(await rne.entreprise(siren)), simule: config.modeRne === 'simulation' };
}

/* ------------------------------------------------------------ contrôles */

async function piecesRecues(reference) {
  if (!reference) return [];
  if (!jeton.REFERENCE.test(reference)) throw erreur(`Référence de dossier invalide : « ${reference} ».`);
  if (!stockage.configure()) return [];
  return stockage.lister(reference);
}

async function assembler({ type, siren, reponses = {}, reference, libelle }) {
  const def = exigerType(type);
  const sirenPropre = nettoyerSiren(siren || '');
  if (!def.sansSiren && !sirenPropre) throw erreur('SIREN requis pour cette formalité.');
  const fiche = def.sansSiren ? null : await rne.entreprise(sirenPropre);
  const pieces = await piecesRecues(reference);
  const denomination = fiche?.denomination || reponses.denomination || '';
  return {
    def,
    fiche,
    pieces,
    dossier: {
      type,
      siren: sirenPropre,
      reference: reference || undefined,
      libelle: libelle || [denomination, def.libelle].filter(Boolean).join(' — '),
      fiche,
      reponses,
      pieces: pieces.map((p) => ({ code: p.code, nom: p.nom, taille: p.taille })),
    },
  };
}

function apercu(def, reponses, fiche) {
  if (!def.apercu) return [];
  return def.apercu(reponses || {}, fiche || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([libelle, valeur]) => ({ libelle, valeur: String(valeur) }));
}

function synthese(c) {
  return {
    pret: c.pret,
    bloquants: c.bloquants.map((b) => b.message),
    alertes: c.alertes.map((a) => a.message),
    informations: c.infos.map((i) => i.message),
    pieces_manquantes: c.pieces_manquantes.map((p) => `${p.libelle} (${p.code})`),
    echeance: c.echeance,
  };
}

async function controlerFormalite(params) {
  const { def, fiche, pieces, dossier } = await assembler(params);
  let payload = null;
  let erreurConstruction = null;
  try { payload = construirePayload(dossier); } catch (e) { erreurConstruction = e.message; }
  const c = controler({ ...dossier, payload });
  const resultat = synthese(c);
  if (erreurConstruction) {
    resultat.pret = false;
    resultat.bloquants.push(`Formalité impossible à construire : ${erreurConstruction}`);
  }
  return {
    reference: params.reference || null,
    formalite: def.libelle,
    societe: fiche ? { denomination: fiche.denomination, siren: fiche.siren_formate || fiche.siren, radiee: Boolean(fiche.radiee) } : null,
    apercu: apercu(def, params.reponses, fiche),
    pieces_recues: pieces.map((p) => ({ code: p.code, fichier: p.nom, taille: p.taille })),
    controles: resultat,
    mode: modeGuichet(),
  };
}

/* ----------------------------------------------------------------- pièces */

function ouvrirDepotPieces({ reference, type, reponses = {}, denomination = '' }, baseUrl) {
  if (!stockage.configure()) {
    throw erreur('Stockage des pièces non configuré sur le serveur (SUPABASE_SECRET_KEY).', 503);
  }
  const def = exigerType(type);
  const ref = reference || jeton.nouvelleReference();
  if (!jeton.REFERENCE.test(ref)) throw erreur(`Référence de dossier invalide : « ${ref} ».`);
  const pieces = piecesExigees(type, reponses).map((p) => ({ code: p.code, libelle: p.libelle, obligatoire: p.obligatoire }));
  const j = jeton.signer({ ref, f: def.libelle, d: String(denomination).slice(0, 80), p: pieces }, DUREE_LIEN_PIECES);
  return {
    reference: ref,
    lien: `${baseUrl}/api/connecteur/pieces?j=${encodeURIComponent(j)}`,
    validite: '7 jours',
    pieces_attendues: pieces,
    consigne: 'Transmettre ce lien à l’avocat : il y dépose ses PDF (10 Mo maximum chacun). Conserver la référence dans la fiche dossier.',
  };
}

async function listerPiecesRecues(reference) {
  const pieces = await piecesRecues(reference);
  return { reference, pieces: pieces.map((p) => ({ code: p.code, fichier: p.nom, taille: p.taille, date: p.date })) };
}

/* --------------------------------------------------------- enregistrement */

function modeGuichet() {
  if (!guichet.simulationActive()) return { simulation: false, environnement: config.guichet.environnement };
  return { simulation: true, motif: guichet.motifSimulation(), environnement: config.guichet.environnement };
}

async function enregistrerFormalite(params) {
  if (params.confirmation_avocat !== true) {
    throw erreur('Enregistrement refusé : l’avocat doit d’abord valider le récapitulatif (confirmation_avocat = true).');
  }
  const { def, pieces, dossier } = await assembler(params);
  const payloadSansFichiers = construirePayload(dossier);
  const c = controler({ ...dossier, payload: payloadSansFichiers });
  if (!c.pret) {
    return { enregistre: false, motif: 'Contrôles bloquants non levés.', controles: synthese(c) };
  }

  // Lecture et vérification des PDF au dernier moment.
  const encodees = [];
  for (const p of pieces) {
    const buffer = await stockage.lire(p.chemin);
    if (!buffer || !pdfLisible(buffer)) {
      return { enregistre: false, motif: `Le fichier « ${p.nom} » (${p.code}) n’est pas un PDF lisible : le remplacer.` };
    }
    if (buffer.length > config.pieceMaxOctets) {
      return { enregistre: false, motif: `Le fichier « ${p.nom} » dépasse 10 Mo.` };
    }
    encodees.push({ code: p.code, nom: p.nom, taille: buffer.length, base64: buffer.toString('base64') });
  }

  // Garde-fou contre le double envoi (appel répété, conversation reprise) :
  // la référence du dossier est transmise comme référence mandataire.
  if (!guichet.simulationActive() && params.reference) {
    const service = def.service === 'comptes_annuels' ? 'comptes_annuels' : 'formalites';
    const recentes = await guichet.lister({ itemsPerPage: 50 }, service);
    const deja = recentes.find((f) => f.reference_mandataire === params.reference);
    if (deja) {
      return {
        enregistre: false,
        motif: `Ce dossier a déjà été enregistré au Guichet unique (identifiant ${deja.inpi_id}, liasse ${deja.numero_liasse || '—'}).`,
        deja_enregistre: lisible(deja),
      };
    }
  }

  const requete = construirePayload({ ...dossier, pieces: encodees });
  const r = await guichet.deposer(requete);

  // Les pièces n'ont plus de raison d'être conservées une fois reçues par le
  // guichet. En simulation, on les garde pour l'enregistrement réel à venir.
  let piecesEffacees = false;
  if (!r.simule && pieces.length) {
    try { await stockage.supprimer(pieces.map((p) => p.chemin)); piecesEffacees = true; } catch { /* sans effet sur le dépôt */ }
  }

  const info = infoStatut(r.statut);
  return {
    enregistre: true,
    simule: Boolean(r.simule),
    motif_simulation: r.motif_simulation || undefined,
    reference: params.reference || null,
    formalite: def.libelle,
    inpi_id: r.inpi_id,
    numero_liasse: r.numero_liasse,
    statut: info.libelle,
    action_attendue: ACTIONS[r.action_attendue] || info.libelle,
    montant_a_payer: r.montant,
    pieces_transmises: encodees.map((p) => `${p.nom} (${p.code})`),
    pieces_effacees_du_stockage: piecesEffacees,
    portail_signature: config.guichet.portailUrl,
    suite: 'L’avocat signe puis paie sur le portail du Guichet unique. La formalité reste modifiable ou supprimable sur le portail tant qu’elle n’est pas payée.',
    alertes: c.alertes.map((a) => a.message),
  };
}

/* ------------------------------------------------------------------ suivi */

function lisible(f) {
  const info = infoStatut(f.statut);
  return {
    inpi_id: f.inpi_id,
    numero_liasse: f.numero_liasse,
    societe: f.company_name,
    siren: f.siren,
    dossier: f.nom_dossier,
    reference: f.reference_mandataire,
    statut: info.libelle,
    statut_code: f.statut,
    depuis: f.statut_date,
    action_attendue: ACTIONS[f.action_attendue] || (info.terminal ? 'Aucune : dossier clos.' : null),
    montant: f.montant,
    regularisations: (f.regularisations || []).map((g) => ({
      motif: g.motif, champ: g.champ, piece: g.piece, echeance: g.echeance, frais: g.frais,
    })),
    simule: f.simule || undefined,
  };
}

async function statutFormalite({ inpi_id, comptes_annuels = false, historique = false }) {
  const service = comptes_annuels ? 'comptes_annuels' : 'formalites';
  const f = await guichet.lire(inpi_id, service);
  if (!f) throw erreur('Identifiant INPI manquant.');
  const resultat = lisible(f);
  if (historique && !comptes_annuels) resultat.historique = await guichet.historique(inpi_id);
  return resultat;
}

async function listerFormalites({ statut, siren, reference, maximum = 50, comptes_annuels = false } = {}) {
  const filtres = { itemsPerPage: Math.min(Math.max(Number(maximum) || 50, 1), 100) };
  if (statut) filtres.status = statut;
  if (siren) filtres.siren = nettoyerSiren(siren);
  let liste = await guichet.lister(filtres, comptes_annuels ? 'comptes_annuels' : 'formalites');
  // Filtre fait ici : le nom du paramètre de l'INPI pour la référence
  // mandataire n'est pas documenté de façon sûre.
  if (reference) liste = liste.filter((f) => f.reference_mandataire === reference);
  return {
    mode: modeGuichet(),
    nombre: liste.length,
    formalites: liste.map(lisible),
    statuts_possibles: Object.fromEntries(Object.entries(STATUTS).map(([k, v]) => [k, v.libelle])),
  };
}

module.exports = {
  formalites, exigences, rechercherEntreprise, ficheEntreprise, controlerFormalite,
  ouvrirDepotPieces, listerPiecesRecues, enregistrerFormalite, statutFormalite, listerFormalites,
  modeGuichet, ACTIONS,
};
