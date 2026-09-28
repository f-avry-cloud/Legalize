'use strict';

/**
 * Contrôles de cohérence du registre.
 *
 * Règle du module : ils n'empêchent JAMAIS la saisie — un registre papier
 * accepte une erreur, on la corrige ensuite. Ils empêchent la certification
 * d'un état incohérent, ce qui n'est pas la même chose.
 *
 * Les bloquants portent sur des impossibilités arithmétiques ou documentaires.
 * Les alertes portent sur des questions de droit : l'outil signale, l'avocat
 * décide, et son acquittement est tracé.
 */

const { supabase, q: db } = require('../supa');
const { NATURES, nommerCompte } = require('./rmt');

/* --------------------------------------------------------------- bloquants */

/**
 * Solde négatif à n'importe quelle date de l'historique.
 *
 * Le contrôle ne peut pas se contenter du solde final : céder 200 titres en
 * mars quand on n'en détient que 100, puis en recevoir 500 en juin, donne un
 * solde final positif et une impossibilité juridique en mars.
 */
function soldesNegatifs(lignes, comptes) {
  const parCompte = new Map(comptes.map((c) => [c.id, c]));
  const evenements = [];
  for (const l of lignes) {
    if (l.supprimee) continue;
    const date = l.date_effet || l.date_inscription || '';
    const quantite = Number(l.quantite || 0);
    if (l.compte_credite) evenements.push({ date, compte: l.compte_credite, categorie: l.categorie_id, delta: quantite, ligne: l });
    if (l.compte_debite) evenements.push({ date, compte: l.compte_debite, categorie: l.categorie_id, delta: -quantite, ligne: l });
  }
  evenements.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const soldes = new Map();
  const vus = new Set();
  const anomalies = [];
  for (const e of evenements) {
    const cle = `${e.compte}:${e.categorie}`;
    const solde = (soldes.get(cle) || 0) + e.delta;
    soldes.set(cle, solde);
    if (solde < 0 && !vus.has(cle)) {
      vus.add(cle);
      anomalies.push({
        code: 'solde_negatif',
        message: `Solde négatif de ${solde} titre(s) sur le compte ${nommerCompte(parCompte.get(e.compte))} `
          + `au ${e.date || 'sans date'}.`,
        compte_id: e.compte,
        mouvement_id: e.ligne.mouvement_id,
        date: e.date,
      });
    }
  }
  return anomalies;
}

/** Σ soldes d'une catégorie contre les titres émis par les décisions sociales. */
function invariantCategories(emis, soldes, categories) {
  const parCategorie = new Map(categories.map((c) => [c.id, c]));
  const anomalies = [];
  for (const e of emis) {
    const detenu = soldes.filter((s) => s.categorie_id === e.categorie_id)
      .reduce((t, s) => t + Number(s.solde || 0), 0);
    const ecart = Number(e.emis) - detenu;
    if (ecart !== 0) {
      const cat = parCategorie.get(e.categorie_id);
      anomalies.push({
        code: 'invariant_categorie',
        message: `Catégorie ${cat?.libelle || e.code} : ${e.emis} titre(s) émis pour ${detenu} détenu(s) `
          + `— écart de ${ecart > 0 ? '+' : ''}${ecart}. Vérifier les décisions de capital ou les écritures.`,
        categorie_id: e.categorie_id,
        ecart,
      });
    }
  }
  return anomalies;
}

function justificatifsManquants(lignes, justificatifs) {
  const anomalies = [];
  for (const l of lignes) {
    if (l.supprimee) continue;
    const exige = NATURES[l.nature]?.justificatif;
    if (!exige) continue;
    const present = justificatifs.some((j) => j.mouvement_id === l.mouvement_id && j.type === exige);
    if (!present) {
      anomalies.push({
        code: 'justificatif_manquant',
        message: `Écriture n° ${l.numero_affiche} (${l.nature_libelle}) : justificatif principal absent `
          + `(${exige.replace(/_/g, ' ')}).`,
        mouvement_id: l.mouvement_id,
      });
    }
  }
  return anomalies;
}

