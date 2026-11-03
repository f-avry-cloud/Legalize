'use strict';

/**
 * Création de SAS présidée par une personne morale, avec des bénéficiaires
 * effectifs détenant directement et indirectement : forme de la liasse et
 * contrôle avant l'envoi. Base en mémoire, guichet simulé : aucun appel à
 * l'INPI. Personnes et sociétés fictives.
 *
 * Non-régression du dossier LGZ-2026-00052, refusé par le guichet :
 *   pouvoirs[0].entreprise.pays « Choisissez un code pays valide »,
 *   pouvoirs[0].entreprise.formeJuridique « pas compatible avec son rôle »,
 *   beneficiairesEffectifs[i].modalite.modalitesDeControle « Choisissez un type d'origine valide ».
 *
 *   node scripts/test-president-pm-be.js
 */

process.env.MCP_GU_JETON = 'jeton-de-test-suffisamment-long-0123456789';
delete process.env.INPI_DEPOT_REEL;

require('./fake-supa');
const express = require('express');
const mcp = require('../src/connecteur/mcp');
const { construireParcours } = require('../src/inpi/payload-parcours');
const be = require('../src/inpi/controle-be');
const guichet = require('../src/inpi/guichet');

const serveur = express();
serveur.use(express.json());
serveur.use('/mcp', mcp.routeur);
serveur.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
    process.exitCode = 1;
  }
}

const ADR = { numVoie: '1', typeVoie: 'RUE', voie: 'de l’Essai', codePostal: '29000', commune: 'Quimper', codeInseeCommune: '29232' };
const PP = (nom, prenoms) => ({
  nom, prenoms, genre: '1', date_naissance: '1980-01-01', lieu_naissance: 'Quimper', code_insee_naissance: '29232',
  pays_naissance: 'FRANCE', nationalite: 'Française', forme_sociale: '0', adresse: ADR,
});
const HOLDING = { denomination: 'HOLDING ESSAI', siren: '552100554', forme_juridique_code: '5710', greffe: 'Quimper', adresse: ADR };

/** Le cas du dossier : 49 % direct ; deux fois 25,50 % par la holding ; capital et votes ; pleine propriété. */
const DIRECT_49 = { capital: { direct: { pleine_propriete: 49 } }, votes: { direct: { pleine_propriete: 49 } } };
const INDIRECT_2550 = { capital: { indirect_personnes_morales: { pleine_propriete: 25.5 } }, votes: { indirect_personnes_morales: { pleine_propriete: 25.5 } } };

/** Les modalités telles qu'envoyées dans le dossier refusé : du texte libre. */
const TEXTES_REFUSES = [
  'Détention directe de 49 % du capital et des droits de vote, en pleine propriété',
  'Détention indirecte de 25,50 % du capital et des droits de vote, en pleine propriété, par l’intermédiaire de la société HOLDING ESSAI',
];

function dossier(beneficiaires) {
  return {
    operations: ['01M'],
    typologie: {
      forme_creation: 'SAS', siege_occupation: 'locaux', apports_numeraire: true, apports_nature: false,
      premiers_dirigeants_statuts: true, fonds_origine: 'creation', activite_reglementee: false,
      entrants: [{ nom: 'HOLDING ESSAI', nature: 'PM', fonction: '73' }, { nom: 'Paul ESSAI', nature: 'PP', fonction: '53' }],
    },
    reponses: {
      c_societe: { denomination: 'CREPERIE ESSAI', capital: 1000, capital_variable: false, objet: 'Restauration', duree: 99, date_cloture: '31/12', date_signature_statuts: '2026-10-15' },
      c_siege: { adresse_siege: ADR },
      c_activite: { activite_principale: 'Crêperie', categorie: '07020301', date_debut_activite: '2026-11-01', exercice_activite: 'P', emploi_salaries: false },
      c_dirigeants: { entrant_0: HOLDING, entrant_1: PP('ESSAI', 'Paul') },
      c_be: { beneficiaires },
      c_fiscal: { regime_benefices: '114', regime_tva: '311' },
      c_publication: { journal_publication: 'actu-juridique.fr', date_publication: '2026-10-20', acre: false },
    },
    pieces: [],
  };
}
const BES = [
  { ...PP('ESSAI', 'Paul'), controle: DIRECT_49 },
  { ...PP('ESSAI-UN', 'Jean'), controle: INDIRECT_2550 },
  { ...PP('ESSAI-DEUX', 'Marie'), genre: '2', controle: INDIRECT_2550 },
];

