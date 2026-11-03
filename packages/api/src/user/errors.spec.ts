import express from 'express';
import request from 'supertest';
import { ResponseErasurePendingError } from '@librechat/data-schemas';
import { sendErasureError } from './errors';

const fallbacks = [
  'Error clearing conversations',
  { message: 'Something went wrong.' },
  { error: 'Failed to delete user' },
];
function appFor(error: unknown, fallback: string | { message: string } | { error: string }) {
  const app = express();
  app.delete('/', (_req, res) => {
    sendErasureError(res, error, fallback);
  });
  return app;
}

it.each(fallbacks)(
  'returns safe retry guidance for pending erasure with %p fallback',
  async (fallback) => {
    const error = new ResponseErasurePendingError();
    error.message = 'private input, checkpoint settings and credentials';
    const response = await request(appFor(error, fallback)).delete('/');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: 'response_erasure_pending',
      message: 'Deletion is still finishing. Please try again shortly.',
    });
    expect(response.text).not.toContain('private');
  },
);

it.each(fallbacks)('preserves unexpected failure status and %p wire format', async (fallback) => {
  const response = await request(appFor(new Error('private query'), fallback)).delete('/');
  expect(response.status).toBe(500);
  if (typeof fallback === 'string') expect(response.text).toBe(fallback);
  else expect(response.body).toEqual(fallback);
  expect(response.text).not.toContain('private');
});

it('does not treat an unrelated error with a copied code as a cleanup receipt', async () => {
  const error = Object.assign(new Error('private'), { code: 'response_erasure_pending' });
  const response = await request(appFor(error, 'Error clearing conversations')).delete('/');
  expect(response.status).toBe(500);
  expect(response.text).toBe('Error clearing conversations');
});
