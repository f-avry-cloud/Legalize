'use strict';

/**
 * Dépôt d'un parcours : plusieurs modifications dans une seule formalité.
 *
 * Les dépôts de test sur le serveur de démonstration ont montré la forme qui
 * passe : `previousFormality` reprend la fiche du registre, `newFormality` la
 * reprend aussi, entièrement, avec les modifications appliquées et leurs
 * drapeaux déclencheurs. Le serveur revalide toute la société : on complète
 * donc les champs qu'il exige et que le registre ne fournit pas.
 *
 * Seules les opérations dont la forme a été vérifiée sont déposées
 * automatiquement ; les autres sont signalées, pour ne jamais envoyer un
 * dossier dont on sait qu'il serait refusé.
 */

const { contenuAnterieur, dateInpi, clotureInpi, adresseInpi, construirePayload, nettoyer, codeNationalite, beneficiairesInpi } = require('./payload');
const { TYPES_FORMALITE, TYPES_PERSONNE, STATUT_BLOC, rolePrincipal, roleDepuisFonction } = require('./referentiels');
const { nettoyerSiren } = require('./normalize');
const creation = require('./parcours-creation');

// Codes de « statutPourLaFormalite » des pouvoirs : 1 ajout, 3 suppression.
const AJOUT = '1';
const SUPPRESSION = '3';

const copie = (o) => JSON.parse(JSON.stringify(o ?? {}));

function chemin(objet, ...cles) {
  let o = objet;
  for (const c of cles) {
    if (o[c] === undefined || o[c] === null) o[c] = {};
    o = o[c];
  }
  return o;
}

/** Ce que le serveur exige pour toute modification et que le registre ne livre pas. */
function socle(content) {
  const pm = chemin(content, 'personneMorale');
  const identite = chemin(pm, 'identite');
  if (!identite.destinataireCorrespondance) identite.destinataireCorrespondance = { typeDestinataireCorrespondance: '2' };
  const desc = chemin(identite, 'description');
  if (desc.depotDemandeAcre === undefined) desc.depotDemandeAcre = false;
  const car = chemin(pm, 'adresseEntreprise', 'caracteristiques');
  if (car.indicateurDomicileEntrepreneur === undefined) car.indicateurDomicileEntrepreneur = false;
  if (car.domiciliataire === undefined) car.domiciliataire = false;
  return content;
}

/** Rôle INPI d'une personne nommée. */
function roleEntrant(e, r, forme) {
  // À la création, la fonction choisie est déjà un code de rôle.
  if (/^\d+$/.test(String(e.fonction || ''))) return String(e.fonction);
  if (e.fonction === 'liquidateur') return '40';
  if (e.fonction === 'cac') return '71';
  if (e.fonction === 'administrateur') return '65';
  return roleDepuisFonction(r.qualite)?.code || rolePrincipal(forme)?.code || '30';
}

/** Identité d'une personne physique au format du guichet. */
function descriptionIndividu(r, role) {
  const prenoms = String(r.prenoms || '').split(/[\s,]+/).filter(Boolean);
  return {
    role,
    nom: r.nom,
    prenoms: prenoms.length ? prenoms : undefined,
    genre: r.genre || undefined,
    dateDeNaissance: dateInpi(r.date_naissance),
    lieuDeNaissance: r.lieu_naissance || undefined,
    codeInseeGeographique: r.code_insee_naissance || undefined,
    paysNaissance: String(r.pays_naissance || 'FRANCE').toUpperCase(),
    nationalite: r.nationalite || 'Française',
    codeNationalite: codeNationalite(r.nationalite || 'Française'),
    formeSociale: r.forme_sociale || undefined,
    // Exigé par le guichet pour un dirigeant affilié de nationalité française.
    numeroSecu: r.numero_secu ? String(r.numero_secu).replace(/\s/g, '') : undefined,
    situationMatrimoniale: r.situation_matrimoniale || undefined,
  };
}

