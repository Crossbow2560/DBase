-- =============================================================================
-- 0025_upload_part_functions.sql
-- One round trip per upload part instead of ~eleven.
--
-- Recording an upload part used to be an interactive Prisma transaction (BEGIN, lock the session,
-- look for the part, insert it, charge quota, COMMIT) plus separate session / destination /
-- permission / name-collision queries — about eleven sequential round trips to a remote pooler per
-- part, which dominated upload time (≈600 ms per 5 MiB part at a 50 ms round trip). These
-- functions do the same work, with the same guarantees, in a single statement:
--
--   * the session row is locked FOR UPDATE while the part is recorded and charged, so two
--     concurrent retries of the same part charge once, and an abort (which updates the same row)
--     either waits and then sees this part, or wins first and this part is rejected uncharged;
--   * the part row is inserted BEFORE quota is charged, so a duplicate is detected by the primary
--     key and never charged;
--   * a quota failure raises, rolling back the part row in the same statement.
--
-- Destination validity (folder still live, name still free) is checked when the session is opened
-- and again at completion, not per part: nothing a part does depends on it, and completion is
-- where a stale destination actually matters.
-- =============================================================================

-- Outcomes: 'recorded' | 'duplicate' | 'session_gone' | 'part_out_of_range' | 'part_too_small'
-- | 'part_too_large'. Raises QUOTA_EXCEEDED (and the system-limit trigger's own exception) instead
-- of returning, so the part row is rolled back with it.
create function record_upload_part(
  p_session_id uuid,
  p_user_id uuid,
  p_part_number integer,
  p_size_bytes bigint,
  p_min_part_bytes bigint,
  p_max_part_bytes bigint
)
returns table (outcome text, total_parts integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_total_parts integer;
  v_expires_at timestamptz;
begin
  select s.total_parts, s.expires_at into v_total_parts, v_expires_at
  from upload_sessions s
  where s.id = p_session_id and s.user_id = p_user_id and s.status = 'pending'
  for update;

  if not found or v_expires_at < now() then
    return query select 'session_gone'::text, null::integer;
    return;
  end if;
  if p_part_number < 0 or p_part_number >= v_total_parts then
    return query select 'part_out_of_range'::text, v_total_parts;
    return;
  end if;
  if p_size_bytes > p_max_part_bytes then
    return query select 'part_too_large'::text, v_total_parts;
    return;
  end if;
  if p_part_number < v_total_parts - 1 and p_size_bytes < p_min_part_bytes then
    return query select 'part_too_small'::text, v_total_parts;
    return;
  end if;

  insert into upload_session_parts (upload_session_id, part_number, size_bytes)
  values (p_session_id, p_part_number, p_size_bytes)
  on conflict do nothing;
  if not found then
    return query select 'duplicate'::text, v_total_parts;
    return;
  end if;

  update users
  set storage_used_bytes = storage_used_bytes + p_size_bytes
  where id = p_user_id and storage_used_bytes + p_size_bytes <= storage_quota_bytes;
  if not found then
    raise exception 'QUOTA_EXCEEDED: upload part would exceed the storage quota';
  end if;

  return query select 'recorded'::text, v_total_parts;
end;
$$;

-- Undo a recorded part whose bytes never reached storage (the write to MinIO failed). Only while
-- the session is still pending: once it's aborted, the abort has already refunded every part row it
-- saw, this one included. Returns whether anything was released.
create function release_upload_part(p_session_id uuid, p_user_id uuid, p_part_number integer)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_size bigint;
begin
  perform 1 from upload_sessions
  where id = p_session_id and user_id = p_user_id and status = 'pending'
  for update;
  if not found then
    return false;
  end if;

  delete from upload_session_parts
  where upload_session_id = p_session_id and part_number = p_part_number
  returning size_bytes into v_size;
  if not found then
    return false;
  end if;

  update users set storage_used_bytes = storage_used_bytes - v_size where id = p_user_id;
  return true;
end;
$$;
