-- ===========================================================================
-- Dossiers : la mission, cœur du suivi du cabinet.
--
-- Un dossier appartient à un client (celui qui mandate le cabinet) et
-- concerne une ou plusieurs sociétés, chacune avec son rôle (cible, cédant,
-- acquéreur, absorbante…). Trois familles, une seule table :
--   haut_de_bilan — opérations suivies par étapes (M&A, transmission,
--                   restructuration, levée de fonds) ;
--   secretariat   — vie sociale des sociétés clientes (approbation des
--                   comptes, décisions de gestion) ;
--   conseil       — consultations et questions ponctuelles.
-- Ce qui est propre à un type de dossier (prix, exercice clos, question
-- posée…) est rangé dans `donnees` et décrit par l'application
-- (src/modules/dossiers/types.js) : ajouter un type ne touche pas la base.
--
-- Toutes les tables sont réservées aux membres du cabinet (schema-auth.sql).
-- À exécuter dans le SQL editor du projet Supabase ; rejouable.
-- ===========================================================================

create table if not exists clients (
  id          bigint generated always as identity primary key,
  nom         text not null,
  nature      text not null default 'societe' check (nature in ('groupe', 'societe', 'personne')),
  groupe_id   bigint references groupes(id) on delete set null,
  societe_id  bigint references societes(id) on delete set null,
  email       text,
  telephone   text,
  adresse     text not null default '',
  notes       text not null default '',
  created_at  timestamptz not null default now()
);