/**
 * Volet social d'un dirigeant travailleur non salarié (affiliation « 3 ») :
 * régime d'assurance maladie actuel, activité simultanée, activité
 * antérieure. Exigé par le guichet (constaté par dépôt de test).
 */
function voletSocial(v, dateEffet) {
  const oui = (x) => x === true || x === 'true';
  return {
    natureVoletSocial: 'TNS',
    dateEffetVoletSocial: dateEffet || undefined,
    indicateurRegimeAssuranceMaladie: Boolean(v.organisme_maladie) && v.organisme_maladie !== 'aucun',
    organismeAssuranceMaladieActuelle: v.organisme_maladie && v.organisme_maladie !== 'aucun' ? v.organisme_maladie : undefined,
    autreOrganisme: v.organisme_maladie === 'X' ? v.autre_organisme : undefined,
    // « aucune » : pas d'activité exercée en parallèle.
    activiteSimultanee: Boolean(v.activite_simultanee) && v.activite_simultanee !== 'aucune',
    statutExerciceActiviteSimultanee: v.activite_simultanee && v.activite_simultanee !== 'aucune' ? v.activite_simultanee : undefined,
    autreActiviteExercee: v.activite_simultanee === '9' ? v.autre_activite : undefined,
    indicateurActiviteAnterieure: Boolean(v.activite_anterieure),
    activiteAnterieureActivite: v.activite_anterieure || undefined,
    activiteAnterieureDateFin: dateInpi(v.activite_anterieure_fin),
    activiteAnterieureCodeGeo: v.activite_anterieure_insee || undefined,
    demandeAcre: oui(v.acre),
  };
}

/** Bloc pouvoir d'une personne nommée, d'après le formulaire ciblé. */
function pouvoirEntrant(e, r, forme, dateEffet) {
  const role = roleEntrant(e, r, forme);
  const base = { roleEntreprise: role, statutPourLaFormalite: AJOUT, is34Or35MAdjonctionTriggered: true, dateEffet34Or35M: dateEffet };
  if (e.nature === 'PM') {
    return {
      ...base,
      typeDePersonne: 'ENTREPRISE',
      beneficiaireEffectif: false,
      entreprise: {
        roleEntreprise: role,
        siren: nettoyerSiren(r.siren) || undefined,
        denomination: r.denomination || e.nom,
        formeJuridique: r.forme_juridique_code || undefined,
        lieuRegistre: r.greffe ? String(r.greffe).toUpperCase() : undefined,
      },
      adresseEntreprise: adresseInpi(r.adresse),
      // Personne morale administrateur : le guichet exige son représentant permanent.
      representant: r.representant?.nom ? {
        descriptionPersonne: { ...descriptionIndividu(r.representant, role), statutVisAVisFormalite: '1' },
        adresseDomicile: adresseInpi(r.representant.adresse),
      } : undefined,
    };
  }
  return {
    ...base,
    typeDePersonne: 'INDIVIDU',
    beneficiaireEffectif: Boolean(r.beneficiaire_effectif),
    individu: {
      descriptionPersonne: descriptionIndividu({ ...r, nom: r.nom || e.nom }, role),
      adresseDomicile: adresseInpi(r.adresse),
      voletSocial: String(r.forme_sociale) === '3' ? voletSocial(r.volet || {}, dateEffet) : undefined,
    },
  };
}

function nomPouvoir(p) {
  const d = p.individu?.descriptionPersonne;
  if (d) return `${(d.prenoms || []).join(' ')} ${d.nom || ''}`.trim().toLowerCase();
  return String(p.entreprise?.denomination || '').trim().toLowerCase();
}

/**
 * Chaque opération modifie le contenu complet. Une opération absente de ce
 * tableau n'est pas encore déposable automatiquement.
 */
