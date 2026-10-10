-- ===========================================================================
-- Revue quotidienne des mails.
--
-- Chaque matin (et en début d'après-midi), une tâche programmée lit la boîte
-- de l'avocat, rattache les mails aux dossiers et dépose ici une revue :
-- ce qui s'est passé par dossier, ce qui est attendu, et des propositions.
-- L'assistant ne modifie jamais un dossier : il PROPOSE. Les propositions
-- s'appliquent dans Legalize, au clic de l'avocat.
--
-- L'assistant n'a que deux portes d'entrée, réservées au compte technique
-- (jamais aux utilisateurs de l'application) :
--   agent_contexte()          ce que Legalize sait déjà (dossiers, contacts,
--                             fils de discussion connus, propositions en cours) ;
--   agent_deposer_revue(json) le dépôt de la revue, contrôlé ici.
--
-- Le contenu des mails reste dans Outlook : Legalize garde l'expéditeur,
-- l'objet, la date, un résumé et le lien. Les résumés sont effacés à la
-- clôture du dossier (src/modules/dossiers/service.js).
-- À exécuter dans le SQL editor du projet Supabase ; rejouable.
-- ===========================================================================

create table if not exists agent_etat (
  id                integer primary key default 1 check (id = 1),
  derniere_lecture  timestamptz,
  derniere_revue_id bigint,
  updated_at        timestamptz not null default now()
);
insert into agent_etat (id) values (1) on conflict (id) do nothing;

create table if not exists revues (
  id             bigint generated always as identity primary key,
  date_revue     date not null default ((now() at time zone 'Europe/Paris')::date),
  moment         text not null default 'matin' check (moment in ('matin', 'apres_midi', 'reprise', 'manuelle')),
  periode_debut  timestamptz,
  periode_fin    timestamptz not null default now(),
  statut         text not null default 'complete' check (statut in ('complete', 'partielle')),
  stats          jsonb not null default '{}',   -- { recus, envoyes, utiles, ecartes, ecartes_detail }
  echeances      jsonb not null default '[]',   -- [{ date, libelle, dossier_id | dossier_cle }]
  remarques      jsonb not null default '[]',   -- points d'attention généraux
  created_at     timestamptz not null default now()
);
create index if not exists revues_date_idx on revues (date_revue desc, id desc);

-- Un bloc par dossier (existant, ou proposé et désigné par une clé).
create table if not exists revue_dossiers (
  id          bigint generated always as identity primary key,
  revue_id    bigint not null references revues(id) on delete cascade,
  dossier_id  bigint references dossiers(id) on delete cascade,
  cle         text,
  titre       text not null,
  priorite    text not null default 'normale' check (priorite in ('haute', 'normale', 'basse', 'terminee')),
  faits       jsonb not null default '[]',
  a_faire     jsonb not null default '[]',
  en_attente  jsonb not null default '[]',
  ordre       integer not null default 0
);
create index if not exists revue_dossiers_revue_idx on revue_dossiers (revue_id);
create index if not exists revue_dossiers_dossier_idx on revue_dossiers (dossier_id);

-- Les mails vus : rattachés à un dossier (par le fil de discussion ou par
-- validation), proposés au rattachement, ou écartés.
create table if not exists emails (
  id               bigint generated always as identity primary key,
  message_id       text not null unique,          -- internetMessageId
  graph_id         text,
  conversation_id  text,
  sens             text not null default 'recu' check (sens in ('recu', 'envoye')),
  expediteur       text,
  destinataires    text[] not null default '{}',
  objet            text,
  date             timestamptz,
  resume           text,
  lien             text,
  dossier_id       bigint references dossiers(id) on delete set null,
  dossier_cle      text,
  revue_id         bigint references revues(id) on delete set null,
  statut           text not null default 'propose' check (statut in ('propose', 'rattache', 'ignore')),
  created_at       timestamptz not null default now()
);
create index if not exists emails_conversation_idx on emails (conversation_id);
create index if not exists emails_dossier_idx on emails (dossier_id, date desc);
create index if not exists emails_revue_idx on emails (revue_id);

create table if not exists propositions (
  id             bigint generated always as identity primary key,
  revue_id       bigint references revues(id) on delete cascade,
  dossier_id     bigint references dossiers(id) on delete cascade,
  dossier_cle    text,
  nature         text not null check (nature in ('creer_dossier', 'creer_tache', 'tache_faite', 'creer_echeance',
                                                  'echeance_tenue', 'etape_faite', 'ajouter_contact', 'changer_statut')),
  donnees        jsonb not null default '{}',
  justification  text,
  statut         text not null default 'proposee' check (statut in ('proposee', 'acceptee', 'refusee')),
  resultat       jsonb,
  decide_par     bigint references utilisateurs(id) on delete set null,
  decide_le      timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists propositions_revue_idx on propositions (revue_id);
create index if not exists propositions_cle_idx on propositions (dossier_cle) where statut = 'proposee';

-- Ce que l'avocat a demandé d'ignorer (refus mémorisés).
create table if not exists regles_agent (
  id         bigint generated always as identity primary key,
  nature     text not null check (nature in ('ignorer_expediteur', 'ignorer_domaine', 'ignorer_objet')),
  valeur     text not null,
  cree_par   bigint references utilisateurs(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (nature, valeur)
);

-- Réservé aux membres du cabinet.
do $$
declare t text;
begin
  foreach t in array array['agent_etat', 'revues', 'revue_dossiers', 'emails', 'propositions', 'regles_agent'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'membres du cabinet') then
      execute format('create policy "membres du cabinet" on public.%I for all to authenticated
                      using (public.est_membre()) with check (public.est_membre())', t);
    end if;
  end loop;
end $$;

/* ------------------------------------------------------------- contexte */

create or replace function public.agent_contexte() returns jsonb
language sql stable security definer set search_path = public as $$
select jsonb_build_object(
  'maintenant', now(),
  'derniere_lecture', (select derniere_lecture from agent_etat where id = 1),
  'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nom', c.nom, 'nature', c.nature) order by c.nom) from clients c), '[]'),
  'dossiers', coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'reference', d.reference, 'titre', d.titre, 'famille', d.famille, 'type', d.type, 'statut', d.statut,
      'client_id', d.client_id, 'echeance', d.echeance,
      'parties', coalesce((select jsonb_agg(jsonb_build_object('denomination', p.denomination, 'role', p.role)) from dossier_parties p where p.dossier_id = d.id), '[]'),
      'etapes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'libelle', e.libelle, 'statut', e.statut) order by e.ordre) from etapes e where e.dossier_id = d.id), '[]'),
      'taches_ouvertes', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'titre', t.titre, 'echeance', t.echeance)) from taches t where t.dossier_id = d.id and t.statut = 'a_faire'), '[]'),
      'echeances', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'libelle', x.libelle, 'date', x.date) order by x.date) from echeances x where x.dossier_id = d.id and x.statut = 'a_venir'), '[]')
    ) order by d.id) from dossiers d where d.statut in ('en_cours', 'en_attente', 'suspendu')), '[]'),
  'contacts', coalesce((select jsonb_agg(jsonb_build_object('email', lower(ct.email), 'nom', trim(ct.prenom || ' ' || ct.nom),
      'fonction', ct.fonction, 'client_id', ct.client_id)) from contacts ct where ct.email is not null), '[]'),
  'fils', coalesce((select jsonb_agg(f) from (select distinct jsonb_build_object('conversation_id', m.conversation_id, 'dossier_id', m.dossier_id) f
      from emails m where m.statut = 'rattache' and m.dossier_id is not null and m.conversation_id is not null) s), '[]'),
  'dossiers_proposes', coalesce((select jsonb_agg(jsonb_build_object('cle', pr.dossier_cle, 'titre', pr.donnees->>'titre', 'proposition_id', pr.id))
      from propositions pr where pr.nature = 'creer_dossier' and pr.statut = 'proposee'), '[]'),
  'propositions_en_attente', coalesce((select jsonb_agg(jsonb_build_object('id', pr.id, 'nature', pr.nature, 'dossier_id', pr.dossier_id,
      'dossier_cle', pr.dossier_cle, 'donnees', pr.donnees)) from propositions pr where pr.statut = 'proposee'), '[]'),
  'refusees_30_jours', coalesce((select jsonb_agg(jsonb_build_object('nature', pr.nature, 'dossier_id', pr.dossier_id, 'donnees', pr.donnees))
      from propositions pr where pr.statut = 'refusee' and pr.decide_le > now() - interval '30 days'), '[]'),
  'regles', coalesce((select jsonb_agg(jsonb_build_object('nature', r.nature, 'valeur', r.valeur)) from regles_agent r), '[]')
);
$$;

