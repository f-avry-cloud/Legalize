'use strict';

/**
 * Backend simulé, utilisé quand aucun identifiant INPI n'est configuré.
 *
 * Il permet de dérouler et de démontrer l'intégralité du parcours — recherche
 * par SIREN, pré-remplissage, contrôles, payload, dépôt, signature, paiement,
 * suivi et demande de régularisation — sans compte e-procédures et sans
 * jamais rien envoyer à l'INPI.
 *
 * Le cycle reproduit celui du Guichet unique (§ 9.1 du contrat d'interface) :
 * ce qui avance tout seul avance tout seul (RECEIVED → SIGNATURE_PENDING,
 * puis VALIDATION_PENDING → VALIDATED), et ce qui attend une action du
 * mandataire l'attend vraiment (signature, paiement). Les données entreprise
 * sont dérivées du SIREN, donc stables d'un appel à l'autre.
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

/**
 * État des dépôts simulés. Volontairement en mémoire : un dépôt simulé n'a
 * pas à survivre au processus — le statut de référence reste celui stocké en
 * base par l'application. Au redémarrage, l'étape est redérivée de l'horodatage
 * contenu dans l'identifiant.
 */
const depots = new Map();

const TARIFS_SIMULES = { formalites: 195.71, formalitesModification: 195.71, comptesAnnuels: 47.36 };

/** Identifiant de liasse simulé, horodaté pour pouvoir redériver l'étape. */
function liasseSimulee() {
  return `SIM-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0')}`;
}

function horodatageDe(id) {
  const m = String(id).match(/^SIM-([0-9A-Z]+)-/);
  const t = m ? parseInt(m[1], 36) : NaN;
  return Number.isFinite(t) ? t : Date.now();
}

function etatDe(id) {
  if (!depots.has(id)) {
    // Dépôt inconnu du processus (redémarrage) : on repart de l'horodatage.
    const secondes = (Date.now() - horodatageDe(id)) / 1000;
    depots.set(id, {
      etape: secondes > 30 ? 'SIGNATURE_PENDING' : 'RECEIVED',
      depuis: horodatageDe(id),
      montant: TARIFS_SIMULES.formalites,
    });
  }
  return depots.get(id);
}

/** Dépôt simulé : renvoie une formalité au format du Guichet unique. */
function deposerSimule(requete) {
  const id = liasseSimulee();
  depots.set(id, {
    etape: 'RECEIVED',
    depuis: Date.now(),
    montant: TARIFS_SIMULES[requete?.endpoint] ?? TARIFS_SIMULES.formalites,
  });
  const enveloppe = requete?.corps?.newFormality || requete?.corps || {};
  return {
    id,
    liasseNumber: id,
    companyName: enveloppe.companyName || null,
    referenceMandataire: enveloppe.referenceMandataire || null,
    status: 'RECEIVED',
    statusDate: new Date().toISOString(),
    carts: { total: depots.get(id).montant },
    _simule: true,
  };
}

/**
 * Statut simulé. Les transitions automatiques du Guichet unique s'appliquent
 * (génération du document de synthèse, puis validation par les partenaires) ;
 * les étapes qui demandent une action du mandataire restent bloquantes.
 * Un dépôt sur cinq part en régularisation, pour que le suivi de
 * régularisation soit démontrable sans attendre un vrai valideur.
 */
function statutSimule(id) {
  const etat = etatDe(id);
  const secondes = (Date.now() - etat.depuis) / 1000;

  if (etat.etape === 'RECEIVED' && secondes > 30) {
    etat.etape = 'SIGNATURE_PENDING';
    etat.depuis = Date.now();
  } else if (etat.etape === 'VALIDATION_PENDING' && secondes > 60) {
    etat.etape = empreinte(id) % 5 === 0 ? 'AMENDMENT_PENDING' : 'VALIDATED';
    etat.depuis = Date.now();
  }

  const regularisations = etat.etape === 'AMENDMENT_PENDING' ? [{
    id: 1,
    type: 'INVALID_ATTACHMENT',
    motif: 'Pièce illisible : l’attestation de parution au journal d’annonces légales doit être fournie en intégralité.',
    champ: null,
    piece: null,
    echeance: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString(),
    frais: null,
  }] : [];

  return {
    id,
    liasseNumber: id,
    status: etat.etape,
    statusDate: new Date().toISOString(),
    carts: { total: etat.montant, paymentDate: etat.paiement || null },
    signedDate: etat.signature || null,
    regularisations,
    _simule: true,
  };
}

function signerSimule(id) {
  const etat = etatDe(id);
  etat.signature = new Date().toISOString();
  etat.etape = etat.montant > 0 ? 'PAYMENT_PENDING' : 'VALIDATION_PENDING';
  etat.depuis = Date.now();
  return { signature_id: `SIM-SIG-${Date.now()}`, date: etat.signature, simule: true };
}

function payerSimule(id) {
  const etat = etatDe(id);
  etat.paiement = new Date().toISOString();
  etat.etape = 'VALIDATION_PENDING';
  etat.depuis = Date.now();
  return { ok: true, montant: etat.montant, simule: true };
}

/** Document de synthèse simulé (PDF minimal mais valide). */
function syntheseSimulee(id) {
  const texte = `Document de synthese simule - liasse ${id}`;
  const contenu = `BT /F1 12 Tf 60 720 Td (${texte}) Tj ET`;
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contenu.length} >>\nstream\n${contenu}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objets.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

module.exports = {
  entrepriseSimulee, rechercheSimulee,
  deposerSimule, statutSimule, signerSimule, payerSimule, syntheseSimulee, liasseSimulee,
};
