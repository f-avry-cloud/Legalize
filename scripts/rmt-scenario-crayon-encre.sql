\set ON_ERROR_STOP on
insert into societes (denomination, forme_sociale, siren) values ('TEST SAS','SAS','978382513');
insert into rmt_societes (societe_id, forme, titres_numerotes) values (1,'SAS',true);
insert into rmt_categories (societe_id, code, libelle, nominal) values (1,'ORD','Actions ordinaires',1);
insert into rmt_titulaires (societe_id, type, nom) values (1,'physique','DUPONT'),(1,'physique','MARTIN');
insert into rmt_comptes (societe_id, numero, type) values (1,'C001','pleine_propriete'),(1,'C002','pleine_propriete');
insert into utilisateurs (email, nom, role, mot_de_passe) values ('a@x.fr','AVRY','associe','x');
insert into rmt_mouvements (societe_id, ordre) values (1,1);
insert into rmt_mouvement_versions (mouvement_id, numero_version, action, nature, categorie_id, quantite, numeros, compte_credite, date_inscription, auteur_id)
  values (1,1,'creation','souscription',1,100,'{[1,100]}',1,'2026-01-15',1);

\echo '--- 1. apres creation (attendu CRAYON)'
select statut from rmt_etat_mouvements where mouvement_id=1;

insert into rmt_extraits (societe_id, reference, type, date_arrete, contenu, empreinte, certifiant_nom, jeton_verification)
  values (1,'EXT-2026-0001','registre_complet', now(), '{}', 'h1', 'Me AVRY', 'jeton-secret-1');
insert into rmt_extrait_mouvements (extrait_id, mouvement_id, version_id) values (1,1,1);
\echo '--- 2. apres certification (attendu ENCRE)'
select statut from rmt_etat_mouvements where mouvement_id=1;

insert into rmt_mouvement_versions (mouvement_id, numero_version, action, nature, categorie_id, quantite, numeros, compte_credite, date_inscription, auteur_id, motif_code, motif)
  values (1,2,'modification','souscription',1,150,'{[1,150]}',1,'2026-01-15',1,'erreur_saisie','Quantite rectifiee');
\echo '--- 3. apres modification (attendu ENCRE_MODIFIEE)'
select statut, numero_version from rmt_etat_mouvements where mouvement_id=1;

insert into rmt_extraits (societe_id, reference, type, date_arrete, contenu, empreinte, empreinte_precedente, certifiant_nom, jeton_verification)
  values (1,'EXT-2026-0002','registre_complet', now(), '{}', 'h2', 'h1', 'Me AVRY', 'jeton-secret-2');
insert into rmt_extrait_mouvements (extrait_id, mouvement_id, version_id) values (2,1,2);
update rmt_extraits set statut='devenu_inexact', devenu_inexact_le=now() where id=1;
\echo '--- 4. apres nouvel extrait (attendu ENCRE, indicateur leve)'
select statut from rmt_etat_mouvements where mouvement_id=1;

insert into rmt_mouvement_versions (mouvement_id, numero_version, action, nature, categorie_id, auteur_id, motif_code, motif)
  values (1,3,'suppression','souscription',1,1,'ordre_annule','Ordre de mouvement annule');
\echo '--- 5. apres suppression (attendu ENCRE_SUPPRIMEE)'
select statut from rmt_etat_mouvements where mouvement_id=1;

update rmt_extraits set statut='revoque', revoque_le=now() where id in (1,2);
\echo '--- 6. apres revocation des deux extraits (attendu CRAYON)'
select statut from rmt_etat_mouvements where mouvement_id=1;

\echo '--- 7. historique complet conserve (attendu 3 versions)'
select count(*) from rmt_mouvement_versions where mouvement_id=1;

\echo '--- 8. numeros de titres : chevauchement detecte par multirange'
select '{[1,100]}'::int4multirange * '{[50,150]}'::int4multirange as chevauchement,
       numrange_subdiff(1,1) is not null as ok;
