-- =============================================================================
-- 0021_received_email_attachments.sql
-- Attachment metadata for inbound mail
--
-- Resend's email.received webhook (0020) carries only metadata — no body, no attachment bytes.
-- src/modules/email/inbound-service.ts now follows up with a GET /emails/receiving/{id} call to
-- pull the text/html body and the attachment list. This column holds that list: metadata only
-- (filename / content type / Resend's attachment id), never the file bytes.
-- =============================================================================

alter table received_emails add column attachments jsonb not null default '[]'::jsonb;

comment on column received_emails.attachments is
  'Array of { id, filename, contentType } for each attachment on the inbound message, from the
   Resend receiving API. Metadata only — the attachment content itself is not downloaded or
   stored. Resend keeps a time-limited download_url retrievable via its Attachments API if the
   bytes are ever needed.';
