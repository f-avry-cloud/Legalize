'use strict';

/**
 * Création de société dans le parcours, sur base en mémoire : pièces selon
 * la situation, champs ciblés et complétude, contenu déposé pour chaque forme.
 *
 *   node scripts/test-creation.js
 */

const { tables } = require('./fake-supa');

const app = require('../src/routes');
const express = require('express');
const { construireParcours } = require('../src/inpi/payload-parcours');
const { resoudre } = require('../src/inpi/parcours');
const { verifier: conforme } = require('../src/inpi/conformite');
const creation = require('../src/inpi/parcours-creation');

const serveur = express();
serveur.use(express.json());
serveur.use('/api', app);
serveur.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message, details: err.details }));

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
    process.exitCode = 1;
  }
}

const ADR = { numVoie: '10', typeVoie: 'RUE', voie: 'de la Paix', codePostal: '75002', commune: 'Paris', codeInseeCommune: '75102' };
const PP = (nom, prenoms) => ({
  nom, prenoms, genre: '1', date_naissance: '1980-03-04', lieu_naissance: 'Lyon', code_insee_naissance: '69123',
  pays_naissance: 'FRANCE', nationalite: 'Française', forme_sociale: '3', numero_secu: '180036912300130',
  situation_matrimoniale: '1', adresse: ADR, volet: { organisme_maladie: 'R', activite_simultanee: 'aucune' },
});

/** Un dossier de création complet, prêt à déposer. */
function dossier(forme, extra = {}) {
  const roles = { SAS: '73', SASU: '73', SARL: '30', EURL: '30', SA: '60', SNC: '28', SCI: '30', SC: '30' };
  return {
    operations: [extra.op || '01M'],
    typologie: {
      forme_creation: forme, siege_occupation: 'locaux', apports_numeraire: true, apports_nature: false,
      premiers_dirigeants_statuts: true, fonds_origine: 'creation', activite_reglementee: false,
      entrants: [{ nom: 'Paul MARTIN', nature: 'PP', fonction: roles[forme] }], ...extra.t,
    },
    reponses: {
      c_societe: { denomination: `ESSAI ${forme}`, capital: 1000, objet: 'Conseil', duree: 99, date_cloture: '31/12', date_signature_statuts: '2026-09-15' },
      c_siege: { adresse_siege: ADR },
      c_activite: { activite_principale: 'Conseil en organisation', categorie: '07-04-08-02', date_debut_activite: '2026-10-01', exercice_activite: 'P' },
      c_dirigeants: { entrant_0: PP('MARTIN', 'Paul') },
      c_be: { beneficiaires: [{ ...PP('MARTIN', 'Paul'), modalites: ['3', '1'], pourcentage_capital: 100, pourcentage_votes: 100 }] },
      c_fiscal: { regime_benefices: '114', regime_tva: '311' },
      c_publication: { journal_publication: 'actu-juridique.fr', date_publication: '2026-09-20' },
      ...extra.r,
    },
    pieces: [],
  };
}

