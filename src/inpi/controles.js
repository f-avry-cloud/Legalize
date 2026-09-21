'use strict';

/**
 * Contrôles de complétude et de cohérence exécutés AVANT tout dépôt.
 *
 * Objectif : que le rejet ou la demande de régularisation — qui coûtent
 * plusieurs semaines — soient détectés ici, pas par le greffe. Trois niveaux :
 *   bloquant — le dépôt est refusé tant que ce n'est pas corrigé ;
 *   alerte   — le dépôt reste possible, l'utilisateur assume ;
 *   info     — rappel de bonne pratique.
 */

const { definition, piecesExigees, champsActifs } = require('./catalogue');
const { sirenValide, formaterSiren } = require('./normalize');
const { formeJuridique, roleDepuisFonction, enumeration, TYPES_FORMALITE } = require('./referentiels');
const { config } = require('./config');

const JOUR_MS = 24 * 3600 * 1000;

function estVide(v) {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v).every((x) => x === '' || x === null || x === undefined);
  return false;
}

/** Échéance légale de dépôt, calculée sur la date pivot du questionnaire. */
function echeance(code, reponses = {}, maintenant = new Date()) {
  const def = definition(code);
  if (!def?.delai?.base) return null;
  const depart = reponses[def.delai.base];
  if (!depart) return null;
  const date = new Date(depart);
  if (Number.isNaN(date.getTime())) return null;
  const limite = new Date(date.getTime() + def.delai.jours * JOUR_MS);
  const joursRestants = Math.ceil((limite - maintenant) / JOUR_MS);
  return {
    depart,
    limite: limite.toISOString().slice(0, 10),
    jours_restants: joursRestants,
    etat: joursRestants < 0 ? 'depasse' : (joursRestants <= 7 ? 'imminent' : 'ok'),
    texte: def.delai.texte,
  };
}

/**
 * @param {object} dossier { type, siren, fiche, reponses, pieces: [{code}] }
 */
