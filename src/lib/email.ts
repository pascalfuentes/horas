import { APP_NAME } from "~/config";
import type { AppEnv } from "~/lib/env";

type Mail = { to: string; subject: string; html: string; text: string };

/**
 * Sends through Resend when `RESEND_API_KEY` exists; otherwise prints to the
 * console. This is on purpose: the template runs and you can test invites and
 * password reset locally without configuring any email provider.
 */
export async function sendEmail(env: AppEnv, mail: Mail): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(
      [
        "",
        "┌─ EMAIL (dev mode — RESEND_API_KEY not configured) ────────────",
        `│ To:      ${mail.to}`,
        `│ Subject: ${mail.subject}`,
        "│",
        ...mail.text.split("\n").map((l) => `│ ${l}`),
        "└───────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "no-reply@example.com",
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }),
  });

  if (!res.ok) {
    // Does not leak the body to the end user — only to the log.
    console.error("Failed to send email:", res.status, await res.text());
    throw new Error("EMAIL_SEND_FAILED");
  }
}

/**
 * The one layout every email uses, drawn with the brand: cream page, the logo
 * and the name on top, a white card with the sun-yellow edge, and the pill
 * button with the hard shadow.
 *
 * Email clients ignore most CSS, so everything is tables and inline styles,
 * the display font falls back to Georgia, and the "shadow" of the button is a
 * thicker bottom border. The logo is the app icon served by the site itself,
 * found from the address of the button.
 */
export function emailLayout(heading: string, paragraphs: string[], cta?: { label: string; url: string }) {
  const INK = "#1b1624";
  const MUTED = "#76737c";
  const serif = "Georgia,'Times New Roman',serif";
  const sans = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  let origin = "";
  try {
    if (cta) origin = new URL(cta.url).origin;
  } catch {
    /* an odd address only costs the logo */
  }
  const logo = origin
    ? `<img src="${origin}/icon-192.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px">`
    : `<div style="width:26px;height:26px;border-radius:50%;background:#fdd46b;border:3px solid ${INK}"></div>`;

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:#f9f6f3;font-family:${sans};color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9f6f3"><tr><td align="center" style="padding:32px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
<tr><td style="padding:0 4px 18px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle;padding-right:10px">${logo}</td>
<td style="vertical-align:middle;font-family:${serif};font-size:24px;font-weight:700;letter-spacing:-0.4px;color:${INK}">${APP_NAME}</td>
</tr></table>
</td></tr>
<tr><td style="background:#ffffff;border:2px solid ${INK};border-top:8px solid #fdd46b;border-radius:20px;padding:32px 32px 28px">
<h1 style="margin:0 0 16px;font-family:${serif};font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-0.4px;color:${INK}">${heading}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:${INK}">${p}</p>`).join("")}
${
  cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 20px"><tr><td style="background:#5dcdf1;border:2px solid ${INK};border-bottom:5px solid ${INK};border-radius:999px">
<a href="${cta.url}" style="display:inline-block;padding:12px 28px;font-size:15px;font-weight:600;color:${INK};text-decoration:none">${cta.label}</a>
</td></tr></table>
<p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};word-break:break-all">If the button doesn't work, copy this address: <a href="${cta.url}" style="color:#1a93bd">${cta.url}</a></p>`
    : ""
}
</td></tr>
<tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.5;color:${MUTED}">
${APP_NAME} · Free time tracking that talks to your AI.${origin ? `<br><a href="${origin}" style="color:${MUTED}">${origin.replace(/^https?:\/\//, "")}</a>` : ""}
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [heading, "", ...paragraphs.map(stripTags), cta ? `\n${cta.label}: ${cta.url}` : ""]
    .filter(Boolean)
    .join("\n");

  return { html, text };
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
