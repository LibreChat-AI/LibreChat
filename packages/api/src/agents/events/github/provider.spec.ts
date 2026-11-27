import { AGENT_EVENT_TYPES } from 'librechat-data-provider';
import crypto, { createHash, createHmac } from 'node:crypto';
import type { AgentEventType } from 'librechat-data-provider';
import type { Inbound, Verified } from '../provider';
import type { Payload } from '../fixtures.helper';
import {
  set,
  reviewSubmitted,
  pullRequestClosed,
  issueCommentCreated,
  checkSuiteCompleted,
  reviewCommentCreated,
} from '../fixtures.helper';
import { catalog, normalize } from '../catalog';
import { github } from './provider';

const SECRET = 'whsec-example-0123456789abcdef';
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';

const fixtures: Record<AgentEventType, () => Payload> = {
  'github.pull_request_review.submitted': reviewSubmitted,
  'github.pull_request_review_comment.created': reviewCommentCreated,
  'github.issue_comment.created': issueCommentCreated,
  'github.check_suite.completed': checkSuiteCompleted,
  'github.pull_request.closed': pullRequestClosed,
};

function sign(body: Uint8Array, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function bytes(value: Payload | string): Buffer {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
}

/** A delivery as GitHub posts it; `headers` replaces or, with `undefined`, removes a header. */
function inbound(
  body: Uint8Array,
  event = 'pull_request_review',
  headers: Inbound['headers'] = {},
): Inbound {
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': DELIVERY,
      'x-hub-signature-256': sign(body),
      ...headers,
    },
  };
}

/** A real payload with one byte of a name replaced by one that no UTF-8 text contains. */
function invalidUtf8(): Buffer {
  const body = bytes(reviewSubmitted());
  body[body.indexOf('"login":"') + 10] = 0xff;
  return body;
}

function verified(body: Uint8Array, event?: string, headers?: Inbound['headers']): Verified {
  const verdict = github.verify(inbound(body, event, headers), SECRET);
  if (!verdict.ok) {
    throw new Error(`expected a verified delivery, got ${verdict.error.reason}`);
  }
  return verdict.value;
}

