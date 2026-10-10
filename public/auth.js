'use strict';

/* =========================================================================
   Connexion.

   L'application ne s'affiche qu'une fois ces trois conditions réunies :
   1. une session ouverte (adresse et mot de passe, ou compte Microsoft) ;
   2. la double authentification faite (code à six chiffres d'une
      application d'authentification ; Microsoft applique la sienne) ;
   3. l'adresse inscrite parmi les membres du cabinet.
   Le serveur et la base vérifient les mêmes conditions à chaque appel.
   ========================================================================= */

const LZ_AUTH = window.LEGALIZE_AUTH || null;
const sb = LZ_AUTH && window.supabase
  ? window.supabase.createClient(LZ_AUTH.url, LZ_AUTH.cle, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  })
  : null;

const escA = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Cookie lu par le serveur pour les liens de téléchargement (lecture seule). */
function poserCookieSession(session) {
  const securise = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = session
    ? `lz_jeton=${encodeURIComponent(session.access_token)}; Path=/api; Max-Age=${session.expires_in || 3600}; SameSite=Strict${securise}`
    : `lz_jeton=; Path=/api; Max-Age=0; SameSite=Strict${securise}`;
}

/** Méthodes de connexion de la session (contenu du jeton, sans vérification : le serveur vérifie). */
function methodesSession(session) {
  try {
    const charge = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return (charge.amr || []).map((m) => m.method);
  } catch (e) { return []; }
}

let lzRecuperation = false;
if (sb) {
  sb.auth.onAuthStateChange((evenement, session) => {
    poserCookieSession(session);
    if (evenement === 'PASSWORD_RECOVERY') lzRecuperation = true;
  });
}

/** En-têtes d'authentification pour un appel d'API (session rafraîchie si besoin). */
async function enTetesAuth() {
  if (!sb) return {};
  const { data } = await sb.auth.getSession();
  return data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {};
}

const CODES_REFUS = new Set(['non_connecte', 'session_expiree', 'double_authentification', 'non_autorise']);