const APPLIQUER = {
  '10M'(c, r, D) {
    const id = chemin(c, 'personneMorale', 'identite');
    Object.assign(chemin(id, 'entreprise'), { denomination: r.nouvelle_denomination, ...(r.nouveau_sigle ? { sigle: r.nouveau_sigle } : {}) });
    Object.assign(chemin(id, 'description'), { is10MTriggered: true, dateEffet10M: D });
  },
  '12M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), { objet: r.nouvel_objet, is12MTriggered: true, dateEffet12M: D });
  },
  '13M'(c, r, D) {
    Object.assign(chemin(c, 'natureCreation'), { formeJuridique: r.nouvelle_forme, is13MTriggered: true, dateEffet13M: D });
    chemin(c, 'personneMorale', 'identite', 'entreprise').formeJuridique = r.nouvelle_forme;
  },
  '14M'(c, r, D) {
    const id = chemin(c, 'personneMorale', 'identite');
    id.nomsDeDomaine = [...(id.nomsDeDomaine || []), { nomDomaine: r.nom_domaine, statutDomaine: '1', is14MTriggered: true, dateEffet14M: D }];
  },
  '15M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), {
      montantCapital: Number(r.nouveau_capital), is15MTriggered: true, dateEffet15M: D,
    });
  },
  '16M'(c, r, D, fiche) {
    const desc = chemin(c, 'personneMorale', 'identite', 'description');
    if (r.nouvelle_cloture) Object.assign(desc, { dateClotureExerciceSocial: clotureInpi(r.nouvelle_cloture), isModificationDateCloture: true });
    if (r.nouvelle_duree) {
      const debut = fiche.date_immatriculation || fiche.date_debut_activite;
      const fin = debut ? `${Number(debut.slice(0, 4)) + Number(r.nouvelle_duree)}${debut.slice(4, 10)}` : undefined;
      Object.assign(desc, { duree: Number(r.nouvelle_duree), isProlongationDuree: true, ...(fin ? { dateFinExistence: fin } : {}) });
    }
    Object.assign(desc, { is16MTriggered: true, dateEffet16M: D });
  },
  '17M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), {
      indicateurAssocieUnique: r.associe_unique === true || r.associe_unique === 'true',
      is17MTriggered: true, is17MNotDirigeantTriggered: true, dateEffet17M: D,
    });
  },
  '25M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), { continuationAvecActifNetInferieurMoitieCapital: true, dateEffet25M: D });
  },
  '26M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), { reconstitutionCapitauxPropres: true, dateEffet26M: D });
  },
  '35M'(c, r, D, fiche, t) { dirigeants(c, r, D, fiche, t); },
  '18M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), { ess: oui(r.ess), is18MTriggered: true, dateEffet18M: D });
  },
  '19M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), { natureGerance: r.nature_gerance, is19MTriggered: true, dateEffet19M: D });
  },
  '20M'(c, r) {
    const d = dateInpi(r.date_debut_activite);
    for (const a of chemin(c, 'personneMorale', 'etablissementPrincipal').activites || []) Object.assign(a, { dateDebut: d, is20MTriggered: true });
  },
  '29M'(c, r, D) {
    Object.assign(chemin(c, 'personneMorale', 'identite', 'description'), {
      societeMission: oui(r.societe_mission), is29MQualiteSocieteMissionTriggered: true, dateEffet29MQualiteSocieteMission: D,
    });
  },
  '38F'(c, r, D) {
    // Déclaration totale : la liste remplace la précédente, chaque bénéficiaire en « ajout ».
    Object.assign(chemin(c, 'personneMorale'), {
      is38FTriggered: true, dateEffet38F: D, mode38F: 2,
      beneficiairesEffectifs: beneficiairesInpi((r.beneficiaires || []).map((b) => ({
        personne: b, modalites: b.modalites, pourcentage_capital: b.pourcentage_capital, pourcentage_votes: b.pourcentage_votes,
      }))),
    });
  },
  '51M'(c, r) {
    Object.assign(chemin(c, 'personneMorale', 'structureEntreprise'), { is51Or52MTriggered: true, dateEffet51M: dateInpi(r.date_debut) });
  },
  '54PMF'(c, r, D, fiche, t) {
    const pm = chemin(c, 'personneMorale');
    const modele = (pm.etablissementPrincipal?.activites || [])[0] || {};
    const cat = creation.categorie(r.categorie);
    const date = dateInpi(r.date_ouverture) || D;
    const activite = {
      ...(modele.codeApe ? { codeApe: modele.codeApe } : {}),
      descriptionDetaillee: r.activite, dateDebut: date, indicateurPrincipal: true, rolePrincipalPourEntreprise: false,
      indicateurPremiereActivite: false, exerciceActivite: 'P', formeExercice: creation.formeExercice(cat),
      origine: { typeOrigine: creation.ORIGINE_FONDS[t.fonds_origine] || '1' }, activiteReguliere: modele.activiteReguliere,
      ...(cat ? Object.fromEntries(cat.code.split('-').map((v, i) => [`categorisationActivite${i + 1}`, v])) : {}),
    };
    pm.autresEtablissements = [...(pm.autresEtablissements || []), {
      descriptionEtablissement: { rolePourEntreprise: '4', statutPourFormalite: '1', indicateurEtablissementPrincipal: false, identifiantTemporaire: '1' },
      adresse: adresseInpi(r.adresse), activites: [activite],
      effectifSalarie: { presenceSalarie: oui(r.salaries), emploiPremierSalarie: false },
      is54PMFTriggered: true, dateEffetOuvertureEtablissement: date,
    }];
  },
  '55PM'(c, r, D) {
    const e = etablissement(c, r.etablissement);
    e.nomsDeDomaine = [...(e.nomsDeDomaine || []), { nomDomaine: r.nom_domaine, statutDomaine: '1', is55PMTriggered: true, dateEffet: D }];
  },
  '60PMF'(c, r, D) {
    Object.assign(chemin(etablissement(c, r.etablissement), 'descriptionEtablissement'), { enseigne: r.enseigne, is60PMFTriggered: true, dateEffet60PMF: D });
  },
  '61PMF'(c, r, D) {
    const ep = chemin(c, 'personneMorale', 'etablissementPrincipal');
    const modele = (ep.activites || [])[ep.activites?.length - 1] || {};
    const cat = creation.categorie(r.categorie);
    const act = JSON.parse(JSON.stringify(modele));
    delete act.activiteId;
    Object.assign(act, {
      rolePrincipalPourEntreprise: false, indicateurPrincipal: false, descriptionDetaillee: r.activite, dateDebut: dateInpi(r.date_debut) || D,
      formeExercice: creation.formeExercice(cat) || act.formeExercice, is61PMFTriggered: true,
      ...(cat ? Object.fromEntries(cat.code.split('-').map((v, i) => [`categorisationActivite${i + 1}`, v])) : {}),
    });
    ep.activites = [...(ep.activites || []), act];
  },
  '62M'(c, r) {
    const a = (chemin(c, 'personneMorale', 'etablissementPrincipal').activites || [])[Number(r.activite || 0)];
    if (a) Object.assign(a, { is62PMTriggered: true, dateFin: dateInpi(r.date_fin) });
  },
  '63M'(c, r) {
    const a = (chemin(c, 'personneMorale', 'etablissementPrincipal').activites || [])[0];
    if (a) Object.assign(a, { is63PMFTriggered: true, dateEffet63PMF: dateInpi(r.date_rachat) });
  },
  '67PMF'(c, r, D) {
    const a = (chemin(c, 'personneMorale', 'etablissementPrincipal').activites || [])[Number(r.activite || 0)];
    if (a) Object.assign(a, { descriptionDetaillee: r.description, is67PMTriggered: true, dateEffet67PM: D });
  },
  '80PMF'(c, r, D) {
    const e = etablissement(c, r.etablissement);
    e.is80PMFTriggered = true;
    Object.assign(chemin(e, 'descriptionEtablissement'), { statutPourFormalite: '2', destinationEtablissement: r.destination || 'B', dateEffetFermeture: dateInpi(r.date_fermeture) || D });
  },
  '84M'(c, r, D) {
    const ep = chemin(c, 'personneMorale', 'etablissementPrincipal');
    const l = r.locataire || {};
    Object.assign(ep, {
      is84MTriggered: true, isLocationGeranceOrGeranceMandat: true,
      locataireGerantMandataire: { denomination: l.denomination, siren: nettoyerSiren(l.siren), lieuRegistre: l.greffe ? String(l.greffe).toUpperCase() : undefined },
      // Codes du référentiel : 1 gérance-mandat, 2 location-gérance.
      locationGeranceMandat: { destinationLocationGeranceMandat: r.mode === 'K' ? '1' : '2', typeLocataireGerantMandataire: 'ENTREPRISE', dateEffet: dateInpi(r.date_effet) || D },
    });
    for (const a of ep.activites || []) a.isLocationGeranceOrGeranceMandat = true;
  },
  '34M'(c, r, D, fiche, t) { dirigeants(c, r, D, fiche, t); },
};

