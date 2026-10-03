-- =============================================================================
-- 0023_folder_scoped_sibling_names.sql
-- Sibling-name uniqueness is now scoped to the containing folder, not (owner, folder).
--
-- 0002 keyed both uq_folders_sibling_name and uq_files_sibling_name on owner_id, reasoning that
-- "parent_folder_id there is already a single folder id that itself only ever belongs to one
-- owner". That stopped being true once editors could create folders and upload files inside
-- someone else's shared folder: each new item is owned by its creator, so an owner's `x.txt` and
-- an editor's `x.txt` could coexist in the same folder — two visually identical entries that
-- REQUIREMENTS.md §5.2's unique-sibling-name rule forbids.
--
-- New rule:
--   * inside a folder:  unique (parent folder, name) among live rows, regardless of owner
--   * at the root:      unique (owner, name) — each user's root is their own namespace, and
--                       root rows have no parent to scope by (same NULL issue 0002 describes)
--
-- Existing live duplicates (only possible inside shared folders) are renamed first, so creating
-- the new indexes can't fail on deploy: the oldest row keeps its name, every later one gets
-- " (<first 8 chars of its id>)" appended, truncated on a character boundary to stay within the
-- 255-byte name limit (files/folders_name_byte_length).
-- =============================================================================

create function pg_temp.dedupe_name(p_name text, p_id uuid)
returns text
language plpgsql
as $$
declare
  v_suffix text := ' (' || left(p_id::text, 8) || ')';
  v_base text := p_name;
begin
  while octet_length(v_base || v_suffix) > 255 loop
    v_base := left(v_base, length(v_base) - 1);
  end loop;
  return v_base || v_suffix;
end;
$$;

-- Folders: the trigger 0002 guards owner_id only, so renaming is a plain UPDATE.
with ranked as (
  select id,
         row_number() over (partition by parent_folder_id, name order by created_at, id) as rn
  from folders
  where deleted_at is null and parent_folder_id is not null
)
update folders f
set name = pg_temp.dedupe_name(f.name, f.id)
from ranked r
where f.id = r.id and r.rn > 1;

with ranked as (
  select id,
         row_number() over (partition by folder_id, name order by created_at, id) as rn
  from files
  where deleted_at is null and folder_id is not null
)
update files f
set name = pg_temp.dedupe_name(f.name, f.id)
from ranked r
where f.id = r.id and r.rn > 1;

drop index uq_folders_sibling_name;
drop index uq_files_sibling_name;

create unique index uq_folders_sibling_name
  on folders (parent_folder_id, name)
  where deleted_at is null and parent_folder_id is not null;

create unique index uq_folders_root_name
  on folders (owner_id, name)
  where deleted_at is null and parent_folder_id is null;

create unique index uq_files_sibling_name
  on files (folder_id, name)
  where deleted_at is null and folder_id is not null;

create unique index uq_files_root_name
  on files (owner_id, name)
  where deleted_at is null and folder_id is null;

-- Temp objects outlive the transaction on a pooled session — don't leave it behind.
drop function pg_temp.dedupe_name(text, uuid);
