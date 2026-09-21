'use strict';

/**
 * Construction des requêtes déposées au Guichet unique.
 *
 * L'arborescence suit le dictionnaire de données mandataire :
 *   content
 *     ├─ natureCreation            (BlocNatureCreation)
 *     ├─ evenementCessation        (code évènement, ex. 22M)
 *     ├─ personneMorale
 *     │    ├─ identite.entreprise  (BlocEntrepriseIdentite)
 *     │    ├─ identite.description (BlocDetailPersonneMorale)
 *     │    ├─ adresseEntreprise.adresse       (BlocAdresse)
 *     │    ├─ composition.pouvoirs[]          (BlocPouvoir)
 *     │    ├─ etablissementPrincipal          (RubriqueEtablissement)
 *     │    └─ detailCessationEntreprise
 *     └─ piecesJointes[]           (BlocPieceJointe, PDF en base64)
 *
 * Trois formes de dépôt, servies par trois endpoints distincts :
 *   - création / cessation → POST /api/formalities          (enveloppe simple)
 *   - modification         → POST /api/formality_updates    (previousFormality
 *     + newFormality, cette dernière portant au moins un indicateur
 *     d'évènement `…Triggered` à true)
 *   - comptes annuels      → POST /api/annual_accounts
 *
 * La fonction renvoie donc l'endpoint visé en même temps que le corps, et le
 * corps reste affichable tel quel dans l'application avant tout envoi.
 */

const {
  TYPES_FORMALITE, TYPES_PERSONNE, ROLE_ETABLISSEMENT, STATUT_BLOC,
  formeJuridique, roleDepuisFonction, rolePrincipal, codeFormeDepuisLibelle,
} = require('./referentiels');
const { definition } = require('./catalogue');
const { nettoyerSiren } = require('./normalize');

/* ------------------------------------------------------------ conversions */

/** Le Guichet unique attend des dates ISO « AAAA-MM-JJ ». */
function dateInpi(valeur) {
  if (!valeur) return undefined;
  const m = String(valeur).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const fr = String(valeur).match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  return fr ? `${fr[3]}-${fr[2]}-${fr[1]}` : String(valeur);
}

