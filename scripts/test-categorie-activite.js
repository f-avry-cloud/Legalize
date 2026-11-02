'use strict';

/**
 * Catégorie d'activité d'une création (01M) et des opérations qui déclarent
 * une activité (54PMF, 61PMF) : lecture de la nomenclature du guichet,
 * report dans la liasse, contrôle avant l'envoi. Base en mémoire, guichet
 * simulé : aucun appel à l'INPI. Les personnes sont fictives.
 *
 * Non-régression du dossier LGZ-2026-00052 : quatre valeurs, toutes
 * acceptées et marquées « rempli », toutes absentes de la liasse, refusée
 * par le guichet (« categorisationActivite1 : Veuillez renseigner ce champ »).
 *
 *   node scripts/test-categorie-activite.js
 */

process.env.MCP_GU_JETON = 'jeton-de-test-suffisamment-long-0123456789';
delete process.env.INPI_DEPOT_REEL;

const { tables } = require('./fake-supa');
const express = require('express');
const mcp = require('../src/connecteur/mcp');
const { construireParcours } = require('../src/inpi/payload-parcours');
const creation = require('../src/inpi/parcours-creation');
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

/** Les quatre valeurs essayées sur le dossier LGZ-2026-00052. */
const ESSAIS = [
  'Restauration traditionnelle',
  'crêperie',
  '07020301',
  { code: '07020301', categorisationActivite1: '07', categorisationActivite2: '02', categorisationActivite3: '03', categorisationActivite4: '01', formeExercice: 'COMMERCIALE' },
];

const ADR = { numVoie: '1', typeVoie: 'RUE', voie: 'de l’Essai', codePostal: '29000', commune: 'Quimper', codeInseeCommune: '29232' };
const PP = (nom, prenoms) => ({
  nom, prenoms, genre: '2', date_naissance: '1985-01-01', lieu_naissance: 'Quimper', code_insee_naissance: '29232',
  pays_naissance: 'FRANCE', nationalite: 'Française', forme_sociale: '1', adresse: ADR,
});

/** Une création de SAS de restauration, complète hormis la catégorie. */
function dossier(categorie) {
  return {
    operations: ['01M'],
    typologie: {
      forme_creation: 'SAS', siege_occupation: 'locaux', apports_numeraire: true, apports_nature: false,
      premiers_dirigeants_statuts: true, fonds_origine: 'creation', activite_reglementee: false,
      entrants: [{ nom: 'Anne ESSAI', nature: 'PP', fonction: '73' }],
    },
    reponses: {
      c_societe: { denomination: 'CREPERIE ESSAI', capital: 1000, objet: 'Restauration', duree: 99, date_cloture: '31/12', date_signature_statuts: '2026-10-15' },
      c_siege: { adresse_siege: ADR },
      c_activite: { activite_principale: 'Crêperie, restauration sur place', categorie, date_debut_activite: '2026-11-01', exercice_activite: 'P', emploi_salaries: false },
      c_dirigeants: { entrant_0: PP('ESSAI', 'Anne') },
      c_be: { beneficiaires: [{ ...PP('ESSAI', 'Anne'), modalites: ['3', '1'], pourcentage_capital: 100, pourcentage_votes: 100 }] },
      c_fiscal: { regime_benefices: '114', regime_tva: '311' },
      c_publication: { journal_publication: 'actu-juridique.fr', date_publication: '2026-10-20', acre: false },
    },
    pieces: [],
  };
}
const activite = (d) => construireParcours(d).corps.content.personneMorale.etablissementPrincipal.activites[0];
const refus = (fn) => { try { fn(); return null; } catch (e) { return e; } };

