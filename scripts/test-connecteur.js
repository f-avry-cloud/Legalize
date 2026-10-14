'use strict';

/**
 * Connecteur « Guichet unique » (Claude hors de l'application), sur une base
 * en mémoire et un guichet simulé : protocole MCP, outils, lien de dépôt des
 * pièces, garde-fous (confirmation de l'avocat, dossiers de l'application
 * intouchables), onglet « Suivi Formalités AI ».
 *
 *   node scripts/test-connecteur.js
 */

process.env.MCP_GU_JETON = 'jeton-de-test-suffisamment-long-0123456789';
delete process.env.INPI_DEPOT_REEL;

const fs = require('fs');
const path = require('path');
const { tables, fichiers, faux } = require('./fake-supa');
const express = require('express');

const mcp = require('../src/connecteur/mcp');
const depot = require('../src/connecteur/depot');
const { echeanceDe, empreinte } = require('../src/connecteur/service');
const routes = require('../src/routes');

const serveur = express();
serveur.use(express.json());
serveur.use('/mcp', mcp.routeur);
serveur.use('/depot', depot.routeur);
serveur.use('/api', routes);
serveur.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

const PDF = fs.readFileSync(path.join(__dirname, 'fixtures/piece-test.pdf'));

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 700)}` : ''}`);
    process.exitCode = 1;
  }
}