/** Clôture d'exercice : « 31/12 » ou « 2025-12-31 » → « 3112 » (JJMM). */
function clotureInpi(valeur) {
  if (!valeur) return undefined;
  const iso = String(valeur).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}${iso[2]}`;
  const chiffres = String(valeur).replace(/\D/g, '');
  return chiffres.length === 4 ? chiffres : undefined;
}

function nombre(v) {
  if (v === '' || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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

/** RubriqueEtablissement + son unique BlocDescriptionActivite. */
function etablissementInpi(o) {
  if (!o.adresse && !o.activite) return undefined;
  return {
    descriptionEtablissement: {
      rolePourEntreprise: o.role,
      indicateurEtablissementPrincipal: Boolean(o.principal),
    },
    adresse: o.adresse,
    effectifSalarie: o.salaries,
    activites: o.activite ? [{
      indicateurPrincipal: Boolean(o.principal),
      rolePrincipalPourEntreprise: Boolean(o.principal),
      indicateurPremiereActivite: true,
      descriptionDetaillee: o.activite,
      dateDebut: dateInpi(o.dateDebut),
      formeExercice: o.formeExercice || 'COMMERCIALE',
      precisionActivite: o.precision || undefined,
      exerciceActivite: o.exercice || undefined,
      activiteReguliere: o.regularite || undefined,
      origine: o.origine || undefined,
    }] : undefined,
  };
}

/**
 * PMRubriqueBeneficiaireEffectif. La modalité de contrôle est obligatoire :
 * à défaut de choix, l'INPI retient le représentant légal (code « 0 »).
 */
function beneficiairesInpi(liste) {
  const beneficiaires = (liste || [])
    .filter((b) => b.personne?.nom)
    .map((b, i) => ({
      // Le dictionnaire déclare cet identifiant en chaîne, pas en entier.
      beneficiaireId: String(i + 1),
      beneficiaire: { descriptionPersonne: descriptionPersonne(b.personne) },
      modalite: {
        modalitesDeControle: b.modalite_controle ? [b.modalite_controle] : undefined,
        detentionPartTotale: nombre(b.pourcentage_capital),
        detentionVoteTotal: nombre(b.pourcentage_votes),
      },
      statutPourLaFormalite: STATUT_BLOC.ADJONCTION,
    }));
  return beneficiaires.length ? beneficiaires : undefined;
}

/** BlocOptionFiscale : régime des bénéfices, TVA, chiffre d'affaires prévisionnel. */
function optionsFiscalesInpi(r) {
  const o = {
    regimeImpositionBenefices: r.regime_benefices || undefined,
    regimeImpositionTVA: r.regime_tva || undefined,
    periodiciteEtOptionsParticulieresTVA: r.periodicite_tva || undefined,
    dateClotureExerciceComptable: dateInpi(r.date_cloture_comptable),
    chiffreAffairePrevisionnelVente: nombre(r.ca_previsionnel_vente),
    chiffreAffairePrevisionnelService: nombre(r.ca_previsionnel_service),
  };
  const rempli = Object.values(o).some((v) => v !== undefined && v !== null);
  return rempli ? { ...o, deviseChiffreAffaire: 'EUR' } : undefined;
}

/** BlocPouvoir d'une personne physique (dirigeant, liquidateur…). */
/** BlocDescriptionPersonneIndividu : commun aux pouvoirs et aux bénéficiaires effectifs. */
function descriptionPersonne(personne, role) {
  if (!personne) return undefined;
  const prenoms = Array.isArray(personne.prenoms) ? personne.prenoms
    : String(personne.prenoms || personne.prenom || '').split(/[\s,]+/).filter(Boolean);
  return {
    role: role || undefined,
    nom: personne.nom || undefined,
    nomUsage: personne.nom_usage || undefined,
    prenoms: prenoms.length ? prenoms : undefined,
    genre: personne.genre || undefined,
    dateDeNaissance: dateInpi(personne.date_naissance),
    lieuDeNaissance: personne.lieu_naissance || undefined,
    paysNaissance: personne.pays_naissance || 'France',
    nationalite: personne.nationalite || 'Française',
  };
}

function pouvoirIndividu(personne, { fonction, codeForme, statut, representantLegal = true, triggers } = {}) {
  if (!personne) return undefined;
  const r = roleDepuisFonction(fonction || personne.fonction) || rolePrincipal(codeForme);
  return {
    typeDePersonne: 'INDIVIDU',
    roleEntreprise: r ? r.code : undefined,
    isRepresentantLegal: representantLegal,
    statutPourLaFormalite: statut || undefined,
    individu: {
      descriptionPersonne: descriptionPersonne(personne, r ? r.code : undefined),
      adresseDomicile: adresseInpi(personne.adresse),
    },
    ...(triggers || {}),
  };
}

/** Pièces jointes : PDF encodés en base64, dans content.piecesJointes. */
function piecesInpi(pieces) {
  return (pieces || []).map((p) => ({
    nomDocument: p.nom || p.filename || undefined,
    typeDocument: p.code || undefined,
    documentExtension: 'pdf',
    langueDocument: 'Français',
    documentBase64: p.base64 || undefined,
    observations: p.observations || undefined,
  }));
}

/** Retire les clés vides pour produire un JSON lisible et minimal. */
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

/* ------------------------------------------------- état antérieur (RNE) */

/**
 * `previousFormality.content` d'une modification : on réutilise tel quel le
 * contenu renvoyé par le RNE, qui est déjà au format du Guichet unique. À
 * défaut (RNE indisponible), on reconstruit le minimum depuis la fiche.
 */
function contenuAnterieur(fiche) {
  const brut = fiche?.brut?.formality?.content;
  if (brut) return brut;
  const codeForme = fiche?.forme_juridique_code || codeFormeDepuisLibelle(fiche?.forme_juridique);
  return nettoyer({
    personneMorale: {
      identite: {
        entreprise: {
          siren: nettoyerSiren(fiche?.siren),
          denomination: fiche?.denomination,
          formeJuridique: codeForme || undefined,
        },
        description: {
          objet: fiche?.objet,
          montantCapital: nombre(fiche?.capital),
          deviseCapital: fiche?.devise_capital || 'EUR',
        },
      },
      adresseEntreprise: { adresse: adresseInpi(fiche?.adresse) },
    },
  }) || {};
}

/* ------------------------------------------------- contenus par formalité */

const CONTENUS = {
  creation_societe(r) {
    const codeForme = r.forme_juridique_code || codeFormeDepuisLibelle(r.forme_juridique);
    const adresse = adresseInpi(r.adresse_siege);
    const salaries = Boolean(r.emploi_salaries);

    const dirigeants = (r.dirigeants || []).map((d) => d.personne).filter(Boolean);
    // Rétrocompatibilité : les dossiers ouverts avant la refonte du
    // questionnaire portent un dirigeant unique et non une liste.
    if (!dirigeants.length && r.dirigeant) dirigeants.push(r.dirigeant);

    const pouvoirs = dirigeants.map((d) => pouvoirIndividu(d, {
      fonction: d.fonction, codeForme, statut: STATUT_BLOC.ADJONCTION,
    })).filter(Boolean);
    for (const a of r.associes || []) {
      const pouvoir = pouvoirIndividu(a.personne, {
        fonction: a.personne?.fonction, codeForme, statut: STATUT_BLOC.ADJONCTION,
        representantLegal: false,
      });
      if (pouvoir) pouvoirs.push(pouvoir);
    }

    return {
      succursaleOuFiliale: r.succursale_ou_filiale || 'AVEC_ETABLISSEMENT',
      formeExerciceActivitePrincipale: r.forme_exercice || 'COMMERCIALE',
      natureCreation: {
        dateCreation: dateInpi(r.date_debut_activite),
        formeJuridique: codeForme || undefined,
        societeEtrangere: Boolean(r.societe_etrangere),
        etablieEnFrance: !r.societe_etrangere,
        microEntreprise: Boolean(r.micro_entreprise),
        entrepriseAgricole: Boolean(r.entreprise_agricole),
        salarieEnFrance: salaries,
        presenceSalarie: salaries,
        eirl: false,
      },
      personneMorale: {
        identite: {
          entreprise: {
            denomination: r.denomination,
            sigle: r.sigle || undefined,
            nomCommercial: r.nom_commercial || undefined,
            formeJuridique: codeForme || undefined,
          },
          description: {
            objet: r.objet,
            duree: nombre(r.duree),
            dateClotureExerciceSocial: clotureInpi(r.date_cloture),
            montantCapital: nombre(r.capital),
            deviseCapital: 'EUR',
            capitalVariable: Boolean(r.capital_variable),
            indicateurAssocieUnique: Boolean(r.associe_unique),
          },
        },
        adresseEntreprise: { adresse },
        composition: { pouvoirs },
        beneficiairesEffectifs: beneficiairesInpi(r.beneficiaires_effectifs),
        etablissementPrincipal: etablissementInpi({
          adresse,
          role: r.role_etablissement || ROLE_ETABLISSEMENT.SIEGE_ET_PRINCIPAL,
          principal: true,
          activite: r.activite_principale,
          dateDebut: r.date_debut_activite,
          formeExercice: r.forme_exercice,
          precision: r.precision_activite,
          exercice: r.exercice_activite,
          regularite: r.activite_reguliere,
          origine: r.origine_activite,
          salaries: salaries ? {
            presenceSalarie: true,
            nombreSalarie: nombre(r.effectif_salarie),
            dateEffetDebutEmploiSalarie: dateInpi(r.date_premiere_embauche),
          } : undefined,
        }),
        autresEtablissements: (r.autres_etablissements || []).map((e) => etablissementInpi({
          adresse: adresseInpi(e.adresse),
          role: e.role || ROLE_ETABLISSEMENT.PRINCIPAL,
          principal: false,
          activite: e.activite,
          dateDebut: e.date_debut,
          formeExercice: r.forme_exercice,
        })),
        optionsFiscales: optionsFiscalesInpi(r),
      },
    };
  },

  transfert_siege(r, fiche) {
    const adresse = adresseInpi(r.nouvelle_adresse);
    const dateEffet = dateInpi(r.date_effet || r.date_decision);
    return {
      personneMorale: {
        // La date de prise d'effet appartient au bloc adresse lui-même, et non
        // à la rubrique qui le contient.
        adresseEntreprise: { adresse: { ...adresse, datePriseEffetAdresse: dateEffet } },
        etablissementPrincipal: {
          // Indicateur d'évènement 11M « transfert de l'entreprise ».
          is11PMFTriggered: true,
          isTransfer: true,
          descriptionEtablissement: {
            rolePourEntreprise: r.transfert_etablissement === false
              ? ROLE_ETABLISSEMENT.SIEGE
              : ROLE_ETABLISSEMENT.SIEGE_ET_PRINCIPAL,
            siret: fiche?.etablissements?.[0]?.siret || undefined,
          },
          adresse,
        },
      },
    };
  },

  changement_dirigeant(r, fiche) {
    const codeForme = fiche?.forme_juridique_code;
    const pouvoirs = [];
    if (r.nature !== 'cessation') {
      pouvoirs.push(pouvoirIndividu(r.dirigeant_entrant, {
        fonction: r.fonction, codeForme, statut: STATUT_BLOC.ADJONCTION,
        triggers: { is34Or35MAdjonctionTriggered: true, isNewPouvoir: true },
      }));
    }
    if (r.nature !== 'nomination' && r.dirigeant_sortant) {
      const sortant = (fiche?.dirigeants || []).find((d) => d.nom_complet === r.dirigeant_sortant);
      pouvoirs.push({
        typeDePersonne: 'INDIVIDU',
        statutPourLaFormalite: STATUT_BLOC.SUPPRESSION,
        is34Or35MSuppressionTriggered: true,
        roleEntreprise: sortant?.role || undefined,
        individu: {
          descriptionPersonne: {
            nom: sortant?.nom || r.dirigeant_sortant,
            prenoms: sortant?.prenoms?.length ? sortant.prenoms : undefined,
            dateDeNaissance: dateInpi(sortant?.dateNaissance),
          },
        },
      });
    }
    return {
      personneMorale: {
        composition: { pouvoirs, isModificationPouvoir: true },
      },
    };
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
          // Indicateur d'évènement 10M « modification de l'identification ».
          description: { is10MTriggered: true, dateEffet10M: dateInpi(r.date_decision) },
        },
      },
    };
  },

  modification_capital(r) {
    const augmentation = r.sens === 'augmentation';
    return {
      personneMorale: {
        identite: {
          description: {
            // Indicateur d'évènement 15M « modification du capital social ».
            is15MTriggered: true,
            dateEffet15M: dateInpi(r.date_decision),
            montantCapital: nombre(r.nouveau_capital),
            deviseCapital: 'EUR',
            capitalVariable: Boolean(r.capital_variable),
            augmentationReductionCapital: augmentation ? 'AUGMENTATION' : 'REDUCTION',
            modificationCapitalTypes: [augmentation ? 'AUGMENTATION' : 'REDUCTION'],
            typeAugmentationCapital: augmentation ? r.modalite : undefined,
            typeReductionCapital: augmentation ? undefined : r.modalite,
            operationEntrainantUneAugmentationDeCapital: augmentation || undefined,
          },
        },
      },
    };
  },

  modification_objet(r) {
    return {
      personneMorale: {
        identite: {
          // Indicateur d'évènement 12M « modification de l'objet ».
          description: { is12MTriggered: true, dateEffet12M: dateInpi(r.date_decision), objet: r.nouvel_objet },
        },
        ...(r.nouvelle_activite ? {
          etablissementPrincipal: {
            activites: [{
              indicateurPrincipal: true,
              descriptionDetaillee: r.nouvelle_activite,
              statutFormalite: STATUT_BLOC.MODIFICATION,
            }],
          },
        } : {}),
      },
    };
  },

  cessation(r, fiche) {
    const dissolution = r.nature === 'dissolution';
    const cloture = r.nature === 'cloture_liquidation';
    return {
      // Évènements de cessation : 22M dissolution, 42M disparition de la
      // personne morale, 40M cessation totale sans disparition.
      evenementCessation: dissolution ? '22M' : (cloture ? '42M' : '40M'),
      personneMorale: {
        detailCessationEntreprise: {
          indicateurDissolution: dissolution || undefined,
          typeDissolution: dissolution ? (r.type_dissolution || '1') : undefined,
          dateDissolutionDisparition: dateInpi(r.date_cessation),
          lieuDeLiquidation: r.adresse_liquidation?.commune || undefined,
          adresse: adresseInpi(r.adresse_liquidation),
          dateClotureLiquidation: cloture ? dateInpi(r.date_cessation) : undefined,
          indicateurDisparitionPM: cloture || undefined,
          indicateurDisparitionPMClotureLiquidation: cloture || undefined,
          dateCessationTotaleActivite: r.nature === 'cessation_activite' ? dateInpi(r.date_cessation) : undefined,
          motifCessation: r.motif_cessation || (dissolution ? '9' : undefined),
        },
        ...(dissolution && r.liquidateur ? {
          composition: {
            pouvoirs: [pouvoirIndividu(r.liquidateur, {
              fonction: 'Liquidateur',
              codeForme: fiche?.forme_juridique_code,
              statut: STATUT_BLOC.ADJONCTION,
              representantLegal: false,
            })],
            isModificationPouvoir: true,
          },
        } : {}),
      },
      ...(cloture ? { natureCessationEntreprise: { dateRadiation: dateInpi(r.date_cessation) } } : {}),
    };
  },

  depot_comptes(r, fiche) {
    const confidentialite = r.confidentialite || 'aucune';
    const cloture = dateInpi(r.exercice_clos);
    return {
      personneMorale: {
        identite: {
          entreprise: {
            siren: nettoyerSiren(fiche?.siren),
            denomination: fiche?.denomination,
            formeJuridique: fiche?.forme_juridique_code || undefined,
          },
        },
      },
      comptesAnnuels: {
        comptesConsolides: Boolean(r.comptes_consolides),
        dateCloture: cloture,
        dateDebutExerciceComptable: dateInpi(r.exercice_debut),
        dateFinExerciceComptable: cloture,
        dispenseDepotAnnexes: Boolean(r.dispense_annexes),
        depotSimplifie: Boolean(r.depot_simplifie),
        // La confidentialité se déclare bloc par bloc (micro-entreprise :
        // comptes entiers ; petite entreprise : compte de résultat seul).
        compteBilan: { confidentiel: confidentialite === 'totale' },
        compteResultat: { confidentiel: confidentialite !== 'aucune' },
      },
    };
  },
};

/* ----------------------------------------------------------- enveloppes */

function enveloppe(dossier, contenu, type) {
  return {
    companyName: dossier.fiche?.denomination || dossier.reponses?.denomination || undefined,
    referenceMandataire: dossier.reference || undefined,
    nomDossier: dossier.libelle || undefined,
    typeFormalite: type,
    typePersonne: TYPES_PERSONNE.MORALE,
    diffusionINSEE: dossier.reponses?.diffusion_insee === false ? 'N' : 'O',
    indicateurEntreeSortieRegistre: type !== TYPES_FORMALITE.MODIFICATION,
    content: {
      ...contenu,
      piecesJointes: piecesInpi(dossier.pieces),
    },
  };
}

/**
 * @param {object} dossier { type, siren, reference, libelle, fiche, reponses, pieces }
 * @returns {{endpoint: string, methode: string, corps: object}}
 */
function construirePayload(dossier) {
  const def = definition(dossier.type);
  const construire = CONTENUS[dossier.type];
  if (!def || !construire) {
    throw Object.assign(new Error(`Type de formalité inconnu : ${dossier.type}`), { status: 400 });
  }
  const r = dossier.reponses || {};
  const fiche = dossier.fiche || null;
  const contenu = construire(r, fiche) || {};

  // Dépôt des comptes annuels : service dédié, enveloppe propre.
  if (def.service === 'comptes_annuels') {
    return {
      endpoint: 'comptesAnnuels',
      methode: 'POST',
      corps: nettoyer({
        typePersonne: TYPES_PERSONNE.MORALE,
        referenceMandataire: dossier.reference || undefined,
        nomDossier: dossier.libelle || undefined,
        companyName: fiche?.denomination || undefined,
        content: { ...contenu, piecesJointes: piecesInpi(dossier.pieces) },
      }) || {},
    };
  }

  // Modification : couple previousFormality / newFormality.
  if (def.typeFormalite === TYPES_FORMALITE.MODIFICATION) {
    const nouvelle = enveloppe(dossier, contenu, TYPES_FORMALITE.MODIFICATION);
    return {
      endpoint: 'formalitesModification',
      methode: 'POST',
      corps: nettoyer({
        previousFormality: {
          companyName: fiche?.denomination || undefined,
          typePersonne: TYPES_PERSONNE.MORALE,
          content: contenuAnterieur(fiche),
        },
        newFormality: { ...nouvelle, siren: nettoyerSiren(dossier.siren) || undefined },
      }) || {},
    };
  }

  // Création et cessation : dépôt direct.
  const corps = enveloppe(dossier, contenu, def.typeFormalite);
  if (def.typeFormalite !== TYPES_FORMALITE.CREATION) corps.siren = nettoyerSiren(dossier.siren) || undefined;
  return { endpoint: 'formalites', methode: 'POST', corps: nettoyer(corps) || {} };
}

/** Indicateurs `…Triggered` présents : un dépôt de modification en exige un. */
function indicateursEvenement(valeur, chemin = '', acc = []) {
  if (!valeur || typeof valeur !== 'object') return acc;
  for (const [k, v] of Object.entries(valeur)) {
    if (/Triggered$/.test(k) && v === true) acc.push(chemin ? `${chemin}.${k}` : k);
    else if (v && typeof v === 'object') indicateursEvenement(v, chemin ? `${chemin}.${k}` : k, acc);
  }
  return acc;
}

module.exports = {
  construirePayload, indicateursEvenement,
  dateInpi, clotureInpi, adresseInpi, pouvoirIndividu, contenuAnterieur,
};
