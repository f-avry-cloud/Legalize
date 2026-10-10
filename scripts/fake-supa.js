'use strict';

/**
 * Double de src/supa.js pour les tests : reproduit la partie de PostgREST
 * réellement utilisée par l'application (filtres eq / not-is-null, tri,
 * insert / update / delete avec select, single) sur des tables en mémoire,
 * et un stockage de fichiers en Map. Doit être requis AVANT src/routes.js.
 */

/* ------------------------------------------- double de src/supa.js */

const tables = {
  groupes: [], societes: [], dirigeants: [], associes: [], operations: [],
  documents: [], document_versions: [], factures: [],
  formalites: [], formalite_pieces: [], formalite_evenements: [],
  utilisateurs: [], clients: [], contacts: [], modeles_processus: [], dossiers: [], dossier_parties: [],
  dossier_intervenants: [], etapes: [], taches: [], echeances: [], evenements: [],
  revues: [], revue_dossiers: [], emails: [], propositions: [], regles_agent: [],
};
const sequences = {};

// Valeurs par défaut des colonnes, comme la base les pose.
const DEFAUTS = {
  dossiers: () => ({ statut: 'en_cours', donnees: {}, notes: '', date_ouverture: new Date().toISOString().slice(0, 10) }),
  etapes: () => ({ statut: 'a_faire', code: '', date_prevue: null, date_realisee: null }),
  taches: () => ({ statut: 'a_faire', origine: 'manuel', fait_le: null }),
  echeances: () => ({ statut: 'a_venir', origine: 'manuel', base_legale: '', nature: 'autre' }),
  evenements: () => ({ date: new Date().toISOString(), origine: 'manuel', details: {} }),
  dossier_parties: () => ({ role: 'concernee' }),
  propositions: () => ({ statut: 'proposee', donnees: {} }),
  revue_dossiers: () => ({ priorite: 'normale', faits: [], a_faire: [], en_attente: [], ordre: 0 }),
};
const fichiers = new Map();

function nextId(table) {
  sequences[table] = (sequences[table] || 0) + 1;
  return sequences[table];
}

function correspond(ligne, filtres) {
  return filtres.every((f) => {
    if (f.op === 'eq') return String(ligne[f.col]) === String(f.val);
    if (f.op === 'not_is_null') return ligne[f.col] !== null && ligne[f.col] !== undefined;
    if (f.op === 'in') return f.val.map(String).includes(String(ligne[f.col]));
    if (f.op === 'like') {
      const motif = new RegExp(`^${String(f.val).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, f.i ? 'i' : '');
      return motif.test(String(ligne[f.col] ?? ''));
    }
    return true;
  });
}

function requete(table) {
  const etat = { table, filtres: [], tri: null, action: 'select', payload: null, unique: false, limite: null };

  const builder = {
    select() { return builder; },
    insert(valeurs) { etat.action = 'insert'; etat.payload = valeurs; return builder; },
    update(valeurs) { etat.action = 'update'; etat.payload = valeurs; return builder; },
    delete() { etat.action = 'delete'; return builder; },
    eq(col, val) { etat.filtres.push({ op: 'eq', col, val }); return builder; },
    not(col, op, val) { if (op === 'is' && val === null) etat.filtres.push({ op: 'not_is_null', col }); return builder; },
    in(col, val) { etat.filtres.push({ op: 'in', col, val }); return builder; },
    like(col, val) { etat.filtres.push({ op: 'like', col, val }); return builder; },
    ilike(col, val) { etat.filtres.push({ op: 'like', col, val, i: true }); return builder; },
    limit(n) { etat.limite = n; return builder; },
    order(col, opts) { etat.tri = { col, asc: opts?.ascending !== false }; return builder; },
    single() { etat.unique = true; return builder; },
    maybeSingle() { etat.unique = 'peut-etre'; return builder; },
    then(resoudre, rejeter) { return executer().then(resoudre, rejeter); },
  };

  async function executer() {
    const lignes = tables[etat.table];
    if (!lignes) return { data: null, error: { message: `relation "${etat.table}" does not exist` } };

    if (etat.action === 'insert') {
      const entrees = (Array.isArray(etat.payload) ? etat.payload : [etat.payload]).map((v) => ({
        id: nextId(etat.table), created_at: new Date().toISOString(), ...(DEFAUTS[etat.table]?.() || {}), ...v,
      }));
      lignes.push(...entrees);
      return { data: etat.unique ? { ...entrees[0] } : entrees.map((e) => ({ ...e })), error: null };
    }

    let selection = lignes.filter((l) => correspond(l, etat.filtres));

    if (etat.action === 'update') {
      selection.forEach((l) => Object.assign(l, etat.payload));
    } else if (etat.action === 'delete') {
      for (const l of selection) lignes.splice(lignes.indexOf(l), 1);
    } else if (etat.tri) {
      selection = [...selection].sort((a, b) => {
        const va = a[etat.tri.col] ?? ''; const vb = b[etat.tri.col] ?? '';
        return (va > vb ? 1 : va < vb ? -1 : 0) * (etat.tri.asc ? 1 : -1);
      });
    }

    if (etat.limite !== null && etat.action === 'select') selection = selection.slice(0, etat.limite);

    // PostgREST renvoie des documents JSON : on copie, pour qu'une mise à
    // jour ultérieure ne modifie pas rétroactivement un objet déjà lu.
    const copie = (l) => ({ ...l });
    if (etat.unique) {
      if (!selection.length) {
        return etat.unique === 'peut-etre' ? { data: null, error: null }
          : { data: null, error: { message: 'JSON object requested, 0 rows returned' } };
      }
      return { data: copie(selection[0]), error: null };
    }
    return { data: selection.map(copie), error: null };
  }

  return builder;
}

const faux = {
  supabase: { from: (table) => requete(table) },
  async q(promise) {
    const { data, error } = await promise;
    if (error) { const e = new Error(error.message); e.status = /0 rows/.test(error.message) ? 404 : 500; throw e; }
    return data;
  },
  async qCount() { return 0; },
  async uploadFile(chemin, buffer) { fichiers.set(chemin, buffer); },
  async downloadFile(chemin) { return fichiers.get(chemin) || Buffer.from(''); },
  async removeFiles(chemins) { (chemins || []).forEach((c) => fichiers.delete(c)); return (chemins || []).length; },
  BUCKET: 'documents',
  // Pas de session dans les tests unitaires : ni contexte ni utilisateur.
  garderContexte: (middleware) => middleware,
  dansContexte: (valeurs, suite) => suite(),
  // Membre connecté simulé : faux.connecte = { id, … }.
  connecte: null,
  utilisateurCourant: () => faux.connecte,
};

require.cache[require.resolve('../src/supa.js')] = { id: 'supa', filename: 'supa', loaded: true, exports: faux };

module.exports = { tables, fichiers, faux };
