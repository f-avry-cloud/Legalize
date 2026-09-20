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
};
const sequences = {};
const fichiers = new Map();

function nextId(table) {
  sequences[table] = (sequences[table] || 0) + 1;
  return sequences[table];
}

function correspond(ligne, filtres) {
  return filtres.every((f) => {
    if (f.op === 'eq') return String(ligne[f.col]) === String(f.val);
    if (f.op === 'not_is_null') return ligne[f.col] !== null && ligne[f.col] !== undefined;
    return true;
  });
}

function requete(table) {
  const etat = { table, filtres: [], tri: null, action: 'select', payload: null, unique: false };

  const builder = {
    select() { return builder; },
    insert(valeurs) { etat.action = 'insert'; etat.payload = valeurs; return builder; },
    update(valeurs) { etat.action = 'update'; etat.payload = valeurs; return builder; },
    delete() { etat.action = 'delete'; return builder; },
    eq(col, val) { etat.filtres.push({ op: 'eq', col, val }); return builder; },
    not(col, op, val) { if (op === 'is' && val === null) etat.filtres.push({ op: 'not_is_null', col }); return builder; },
    in() { return builder; },
    like() { return builder; },
    order(col, opts) { etat.tri = { col, asc: opts?.ascending !== false }; return builder; },
    single() { etat.unique = true; return builder; },
    then(resoudre, rejeter) { return executer().then(resoudre, rejeter); },
  };

  async function executer() {
    const lignes = tables[etat.table];
    if (!lignes) return { data: null, error: { message: `relation "${etat.table}" does not exist` } };

    if (etat.action === 'insert') {
      const entrees = (Array.isArray(etat.payload) ? etat.payload : [etat.payload]).map((v) => ({
        id: nextId(etat.table), created_at: new Date().toISOString(), ...v,
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

    // PostgREST renvoie des documents JSON : on copie, pour qu'une mise à
    // jour ultérieure ne modifie pas rétroactivement un objet déjà lu.
    const copie = (l) => ({ ...l });
    if (etat.unique) {
      if (!selection.length) return { data: null, error: { message: 'JSON object requested, 0 rows returned' } };
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
  BUCKET: 'documents',
};

require.cache[require.resolve('../src/supa.js')] = { id: 'supa', filename: 'supa', loaded: true, exports: faux };

module.exports = { tables, fichiers, faux };
