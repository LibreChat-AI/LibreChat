import {
  discordConfirmationControl,
  discordConfirmationParts,
  discordRunControl,
  discordDecisionControl,
  parseDiscordControl,
  discordIngressActionSchema,
} from './types/discordIngress';

const linkId = 'a'.repeat(43);
const revision = 'b'.repeat(43);
const runId = '12345678-1234-4123-8123-123456789012';
const messageId = '123456789012345678';
it('fits independent opaque confirmation values within the Discord component limit', () => {
  const control = discordConfirmationControl(linkId, revision);
  expect(control.length).toBeLessThanOrEqual(100);
  const action = parseDiscordControl(control);
  expect(action).toEqual({ kind: 'confirm', reference: linkId + revision });
  expect(discordConfirmationParts(linkId + revision)).toEqual({ linkId, revision });
  expect(discordConfirmationParts('invalid')).toBeNull();
  expect(() => discordConfirmationControl('bad', revision)).toThrow();
});
it.each(['cancel', 'thumbsUp', 'thumbsDown'] as const)(
  'requires the actual source message for %s',
  (kind) => {
    const control = discordRunControl(kind, runId);
    expect(parseDiscordControl(control)).toBeNull();
    expect(parseDiscordControl(control, 'not-a-snowflake')).toBeNull();
    expect(parseDiscordControl(control, messageId)).toEqual(
      kind === 'cancel'
        ? { kind: 'cancel', reference: runId, messageId }
        : { kind: 'feedback', reference: runId, messageId, rating: kind },
    );
  },
);
it.each([
  'lc2:x:reference',
  'lc1:unknown:reference',
  'lc1:c:short',
  'lc1:x:',
  'lc1:x:' + 'a'.repeat(100),
  'lc1:x:../other',
])('rejects malformed or unknown control %s', (control) => {
  expect(parseDiscordControl(control, messageId)).toBeNull();
});
it('allows a slash cancel without a reference but rejects half-bound native controls', () => {
  expect(discordIngressActionSchema.safeParse({ kind: 'cancel' }).success).toBe(true);
  expect(discordIngressActionSchema.safeParse({ kind: 'cancel', reference: runId }).success).toBe(
    false,
  );
  expect(discordIngressActionSchema.safeParse({ kind: 'cancel', messageId }).success).toBe(false);
  expect(
    discordIngressActionSchema.safeParse({ kind: 'feedback', reference: runId, rating: 'thumbsUp' })
      .success,
  ).toBe(false);
});

it('binds review entry to a real source and decisions to an immutable private interaction', () => {
  const review = discordRunControl('review', runId);
  expect(parseDiscordControl(review)).toBeNull();
  expect(parseDiscordControl(review, messageId)).toEqual({
    kind: 'review',
    reference: runId,
    messageId,
  });
  const decide = discordDecisionControl(messageId, 3);
  expect(decide.length).toBeLessThanOrEqual(100);
  expect(parseDiscordControl(decide)).toEqual({ kind: 'decide', reference: messageId, choice: 3 });
  expect(parseDiscordControl(`lc1:v:${messageId}:4`)).toBeNull();
  expect(parseDiscordControl('lc1:v:wrong:0')).toBeNull();
  expect(() => discordDecisionControl(messageId, -1)).toThrow();
  expect(
    discordIngressActionSchema.safeParse({
      kind: 'decide',
      reference: messageId,
      choice: 0,
      actionId: 'model-selected',
    }).success,
  ).toBe(false);
});
