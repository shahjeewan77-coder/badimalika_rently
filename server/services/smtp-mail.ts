// ── AGENT-OWNED: SMTP mailer ──────────────────────────────────────────────────
//
// HOW THE CONFIG IS READ — AND WHY IT IS NOT read from env.config/env.secret.
//
// The obvious route is `env.config("SMTP_HOST")` / `env.secret("SMTP_PASS")`,
// which surface the platform's "add it under Settings" hint. That route cannot
// be used here: ./_core/env validates DATABASE_URL and JWT_SECRET inside its
// module body, so merely IMPORTING it throws when those are unset — and this
// module is imported by server/routers.ts, which is imported by the canonical
// test-caller in ./_core. Pulling env in would therefore make the whole router
// — and every unit test that builds a caller from it — require a live database
// just to load. SMTP values are ordinary user-supplied configuration, so they
// are read from process.env at call time instead.
//
// Configuration (app owner: Settings → Environment variables):
//   SMTP_HOST   e.g. smtp.gmail.com
//   SMTP_PORT   e.g. 465 (implicit TLS) or 587 (STARTTLS)
//   SMTP_USER   the full Gmail address
//   SMTP_PASS   a 16-character Gmail App Password (NOT the normal password)
//   MAIL_FROM   optional; defaults to SMTP_USER. e.g. "Sharma Equipment <you@gmail.com>"
//
// Absent config never throws from here: the caller decides what to tell the user.
import nodemailer, { type Transporter } from "nodemailer";

/** The "add it in Settings" hint, mirroring the one _core/env itself shows. */
const SETTINGS_HINT = "Add it under Settings → Environment variables.";

/** Present, non-empty config value, or undefined. Read at call time, never cached. */
function cfg(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailResult {
  sent: boolean;
  /** "sent" | "not_configured" | "failed" */
  status: "sent" | "not_configured" | "failed";
  error?: string;
}

/** True when every SMTP variable needed to send is present. */
export function smtpConfigured(): boolean {
  return Boolean(cfg("SMTP_HOST"));
}

function buildTransport(host: string, port: number, user: string, pass: string): Transporter {
  // 465 is implicit TLS; 587 (and most others) upgrade with STARTTLS. Getting
  // this wrong is the classic "self signed certificate in certificate chain" /
  // "wrong version number" failure.
  const secure = port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/**
 * Send one message over the owner's SMTP account.
 *
 * NEVER throws: a mail failure must not 500 the request that triggered it, and
 * the caller decides what to tell the user. When SMTP is not configured the
 * message is logged for the caller and `status: "not_configured"` is returned,
 * which is what keeps the forgot-password flow usable before the owner has
 * plugged a mailbox in.
 */
export async function sendMail(input: MailInput): Promise<MailResult> {
  const host = cfg("SMTP_HOST");
  const pass = cfg("SMTP_PASS");

  if (!host || !pass) {
    const missing = [!host && "SMTP_HOST", !pass && "SMTP_PASS"].filter(Boolean).join(", ");
    console.warn(
      `[smtp] not configured — missing ${missing}. ${SETTINGS_HINT} ` +
        `Mail to ${input.to} was NOT sent.`,
    );
    return { sent: false, status: "not_configured" };
  }

  try {
    const port = Number(cfg("SMTP_PORT") ?? "587") || 587;
    const user = cfg("SMTP_USER") ?? "";
    const from = cfg("MAIL_FROM") ?? user;

    const transport = buildTransport(host, port, user, pass);
    await transport.sendMail({
      from: from || user,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { sent: true, status: "sent" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[smtp] send failed", message);
    return { sent: false, status: "failed", error: message };
  }
}

/** Standard OTP email body. Plain text plus a minimal, inline-styled HTML part. */
export function otpEmail(otp: string, minutes: number, appName = "Equipment Rental") {
  const text =
    `Your ${appName} password reset code is ${otp}.\n\n` +
    `It expires in ${minutes} minutes and can be used once.\n` +
    `If you did not ask to reset your password, you can ignore this email.`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px">
  <h2 style="margin:0 0 8px;font-size:18px">Reset your password</h2>
  <p style="margin:0 0 16px;color:#475569">Your ${appName} password reset code is:</p>
  <p style="margin:0 0 16px;font-size:32px;font-weight:700;letter-spacing:6px">${otp}</p>
  <p style="margin:0 0 8px;color:#475569">It expires in <b>${minutes} minutes</b> and can be used once.</p>
  <p style="margin:0;color:#94a3b8;font-size:12px">If you did not ask to reset your password, you can ignore this email.</p>
</div>`;
  return { text, html };
}
