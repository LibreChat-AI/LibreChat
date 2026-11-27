import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import { isEnabled } from '~/utils';

export function validateEmailLogin(
  req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  const emailLoginEnabled =
    process.env.ALLOW_EMAIL_LOGIN === undefined || isEnabled(process.env.ALLOW_EMAIL_LOGIN);
  if (emailLoginEnabled) {
    next();
    return;
  }

  if (isEnabled(process.env.ALLOW_EMAIL_LOGIN_OVERRIDE)) {
    logger.warn(
      `[validateEmailLogin] Email login is disabled; allowing login attempt via ALLOW_EMAIL_LOGIN_OVERRIDE. IP: ${req.ip}`,
    );
    next();
    return;
  }

  logger.warn(`[validateEmailLogin] Login attempt while email login is disabled. IP: ${req.ip}`);
  return res.status(403).json({ message: 'Email login is not allowed.' });
}