const oui = (x) => x === true || x === 'true';

/** Établissement secondaire désigné par son rang dans la fiche. */
function etablissement(c, rang) {
  const autres = chemin(c, 'personneMorale').autresEtablissements || [];
  return autres[Number(rang || 0)] || {};
}

/* ------------------------------------------------- cessations (type « R ») */

/**
 * Mise en sommeil (40M) et dissolution par l'associé unique (28M) se déposent
 * comme des cessations, sur la fiche complète, sans état antérieur à part.
 * Recettes établies par dépôts de test.
 */
const CESSATIONS = {
  '40M'(c, r) {
    const d = dateInpi(r.date_cessation);
    c.personneMorale.detailCessationEntreprise = { dateCessationTotaleActivite: d, indicateurDissolution: false, indicateurDisparitionPM: false };
    for (const e of tousEtablissements(c)) Object.assign(chemin(e, 'descriptionEtablissement'), { statutPourFormalite: '2', destinationEtablissement: 'F', dateEffetFermeture: d });
  },
  '28M'(c, r) {
    const d = dateInpi(r.date_dissolution);
    const a = r.associe_unique || {};
    c.personneMorale.detailCessationEntreprise = {
      indicateurDissolution: true, typeDissolution: '2', dateDissolutionDisparition: d, dateTransfertPatrimoine: d, motifCessation: '11',
    };
    chemin(c, 'personneMorale', 'composition').pouvoirs = [...(c.personneMorale.composition.pouvoirs || []), {
      typeDePersonne: 'ENTREPRISE', roleEntreprise: '130', statutPourLaFormalite: '1',
      entreprise: { siren: nettoyerSiren(a.siren), denomination: a.denomination, formeJuridique: a.forme_juridique_code, roleEntreprise: '130', lieuRegistre: a.greffe ? String(a.greffe).toUpperCase() : undefined },
      adresseEntreprise: adresseInpi(a.adresse),
    }];
    // Établissements secondaires : le guichet exige une destination (constaté).
    for (const e of c.personneMorale.autresEtablissements || []) chemin(e, 'descriptionEtablissement').destinationEtablissement = 'B';
  },
};

