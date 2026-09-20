'use strict';

/**
 * Backend simulé, utilisé quand aucun identifiant INPI n'est configuré.
 *
 * Il permet de dérouler et de démontrer l'intégralité du parcours — recherche
 * par SIREN, pré-remplissage, contrôles, payload, dépôt, avancement du statut,
 * demande de régularisation — sans compte e-procédures et sans jamais rien
 * envoyer à l'INPI.
 *
 * Tout est déterministe (dérivé du SIREN ou de l'identifiant de liasse) : pas
 * d'état en mémoire, donc un comportement identique en serverless.
 */

const { formaterSiren, nettoyerSiren } = require('./normalize');

function empreinte(texte) {
  let h = 0;
  for (const c of String(texte)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

const RACINES = ['Alésia', 'Borée', 'Cassiopée', 'Dolmen', 'Estuaire', 'Farandole', 'Gallion', 'Héliante'];
const SUFFIXES = ['Conseil', 'Industries', 'Développement', 'Participations', 'Services', 'Technologies'];
const FORMES = ['5710', '5499', '5720', '6540', '5599'];
const VILLES = [
  { commune: 'Paris', codePostal: '75002', codeInseeCommune: '75102', typeVoie: 'RUE', voie: 'de la Paix', numVoie: '12' },
  { commune: 'Lyon', codePostal: '69002', codeInseeCommune: '69382', typeVoie: 'QUAI', voie: 'Saint-Antoine', numVoie: '15' },
  { commune: 'Bordeaux', codePostal: '33000', codeInseeCommune: '33063', typeVoie: 'COURS', voie: 'de l’Intendance', numVoie: '4' },
  { commune: 'Lille', codePostal: '59000', codeInseeCommune: '59350', typeVoie: 'RUE', voie: 'Nationale', numVoie: '88' },
];

/** JSON de formalité RNE plausible, dérivé du SIREN. */
function entrepriseSimulee(sirenBrut) {
  const siren = nettoyerSiren(sirenBrut);
  const h = empreinte(siren);
  const forme = FORMES[h % FORMES.length];
  const ville = VILLES[(h >>> 3) % VILLES.length];
  const denomination = `${RACINES[h % RACINES.length]} ${SUFFIXES[(h >>> 5) % SUFFIXES.length]}`.toUpperCase();
  const capital = [5000, 10000, 50000, 100000, 250000][(h >>> 7) % 5];
  const annee = 2005 + (h % 20);

  return {
    updatedAt: new Date().toISOString(),
    id: `demo-${siren}`,
    formality: {
      siren,
      content: {
        formeExerciceActivitePrincipale: forme === '6540' ? 'CIVILE' : 'COMMERCIALE',
        natureCreation: { formeJuridique: forme, etablieEnFrance: true, societeEtrangere: false },
        personneMorale: {
          identite: {
            entreprise: {
              siren,
              denomination,
              formeJuridique: forme,
              dateImmat: `${annee}-04-15`,
              dateDebutActiv: `${annee}-05-01`,
              codeApe: '7022Z',
            },
            description: {
              montantCapital: capital,
              deviseCapital: 'EUR',
              capitalVariable: false,
              duree: 99,
              dateClotureExerciceSocial: '3112',
              objet: 'Toutes prestations de conseil et de services aux entreprises, la prise de participations '
                + 'dans toutes sociétés et la gestion de ces participations.',
            },
          },
          adresseEntreprise: { adresse: { pays: 'France', codePays: 'FRA', ...ville } },
          composition: {
            pouvoirs: [{
              typeDePersonne: 'INDIVIDU',
              individu: {
                descriptionPersonne: {
                  role: forme.startsWith('57') ? '30' : '5',
                  nom: ['MARTIN', 'BERNARD', 'DUBOIS', 'THOMAS'][(h >>> 9) % 4],
                  prenoms: [['Claire', 'Paul', 'Léa', 'Antoine'][(h >>> 11) % 4]],
                  dateDeNaissance: `19${60 + (h % 30)}-06-12`,
                  nationalite: 'Française',
                },
                adresseDomicile: { adresse: { pays: 'France', codePays: 'FRA', ...VILLES[(h >>> 13) % VILLES.length] } },
              },
            }],
          },
          etablissementPrincipal: {
            descriptionEtablissement: { indicateurEtablissementPrincipal: true },
            adresse: { pays: 'France', codePays: 'FRA', ...ville },
            activites: [{ descriptionDetaillee: 'Conseil pour les affaires et autres conseils de gestion', indicateurPrincipal: true }],
          },
        },
      },
    },
    _simule: true,
  };
}

function rechercheSimulee(terme) {
  const base = empreinte(terme);
  return Array.from({ length: 5 }, (_, i) => {
    const siren = String(100000000 + ((base + i * 7919) % 899999999));
    const e = entrepriseSimulee(siren);
    const pm = e.formality.content.personneMorale;
    return {
      siren,
      siren_formate: formaterSiren(siren),
      denomination: pm.identite.entreprise.denomination,
      forme_juridique_code: pm.identite.entreprise.formeJuridique,
      commune: pm.adresseEntreprise.adresse.commune,
      _simule: true,
    };
  });
}

/* --------------------------------------------------------- Guichet unique */

const ETAPES = ['DEPOSEE', 'EN_COURS', 'VALIDEE'];

/** Identifiant de liasse simulé, horodaté pour pouvoir faire avancer le statut. */
function liasseSimulee() {
  return `DEMO-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`;
}

function horodatageDe(id) {
  const m = String(id).match(/^DEMO-([0-9A-Z]+)-/);
  const t = m ? parseInt(m[1], 36) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

/**
 * Statut simulé : la formalité avance d'une étape toutes les deux minutes.
 * Une liasse sur cinq bascule en régularisation — pour que le suivi des
 * régularisations soit démontrable sans attendre un vrai greffe.
 */
function statutSimule(id) {
  const minutes = (Date.now() - horodatageDe(id)) / 60000;
  const etape = Math.min(ETAPES.length - 1, Math.floor(minutes / 2));
  const regularisation = empreinte(id) % 5 === 0;
  if (regularisation && etape >= 1) {
    return {
      id,
      status: 'REGULARISATION',
      status_date: new Date().toISOString(),
      regularisations: [{
        date: new Date().toISOString(),
        motif: 'Pièce illisible : l’attestation de parution au journal d’annonces légales doit être fournie en intégralité.',
        delai_reponse_jours: 15,
      }],
      _simule: true,
    };
  }
  return { id, status: ETAPES[etape], status_date: new Date().toISOString(), _simule: true };
}

module.exports = { entrepriseSimulee, rechercheSimulee, liasseSimulee, statutSimule };
