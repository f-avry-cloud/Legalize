'use strict';

/**
 * Construction du JSON de formalité transmis au Guichet unique.
 *
 * L'arborescence reproduit celle du RNE (`formality.content` : natureCreation,
 * personneMorale → identite / adresseEntreprise / composition /
 * etablissementPrincipal), qui est le format pivot des formalités INPI. Pour
 * une modification, seul le bloc modifié est transmis, accompagné du bloc
 * `evenement` qui porte la date et la nature du changement.
 *
 * Le payload produit est toujours consultable dans l'application avant dépôt
 * (écran « JSON INPI »), ce qui permet de le contrôler — ou de le rejouer
 * manuellement — sans boîte noire.
 */

const { TYPES_FORMALITE, formeJuridique, roleDepuisFonction, codeFormeDepuisLibelle } = require('./referentiels');
const { definition } = require('./catalogue');
const { nettoyerSiren } = require('./normalize');

/* ------------------------------------------------------------- conversions */

/** « 2026-03-12 » → « 12-03-2026 » (format des dates du RNE). */
function dateInpi(iso) {
  if (!iso) return undefined;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso);
}

/** « 31/12 » ou « 2026-12-31 » → « 3112 ». */
function clotureInpi(valeur) {
  const chiffres = String(valeur || '').replace(/\D/g, '');
  if (chiffres.length === 4) return chiffres;
  if (chiffres.length === 8) return chiffres.slice(6, 8) + chiffres.slice(4, 6); // AAAAMMJJ
  return undefined;
}

function adresseInpi(a) {
  if (!a) return undefined;
  return {
    pays: a.pays || 'France',
    codePays: a.codePays || 'FRA',
    codePostal: a.codePostal || undefined,
    commune: a.commune || undefined,
    codeInseeCommune: a.codeInseeCommune || undefined,
    typeVoie: a.typeVoie || undefined,
    voie: a.voie || undefined,
    numVoie: a.numVoie || undefined,
    indiceRepetition: a.indiceRepetition || undefined,
    complementLocalisation: a.complementLocalisation || undefined,
    distributionSpeciale: a.distributionSpeciale || undefined,
  };
}

function personneInpi(p, fonction) {
  if (!p) return undefined;
  const role = roleDepuisFonction(fonction || p.fonction);
  const prenoms = Array.isArray(p.prenoms) ? p.prenoms
    : String(p.prenoms || p.prenom || '').split(/[\s,]+/).filter(Boolean);
  return {
    typeDePersonne: 'INDIVIDU',
    individu: {
      descriptionPersonne: {
        role: role ? role.code : undefined,
        roleLibelle: role ? role.libelle : (fonction || undefined),
        nom: p.nom || undefined,
        nomUsage: p.nom_usage || undefined,
        prenoms: prenoms.length ? prenoms : undefined,
        genre: p.genre || undefined,
        dateDeNaissance: dateInpi(p.date_naissance),
        lieuDeNaissance: p.lieu_naissance || undefined,
        paysNaissance: p.pays_naissance || 'France',
        nationalite: p.nationalite || 'Française',
      },
      adresseDomicile: adresseInpi(p.adresse),
    },
  };
}

/** Retire les clés undefined / objets vides pour un JSON lisible. */
function nettoyer(valeur) {
  if (Array.isArray(valeur)) {
    const l = valeur.map(nettoyer).filter((v) => v !== undefined);
    return l.length ? l : undefined;
  }
  if (valeur && typeof valeur === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(valeur)) {
      const n = nettoyer(v);
      if (n !== undefined) o[k] = n;
    }
    return Object.keys(o).length ? o : undefined;
  }
  return valeur === '' || valeur === null ? undefined : valeur;
}

/* ----------------------------------------------------- blocs par formalité */

