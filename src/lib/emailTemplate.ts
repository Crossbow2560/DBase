// Shared visual shell for outbound emails, matching web/app/globals.css's [data-theme="alt"]
// skin (cream background #F7F4EE / near-black text & borders #1A1A1A / #433D37 / mustard-amber
// accent #D46F35 / square corners) and the app's actual logo mark (web/public/logo.png),
// referenced by URL rather than embedded — most mail clients handle a remote <img> far better
// than a large inline data URI, and this asset is ~400KB. Mirrors the alt theme's own button
// rule: bg-accent (amber) is reserved for badges/highlights, while primary-action buttons render
// solid black — see the [data-theme="alt"] .bg-accent.hover:opacity-90 override in globals.css.
// Table-based and inline-styled since most mail clients (Outlook in particular) strip <style> blocks.
import { config } from "../config.js";

export function renderEmailLayout(options: {
  heading: string;
  bodyHtml: string;
  buttonLabel: string;
  buttonUrl: string;
}): string {
  const { heading, bodyHtml, buttonLabel, buttonUrl } = options;
  const logoUrl = `${config.publicAppUrl}/logo.png`;

  return `
<div style="background-color:#F7F4EE;background-image:radial-gradient(#1A1A1A14 1px, transparent 1px);background-size:22px 22px;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #433D37;">
    <tr>
      <td style="padding:20px 32px;border-bottom:1px solid #433D37;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;">
              <img src="${logoUrl}" width="28" height="28" alt="DBase" style="display:block;width:28px;height:28px;">
            </td>
            <td style="padding-left:10px;font-size:16px;font-weight:700;color:#1A1A1A;">DBase</td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h1 style="margin:0 0 16px;font-size:20px;font-weight:400;letter-spacing:-0.01em;color:#1A1A1A;">${heading}</h1>
        <div style="font-size:15px;line-height:1.6;color:#1A1A1A;">${bodyHtml}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0;">
          <tr>
            <td style="background-color:#1A1A1A;">
              <a href="${buttonUrl}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#F7F4EE;text-decoration:none;">${buttonLabel}</a>
            </td>
          </tr>
        </table>
        <p style="font-size:13px;color:#433D37;word-break:break-all;">
          Or copy and paste this link into your browser:<br>
          <a href="${buttonUrl}" style="color:#D46F35;">${buttonUrl}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background-color:#EBE6DB;border-top:1px solid #433D37;">
        <p style="margin:0;font-size:12px;color:#433D37;">If you didn't request this, you can safely ignore this email.</p>
      </td>
    </tr>
  </table>
</div>`;
}