-- Les interlocuteurs, et leur adresse : c'est elle qui rattachera un mail
-- reçu au bon client.
create table if not exists contacts (
  id          bigint generated always as identity primary key,
  client_id   bigint references clients(id) on delete cascade,
  societe_id  bigint references societes(id) on delete set null,
  civilite    text not null default '',
  nom         text not null,
  prenom      text not null default '',
  fonction    text not null default '',
  email       text,
  telephone   text,
  notes       text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists contacts_email_idx on contacts (lower(email));
create index if not exists contacts_client_idx on contacts (client_id);

-- Étapes types par type de dossier, modifiables par le cabinet. Sans ligne
-- pour un type, l'application propose ses étapes par défaut.
create table if not exists modeles_processus (
  type        text primary key,
  libelle     text,
  etapes      jsonb not null default '[]',   -- [{ "code": "...", "libelle": "..." }]
  updated_at  timestamptz not null default now()
);

create table if not exists dossiers (
  id             bigint generated always as identity primary key,
  reference      text not null unique,            -- 2026-0001
  client_id      bigint references clients(id) on delete restrict,
  famille        text not null check (famille in ('haut_de_bilan', 'secretariat', 'conseil')),
  type           text not null,
  titre          text not null,
  statut         text not null default 'en_cours'
                 check (statut in ('en_cours', 'en_attente', 'suspendu', 'clos', 'abandonne')),
  responsable_id bigint references utilisateurs(id) on delete set null,
  echeance       date,
  date_ouverture date not null default current_date,
  date_cloture   date,
  donnees        jsonb not null default '{}',
  notes          text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists dossiers_famille_idx on dossiers (famille, statut);
create index if not exists dossiers_client_idx on dossiers (client_id);

-- Sociétés concernées et leur rôle. Une partie peut ne pas avoir de fiche
-- (acquéreur étranger, investisseur) : la dénomination suffit.
create table if not exists dossier_parties (
  id           bigint generated always as identity primary key,
  dossier_id   bigint not null references dossiers(id) on delete cascade,
  societe_id   bigint references societes(id) on delete set null,
  denomination text not null,
  role         text not null default 'concernee',
  created_at   timestamptz not null default now()
);
create index if not exists dossier_parties_dossier_idx on dossier_parties (dossier_id);
create index if not exists dossier_parties_societe_idx on dossier_parties (societe_id);

create table if not exists dossier_intervenants (
  id             bigint generated always as identity primary key,
  dossier_id     bigint not null references dossiers(id) on delete cascade,
  utilisateur_id bigint references utilisateurs(id) on delete cascade,
  contact_id     bigint references contacts(id) on delete cascade,
  role           text not null default '',
  created_at     timestamptz not null default now(),
  check (utilisateur_id is not null or contact_id is not null)
);
create index if not exists dossier_intervenants_dossier_idx on dossier_intervenants (dossier_id);

-- Les étapes du dossier : copiées du modèle à l'ouverture, puis propres au
-- dossier (on peut en ajouter, en retirer).
create table if not exists etapes (
  id            bigint generated always as identity primary key,
  dossier_id    bigint not null references dossiers(id) on delete cascade,
  ordre         integer not null,
  code          text not null default '',
  libelle       text not null,
  statut        text not null default 'a_faire' check (statut in ('a_faire', 'en_cours', 'fait', 'sans_objet')),
  date_prevue   date,
  date_realisee date,
  created_at    timestamptz not null default now()
);
create index if not exists etapes_dossier_idx on etapes (dossier_id, ordre);

create table if not exists taches (
  id             bigint generated always as identity primary key,
  dossier_id     bigint not null references dossiers(id) on delete cascade,
  etape_id       bigint references etapes(id) on delete set null,
  titre          text not null,
  responsable_id bigint references utilisateurs(id) on delete set null,
  echeance       date,
  statut         text not null default 'a_faire' check (statut in ('a_faire', 'fait')),
  origine        text not null default 'manuel' check (origine in ('manuel', 'modele', 'agent')),
  fait_le        timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists taches_dossier_idx on taches (dossier_id);

-- Les dates qui comptent : légales (calculées), contractuelles, ou fixées.
create table if not exists echeances (
  id          bigint generated always as identity primary key,
  dossier_id  bigint references dossiers(id) on delete cascade,
  societe_id  bigint references societes(id) on delete cascade,
  nature      text not null default 'autre',
  libelle     text not null,
  date        date not null,
  base_legale text not null default '',
  statut      text not null default 'a_venir' check (statut in ('a_venir', 'faite', 'sans_objet')),
  origine     text not null default 'manuel' check (origine in ('manuel', 'calcul', 'agent')),
  created_at  timestamptz not null default now(),
  check (dossier_id is not null or societe_id is not null)
);
create index if not exists echeances_dossier_idx on echeances (dossier_id);
create index if not exists echeances_date_idx on echeances (date) where statut = 'a_venir';

-- Chronologie du dossier : ce qui s'est passé, qui l'a fait (membre,
-- application ou agent). Sert aussi de journal des actions de l'agent.
create table if not exists evenements (
  id          bigint generated always as identity primary key,
  dossier_id  bigint not null references dossiers(id) on delete cascade,
  date        timestamptz not null default now(),
  nature      text not null default 'note',
  resume      text not null,
  auteur_id   bigint references utilisateurs(id) on delete set null,
  origine     text not null default 'manuel' check (origine in ('manuel', 'systeme', 'agent')),
  objet_table text,
  objet_id    bigint,
  details     jsonb not null default '{}'
);
create index if not exists evenements_dossier_idx on evenements (dossier_id, date desc);

-- Les travaux existants se rattachent au dossier.
alter table operations add column if not exists dossier_id bigint references dossiers(id) on delete set null;
alter table formalites add column if not exists dossier_id bigint references dossiers(id) on delete set null;
alter table factures   add column if not exists dossier_id bigint references dossiers(id) on delete set null;

-- Réservé aux membres du cabinet.
do $$
declare t text;
begin
  foreach t in array array['clients', 'contacts', 'modeles_processus', 'dossiers', 'dossier_parties',
                           'dossier_intervenants', 'etapes', 'taches', 'echeances', 'evenements'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'membres du cabinet') then
      execute format('create policy "membres du cabinet" on public.%I for all to authenticated
                      using (public.est_membre()) with check (public.est_membre())', t);
    end if;
  end loop;
end $$;