/** Numéros de titres en double ou hors des titres émis. */
function numerosIncoherents(lignes, emisTotal) {
  const anomalies = [];
  const attribues = new Map();           // numéro → écriture qui l'a crédité
  for (const l of lignes) {
    if (l.supprimee || !l.numeros) continue;
    for (const [de, a] of intervalles(l.numeros)) {
      if (emisTotal && a > emisTotal) {
        anomalies.push({
          code: 'numeros_incoherents',
          message: `Écriture n° ${l.numero_affiche} : le numéro ${a} dépasse les ${emisTotal} titres émis.`,
          mouvement_id: l.mouvement_id,
        });
      }
      if (!l.compte_credite) continue;   // seul un crédit attribue un numéro
      for (let n = de; n <= a; n += 1) {
        if (attribues.has(n)) {
          anomalies.push({
            code: 'numeros_incoherents',
            message: `Le titre n° ${n} est attribué deux fois : écritures n° ${attribues.get(n)} et n° ${l.numero_affiche}.`,
            mouvement_id: l.mouvement_id,
          });
        } else {
          attribues.set(n, l.numero_affiche);
        }
      }
    }
  }
  return anomalies;
}

/** `{[1,100],[151,200]}` → [[1,100],[151,200]] */
function intervalles(multirange) {
  const texte = String(multirange || '');
  const bornes = [];
  for (const m of texte.matchAll(/([\[(])(\d+),(\d+)([\])])/g)) {
    const de = Number(m[2]) + (m[1] === '(' ? 1 : 0);
    const a = Number(m[3]) - (m[4] === ')' ? 1 : 0);
    if (Number.isFinite(de) && Number.isFinite(a) && a >= de) bornes.push([de, a]);
  }
  return bornes;
}

/* ----------------------------------------------------------------- alertes */

function alertes(lignes, params, mentions, acquittements, comptes) {
  const parCompte = new Map(comptes.map((c) => [c.id, c]));
  const sortie = [];
  const transferts = new Set(['cession', 'apport', 'donation', 'succession', 'fusion_tup']);

  const clauses = [
    ['clause_agrement', 'Clause d’agrement', params.clause_agrement],
    ['clause_preemption', 'Droit de préemption', params.clause_preemption],
    ['clause_inalienabilite', 'Clause d’inaliénabilité', params.clause_inalienabilite],
  ];

  // Date de la dernière écriture déjà passée à l'encre : toute inscription
  // antérieure est une insertion rétroactive dans un état déjà certifié.
  const derniereEncre = lignes
    .filter((l) => l.statut === 'ENCRE' || l.statut === 'ENCRE_MODIFIEE')
    .map((l) => l.date_inscription || l.date_effet || '')
    .sort()
    .pop();

  for (const l of lignes) {
    if (l.supprimee) continue;
    const acquittee = (code) => acquittements.some((a) => a.version_id === l.id && a.code === code);

    if (transferts.has(l.nature)) {
      for (const [code, libelle, active] of clauses) {
        if (!active) continue;
        sortie.push({
          code,
          message: `Écriture n° ${l.numero_affiche} (${l.nature_libelle}) : ${libelle} potentiellement applicable `
            + '— vérifier qu’elle a été respectée ou purgée.',
          mouvement_id: l.mouvement_id,
          version_id: l.id,
          acquittee: acquittee(code),
        });
      }

      const mention = mentions.find((m) => m.compte_id === l.compte_debite && !m.mainlevee_le);
      if (mention) {
        sortie.push({
          code: 'mention_active',
          message: `Écriture n° ${l.numero_affiche} : une mention de ${mention.type} grève le compte `
            + `${nommerCompte(parCompte.get(l.compte_debite))}.`,
          mouvement_id: l.mouvement_id,
          version_id: l.id,
          acquittee: acquittee('mention_active'),
        });
      }
    }

    if (derniereEncre && (l.date_inscription || '') < derniereEncre && l.statut === 'CRAYON') {
      sortie.push({
        code: 'insertion_retroactive',
        message: `Écriture n° ${l.numero_affiche} : inscrite au ${l.date_inscription}, soit avant une écriture `
          + `déjà certifiée (${derniereEncre}).`,
        mouvement_id: l.mouvement_id,
        version_id: l.id,
        acquittee: acquittee('insertion_retroactive'),
      });
    }
  }
  return sortie;
}

