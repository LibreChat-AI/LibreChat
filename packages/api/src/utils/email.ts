import { logger } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from './errors';

/**
 * Check if email configuration is set
 * @returns Returns `true` if either Mailgun or SMTP is properly configured
 */
export function checkEmailConfig(): boolean {
  const hasMailgunConfig =
    !!process.env.MAILGUN_API_KEY && !!process.env.MAILGUN_DOMAIN && !!process.env.EMAIL_FROM;

  const hasSMTPConfig =
    (!!process.env.EMAIL_SERVICE || !!process.env.EMAIL_HOST) && !!process.env.EMAIL_FROM;

  if (hasSMTPConfig) {
    const hasUsername = !!process.env.EMAIL_USERNAME;
    const hasPassword = !!process.env.EMAIL_PASSWORD;
    if (hasUsername !== hasPassword) {
      logger.warn(
        '[checkEmailConfig] EMAIL_USERNAME and EMAIL_PASSWORD must both be set for authenticated SMTP, or both omitted for unauthenticated SMTP.',
      );
    }
  }

  return hasMailgunConfig || hasSMTPConfig;
}

/** Provider failures may echo recovery credentials, so only bounded metadata leaves the mailer. */
export function handleEmailError(error: unknown, throwError: boolean): Error {
  const metadata = getSafeErrorMetadata(error);
  const safeError = Object.assign(new Error('Email delivery failed'), metadata);
  if (throwError) {
    throw safeError;
  }
  logger.error('[sendEmail]', metadata);
  return safeError;
}