(async () => {
  console.log('\nPièces selon la situation');
  const vide = resoudre(['01M'], {});
  verifier('la forme est la première question', vide.questions[0]?.id === 'forme_creation', vide.questions.map((q) => q.id));
  verifier('les dirigeants attendent la forme', vide.questions.find((q) => q.id === 'entrants')?.attente, vide.questions.find((q) => q.id === 'entrants'));
  verifier('statuts et annonce toujours exigés', ['PJ_01', 'PJ_08'].every((c) => vide.pieces.obligatoires.some((p) => p.code === c)));

  const sas = resoudre(['01M'], { forme_creation: 'SAS', siege_occupation: 'domiciliation', domiciliataire_meme_greffe: false, apports_numeraire: true, apports_nature: true, commissaire_apports: true, premiers_dirigeants_statuts: false, fonds_origine: 'achat', activite_reglementee: true,
    entrants: [{ nom: 'Paul MARTIN', nature: 'PP', fonction: '73', hors_ue: true }, { nom: 'HOLDING', nature: 'PM', fonction: '53' }, { nom: 'AUDIT', nature: 'PM', fonction: '71', inscrit: true }] });
  const codes = sas.pieces.obligatoires.map((p) => p.code);
  verifier('rôles proposés : ceux d’une SAS et les commissaires aux comptes', JSON.stringify(sas.questions.find((q) => q.id === 'entrants').options.map(([c]) => c)) === JSON.stringify(['73', '53', '70', '71', '72']));
  for (const [code, motif] of [['PJ_29', 'contrat de domiciliation'], ['PJ_45', 'Kbis du domiciliataire'], ['PJ_06', 'certificat du dépositaire'], ['PJ_04', 'rapport du commissaire aux apports'],
    ['PJ_05', 'évaluation des apports en nature'], ['PJ_03', 'acte de nomination des dirigeants'], ['PJ_33', 'acte d’achat du fonds'], ['PJ_31', 'autorisation d’exercer'], ['PJ_41', 'acceptation du CAC']]) {
    verifier(`${motif} (${code})`, codes.includes(code), codes);
  }
  verifier('dirigeant personne physique : identité et non-condamnation', ['PJ_11', 'PJ_17'].every((c) => sas.pieces.obligatoires.some((p) => p.code === c && p.personne === 'Paul MARTIN')));
  verifier('dirigeant personne morale : Kbis', sas.pieces.obligatoires.some((p) => p.code === 'PJ_20' && p.personne === 'HOLDING'));
  verifier('nationalité hors UE : titre de séjour à préciser', sas.pieces.a_preciser.some((p) => p.cle === 'PJ_14:e0'), sas.pieces.a_preciser.map((p) => p.cle));
  verifier('CAC inscrit : pas de justificatif d’inscription', !codes.includes('PJ_40'));
  verifier('locaux, domicile : non demandés', !codes.includes('PJ_25') && !codes.includes('PJ_26'));
  const t2 = resoudre(['01M'], { forme_creation: 'SAS', siege_occupation: 'locaux', apports_numeraire: false, apports_nature: false, premiers_dirigeants_statuts: true, fonds_origine: 'creation', activite_reglementee: false,
    manuel: { 'PJ_14:e0': false }, entrants: [{ nom: 'Paul MARTIN', nature: 'PP', fonction: '73', hors_ue: true }] });
  verifier('sans apport en argent : pas de certificat du dépositaire', !t2.pieces.obligatoires.some((p) => p.code === 'PJ_06'));
  verifier('titre de séjour écarté à la main', !t2.pieces.a_preciser.some((p) => p.cle === 'PJ_14:e0') && !t2.pieces.obligatoires.some((p) => p.code === 'PJ_14'));
  verifier('plus rien à préciser', t2.pieces.a_preciser.length === 0, t2.pieces.a_preciser.map((p) => p.cle));
  const sasu = resoudre(['01M'], { forme_creation: 'SASU', associe_unique_nature: 'PM' });
  verifier('SASU détenue par une société : Kbis de l’associé unique proposé', sasu.pieces.facultatives.some((p) => p.code === 'PJ_188'));
  const sa = resoudre(['01M'], { forme_creation: 'SA', entrants: [{ nom: 'X SAS', nature: 'PM', fonction: '65' }] });
  verifier('SA, administrateur personne morale : Kbis et désignation du représentant permanent', ['PJ_20', 'PJ_80'].every((c) => sa.pieces.obligatoires.some((p) => p.code === c)));
  verifier('incompatibilité : une création se dépose seule', resoudre(['01M', '15M'], {}).incompatibilites.length > 0);

  console.log('\nChamps ciblés et complétude');
  const d = dossier('SARL');
  const g = resoudre(['01M'], d.typologie, {}, d.reponses).champs;
  verifier('sept rubriques dans l’ordre du juriste', g.map((x) => x.op).join(',') === 'c_societe,c_siege,c_activite,c_dirigeants,c_be,c_fiscal,c_publication', g.map((x) => x.op));
  const gerant = g.find((x) => x.op === 'c_dirigeants').champs[0];
  verifier('gérant de SARL : situation matrimoniale exigée', gerant.sous_requis.includes('situation_matrimoniale'));
  verifier('personne complète : rien ne manque', creation.manquants(gerant, PP('MARTIN', 'Paul')).length === 0, creation.manquants(gerant, PP('MARTIN', 'Paul')));
  verifier('affilié sans NIR : le NIR manque', creation.manquants(gerant, { ...PP('MARTIN', 'Paul'), numero_secu: '' }).includes('numéro de sécurité sociale'));
  verifier('NIR à la clé fausse : signalé', creation.manquants(gerant, { ...PP('MARTIN', 'Paul'), numero_secu: '180036912300100' }).some((m) => /clé invalide/.test(m)));
  verifier('travailleur non salarié sans volet social : signalé', creation.manquants(gerant, { ...PP('MARTIN', 'Paul'), volet: {} }).includes('régime d’assurance maladie actuel'));
  verifier('non affilié : NIR non exigé', creation.manquants(gerant, { ...PP('MARTIN', 'Paul'), forme_sociale: '1', numero_secu: '' }).length === 0);
  verifier('né à l’étranger : pas de code INSEE exigé', creation.manquants(gerant, { ...PP('MARTIN', 'Paul'), pays_naissance: 'BELGIQUE', code_insee_naissance: '' }).length === 0);
  const be = g.find((x) => x.op === 'c_be').champs[0];
  verifier('bénéficiaire effectif : au moins un', creation.manquants(be, []).length === 1);
  verifier('bénéficiaire sans modalité de contrôle : signalé', creation.manquants(be, [{ ...PP('MARTIN', 'Paul'), modalites: [] }]).length === 1);
  const dom = resoudre(['01M'], { ...d.typologie, siege_occupation: 'domiciliation' }, {}, d.reponses).champs.find((x) => x.op === 'c_siege');
  verifier('siège domicilié : le domiciliataire est demandé', dom.champs.some((c) => c.name === 'domiciliataire_siren'));
  const sal = resoudre(['01M'], d.typologie, {}, { ...d.reponses, c_activite: { ...d.reponses.c_activite, emploi_salaries: true } }).champs.find((x) => x.op === 'c_activite');
  verifier('salariés : date de première embauche demandée', sal.champs.some((c) => c.name === 'date_premiere_embauche' && c.requis));
  const sansAct = resoudre(['02M'], d.typologie, {}, d.reponses).champs.find((x) => x.op === 'c_activite');
  verifier('sans activité : seule la date de constitution', sansAct.champs.length === 1);

  console.log('\nContenu déposé, forme par forme');
  for (const [forme, code, unique] of [['SAS', '5710', false], ['SASU', '5710', true], ['SARL', '5499', false], ['EURL', '5499', true],
    ['SA', '5599', false], ['SNC', '5202', false], ['SCI', '6540', false], ['SC', '6599', false]]) {
    const { endpoint, corps } = construireParcours(dossier(forme));
    const pm = corps.content.personneMorale;
    const ecarts = conforme(corps.content);
    verifier(`${forme} : ${code}${unique ? ' avec associé unique' : ''}, conforme au dictionnaire`,
      endpoint === 'formalites' && corps.typeFormalite === 'C' && pm.identite.entreprise.formeJuridique === code
      && Boolean(pm.identite.description.indicateurAssocieUnique) === unique && !ecarts.length, ecarts);
  }
  const c = construireParcours(dossier('SAS', {
    t: { siege_occupation: 'domiciliation', fonds_origine: 'achat',
      entrants: [{ nom: 'HOLDING FICTIVE', nature: 'PM', fonction: '73' }, { nom: 'Paul MARTIN', nature: 'PP', fonction: '53' }] },
    r: {
      c_siege: { adresse_siege: ADR, domiciliataire_denomination: 'DOMICILIATION', domiciliataire_siren: '794 598 813' },
      c_dirigeants: { entrant_0: { denomination: 'HOLDING FICTIVE', siren: '794598813', forme_juridique_code: '5710', greffe: 'Paris', adresse: ADR }, entrant_1: PP('MARTIN', 'Paul') },
    },
  })).corps.content;
  const p = c.personneMorale;
  verifier('président personne morale : greffe en capitales, SIREN', p.composition.pouvoirs[0].typeDePersonne === 'ENTREPRISE' && p.composition.pouvoirs[0].entreprise.lieuRegistre === 'PARIS' && p.composition.pouvoirs[0].roleEntreprise === '73');
  verifier('directeur général : rôle 53, bénéficiaire effectif reconnu', p.composition.pouvoirs[1].roleEntreprise === '53' && p.composition.pouvoirs[1].beneficiaireEffectif === true);
  verifier('aucun drapeau de modification dans une création', !JSON.stringify(c).includes('34Or35M'));
  verifier('catégorie d’activité sur quatre niveaux', ['07', '04', '08', '02'].every((v, i) => p.etablissementPrincipal.activites[0][`categorisationActivite${i + 1}`] === v));
  verifier('fonds acheté : origine « achat »', p.etablissementPrincipal.activites[0].origine.typeOrigine === '3');
  verifier('domiciliataire déclaré', p.adresseEntreprise.entrepriseDomiciliataire?.siren === '794598813' && p.adresseEntreprise.caracteristiques.domiciliataire === true);
  verifier('volet social du travailleur non salarié transmis', p.composition.pouvoirs[1].individu.voletSocial?.natureVoletSocial === 'TNS'
    && p.composition.pouvoirs[1].individu.voletSocial.organismeAssuranceMaladieActuelle === 'R' && p.composition.pouvoirs[1].individu.voletSocial.activiteSimultanee === false);
  verifier('NIR transmis sans espaces', p.composition.pouvoirs[1].individu.descriptionPersonne.numeroSecu === '180036912300130');
  verifier('bénéficiaire effectif : statut « ajout », capital ventilé', p.beneficiairesEffectifs[0].statutPourLaFormalite === '1' && p.beneficiairesEffectifs[0].modalite.partsDirectesPleinePropriete === 100);
  verifier('journal du référentiel repris tel quel', p.identite.publicationLegale.journalPublication === 'actu-juridique.fr');
  const autre = construireParcours(dossier('SAS', { r: { c_publication: { journal_publication: 'Mon Journal Inconnu', date_publication: '2026-09-20' } } })).corps.content;
  verifier('journal hors référentiel : « Autre » avec son nom', autre.personneMorale.identite.publicationLegale.journalPublication === 'Autre'
    && autre.personneMorale.identite.publicationLegale.journalPublicationAutre === 'Mon Journal Inconnu');
  const dom2 = construireParcours(dossier('SAS', { t: { siege_occupation: 'domicile' } })).corps.content;
  verifier('siège au domicile : option validée', dom2.personneMorale.adresseEntreprise.caracteristiques.indicateurDomicileEntrepreneurValidation === true);
  const sa2 = construireParcours(dossier('SA', {
    t: { entrants: [{ nom: 'Paul MARTIN', nature: 'PP', fonction: '60' }, { nom: 'X SAS', nature: 'PM', fonction: '65' }] },
    r: { c_dirigeants: { entrant_0: PP('MARTIN', 'Paul'), entrant_1: { denomination: 'X SAS', siren: '794598813', greffe: 'Paris', adresse: ADR, representant: PP('DURAND', 'Luc') } } },
  })).corps.content;
  const rp = sa2.personneMorale.composition.pouvoirs[1].representant?.descriptionPersonne;
  verifier('SA : représentant permanent avec nationalité codée et statut', rp?.codeNationalite === 'FRA' && rp?.statutVisAVisFormalite === '1', rp);
  const sansAct2 = construireParcours(dossier('SAS', { op: '02M' })).corps.content.personneMorale;
  verifier('sans activité : pas d’établissement principal, structure déclarée', !sansAct2.etablissementPrincipal && sansAct2.structureEntreprise?.aucuneActivite === true
    && sansAct2.autresEtablissements?.[0]?.descriptionEtablissement?.rolePourEntreprise === '1');
  const salarie = construireParcours(dossier('SAS', { r: { c_activite: { ...dossier('SAS').reponses.c_activite, emploi_salaries: true, date_premiere_embauche: '2026-10-15', effectif_salarie: 2 } } })).corps.content;
  verifier('salariés : premier emploi déclaré', salarie.personneMorale.etablissementPrincipal.effectifSalarie.emploiPremierSalarie === true);

  console.log('\nParcours complet : création d’une SAS jusqu’au dépôt');
  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}/api`;
  const appel = async (methode, url, corps, form) => {
    const res = await fetch(base + url, {
      method: methode, headers: corps && !form ? { 'Content-Type': 'application/json' } : undefined,
      body: form || (corps ? JSON.stringify(corps) : undefined),
    });
    return { statut: res.status, corps: await res.json().catch(() => null) };
  };
  const ref = await appel('GET', '/parcours/referentiels');
  verifier('référentiels : journaux, nationalités, catégories', ref.corps.journaux.length > 1000 && ref.corps.nationalites.some(([c]) => c === 'FRA') && ref.corps.categories.length > 400);
  const ouvert = await appel('POST', '/parcours', { operations: ['01M'] });
  verifier('dossier ouvert sans société ni SIREN', ouvert.statut === 201, ouvert.corps);
  const id = ouvert.corps.id;
  const modele = dossier('SAS');
  let lu = (await appel('PUT', `/parcours/${id}/typologie`, modele.typologie)).corps;
  verifier('situation complète', lu.etat.questions_restantes === 0, lu.questions.filter((q) => q.valeur == null).map((q) => q.id));
  for (const [op, valeurs] of Object.entries(modele.reponses)) lu = (await appel('PUT', `/parcours/${id}/reponses`, { [op]: valeurs })).corps;
  verifier('informations complètes', lu.etat.champs_manquants.length === 0, lu.etat.champs_manquants);
  verifier('en-tête : dénomination saisie', lu.societe.denomination === 'ESSAI SAS' && lu.societe.creation === true);
  for (const p2 of lu.pieces.obligatoires) {
    const form = new FormData();
    form.append('cle', p2.cle); form.append('code', p2.code);
    form.append('fichier', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), `${p2.cle.replace(':', '-')}.pdf`);
    lu = (await appel('POST', `/parcours/${id}/pieces`, null, form)).corps;
  }
  verifier('prêt à déposer', lu.etat.pret, lu.etat);
  const depot = await appel('POST', `/parcours/${id}/deposer`);
  verifier('dépôt effectué (simulé sans identifiants INPI)', depot.statut === 200 && depot.corps.inpi_id, depot.corps);
  const f = tables.formalites.find((x) => x.id === id);
  verifier('formalité de création déposée avec ses pièces', f.payload?.typeFormalite === 'C' && f.payload.content.piecesJointes.length === lu.pieces.obligatoires.length);
  instance.close();

  console.log(`\n${ok} vérification(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
})();