/** Réponse de l'API qui signifie « reconnectez-vous » : on repasse par l'écran de connexion. */
function refusAcces(statut, json) {
  if ((statut !== 401 && statut !== 403) || !CODES_REFUS.has(json?.code)) return false;
  if (!document.body.classList.contains('auth-en-cours')) ouvrirSession().then(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  return true;
}

/* ------------------------------------------------------------- écrans */

function ecranAuth(html) {
  document.body.classList.add('auth-en-cours');
  let $e = document.getElementById('auth');
  if (!$e) {
    $e = document.createElement('div');
    $e.id = 'auth';
    $e.className = 'auth';
    document.body.appendChild($e);
  }
  $e.innerHTML = `<div class="auth-carte">
      <div class="auth-marque"><span class="brand-mark" aria-hidden="true">L</span><strong>Legalize</strong></div>
      ${html}
    </div>`;
  $e.querySelector('input')?.focus();
  return $e;
}

function fermerEcranAuth() {
  document.getElementById('auth')?.remove();
  document.body.classList.remove('auth-en-cours');
}

function messageAuth($e, texte, erreur) {
  const $m = $e.querySelector('.auth-message');
  $m.textContent = texte;
  $m.className = `auth-message${erreur ? ' erreur' : ''}`;
  $m.hidden = !texte;
}

/** Traduit les messages du service d'authentification. */
function erreurAuth(e) {
  const m = String(e?.message || e || '');
  if (/invalid login credentials/i.test(m)) return 'Adresse ou mot de passe incorrect.';
  if (/email not confirmed/i.test(m)) return 'Adresse pas encore confirmée : ouvrez le lien reçu par courriel.';
  if (/not authorized/i.test(m)) return 'L’envoi de courriel vers cette adresse est refusé par le service d’envoi. Utilisez l’adresse de votre compte.';
  if (/already registered|already exists/i.test(m)) return 'Un accès existe déjà pour cette adresse : connectez-vous.';
  if (/invalid totp|invalid code|expired/i.test(m)) return 'Code incorrect ou expiré : saisissez le code affiché maintenant.';
  if (/rate limit|too many/i.test(m)) return 'Trop de tentatives : patientez quelques minutes.';
  if (/password should be|weak/i.test(m)) return 'Mot de passe trop faible : au moins 12 caractères.';
  return m || 'Opération impossible.';
}

function formConnexion(mode) {
  const creation = mode === 'creation';
  const microsoft = LZ_AUTH?.microsoft
    ? `<button type="button" class="btn auth-microsoft" data-microsoft>
         <svg viewBox="0 0 21 21" aria-hidden="true"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>
         Se connecter avec Microsoft</button>
       <div class="auth-ou"><span>ou</span></div>`
    : '';
  return `
    <h1>${creation ? 'Créer mon accès' : 'Connexion'}</h1>
    <p class="auth-aide">${creation ? 'Réservé aux membres du cabinet. Un lien de confirmation vous sera envoyé.' : 'Accès réservé aux membres du cabinet.'}</p>
    ${creation ? '' : microsoft}
    <form class="auth-form" novalidate>
      <label class="field">Adresse électronique<input type="email" name="email" autocomplete="username" required></label>
      <label class="field">Mot de passe<input type="password" name="mdp" autocomplete="${creation ? 'new-password' : 'current-password'}" required minlength="${creation ? 12 : 1}"></label>
      ${creation ? '<label class="field">Confirmer le mot de passe<input type="password" name="mdp2" autocomplete="new-password" required></label>' : ''}
      <p class="auth-message" role="alert" hidden></p>
      <button class="btn btn-primary" type="submit">${creation ? 'Créer mon accès' : 'Se connecter'}</button>
    </form>
    <div class="auth-liens">
      ${creation
    ? '<button type="button" class="lien" data-mode="connexion">J’ai déjà un accès</button>'
    : '<button type="button" class="lien" data-mode="creation">Première connexion</button><button type="button" class="lien" data-oubli>Mot de passe oublié</button>'}
    </div>`;
}

/** Étape 1 : adresse et mot de passe (ou Microsoft). Résout quand une session est ouverte. */
function etapeConnexion(mode = 'connexion', erreur = null) {
  return new Promise((resolve) => {
    const $e = ecranAuth(formConnexion(mode));
    if (erreur) messageAuth($e, erreur, true);
    $e.querySelectorAll('[data-mode]').forEach((b) => { b.onclick = () => etapeConnexion(b.dataset.mode).then(resolve); });
    const $micro = $e.querySelector('[data-microsoft]');
    if ($micro) {
      $micro.onclick = async () => {
        const { error } = await sb.auth.signInWithOAuth({ provider: 'azure', options: { scopes: 'email', redirectTo: `${location.origin}/` } });
        if (error) messageAuth($e, erreurAuth(error), true);
      };
    }
    const $oubli = $e.querySelector('[data-oubli]');
    if ($oubli) {
      $oubli.onclick = async () => {
        const email = $e.querySelector('[name=email]').value.trim();
        if (!email) { messageAuth($e, 'Saisissez d’abord votre adresse.', true); return; }
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/` });
        messageAuth($e, error ? erreurAuth(error) : 'Si un accès existe pour cette adresse, un lien de réinitialisation vient d’être envoyé.', Boolean(error));
      };
    }
    $e.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const email = f.email.value.trim();
      const mdp = f.mdp.value;
      const $btn = f.querySelector('button[type=submit]');
      if (!email || !mdp) { messageAuth($e, 'Adresse et mot de passe requis.', true); return; }
      if (mode === 'creation') {
        if (mdp.length < 12) { messageAuth($e, 'Mot de passe trop court : au moins 12 caractères.', true); return; }
        if (mdp !== f.mdp2.value) { messageAuth($e, 'Les deux mots de passe diffèrent.', true); return; }
      }
      $btn.disabled = true;
      try {
        if (mode === 'creation') {
          const { data, error } = await sb.auth.signUp({ email, password: mdp, options: { emailRedirectTo: `${location.origin}/` } });
          if (error) throw error;
          if (data.session) { resolve(data.session); return; }
          messageAuth($e, `Un lien de confirmation a été envoyé à ${email}. Ouvrez-le, puis connectez-vous ici.`, false);
        } else {
          const { data, error } = await sb.auth.signInWithPassword({ email, password: mdp });
          if (error) throw error;
          resolve(data.session);
        }
      } catch (e) {
        messageAuth($e, erreurAuth(e), true);
      } finally { $btn.disabled = false; }
    };
  });
}

/** Retour d'un lien « mot de passe oublié » : choisir le nouveau mot de passe. */
function etapeNouveauMotDePasse() {
  return new Promise((resolve) => {
    const $e = ecranAuth(`
      <h1>Nouveau mot de passe</h1>
      <form class="auth-form" novalidate>
        <label class="field">Nouveau mot de passe<input type="password" name="mdp" autocomplete="new-password" minlength="12" required></label>
        <label class="field">Confirmer<input type="password" name="mdp2" autocomplete="new-password" required></label>
        <p class="auth-message" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Enregistrer</button>
      </form>`);
    $e.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      if (f.mdp.value.length < 12) { messageAuth($e, 'Au moins 12 caractères.', true); return; }
      if (f.mdp.value !== f.mdp2.value) { messageAuth($e, 'Les deux mots de passe diffèrent.', true); return; }
      const { error } = await sb.auth.updateUser({ password: f.mdp.value });
      if (error) { messageAuth($e, erreurAuth(error), true); return; }
      lzRecuperation = false;
      resolve();
    };
  });
}

/** Étape 2 : code à six chiffres. Première fois : associer l'application d'authentification. */
async function etapeDoubleAuthentification() {
  const { data: niveau } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (niveau?.currentLevel === 'aal2') return;
  // Connexion Microsoft : la double authentification relève de Microsoft.
  const { data: { session } } = await sb.auth.getSession();
  if (methodesSession(session).includes('oauth')) return;

  const { data: facteurs } = await sb.auth.mfa.listFactors();
  let facteur = facteurs?.totp?.[0] || null;
  let inscription = null;
  if (!facteur) {
    // Un essai d'association abandonné bloquerait le suivant.
    for (const f of (facteurs?.all || []).filter((x) => x.factor_type === 'totp' && x.status !== 'verified')) {
      await sb.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Legalize ${new Date().toISOString().slice(0, 10)}` });
    if (error) throw error;
    inscription = data;
    facteur = { id: data.id };
  }

  await new Promise((resolve) => {
    const $e = ecranAuth(inscription ? `
      <h1>Double authentification</h1>
      <p class="auth-aide">Une seule fois : scannez ce code avec une application d’authentification (Microsoft Authenticator, Google Authenticator…), puis saisissez le code à six chiffres qu’elle affiche.</p>
      <div class="auth-qr"><img src="${escA(inscription.totp.qr_code)}" alt="Code QR à scanner"></div>
      <details class="auth-cle"><summary>Saisie manuelle</summary><code>${escA(inscription.totp.secret)}</code></details>
      <form class="auth-form" novalidate>
        <label class="field">Code à six chiffres<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
        <p class="auth-message" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Valider</button>
      </form>` : `
      <h1>Code de vérification</h1>
      <p class="auth-aide">Saisissez le code à six chiffres affiché par votre application d’authentification.</p>
      <form class="auth-form" novalidate>
        <label class="field">Code à six chiffres<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
        <p class="auth-message" role="alert" hidden></p>
        <button class="btn btn-primary" type="submit">Valider</button>
      </form>
      <div class="auth-liens"><button type="button" class="lien" data-sortir>Changer de compte</button></div>`);
    const $sortir = $e.querySelector('[data-sortir]');
    if ($sortir) $sortir.onclick = () => deconnecter();
    $e.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const code = ev.target.code.value.replace(/\s/g, '');
      if (!/^\d{6}$/.test(code)) { messageAuth($e, 'Six chiffres attendus.', true); return; }
      const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: facteur.id, code });
      if (error) { messageAuth($e, erreurAuth(error), true); ev.target.code.select(); return; }
      resolve();
    };
  });
}

