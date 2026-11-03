import { getErasureErrorKey } from '../errors';

it('recognizes only the approved pending status and code without forwarding server text', () => {
  const error = {
    isAxiosError: true,
    response: {
      status: 503,
      data: { code: 'response_erasure_pending', message: 'private server diagnostic' },
    },
  };
  expect(getErasureErrorKey(error, 'com_ui_convo_delete_error')).toBe('com_ui_deletion_pending');
});

it.each([
  new Error('private'),
  undefined,
  { isAxiosError: true, response: { status: 500, data: { code: 'response_erasure_pending' } } },
  { isAxiosError: true, response: { status: 503, data: { code: 'unknown', message: 'private' } } },
  { isAxiosError: true, response: { status: 503, data: 'private' } },
])('preserves the caller fallback for %p', (error) => {
  expect(getErasureErrorKey(error, 'com_nav_delete_account_error')).toBe(
    'com_nav_delete_account_error',
  );
});
