-- ===========================================================================
-- Module « Registre des mouvements de titres » (RMT) — Supabase / Postgres 17
--
-- Philosophie « le crayon et l'encre » : aucune écriture n'est immuable. La
-- sécurité juridique vient de l'historique complet des versions et des
-- extraits certifiés, qui figent un état daté et vérifiable.
--
-- Deux principes de conception en découlent :
--
--   1. Une écriture est une IDENTITÉ STABLE (rmt_mouvements) plus une SUITE DE
--      VERSIONS (rmt_mouvement_versions). Le contenu vit dans la version ; la
--      table d'identité ne porte que ce qui ne doit jamais changer et le n°
--      d'affichage, lui recalculable. Une suppression est une version de type
--      « suppression », jamais un DELETE.
--
--   2. Le statut crayon / encre n'est PAS stocké : il se déduit des extraits
--      qui couvrent l'écriture (vue rmt_etat_mouvements). Un statut stocké
--      finirait par mentir le jour où une certification échoue à mi-chemin.
--
-- À exécuter dans le SQL editor du projet Supabase.
-- ===========================================================================

-- ------------------------------------------------------------------ comptes

-- L'application n'avait aucune authentification. La double validation des
-- suppressions et le journal d'audit ne valent rien sans identité réelle :
-- « l'associé qui approuve » doit être quelqu'un.
create table if not exists utilisateurs (
  id            bigint generated always as identity primary key,
  email         text not null unique,
  nom           text not null default '',
  prenom        text not null default '',
  -- assistant < collaborateur < associe ; « client » ne voit que les extraits
  -- certifiés des sociétés qui lui sont rattachées.
  role          text not null default 'collaborateur'
                check (role in ('assistant', 'collaborateur', 'associe', 'client')),
  mot_de_passe  text not null,              -- scrypt, jamais en clair
  actif         boolean not null default true,
  dernier_acces timestamptz,
  created_at    timestamptz not null default now()
);

-- Rattachement d'un utilisateur « client » aux sociétés qu'il peut consulter.
create table if not exists utilisateur_societes (
  utilisateur_id bigint not null references utilisateurs(id) on delete cascade,
  societe_id     bigint not null references societes(id) on delete cascade,
  primary key (utilisateur_id, societe_id)
);