/* ---------------------------------------------------------------- dépôt */

create or replace function public.agent_deposer_revue(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_revue   bigint;
  v         jsonb;
  v_dossier bigint;
  v_fil     bigint;
  v_ignore  boolean;
  n_mails   integer := 0;
  n_fil     integer := 0;
  n_prop    integer := 0;
  n_rejet   integer := 0;
  natures   text[] := array['creer_dossier', 'creer_tache', 'tache_faite', 'creer_echeance', 'echeance_tenue',
                             'etape_faite', 'ajouter_contact', 'changer_statut'];
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Revue vide ou mal formée.';
  end if;

  insert into revues (moment, periode_debut, periode_fin, statut, stats, echeances, remarques)
  values (
    case when p->>'moment' in ('matin', 'apres_midi', 'reprise', 'manuelle') then p->>'moment' else 'matin' end,
    nullif(p->>'periode_debut', '')::timestamptz,
    coalesce(nullif(p->>'periode_fin', '')::timestamptz, now()),
    case when p->>'statut' = 'partielle' then 'partielle' else 'complete' end,
    coalesce(p->'stats', '{}'), coalesce(p->'echeances', '[]'), coalesce(p->'remarques', '[]'))
  returning id into v_revue;

  -- Blocs par dossier.
  for v in select * from jsonb_array_elements(coalesce(p->'dossiers', '[]')) loop
    v_dossier := (select d.id from dossiers d where d.id::text = v->>'dossier_id');
    insert into revue_dossiers (revue_id, dossier_id, cle, titre, priorite, faits, a_faire, en_attente, ordre)
    values (v_revue, v_dossier, case when v_dossier is null then nullif(v->>'cle', '') end,
            coalesce(nullif(v->>'titre', ''), 'Sans titre'),
            case when v->>'priorite' in ('haute', 'normale', 'basse', 'terminee') then v->>'priorite' else 'normale' end,
            coalesce(v->'faits', '[]'), coalesce(v->'a_faire', '[]'), coalesce(v->'en_attente', '[]'),
            coalesce(nullif(v->>'ordre', '')::integer, 0));
  end loop;

  -- Mails : un fil déjà rattaché suit son dossier ; sinon rattachement proposé.
  for v in select * from jsonb_array_elements(coalesce(p->'emails', '[]')) loop
    continue when coalesce(v->>'message_id', '') = '';
    v_ignore := coalesce((v->>'ignore')::boolean, false);
    v_dossier := (select d.id from dossiers d where d.id::text = v->>'dossier_id');
    v_fil := null;
    if not v_ignore and coalesce(v->>'conversation_id', '') <> '' then
      select m.dossier_id into v_fil from emails m
       where m.conversation_id = v->>'conversation_id' and m.statut = 'rattache' and m.dossier_id is not null
       order by m.date desc nulls last limit 1;
    end if;
    insert into emails (message_id, graph_id, conversation_id, sens, expediteur, destinataires, objet, date,
                        resume, lien, dossier_id, dossier_cle, revue_id, statut)
    values (v->>'message_id', v->>'graph_id', nullif(v->>'conversation_id', ''),
            case when v->>'sens' = 'envoye' then 'envoye' else 'recu' end,
            v->>'expediteur',
            coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(v->'destinataires', '[]')) x), '{}'),
            left(v->>'objet', 500), nullif(v->>'date', '')::timestamptz,
            case when v_ignore then null else left(v->>'resume', 2000) end,
            v->>'lien',
            case when v_ignore then null else coalesce(v_fil, v_dossier) end,
            case when v_ignore or v_fil is not null or v_dossier is not null then null else nullif(v->>'dossier_cle', '') end,
            v_revue,
            case when v_ignore then 'ignore' when v_fil is not null then 'rattache' else 'propose' end)
    on conflict (message_id) do nothing;
    if found then
      n_mails := n_mails + 1;
      if v_fil is not null then n_fil := n_fil + 1; end if;
    end if;
  end loop;

  -- Propositions : une nature inconnue est écartée, pas la revue entière.
  for v in select * from jsonb_array_elements(coalesce(p->'propositions', '[]')) loop
    if not (coalesce(v->>'nature', '') = any (natures)) then
      n_rejet := n_rejet + 1;
      continue;
    end if;
    v_dossier := (select d.id from dossiers d where d.id::text = v->>'dossier_id');
    insert into propositions (revue_id, dossier_id, dossier_cle, nature, donnees, justification)
    values (v_revue, v_dossier, case when v_dossier is null then nullif(v->>'dossier_cle', '') end,
            v->>'nature', coalesce(v->'donnees', '{}'), left(v->>'justification', 1000));
    n_prop := n_prop + 1;
  end loop;

  update agent_etat
     set derniere_lecture = (select periode_fin from revues where id = v_revue),
         derniere_revue_id = v_revue, updated_at = now()
   where id = 1;

  return jsonb_build_object('revue_id', v_revue, 'emails', n_mails, 'rattaches_par_fil', n_fil,
                            'propositions', n_prop, 'propositions_ecartees', n_rejet);
end;
$$;

-- Portes réservées au compte technique de l'assistant : aucun utilisateur
-- de l'application ne peut les appeler.
revoke execute on function public.agent_contexte(), public.agent_deposer_revue(jsonb) from public, anon, authenticated;
