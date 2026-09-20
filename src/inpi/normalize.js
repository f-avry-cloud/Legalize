'use strict';

/**
 * Traduction du JSON « formalité » du RNE vers la fiche entreprise utilisée
 * par l'application (et par le pré-remplissage des formalités).
 *
 * Le JSON du RNE est profond et plusieurs blocs sont optionnels selon qu'il
 * s'agit d'une personne morale ou d'une personne physique. On lit donc en
 * défensif : un champ absent vaut null, jamais une exception — un dossier ne
 * doit pas être bloqué parce que l'INPI ne connaît pas le sigle.
 */

const { formeJuridique } = require('./referentiels');

/* ------------------------------------------------------------------- SIREN */

/** Ne garde que les chiffres (l'utilisateur colle souvent « 901 234 567 »). */
function nettoyerSiren(valeur) {
  return String(valeur || '').replace(/\D/g, '');
}

function formaterSiren(valeur) {
  const s = nettoyerSiren(valeur);
  return s.length === 9 ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s;
}

/** Clé de Luhn : évite un aller-retour API sur une coquille de saisie. */
function sirenValide(valeur) {
  const s = nettoyerSiren(valeur);
  if (!/^\d{9}$/.test(s)) return false;
  let somme = 0;
  for (let i = 0; i < 9; i += 1) {
    let chiffre = Number(s[8 - i]);
    if (i % 2 === 1) { chiffre *= 2; if (chiffre > 9) chiffre -= 9; }
    somme += chiffre;
  }
  return somme % 10 === 0;
}

/* ----------------------------------------------------------------- adresses */

function adresseTexte(adresse) {
  if (!adresse) return '';
  const voie = [adresse.numVoie, adresse.indiceRepetition, adresse.typeVoie, adresse.voie]
    .filter(Boolean).join(' ').trim();
  const ligne2 = [adresse.complementLocalisation, adresse.distributionSpeciale].filter(Boolean).join(', ');
  const ville = [adresse.codePostal, adresse.commune].filter(Boolean).join(' ').trim();
  return [voie, ligne2, ville].filter(Boolean).join(', ');
}

function normaliserAdresse(bloc) {
  const a = bloc?.adresse || bloc || null;
  if (!a) return null;
  return {
    numVoie: a.numVoie || '',
    indiceRepetition: a.indiceRepetition || '',
    typeVoie: a.typeVoie || '',
    voie: a.voie || '',
    complementLocalisation: a.complementLocalisation || '',
    distributionSpeciale: a.distributionSpeciale || '',
    codePostal: a.codePostal || '',
    commune: a.commune || '',
    codeInseeCommune: a.codeInseeCommune || '',
    pays: a.pays || 'France',
    codePays: a.codePays || 'FRA',
    texte: adresseTexte(a),
  };
}

/* -------------------------------------------------------------- dirigeants */

function nomComplet(d) {
  if (!d) return '';
  const prenoms = Array.isArray(d.prenoms) ? d.prenoms.join(' ') : (d.prenoms || d.prenom || '');
  return [prenoms, d.nom, d.nomUsage].filter(Boolean).join(' ').trim();
}

function normaliserPouvoir(p) {
  if (!p) return null;
  const individu = p.individu?.descriptionPersonne || null;
  const morale = p.entreprise || p.personneMorale?.identite?.entreprise || null;
  if (individu) {
    return {
      type: 'physique',
      role: String(individu.role ?? p.roleEntreprise ?? ''),
      nom: individu.nom || '',
      prenoms: Array.isArray(individu.prenoms) ? individu.prenoms : (individu.prenoms ? [individu.prenoms] : []),
      nom_complet: nomComplet(individu),
      dateNaissance: individu.dateDeNaissance || '',
      lieuNaissance: individu.lieuDeNaissance || '',
      nationalite: individu.nationalite || '',
      adresse: normaliserAdresse(p.adresseDomicile),
    };
  }
  if (morale) {
    return {
      type: 'morale',
      role: String(morale.roleEntreprise ?? p.roleEntreprise ?? ''),
      denomination: morale.denomination || '',
      siren: morale.siren || '',
      formeJuridique: String(morale.formeJuridique || ''),
      nom_complet: morale.denomination || '',
      adresse: normaliserAdresse(p.adresseEntreprise),
    };
  }
  return null;
}

