/**
 * Email Notification Channel
 *
 * Sends reminder emails via Nodemailer (SMTP).
 *
 * Required environment variables:
 *   SMTP_HOST   — SMTP server hostname
 *   SMTP_PORT   — SMTP port (default: 587)
 *   SMTP_USER   — SMTP username / API key
 *   SMTP_PASS   — SMTP password
 *   EMAIL_FROM  — From address, e.g. "CRM <noreply@yourapp.com>"
 */
import nodemailer from 'nodemailer';
import logger from '../../utils/logger.js';

let transporter = null;

const getTransporter = () => {
    if (transporter) return transporter;

    const { SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, FROM_EMAIL } = process.env;
    if (!SMTP_HOST || !EMAIL_USER || !EMAIL_PASS || !FROM_EMAIL) {
        logger.warn('[Email] SMTP not configured — email channel disabled');
        return null;
    }

    transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: parseInt(SMTP_PORT || '587', 10),
        secure: false,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    });

    return transporter;
};

/**
 * Send a reminder email to the admin.
 *
 * @param {object} adminInfo  - { email, firstName, lastName }
 * @param {object} payload    - { reminderId, title, description, scheduledAt, type }
 */
export const send = async (adminInfo, payload) => {
    const transport = getTransporter();
    if (!transport) return;

    if (!adminInfo?.email) {
        logger.warn('[Email] Admin has no email address — skipping');
        return;
    }

    const subject = 'Lead App Reminder';

    const typeLabel = payload.type === 'pre'
        ? 'Pre-Reminder'
        : 'Reminder';

    const adminName = [adminInfo.firstName, adminInfo.lastName].filter(Boolean).join(' ') || 'Admin';

    const html = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; background: #f9fafb; border-radius: 12px;">
            <div style="background: #ffffff; border-radius: 10px; padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08);">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
                    <div style="width: 40px; height: 40px; background: linear-gradient(to right, #4f46e5, #7c3aed); border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                        <span style="font-size: 18px;">🔔</span>
                    </div>
                    <div>
                        <p style="margin: 0; font-size: 11px; font-weight: 600; color: #6366f1; text-transform: uppercase; letter-spacing: 0.05em;">${typeLabel}</p>
                        <h2 style="margin: 2px 0 0; font-size: 18px; font-weight: 700; color: #111827;">${subject}</h2>
                    </div>
                </div>

                <p style="color: #374151; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
                    Hi ${adminName},
                </p>
                <p style="color: #374151; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
                    ${payload.description}
                </p>

                <div style="background: #f3f4f6; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px;">
                    <p style="margin: 0; font-size: 12px; color: #6b7280;">
                        🕐 Scheduled for: <strong style="color: #111827;">${new Date(payload.scheduledAt).toLocaleString()}</strong>
                    </p>
                </div>

                <p style="margin: 0; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 16px;">
                    This reminder was set in your Lead App. Log in to view the lead details.
                </p>
            </div>
        </div>
    `;
    try {
        await transport.sendMail({
            from: `Lead App <${process.env.FROM_EMAIL}>`,
            to: adminInfo.email,
            subject,
            html
        });
        logger.info(`[Email] Sent reminder email to ${adminInfo.email}`);
    } catch (err) {
        logger.error(`[Email] Failed to send to ${adminInfo.email}: ${err.message}`);
        throw err;
    }
};
