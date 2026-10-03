import { classifyScheduledGrant, indexGrantClients } from './grants';

const refresh = { credential_set_id: 'generation' };
const client = {
  credential_set_id: 'generation',
  openid_subject: 'subject',
  openid_issuer: 'issuer',
};

it('keeps a duplicate-client marker instead of selecting the last record', () => {
  const indexed = indexGrantClients(
    [{ key: 'a' }, { key: 'b' }, { key: 'a' }],
    (record) => record.key,
  );
  expect(indexed.get('a')).toBeNull();
  expect(indexed.get('b')).toEqual({ key: 'b' });
});
it.each([
  { refresh, client, state: 'provable' },
  { refresh, client: { credential_set_id: 'generation' }, state: 'ordinary' },
  { refresh, client: undefined, state: 'ambiguous' },
  { refresh, client: null, state: 'ambiguous' },
  { refresh, client: { ...client, credential_set_id: 'other' }, state: 'ambiguous' },
  {
    refresh,
    client: { credential_set_id: 'generation', openid_subject: 'subject' },
    state: 'ambiguous',
  },
  { refresh: { credential_set_id: '' }, client, state: 'ambiguous' },
  {
    refresh: { ...refresh, credential_purpose: 'scheduled_obo' },
    client: undefined,
    state: 'tagged',
  },
  {
    refresh: { ...refresh, credential_purpose: 'scheduled_obo' },
    client: null,
    state: 'ambiguous',
  },
  {
    refresh: { ...refresh, credential_purpose: 'scheduled_obo' },
    client: { ...client, credential_set_id: 'other' },
    state: 'ambiguous',
  },
])(
  'classifies durable generation provenance: $state',
  ({ refresh: metadata, client: proof, state }) => {
    expect(classifyScheduledGrant(metadata, proof)).toBe(state);
  },
);
