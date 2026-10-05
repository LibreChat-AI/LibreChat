import type { Response } from 'express';
import { MediaServiceError } from '../media/errors';

export {
  prepareMediaAccountDeletion as prepareAccountDeletion,
  completeMediaAccountDeletion as completeAccountDeletion,
  cancelMediaAccountDeletion as cancelAccountDeletion,
} from '../media/account';

export function sendAccountDeletionError(res: Pick<Response, 'status'>, error: Error): Response {
  if (error instanceof MediaServiceError) {
    return res.status(error.status).json({ message: error.message, code: error.code });
  }
  return res.status(500).json({ message: 'Something went wrong.' });
}
