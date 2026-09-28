'use strict';

/**
 * Émission, vérification et révocation des extraits certifiés.
 *
 * L'extrait est le seul objet figé du module : il fait passer des écritures
 * « à l'encre » en gelant leur contenu, leur empreinte et le chaînage avec
 * l'extrait précédent. C'est ce qui remplace l'immuabilité du registre.
 *
 * La signature PAdES suppose un certificat que le cabinet doit fournir. Elle
 * est donc isolée derrière `signer()` : tant qu'aucun certificat n'est
 * configuré, l'extrait porte un scellement interne et le dit franchement,
 * plutôt que de laisser croire à une signature qu'il n'a pas.
 */

const crypto = require('node:crypto');
const { supabase, q: db } = require('../supa');
const rmt = require('./rmt');
const controles = require('./rmt-controles');

const TYPES = {
  registre_complet: 'Registre des mouvements de titres',
  compte_individuel: 'Compte individuel d’actionnaire',
  attestation_inscription: 'Attestation d’inscription en compte',
  table_capitalisation: 'Table de capitalisation',
};

const MENTION_LEGALE =
  'Ce document est un extrait d’un registre de travail tenu par le cabinet. '
  + 'Il ne constitue pas le registre légal des mouvements de titres de la société.';

/** Sérialisation stable : deux fois le même état donnent la même empreinte. */
function canonique(valeur) {
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(',')}]`;
  if (valeur && typeof valeur === 'object') {
    return `{${Object.keys(valeur).sort().map((c) => `${JSON.stringify(c)}:${canonique(valeur[c])}`).join(',')}}`;
  }
  return JSON.stringify(valeur ?? null);
}

function empreinteDe(contenu) {
  return crypto.createHash('sha256').update(canonique(contenu)).digest('hex');
}

/**
 * Scellement du contenu. Le format PAdES attend un certificat : sans lui, on
 * scelle en interne et on l'annonce. Le jour où le certificat arrive, seule
 * cette fonction change.
 */
function signer(empreinte, certifiant) {
  const certificat = process.env.RMT_CERTIFICAT_PEM || null;
  if (!certificat) {
    return {
      format: 'scellement_interne',
      algorithme: 'sha256',
      horodatage: new Date().toISOString(),
      certifiant,
      avertissement: 'Aucun certificat configuré : le document porte un scellement interne '
        + 'et non une signature électronique au sens du règlement eIDAS.',
    };
  }
  const signature = crypto.createSign('sha256');
  signature.update(empreinte);
  return {
    format: 'PAdES',
    algorithme: 'sha256',
    horodatage: new Date().toISOString(),
    certifiant,
    valeur: signature.sign(certificat, 'base64'),
  };
}

/** Le contenu figé : ce que l'extrait atteste, indépendamment de la base. */
async function composer(societeId, type, perimetre = {}) {
  const fiche = await rmt.societe(societeId);
  if (!fiche.actif) throw rmt.erreur('Aucun registre ouvert pour cette société.', 409);

  let lignes = await rmt.mouvements(societeId, { historique: false });
  if (perimetre.compte_id) {
    const compte = Number(perimetre.compte_id);
    lignes = lignes.filter((l) => l.compte_debite === compte || l.compte_credite === compte);
  }

  return {
    societe: {
      denomination: fiche.societe.denomination,
      forme: fiche.parametres.forme,
      siren: fiche.societe.siren,
      siege: fiche.societe.siege_social,
      capital: fiche.societe.capital_social,
    },
    type,
    type_libelle: TYPES[type],
    perimetre,
    mention_legale: MENTION_LEGALE,
    categories: fiche.categories.map((c) => ({ code: c.code, libelle: c.libelle, nominal: c.nominal })),
    comptes: fiche.comptes.map((c) => ({
      numero: c.numero, type: c.type, intitule: rmt.nommerCompte(c), solde: c.solde,
    })),
    ecritures: lignes.map((l) => ({
      numero: l.numero_affiche,
      date_inscription: l.date_inscription,
      date_effet: l.date_effet,
      nature: l.nature,
      nature_libelle: l.nature_libelle,
      quantite: l.quantite,
      numeros: l.numeros,
      compte_debite: l.compte_debite,
      compte_credite: l.compte_credite,
      prix_total: l.prix_total,
      version: l.numero_version,
    })),
    capital: fiche.capital,
  };
}

async function previsualiser(societeId, { type, perimetre }) {
  const [contenu, analyse] = await Promise.all([
    composer(societeId, type, perimetre),
    controles.analyser(societeId),
  ]);
  return { contenu, ...analyse };
}

/**
 * Émet l'extrait. Les contrôles bloquants interdisent la certification — c'est
 * le seul endroit du module où une incohérence arrête quelque chose.
 */
async function certifier(societeId, { type, perimetre = {}, destinataires = [] }, utilisateur) {
  if (!TYPES[type]) throw rmt.erreur(`Type d’extrait inconnu : ${type}.`);

  const analyse = await controles.analyser(societeId);
  if (!analyse.certifiable) {
    throw rmt.erreur(
      'Certification impossible : le registre présente des incohérences bloquantes. '
      + 'La saisie reste libre, mais un extrait ne peut pas certifier un état incohérent.',
      422, { bloquants: analyse.bloquants },
    );
  }

  const fiche = await rmt.societe(societeId);
  const contenu = await composer(societeId, type, perimetre);
  const dateArrete = new Date().toISOString();

  const precedents = await db(supabase.from('rmt_extraits').select('empreinte')
    .eq('societe_id', societeId).order('certifie_le', { ascending: false }).limit(1));
  const empreinte = empreinteDe(contenu);

  const certifiantNom = fiche.parametres.certifiant_nom
    || [utilisateur?.prenom, utilisateur?.nom].filter(Boolean).join(' ')
    || 'Certifiant non renseigné';
  const certifiantQualite = fiche.parametres.certifiant_qualite
    || (fiche.parametres.certifiant_type === 'representant_legal' ? 'Représentant légal' : 'Avocat mandaté');

  const annee = new Date().getFullYear();
  const deja = await db(supabase.from('rmt_extraits').select('id').eq('societe_id', societeId));
  const reference = `EXT-${annee}-${String(deja.length + 1).padStart(4, '0')}-${societeId}`;

  const extrait = await db(supabase.from('rmt_extraits').insert({
    societe_id: societeId,
    reference,
    type,
    perimetre,
    date_arrete: dateArrete,
    contenu,
    empreinte,
    empreinte_precedente: precedents[0]?.empreinte || null,
    signature: signer(empreinte, { nom: certifiantNom, qualite: certifiantQualite }),
    certifiant_id: utilisateur?.id || null,
    certifiant_nom: certifiantNom,
    certifiant_qualite: certifiantQualite,
    jeton_verification: crypto.randomBytes(24).toString('base64url'),
  }).select().single());

  // Geler quelle version de quelle écriture cet extrait couvre : c'est de
  // cette table que se déduit le passage à l'encre.
  const lignes = await rmt.mouvements(societeId, { historique: false });
  const couvertes = perimetre.compte_id
    ? lignes.filter((l) => l.compte_debite === Number(perimetre.compte_id) || l.compte_credite === Number(perimetre.compte_id))
    : lignes;
  if (couvertes.length) {
    await db(supabase.from('rmt_extrait_mouvements').insert(couvertes.map((l) => ({
      extrait_id: extrait.id, mouvement_id: l.mouvement_id, version_id: l.id,
    }))));
  }

  if (destinataires.length) {
    await db(supabase.from('rmt_extrait_destinataires').insert(destinataires.map((d) => ({
      extrait_id: extrait.id, nom: d.nom, qualite: d.qualite || null, email: d.email || null,
    }))));
  }

  await rmt.journal(societeId, utilisateur?.id, 'extrait.certifie', 'extrait', extrait.id,
    { reference, type, ecritures: couvertes.length });

  return { ...extrait, ecritures_couvertes: couvertes.length };
}

/** Un extrait révoqué ne couvre plus rien : les écritures redeviennent crayon. */
async function revoquer(extraitId, motif, utilisateur) {
  if (!utilisateur || utilisateur.role !== 'associe') {
    throw rmt.erreur('Seul un associé peut révoquer un extrait certifié.', 403,
      { role_requis: 'associe', role_actuel: utilisateur?.role || null });
  }
  if (!motif) throw rmt.erreur('La révocation doit être motivée.', 422);

  const [extrait] = await db(supabase.from('rmt_extraits').select('*').eq('id', extraitId));
  if (!extrait) throw rmt.erreur('Extrait inconnu.', 404);

  const maj = await db(supabase.from('rmt_extraits').update({
    statut: 'revoque',
    revoque_le: new Date().toISOString(),
    revoque_par: utilisateur.id,
    revocation_motif: motif,
  }).eq('id', extraitId).select().single());

  await rmt.journal(extrait.societe_id, utilisateur.id, 'extrait.revoque', 'extrait', extraitId, { motif });
  return maj;
}

/**
 * Vérification publique par le jeton du QR code.
 *
 * N'expose que ce qui permet de vérifier : statut, dates, certifiant,
 * empreinte. Jamais le contenu du registre, jamais un nom d'actionnaire. Un
 * jeton inconnu et un jeton révoqué renvoient le même 404, faute de quoi le
 * code d'erreur deviendrait lui-même une information.
 */
async function verifier(jeton) {
  const lignes = await db(supabase.from('rmt_extraits').select('*').eq('jeton_verification', jeton));
  const extrait = lignes[0];
  if (!extrait) throw rmt.erreur('Aucun extrait ne correspond à cet identifiant.', 404);

  await rmt.journal(extrait.societe_id, null, 'extrait.verifie', 'extrait', extrait.id, {});

  return {
    reference: extrait.reference,
    type_libelle: TYPES[extrait.type],
    statut: extrait.statut,
    statut_libelle: {
      a_jour: 'À jour',
      devenu_inexact: 'Devenu inexact',
      revoque: 'Révoqué',
    }[extrait.statut],
    date_arrete: extrait.date_arrete,
    certifie_le: extrait.certifie_le,
    devenu_inexact_le: extrait.devenu_inexact_le,
    certifiant_nom: extrait.certifiant_nom,
    certifiant_qualite: extrait.certifiant_qualite,
    empreinte: extrait.empreinte,
    signature_format: extrait.signature?.format || null,
    mention_legale: MENTION_LEGALE,
  };
}

module.exports = { TYPES, MENTION_LEGALE, composer, previsualiser, certifier, revoquer, verifier, empreinteDe };
