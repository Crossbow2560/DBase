-- =============================================================================
-- 0010_enable_rls.sql
-- Enable RLS, deliberately with zero policies, on every table.
--
-- This does NOT change how the application behaves: the app connects via the service_role
-- key, which Supabase configures to bypass RLS unconditionally, so access.checkPermission()
-- remains the sole authorization gate for all application traffic — exactly as
-- APPLICATION_DESIGN.md §1.3 specifies.
--
-- What this DOES change: Supabase auto-generates a PostgREST/GraphQL/Realtime API for every
-- table in the public schema, reachable via the anon/authenticated keys independently of this
-- application's own Fastify API — a path access.checkPermission() never sees. With RLS
-- enabled and no policies defined, that path is denied by default for every table, closing an
-- access route this schema's design never intended to exist in the first place (this app
-- never uses Supabase Auth or the anon key — APPLICATION_DESIGN.md §1.3). If a genuine need
-- for anon/authenticated access via that API ever arises, it must be satisfied with an
-- explicit, deliberately-written CREATE POLICY — never by disabling RLS again.
-- =============================================================================

alter table users enable row level security;
alter table sessions enable row level security;
alter table folders enable row level security;
alter table files enable row level security;
alter table upload_sessions enable row level security;
alter table upload_session_parts enable row level security;
alter table permissions enable row level security;
alter table effective_permissions enable row level security;
alter table share_links enable row level security;
alter table deletion_queue enable row level security;
alter table favorites enable row level security;
alter table tags enable row level security;
alter table item_tags enable row level security;
alter table thumbnail_queue enable row level security;
alter table activity_log enable row level security;
