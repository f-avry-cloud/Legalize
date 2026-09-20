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
  const pousser = (a) => {
    const cible = a.niveau === 'bloquant' ? bloquants : (a.niveau === 'info' ? infos : alertes);
    cible.push(a.message);
  };

  if (!def) {
    return { bloquants: ['Type de formalité inconnu.'], alertes: [], infos: [], pieces_manquantes: [], echeance: null, pret: false };
  }

  const reponses = dossier.reponses || {};
  const fiche = dossier.fiche || null;

  /* --- identification de l'entreprise --- */
  if (!def.sansSiren) {
    if (!dossier.siren) bloquants.push('SIREN de l’entreprise absent.');
    else if (!sirenValide(dossier.siren)) bloquants.push(`SIREN invalide (clé de contrôle) : ${formaterSiren(dossier.siren)}.`);
    if (fiche?.radiee) alertes.push('L’entreprise est radiée au RNE : vérifier la recevabilité de la formalité.');
  }

  /* --- champs du questionnaire --- */
  for (const champ of champsActifs(dossier.type, reponses)) {
    if (champ.required && estVide(reponses[champ.name])) {
      bloquants.push(`Champ obligatoire non renseigné : « ${champ.label} ».`);
    }
    if (champ.type === 'adresse' && !estVide(reponses[champ.name])) {
      const a = reponses[champ.name];
      if (!a.codePostal || !/^\d{5}$/.test(String(a.codePostal))) {
        bloquants.push(`Code postal invalide pour « ${champ.label} ».`);
      }
      if (!a.commune) bloquants.push(`Commune manquante pour « ${champ.label} ».`);
      if (!a.voie) alertes.push(`Libellé de voie manquant pour « ${champ.label} ».`);
      // Le type de voie est un code du référentiel INPI (RUE, AV, BD…).
      if (a.typeVoie && !enumeration('typeVoie')[String(a.typeVoie).toUpperCase()]) {
        alertes.push(`Type de voie « ${a.typeVoie} » absent du référentiel INPI pour « ${champ.label} » : utiliser un code officiel (RUE, AV, BD…).`);
      }
    }
    if (champ.type === 'personne' && !estVide(reponses[champ.name])) {
      const p = reponses[champ.name];
      if (!p.nom) bloquants.push(`Nom manquant pour « ${champ.label} ».`);
      if (!p.date_naissance) bloquants.push(`Date de naissance manquante pour « ${champ.label} » (exigée par le RNE).`);
      if (!p.nationalite) alertes.push(`Nationalité manquante pour « ${champ.label} ».`);
      if (!p.adresse?.codePostal) alertes.push(`Adresse personnelle incomplète pour « ${champ.label} ».`);
    }
    if (champ.type === 'date' && reponses[champ.name]) {
      const d = new Date(reponses[champ.name]);
      if (Number.isNaN(d.getTime())) bloquants.push(`Date illisible pour « ${champ.label} ».`);
      else if (d - maintenant > 365 * JOUR_MS) alertes.push(`« ${champ.label} » est à plus d’un an : vérifier la saisie.`);
    }
  }

  /* --- codes de référentiel --- */
  const codeForme = reponses.forme_juridique_code || fiche?.forme_juridique_code;
  if (codeForme && !formeJuridique(codeForme)) {
    alertes.push(`Forme juridique ${codeForme} absente du référentiel local : le code transmis à l’INPI doit être vérifié.`);
  }
  const fonction = reponses.fonction || reponses.dirigeant?.fonction;
  if (fonction && !roleDepuisFonction(fonction)) {
    alertes.push(`Fonction « ${fonction} » non reconnue : le code rôle transmis à l’INPI doit être vérifié.`);
  }

  /* --- contrôles propres à la formalité --- */
  if (typeof def.controles === 'function') {
    for (const a of def.controles(reponses, fiche) || []) pousser(a);
  }

  /* --- pièces justificatives --- */
  const fournies = new Set((dossier.pieces || []).map((p) => p.code));
  const exigees = piecesExigees(dossier.type, reponses);
  const piecesManquantes = exigees.filter((p) => p.obligatoire && !fournies.has(p.code));
  for (const p of piecesManquantes) bloquants.push(`Pièce obligatoire manquante : ${p.libelle}.`);
  for (const p of exigees.filter((x) => !x.obligatoire && !fournies.has(x.code))) {
    infos.push(`Pièce facultative non jointe : ${p.libelle}${p.aide ? ` — ${p.aide}` : ''}`);
  }
  // Le Guichet unique n'accepte que des PDF de moins de 10 Mo.
  for (const p of dossier.pieces || []) {
    const nom = p.nom || p.filename || p.code;
    if (!/\.pdf$/i.test(nom)) {
      bloquants.push(`La pièce « ${nom} » doit être au format PDF (seul format accepté par le guichet unique).`);
    }
    if (p.taille && p.taille > config.pieceMaxOctets) {
      bloquants.push(`La pièce « ${nom} » dépasse 10 Mo (${Math.round(p.taille / 1048576)} Mo).`);
    }
  }

  /* --- indicateur d'évènement (formalités de modification) ---
     Le Guichet unique refuse une modification qui ne porte aucun indicateur
     `…Triggered` : on le vérifie sur le payload réellement construit. */
  if (def.typeFormalite === TYPES_FORMALITE.MODIFICATION && dossier.payload) {
    const { indicateursEvenement } = require('./payload');
    const contenu = dossier.payload.corps?.newFormality?.content;
    if (contenu && indicateursEvenement(contenu).length === 0) {
      bloquants.push('Aucun indicateur d’évènement dans la formalité de modification : le guichet unique la rejetterait.');
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
