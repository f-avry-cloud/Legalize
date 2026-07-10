'use strict';

/**
 * Test de bout en bout via l'API HTTP : référentiel → société → opération →
 * génération en un clic → checklist → versions/markup → comparaison → facture.
 *
 * Nécessite un accès réseau au projet Supabase. Cible :
 *   - sans argument : démarre le serveur local en mémoire (port 3999) ;
 *   - BASE_URL=https://… : teste une instance déployée.
 * Les données créées (préfixées « Smoke Test ») sont supprimées à la fin.
 */

const { extractDocxText, buildDocx } = require('../src/docx');

const BASE_URL = process.env.BASE_URL || null;
const PORT = 3999;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) failures += 1;
}

let base;
async function api(method, url, body, isForm) {
  const opts = { method, headers: {} };
  if (body && !isForm) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (body) {
    opts.body = body;
  }
  const res = await fetch(`${base}${url}`, opts);
  const json = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  return { status: res.status, json, res };
}

async function main() {
  let server = null;
  if (BASE_URL) {
    base = BASE_URL.replace(/\/$/, '');
  } else {
    const app = require('../server');
    server = app.listen(PORT);
    base = `http://localhost:${PORT}`;
  }

  const aNettoyer = { societes: [], groupes: [] };
  try {
    // Référentiel
    const ref = await api('GET', '/api/referentiel');
    check('référentiel : 5 types d’opérations', ref.json.types.length === 5);

    // Groupe + sociétés
    const groupe = (await api('POST', '/api/groupes', { nom: 'Smoke Test Groupe' })).json;
    aNettoyer.groupes.push(groupe.id);
    const holding = (await api('POST', '/api/societes', {
      groupe_id: groupe.id, denomination: 'Smoke Test Holding', forme_sociale: 'SAS',
      capital_social: 10000, nb_titres: 1000, siege_social: '1 rue du Test, 75001 Paris',
      siren: '111 222 333', rcs_ville: 'Paris', objet_social: 'la prise de participations',
    })).json;
    const fille = (await api('POST', '/api/societes', {
      groupe_id: groupe.id, denomination: 'Smoke Test Fille', forme_sociale: 'SAS',
      capital_social: 5000, nb_titres: 500, siege_social: '2 rue du Test, 75001 Paris',
      siren: '444 555 666', rcs_ville: 'Paris', objet_social: 'le conseil',
    })).json;
    aNettoyer.societes.push(holding.id, fille.id);
    check('création société', holding.id > 0 && fille.id > 0);

    await api('POST', `/api/societes/${holding.id}/dirigeants`, {
      civilite: 'M.', nom: 'Test', prenom: 'Jean', fonction: 'Président', adresse: '1 rue du Test, 75001 Paris',
    });
    await api('POST', `/api/societes/${holding.id}/associes`, {
      type: 'physique', civilite: 'M.', nom: 'Test', prenom: 'Jean', nb_titres: 1000, adresse: '1 rue du Test',
    });
    await api('POST', `/api/societes/${fille.id}/dirigeants`, { nom: 'Test', prenom: 'Jean', fonction: 'Président' });
    await api('POST', `/api/societes/${fille.id}/associes`, {
      type: 'morale', societe_liee_id: holding.id, nb_titres: 400,
    });
    await api('POST', `/api/societes/${fille.id}/associes`, {
      type: 'physique', nom: 'Minor', prenom: 'Paul', nb_titres: 100,
    });

    // Organigramme
    const orga = (await api('GET', `/api/groupes/${groupe.id}/organigramme`)).json;
    const racine = orga.racines.find((r) => r.id === holding.id);
    check('organigramme : holding racine, fille détenue à 80 %',
      racine && racine.filles.length === 1 && racine.filles[0].pourcentage === 80);

    // Opération de cession avec agrément (document conditionnel) et sans GAP
    const op = (await api('POST', '/api/operations', {
      societe_id: fille.id, type: 'cession_titres', libelle: 'Smoke Test Cession',
      variables: {
        cedant_nom: 'M. Paul Minor', cedant_adresse: '3 rue du Test',
        cessionnaire_nom: 'Smoke Test Holding', cessionnaire_adresse: '1 rue du Test',
        nb_titres_cedes: 100, prix_total: 15000, date_cession: '2026-07-20',
        clause_agrement: true, garantie_ap: false, date_agrement: '2026-07-15',
      },
    })).json;
    let detail = (await api('GET', `/api/operations/${op.id}`)).json;
    check('checklist instanciée (4 documents)', detail.documents.length === 4);
    check('documents manquants signalés', detail.manquants.length >= 2);

    // Génération en un clic
    const gen = (await api('POST', `/api/operations/${op.id}/generer`)).json;
    check('génération en un clic : 3 documents générés', gen.generes && gen.generes.length === 3);
    check('document conditionnel écarté (GAP non applicable)', gen.non_applicables.length === 1);

    detail = (await api('GET', `/api/operations/${op.id}`)).json;
    check('plus aucun document obligatoire manquant', detail.manquants.length === 0);

    const acte = detail.documents.find((d) => d.code === 'acte_cession');
    const dl = await fetch(`${base}/api/versions/${acte.versions[0].id}/download`);
    check('téléchargement d’une version', dl.status === 200);
    const texte = extractDocxText(Buffer.from(await dl.arrayBuffer()));
    check('fusion : variables substituées', texte.includes('M. Paul Minor') && texte.includes('Smoke Test Holding'));
    check('fusion : montants formatés', /15\s?000/.test(texte) && texte.includes('150 euros par titre'));
    check('fusion : bloc conditionnel agrément inclus', texte.includes('agréée par décision collective'));
    check('fusion : aucune balise résiduelle', !/\{[a-z_#/^]+\}/i.test(texte));
    check('fusion : date en toutes lettres', texte.includes('20 juillet 2026'));

    // Markup : dépôt d'une version reçue modifiée, puis comparaison
    const texteModifie = texte.replace('150 euros par titre', '155 euros par titre') + '\nClause ajoutée par la partie adverse.';
    const recu = buildDocx(texteModifie.split('\n').map((t) => ({ style: 'p', text: t })));
    const form = new FormData();
    form.append('fichier', new Blob([recu]), 'markup.docx');
    form.append('source', 'recu');
    const up = await api('POST', `/api/documents/${acte.id}/versions`, form, true);
    check('dépôt version reçue (markup)', up.status === 201 && up.json.source === 'recu');

    const cmp = (await api('GET', `/api/documents/${acte.id}/compare`)).json;
    check('comparaison : modifications détectées', cmp.stats.ajouts > 0 && cmp.stats.suppressions > 0);
    check('comparaison : ajout retrouvé', cmp.segments.some((s) => s.added && s.value.includes('155')));

    const statutDoc = (await api('GET', `/api/operations/${op.id}`)).json.documents.find((d) => d.id === acte.id);
    check('statut du document passé à « reçu markup »', statutDoc.statut === 'recu_markup');

    // Facturation
    const devis = (await api('POST', '/api/factures', {
      operation_id: op.id, type: 'devis', mode: 'temps',
      lignes: [{ description: 'Rédaction des actes', quantite: 3, prix_unitaire: 250 }],
    })).json;
    check('devis numéroté automatiquement', /^DEV-\d{4}-\d{3}$/.test(devis.numero));
    const paye = (await api('PUT', `/api/factures/${devis.id}`, { statut: 'accepte' })).json;
    check('mise à jour du statut du devis', paye.statut === 'accepte');

    // Génération d'une approbation des comptes (select + boucle associés)
    const ago = (await api('POST', '/api/operations', {
      societe_id: fille.id, type: 'approbation_comptes', libelle: 'Smoke Test AGO',
      variables: {
        exercice_clos: '2025-12-31', date_ago: '2026-06-30', resultat: 42000,
        affectation: 'ran', conventions_reglementees: false, quitus: true,
      },
    })).json;
    const genAgo = (await api('POST', `/api/operations/${ago.id}/generer`)).json;
    check('génération approbation des comptes (5 documents)', genAgo.generes.length === 5);
    const agoDetail = (await api('GET', `/api/operations/${ago.id}`)).json;
    const pv = agoDetail.documents.find((d) => d.code === 'pv_ago');
    const dlPv = await fetch(`${base}/api/versions/${pv.versions[0].id}/download`);
    const textePv = extractDocxText(Buffer.from(await dlPv.arrayBuffer()));
    check('PV AGO : affectation en report à nouveau (select → drapeaux)',
      textePv.includes('report à nouveau') && !textePv.includes('dividendes'));
    const fp = agoDetail.documents.find((d) => d.code === 'feuille_presence');
    const dlFp = await fetch(`${base}/api/versions/${fp.versions[0].id}/download`);
    const texteFp = extractDocxText(Buffer.from(await dlFp.arrayBuffer()));
    check('feuille de présence : boucle sur les associés de la fiche société',
      texteFp.includes('Smoke Test Holding') && texteFp.includes('Paul Minor') && texteFp.includes('80'));

    // Dashboard
    const dash = (await api('GET', '/api/dashboard')).json;
    check('tableau de bord', dash.compteurs.societes >= 2 && dash.compteurs.operations_en_cours >= 2);
  } finally {
    // Nettoyage : la suppression des sociétés cascade opérations, documents, versions, factures.
    for (const id of aNettoyer.societes) await api('DELETE', `/api/societes/${id}`).catch(() => {});
    for (const id of aNettoyer.groupes) await api('DELETE', `/api/groupes/${id}`).catch(() => {});
    if (server) server.close();
  }

  console.log(failures === 0 ? '\nTous les tests passent.' : `\n${failures} échec(s).`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