const CONSTRUCTEURS = {
  creation_societe(r) {
    const code = r.forme_juridique_code || codeFormeDepuisLibelle(r.forme_juridique);
    return {
      natureCreation: {
        dateCreation: dateInpi(r.date_debut_activite),
        formeJuridique: code || undefined,
        societeEtrangere: false,
        etablieEnFrance: true,
        microEntreprise: false,
        entrepriseAgricole: false,
      },
      personneMorale: {
        identite: {
          entreprise: {
            denomination: r.denomination,
            sigle: r.sigle || undefined,
            formeJuridique: code || undefined,
            dateDebutActiv: dateInpi(r.date_debut_activite),
          },
          description: {
            montantCapital: r.capital != null && r.capital !== '' ? Number(r.capital) : undefined,
            deviseCapital: 'EUR',
            capitalVariable: Boolean(r.capital_variable),
            duree: r.duree != null && r.duree !== '' ? Number(r.duree) : undefined,
            dateClotureExerciceSocial: clotureInpi(r.date_cloture),
            objet: r.objet,
          },
        },
        adresseEntreprise: { adresse: adresseInpi(r.adresse_siege) },
        composition: { pouvoirs: [personneInpi(r.dirigeant, r.dirigeant?.fonction || formeJuridique(code)?.dirigeant)] },
        etablissementPrincipal: {
          descriptionEtablissement: { indicateurEtablissementPrincipal: true },
          adresse: adresseInpi(r.adresse_siege),
          activites: [{ descriptionDetaillee: r.activite_principale, indicateurPrincipal: true }],
        },
      },
    };
  },

  transfert_siege(r) {
    return {
      personneMorale: {
        adresseEntreprise: { adresse: adresseInpi(r.nouvelle_adresse) },
        ...(r.transfert_etablissement === false ? {} : {
          etablissementPrincipal: {
            descriptionEtablissement: { indicateurEtablissementPrincipal: true },
            adresse: adresseInpi(r.nouvelle_adresse),
          },
        }),
      },
      indicateurTransfertHorsRessort: Boolean(r.hors_ressort),
    };
  },

  changement_dirigeant(r) {
    const pouvoirs = [];
    if (r.nature !== 'cessation' && r.dirigeant_entrant) {
      pouvoirs.push({ ...personneInpi(r.dirigeant_entrant, r.fonction), indicateurEntree: true });
    }
    if (r.nature !== 'nomination' && r.dirigeant_sortant) {
      pouvoirs.push({
        typeDePersonne: 'INDIVIDU',
        indicateurSortie: true,
        individu: { descriptionPersonne: { nom: r.dirigeant_sortant } },
      });
    }
    return { personneMorale: { composition: { pouvoirs } } };
  },

  changement_denomination(r) {
    return {
      personneMorale: {
        identite: {
          entreprise: {
            denomination: r.nouvelle_denomination,
            sigle: r.nouveau_sigle || undefined,
            nomCommercial: r.nouveau_nom_commercial || undefined,
          },
        },
      },
    };
  },

  modification_capital(r) {
    return {
      personneMorale: {
        identite: {
          description: {
            montantCapital: r.nouveau_capital != null && r.nouveau_capital !== '' ? Number(r.nouveau_capital) : undefined,
            deviseCapital: 'EUR',
            capitalVariable: Boolean(r.capital_variable),
          },
        },
      },
      modaliteOperationCapital: r.modalite,
      sensOperationCapital: r.sens,
    };
  },

  modification_objet(r) {
    return {
      personneMorale: {
        identite: { description: { objet: r.nouvel_objet } },
        ...(r.nouvelle_activite ? {
          etablissementPrincipal: {
            activites: [{ descriptionDetaillee: r.nouvelle_activite, indicateurPrincipal: true }],
          },
        } : {}),
      },
    };
  },

  cessation(r) {
    return {
      personneMorale: {
        ...(r.nature === 'dissolution' ? {
          composition: { pouvoirs: [personneInpi(r.liquidateur, 'Liquidateur')] },
          adresseEntreprise: { adresse: adresseInpi(r.adresse_liquidation) },
        } : {}),
      },
      cessation: {
        typeCessation: r.nature,
        dateCessation: dateInpi(r.date_cessation),
        boniMaliLiquidation: r.boni_mali !== '' && r.boni_mali != null ? Number(r.boni_mali) : undefined,
        indicateurRadiation: r.nature === 'cloture_liquidation',
      },
    };
  },

  depot_comptes(r) {
    return {
      depotComptesAnnuels: {
        dateClotureExercice: dateInpi(r.exercice_clos),
        dateApprobation: dateInpi(r.date_approbation),
        resultat: r.resultat !== '' && r.resultat != null ? Number(r.resultat) : undefined,
        affectationResultat: r.affectation,
        montantDividendes: r.montant_dividendes !== '' && r.montant_dividendes != null
          ? Number(r.montant_dividendes) : undefined,
        typeConfidentialite: r.confidentialite || 'aucune',
        comptesConsolides: Boolean(r.comptes_consolides),
      },
    };
  },
};

/**
 * @param {object} dossier { type, siren, reference, libelle, fiche, reponses, pieces }
 * @returns {object} payload prêt à être déposé (et affichable tel quel)
 */
function construirePayload(dossier) {
  const constructeur = CONSTRUCTEURS[dossier.type];
  if (!constructeur) throw Object.assign(new Error(`Type de formalité inconnu : ${dossier.type}`), { status: 400 });
  const r = dossier.reponses || {};
  const fiche = dossier.fiche || null;
  const contenu = constructeur(r, fiche) || {};

  const type = definition(dossier.type).typeFormalite;
  const datePivot = r.date_decision || r.date_cessation || r.date_approbation || r.date_debut_activite;

  const payload = {
    typeFormalite: type,
    referenceMandataire: dossier.reference || undefined,
    nomDossier: dossier.libelle || undefined,
    companyName: fiche?.denomination || r.denomination || undefined,
    siren: type === TYPES_FORMALITE.CREATION ? undefined : nettoyerSiren(dossier.siren) || undefined,
    content: {
      ...contenu,
      ...(type === TYPES_FORMALITE.CREATION ? {} : {
        evenement: { type: dossier.type, date: dateInpi(datePivot) },
      }),
      formeExerciceActivitePrincipale: fiche?.famille === 'sci' ? 'CIVILE' : 'COMMERCIALE',
    },
    pieces: (dossier.pieces || []).map((p) => ({
      typePiece: p.code,
      nomFichier: p.nom || undefined,
      chemin: p.chemin || undefined,
    })),
  };

  return nettoyer(payload) || {};
}

module.exports = { construirePayload, dateInpi, clotureInpi, adresseInpi, personneInpi };