(async () => {
  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}`;
  const JETON = process.env.MCP_GU_JETON;
  const http = async (methode, url, corps) => {
    const res = await fetch(base + url, {
      method: methode, headers: corps ? { 'Content-Type': 'application/json' } : undefined, body: corps ? JSON.stringify(corps) : undefined,
    });
    const texte = await res.text();
    let json = null;
    try { json = JSON.parse(texte); } catch (e) { /* page HTML */ }
    return { statut: res.status, corps: json, texte };
  };
  let n = 0;
  const rpc = (method, params) => http('POST', `/mcp/${JETON}`, { jsonrpc: '2.0', id: ++n, method, params });
  const outil = async (name, args) => {
    const r = await rpc('tools/call', { name, arguments: args });
    const res = r.corps.result;
    return { erreur: Boolean(res.isError), texte: res.content[0].text, json: res.isError ? null : JSON.parse(res.content[0].text) };
  };

  console.log('\nProtocole MCP');
  verifier('adresse sans le bon jeton : introuvable', (await http('POST', '/mcp/mauvais-jeton', { jsonrpc: '2.0', id: 1, method: 'ping' })).statut === 404);
  process.env.MCP_GU_JETON = '';
  const nonConfigure = await http('POST', `/mcp/${JETON}`, { jsonrpc: '2.0', id: 1, method: 'ping' });
  verifier('jeton absent de Vercel : « connecteur non configuré » (503)', nonConfigure.statut === 503 && /non configuré/.test(nonConfigure.corps.error.message), nonConfigure.corps);
  process.env.MCP_GU_JETON = JETON;
  verifier('GET refusé (pas de flux serveur)', (await http('GET', `/mcp/${JETON}`)).statut === 405);
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  verifier('initialize : version du client reprise, outils annoncés, consignes jointes',
    init.corps.result.protocolVersion === '2025-03-26' && init.corps.result.capabilities.tools && /confirmation_avocat/.test(init.corps.result.instructions), init.corps);
  const notif = await http('POST', `/mcp/${JETON}`, { jsonrpc: '2.0', method: 'notifications/initialized' });
  verifier('notification : 202 sans corps', notif.statut === 202);
  const liste = await rpc('tools/list', {});
  const noms = liste.corps.result.tools.map((t) => t.name);
  verifier('quatorze outils, aucun ne signe ni ne paie', noms.length === 14 && !noms.some((x) => /sign|pay/i.test(x)), noms);
  verifier('outil inconnu : erreur JSON-RPC', (await rpc('tools/call', { name: 'payer', arguments: {} })).corps.error?.code === -32602);
  verifier('méthode inconnue : erreur JSON-RPC', (await rpc('resources/read', {})).corps.error?.code === -32601);

  console.log('\nOutils de préparation');
  const exig = await outil('exigences_formalite', { operations: ['35M'], siren: '552100554' });
  verifier('exigences 35M : questions entrants / sortants, PV obligatoire',
    exig.json.questions.some((qq) => qq.id === 'entrants') && exig.json.questions.some((qq) => qq.id === 'sortants')
    && exig.json.pieces.obligatoires.some((p) => p.code === 'PJ_54'), exig.json.questions);
  verifier('mode simulation signalé', exig.json.guichet_simulation === true && Boolean(exig.json.motif_simulation));
  const exig2 = await outil('exigences_formalite', { operations: ['35M'], siren: '552100554', typologie: { entrants: [{ nom: 'Claire MARTIN', nature: 'PP', fonction: 'dirigeant' }] } });
  verifier('les pièces suivent la qualification (identité de la personne nommée)', exig2.json.pieces.obligatoires.some((p) => p.code === 'PJ_11' && p.personne === 'Claire MARTIN'), exig2.json.pieces.obligatoires);
  verifier('opération inconnue refusée en clair', (await outil('exigences_formalite', { operations: ['99Z'] })).erreur);

  console.log('\nÉchéance');
  verifier('un mois de la décision, de quantième à quantième (31/01 → 28/02)', echeanceDe(['10M'], { commun: { date_decision: '2026-01-31' } }).limite === '2026-02-28');
  const passe = echeanceDe(['10M'], { commun: { date_decision: '2026-01-01' } }, new Date('2026-03-01T10:00:00Z'));
  verifier('délai dépassé', passe.etat === 'depassee' && passe.jours_restants < 0, passe);
  verifier('création : 15 jours du début d’activité', echeanceDe(['01M'], { c_societe: { date_debut_activite: '2026-10-01' } }).limite === '2026-10-16');
  verifier('sans date : échéance inconnue', echeanceDe(['10M'], {}).connue === false);

  console.log('\nOuverture du dossier et lien de dépôt');
  const ouv = await outil('ouvrir_depot_pieces', {
    siren: '552100554', operations: ['10M'],
    reponses: { commun: { date_decision: '2026-10-01' }, '10M': { nouvelle_denomination: 'NOUVEAU NOM' } },
  });
  verifier('dossier ouvert, lien de dépôt rendu', !ouv.erreur && /\/depot\/[\w-]{30,}$/.test(ouv.json.lien_depot), ouv.texte);
  const ref = ouv.json.dossier.reference;
  const jeton = ouv.json.lien_depot.split('/').pop();
  const f = tables.formalites.find((x) => x.reference === ref);
  verifier('origine « assistant », échéance enregistrée', f.origine === 'assistant' && f.echeance === '2026-11-01', f);
  verifier('le lien n’est conservé que sous forme d’empreinte', f.depot_jeton === empreinte(jeton) && f.depot_jeton !== jeton);

  const page = await http('GET', `/depot/${jeton}`);
  verifier('page de dépôt servie, sans référent ni indexation', page.statut === 200 && /Dépôt des pièces/.test(page.texte));
  const etat = (await http('GET', `/depot/${jeton}/etat`)).corps;
  verifier('la page liste les pièces attendues', etat.reference === ref && etat.pieces.some((p) => p.cle === 'PJ_54' && p.categorie === 'obligatoire'), etat);
  verifier('lien inconnu : introuvable', (await http('GET', '/depot/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/etat')).statut === 404);

  const deposer = async (cle, nom = `${cle}.pdf`, contenu = PDF) => {
    const t = await http('POST', `/depot/${jeton}/televersement`, { cle, nom, taille: contenu.length });
    if (t.statut !== 200) return t;
    fichiers.set(t.corps.chemin, contenu); // ce que fait le navigateur vers le stockage
    return http('POST', `/depot/${jeton}/confirmer`, { cle, chemin: t.corps.chemin, nom });
  };
  verifier('fichier autre que PDF refusé', (await http('POST', `/depot/${jeton}/televersement`, { cle: 'PJ_54', nom: 'pv.docx', taille: 10 })).statut === 422);
  verifier('fichier de plus de 10 Mo refusé', (await http('POST', `/depot/${jeton}/televersement`, { cle: 'PJ_54', nom: 'pv.pdf', taille: 11 * 1024 * 1024 })).statut === 422);
  verifier('pièce hors de la liste refusée', (await http('POST', `/depot/${jeton}/televersement`, { cle: 'PJ_999', nom: 'x.pdf', taille: 10 })).statut === 400);
  const abime = await deposer('PJ_54', 'pv-abime.pdf', Buffer.from('%PDF-1.4 tronqué'.padEnd(200, ' ')));
  verifier('PDF abîmé refusé et retiré du stockage', abime.statut === 422 && ![...fichiers.keys()].some((k) => k.includes('pv-abime')), abime.corps);
  const autre = await http('POST', `/depot/${jeton}/confirmer`, { cle: 'PJ_54', chemin: 'formalites/999/PJ_54_1_x.pdf', nom: 'x.pdf' });
  verifier('un envoi hors du dossier n’est pas inscrit', autre.statut === 400);
  const recu = await deposer('PJ_54', 'PV AGE.pdf');
  verifier('PDF reçu et rattaché à sa ligne', recu.statut === 200 && recu.corps.pieces.find((p) => p.cle === 'PJ_54').fichiers[0]?.nom === 'PV AGE.pdf', recu.corps);
  verifier('dépôt journalisé', tables.formalite_evenements.some((e) => e.formalite_id === f.id && /lien de dépôt/.test(e.message)));

  const pr = await outil('pieces_recues', { reference: ref });
  verifier('pieces_recues : PV reçu, trois pièces encore manquantes', pr.json.pieces.obligatoires.find((p) => p.cle === 'PJ_54').recue.length === 1 && pr.json.manquantes.length === 3, pr.json.manquantes);

  console.log('\nContrôles et enregistrement');
  let ctl = await outil('controler_formalite', { reference: ref });
  verifier('contrôle : bloquants nommés (pièces, donnée du registre), pas prêt',
    !ctl.json.pret && ctl.json.bloquants.some((b) => /Statuts/.test(b)) && ctl.json.bloquants.some((b) => /Sexe/.test(b)), ctl.json);
  verifier('alerte de simulation au contrôle', ctl.json.alertes.some((a) => /simulation/i.test(a)));
  verifier('enregistrement refusé sans confirmation de l’avocat', /confirmer/.test((await outil('enregistrer_formalite', { reference: ref, confirmation_avocat: false })).texte));
  const incomplet = await outil('enregistrer_formalite', { reference: ref, confirmation_avocat: true });
  verifier('enregistrement refusé tant que le dossier est incomplet', incomplet.erreur && /pas complet/.test(incomplet.texte), incomplet.texte);

  const rens = await outil('renseigner_formalite', { reference: ref, reponses: { _registre: { genre_0: '2' } } });
  verifier('renseigner_formalite complète la donnée manquante', !rens.erreur && !rens.json.etat.champs_manquants.length, rens.json?.etat);
  for (const cle of ['PJ_02', 'PJ_08', 'PJ_51']) await deposer(cle);
  ctl = await outil('controler_formalite', { reference: ref });
  verifier('dossier complet : prêt', ctl.json.pret === true && !ctl.json.bloquants.length, ctl.json);

  const enr = await outil('enregistrer_formalite', { reference: ref, confirmation_avocat: true });
  verifier('enregistré (simulé), identifiant et liasse rendus, rien de signé ni payé',
    enr.json?.enregistre && enr.json.simule && enr.json.inpi.identifiant && /signe puis paie/.test(enr.json.suite), enr.texte);
  const bis = await outil('enregistrer_formalite', { reference: ref, confirmation_avocat: true });
  verifier('second enregistrement : « déjà enregistré », pas de nouveau dépôt', bis.json?.deja_enregistre === true, bis.texte);
  verifier('lien de dépôt fermé après transmission', (await http('POST', `/depot/${jeton}/televersement`, { cle: 'PJ_54', nom: 'x.pdf', taille: 10 })).statut === 409);
  verifier('le dossier transmis ne se modifie plus', (await outil('renseigner_formalite', { reference: ref, reponses: { commun: { date_decision: '2026-10-02' } } })).erreur);

  const st = await outil('statut_formalite', { reference: ref });
  verifier('statut_formalite : statut, identifiant INPI, journal', Boolean(st.json.statut) && st.json.inpi?.identifiant && st.json.journal.length > 3, st.json);
  const lst = await outil('lister_formalites', {});
  verifier('lister_formalites : le dossier de l’assistant', lst.json.formalites.some((x) => x.reference === ref));

  console.log('\nGarde-fous');
  tables.formalites.push({ id: 500, type: 'parcours', origine: 'locale', reference: 'LGZ-2026-00500', operations: ['10M'], typologie: {}, reponses: {}, fiche: {}, statut: 'BROUILLON' });
  const app = await outil('renseigner_formalite', { reference: 'LGZ-2026-00500', reponses: { commun: { date_decision: '2026-10-01' } } });
  verifier('un dossier ouvert dans Legalize ne se modifie pas depuis le connecteur', app.erreur && /application/.test(app.texte), app.texte);
  verifier('ni ne s’enregistre depuis le connecteur', (await outil('enregistrer_formalite', { reference: 'LGZ-2026-00500', confirmation_avocat: true })).erreur);

  const ouv2 = await outil('ouvrir_depot_pieces', { siren: '552100554', operations: ['11M'] });
  const jeton2 = ouv2.json.lien_depot.split('/').pop();
  const ouv3 = await outil('ouvrir_depot_pieces', { reference: ouv2.json.dossier.reference, typologie: { siege_occupation: 'locaux', hors_ressort: false } });
  verifier('nouveau lien pour le même dossier : l’ancien ne marche plus', (await http('GET', `/depot/${jeton2}/etat`)).statut === 404
    && (await http('GET', `/depot/${ouv3.json.lien_depot.split('/').pop()}/etat`)).statut === 200);
  const f3 = tables.formalites.find((x) => x.reference === ouv2.json.dossier.reference);
  f3.depot_expire = new Date(Date.now() - 1000).toISOString();
  verifier('lien expiré : 410', (await http('GET', `/depot/${ouv3.json.lien_depot.split('/').pop()}/etat`)).statut === 410);

  const service = faux.service;
  faux.service = null;
  const sansCle = await rpc('tools/list', {});
  const outilSansCle = await rpc('tools/call', { name: 'lister_formalites', arguments: {} });
  verifier('sans clé de service : connexion possible, l’outil explique ce qui manque',
    sansCle.statut === 200 && sansCle.corps.result.tools.length === 14
    && outilSansCle.corps.result.isError && /SUPABASE_SERVICE_ROLE_KEY/.test(outilSansCle.corps.result.content[0].text), outilSansCle.corps);
  faux.service = service;

  console.log('\nOnglet « Suivi Formalités AI »');
  const ai = (await http('GET', '/api/formalites-ai')).corps;
  verifier('liste : les seuls dossiers de l’assistant', ai.formalites.length === 2 && ai.formalites.every((x) => x.reference !== 'LGZ-2026-00500'), ai.formalites.map((x) => x.reference));
  const fiche = (await http('GET', `/api/formalites-ai/${f.id}`)).corps;
  verifier('fiche : pièces, échéance, journal', fiche.reference === ref && fiche.journal.length > 3 && fiche.echeance.limite === '2026-11-01', fiche.echeance);
  verifier('un dossier de l’application n’y figure pas', (await http('GET', '/api/formalites-ai/500')).statut === 404);
  verifier('les formalités classiques n’affichent pas ceux de l’assistant',
    (await http('GET', '/api/formalites')).corps.every((x) => x.origine !== 'assistant'));
  const act = await http('POST', `/api/formalites-ai/${f.id}/actualiser`);
  verifier('actualisation auprès de l’INPI', act.statut === 200 && act.corps.synchronise === true, act.corps);

  /* -------------------------------------------------------------------
     Anomalies relevées sur le dossier réel LGZ-2026-00044 (COUVOIR JOSSET,
     MAJDIR) : justificatif disparu, pièces mal rangées, objet social absent
     du registre. Guichet simulé, aucun appel à l'API INPI de production. */
  const { resoudre } = require('../src/inpi/parcours');
  const { construireParcours } = require('../src/inpi/payload-parcours');
  const guichet = require('../src/inpi/guichet');
  const rne = require('../src/inpi/rne');

  // Fiche « COUVOIR JOSSET » : une société dirigeante (BD France) et pas d'objet au registre.
  const ficheSansObjet = JSON.parse(JSON.stringify(await rne.entreprise('552100554')));
  const pmSO = ficheSansObjet.brut.formality.content.personneMorale;
  delete pmSO.identite.description.objet;
  ficheSansObjet.objet = null;
  pmSO.composition.pouvoirs.push({ typeDePersonne: 'ENTREPRISE', roleEntreprise: '73',
    entreprise: { denomination: 'BD France', siren: '552032534', formeJuridique: '5710', lieuRegistre: 'BREST' },
    adresseEntreprise: { codePostal: '29200', commune: 'BREST', voie: 'du Port', typeVoie: 'RUE', numVoie: '1' } });
  ficheSansObjet.dirigeants = [...(ficheSansObjet.dirigeants || []), { nom_complet: 'BD France' }];

  console.log('\nAnomalie 1 — mise à jour d’un dirigeant (MAJDIR) et pièces');
  const formeClaude = { mises_a_jour: [{ dirigeant: 'BD France', changements: ['denomination'], nouvelle_denomination: 'DanHatch France' }], statuts_modifies: false };
  const rMaj = resoudre(['MAJDIR'], formeClaude, ficheSansObjet);
  const kbis = rMaj.pieces.obligatoires.find((p) => p.code === 'PJ_20' && p.personne === 'BD France');
  verifier('ligne décrite par « dirigeant » / « changements » reconnue : Kbis de BD France obligatoire', kbis?.cle === 'PJ_20:m0', rMaj.pieces);
  verifier('le champ de la société dirigeante est demandé (pré-rempli du registre)',
    rMaj.champs.some((g) => g.op === 'MAJDIR' && g.champs.some((c) => c.name === 'maj_0' && c.prerempli?.denomination === 'BD France')), rMaj.champs);
  const illisible = resoudre(['MAJDIR'], { mises_a_jour: [{ quoi: 'inconnu' }], statuts_modifies: false, manuel: { 'maj:MAJDIR': true } }, ficheSansObjet);
  verifier('manuel["maj:MAJDIR"] = true : le justificatif réapparaît, obligatoire, même après statuts_modifies',
    illisible.pieces.obligatoires.some((p) => p.cle === 'maj:MAJDIR' && p.code === 'PJ_20'), illisible.pieces);
  const sansCoche = resoudre(['MAJDIR'], { mises_a_jour: [], statuts_modifies: false }, ficheSansObjet);
  verifier('sans réponse ni coche : justificatif « à préciser »', sansCoche.pieces.a_preciser.some((p) => p.cle === 'maj:MAJDIR'));
  verifier('décoché : le justificatif à préciser sort de la liste',
    !resoudre(['MAJDIR'], { mises_a_jour: [], statuts_modifies: false, manuel: { 'maj:MAJDIR': false } }, ficheSansObjet).pieces.a_preciser.some((p) => p.cle === 'maj:MAJDIR'));
  verifier('toute pièce « à préciser » cochée devient obligatoire',
    resoudre(['35M'], { manuel: { 'personnes:35M': true } }, ficheSansObjet).pieces.obligatoires.some((p) => p.cle === 'personnes:35M'));

  const { validerTypologie } = require('../src/connecteur/service');
  const refus = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  verifier('réponse mal formée refusée en clair (motif inconnu, dirigeant absent du registre)',
    /motif/.test(refus(() => validerTypologie(['MAJDIR'], { mises_a_jour: [{ nom: 'Inconnu SA', motif: 'x' }] }, ficheSansObjet)) || '')
    && /ne figure pas parmi les dirigeants/.test(refus(() => validerTypologie(['MAJDIR'], { mises_a_jour: [{ nom: 'Zorglub', motif: 'adresse' }] }, ficheSansObjet)) || ''));
  verifier('question inconnue refusée', /n’est pas une question connue/.test(refus(() => validerTypologie(['MAJDIR'], { dirigeants: [] }, ficheSansObjet)) || ''));
  verifier('forme de Claude acceptée telle quelle', refus(() => validerTypologie(['MAJDIR'], formeClaude, ficheSansObjet)) === null);
  const exM = await outil('exigences_formalite', { operations: ['MAJDIR'], siren: '552100554' });
  verifier('chaque question donne son format', exM.json.questions.find((qq) => qq.id === 'mises_a_jour')?.format?.includes('motif'), exM.json.questions);

  // Dossier réel reconstitué : la fiche sans objet, les deux PDF rangés sous le pouvoir.
  const ouvM = await outil('ouvrir_depot_pieces', { siren: '552100554', operations: ['MAJDIR'] });
  const refM = ouvM.json.dossier.reference;
  const fM = tables.formalites.find((x) => x.reference === refM);
  fM.fiche = ficheSansObjet;
  const r2 = await outil('renseigner_formalite', { reference: refM, typologie: formeClaude, reponses: { commun: { date_decision: '2026-09-01' } } });
  verifier('dossier : Kbis de BD France exigé', r2.json.pieces.obligatoires.some((p) => p.cle === 'PJ_20:m0'), r2.json.pieces);
  const jetonM = ouvM.json.lien_depot.split('/').pop();
  const deposerM = async (corps, nom) => {
    const t = await http('POST', `/depot/${jetonM}/televersement`, { ...corps, nom, taille: PDF.length });
    if (t.statut !== 200) return t;
    fichiers.set(t.corps.chemin, PDF);
    return http('POST', `/depot/${jetonM}/confirmer`, { ...corps, chemin: t.corps.chemin, nom });
  };
  const kbisNom = 'DANF - 2026.09.23 - KBis du RCS Brest (siège).pdf';
  await deposerM({ cle: 'PJ_51' }, kbisNom);
  await deposerM({ cle: 'PJ_51' }, 'COUVOIR JOSSET - Procuration.pdf');
  const etatM = (await http('GET', `/depot/${jetonM}/etat`)).corps;
  verifier('la page propose un emplacement par pièce de la liste, plus « Autre pièce »',
    etatM.pieces.some((p) => p.cle === 'PJ_20:m0') && etatM.pieces.some((p) => p.cle === 'PJ_51') && etatM.types.some((t) => t.code === 'PJ_97'), etatM.pieces.map((p) => p.cle));
  const rec = await outil('reclasser_piece', { reference: refM, fichier: 'KBis du RCS Brest', code_pj: 'PJ_20' });
  verifier('reclasser_piece : le Kbis passe de PJ_51 à PJ_20 (ligne de BD France)',
    !rec.erreur && rec.json.pieces.obligatoires.find((p) => p.cle === 'PJ_20:m0').recue.some((x) => x.nom === kbisNom)
    && !rec.json.pieces.obligatoires.find((p) => p.cle === 'PJ_51').recue.some((x) => x.nom === kbisNom), rec.texte);
  verifier('reclassement journalisé', tables.formalite_evenements.some((e) => e.formalite_id === fM.id && /reclassée/.test(e.message)));
  const autreM = await deposerM({ code: 'PJ_97' }, 'Liste des sièges.pdf');
  verifier('« Autre pièce » : PDF d’un type choisi, hors liste', autreM.statut === 200 && autreM.corps.autres.some((x) => x.code === 'PJ_97'), autreM.corps);
  const idAutre = autreM.corps.autres.find((x) => x.code === 'PJ_97').id;
  const viaPage = await http('POST', `/depot/${jetonM}/pieces/${idAutre}/reclasser`, { cle: 'PJ_51' });
  verifier('reclasser depuis la page', viaPage.statut === 200 && viaPage.corps.pieces.find((p) => p.cle === 'PJ_51').fichiers.some((x) => x.id === idAutre), viaPage.corps);
  verifier('type inconnu refusé', (await outil('reclasser_piece', { reference: refM, fichier: String(idAutre), code_pj: 'PJ_XYZ' })).erreur);
  const ret = await outil('retirer_piece', { reference: refM, fichier: String(idAutre) });
  verifier('retirer_piece', !ret.erreur && !tables.formalite_pieces.some((x) => x.id === idAutre), ret.texte);

  console.log('\nAnomalie 2 — objet social absent du registre');
  const exO = resoudre(['MAJDIR'], formeClaude, ficheSansObjet);
  const champObjet = exO.champs.find((g) => g.op === '_registre')?.champs.find((c) => c.name === 'objet');
  verifier('objet absent du registre : demandé (groupe _registre, requis)', champObjet?.requis === true, exO.champs);
  const avecObjet = resoudre(['MAJDIR'], formeClaude, await rne.entreprise('552100554'));
  verifier('objet présent au registre : pas demandé', !(avecObjet.champs.find((g) => g.op === '_registre')?.champs || []).some((c) => c.name === 'objet'));
  verifier('demandé quelle que soit l’opération (10M, 11M, 35M, 15M)',
    ['10M', '11M', '35M', '15M'].every((op) => resoudre([op], {}, ficheSansObjet).champs.find((g) => g.op === '_registre')?.champs.some((c) => c.name === 'objet')));
  verifier('pas demandé pour une cessation (40M)', !(resoudre(['40M'], {}, ficheSansObjet).champs.find((g) => g.op === '_registre')?.champs || []).some((c) => c.name === 'objet'));
  const ctlO = await outil('controler_formalite', { reference: refM });
  verifier('controler_formalite : bloquant « objet social » avant l’enregistrement', !ctlO.json.pret && ctlO.json.bloquants.some((b) => /Objet social/.test(b)), ctlO.json.bloquants);
  const objet = 'Accouvage, sélection et commerce de volailles.';
  const rO = await outil('renseigner_formalite', { reference: refM, reponses: { _registre: { objet } } });
  verifier('objet renseigné : plus de bloquant à ce titre', !rO.json.etat.champs_manquants.some((m) => /Objet/.test(m)), rO.json.etat.champs_manquants);
  const corpsM = construireParcours({ ...fM, reponses: fM.reponses, typologie: fM.typologie, fiche: fM.fiche, pieces: [] }).corps;
  const contenu = corpsM.formality?.content || corpsM.content || corpsM.newFormality?.content || {};
  verifier('objet injecté dans le contenu envoyé au guichet', contenu.personneMorale?.identite?.description?.objet === objet, contenu.personneMorale?.identite?.description);

  console.log('\nToute donnée refusée par le guichet devient une donnée à compléter');
  const original = guichet.deposer;
  guichet.deposer = async () => { throw Object.assign(new Error('Données refusées par le guichet'), { status: 400, detail: { violations: [
    { propertyPath: 'content.personneMorale.identite.description.dateFinExistence', message: 'Ce champ est obligatoire.' },
  ] } }); };
  // Le dossier complet, pour atteindre le guichet.
  const lignesM = (await outil('pieces_recues', { reference: refM })).json.pieces.obligatoires;
  for (const l of lignesM.filter((x) => !x.recue.length)) await deposerM({ cle: l.cle }, `${l.code}.pdf`);
  await outil('renseigner_formalite', { reference: refM, reponses: { _registre: { genre_0: '2' }, MAJDIR: { maj_0: { ...rMaj.champs.find((g) => g.op === 'MAJDIR').champs[0].prerempli, denomination: 'DanHatch France' } } } });
  const ctlPret = await outil('controler_formalite', { reference: refM });
  const echec = await outil('enregistrer_formalite', { reference: refM, confirmation_avocat: true });
  guichet.deposer = original;
  verifier('refus du guichet rendu en clair, avec le champ en cause', ctlPret.json.pret && echec.erreur && /dateFinExistence/.test(echec.texte), { ctl: ctlPret.json.bloquants, echec: echec.texte });
  const apresRefus = await outil('controler_formalite', { reference: refM });
  verifier('le champ refusé devient un bloquant à compléter', apresRefus.json.bloquants.some((b) => /refusée par le guichet.*dateFinExistence/.test(b)), apresRefus.json.bloquants);
  const champRejet = (await outil('renseigner_formalite', { reference: refM })).json.champs
    .find((g) => g.groupe === '_registre').champs.find((c) => /dateFinExistence/.test(c.label));
  await outil('renseigner_formalite', { reference: refM, reponses: { _registre: { [champRejet.name]: '2125-01-01' } } });
  const corpsR = construireParcours({ ...fM, pieces: [] }).corps;
  const contenuR = corpsR.formality?.content || corpsR.content || corpsR.newFormality?.content || {};
  verifier('la valeur saisie est réinjectée à l’endroit désigné par le guichet',
    contenuR.personneMorale?.identite?.description?.dateFinExistence === '2125-01-01' && contenuR.personneMorale.identite.description.objet === objet, contenuR.personneMorale?.identite?.description);
  guichet.deposer = async () => { throw Object.assign(new Error('Données refusées par le guichet'), { status: 400, detail: { violations: [
    { propertyPath: 'content.personneMorale.composition.pouvoirs[0].individu.descriptionPersonne.nomUsage', message: 'Valeur attendue.' },
  ] } }); };
  await outil('enregistrer_formalite', { reference: refM, confirmation_avocat: true });
  guichet.deposer = original;
  verifier('les refus successifs s’additionnent : le premier, déjà corrigé, reste réinjecté',
    ['dateFinExistence', 'nomUsage'].every((k) => (fM.typologie._rejets || []).some((r) => r.champ.includes(k))), fM.typologie._rejets);
  const champ2 = (await outil('renseigner_formalite', { reference: refM })).json.champs
    .find((g) => g.groupe === '_registre').champs.find((c) => /nomUsage/.test(c.label));
  verifier('libellé lisible du champ refusé', /dirigeant n° 1/.test(champ2?.label || ''), champ2);
  await outil('renseigner_formalite', { reference: refM, reponses: { _registre: { [champ2.name]: 'THOMAS' } } });
  const contenu3 = (() => { const c = construireParcours({ ...fM, pieces: [] }).corps; return c.formality?.content || c.content || c.newFormality?.content || {}; })();
  verifier('les deux valeurs partent au guichet', contenu3.personneMorale.identite.description.dateFinExistence === '2125-01-01'
    && contenu3.personneMorale.composition.pouvoirs[0].individu.descriptionPersonne.nomUsage === 'THOMAS');
  const enfin = await outil('enregistrer_formalite', { reference: refM, confirmation_avocat: true });
  verifier('dossier corrigé : enregistré (guichet simulé)', enfin.json?.enregistre === true && enfin.json.simule === true, enfin.texte);
  verifier('après le dépôt réussi, les refus sont soldés', !(fM.typologie._rejets || []).length);

  console.log('\nCouverture de tout le catalogue d’opérations');
  const moteur = require('../src/inpi/parcours');
  const { PIECES } = require('../src/inpi/referentiels');
  const toutes = Object.keys(moteur.OPERATIONS).filter((op) => !moteur.infoOperation(op)?.creation);
  const typologiePleine = {
    entrants: [{ nom: 'Claire MARTIN', nature: 'PP', fonction: 'dirigeant' }, { nom: 'HOLDING X', nature: 'PM', fonction: 'dirigeant' }],
    sortants: [{ nom: 'Léa THOMAS', motif: 'demission' }], mises_a_jour: [{ nom: 'BD France', motif: 'denomination' }],
  };
  const inconnues = [];
  const sansFormat = [];
  const sansObjet = [];
  for (const op of toutes) {
    for (const t of [{}, typologiePleine]) {
      const r = moteur.resoudre([op], t, ficheSansObjet);
      for (const p of [...r.pieces.obligatoires, ...r.pieces.a_preciser, ...r.pieces.facultatives]) if (!PIECES[p.code]) inconnues.push(`${op} ${p.code}`);
      for (const qq of r.questions) if (!['entrants', 'sortants', 'maj', 'choix'].includes(qq.type)) sansFormat.push(`${op} ${qq.id}`);
      const demande = (r.champs.find((g) => g.op === '_registre')?.champs || []).some((c) => c.name === 'objet');
      if (!demande && !['40M', '28M', '41M'].includes(op)) sansObjet.push(op);
    }
  }
  verifier(`${toutes.length} opérations : toute pièce exigée est un type reconnu par le guichet`, !inconnues.length, inconnues);
  verifier('toute question a un format documenté pour Claude', !sansFormat.length, sansFormat);
  verifier('objet absent du registre : demandé pour toute modification', !sansObjet.length, [...new Set(sansObjet)]);

  instance.close();
  console.log(`\n${ok} vérifications${process.exitCode ? ' — ÉCHECS ci-dessus' : ' — tout est vert'}`);
})().catch((e) => { console.error(e); process.exit(1); });
