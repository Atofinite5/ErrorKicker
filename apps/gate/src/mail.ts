import { config } from "./config.ts";

/** Send an alert email via Resend HTTP or SMTP (Nodemailer). Never throws. */
export async function sendAlertEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!to) return false;
  try {
    if (config.resendApiKey) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.resendApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: config.alertEmailFrom,
          to: [to],
          subject,
          text,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
      return true;
    }
    if (config.smtpHost) {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth:
          config.smtpUser && config.smtpPass
            ? { user: config.smtpUser, pass: config.smtpPass }
            : undefined,
      });
      await transport.sendMail({
        from: config.alertEmailFrom,
        to,
        subject,
        text,
      });
      return true;
    }
    console.warn("[alert] email skipped: set RESEND_API_KEY or SMTP_HOST");
    return false;
  } catch (err) {
    console.error("[alert] email failed:", (err as Error).message);
    return false;
  }
}