CESSATIONS['41M'] = (c, r) => {
  const d = dateInpi(r.date_fusion);
  const a = r.absorbante || {};
  c.personneMorale.detailCessationEntreprise = { indicateurDissolution: true, dateDissolutionDisparition: d, motifCessation: '12', indicateurDisparitionPM: true };
  c.personneMorale.identite.entreprisesIntervenant = [{
    entreprise: { siren: nettoyerSiren(a.siren), denomination: a.denomination, formeJuridique: a.forme_juridique_code },
    adresse: adresseInpi(a.adresse),
  }];
  chemin(c, 'personneMorale', 'identite', 'description').indicateurOrigineFusionScission = true;
  // Les établissements encore ouverts passent à la société absorbante.
  for (const e of tousEtablissements(c)) {
    const de = chemin(e, 'descriptionEtablissement');
    if (/^1[1-6]$/.test(String(de.rolePourEntreprise || ''))) continue;
    Object.assign(de, { destinationEtablissement: '9', autreDestination: 'Transmis à la société absorbante', dateEffetFermeture: d });
  }
};

function tousEtablissements(c) {
  return [c.personneMorale.etablissementPrincipal, ...(c.personneMorale.autresEtablissements || [])].filter(Boolean);
}

function construireCessation(dossier, op) {
  const fiche = dossier.fiche || {};
  const r = { ...(dossier.reponses?.commun || {}), ...(dossier.reponses?.[op] || {}) };
  const c = socle(copie(contenuAnterieur(fiche)));
  completerRegistre(c, dossier.reponses?._registre || {});
  c.evenementCessation = op;
  c.natureCessation = '1';
  // Pouvoirs existants : inchangés (exigé par le guichet pour une cessation).
  for (const p of c.personneMorale?.composition?.pouvoirs || []) p.statutPourLaFormalite = '4';
  for (const e of tousEtablissements(c)) for (const a of e.activites || []) a.indicateurProlongement = false;
  CESSATIONS[op](c, r);
  c.piecesJointes = (dossier.pieces || []).map((p) => ({
    nomDocument: p.nom, typeDocument: p.code, langueDocument: 'fr', documentExtension: 'pdf', ...(p.base64 ? { documentBase64: p.base64 } : {}),
  }));
  const denomination = fiche.denomination || c.personneMorale?.identite?.entreprise?.denomination;
  return {
    endpoint: 'formalites', methode: 'POST',
    corps: {
      companyName: denomination, referenceMandataire: dossier.reference || undefined, nomDossier: dossier.libelle || undefined,
      typeFormalite: 'R', typePersonne: TYPES_PERSONNE.MORALE, diffusionINSEE: 'O', diffusionCommerciale: 'O',
      indicateurEntreeSortieRegistre: true, siren: nettoyerSiren(dossier.siren) || undefined, content: c,
    },
  };
}