(async () => {
  console.log('\nNomenclature');
  verifier('nomenclature embarquée et datée', /category_activities.*\d{4}-\d{2}-\d{2}/.test(creation.VERSION_CATEGORIES), creation.VERSION_CATEGORIES);
  const feuilles = creation.feuillesCategories();
  verifier('feuilles à deux, trois ou quatre niveaux, codes à deux chiffres', feuilles.length > 500 && feuilles.every((f) => /^\d{2}(-\d{2}){1,3}$/.test(f.code)));

  console.log('\nLecture de la catégorie');
  const attendu = '07-02-03-01';
  for (const v of ['07-02-03-01', '07020301', '07 02 03 01', { categorisationActivite1: '07', categorisationActivite2: '02', categorisationActivite3: '03', categorisationActivite4: '01' }, '{"code":"07020301"}']) {
    const r = creation.resoudreCategorie(v);
    verifier(`${JSON.stringify(v)} → ${attendu}`, r.statut === 'resolue' && r.categorie.code === attendu, r);
  }
  const cat = creation.resoudreCategorie('07020301').categorie;
  verifier('catégorie résolue : quatre codes, libellés et forme d’exercice', JSON.stringify(cat.codes) === '["07","02","03","01"]'
    && cat.libelles.length === 4 && /Restauration/.test(cat.chemin) && cat.forme_exercice === 'COMMERCIALE', cat);
  const courte = feuilles.find((f) => f.code.split('-').length === 2);
  verifier('« 00 » pour un niveau absent', creation.resoudreCategorie(`${courte.code.replace('-', '')}0000`).categorie?.code === courte.code, courte);
  const inter = creation.resoudreCategorie('07-02');
  verifier('niveau intermédiaire : candidates, aucune retenue', inter.statut === 'candidats' && inter.candidats.every((c) => c.code.startsWith('07-02-')), inter);
  verifier('recherche insensible aux accents', creation.resoudreCategorie('hôtellerie').total === creation.resoudreCategorie('Hotellerie').total && creation.resoudreCategorie('hôtellerie').total > 0);
  verifier('code absent de la nomenclature : inconnu', creation.resoudreCategorie('99999999').statut === 'inconnue');
  const contradictoire = creation.resoudreCategorie({ code: '07020302', categorisationActivite1: '07', categorisationActivite2: '02', categorisationActivite3: '03', categorisationActivite4: '01' });
  verifier('code et niveaux contradictoires : refusés', contradictoire.statut === 'inconnue' && /même catégorie/.test(contradictoire.motif), contradictoire);
  const terme = creation.resoudreCategorie('restaurant');
  verifier('terme de recherche : candidates avec codes et libellés des niveaux, aucune retenue',
    terme.statut === 'candidats' && terme.candidats.some((c) => c.code === attendu) && terme.candidats.every((c) => c.codes.length && c.libelles.length), terme);

  console.log('\nLiasse 01M : activites[0] au format du guichet');
  const a = activite(dossier('07-02-03-01'));
  verifier('categorisationActivite1…4 = 07 / 02 / 03 / 01, en chaînes de deux caractères',
    a.categorisationActivite1 === '07' && a.categorisationActivite2 === '02' && a.categorisationActivite3 === '03' && a.categorisationActivite4 === '01', a);
  verifier('formeExercice déduite de la catégorie : COMMERCIALE', a.formeExercice === 'COMMERCIALE', a);
  verifier('formeExerciceActivitePrincipale assortie', construireParcours(dossier('07-02-03-01')).corps.content.formeExerciceActivitePrincipale === 'COMMERCIALE');
  const artisanale = feuilles.find((f) => f.forme_exercice === 'ARTISANALE');
  verifier('catégorie artisanale : formeExercice ARTISANALE', activite(dossier(artisanale.code)).formeExercice === 'ARTISANALE', artisanale);
  const courteLiasse = activite(dossier(courte.code));
  verifier('catégorie à deux niveaux : seuls les niveaux existants sont transmis', courteLiasse.categorisationActivite2 && !courteLiasse.categorisationActivite3, courteLiasse);

  console.log('\nNon-régression LGZ-2026-00052 : les quatre valeurs essayées');
  for (const v of ESSAIS) {
    const r = creation.resoudreCategorie(v);
    const e = refus(() => activite(dossier(v)));
    if (r.statut === 'resolue') {
      const x = activite(dossier(v));
      verifier(`${JSON.stringify(v).slice(0, 40)} : reconnue, reportée dans la liasse`,
        [1, 2, 3, 4].map((i) => x[`categorisationActivite${i}`]).join('-') === attendu && x.formeExercice === 'COMMERCIALE', x);
    } else {
      verifier(`${JSON.stringify(v)} : liasse refusée en clair (422), pas de catégorie omise en silence`,
        e?.status === 422 && /Catégorie d’activité.*non reconnue/.test(e.message), e?.message);
    }
  }
  verifier('« 07020301 » et l’objet du guichet sont reconnus', creation.resoudreCategorie(ESSAIS[2]).statut === 'resolue' && creation.resoudreCategorie(ESSAIS[3]).statut === 'resolue');
  verifier('« Restauration traditionnelle » : candidates, dont la restauration commerciale', creation.resoudreCategorie(ESSAIS[0]).candidats?.some((c) => c.code === attendu));

  console.log('\nAutres opérations qui déclarent une activité');
  const modif = (op, r) => ({
    operations: [op], typologie: { fonds_origine: 'creation' }, reponses: { commun: { date_decision: '2026-10-01' }, [op]: r }, pieces: [],
    fiche: { brut: { formality: { content: { personneMorale: { etablissementPrincipal: { activites: [{ categorisationActivite1: '01', categorisationActivite2: '02', categorisationActivite3: '03', categorisationActivite4: '04', formeExercice: 'ACTIF_AGRICOLE' }] } } } } } },
  });
  for (const [op, r] of [['54PMF', { activite: 'Crêperie', adresse: ADR, date_ouverture: '2026-10-01' }], ['61PMF', { activite: 'Crêperie', date_debut: '2026-10-01' }]]) {
    const e = refus(() => construireParcours(modif(op, { ...r, categorie: 'crêperie' })));
    verifier(`${op} : catégorie non reconnue, liasse refusée en clair`, e?.status === 422 && /non reconnue/.test(e.message), e?.message);
    let liasse = null;
    try { liasse = construireParcours(modif(op, { ...r, categorie: '07020301' })).corps; } catch (err) { liasse = { erreur: err.message }; }
    const json = JSON.stringify(liasse);
    verifier(`${op} : catégorie « 07020301 » reportée en quatre niveaux`, /"categorisationActivite1":"07","categorisationActivite2":"02","categorisationActivite3":"03","categorisationActivite4":"01"/.test(json)
      || /"categorisationActivite1":"07"[^}]*"categorisationActivite4":"01"/.test(json), json.slice(0, 300));
  }

  console.log('\nConnecteur : dossier, contrôle, enregistrement');
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
  const champCat = (v) => v.champs.find((g) => g.groupe === 'c_activite').champs.find((c) => c.name === 'categorie');
  let deposes = 0;
  guichet.deposer = async () => { deposes += 1; return { simule: true, inpi_id: 'X', numero_liasse: 'L', montant: 0, evenements: ['01M'] }; };

  const d = dossier(ESSAIS[1]);
  const ouv = await outil('ouvrir_depot_pieces', { operations: d.operations, typologie: d.typologie, reponses: d.reponses });
  const ref = ouv.json.dossier.reference;
  for (const v of ESSAIS) {
    const r = await outil('renseigner_formalite', { reference: ref, reponses: { c_activite: { categorie: v } } });
    const c = champCat(r.json);
    const reconnue = creation.resoudreCategorie(v).statut === 'resolue';
    if (reconnue) {
      verifier(`${JSON.stringify(v).slice(0, 40)} : rangée sous son code, affichée en clair`, c.rempli && c.valeur === attendu
        && c.categorie_resolue?.code === attendu && /Restauration/.test(c.categorie_resolue.chemin) && c.categorie_resolue.forme_exercice === 'COMMERCIALE', c);
    } else {
      verifier(`${JSON.stringify(v)} : pas « rempli », motif donné`, c.rempli === false && c.manque?.some((m) => /catégorie non reconnue/.test(m)), c);
      const ctl = await outil('controler_formalite', { reference: ref });
      verifier(`${JSON.stringify(v)} : contrôle non prêt, bloquant explicite`, ctl.json.pret === false
        && ctl.json.bloquants.some((b) => /Catégorie d’activité.*catégorie non reconnue/.test(b)), ctl.json.bloquants);
    }
  }
  verifier('terme de recherche : candidates rendues à l’assistant',
    champCat((await outil('renseigner_formalite', { reference: ref, reponses: { c_activite: { categorie: 'restaurant' } } })).json).categories_candidates?.some((c) => c.code === attendu));
  const enr = await outil('enregistrer_formalite', { reference: ref, confirmation_avocat: true });
  verifier('catégorie non résolue : rien n’est envoyé au guichet', enr.erreur && deposes === 0, enr.texte);

  const f = tables.formalites.find((x) => x.reference === ref);
  await outil('renseigner_formalite', { reference: ref, reponses: { c_activite: { categorie: '07020301' } } });
  verifier('catégorie résolue conservée au dossier (codes, libellés, forme d’exercice, version de la nomenclature)',
    f.reponses._categorie?.['c_activite.categorie']?.codes?.join('') === '07020301' && f.reponses._categorie['c_activite.categorie'].nomenclature === creation.VERSION_CATEGORIES,
    f.reponses._categorie);
  verifier('choix journalisé', tables.formalite_evenements.some((e) => e.formalite_id === f.id && /Catégorie d’activité : 07-02-03-01/.test(e.message)));

  console.log('\nValeurs par défaut et champs codés');
  const sansDefauts = dossier('07020301');
  // Fourni par l'avocat dans le dossier de référence ; ici laissé au défaut, comme dans LGZ-2026-00052.
  delete sansDefauts.reponses.c_activite.exercice_activite;
  delete sansDefauts.reponses.c_activite.emploi_salaries;
  delete sansDefauts.reponses.c_fiscal;
  delete sansDefauts.reponses.c_publication.acre;
  const o2 = await outil('ouvrir_depot_pieces', { operations: sansDefauts.operations, typologie: sansDefauts.typologie, reponses: sansDefauts.reponses });
  const aConf = o2.json.dossier.champs.flatMap((g) => g.champs).filter((c) => c.a_confirmer).map((c) => c.name).sort();
  verifier('défauts non fournis : « à confirmer », pas « remplis »', JSON.stringify(aConf) === JSON.stringify(['acre', 'capital_variable', 'emploi_salaries', 'exercice_activite', 'regime_benefices', 'regime_tva']), aConf);
  const ctl2 = await outil('controler_formalite', { reference: o2.json.dossier.reference });
  verifier('contrôle : un bloquant par défaut à confirmer', ctl2.json.bloquants.filter((b) => /par défaut à confirmer/.test(b)).length === 6, ctl2.json.bloquants);
  const conf = await outil('renseigner_formalite', { reference: o2.json.dossier.reference,
    reponses: { c_societe: { capital_variable: false }, c_activite: { exercice_activite: 'P', emploi_salaries: false }, c_fiscal: { regime_benefices: '114', regime_tva: '311' }, c_publication: { acre: false } } });
  verifier('défauts confirmés par l’avocat : plus rien à confirmer', !conf.json.champs.flatMap((g) => g.champs).some((c) => c.a_confirmer));

  const codes = await outil('renseigner_formalite', { reference: o2.json.dossier.reference,
    reponses: { c_dirigeants: { entrant_0: { ...PP('ESSAI', 'Anne'), forme_sociale: 'salarié assimilé', nationalite: 'Bretonne' } } } });
  const dir = codes.json.champs.find((g) => g.groupe === 'c_dirigeants').champs[0];
  verifier('affiliation sociale en texte libre : refusée, codes admis indiqués', !dir.rempli && dir.manque.some((m) => /affiliation sociale \(code attendu/.test(m))
    && dir.valeurs_admises?.forme_sociale?.some(([c]) => c === '3'), dir);
  verifier('nationalité hors référentiel : refusée', dir.manque.some((m) => /nationalité \(absente du référentiel/.test(m)), dir.manque);

  instance.close();
  console.log(`\n${ok} vérification(s) réussie(s)${process.exitCode ? ', des échecs' : ''}.`);
})().catch((e) => { console.error(e); process.exit(1); });
