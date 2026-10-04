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

const { contenuAnterieur, dateInpi, clotureInpi, adresseInpi } = require('./payload');
const { TYPES_FORMALITE, TYPES_PERSONNE, rolePrincipal, roleDepuisFonction } = require('./referentiels');
const { nettoyerSiren } = require('./normalize');

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
  if (e.fonction === 'liquidateur') return '40';
  if (e.fonction === 'cac') return '71';
  if (e.fonction === 'administrateur') return '65';
  return roleDepuisFonction(r.qualite)?.code || rolePrincipal(forme)?.code || '30';
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
    };
  }
  const prenoms = String(r.prenoms || '').split(/[\s,]+/).filter(Boolean);
  return {
    ...base,
    typeDePersonne: 'INDIVIDU',
    beneficiaireEffectif: Boolean(r.beneficiaire_effectif),
    individu: {
      descriptionPersonne: {
        role,
        nom: r.nom || e.nom,
        prenoms: prenoms.length ? prenoms : undefined,
        genre: r.genre || undefined,
        dateDeNaissance: dateInpi(r.date_naissance),
        lieuDeNaissance: r.lieu_naissance || undefined,
        codeInseeGeographique: r.code_insee_naissance || undefined,
        paysNaissance: String(r.pays_naissance || 'FRANCE').toUpperCase(),
        codePaysNaissance: r.code_pays_naissance || 'FRA',
        nationalite: r.nationalite || 'Française',
        formeSociale: r.forme_sociale || undefined,
        situationMatrimoniale: r.situation_matrimoniale || undefined,
      },
      adresseDomicile: adresseInpi(r.adresse),
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
  '34M'(c, r, D, fiche, t) { dirigeants(c, r, D, fiche, t); },
};

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
function deposable(op) { return Boolean(APPLIQUER[op]); }

/**
 * @param {object} dossier { operations, typologie, reponses: { commun, [op] }, fiche, siren, reference, libelle, pieces }
 * @returns {{endpoint, methode, corps}}
 */
function construireParcours(dossier) {
  const ops = dossier.operations || [];
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

module.exports = { construireParcours, deposable, socle, pouvoirEntrant, APPLIQUER };