function dirigeants(c, r, D, fiche, t) {
  const compo = chemin(c, 'personneMorale', 'composition');
  compo.pouvoirs = compo.pouvoirs || [];
  for (const s of t.sortants || []) {
    if (!s?.nom) continue;
    const cible = compo.pouvoirs.find((p) => nomPouvoir(p) === s.nom.trim().toLowerCase())
      || compo.pouvoirs.find((p) => nomPouvoir(p).includes(s.nom.trim().toLowerCase().split(' ').pop()));
    if (cible) Object.assign(cible, { statutPourLaFormalite: SUPPRESSION, is34Or35MSuppressionTriggered: true, dateEffet34Or35M: D });
  }
  for (const [i, e] of (t.entrants || []).entries()) {
    if (!e?.nom || e.fonction === 'liquidateur') continue;
    compo.pouvoirs.push(pouvoirEntrant(e, r[`entrant_${i}`] || {}, fiche.forme_juridique_code, D));
  }
  compo.isModificationPouvoir = true;
}

/** Reporte les compléments saisis sur les dirigeants déjà inscrits (par rang). */
function completerRegistre(content, r) {
  const pouvoirs = content.personneMorale?.composition?.pouvoirs || [];
  pouvoirs.forEach((p, i) => {
    const d = p.individu?.descriptionPersonne;
    if (d && r[`genre_${i}`]) d.genre = r[`genre_${i}`];
    if (d && r[`forme_sociale_${i}`] !== undefined) d.formeSociale = String(r[`forme_sociale_${i}`]);
    if (p.entreprise && r[`greffe_${i}`]) p.entreprise.lieuRegistre = String(r[`greffe_${i}`]).toUpperCase();
    if (r[`adresse_${i}`]) {
      const a = adresseInpi(r[`adresse_${i}`]);
      if (p.entreprise) p.adresseEntreprise = a; else if (p.individu) p.individu.adresseDomicile = a;
    }
  });
}

/** Opérations déposables automatiquement aujourd'hui. */
function deposable(op) { return Boolean(APPLIQUER[op] || CESSATIONS[op]) || ['01M', '02M'].includes(op); }

/* --------------------------------------------------------------- création */