create table if not exists sessions_web (
  jeton       text primary key,
  utilisateur_id bigint not null references utilisateurs(id) on delete cascade,
  expire_le   timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_web_expire_idx on sessions_web (expire_le);

-- --------------------------------------------------- paramètres par société

-- Extension RMT de la fiche société : ce que le registre exige et que la
-- table `societes` ne porte pas.
create table if not exists rmt_societes (
  societe_id        bigint primary key references societes(id) on delete cascade,
  -- Le module ne couvre que les sociétés par actions. Les parts sociales
  -- (SARL, SNC, sociétés civiles) obéissent à d'autres règles de cession et
  -- ne se tiennent pas en comptes de titres : un refus explicite vaut mieux
  -- qu'un registre faux.
  forme             text not null check (forme in ('SA', 'SAS', 'SASU', 'SCA')),
  titres_numerotes  boolean not null default false,
  -- Qui signe les extraits certifiés, choisi société par société.
  certifiant_type   text not null default 'avocat'
                    check (certifiant_type in ('representant_legal', 'avocat')),
  certifiant_nom    text,
  certifiant_qualite text,
  -- Clauses statutaires : le texte fait foi, le drapeau déclenche l'alerte.
  clause_agrement        boolean not null default false,
  clause_agrement_texte  text,
  clause_preemption      boolean not null default false,
  clause_preemption_texte text,
  clause_inalienabilite  boolean not null default false,
  clause_inalienabilite_texte text,
  clause_sortie_conjointe boolean not null default false,
  clause_sortie_conjointe_texte text,
  clause_drag_along      boolean not null default false,
  clause_drag_along_texte text,
  clause_tag_along       boolean not null default false,
  clause_tag_along_texte text,
  preponderance_immobiliere boolean not null default false,
  -- Seuils de détention surveillés, en pourcentage : [10, 25, 33.34, 50]
  seuils_surveilles numeric(6,3)[] not null default '{}',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Catégories de titres : ordinaires, de préférence A, B… Le nominal est porté
-- par la catégorie et non par la société, une division de nominal ne touchant
-- pas forcément toutes les catégories.
create table if not exists rmt_categories (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  code          text not null,              -- ORD, PREF_A, PREF_B…
  libelle       text not null,
  nominal       numeric(18,6),
  droits        text,                       -- droits particuliers, en texte
  ordre         integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (societe_id, code)
);

-- Nombre de titres émis par catégorie, à chaque décision sociale. L'invariant
-- « Σ soldes = titres émis » se contrôle contre cette table, et non contre un
-- nombre figé dans la fiche société.
create table if not exists rmt_emissions (
  id            bigint generated always as identity primary key,
  categorie_id  bigint not null references rmt_categories(id) on delete cascade,
  date_effet    date not null,
  quantite      bigint not null,            -- variation, signée
  decision      text not null,              -- « AGE du 12/03/2026 — augmentation de capital »
  justificatif_id bigint,                   -- référence posée plus bas
  created_at    timestamptz not null default now()
);
create index if not exists rmt_emissions_cat_idx on rmt_emissions (categorie_id, date_effet);

-- ------------------------------------------------------- titulaires, comptes

create table if not exists rmt_titulaires (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  type          text not null check (type in ('physique', 'morale')),
  -- personne physique
  civilite      text,
  nom           text,
  nom_usage     text,
  prenoms       text,
  date_naissance date,
  lieu_naissance text,
  nationalite   text,
  -- personne morale
  denomination  text,
  forme_juridique text,
  siren         text,
  rcs_ville     text,
  representant  text,
  -- commun
  adresse       text,
  email         text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint rmt_titulaire_identifie check (
    (type = 'physique' and nom is not null)
    or (type = 'morale' and denomination is not null)
  )
);
create index if not exists rmt_titulaires_societe_idx on rmt_titulaires (societe_id);

-- Un compte par titulaire ET par nature de droit : la pleine propriété, la
-- nue-propriété et l'usufruit d'un même démembrement sont trois comptes
-- distincts, reliés entre eux.
create table if not exists rmt_comptes (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  numero        text not null,
  type          text not null check (type in ('pleine_propriete', 'indivision', 'nue_propriete', 'usufruit')),
  -- Relie le compte de nue-propriété à celui d'usufruit d'un même
  -- démembrement : sans ce lien, la réunion d'usufruit est indécidable.
  demembrement_id bigint,
  ouvert_le     date,
  clos_le       date,
  notes         text,
  created_at    timestamptz not null default now(),
  unique (societe_id, numero)
);
create index if not exists rmt_comptes_societe_idx on rmt_comptes (societe_id);
create index if not exists rmt_comptes_demembrement_idx on rmt_comptes (demembrement_id);

-- N-N : l'indivision a plusieurs titulaires sur un même compte.
create table if not exists rmt_comptes_titulaires (
  compte_id    bigint not null references rmt_comptes(id) on delete cascade,
  titulaire_id bigint not null references rmt_titulaires(id) on delete cascade,
  quote_part   numeric(7,4),                -- en % pour une indivision
  primary key (compte_id, titulaire_id)
);

-- ------------------------------------------------------ écritures et versions

-- Identité d'une écriture. L'identifiant n'est jamais réutilisé ; le n° d'ordre
-- d'affichage se recalcule à chaque insertion ou déplacement.
create table if not exists rmt_mouvements (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  ordre         numeric(20,10) not null,    -- décimal : insérer entre 3 et 4 sans tout renuméroter
  created_at    timestamptz not null default now()
);
create index if not exists rmt_mouvements_societe_idx on rmt_mouvements (societe_id, ordre);

-- Toute création, modification, déplacement, suppression ou restauration crée
-- une version. Rien n'est jamais écrasé ni effacé.
create table if not exists rmt_mouvement_versions (
  id            bigint generated always as identity primary key,
  mouvement_id  bigint not null references rmt_mouvements(id) on delete cascade,
  numero_version integer not null,
  action        text not null check (action in
                  ('creation', 'modification', 'deplacement', 'suppression', 'restauration')),

  -- --- contenu de l'écriture (repris intégralement à chaque version) ---
  date_inscription date,
  date_effet       date,                    -- date de l'ordre de mouvement
  nature        text not null check (nature in (
                  'souscription', 'cession', 'apport', 'donation', 'succession',
                  'fusion_tup', 'demembrement', 'reunion_usufruit', 'conversion',
                  'division_nominal', 'regroupement_nominal', 'annulation')),
  categorie_id  bigint references rmt_categories(id) on delete restrict,
  quantite      bigint,
  -- Numéros de titres, si la société les numérote. Le type multirange permet
  -- de détecter nativement les doublons et les trous : '{[1,100],[151,200]}'.
  numeros       int4multirange,
  compte_debite bigint references rmt_comptes(id) on delete restrict,
  compte_credite bigint references rmt_comptes(id) on delete restrict,
  prix_unitaire numeric(18,6),
  prix_total    numeric(18,2),
  devise        text not null default 'EUR',
  observations  text,

  -- --- métadonnées de version ---
  ordre_affiche numeric(20,10),             -- n° d'ordre au moment de la version
  auteur_id     bigint references utilisateurs(id) on delete set null,
  motif_code    text,                       -- erreur_saisie, acte_rectificatif, ordre_annule…
  motif         text,
  cree_le       timestamptz not null default now(),
  unique (mouvement_id, numero_version)
);
create index if not exists rmt_versions_mouvement_idx on rmt_mouvement_versions (mouvement_id, numero_version desc);

-- La version courante d'une écriture : la plus récente.
create or replace view rmt_versions_courantes as
select distinct on (v.mouvement_id) v.*
from rmt_mouvement_versions v
order by v.mouvement_id, v.numero_version desc;

-- ------------------------------------------------------------ justificatifs

create table if not exists rmt_justificatifs (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  mouvement_id  bigint references rmt_mouvements(id) on delete set null,
  type          text not null check (type in (
                  'ordre_mouvement', 'bulletin_souscription', 'certificat_depositaire',
                  'acte_donation', 'attestation_notariale', 'proces_verbal',
                  'enregistrement_fiscal', 'agrement', 'purge_preemption', 'autre')),
  nom_fichier   text not null,
  chemin        text not null,              -- Supabase Storage
  taille        bigint,
  date_piece    date,
  depose_par    bigint references utilisateurs(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists rmt_justificatifs_mouvement_idx on rmt_justificatifs (mouvement_id);

alter table rmt_emissions
  drop constraint if exists rmt_emissions_justificatif_fkey;
alter table rmt_emissions
  add constraint rmt_emissions_justificatif_fkey
  foreign key (justificatif_id) references rmt_justificatifs(id) on delete set null;

-- --------------------------------------------------- mentions sans transfert

-- Nantissement, séquestre, saisie, inaliénabilité temporaire : elles grèvent
-- les titres sans les transférer, et doivent apparaître sur la fiche de compte
-- comme dans l'alerte déclenchée par une cession.
create table if not exists rmt_mentions (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  compte_id     bigint not null references rmt_comptes(id) on delete cascade,
  type          text not null check (type in
                  ('nantissement', 'sequestre', 'saisie', 'inalienabilite', 'autre')),
  quantite      bigint,
  numeros       int4multirange,
  beneficiaire  text,
  date_debut    date not null,
  date_fin      date,
  mainlevee_le  date,
  justificatif_id bigint references rmt_justificatifs(id) on delete set null,
  observations  text,
  created_at    timestamptz not null default now()
);
create index if not exists rmt_mentions_compte_idx on rmt_mentions (compte_id);

-- ---------------------------------------------------- extraits certifiés

-- Le seul objet figé du module. Contenu gelé, empreinte, chaînage.
create table if not exists rmt_extraits (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  reference     text not null unique,       -- EXT-2026-0007
  type          text not null check (type in (
                  'registre_complet', 'compte_individuel',
                  'attestation_inscription', 'table_capitalisation')),
  perimetre     jsonb not null default '{}'::jsonb,  -- {compte_id} ou {categorie_id}…
  date_arrete   timestamptz not null,       -- état du registre reflété
  contenu       jsonb not null,             -- données figées, source du PDF
  pdf_chemin    text,
  empreinte     text not null,              -- sha256 du contenu canonique
  empreinte_precedente text,                -- chaînage avec l'extrait précédent
  signature     jsonb,                      -- {format: 'PAdES', certificat, horodatage}
  certifiant_id bigint references utilisateurs(id) on delete set null,
  certifiant_nom text not null,
  certifiant_qualite text,
  certifie_le   timestamptz not null default now(),
  -- Le jeton du QR code : long, aléatoire, non devinable. La page publique
  -- n'expose que le statut et l'empreinte, jamais le contenu du registre.
  jeton_verification text not null unique,
  statut        text not null default 'a_jour'
                check (statut in ('a_jour', 'devenu_inexact', 'revoque')),
  devenu_inexact_le timestamptz,
  revoque_le    timestamptz,
  revoque_par   bigint references utilisateurs(id) on delete set null,
  revocation_motif text,
  created_at    timestamptz not null default now()
);
create index if not exists rmt_extraits_societe_idx on rmt_extraits (societe_id, certifie_le desc);

-- Quelle version exacte de quelle écriture chaque extrait a figée. C'est de
-- cette table que se déduit tout le crayon / encre.
create table if not exists rmt_extrait_mouvements (
  extrait_id    bigint not null references rmt_extraits(id) on delete cascade,
  mouvement_id  bigint not null references rmt_mouvements(id) on delete cascade,
  version_id    bigint not null references rmt_mouvement_versions(id) on delete cascade,
  primary key (extrait_id, mouvement_id)
);
create index if not exists rmt_extrait_mouvements_mvt_idx on rmt_extrait_mouvements (mouvement_id);

create table if not exists rmt_extrait_destinataires (
  id            bigint generated always as identity primary key,
  extrait_id    bigint not null references rmt_extraits(id) on delete cascade,
  nom           text not null,
  qualite       text,                       -- banque, acquéreur, commissaire aux comptes…
  email         text,
  declare_le    timestamptz not null default now()
);

-- ----------------------------------------- état crayon / encre d'une écriture
--
-- Déduit, jamais stocké :
--   CRAYON          aucun extrait ne la couvre
--   ENCRE           un extrait couvre sa version courante
--   ENCRE_MODIFIEE  un extrait couvre une version antérieure
--   ENCRE_SUPPRIMEE couverte, puis supprimée
--
-- Les extraits révoqués ne comptent pas : un extrait révoqué ne couvre plus
-- rien, et l'écriture doit pouvoir redevenir libre.
create or replace view rmt_etat_mouvements as
select
  m.id            as mouvement_id,
  m.societe_id,
  m.ordre,
  vc.id           as version_id,
  vc.numero_version,
  vc.action,
  case
    when couverture.mouvement_id is null then 'CRAYON'
    when vc.action = 'suppression'       then 'ENCRE_SUPPRIMEE'
    when couverture.version_id = vc.id   then 'ENCRE'
    else 'ENCRE_MODIFIEE'
  end             as statut,
  couverture.extrait_id   as dernier_extrait_id,
  couverture.version_id   as version_certifiee_id
from rmt_mouvements m
join rmt_versions_courantes vc on vc.mouvement_id = m.id
left join lateral (
  select em.mouvement_id, em.extrait_id, em.version_id
  from rmt_extrait_mouvements em
  join rmt_extraits e on e.id = em.extrait_id
  where em.mouvement_id = m.id and e.statut <> 'revoque'
  order by e.certifie_le desc
  limit 1
) couverture on true;

-- --------------------------------------- suppression d'une écriture à l'encre

-- Double validation : demande par un collaborateur, approbation par un associé.
create table if not exists rmt_demandes_suppression (
  id            bigint generated always as identity primary key,
  mouvement_id  bigint not null references rmt_mouvements(id) on delete cascade,
  demandeur_id  bigint not null references utilisateurs(id) on delete restrict,
  motif_code    text not null,
  motif         text not null,
  extraits_impactes jsonb not null default '[]'::jsonb,
  statut        text not null default 'en_attente'
                check (statut in ('en_attente', 'approuvee', 'refusee', 'annulee')),
  decideur_id   bigint references utilisateurs(id) on delete set null,
  decision_le   timestamptz,
  decision_motif text,
  created_at    timestamptz not null default now()
);
create index if not exists rmt_demandes_statut_idx on rmt_demandes_suppression (statut);

-- ------------------------------------------------------- alertes acquittées

-- « L'outil signale, l'avocat décide » : l'acquittement est tracé et ne vaut
-- que pour la version acquittée. Une nouvelle version rouvre l'alerte.
create table if not exists rmt_alertes_acquittees (
  id            bigint generated always as identity primary key,
  societe_id    bigint not null references societes(id) on delete cascade,
  mouvement_id  bigint references rmt_mouvements(id) on delete cascade,
  version_id    bigint references rmt_mouvement_versions(id) on delete cascade,
  code          text not null,              -- clause_agrement, mention_active, seuil…
  commentaire   text,
  acquitte_par  bigint not null references utilisateurs(id) on delete restrict,
  acquitte_le   timestamptz not null default now(),
  unique (version_id, code)
);

-- --------------------------------------------- droits d'enregistrement

-- Taux paramétrables, jamais codés en dur. Les valeurs initiales sont des
-- propositions à valider par le cabinet, pas du droit établi : elles portent
-- un drapeau `valide` tant que personne ne les a confirmées.
create table if not exists rmt_taux_enregistrement (
  id            bigint generated always as identity primary key,
  libelle       text not null,
  applicable_a  text not null,              -- actions, preponderance_immobiliere…
  taux          numeric(8,5) not null,
  abattement    numeric(18,2) not null default 0,
  plafond       numeric(18,2),
  delai_jours   integer,
  en_vigueur_du date not null,
  en_vigueur_au date,
  reference_texte text,                     -- article du CGI
  valide        boolean not null default false,
  valide_par    bigint references utilisateurs(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------ journal d'audit

-- Toutes les actions, y compris les consultations d'extraits certifiés.
create table if not exists rmt_audit (
  id            bigint generated always as identity primary key,
  societe_id    bigint references societes(id) on delete set null,
  utilisateur_id bigint references utilisateurs(id) on delete set null,
  action        text not null,              -- mouvement.modifie, extrait.consulte…
  objet_type    text,
  objet_id      bigint,
  details       jsonb not null default '{}'::jsonb,
  adresse_ip    inet,
  created_at    timestamptz not null default now()
);
create index if not exists rmt_audit_societe_idx on rmt_audit (societe_id, created_at desc);
create index if not exists rmt_audit_objet_idx on rmt_audit (objet_type, objet_id);

-- ------------------------------------------------- soldes et cohérence
--
-- Le registre est la source de vérité : les soldes ne sont jamais stockés,
-- ils se recalculent depuis les versions courantes. Une écriture supprimée
-- ne compte plus, mais reste dans l'historique.

create or replace view rmt_soldes as
select
  m.societe_id,
  mouvements.compte_id,
  mouvements.categorie_id,
  sum(mouvements.sens * mouvements.quantite) as solde
from rmt_mouvements m
join rmt_versions_courantes vc on vc.mouvement_id = m.id and vc.action <> 'suppression'
cross join lateral (
  values
    (vc.compte_credite, vc.categorie_id,  1::int, coalesce(vc.quantite, 0)),
    (vc.compte_debite,  vc.categorie_id, -1::int, coalesce(vc.quantite, 0))
) as mouvements(compte_id, categorie_id, sens, quantite)
where mouvements.compte_id is not null
group by m.societe_id, mouvements.compte_id, mouvements.categorie_id;

-- Même calcul arrêté à une date : sert au contrôle « solde négatif à
-- n'importe quelle date de l'historique », qu'un solde final positif masque.
create or replace function rmt_soldes_a_date(p_societe_id bigint, p_date date)
returns table (compte_id bigint, categorie_id bigint, solde bigint)
language sql stable as $$
  select mouvements.compte_id, mouvements.categorie_id,
         sum(mouvements.sens * mouvements.quantite)::bigint
  from rmt_mouvements m
  join rmt_versions_courantes vc on vc.mouvement_id = m.id and vc.action <> 'suppression'
  cross join lateral (
    values
      (vc.compte_credite, vc.categorie_id,  1::int, coalesce(vc.quantite, 0)),
      (vc.compte_debite,  vc.categorie_id, -1::int, coalesce(vc.quantite, 0))
  ) as mouvements(compte_id, categorie_id, sens, quantite)
  where m.societe_id = p_societe_id
    and mouvements.compte_id is not null
    and coalesce(vc.date_effet, vc.date_inscription) <= p_date
  group by mouvements.compte_id, mouvements.categorie_id;
$$;

-- Titres émis par catégorie, cumulés depuis les décisions sociales.
create or replace view rmt_titres_emis as
select c.societe_id, c.id as categorie_id, c.code, c.libelle, c.nominal,
       coalesce(sum(e.quantite), 0)::bigint as emis
from rmt_categories c
left join rmt_emissions e on e.categorie_id = c.id
group by c.societe_id, c.id, c.code, c.libelle, c.nominal;

-- ---------------------------------------------------------------------------
-- Réconciliation du capital.
--
-- Trois chiffres disent la même chose et peuvent diverger : le capital porté
-- par la fiche société, le nombre de titres qu'elle indique, et ce que le
-- registre contient réellement. Plutôt que d'imposer une double saisie, on
-- expose les trois et l'écart, à charge pour l'écran de proposer la
-- correction — aligner la fiche sur le registre, ou l'inverse.
--
-- L'identité vérifiée est : Σ (titres émis × nominal) = capital social.
-- ---------------------------------------------------------------------------
create or replace view rmt_coherence_capital as
select
  s.id                                          as societe_id,
  s.denomination,
  s.capital_social                              as capital_fiche,
  s.nb_titres                                   as titres_fiche,
  registre.titres_emis,
  registre.titres_detenus,
  registre.capital_calcule,
  registre.nominal_indetermine,
  -- Écarts : null quand l'information manque, 0 quand tout concorde.
  case when s.capital_social is null or registre.capital_calcule is null then null
       else round(s.capital_social - registre.capital_calcule, 2) end as ecart_capital,
  case when s.nb_titres is null then null
       else s.nb_titres - registre.titres_emis end                    as ecart_titres,
  -- Invariant du registre lui-même : ce qui est émis doit être détenu.
  registre.titres_emis - registre.titres_detenus                      as ecart_emis_detenus
from societes s
join lateral (
  select
    coalesce(sum(te.emis), 0)::bigint                               as titres_emis,
    coalesce(sum(det.detenus), 0)::bigint                           as titres_detenus,
    case when bool_or(te.nominal is null) then null
         else sum(te.emis * te.nominal) end                         as capital_calcule,
    bool_or(te.nominal is null)                                     as nominal_indetermine
  from rmt_titres_emis te
  left join lateral (
    select coalesce(sum(so.solde), 0)::bigint as detenus
    from rmt_soldes so where so.categorie_id = te.categorie_id
  ) det on true
  where te.societe_id = s.id
) registre on true;

-- ------------------------------------------------------------------- RLS
--
-- Posture identique au reste du MVP : RLS activé, avec une policy permissive
-- « demo acces complet ». Le contrôle d'accès ne se fera pas table par table
-- mais par une brique d'authentification qui restreindra l'accès général de
-- l'application. Une exception locale ici n'aurait fait que compliquer le
-- module sans rien protéger tant que le reste est ouvert.

do $$
declare t text;
begin
  foreach t in array array[
    'utilisateurs', 'utilisateur_societes', 'sessions_web',
    'rmt_societes', 'rmt_categories', 'rmt_emissions', 'rmt_titulaires',
    'rmt_comptes', 'rmt_comptes_titulaires', 'rmt_mouvements',
    'rmt_mouvement_versions', 'rmt_justificatifs', 'rmt_mentions',
    'rmt_extraits', 'rmt_extrait_mouvements', 'rmt_extrait_destinataires',
    'rmt_demandes_suppression', 'rmt_alertes_acquittees',
    'rmt_taux_enregistrement', 'rmt_audit'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "demo acces complet" on %I', t);
    execute format('create policy "demo acces complet" on %I for all using (true) with check (true)', t);
  end loop;
end $$;
