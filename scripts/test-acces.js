'use strict';

/**
 * Essai réel du verrouillage : chaque porte est essayée, ouverte et fermée.
 *
 *   LEGALIZE_ESSAI_EMAIL=… LEGALIZE_ESSAI_MDP=… [LEGALIZE_ESSAI_TOTP=secret]
 *   [LEGALIZE_ESSAI_MEMBRE=0] node scripts/test-acces.js [URL de l'application]
 *
 * Le compte d'essai associe une application d'authentification au premier
 * passage ; le secret est alors affiché pour les passages suivants
 * (LEGALIZE_ESSAI_TOTP). LEGALIZE_ESSAI_MEMBRE=0 : le compte n'est pas dans la
 * liste des membres, l'accès doit être refusé.
 */

const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_KEY } = require('../src/supa');
const { totp, fetchConnexionUnique, agentUnique } = require('./session-essai');

const APP = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.LEGALIZE_ESSAI_EMAIL;
const MDP = process.env.LEGALIZE_ESSAI_MDP;
const MEMBRE = process.env.LEGALIZE_ESSAI_MEMBRE !== '0';

let ok = 0;
function verifier(nom, condition, detail) {
  if (condition) { ok += 1; console.log(`  ✓ ${nom}`); } else {
    console.error(`  ✗ ${nom}${detail !== undefined ? `\n    ${JSON.stringify(detail).slice(0, 400)}` : ''}`);
    process.exitCode = 1;
  }
}

async function appel(chemin, { jeton, cookie, methode = 'GET' } = {}) {
  const headers = {};
  if (jeton) headers.Authorization = `Bearer ${jeton}`;
  if (cookie) headers.Cookie = `lz_jeton=${encodeURIComponent(cookie)}`;
  const r = await fetch(`${APP}/api${chemin}`, { method: methode, headers });
  return { statut: r.status, corps: await r.json().catch(() => null) };
}

const base = (jeton) => createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  ...(jeton ? { global: { headers: { Authorization: `Bearer ${jeton}` } } } : {}),
});

(async () => {
  if (!EMAIL || !MDP) { console.error('LEGALIZE_ESSAI_EMAIL et LEGALIZE_ESSAI_MDP requis.'); process.exit(2); }
  console.log(`\nApplication : ${APP}`);

  console.log('\nSans session');
  verifier('la version reste publique', (await appel('/version')).statut === 200);
  const sans = await appel('/societes');
  verifier('les données sont refusées (401, connexion requise)', sans.statut === 401 && sans.corps?.code === 'non_connecte', sans);
  const ecriture = await appel('/societes', { methode: 'POST', cookie: 'faux' });
  verifier('une écriture par simple cookie est refusée', ecriture.statut === 401, ecriture);
  const { data: anon, error: eAnon } = await base().from('societes').select('id').limit(5);
  verifier('la base ne livre rien avec la seule clé publique', !eAnon && anon.length === 0, { erreur: eAnon?.message, lignes: anon?.length });
  const { data: anonUtil } = await base().from('utilisateurs').select('email').limit(5);
  verifier('la liste des membres est invisible sans session', (anonUtil || []).length === 0);
  const { data: fichiers } = await base().storage.from('documents').list('', { limit: 5 });
  verifier('les fichiers sont invisibles sans session', (fichiers || []).length === 0);

  console.log('\nMot de passe seul (double authentification non faite)');
  const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchConnexionUnique } });
  const { data: c1, error: e1 } = await client.auth.signInWithPassword({ email: EMAIL, password: MDP });
  if (e1) { console.error(`Connexion impossible : ${e1.message}`); process.exit(1); }
  const j1 = c1.session.access_token;
  const r1 = await appel('/societes', { jeton: j1 });
  verifier('l’application exige le code (401)', r1.statut === 401 && r1.corps?.code === 'double_authentification', r1);
  const { data: b1 } = await base(j1).from('societes').select('id').limit(5);
  verifier('la base ne livre rien non plus', (b1 || []).length === 0, b1?.length);

  console.log('\nAvec le code à six chiffres');
  let secret = process.env.LEGALIZE_ESSAI_TOTP;
  const { data: facteurs } = await client.auth.mfa.listFactors();
  let facteur = facteurs.totp[0];
  if (!facteur) {
    for (const f of facteurs.all.filter((x) => x.status !== 'verified')) await client.auth.mfa.unenroll({ factorId: f.id });
    const { data: ins, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'essai automatique' });
    if (error) { console.error(error.message); process.exit(1); }
    facteur = { id: ins.id };
    secret = ins.totp.secret;
    console.log(`    (application associée — LEGALIZE_ESSAI_TOTP=${secret})`);
  }
  const faux = await client.auth.mfa.challengeAndVerify({ factorId: facteur.id, code: totp(secret, 7) });
  verifier('un mauvais code est refusé', Boolean(faux.error));
  const { error: e2 } = await client.auth.mfa.challengeAndVerify({ factorId: facteur.id, code: totp(secret) });
  verifier('le bon code est accepté', !e2, e2?.message);
  const { data: { session } } = await client.auth.getSession();
  const j2 = session.access_token;
  const moi = await appel('/moi', { jeton: j2 });

  if (!MEMBRE) {
    verifier('adresse hors de la liste des membres : refus (403)', moi.statut === 403 && moi.corps?.code === 'non_autorise', moi);
    const { data: b2 } = await base(j2).from('societes').select('id').limit(5);
    verifier('la base ne livre rien à un non-membre', (b2 || []).length === 0);
  } else {
    verifier('membre reconnu', moi.statut === 200 && moi.corps?.email?.toLowerCase() === EMAIL.toLowerCase(), moi);
    for (const chemin of ['/dashboard', '/societes', '/operations', '/formalites', '/parcours/referentiels']) {
      const r = await appel(chemin, { jeton: j2 });
      verifier(`${chemin} accessible`, r.statut === 200, r.statut);
    }
    // Indépendant du contenu de la base : le membre lit au moins sa propre fiche.
    const { data: b2, error: eb2 } = await base(j2).from('utilisateurs').select('id').ilike('email', EMAIL);
    const { error: eb3 } = await base(j2).from('societes').select('id').limit(1);
    verifier('la base livre les données au membre', !eb2 && !eb3 && b2.length === 1, eb2?.message || eb3?.message);
    const { data: v } = await base(j2).from('document_versions').select('id').limit(1);
    if (v?.[0]) {
      const r = await fetch(`${APP}/api/versions/${v[0].id}/download`, { headers: { Cookie: `lz_jeton=${encodeURIComponent(j2)}` } });
      verifier('téléchargement par lien (cookie de session)', r.status === 200, r.status);
      const r0 = await fetch(`${APP}/api/versions/${v[0].id}/download`);
      verifier('le même lien sans session est refusé', r0.status === 401, r0.status);
    }
    const { data: membres } = await base(j2).from('utilisateurs').select('id').limit(50);
    verifier('le membre voit la liste des membres', (membres || []).length > 0);
    const { error: eModif } = await base(j2).from('utilisateurs').update({ role: 'associe' }).eq('email', EMAIL).select().single();
    const { data: apres } = await base(j2).from('utilisateurs').select('role').ilike('email', EMAIL).single();
    verifier('un collaborateur ne peut pas se promouvoir associé', Boolean(eModif) || apres?.role !== 'associe', { eModif: eModif?.message, role: apres?.role });
  }

  await client.auth.signOut();
  agentUnique.destroy();
  console.log(`\n${ok} vérification(s) passée(s).${process.exitCode ? ' ÉCHECS ci-dessus.' : ' Tout est vert.'}\n`);
})();
