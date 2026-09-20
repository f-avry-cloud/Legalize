-- Schéma du module « Formalités INPI » (Supabase / Postgres).
-- À exécuter une fois dans le SQL editor du projet Supabase.
--
-- Posture identique au reste du MVP : RLS activé, mais avec une policy
-- permissive « demo acces complet » (accès total par la clé publishable),
-- exactement comme les tables existantes. À restreindre avant d'y mettre de
-- vrais dossiers clients (voir la fin de ce fichier).

create table if not exists formalites (
  id            bigint generated always as identity primary key,
  societe_id    bigint references societes(id) on delete set null,
  operation_id  bigint references operations(id) on delete set null,
  type          text not null,
  service       text not null default 'formalites',  -- formalites | comptes_annuels
  libelle       text not null default '',
  reference     text,                       -- référence mandataire (notre côté)
  siren         text,
  fiche         jsonb not null default '{}'::jsonb,   -- instantané RNE au moment de la création
  reponses      jsonb not null default '{}'::jsonb,   -- questionnaire (le « delta »)
  payload       jsonb,                      -- JSON INPI déposé (ou prêt à déposer)
  statut        text not null default 'BROUILLON',
  action_attendue text,                      -- deposer | signer | payer | regulariser | attendre
  inpi_id       text,
  numero_liasse text,
  statut_inpi   text,                        -- statut brut renvoyé par l'INPI
  statut_date   timestamptz,
  montant       numeric(10,2),               -- taxes calculées par le guichet après dépôt
  num_nat       text,                        -- numéro national attribué au paiement
  signature_date timestamptz,
  paiement_date timestamptz,
  echeance      date,
  simule        boolean not null default false,
  regularisations jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists formalites_statut_idx   on formalites (statut);
create index if not exists formalites_societe_idx  on formalites (societe_id);
create index if not exists formalites_echeance_idx on formalites (echeance);
create index if not exists formalites_action_idx   on formalites (action_attendue);

create table if not exists formalite_pieces (
  id           bigint generated always as identity primary key,
  formalite_id bigint not null references formalites(id) on delete cascade,
  code         text not null,               -- code officiel INPI (PJ_01, PJ_54…)
  libelle      text not null default '',
  filename     text not null default '',
  filepath     text not null default '',    -- chemin dans le bucket « documents »
  taille       bigint,
  created_at   timestamptz not null default now()
);

create index if not exists formalite_pieces_formalite_idx on formalite_pieces (formalite_id);

-- Journal : toute action sur un dossier est tracée (qui/quoi/quand), ce qui
-- rend le suivi auditable et permet de reconstituer l'historique d'un dépôt.
create table if not exists formalite_evenements (
  id           bigint generated always as identity primary key,
  formalite_id bigint not null references formalites(id) on delete cascade,
  type         text not null,               -- creation | saisie | piece | depot | statut | regularisation | note
  message      text not null default '',
  donnees      jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists formalite_evenements_formalite_idx on formalite_evenements (formalite_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Sécurité : même posture démo que les tables existantes (RLS activé, policy
-- permissive). PostgREST refuserait l'accès sans policy.

alter table formalites           enable row level security;
alter table formalite_pieces     enable row level security;
alter table formalite_evenements enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='formalites') then
    create policy "demo acces complet" on formalites for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='formalite_pieces') then
    create policy "demo acces complet" on formalite_pieces for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='formalite_evenements') then
    create policy "demo acces complet" on formalite_evenements for all using (true) with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Durcissement (avant mise en production réelle) : remplacer la policy
-- permissive par une restriction au cabinet / à l'utilisateur authentifié.
--
-- drop policy "demo acces complet" on formalites;
-- create policy "cabinet" on formalites for all to authenticated using (true) with check (true);
-- (idem sur les deux autres tables)
