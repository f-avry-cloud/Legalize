'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Sur Vercel (serverless), seul /tmp est inscriptible : la base y est éphémère (mode démo).
const DATA_DIR = process.env.LEGALIZE_DATA_DIR
  || (process.env.VERCEL ? '/tmp/legalize/data' : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'legalize.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS groupes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS societes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  groupe_id INTEGER REFERENCES groupes(id) ON DELETE SET NULL,
  denomination TEXT NOT NULL,
  forme_sociale TEXT NOT NULL DEFAULT 'SAS',
  capital_social REAL NOT NULL DEFAULT 0,
  nb_titres INTEGER NOT NULL DEFAULT 0,
  siege_social TEXT DEFAULT '',
  siren TEXT DEFAULT '',
  rcs_ville TEXT DEFAULT '',
  objet_social TEXT DEFAULT '',
  date_cloture TEXT DEFAULT '31/12',
  statut TEXT NOT NULL DEFAULT 'active', -- active | en_constitution | radiee
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dirigeants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  societe_id INTEGER NOT NULL REFERENCES societes(id) ON DELETE CASCADE,
  civilite TEXT DEFAULT 'M.',
  nom TEXT NOT NULL,
  prenom TEXT DEFAULT '',
  fonction TEXT NOT NULL DEFAULT 'Président',
  adresse TEXT DEFAULT '',
  date_nomination TEXT DEFAULT ''
);

-- Les associés couvrent aussi les participations inter-sociétés :
-- si societe_liee_id est renseigné, l'associé est une société du référentiel
-- et le lien alimente l'organigramme de groupe.
CREATE TABLE IF NOT EXISTS associes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  societe_id INTEGER NOT NULL REFERENCES societes(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'physique', -- physique | morale
  civilite TEXT DEFAULT 'M.',
  nom TEXT DEFAULT '',
  prenom TEXT DEFAULT '',
  denomination TEXT DEFAULT '',
  societe_liee_id INTEGER REFERENCES societes(id) ON DELETE SET NULL,
  nb_titres INTEGER NOT NULL DEFAULT 0,
  adresse TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  societe_id INTEGER NOT NULL REFERENCES societes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  libelle TEXT NOT NULL,
  statut TEXT NOT NULL DEFAULT 'en_cours', -- en_cours | termine | abandonne
  variables TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  nom TEXT NOT NULL,
  obligatoire INTEGER NOT NULL DEFAULT 1,
  statut TEXT NOT NULL DEFAULT 'a_faire',
  -- a_faire | genere | envoye | recu_markup | signe | finalise | non_applicable
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(operation_id, code)
);

CREATE TABLE IF NOT EXISTS document_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  numero INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'genere', -- genere | recu | importe
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS factures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'devis', -- devis | facture
  numero TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'forfait', -- forfait | temps
  lignes TEXT NOT NULL DEFAULT '[]', -- [{description, quantite, prix_unitaire}]
  taux_tva REAL NOT NULL DEFAULT 20,
  statut TEXT NOT NULL DEFAULT 'brouillon', -- brouillon | envoye | accepte | paye
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
