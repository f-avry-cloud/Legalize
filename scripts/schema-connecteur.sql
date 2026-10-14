-- Bucket PRIVÉ des pièces en transit du connecteur Claude (Guichet unique).
-- Aucune politique d'accès n'est créée : seul le serveur, avec la clé
-- secrète du projet (SUPABASE_SECRET_KEY), y lit et y écrit ; le navigateur
-- n'y dépose que par des URL de téléversement signées, émises fichier par
-- fichier. PDF uniquement, 10 Mo au maximum (limite du Guichet unique).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('connecteur-pieces', 'connecteur-pieces', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
