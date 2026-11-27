import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import { FileContext } from 'librechat-data-provider';
import { loginAdmin, requestResult } from '../content-filters.helpers';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/** Past `PREVIEW_LAZY_SWEEP_CUTOFF_MS` (two minutes) in api/server/routes/files/files.js. */
const STALE_MS = 10 * 60 * 1000;

test.describe('file preview lazy sweep', () => {
  test('a preview stuck pending reports failed and records the write @scenario:orphaned-preview-sweep-reports-failed', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const fileId = randomUUID();
    const stale = new Date(Date.now() - STALE_MS);
    try {
      const token = await loginAdmin(request);
      await withMongo(async (db) => {
        const owner = await db.collection('users').findOne({ email: getPrimaryE2EUser().email });
        if (!owner) {
          throw new Error('E2E seed: primary user not found');
        }
        await db.collection('files').insertOne({
          _id: new ObjectId(),
          user: owner._id,
          ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
          file_id: fileId,
          bytes: 128,
          filename: 'stuck.xlsx',
          filepath: `/tmp/${fileId}.xlsx`,
          object: 'file',
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          status: 'pending',
          usage: 0,
          source: 'local',
          context: FileContext.message_attachment,
          createdAt: stale,
          updatedAt: stale,
        });
      });

      const preview = await requestResult(request, {
        path: `/api/files/${encodeURIComponent(fileId)}/preview`,
        token,
      });
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({ file_id: fileId, status: 'failed', previewError: 'orphaned' });

      const stored = await withMongo((db) => db.collection('files').findOne({ file_id: fileId }));
      expect(stored?.status).toBe('failed');
      expect(stored?.previewError).toBe('orphaned');
      expect(stored?.updatedAt).toBeInstanceOf(Date);
      expect((stored?.updatedAt as Date).getTime()).toBeGreaterThan(stale.getTime());
    } finally {
      await withMongo((db) => db.collection('files').deleteOne({ file_id: fileId })).catch(
        () => undefined,
      );
      await request.dispose();
    }
  });
});
