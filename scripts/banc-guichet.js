'use strict';

/**
 * Banc d'essai réel : chaque scénario du parcours est construit par le
 * générateur de l'application, déposé sur le serveur de DÉMONSTRATION du
 * guichet unique, puis supprimé aussitôt. C'est la preuve que les
 * informations demandées par le parcours suffisent au serveur.
 *
 *   node scripts/banc-guichet.js                 tous les scénarios
 *   node scripts/banc-guichet.js creation-SA     un scénario (filtre sur le nom)
 *
 * Passe par la sonde de l'application déployée (environnement de
 * démonstration uniquement). Données fictives ; les modifications portent sur
 * une société de l'échantillon du serveur de démonstration.
 */

const { construireParcours } = require('../src/inpi/payload-parcours');
const { normaliserEntreprise } = require('../src/inpi/normalize');

const SONDE = process.env.SONDE_URL || 'https://legalize-rho.vercel.app/api/inpi/sonde';
const SIREN_DEMO = '794598813';

async function sonde(corps) {
  for (let i = 0; ; i += 1) {
    try {
      const r = await fetch(SONDE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corps) });
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
    }
  }
}

/* ------------------------------------------------------- données fictives */

const ADR = { numVoie: '10', typeVoie: 'RUE', voie: 'de la Paix', codePostal: '75002', commune: 'Paris', codeInseeCommune: '75102' };
// NIR fictif à la clé valide (le serveur contrôle la clé).
const PP = (nom, prenoms, extra = {}) => ({
  nom, prenoms, genre: '1', date_naissance: '1980-03-04', lieu_naissance: 'Lyon', code_insee_naissance: '69123',
  pays_naissance: 'FRANCE', nationalite: 'Française', forme_sociale: '3', numero_secu: '180036912300130',
  situation_matrimoniale: '1', adresse: { ...ADR, numVoie: '12' },
  // Travailleur non salarié : volet social.
  volet: { organisme_maladie: 'R', activite_simultanee: 'aucune' }, ...extra,
});
const PM = (nom, extra = {}) => ({ denomination: nom, siren: SIREN_DEMO, forme_juridique_code: '5710', greffe: 'Paris', adresse: ADR, ...extra });
const ROLES = { SAS: '73', SASU: '73', SARL: '30', EURL: '30', SA: '60', SNC: '28', SCI: '30', SC: '30' };

function creation(forme, sc = {}) {
  const entrants = sc.entrants || [{ nom: 'Paul MARTIN', nature: 'PP', fonction: ROLES[forme] }];
  const dirigeants = {};
  entrants.forEach((e, i) => {
    dirigeants[`entrant_${i}`] = e.nature === 'PM'
      ? PM(e.nom, e.fonction === '65' ? { representant: PP('DURAND', 'Luc') } : {})
      : PP(e.nom.split(' ').pop(), e.nom.split(' ')[0]);
  });
  return {
    endpoint: '/api/formalities',
    dossier: {
      operations: [sc.op || '01M'], reference: 'BANC', libelle: `Banc création ${forme}`,
      typologie: {
        forme_creation: forme, siege_occupation: sc.siege || 'locaux', apports_numeraire: true, apports_nature: false,
        premiers_dirigeants_statuts: true, fonds_origine: sc.fonds || 'creation', activite_reglementee: false,
        associe_unique_nature: 'PP', entrants,
      },
      reponses: {
        c_societe: { denomination: `BANC ${forme}`, capital: 1000, objet: 'Conseil en organisation des entreprises', duree: 99, date_cloture: '31/12', date_signature_statuts: '2026-09-15' },
        c_siege: { adresse_siege: ADR, ...(sc.siege === 'domiciliation' ? { domiciliataire_denomination: 'DOMICILIATION FICTIVE', domiciliataire_siren: SIREN_DEMO } : {}) },
        c_activite: { activite_principale: 'Conseil en organisation', categorie: sc.categorie || '07-04-08-02', date_debut_activite: '2026-10-01', exercice_activite: 'P',
          emploi_salaries: Boolean(sc.salaries), ...(sc.salaries ? { date_premiere_embauche: '2026-10-15', effectif_salarie: 2 } : {}) },
        c_dirigeants: dirigeants,
        c_be: { beneficiaires: [{ ...PP('MARTIN', 'Paul'), modalites: ['3', '1'], pourcentage_capital: 100, pourcentage_votes: 100, detention: 'directe' }] },
        c_fiscal: { regime_benefices: ['SCI', 'SC'].includes(forme) ? '120' : '114', regime_tva: ['SCI', 'SC'].includes(forme) ? '316' : '311' },
        c_publication: { journal_publication: sc.journal || 'actu-juridique.fr', date_publication: '2026-09-20' },
      },
      pieces: [],
    },
  };
}

