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

export function emailLayout(heading: string, paragraphs: string[], cta?: { label: string; url: string }) {
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f4f4f5;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:480px;background:#fff;border-radius:12px;padding:32px">
<tr><td>
<h1 style="margin:0 0 16px;font-size:20px;color:#18181b">${heading}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#52525b">${p}</p>`).join("")}
${
  cta
    ? `<p style="margin:24px 0"><a href="${cta.url}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600">${cta.label}</a></p>
<p style="margin:0;font-size:12px;color:#a1a1aa;word-break:break-all">If the button doesn't work, copy this address: ${cta.url}</p>`
    : ""
}
</td></tr></table></td></tr></table></body></html>`;

  const text = [heading, "", ...paragraphs.map(stripTags), cta ? `\n${cta.label}: ${cta.url}` : ""]
    .filter(Boolean)
    .join("\n");

  return { html, text };
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "");
