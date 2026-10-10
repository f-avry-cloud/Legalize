-- ===========================================================================
-- Verrouillage de la base : seuls les membres du cabinet, connectés avec
-- double authentification, accèdent aux données.
--
-- Jusqu'ici chaque table portait une règle « demo acces complet » ouverte à
-- tous, y compris sans compte : la clé publique de l'application suffisait
-- pour tout lire et tout modifier. Ce script la remplace par une règle unique.
--
-- Un membre = une ligne active de `utilisateurs` (rôle autre que « client »)
-- dont l'adresse est celle du compte connecté. La double authentification
-- est faite quand la session est de niveau aal2 (code à usage unique), ou
-- quand la connexion vient d'un fournisseur d'identité (Microsoft), dont la
-- politique de sécurité s'applique.
--
-- Toute nouvelle table doit recevoir la même règle (voir la fin du script).
-- À exécuter dans le SQL editor du projet Supabase ; rejouable.
-- ===========================================================================

alter table public.utilisateurs alter column mot_de_passe drop not null;

create or replace function public.double_authentification() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
      or exists (
        select 1 from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) m
        where m ->> 'method' in ('oauth', 'sso/saml')
      );
$$;

-- security definer : lit `utilisateurs` sans repasser par ses propres règles.
create or replace function public.est_membre() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.double_authentification() and exists (
    select 1 from public.utilisateurs u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and u.actif and u.role <> 'client'
  );
$$;

create or replace function public.est_associe() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.double_authentification() and exists (
    select 1 from public.utilisateurs u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
      and u.actif and u.role = 'associe'
  );
$$;

revoke execute on function public.est_membre(), public.est_associe(), public.double_authentification() from anon, public;
grant execute on function public.est_membre(), public.est_associe(), public.double_authentification() to authenticated;

-- Tables : la règle « demo acces complet » laisse place à « membres du cabinet ».
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' loop
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('drop policy if exists "demo acces complet" on public.%I', t.relname);
    execute format('drop policy if exists "membres du cabinet" on public.%I', t.relname);
    if t.relname <> 'utilisateurs' then
      execute format('create policy "membres du cabinet" on public.%I for all to authenticated
                      using (public.est_membre()) with check (public.est_membre())', t.relname);
    end if;
  end loop;
end $$;

-- La liste des membres : lue par tous les membres, tenue par les associés.
drop policy if exists "membres du cabinet" on public.utilisateurs;
drop policy if exists "associes gerent les membres" on public.utilisateurs;
create policy "membres du cabinet" on public.utilisateurs for select to authenticated using (public.est_membre());
create policy "associes gerent les membres" on public.utilisateurs for all to authenticated
  using (public.est_associe()) with check (public.est_associe());

-- Vues : elles s'exécutaient avec les droits de leur propriétaire, donc
-- au-dessus des règles. Elles appliquent désormais celles de l'utilisateur.
do $$
declare v record;
begin
  for v in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'v' loop
    execute format('alter view public.%I set (security_invoker = on)', v.relname);
  end loop;
end $$;

-- Fichiers (bucket privé « documents »).
-- storage.objects appartient au compte technique du service de stockage : le
-- SQL editor (rôle postgres) ne peut pas modifier ces règles (« must be owner
-- of table objects »). À faire dans le tableau de bord : Storage → Policies →
-- bucket « documents » : supprimer les quatre règles « demo documents … », puis
-- créer une règle « membres documents », toutes opérations, rôle
-- authenticated, condition : bucket_id = 'documents' and public.est_membre().
-- Les instructions ci-dessous sont l'équivalent SQL, pour mémoire.
drop policy if exists "demo documents lecture" on storage.objects;
drop policy if exists "demo documents ecriture" on storage.objects;
drop policy if exists "demo documents maj" on storage.objects;
drop policy if exists "demo documents suppression" on storage.objects;
drop policy if exists "membres documents" on storage.objects;
create policy "membres documents" on storage.objects for all to authenticated
  using (bucket_id = 'documents' and public.est_membre())
  with check (bucket_id = 'documents' and public.est_membre());

-- Les sessions maison de l'ancien module de comptes ne servent plus.
delete from public.sessions_web;

-- Pour une nouvelle table :
--   alter table public.<t> enable row level security;
--   create policy "membres du cabinet" on public.<t> for all to authenticated
--     using (public.est_membre()) with check (public.est_membre());