(async () => {
  console.log('\nPrésident personne morale (liasse 01M)');
  const pm = construireParcours(dossier(BES)).corps.content.personneMorale;
  const president = pm.composition.pouvoirs.find((p) => p.typeDePersonne === 'ENTREPRISE');
  verifier('pouvoir PM : rôle 73 (président de SAS), typeDePersonne ENTREPRISE', president?.roleEntreprise === '73' && president.entreprise.roleEntreprise === '73', president);
  verifier('pays : code du référentiel « FRA », pas le libellé « FRANCE »', president.entreprise.pays === 'FRA', president.entreprise);
  verifier('forme juridique : code 5710, SIREN, greffe en majuscules', president.entreprise.formeJuridique === '5710'
    && president.entreprise.siren === '552100554' && president.entreprise.lieuRegistre === 'QUIMPER', president.entreprise);
  verifier('adresse de la personne morale transmise (adresseEntreprise)', president.adresseEntreprise?.codePostal === '29000' && president.adresseEntreprise.codePays === 'FRA', president.adresseEntreprise);
  verifier('aucune personne physique dans le pouvoir PM', !president.individu, president);

  console.log('\nBénéficiaires effectifs : modalite au format du guichet');
  const [b1, b2, b3] = pm.beneficiairesEffectifs.map((b) => b.modalite);
  verifier('49 % direct, capital et votes, pleine propriété', b1.detentionPartDirecte === true && b1.partsDirectesPleinePropriete === 49 && b1.detentionPartTotale === 49
    && b1.detentionVoteDirecte === true && b1.voteDirectePleinePropriete === 49 && b1.detentionVoteTotal === 49 && b1.detentionPartIndirecte === false, b1);
  verifier('49 % : plus de 25 % du capital et des votes, code « 1 »', b1.detention25pCapital && b1.detention25pDroitVote && JSON.stringify(b1.modalitesDeControle) === '["1"]', b1);
  verifier('25,50 % indirect par une personne morale, capital et votes', b2.detentionPartIndirecte === true && b2.detentionCapitalIndirectesPersonnesMorales === true
    && b2.partsIndirectesPersonnesMorales === 25.5 && b2.partsIndirectesPmoralesPleinePropriete === 25.5 && b2.detentionPartTotale === 25.5
    && b2.detentionVoteIndirecte === true && b2.detentionVoteIndirectePersonnesMorales === true && b2.voteIndirectePmoralesPleinePropriete === 25.5
    && b2.detentionVoteTotal === 25.5 && b2.detentionPartDirecte === false, b2);
  verifier('25,50 % : plus de 25 %, code « 1 »', b2.detention25pCapital && b2.detention25pDroitVote && JSON.stringify(b2.modalitesDeControle) === '["1"]', b2);
  verifier('troisième bénéficiaire identique au deuxième', JSON.stringify(b3) === JSON.stringify(b2));
  verifier('codes de modalitesDeControle tous du référentiel', [b1, b2, b3].every((m) => m.modalitesDeControle.every((c) => be.CODES_MODALITES[c])));
  verifier('autres champs à 0 / false (comme une création validée par le portail)', b1.partsDirectesNuePropriete === 0 && b1.voteDirecteUsufruit === 0
    && b1.vocationTitulaireDirectePleinePropriete === 0 && b1.detentionAutresMoyensControle === false && b1.beneficiaireRepresentantLegal === false, b1);
  const exemplePortail = be.modaliteInpi({ capital: { direct: { pleine_propriete: 99.99 } }, votes: { direct: { pleine_propriete: 99.99 } } });
  verifier('exemple du portail (99,99 % direct) reproduit', exemplePortail.detentionPartDirecte && exemplePortail.partsDirectesPleinePropriete === 99.99
    && exemplePortail.detentionPartTotale === 99.99 && exemplePortail.detentionVoteDirecte && exemplePortail.voteDirectePleinePropriete === 99.99
    && exemplePortail.detentionVoteTotal === 99.99 && exemplePortail.detention25pCapital && exemplePortail.detention25pDroitVote
    && JSON.stringify(exemplePortail.modalitesDeControle) === '["1"]', exemplePortail);
  const autres = be.modaliteInpi({ autres: { pouvoir_nomination: true, representant_legal: true } });
  verifier('autres moyens de contrôle : codes 5 et 0, drapeaux correspondants', JSON.stringify(autres.modalitesDeControle) === '["5","0"]'
    && autres.detentionPouvoirNommageMembresConseilAdmin && autres.beneficiaireRepresentantLegal && !autres.detention25pCapital, autres);
  const ancien = construireParcours(dossier([{ ...PP('ESSAI', 'Paul'), modalites: ['1', 'x'], pourcentage_capital: 100, pourcentage_votes: 100 }])).corps
    .content.personneMorale.beneficiairesEffectifs[0].modalite;
  verifier('saisie par codes (écran Legalize) : seuls les codes du référentiel partent', JSON.stringify(ancien.modalitesDeControle) === '["1"]', ancien);

  console.log('\nContrôle de la saisie');
  const err = (c) => be.erreursControle(c);
  verifier('saisie du dossier valable', [DIRECT_49, INDIRECT_2550].every((c) => !err(c).length));
  verifier('pourcentage hors bornes refusé', err({ capital: { direct: { pleine_propriete: 120 } } }).some((e) => /0 à 100/.test(e)));
  verifier('total de détention supérieur à 100 % refusé', err({ capital: { direct: { pleine_propriete: 60 }, indirect_personnes_morales: { pleine_propriete: 50 } } }).some((e) => /dépasse 100/.test(e)));
  verifier('usufruit du capital refusé (le guichet ne le connaît que pour les votes)', err({ capital: { direct: { usufruit: 30 } } }).some((e) => /droit inconnu/.test(e)));
  verifier('détention inconnue refusée', err({ capital: { via_holding: { pleine_propriete: 30 } } }).some((e) => /détention inconnue/.test(e)));
  verifier('25 % tout juste, sans autre critère : pas bénéficiaire effectif', err({ capital: { direct: { pleine_propriete: 25 } } }).some((e) => /aucun critère/.test(e)));
  verifier('représentant légal à défaut : accepté', !err({ autres: { representant_legal: true } }).length);

  console.log('\nNon-régression LGZ-2026-00052 (connecteur)');
  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}`;
  let n = 0;
  const outil = async (name, args) => {
    const res = await fetch(`${base}/mcp/${process.env.MCP_GU_JETON}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
    });
    const r = (await res.json()).result;
    return { erreur: Boolean(r.isError), texte: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  let deposes = 0;
  guichet.deposer = async () => { deposes += 1; return { simule: true, inpi_id: 'X', numero_liasse: 'L', montant: 0, evenements: ['01M'] }; };

  const refuse = dossier([{ ...PP('ESSAI', 'Paul'), modalites: TEXTES_REFUSES[0] }, { ...PP('ESSAI-UN', 'Jean'), modalites: TEXTES_REFUSES[1] }]);
  refuse.reponses.c_dirigeants.entrant_0 = { ...HOLDING, forme_juridique_code: 'SAS' };
  const ouv = await outil('ouvrir_depot_pieces', { operations: refuse.operations, typologie: refuse.typologie, reponses: refuse.reponses });
  const ref = ouv.json.dossier.reference;
  const ctl = await outil('controler_formalite', { reference: ref });
  verifier('modalités en texte libre : bloquant explicite, par bénéficiaire', ctl.json.pret === false
    && ctl.json.bloquants.filter((b) => /modalités de contrôle en texte libre/.test(b)).length === 1
    && ctl.json.bloquants.some((b) => /Paul ESSAI.*texte libre/.test(b) && /Jean ESSAI-UN.*texte libre/.test(b)), ctl.json.bloquants);
  verifier('forme juridique en libellé (« SAS ») : bloquant, code attendu indiqué', ctl.json.bloquants.some((b) => /forme juridique : code « SAS » inconnu.*5710/.test(b)), ctl.json.bloquants);
  const enr = await outil('enregistrer_formalite', { reference: ref, confirmation_avocat: true });
  verifier('rien n’est envoyé au guichet', enr.erreur && deposes === 0, enr.texte);

  const ex = await outil('exigences_formalite', { operations: ['01M'], typologie: refuse.typologie });
  const champBe = ex.json.champs.find((g) => g.groupe === 'c_be').champs[0];
  const champPm = ex.json.champs.find((g) => g.groupe === 'c_dirigeants').champs.find((c) => c.type === 'personne_morale');
  verifier('exigences : format « controle » et valeurs admises des bénéficiaires exposés', /"controle"/.test(champBe.format)
    && champBe.valeurs_admises?.controle?.droits_votes?.includes('usufruit') && champBe.valeurs_admises.modalitesDeControle.some(([c]) => c === '1'), champBe);
  verifier('exigences : codes de forme juridique exposés pour une personne morale', /5710 SAS/.test(champPm.valeurs_admises?.forme_juridique_code || ''), champPm);

  const corrige = await outil('renseigner_formalite', { reference: ref, reponses: {
    c_dirigeants: { entrant_0: HOLDING },
    c_be: { beneficiaires: BES },
  } });
  const ctl2 = await outil('controler_formalite', { reference: ref });
  verifier('saisie structurée : plus de bloquant sur les bénéficiaires ni la forme juridique', !corrige.erreur
    && !ctl2.json.bloquants.some((b) => /contrôle|modalités|forme juridique/.test(b)), ctl2.json.bloquants);
  const incoherent = await outil('renseigner_formalite', { reference: ref, reponses: { c_be: { beneficiaires: [{ ...BES[0], controle: { capital: { direct: { pleine_propriete: 10 } } } }] } } });
  verifier('bénéficiaire sans critère : bloquant explicite', incoherent.json.etat.champs_manquants.some((m) => /aucun critère de bénéficiaire effectif/.test(m)), incoherent.json.etat.champs_manquants);

  instance.close();
  console.log(`\n${ok} vérification(s) réussie(s)${process.exitCode ? ', des échecs' : ''}.`);
})().catch((e) => { console.error(e); process.exit(1); });
