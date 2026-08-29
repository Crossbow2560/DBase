-- =============================================================================
-- 0020_received_emails.sql
-- Inbound email for dbase@nishit-db.com
--
-- Outbound mail already goes through Resend (src/lib/email.ts). Resend also does INBOUND: the
-- domain's MX records point at Resend, and each received message is POSTed to a webhook
-- (src/modules/email/routes.ts -> POST /api/v1/email/inbound, Svix-signature verified). This
-- table is where those land, for the admin "Received Mail" tab to read back.
--
-- No FK to users — a message to dbase@ is not "owned" by anyone; it is deployment-level mail the
-- admin reads. message_id carries the provider/RFC Message-ID and is UNIQUE so a webhook
-- redelivery (Resend retries on non-2xx) is idempotent rather than inserting a duplicate row.
-- =============================================================================

create table received_emails (
  id            uuid primary key default gen_random_uuid(),
  message_id    text unique,
  from_address  text not null,
  from_name     text,
  to_address    text not null,
  subject       text,
  text_body     text,
  html_body     text,
  headers       jsonb not null default '{}'::jsonb,
  raw           jsonb not null default '{}'::jsonb,
  received_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

comment on table received_emails is
  'Inbound messages delivered to the deployment address (dbase@nishit-db.com) via the Resend
   inbound webhook. raw holds the full provider payload for debugging; message_id is UNIQUE so
   webhook redeliveries are idempotent.';

create index idx_received_emails_received_at on received_emails(received_at desc);

alter table received_emails enable row level security;