/* ------------------------------------------------------------- entreprise */

/**
 * @param {object} json Réponse brute de GET /api/companies/{siren}
 * @returns {object|null} fiche normalisée
 */
function normaliserEntreprise(json) {
  if (!json) return null;
  const contenu = json.formality?.content || json.content || json;
  const pm = contenu.personneMorale || null;
  const pp = contenu.personnePhysique || null;
  const socle = pm || pp;
  if (!socle) return null;

  const entreprise = socle.identite?.entreprise || socle.identite || {};
  const description = socle.identite?.description || {};
  const codeForme = String(entreprise.formeJuridique || contenu.natureCreation?.formeJuridique || '');
  const forme = formeJuridique(codeForme);
  const etabPrincipal = socle.etablissementPrincipal || null;
  const activites = etabPrincipal?.activites || socle.activites || [];

  const identitePP = pp ? (pp.identite?.entrepreneur?.descriptionPersonne || {}) : null;

  return {
    source: 'RNE',
    siren: json.formality?.siren || entreprise.siren || json.siren || '',
    siren_formate: formaterSiren(json.formality?.siren || entreprise.siren || json.siren || ''),
    denomination: entreprise.denomination
      || (identitePP ? nomComplet(identitePP) : '')
      || entreprise.nomCommercial || '',
    sigle: entreprise.sigle || '',
    nom_commercial: entreprise.nomCommercial || etabPrincipal?.descriptionEtablissement?.nomCommercial || '',
    forme_juridique_code: codeForme,
    forme_juridique: forme ? forme.libelle : (entreprise.libelleFormeJuridique || ''),
    famille: forme ? forme.famille : null,
    capital: description.montantCapital ?? description.capital ?? null,
    devise_capital: description.deviseCapital || 'EUR',
    capital_variable: Boolean(description.capitalVariable),
    duree: description.duree ?? null,
    date_cloture: description.dateClotureExerciceSocial || '',
    objet: description.objet || '',
    date_immatriculation: entreprise.dateImmat || entreprise.dateImmatriculation || '',
    date_debut_activite: entreprise.dateDebutActiv || '',
    date_radiation: entreprise.dateRadiation || '',
    code_ape: entreprise.codeApe || activites[0]?.codeApe || '',
    activite_principale: activites[0]?.descriptionDetaillee || activites[0]?.categorisationActivite1 || '',
    adresse: normaliserAdresse(socle.adresseEntreprise),
    dirigeants: (socle.composition?.pouvoirs || []).map(normaliserPouvoir).filter(Boolean),
    beneficiaires_effectifs: (socle.beneficiairesEffectifs || []).map((b) => ({
      nom_complet: nomComplet(b.beneficiaire?.descriptionPersonne),
      detention: b.modalite?.detentionPartSociale ?? null,
    })),
    etablissements: (socle.autresEtablissements || []).map((e) => ({
      siret: e.descriptionEtablissement?.siret || '',
      enseigne: e.descriptionEtablissement?.enseigne || '',
      adresse: normaliserAdresse(e.adresse),
    })),
    radiee: Boolean(entreprise.dateRadiation),
    brut: json,
  };
}

/**
 * Projette une fiche RNE sur les colonnes de la table `societes` : c'est ce
 * qui permet de créer une fiche société complète à partir d'un seul SIREN.
 */
function versFicheSociete(fiche) {
  if (!fiche) return null;
  return {
    denomination: fiche.denomination,
    forme_sociale: fiche.forme_juridique || '',
    capital_social: fiche.capital ?? null,
    siege_social: fiche.adresse?.texte || '',
    siren: fiche.siren_formate,
    rcs_ville: fiche.adresse?.commune || '',
    objet_social: fiche.objet || fiche.activite_principale || '',
    date_cloture: fiche.date_cloture || '',
  };
}

module.exports = {
  nettoyerSiren, formaterSiren, sirenValide,
  adresseTexte, normaliserAdresse,
  normaliserEntreprise, versFicheSociete,
};
