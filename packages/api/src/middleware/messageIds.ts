import { Constants } from 'librechat-data-provider';
import type { Request, Response, NextFunction } from 'express';
import {
  MAX_MESSAGE_ID_LENGTH,
  MAX_RESPONSE_MESSAGE_ID_LENGTH,
  isValidMessageId,
} from '../utils/message';

/** An override carries an optional writer index serialized from a JS safe integer. */
const MAX_OVERRIDE_MESSAGE_ID_LENGTH =
  MAX_MESSAGE_ID_LENGTH + Constants.COMMON_DIVIDER.length + String(Number.MAX_SAFE_INTEGER).length;

/** Reject invalid client turn identities before chat admission or resume lookups. */
export function validateChatMessageIds(req: Request, res: Response, next: NextFunction): void {
  for (const field of [
    'messageId',
    'responseMessageId',
    'parentMessageId',
    'overrideUserMessageId',
    'overrideParentMessageId',
  ] as const) {
    const value: unknown = req.body?.[field];
    if (value == null) {
      continue;
    }
    let maxLength = MAX_MESSAGE_ID_LENGTH;
    if (field === 'overrideUserMessageId') {
      maxLength = MAX_OVERRIDE_MESSAGE_ID_LENGTH;
    } else if (
      field === 'responseMessageId' ||
      field === 'parentMessageId' ||
      (field === 'messageId' && req.body?.compact === true)
    ) {
      maxLength = MAX_RESPONSE_MESSAGE_ID_LENGTH;
    }
    if (
      !isValidMessageId(value, maxLength) ||
      (field === 'overrideUserMessageId' &&
        !isValidMessageId(value.split(Constants.COMMON_DIVIDER, 1)[0]))
    ) {
      res.status(400).json({
        code: 'INVALID_MESSAGE_ID',
        error: `${field} must be a 1-${maxLength} character identifier using letters, digits, _, :, ., or -.`,
      });
      return;
    }
  }
  next();
}