function controler(dossier, maintenant = new Date()) {
  const def = definition(dossier.type);
  const bloquants = [];
  const alertes = [];
  const infos = [];
  // Chaque constat porte le champ qu'il vise : c'est ce qui permet à
  // l'écran de renvoyer l'utilisateur sur l'encart à corriger.
  const bloq = (message, champ) => bloquants.push({ message, champ: champ || null });
  const alerte = (message, champ) => alertes.push({ message, champ: champ || null });
  const info = (message, champ) => infos.push({ message, champ: champ || null });
  const pousser = (a) => {
    const cible = a.niveau === 'bloquant' ? bloq : (a.niveau === 'info' ? info : alerte);
    cible(a.message, a.champ);
  };

  if (!def) {
    return { bloquants: [{ message: 'Type de formalité inconnu.', champ: null }], alertes: [], infos: [], pieces_manquantes: [], echeance: null, pret: false };
  }

  const reponses = dossier.reponses || {};
  const fiche = dossier.fiche || null;

  /* --- identification de l'entreprise --- */
  if (!def.sansSiren) {
    if (!dossier.siren) bloq('SIREN de l’entreprise absent.');
    else if (!sirenValide(dossier.siren)) bloq(`SIREN invalide (clé de contrôle) : ${formaterSiren(dossier.siren)}.`);
    if (fiche?.radiee) alerte('L’entreprise est radiée au RNE : vérifier la recevabilité de la formalité.');
  }

  /* --- champs du questionnaire --- */
  for (const champ of champsActifs(dossier.type, reponses)) {
    if (champ.required && estVide(reponses[champ.name])) {
      bloq(`Champ obligatoire non renseigné : « ${champ.label} ».`, champ.name);
    }
    if (champ.type === 'adresse' && !estVide(reponses[champ.name])) {
      const a = reponses[champ.name];
      if (!a.codePostal || !/^\d{5}$/.test(String(a.codePostal))) {
        bloq(`Code postal invalide pour « ${champ.label} ».`, champ.name);
      }
      if (!a.commune) bloq(`Commune manquante pour « ${champ.label} ».`, champ.name);
      if (!a.voie) alerte(`Libellé de voie manquant pour « ${champ.label} ».`, champ.name);
      // Le type de voie est un code du référentiel INPI (RUE, AV, BD…).
      if (a.typeVoie && !enumeration('typeVoie')[String(a.typeVoie).toUpperCase()]) {
        alerte(`Type de voie « ${a.typeVoie} » absent du référentiel INPI pour « ${champ.label} » : utiliser un code officiel (RUE, AV, BD…).`, champ.name);
      }
    }
    if (champ.type === 'personne' && !estVide(reponses[champ.name])) {
      const p = reponses[champ.name];
      if (!p.nom) bloq(`Nom manquant pour « ${champ.label} ».`, champ.name);
      if (!p.date_naissance) bloq(`Date de naissance manquante pour « ${champ.label} » (exigée par le RNE).`, champ.name);
      if (!p.nationalite) alerte(`Nationalité manquante pour « ${champ.label} ».`, champ.name);
      if (!p.adresse?.codePostal) alerte(`Adresse personnelle incomplète pour « ${champ.label} ».`, champ.name);
    }
    if (champ.type === 'date' && reponses[champ.name]) {
      const d = new Date(reponses[champ.name]);
      if (Number.isNaN(d.getTime())) bloq(`Date illisible pour « ${champ.label} ».`, champ.name);
      else if (d - maintenant > 365 * JOUR_MS) alerte(`« ${champ.label} » est à plus d’un an : vérifier la saisie.`, champ.name);
    }
  }

  /* --- codes de référentiel --- */
  const codeForme = reponses.forme_juridique_code || fiche?.forme_juridique_code;
  if (codeForme && !formeJuridique(codeForme)) {
    alerte(`Forme juridique ${codeForme} absente du référentiel local : le code transmis à l’INPI doit être vérifié.`);
  }
  const fonction = reponses.fonction || reponses.dirigeant?.fonction;
  if (fonction && !roleDepuisFonction(fonction)) {
    alerte(`Fonction « ${fonction} » non reconnue : le code rôle transmis à l’INPI doit être vérifié.`);
  }

  /* --- contrôles propres à la formalité --- */
  if (typeof def.controles === 'function') {
    for (const a of def.controles(reponses, fiche) || []) pousser(a);
  }

  /* --- pièces justificatives --- */
  const fournies = new Set((dossier.pieces || []).map((p) => p.code));
  const exigees = piecesExigees(dossier.type, reponses);
  const piecesManquantes = exigees.filter((p) => p.obligatoire && !fournies.has(p.code));
  for (const p of piecesManquantes) bloq(`Pièce obligatoire manquante : ${p.libelle}.`, '_pieces');
  for (const p of exigees.filter((x) => !x.obligatoire && !fournies.has(x.code))) {
    info(`Pièce facultative non jointe : ${p.libelle}${p.aide ? ` — ${p.aide}` : ''}`, '_pieces');
  }
  // Le Guichet unique n'accepte que des PDF de moins de 10 Mo.
  for (const p of dossier.pieces || []) {
    const nom = p.nom || p.filename || p.code;
    if (!/\.pdf$/i.test(nom)) {
      bloq(`La pièce « ${nom} » doit être au format PDF (seul format accepté par le guichet unique).`, '_pieces');
    }
    if (p.taille && p.taille > config.pieceMaxOctets) {
      bloq(`La pièce « ${nom} » dépasse 10 Mo (${Math.round(p.taille / 1048576)} Mo).`, '_pieces');
    }
  }

  /* --- indicateur d'évènement (formalités de modification) ---
     Le Guichet unique refuse une modification qui ne porte aucun indicateur
     `…Triggered` : on le vérifie sur le payload réellement construit. */
  if (def.typeFormalite === TYPES_FORMALITE.MODIFICATION && dossier.payload) {
    const { indicateursEvenement } = require('./payload');
    const contenu = dossier.payload.corps?.newFormality?.content;
    if (contenu && indicateursEvenement(contenu).length === 0) {
      bloq('Aucun indicateur d’évènement dans la formalité de modification : le guichet unique la rejetterait.');
    }
  }

  /* --- conformité du payload au dictionnaire officiel ---
     Le guichet unique rejette tout le dépôt sur une seule propriété mal
     typée, et son message arrive après l'envoi. On le vérifie avant. */
  if (dossier.payload && dossier.service !== 'comptes_annuels') {
    const { verifier } = require('./conformite');
    const contenu = dossier.payload.corps?.content || dossier.payload.corps?.newFormality?.content;
    for (const e of verifier(contenu)) {
      bloq(e.attendu
        ? `Type inattendu pour « ${e.chemin} » : l’INPI attend « ${e.attendu} », la formalité transmet « ${e.recu} ».`
        : `Propriété « ${e.chemin} » inconnue du dictionnaire INPI : le dépôt serait rejeté.`);
    }
  }

  /* --- délai légal ---
     Restitué comme bloc dédié (`echeance`) plutôt que noyé dans les alertes :
     l'état (ok / imminent / dépassé) y est directement exploitable. */
  const ech = echeance(dossier.type, reponses, maintenant);

  return {
    bloquants,
    alertes,
    infos,
    pieces_manquantes: piecesManquantes,
    pieces_exigees: exigees,
    echeance: ech,
    pret: bloquants.length === 0,
  };
}

module.exports = { controler, echeance };
