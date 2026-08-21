-- =============================================================================
-- 0009_search_indexes.sql
-- Subcomponent 8 (IMPLEMENTATION_PHASES.md): name-search indexes
-- Source: DESIGN.md v7 §5.4 (Pass 6); REQUIREMENTS.md §5.3
-- Independent of every other subcomponent besides Core Filesystem (0002) — pg_trgm is
-- enabled in 0001.
-- =============================================================================

-- Partial + case-insensitive substring matching (REQUIREMENTS.md §5.3) cannot be served by a
-- plain B-tree (prefix-only); pg_trgm GIN indexes support ILIKE '%term%'-style queries.
-- Scoped WHERE deleted_at IS NULL, same as every other partial index in this schema — search
-- results exclude trashed items by default.
create index idx_files_name_trgm
  on files using gin (name gin_trgm_ops)
  where deleted_at is null;

create index idx_folders_name_trgm
  on folders using gin (name gin_trgm_ops)
  where deleted_at is null;
