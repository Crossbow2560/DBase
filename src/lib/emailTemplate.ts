// Shared visual shell for outbound emails, matching web/app/globals.css's palette
// (F6FAFD background / B3CFE5 muted / 4A7FA7 accent / 1A3D63 muted text / 0A1931 foreground)
// and the app header's logo mark (web/app/(auth)/layout.tsx). Table-based and inline-styled
// since most mail clients (Outlook in particular) strip <style> blocks.
export function renderEmailLayout(options: {
  heading: string;
  bodyHtml: string;
  buttonLabel: string;
  buttonUrl: string;
}): string {
  const { heading, bodyHtml, buttonLabel, buttonUrl } = options;

  return `
<div style="background-color:#F6FAFD;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #DCE9F2;">
    <tr>
      <td style="padding:20px 32px;border-bottom:1px solid #DCE9F2;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:28px;height:28px;background-color:#4A7FA7;border-radius:6px;text-align:center;vertical-align:middle;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#F6FAFD" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;">
                <rect width="7" height="7" x="3" y="3" rx="1" />
                <rect width="7" height="7" x="14" y="3" rx="1" />
                <rect width="7" height="7" x="14" y="14" rx="1" />
                <rect width="7" height="7" x="3" y="14" rx="1" />
              </svg>
            </td>
            <td style="padding-left:8px;font-size:15px;font-weight:600;color:#0A1931;">DBase</td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h1 style="margin:0 0 16px;font-size:20px;color:#0A1931;">${heading}</h1>
        <div style="font-size:15px;line-height:1.6;color:#1A3D63;">${bodyHtml}</div>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0;">
          <tr>
            <td style="border-radius:6px;background-color:#4A7FA7;">
              <a href="${buttonUrl}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:#F6FAFD;text-decoration:none;border-radius:6px;">${buttonLabel}</a>
            </td>
          </tr>
        </table>
        <p style="font-size:13px;color:#4A7FA7;word-break:break-all;">
          Or copy and paste this link into your browser:<br>
          <a href="${buttonUrl}" style="color:#4A7FA7;">${buttonUrl}</a>
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 32px;background-color:#F6FAFD;border-top:1px solid #DCE9F2;">
        <p style="margin:0;font-size:12px;color:#4A7FA7;">If you didn't request this, you can safely ignore this email.</p>
      </td>
    </tr>
  </table>
</div>`;
}