/** Franchissement des seuils de détention paramétrés par la société. */
function seuils(comptes, params, totalDetenu) {
  if (!params.seuils_surveilles?.length || !totalDetenu) return [];
  const sortie = [];
  for (const c of comptes) {
    const part = (Number(c.solde || 0) / totalDetenu) * 100;
    for (const seuil of params.seuils_surveilles) {
      if (part >= Number(seuil)) {
        sortie.push({
          code: 'franchissement_seuil',
          message: `${nommerCompte(c)} détient ${part.toFixed(2)} % du capital — seuil de ${seuil} % franchi.`,
          compte_id: c.id,
          acquittee: false,
        });
        break;                            // le seuil le plus élevé suffit
      }
    }
  }
  return sortie;
}

/* ------------------------------------------------------------------ façade */

async function analyser(societeId) {
  const rmt = require('./rmt');
  const [fiche, lignes] = await Promise.all([
    rmt.societe(societeId),
    rmt.mouvements(societeId, { historique: true }),
  ]);
  if (!fiche.actif) return { bloquants: [], alertes: [], certifiable: false, inactif: true };

  const [justificatifs, mentions, acquittements, soldes] = await Promise.all([
    db(supabase.from('rmt_justificatifs').select('*').eq('societe_id', societeId)),
    db(supabase.from('rmt_mentions').select('*').eq('societe_id', societeId)),
    db(supabase.from('rmt_alertes_acquittees').select('*').eq('societe_id', societeId)),
    db(supabase.from('rmt_soldes').select('*').eq('societe_id', societeId)),
  ]);

  const emisTotal = fiche.emissions.reduce((t, e) => t + Number(e.emis || 0), 0);
  const totalDetenu = soldes.reduce((t, s) => t + Number(s.solde || 0), 0);

  const bloquants = [
    ...soldesNegatifs(lignes, fiche.comptes),
    ...invariantCategories(fiche.emissions, soldes, fiche.categories),
    ...justificatifsManquants(lignes, justificatifs),
    ...numerosIncoherents(lignes, fiche.parametres.titres_numerotes ? emisTotal : 0),
  ];

  const listeAlertes = [
    ...alertes(lignes, fiche.parametres, mentions, acquittements, fiche.comptes),
    ...seuils(fiche.comptes, fiche.parametres, totalDetenu),
  ];

  // La réconciliation du capital est une alerte, non un bloquant : la fiche
  // société peut être en retard sans que le registre soit faux.
  const cap = fiche.capital;
  if (cap && (cap.ecart_capital || cap.ecart_titres)) {
    listeAlertes.push({
      code: 'ecart_capital',
      message: `Écart entre la fiche société et le registre : capital ${cap.capital_fiche} € déclaré contre `
        + `${cap.capital_calcule ?? '—'} € calculé, ${cap.titres_fiche ?? '—'} titres déclarés contre `
        + `${cap.titres_emis} émis.`,
      acquittee: false,
    });
  }

  return {
    bloquants,
    alertes: listeAlertes,
    certifiable: bloquants.length === 0,
    capital: cap,
  };
}

async function acquitter({ societe_id, mouvement_id, version_id, code, commentaire }, utilisateurId) {
  return db(supabase.from('rmt_alertes_acquittees').upsert({
    societe_id, mouvement_id: mouvement_id || null, version_id: version_id || null,
    code, commentaire: commentaire || null, acquitte_par: utilisateurId,
  }, { onConflict: 'version_id,code' }).select().single());
}

module.exports = { analyser, acquitter, intervalles };