/** Les réponses du parcours, à plat, au format du générateur de création. */
function reponsesCreation(dossier) {
  const t = dossier.typologie || {};
  const rep = dossier.reponses || {};
  const f = creation.forme(t) || {};
  const s = rep.c_societe || {};
  const a = rep.c_activite || {};
  const fisc = rep.c_fiscal || {};
  const pub = rep.c_publication || {};
  const sansActivite = (dossier.operations || []).includes('02M');
  return {
    ...s,
    forme_juridique_code: f.code,
    associe_unique: Boolean(f.unique),
    adresse_siege: rep.c_siege?.adresse_siege,
    domiciliation: t.siege_occupation === 'domiciliation',
    siege_domicile_dirigeant: t.siege_occupation === 'domicile',
    succursale_ou_filiale: 'AVEC_ETABLISSEMENT',
    activite_principale: sansActivite ? undefined : a.activite_principale,
    date_debut_activite: a.date_debut_activite,
    exercice_activite: a.exercice_activite || 'P',
    origine_activite: creation.ORIGINE_FONDS[t.fonds_origine] || '1',
    forme_exercice: creation.formeExercice(creation.categorie(a.categorie), f),
    emploi_salaries: a.emploi_salaries === true,
    date_premiere_embauche: a.date_premiere_embauche,
    effectif_salarie: a.effectif_salarie,
    regime_benefices: fisc.regime_benefices,
    regime_tva: fisc.regime_tva,
    // La clôture comptable suit la clôture statutaire (format JJMM).
    date_cloture_comptable: s.date_cloture,
    journal_publication: pub.journal_publication,
    date_publication: pub.date_publication,
    acre: pub.acre === true,
    beneficiaires_effectifs: (rep.c_be?.beneficiaires || []).map((b) => ({
      personne: b, modalites: b.modalites, pourcentage_capital: b.pourcentage_capital, pourcentage_votes: b.pourcentage_votes,
    })),
  };
}

const nomCle = (nom, prenoms) => `${String(prenoms || '').trim()} ${String(nom || '').trim()}`.trim().toLowerCase().replace(/\s+/g, ' ');

/** Bloc pouvoir d'un dirigeant à la création : comme une nomination, sans drapeau de modification. */
function pouvoirCreation(e, r, f, beneficiaires) {
  const p = pouvoirEntrant(e, r, f.code);
  delete p.is34Or35MAdjonctionTriggered;
  delete p.dateEffet34Or35M;
  p.statutPourLaFormalite = STATUT_BLOC.ADJONCTION;
  p.isRepresentantLegal = creation.categorieFonction(e.fonction) === 'dirigeant';
  if (p.individu) {
    p.beneficiaireEffectif = beneficiaires.has(nomCle(r.nom || e.nom, r.prenoms));
  }
  return p;
}

/**
 * Formalité de création issue du parcours. Le générateur de création fait le
 * gros du travail ; s'y ajoutent ce que seul le parcours connaît : les
 * dirigeants personnes morales, la catégorie d'activité, le domiciliataire.
 */