function modification(ops, fiche, extra = {}) {
  return {
    endpoint: '/api/formality_updates',
    dossier: {
      operations: ops, fiche, siren: SIREN_DEMO, reference: 'BANC', libelle: `Banc ${ops.join('+')}`,
      typologie: { entrants: [{ nom: 'Claire DURAND', nature: 'PP', fonction: 'dirigeant' }], sortants: [], ...extra.t },
      reponses: {
        commun: { date_decision: '2026-09-30' },
        // Données de l'échantillon que le serveur refuse lui-même (constaté) : à compléter.
        _registre: { genre_0: '1', forme_sociale_0: '0', greffe_1: 'NANTERRE', greffe_2: 'NANTERRE',
          adresse_1: { numVoie: '2', typeVoie: 'AV', voie: 'Gambetta', codePostal: '92400', commune: 'Courbevoie' } },
        '10M': { nouvelle_denomination: 'BANC DENOMINATION' },
        '12M': { nouvel_objet: 'Conception et exploitation de logiciels' },
        '13M': { nouvelle_forme: '5599' },
        '14M': { nom_domaine: 'banc-legalize.fr' },
        '15M': { nouveau_capital: '250000' },
        '16M': { nouvelle_cloture: '30/06' },
        '17M': { associe_unique: true },
        '35M': { entrant_0: PP('DURAND', 'Claire', { genre: '2', qualite: 'Directeur général' }) },
      },
      pieces: [],
    },
  };
}

/* ---------------------------------------------------------------- matrice */

function scenarios(fiche) {
  const l = [];
  for (const f of ['SAS', 'SASU', 'SARL', 'EURL', 'SA', 'SNC', 'SCI', 'SC']) l.push([`creation-${f}`, creation(f)]);
  l.push(['creation-SAS-president-societe-DG-DGD-domicile', creation('SAS', { siege: 'domicile', entrants: [
    { nom: 'HOLDING FICTIVE', nature: 'PM', fonction: '73' }, { nom: 'Paul MARTIN', nature: 'PP', fonction: '53' }, { nom: 'Anne DURAND', nature: 'PP', fonction: '70' }] })]);
  l.push(['creation-SA-administrateurs-CAC', creation('SA', { entrants: [
    { nom: 'Paul MARTIN', nature: 'PP', fonction: '60' }, { nom: 'Anne DURAND', nature: 'PP', fonction: '65' },
    { nom: 'HOLDING FICTIVE', nature: 'PM', fonction: '65' }, { nom: 'CABINET AUDIT', nature: 'PM', fonction: '71' }, { nom: 'Jean AUDIT', nature: 'PP', fonction: '72' }] })]);
  l.push(['creation-SNC-associes', creation('SNC', { entrants: [{ nom: 'Paul MARTIN', nature: 'PP', fonction: '28' }, { nom: 'Anne DURAND', nature: 'PP', fonction: '74' }] })]);
  l.push(['creation-SARL-domiciliation-achat-salaries', creation('SARL', { siege: 'domiciliation', fonds: 'achat', salaries: true })]);
  l.push(['creation-SAS-journal-hors-referentiel', creation('SAS', { journal: 'Journal fictif du banc' })]);
  l.push(['creation-SAS-liberale-reglementee', creation('SAS', { categorie: '07-04-04-13' })]);
  l.push(['creation-SAS-sans-activite', creation('SAS', { op: '02M' })]);
  for (const ops of [['15M', '35M'], ['10M', '15M', '35M'], ['12M', '16M'], ['13M', '14M', '25M'], ['12M', '17M']]) {
    l.push([`modification-${ops.join('-')}`, modification(ops, fiche)]);
  }
  return l;
}

(async () => {
  const brut = (await sonde({ api: 'rne', chemin: `/api/companies/${SIREN_DEMO}` })).reponse;
  const fiche = { ...normaliserEntreprise(brut), brut };
  const filtre = process.argv[2] || '';
  let echecs = 0;
  for (const [nom, { endpoint, dossier }] of scenarios(fiche).filter(([n]) => n.includes(filtre))) {
    const { corps } = construireParcours(dossier);
    const r = await sonde({ methode: 'POST', chemin: endpoint, corps });
    const f = r.reponse?.formalities?.[0] || (r.ok ? r.reponse : null);
    if (r.ok && f?.id) {
      const frais = (f.carts || []).reduce((t, c) => t + (c.total || 0), 0);
      await sonde({ methode: 'DELETE', chemin: `/api/formalities/${f.id}` });
      console.log(`✓ ${nom} — ${(f.events || []).join(', ')}${frais ? ` — ${(frais / 100).toFixed(2)} €` : ''}`);
    } else {
      echecs += 1;
      console.log(`✗ ${nom} — ${r.statut}`);
      for (const v of r.reponse?.violations || []) console.log(`    ${v.propertyPath} : ${v.message}`);
      if (!r.reponse?.violations && r.message) console.log(`    ${r.message.slice(0, 300)}`);
    }
  }
  // Rien ne doit rester sur le compte de démonstration.
  const restants = (await sonde({ methode: 'GET', chemin: '/api/formalities' })).reponse || [];
  for (const x of restants) await sonde({ methode: 'DELETE', chemin: `/api/formalities/${x.id}` });
  console.log(`\n${echecs ? `${echecs} scénario(s) refusé(s).` : 'Tous les scénarios sont acceptés par le serveur.'}${restants.length ? ` ${restants.length} dossier(s) résiduel(s) supprimé(s).` : ''}`);
  process.exitCode = echecs ? 1 : 0;
})();
