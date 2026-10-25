import nodemailer from 'nodemailer';
import {
  allowDevOtp,
  getOtpWebhookUrl,
  getSmtpConfig,
  isProduction,
} from '@/lib/auth-config';

export interface OtpDeliveryResult {
  delivered: boolean;
  channel: 'smtp' | 'webhook' | 'dev' | 'none';
  devOtp?: string;
  reason?: string;
}

function istNow(): string {
  try {
    return new Date().toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  } catch {
    return new Date().toISOString();
  }
}

function textBody(input: { otp: string; deviceLabel: string; ip: string; to: string }): string {
  return [
    '🔐 KAUSTUBH — New device login verification',
    '',
    `A login to your KAUSTUBH account needs approval because another device is already signed in.`,
    '',
    `OTP: ${input.otp}`,
    `Device: ${input.deviceLabel}`,
    `IP address: ${input.ip}`,
    `Time (IST): ${istNow()}`,
    '',
    'This code expires in 10 minutes. If this was not you, do not share the code and change your password immediately.',
    '',
    `Account: ${input.to}`,
  ].join('\n');
}

function htmlBody(input: { otp: string; deviceLabel: string; ip: string; to: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#070b12;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e8eefc">
  <div style="max-width:520px;margin:0 auto;border:1px solid rgba(148,163,184,.25);border-radius:20px;overflow:hidden;background:linear-gradient(160deg,#0d1728,#0a111d)">
    <div style="padding:22px 24px;background:linear-gradient(120deg,rgba(16,185,129,.18),rgba(59,130,246,.18));border-bottom:1px solid rgba(148,163,184,.18)">
      <div style="font-size:22px;font-weight:800;letter-spacing:.5px">🛡️ KAUSTUBH</div>
      <div style="font-size:12px;color:#94a3b8;letter-spacing:2px;text-transform:uppercase;margin-top:4px">New device verification</div>
    </div>
    <div style="padding:26px 24px">
      <p style="margin:0 0 14px;font-size:15px;line-height:1.6">🚨 A new device is trying to sign in while another device is already active.</p>
      <div style="margin:18px 0;padding:20px;border-radius:16px;background:#0b1220;border:1px dashed rgba(16,185,129,.45);text-align:center">
        <div style="font-size:11px;letter-spacing:3px;color:#64748b;text-transform:uppercase">Your one-time code</div>
        <div style="font-size:40px;font-weight:900;letter-spacing:12px;color:#34d399;margin-top:8px">${input.otp}</div>
        <div style="font-size:11px;color:#64748b;margin-top:8px">Expires in 10 minutes · single use</div>
      </div>
      <table style="width:100%;font-size:13px;color:#cbd5e1;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#64748b">📱 Device</td><td style="padding:6px 0;text-align:right">${escapeHtml(input.deviceLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">🌐 IP address</td><td style="padding:6px 0;text-align:right">${escapeHtml(input.ip)}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">🕒 Time (IST)</td><td style="padding:6px 0;text-align:right">${escapeHtml(istNow())}</td></tr>
      </table>
      <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#94a3b8">If this was not you, do not share this code. Change your password and revoke the device from Settings → Security.</p>
    </div>
  </div>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Deliver a one-time code. Supports SMTP (any provider), a generic JSON webhook,
 * and an explicit dev-only console fallback. OTPs are never logged in production.
 */
export async function deliverOtp(input: {
  otp: string;
  deviceLabel: string;
  ip: string;
  to: string;
}): Promise<OtpDeliveryResult> {
  const subject = '🛡️ KAUSTUBH — your new-device login code';
  const text = textBody(input);
  const html = htmlBody(input);

  const webhook = getOtpWebhookUrl();
  if (webhook) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: input.to,
          subject,
          text,
          html,
          otp: input.otp,
          deviceLabel: input.deviceLabel,
          ip: input.ip,
          app: 'KAUSTUBH',
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) return { delivered: true, channel: 'webhook' };
      return { delivered: false, channel: 'webhook', reason: `Webhook responded ${res.status}` };
    } catch (err) {
      return {
        delivered: false,
        channel: 'webhook',
        reason: err instanceof Error ? err.message : 'Webhook delivery failed',
      };
    }
  }

  const smtp = getSmtpConfig();
  if (smtp) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass },
        connectionTimeout: 12_000,
        greetingTimeout: 12_000,
        socketTimeout: 20_000,
      });
      await transporter.sendMail({
        from: smtp.from,
        to: input.to || smtp.to,
        subject,
        text,
        html,
      });
      return { delivered: true, channel: 'smtp' };
    } catch (err) {
      return {
        delivered: false,
        channel: 'smtp',
        reason: err instanceof Error ? err.message : 'SMTP delivery failed',
      };
    }
  }

  if (allowDevOtp()) {
    console.warn(`[auth-otp] SMTP not configured. DEV OTP for ${input.to}: ${input.otp}`);
    return { delivered: true, channel: 'dev', devOtp: input.otp };
  }

  return {
    delivered: false,
    channel: 'none',
    reason: isProduction
      ? 'No OTP delivery channel configured. Set AUTH_SMTP_* or AUTH_OTP_WEBHOOK_URL.'
      : 'No OTP delivery channel configured.',
  };
}