function construireCreation(dossier) {
  const t = dossier.typologie || {};
  const rep = dossier.reponses || {};
  const f = creation.forme(t);
  if (!f) throw Object.assign(new Error('Choisissez la forme de la société.'), { status: 422 });
  const r = reponsesCreation(dossier);
  const { corps } = construirePayload({
    type: 'creation_societe', siren: '', fiche: {}, reference: dossier.reference, libelle: dossier.libelle,
    reponses: r, pieces: dossier.pieces || [],
  });
  const c = corps.content;
  const pm = c.personneMorale;
  if ((dossier.operations || []).includes('02M')) {
    // Société sans activité : le siège est un établissement sans activité,
    // qui ne peut pas être « principal » (règles du serveur, constatées).
    const siege = pm.etablissementPrincipal || {};
    delete pm.etablissementPrincipal;
    siege.descriptionEtablissement = { ...(siege.descriptionEtablissement || {}), rolePourEntreprise: '1', statutPourFormalite: '1', indicateurEtablissementPrincipal: false };
    delete siege.activites;
    pm.autresEtablissements = [siege];
    pm.structureEntreprise = { aucuneActivite: true, indicateurPrincipalIdemSiege: false, dateAucuneActivite: dateInpi(r.date_debut_activite) };
    delete c.formeExerciceActivitePrincipale;
  }

  const beneficiaires = new Set((rep.c_be?.beneficiaires || []).map((b) => nomCle(b.nom, b.prenoms)));
  pm.composition = {
    pouvoirs: (t.entrants || [])
      .map((e, i) => (e?.nom ? pouvoirCreation(e, rep.c_dirigeants?.[`entrant_${i}`] || {}, f, beneficiaires) : null))
      .filter(Boolean),
  };

  const cat = creation.categorie(rep.c_activite?.categorie);
  for (const act of pm.etablissementPrincipal?.activites || []) {
    if (cat) {
      cat.code.split('-').forEach((v, i) => { act[`categorisationActivite${i + 1}`] = v; });
    }
  }
  if (r.domiciliation) {
    pm.adresseEntreprise.entrepriseDomiciliataire = {
      denomination: rep.c_siege?.domiciliataire_denomination,
      siren: nettoyerSiren(rep.c_siege?.domiciliataire_siren),
    };
  }
  corps.content = nettoyer(c);
  return { endpoint: 'formalites', methode: 'POST', corps };
}

/**
 * @param {object} dossier { operations, typologie, reponses: { commun, [op] }, fiche, siren, reference, libelle, pieces }
 * @returns {{endpoint, methode, corps}}
 */
function construireParcours(dossier) {
  const ops = dossier.operations || [];
  if (ops.some((op) => ['01M', '02M'].includes(op))) return construireCreation(dossier);
  const cessation = ops.find((op) => CESSATIONS[op]);
  if (cessation) return construireCessation(dossier, cessation);
  const nonGeres = ops.filter((op) => !deposable(op));
  if (nonGeres.length) {
    throw Object.assign(new Error(`Dépôt automatique pas encore disponible pour : ${nonGeres.join(', ')}.`), { status: 422, non_geres: nonGeres });
  }
  const fiche = dossier.fiche || {};
  const t = dossier.typologie || {};
  const commun = dossier.reponses?.commun || {};
  const D = dateInpi(commun.date_decision);

  const precedent = contenuAnterieur(fiche);
  const content = socle(copie(precedent));
  completerRegistre(content, dossier.reponses?._registre || {});
  for (const op of ops) {
    const r = { ...commun, ...(dossier.reponses?.[op] || {}) };
    APPLIQUER[op](content, r, dateInpi(r.date_effet) || D, fiche, t);
  }
  content.piecesJointes = (dossier.pieces || []).map((p) => ({
    nomDocument: p.nom, typeDocument: p.code, langueDocument: 'fr', documentExtension: 'pdf',
    ...(p.base64 ? { documentBase64: p.base64 } : {}),
  }));

  const denomination = fiche.denomination || content.personneMorale?.identite?.entreprise?.denomination;
  return {
    endpoint: 'formalitesModification',
    methode: 'POST',
    corps: {
      previousFormality: { companyName: denomination, typePersonne: TYPES_PERSONNE.MORALE, content: precedent },
      newFormality: {
        companyName: content.personneMorale?.identite?.entreprise?.denomination || denomination,
        referenceMandataire: dossier.reference || undefined,
        nomDossier: dossier.libelle || undefined,
        typeFormalite: TYPES_FORMALITE.MODIFICATION,
        typePersonne: TYPES_PERSONNE.MORALE,
        diffusionINSEE: 'O',
        diffusionCommerciale: 'O',
        indicateurEntreeSortieRegistre: false,
        siren: nettoyerSiren(dossier.siren) || undefined,
        content,
      },
    },
  };
}

module.exports = { CESSATIONS, construireParcours, construireCreation, reponsesCreation, deposable, socle, pouvoirEntrant, APPLIQUER };
