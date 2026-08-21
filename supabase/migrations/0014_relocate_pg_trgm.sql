-- =============================================================================
-- 0014_relocate_pg_trgm.sql
-- Decision: relocate pg_trgm out of public into a dedicated `extensions` schema, closing the
-- Supabase linter's "extension_in_public" warning permanently. Low-risk, one-time, no
-- functional change — the two GIN trigram indexes (0009) are dropped and recreated bound to
-- the relocated extension's operator class; ILIKE '%term%' queries keep working identically,
-- since the planner resolves index usage from the index definition itself, not by re-resolving
-- schema names per-query.
-- =============================================================================

create schema if not exists extensions;

drop index if exists idx_files_name_trgm;
drop index if exists idx_folders_name_trgm;
drop extension if exists pg_trgm;

create extension pg_trgm schema extensions;

create index idx_files_name_trgm
  on files using gin (name extensions.gin_trgm_ops)
  where deleted_at is null;

create index idx_folders_name_trgm
  on folders using gin (name extensions.gin_trgm_ops)
  where deleted_at is null;
