'use strict';

/**
 * Suppression des sociétés et des dossiers de formalités, sur base en mémoire.
 *
 *   node scripts/test-suppression.js
 */

const { tables, fichiers } = require('./fake-supa');

const app = require('../src/routes');
const express = require('express');

const serveur = express();
serveur.use(express.json());
serveur.use('/api', app);
serveur.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 500)}` : ''}`);
    process.exitCode = 1;
  }
}

(async () => {
  const instance = serveur.listen(0);
  const base = `http://127.0.0.1:${instance.address().port}/api`;
  const appel = async (methode, url, corps) => {
    const res = await fetch(base + url, {
      method: methode,
      headers: corps ? { 'Content-Type': 'application/json' } : undefined,
      body: corps ? JSON.stringify(corps) : undefined,
    });
    return { statut: res.status, corps: await res.json().catch(() => null) };
  };

  console.log('\nSuppression d’une société');
  tables.societes.push({ id: 1, denomination: 'Société Générale d’Essai', siren: '', forme_sociale: 'SAS' });
  tables.societes.push({ id: 2, denomination: 'MERE', forme_sociale: 'SAS' });
  tables.dirigeants.push({ id: 1, societe_id: 1, nom: 'MARTIN' });
  tables.associes.push({ id: 1, societe_id: 1, nom: 'DURAND' });
  tables.associes.push({ id: 2, societe_id: 2, type: 'morale', denomination: 'Société Générale d’Essai', societe_liee_id: 1 });
  tables.operations.push({ id: 1, societe_id: 1, type: 'agoa' });
  tables.documents.push({ id: 1, operation_id: 1 });
  tables.document_versions.push({ id: 1, document_id: 1, filepath: 'operations/1/pv.docx' });
  fichiers.set('operations/1/pv.docx', Buffer.from('x'));
  tables.formalites.push({ id: 1, societe_id: 1, type: 'transfert_siege', statut: 'BROUILLON', origine: 'locale' });

  const im = await appel('GET', '/societes/1/suppression');
  verifier('aperçu : ce qui sera effacé', im.corps.supprime.dirigeants === 1 && im.corps.supprime.associes === 1
    && im.corps.supprime.operations === 1 && im.corps.supprime.documents === 1, im.corps);
  verifier('aperçu : ce qui sera conservé', im.corps.conserve.formalites === 1 && im.corps.conserve.participations === 1, im.corps.conserve);

  const refus = await appel('DELETE', '/societes/1', { confirmation: 'autre chose' });
  verifier('mauvaise confirmation refusée', refus.statut === 422 && tables.societes.some((s) => s.id === 1));
  const sansConfirmation = await appel('DELETE', '/societes/1');
  verifier('suppression sans confirmation refusée', sansConfirmation.statut === 422);

  const fait = await appel('DELETE', '/societes/1', { confirmation: '  societe generale d’essai ' });
  verifier('confirmation tolérante aux accents, à la casse et aux espaces', fait.statut === 200, fait.corps);
  verifier('société effacée', !tables.societes.some((s) => s.id === 1));
  verifier('formalité conservée et détachée', tables.formalites.find((f) => f.id === 1)?.societe_id === null);
  verifier('participation conservée sans le lien', tables.associes.find((a) => a.id === 2)?.societe_liee_id === null);
  verifier('fichier des documents retiré du stockage', !fichiers.has('operations/1/pv.docx'));
  verifier('société déjà supprimée : 404', (await appel('GET', '/societes/1/suppression')).statut === 404);

  console.log('\nSuppression des dossiers de formalités');
  tables.formalites.push(
    { id: 10, type: 'transfert_siege', statut: 'BROUILLON', origine: 'locale' },
    { id: 11, type: 'transfert_siege', statut: 'PAYMENT_PENDING', origine: 'locale', inpi_id: 'SIM-1', simule: true },
    { id: 12, type: 'transfert_siege', statut: 'VALIDATED', origine: 'locale', inpi_id: '42' },
    { id: 13, type: 'inpi_M', statut: 'VALIDATED', origine: 'inpi', inpi_id: '900001' },
    { id: 14, type: 'parcours', statut: 'BROUILLON', origine: 'locale' },
  );
  tables.formalite_pieces.push({ id: 1, formalite_id: 10, code: 'PJ_54', filepath: 'formalites/10/pv.pdf' });
  fichiers.set('formalites/10/pv.pdf', Buffer.from('x'));

  const brouillon = await appel('DELETE', '/formalites/10');
  verifier('brouillon supprimé avec ses fichiers', brouillon.statut === 200 && !fichiers.has('formalites/10/pv.pdf'), brouillon.corps);
  const nonPaye = await appel('DELETE', '/formalites/11');
  verifier('dépôt non payé supprimé', nonPaye.statut === 200, nonPaye.corps);
  const valide = await appel('DELETE', '/formalites/12');
  verifier('dossier validé conservé', valide.statut === 409 && tables.formalites.some((f) => f.id === 12), valide.corps);
  const importe = await appel('DELETE', '/formalites/13');
  verifier('copie importée retirée, avec message', importe.statut === 200 && /guichet unique/.test(importe.corps.message), importe.corps);
  verifier('parcours en brouillon supprimé', (await appel('DELETE', '/formalites/14')).statut === 200);

  instance.close();
  console.log(`\n${ok} vérification(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
})();