/** Étape 3 : l'adresse doit figurer parmi les membres du cabinet. */
async function etapeMembre() {
  const res = await fetch('/api/moi', { headers: await enTetesAuth() });
  const json = await res.json().catch(() => null);
  if (res.ok) return json;
  if (json?.code === 'non_autorise') {
    await new Promise(() => {
      const $e = ecranAuth(`
        <h1>Accès non autorisé</h1>
        <p class="auth-aide">${escA(json.error)}</p>
        <p class="auth-aide">Un associé du cabinet doit d’abord ajouter cette adresse à la liste des membres.</p>
        <div class="auth-liens"><button type="button" class="btn" data-sortir>Changer de compte</button></div>`);
      $e.querySelector('[data-sortir]').onclick = () => deconnecter();
    });
  }
  // Incident passager (base injoignable…) : la session est gardée, on propose de réessayer.
  await new Promise((resolve) => {
    const $e = ecranAuth(`
      <h1>Connexion momentanément impossible</h1>
      <p class="auth-aide">${escA(json?.error || `Erreur ${res.status}`)}</p>
      <div class="auth-liens"><button type="button" class="btn btn-primary" data-reessayer>Réessayer</button>
        <button type="button" class="lien" data-sortir>Changer de compte</button></div>`);
    $e.querySelector('[data-reessayer]').onclick = resolve;
    $e.querySelector('[data-sortir]').onclick = () => deconnecter();
  });
  return null;
}

