// Shared visual shell for outbound emails, matching web/app/globals.css's [data-theme="alt"]
// skin (cream background #F7F4EE / near-black text & borders #1A1A1A / #433D37 / mustard-amber
// accent #D46F35 / square corners) and the app header's logo mark — the `Layers` lucide icon in
// an accent-colored badge (web/app/(app)/layout.tsx:153-158), not a plain grid glyph. Mirrors
// that theme's own button rule: bg-accent (amber) is reserved for badges/highlights, while
// primary-action buttons render solid black — see the
// [data-theme="alt"] .bg-accent.hover:opacity-90 override in globals.css.
// Table-based and inline-styled since most mail clients (Outlook in particular) strip <style> blocks.
export function renderEmailLayout(options: {
  heading: string;
  bodyHtml: string;
  buttonLabel: string;
  buttonUrl: string;
}): string {
  const { heading, bodyHtml, buttonLabel, buttonUrl } = options;

  return `
<div style="background-color:#F7F4EE;background-image:radial-gradient(#1A1A1A14 1px, transparent 1px);background-size:22px 22px;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #433D37;">
    <tr>
      <td style="padding:20px 32px;border-bottom:1px solid #433D37;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:28px;height:28px;background-color:#D46F35;text-align:center;vertical-align:middle;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1A1A1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;">
                <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
                <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
                <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
              </svg>
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