describe('github.verify', () => {
  it("accepts GitHub's published example signature", () => {
    const body = bytes('Hello, World!');
    const verdict = github.verify(
      {
        body,
        headers: {
          'x-hub-signature-256':
            'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
        },
      },
      "It's a Secret to Everybody",
    );
    expect(verdict).toEqual({
      ok: true,
      value: { provider: 'github', digest: createHash('sha256').update(body).digest('hex') },
    });
  });

  it('hands back the digest of the body with the header labels beside it', () => {
    const body = bytes(reviewSubmitted());
    expect(github.verify(inbound(body), SECRET)).toEqual({
      ok: true,
      value: {
        provider: 'github',
        digest: createHash('sha256').update(body).digest('hex'),
        delivery: DELIVERY,
        event: 'pull_request_review',
      },
    });
  });

  it('accepts the signature in either letter case', () => {
    const body = bytes(reviewSubmitted());
    const upper = `sha256=${sign(body).slice(7).toUpperCase()}`;
    expect(
      github.verify(inbound(body, undefined, { 'x-hub-signature-256': upper }), SECRET),
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  it('reports a delivery without a signature as missing', () => {
    const body = bytes(reviewSubmitted());
    expect(
      github.verify(inbound(body, undefined, { 'x-hub-signature-256': undefined }), SECRET),
    ).toEqual({ ok: false, error: { code: 'signature', reason: 'missing' } });
  });

  it.each([
    ['no algorithm prefix', (hex: string) => hex],
    ['the SHA-1 prefix', (hex: string) => `sha1=${hex}`],
    ['one digit short', (hex: string) => `sha256=${hex.slice(1)}`],
    ['one digit long', (hex: string) => `sha256=${hex}0`],
    ['a digit that is not hex', (hex: string) => `sha256=g${hex.slice(1)}`],
    ['surrounding space', (hex: string) => ` sha256=${hex}`],
    ['nothing after the prefix', () => 'sha256='],
    ['an empty value', () => ''],
  ])('reports a signature with %s as malformed', (_name, shape) => {
    const body = bytes(reviewSubmitted());
    const header = shape(sign(body).slice(7));
    expect(
      github.verify(inbound(body, undefined, { 'x-hub-signature-256': header }), SECRET),
    ).toEqual({ ok: false, error: { code: 'signature', reason: 'malformed' } });
  });

  it('reports a signature header sent twice as malformed, even when one copy is right', () => {
    const body = bytes(reviewSubmitted());
    const twice = [sign(body), sign(body)];
    expect(
      github.verify(inbound(body, undefined, { 'x-hub-signature-256': twice }), SECRET),
    ).toEqual({ ok: false, error: { code: 'signature', reason: 'malformed' } });
  });

  it('rejects a body signed with another secret', () => {
    const body = bytes(reviewSubmitted());
    const header = sign(body, `${SECRET}x`);
    expect(
      github.verify(inbound(body, undefined, { 'x-hub-signature-256': header }), SECRET),
    ).toEqual({ ok: false, error: { code: 'signature', reason: 'mismatch' } });
  });

  it('rejects a body changed by one byte after it was signed', () => {
    const body = bytes(reviewSubmitted());
    const header = sign(body);
    const altered = Buffer.from(body);
    altered[altered.length - 2] ^= 0x01;
    expect(
      github.verify(inbound(altered, undefined, { 'x-hub-signature-256': header }), SECRET),
    ).toEqual({ ok: false, error: { code: 'signature', reason: 'mismatch' } });
  });

  it('rejects a signature changed in its last digit', () => {
    const body = bytes(reviewSubmitted());
    const header = sign(body);
    const last = header.endsWith('0') ? '1' : '0';
    expect(
      github.verify(
        inbound(body, undefined, { 'x-hub-signature-256': `${header.slice(0, -1)}${last}` }),
        SECRET,
      ),
    ).toEqual({ ok: false, error: { code: 'signature', reason: 'mismatch' } });
  });

  it('rejects a re-serialized copy of a signed body', () => {
    const body = bytes(JSON.stringify(reviewSubmitted(), null, 2));
    const header = sign(body);
    const compact = bytes(reviewSubmitted());
    expect(
      github.verify(inbound(compact, undefined, { 'x-hub-signature-256': header }), SECRET),
    ).toEqual({ ok: false, error: { code: 'signature', reason: 'mismatch' } });
  });

  it('compares the two digests in constant time', () => {
    const compare = jest.spyOn(crypto, 'timingSafeEqual');
    try {
      const body = bytes(reviewSubmitted());
      github.verify(inbound(body), SECRET);
      github.verify(
        inbound(body, undefined, { 'x-hub-signature-256': sign(body, 'other') }),
        SECRET,
      );
      expect(compare).toHaveBeenCalledTimes(2);
      for (const [expected, sent] of compare.mock.calls) {
        expect(expected.byteLength).toBe(32);
        expect(sent.byteLength).toBe(32);
      }
    } finally {
      compare.mockRestore();
    }
  });

  it('throws for an empty secret, which would accept a signature anyone can compute', () => {
    const body = bytes(reviewSubmitted());
    const forged = inbound(body, undefined, { 'x-hub-signature-256': sign(body, '') });
    expect(() => github.verify(forged, '')).toThrow('A webhook secret is required');
  });

  it('never puts the secret in a verdict', () => {
    const body = bytes(reviewSubmitted());
    const verdicts = [
      github.verify(inbound(body), SECRET),
      github.verify(inbound(body, undefined, { 'x-hub-signature-256': 'sha256=zz' }), SECRET),
      github.verify(inbound(body, undefined, { 'x-hub-signature-256': sign(body, 'x') }), SECRET),
    ];
    expect(JSON.stringify(verdicts)).not.toContain(SECRET);
  });

  it('keeps one identity for a body posted again under a new delivery id', () => {
    const body = bytes(reviewSubmitted());
    const first = verified(body);
    const replay = verified(body, undefined, {
      'x-github-delivery': 'ffffffff-0000-1111-2222-333333333333',
    });
    expect(replay.delivery).not.toBe(first.delivery);
    expect(replay.digest).toBe(first.digest);
    expect(verified(bytes(reviewCommentCreated())).digest).not.toBe(first.digest);
  });

  it.each([
    ['repeated', ['a', 'b']],
    ['longer than a GUID', 'a'.repeat(65)],
    ['not a plain token', 'abc def\r\nx: y'],
    ['empty', ''],
  ])('leaves out a delivery id that is %s', (_name, value) => {
    const body = bytes(reviewSubmitted());
    expect(verified(body, undefined, { 'x-github-delivery': value }).delivery).toBeUndefined();
  });

  it('returns a value that cannot be changed and holds no body', () => {
    const value = verified(bytes(reviewSubmitted()));
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.keys(value).sort()).toEqual(['delivery', 'digest', 'event', 'provider']);
  });
});

describe('github.parse', () => {
  it.each(AGENT_EVENT_TYPES)('reads %s as the catalog does', (type) => {
    const payload = fixtures[type]();
    const outcome = github.parse(verified(bytes(payload), catalog[type].event));
    expect(outcome).toEqual(normalize('github', catalog[type].event, payload));
    expect(outcome.ok).toBe(true);
  });

  it('passes the caller its limits', () => {
    const payload = set(reviewSubmitted(), 'review.body', 'word '.repeat(40));
    const outcome = github.parse(verified(bytes(payload)), { excerpt: 16, fanout: 1 });
    expect(outcome).toEqual(
      normalize('github', 'pull_request_review', payload, { excerpt: 16, fanout: 1 }),
    );
    const text = outcome.ok ? outcome.value[0].text : undefined;
    expect(text).toMatch(/…$/);
    expect(text?.length).toBeLessThanOrEqual(16);
  });

  it('throws for an object that verify did not return', () => {
    const real = verified(bytes(reviewSubmitted()));
    expect(() => github.parse({ ...real })).toThrow(
      'parse takes only a delivery that verify passed',
    );
  });

  it('reads the bytes that were verified, not the buffer as it is later', () => {
    const payload = reviewSubmitted();
    const body = bytes(payload);
    const value = verified(body);
    body.fill(0x20);
    expect(github.parse(value)).toEqual(normalize('github', 'pull_request_review', payload));
  });

  it.each([
    ['missing', undefined],
    ['repeated', ['pull_request_review', 'pull_request_review']],
    ['not an event name', 'pull_request_review\r\nx-other: 1'],
    ['empty', ''],
  ])('reports an event header that is %s as malformed', (_name, value) => {
    const body = bytes(reviewSubmitted());
    expect(github.parse(verified(body, undefined, { 'x-github-event': value }))).toEqual({
      ok: false,
      error: { code: 'malformed', field: 'x-github-event' },
    });
  });

  it('ignores an event the catalog does not list', () => {
    expect(github.parse(verified(bytes(reviewSubmitted()), 'ping'))).toEqual({
      ok: false,
      error: { code: 'ignored', reason: 'event' },
    });
  });

  it.each([
    ['is not JSON', bytes('{"action":"submitted","marker-7f3a9":')],
    ['is form encoded', bytes(`payload=${encodeURIComponent(JSON.stringify(reviewSubmitted()))}`)],
    ['is not UTF-8', invalidUtf8()],
    ['is empty', Buffer.alloc(0)],
  ])('reports a body that %s as malformed, without its text', (_name, body) => {
    const outcome = github.parse(verified(body));
    expect(outcome).toEqual({ ok: false, error: { code: 'malformed', field: 'body' } });
    expect(JSON.stringify(outcome)).not.toContain('marker-7f3a9');
  });

  /**
   * The event header is not signed. Every real body is offered under every other listed
   * event's name: none may become an event, or a sender could relabel a captured delivery.
   */
  describe.each(AGENT_EVENT_TYPES)('a %s body', (type) => {
    const others = [
      ...new Set(AGENT_EVENT_TYPES.map((other) => catalog[other].event)),
      'issues',
      'check_run',
      'pull_request_review_thread',
    ].filter((event) => event !== catalog[type].event);

    it.each(others)('does not read as %s', (event) => {
      const outcome = github.parse(verified(bytes(fixtures[type]()), event));
      expect(outcome.ok).toBe(false);
    });
  });
});