let lzSessionEnCours = null;

/** Ouvre (ou rouvre) une session complète ; résout avec le membre connecté. */
function ouvrirSession() {
  if (lzSessionEnCours) return lzSessionEnCours;
  lzSessionEnCours = (async () => {
    if (!sb) {
      ecranAuth('<h1>Connexion indisponible</h1><p class="auth-aide">Rechargez la page depuis l’adresse principale de l’application.</p>');
      return new Promise(() => {});
    }
    let erreur = null;
    for (;;) {
      try {
        let { data: { session } } = await sb.auth.getSession();
        if (lzRecuperation && session) await etapeNouveauMotDePasse();
        if (!session) session = await etapeConnexion('connexion', erreur);
        erreur = null;
        await etapeDoubleAuthentification();
        const membre = await etapeMembre();
        if (!membre) continue;
        fermerEcranAuth();
        afficherMembre(membre);
        return membre;
      } catch (e) {
        // Session inutilisable : on repart de l'écran de connexion, avec le motif.
        erreur = erreurAuth(e);
        await sb.auth.signOut().catch(() => {});
      }
    }
  })().finally(() => { lzSessionEnCours = null; });
  return lzSessionEnCours;
}

async function deconnecter() {
  await sb?.auth.signOut().catch(() => {});
  poserCookieSession(null);
  location.hash = '#/';
  location.reload();
}

/** Nom du membre et bouton de déconnexion, en pied de menu. */
function afficherMembre(membre) {
  const $pied = document.querySelector('.sidebar-foot');
  if (!$pied || !membre) return;
  let $m = document.getElementById('membre-connecte');
  if (!$m) {
    $m = document.createElement('div');
    $m.id = 'membre-connecte';
    $m.className = 'membre-connecte';
    $pied.prepend($m);
  }
  const nom = [membre.prenom, membre.nom].filter(Boolean).join(' ') || membre.email;
  $m.innerHTML = `<span title="${escA(membre.email)}">${escA(nom)}</span>
    <button type="button" class="lien" id="btn-deconnexion">Se déconnecter</button>`;
  document.getElementById('btn-deconnexion').onclick = deconnecter;
}
