import { MAX_PART, MAX_SPAN, findEmails, hasAtSign, maskEmails, maskSpans } from './email';
import { READS_PER_CHAR, reads } from './test-helpers';

const MASK = '[REDACTED_EMAIL]';

type Case = [label: string, input: string, expected: string];

describe('maskEmails coverage contract', () => {
  it.each<Case>([
    ['a tagged address', 'login for jane.doe+tag@example.co.uk | ok', `login for ${MASK} | ok`],
    ['two addresses', 'a@b.com and c@d.org', `${MASK} and ${MASK}`],
    ['RFC atext punctuation', 'user customer/dept=ship@example.com ok', `user ${MASK} ok`],
    ['a double solidus outside a URL', 'user customer//dept@example.com ok', `user ${MASK} ok`],
    ['an apostrophe', "mary.jane'o_connor@example.com", MASK],
    ['a one-character final label', 'user@example.c ok', `${MASK} ok`],
    ['a trailing full stop', 'mail jane@example.com.', `mail ${MASK}.`],
  ])('masks ASCII: %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it.each<Case>([
    ['accented letters', 'user jöhn@exämple.de ok', `user ${MASK} ok`],
    ['CJK', 'user 用户@例子.公司 ok', `user ${MASK} ok`],
    ['combining marks', 'user@उदाहरण.भारत ok', `${MASK} ok`],
    ['an emoji local part', 'jane😀doe@example.com ok', `${MASK} ok`],
    ['ideographic full stops', 'jane@例子。中国 ok', `${MASK} ok`],
    ['a Catalan middle dot', 'jane@col·legi.cat ok', `${MASK} ok`],
    ['a typographic apostrophe', 'mary.o’connor@example.com', MASK],
    ['a JSON \\u escape', 'jane\\u00e9@ex\\u00e4mple.com', MASK],
    ['full-width punctuation before it', '用户：jane@x.com', `用户：${MASK}`],
  ])('masks Unicode: %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it.each<Case>([
    ['a space', 'user "jane doe"@example.com ok', `user ${MASK} ok`],
    ['an escaped quote', 'user "jane\\"doe"@example.com ok', `user ${MASK} ok`],
    ['an escaped backslash', 'user "jane\\\\"@example.com ok', `user ${MASK} ok`],
    ['no content', '""@blocked.example ok', `${MASK} ok`],
    ['a dotted quoted word', 'john."jane doe"@example.com', MASK],
    ['a quoted word before a dot', '"jane doe".smith@example.com', MASK],
    ['a key before it', 'key="jane doe"@x.com', `key=${MASK}`],
    ['a stray quote before it', 'note: " and "jane doe"@example.com', `note: " and ${MASK}`],
    ['an escaped opening quote', 'id \\"jane doe"@example.com', `id ${MASK}`],
    ['a comment', 'user(comment)@blocked.example ok', `${MASK} ok`],
  ])('masks a raw quoted local part with %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it.each([
    'jane doe',
    'jane\\"doe',
    'jane\\doe',
    'jane\\\\doe',
    'jane\tdoe',
    'jane\\\\',
    'a/b',
    'x y\\"z',
  ])('masks the quoted local part %j serialized once and twice, keeping the JSON', (local) => {
    const once = JSON.stringify({ email: `"${local}"@example.com` });
    expect(maskEmails(once)).toBe(`{"email":"${MASK}"}`);
    const twice = JSON.stringify(once);
    expect(maskEmails(twice)).toBe(JSON.stringify(`{"email":"${MASK}"}`));
  });

  it('masks a serialized local part with an escaped solidus', () => {
    const input = JSON.stringify({ email: '"a/b"@example.com' }).replace('/', '\\/');
    expect(maskEmails(input)).toBe(`{"email":"${MASK}"}`);
  });

  it('masks a serialized closing quote back to its string when no opening quote matches', () => {
    expect(maskEmails('{"note":"jane doe\\"@example.com"}')).toBe(`{"note":"${MASK}"}`);
  });

  it.each<Case>([
    ['IPv4', 'user@[192.0.2.1] ok', `${MASK} ok`],
    ['IPv6', 'user@[IPv6:2001:db8::1] ok', `${MASK} ok`],
    ['a bracketed label', '[Email: a@b.com]', `[Email: ${MASK}]`],
  ])('masks an address literal: %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it.each<Case>([
    ['%40', 'GET /v1?email=jane%40example.com&x=1', `GET /v1?email=${MASK}&x=1`],
    ['%2540', 'GET /v1?email=jane%2540example.com&x=1', `GET /v1?email=${MASK}&x=1`],
    ['%252540', 'next=jane%252540example.com', `next=${MASK}`],
    ['eight %25 levels', `q=jane%${'25'.repeat(8)}40example.com`, `q=${MASK}`],
    ['an encoded dot', 'GET /v1?email=jane%40example%2Ecom&x=1', `GET /v1?email=${MASK}&x=1`],
    ['a doubly encoded dot', 'e=jane%2540example%252ecom&x=1', `e=${MASK}&x=1`],
    [
      'an encoded redirect_uri',
      'redirect_uri=https%3A%2F%2Fx%3Femail%3Djane%2540example.com&a=1',
      `redirect_uri=${MASK}&a=1`,
    ],
    ['an encoded non-ASCII domain', 'e=jane%40b%C3%BCcher.de', `e=${MASK}`],
    ['an encoded IPv6 literal', 'e=user%40%5BIPv6%3A2001%3Adb8%3A%3A1%5D&x=1', `e=${MASK}&x=1`],
    [
      'an encoded ideographic full stop',
      'e=jane%40%E4%BE%8B%E5%AD%90%E3%80%82cn&x=1',
      `e=${MASK}&x=1`,
    ],
    [
      'a doubly encoded full-width full stop',
      'e=jane%2540ex%25EF%25BC%258Ecom&x=1',
      `e=${MASK}&x=1`,
    ],
    ['a doubly encoded IPv6 literal', 'e=user%2540%255BIPv6%253A%253A1%255D&x=1', `e=${MASK}&x=1`],
  ])('masks a percent-encoded address: %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it.each<Case>([
    ['mailto:', 'href=mailto:jane@example.com', `href=mailto:${MASK}`],
    ['mailto: encoded', 'mailto:jane%40example.com', `mailto:${MASK}`],
    [
      'angle brackets',
      'Jane <jane@example.com>, Bob <bob@example.org>',
      `Jane <${MASK}>, Bob <${MASK}>`,
    ],
    ['HTML-escaped angle brackets', '&lt;jane@example.com&gt;', `&lt;${MASK}&gt;`],
    ['parentheses', '(jane@example.com)', `(${MASK})`],
    ['a JSON field', '{"to":"jane@example.com","n":1}', `{"to":"${MASK}","n":1}`],
    [
      'a serialized JSON field',
      '"{\\"to\\":\\"jane@example.com\\"}"',
      `"{\\"to\\":\\"${MASK}\\"}"`,
    ],
    ['URI userinfo', 'https://user@example.com/path?x=1', `https://${MASK}/path?x=1`],
    ['a file URL', 'file:///home/jane@example.com/x', `file:///${MASK}/x`],
    ['a port', 'smtp jane@example.com:587', `smtp ${MASK}:587`],
    ['a path after a slash-ending local part', 'customer/@example.com/profile', `${MASK}/profile`],
    ['a handle in a URL path', 'https://social.example/@jane.doe/123', `https://${MASK}/123`],
  ])('masks a wrapped address in place: %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it.each([
    ['U+200B', '\u200b'],
    ['U+200C', '\u200c'],
    ['U+200D', '\u200d'],
    ['U+2060', '\u2060'],
    ['U+FEFF', '\ufeff'],
    ['U+00AD', '\u00ad'],
  ])('reads %s inside an address as part of it', (_label, zero) => {
    for (const input of [
      `ja${zero}ne@example.com`,
      `jane${zero}@${zero}example.com`,
      `jane@exa${zero}mple.c${zero}om`,
    ]) {
      expect(maskEmails(`id ${input} ok`)).toBe(`id ${MASK} ok`);
    }
  });

  it('reads a serialized zero-width escape inside an address as part of it', () => {
    expect(maskEmails('"ja\\u200bne@exa\\u200bmple.com"')).toBe(`"${MASK}"`);
  });

  it.each<Case>([
    ['a comma', 'user@exa,mple.com', MASK],
    ['a comma before a dot', 'jane@example,.com', MASK],
    ['a semicolon', 'jane@exa;mple.com', MASK],
    ['an apostrophe', "jane@exa'mple.com", MASK],
    ['a bracketed identifier', '[Identifier: user@exa,mple.com]', `[Identifier: ${MASK}]`],
    ['a comma and another at sign', 'id user@exa,mple.com@x ok', `id ${MASK}@x ok`],
  ])('masks a domain with %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it.each<Case>([
    ['an apostrophe', "jane@exa.mple'private.com ok", `${MASK} ok`],
    ['an exclamation mark', 'jane@exa.mple!private.com ok', `${MASK} ok`],
    ['parentheses', 'jane@exa.mple(private).com ok', `${MASK} ok`],
    ['a path to a file', 'see https://user@example.com/a/b.json ok', `see https://${MASK} ok`],
  ])(
    'masks to the end of the token when %s leads into another dotted label',
    (_label, input, expected) => {
      expect(maskEmails(input)).toBe(expected);
    },
  );

  it.each<Case>([
    ['a possessive', "jane@example.com's account", `${MASK}'s account`],
    ['a closing parenthesis and full stop', '(jane@example.com).', `(${MASK}).`],
    ['a query', 'mailto:jane@example.com?subject=hi', `mailto:${MASK}?subject=hi`],
    ['a serialized quote', '"{\\"to\\":\\"jane@example.com\\"}"', `"{\\"to\\":\\"${MASK}\\"}"`],
  ])('keeps %s after a domain in place', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });

  it('masks across JSON strings that a comment spans, never leaving part of it out', () => {
    const output = maskEmails('{"a":"(x","b":"y)@example.com"}');
    expect(output).toContain(MASK);
    expect(output).not.toMatch(/y\)|example/);
  });

  it('keeps the separator of a comma or semicolon separated list', () => {
    expect(maskEmails('a@b.com,c.d@e.com;f@g.com')).toBe(`${MASK},${MASK};${MASK}`);
  });

  it.each<Case>([
    ['a nested comment', 'jane(outer(inner))@example.com ok', `${MASK} ok`],
    ['a stray parenthesis', 'id jane)@example.com ok', `id ${MASK} ok`],
    ['a colon', 'id jane:@example.com ok', `id ${MASK} ok`],
    ['an escaped at sign', 'id jane\\@example.com ok', `id ${MASK} ok`],
    ['a closing bracket', 'id jane」@example.com ok', `id ${MASK} ok`],
    ['an encoded at sign', 'q=jane)%40example.com&x=1', `q=${MASK}&x=1`],
    ['text glued to a failed at sign', 'jane@ex)@ample.com', MASK],
  ])(
    'masks the token the earlier patterns masked when no local part is read: %s',
    (_label, input, expected) => {
      expect(maskEmails(input)).toBe(expected);
    },
  );

  it.each<Case>([
    ['at signs', 'jane@ex@ample.com', MASK],
    ['a handle', '@user@instance.social', MASK],
    ['an address after a domain', 'a@b.com@c.com', MASK],
    ['encoded at signs', 'jane%40ex%40ample.com', MASK],
    ['an at sign in a comment', 'alice(work@home)@example.com', MASK],
    ['an address in a comment', 'alice(work@home.com)@example.com', MASK],
    ['an at sign in a nested comment', 'alice(a(b@c)d)@example.com', MASK],
    ['a nested comment with spaces', 'jane(outer (inner))@example.com', MASK],
    ['a comment with spaces and an at sign', 'jane(a (b@c) d)@example.com ok', `${MASK} ok`],
    ['a quoted string in a comment', 'jane("work")@example.com ok', `${MASK} ok`],
    ['a parenthesis quoted in a comment', 'jane("wo)rk")@example.com ok', `${MASK} ok`],
    ['an escaped parenthesis in a comment', 'jane(wo\\)rk)@example.com ok', `${MASK} ok`],
    ['a serialized comment', '{"to":"jane(\\"work\\")@example.com"}', `{"to":"${MASK}"}`],
    [
      'an escaped parenthesis in a serialized comment',
      JSON.stringify('alice(\\(work)@example.com'),
      `"${MASK}"`,
    ],
    [
      'an escaped parenthesis before an atom',
      JSON.stringify('alice(\\(work)x@example.com'),
      `"${MASK}"`,
    ],
    [
      'a comment alone after a stray parenthesis',
      'id alice)(work)@example.com ok',
      `id ${MASK} ok`,
    ],
    [
      'an escaped parenthesis and a space in a serialized comment',
      JSON.stringify('alice(a\\) b)@example.com'),
      `"${MASK}"`,
    ],
    ['a raw escaped backslash closing a comment', 'id qzq.(\\\\)x@example.com ok', `id ${MASK} ok`],
    [
      'a serialized quoted string holding a parenthesis in a comment',
      JSON.stringify('qzq.(x y."a)b")x@example.com'),
      `"${MASK}"`,
    ],
    [
      'a doubly serialized comment',
      JSON.stringify(JSON.stringify('alice(a\\) b "c")@example.com')),
      JSON.stringify(`"${MASK}"`),
    ],
    ['a colon before an at sign glued to the next', 'alice:work@home)@example.com', MASK],
  ])('never leaves text glued to an address outside the mask: %s', (_label, input, expected) => {
    expect(maskEmails(input)).toBe(expected);
  });
});

describe('maskEmails non-goals', () => {
  it.each([
    'mention @handle and v1.2.3',
    'a@b and user@localhost',
    'jane at example dot com',
    'jane @ example.com',
    'jane＠example.com',
    'jane&#64;example.com',
    '    at Run.processStream (/app/node_modules/@librechat/agents/dist/cjs/run.cjs:120:5)',
    '    at file:///app/node_modules/@scope.name/pkg/index.mjs:1:1',
    '    at load (C:\\app\\node_modules\\@scope\\pkg\\index.js:1:1)',
    'postgresql://[REDACTED]@example.test/app',
    'redis://[REDACTED]@example.test:6379',
    '["@example.com"]',
    'user@exa"mple.com',
    `q=jane%${'25'.repeat(9)}40example.com`,
  ])('leaves %j as it is', (input) => {
    expect(maskEmails(input)).toBe(input);
  });

  it('reads an unescaped inner quote of a malformed quoted local part as its opening quote', () => {
    expect(maskEmails('"jane"doe"@example.com')).toBe(`"jane${MASK}`);
  });
});

describe('maskEmails bounds', () => {
  it('masks a local part longer than MAX_PART from the bound outward', () => {
    const input = `${'a'.repeat(MAX_PART + 100)}@example.com`;
    expect(maskEmails(input)).toBe(`${'a'.repeat(100)}${MASK}`);
  });

  it('masks a domain longer than MAX_PART up to the bound', () => {
    const input = `jane@example.${'b'.repeat(MAX_PART + 100)}`;
    expect(maskEmails(input)).toBe(`${MASK}${'b'.repeat(100 + 'example.'.length)}`);
  });

  it('masks a quoted local part longer than MAX_PART from the bound outward', () => {
    const input = `"jane ${'x'.repeat(MAX_PART)}"@example.com`;
    const output = maskEmails(input);
    expect(output.endsWith(MASK)).toBe(true);
    expect(output.length).toBe(input.length - (MAX_PART + '@example.com'.length) + MASK.length);
  });

  it('masks a quoted local part of up to MAX_PART units whole', () => {
    expect(maskEmails(`"jane ${'x'.repeat(MAX_PART - 10)}"@example.com tail`)).toBe(`${MASK} tail`);
  });

  it('keeps a long run that is not an address', () => {
    const input = `${'_'.repeat(50_000)}@${'-'.repeat(50_000)}`;
    expect(maskEmails(input)).toBe(input);
  });

  it.each<[label: string, flood: string]>([
    ['at signs', 'a@'.repeat(50_000)],
    ['a long dotted domain', `a@${'a.'.repeat(50_000)}`],
    ['quotes before at signs', '"a@'.repeat(30_000)],
    ['escaped quotes before at signs', '\\"@'.repeat(30_000)],
    ['quoted words', '"x"@'.repeat(30_000)],
    ['closing parentheses', ')@'.repeat(50_000)],
    ['comments', '(a)@'.repeat(30_000)],
    ['unpaired parentheses', 'a)@'.repeat(30_000)],
    ['open comments with at signs', `${'(a@'.repeat(30_000)})@example.com`],
    ['nested parentheses', `${'('.repeat(30_000)}${')@'.repeat(30_000)}`],
    ['quotes in a comment', `(${'"x'.repeat(30_000)})@example.com`],
    ['serialized quotes in comments', `${('(\\"' + 'x'.repeat(10)).repeat(10_000)})@example.com`],
    ['escape runs in comments', `${('(' + '\\\\\\"'.repeat(500) + '\\"').repeat(40)})@x.com`],
    ['a backslash run in a comment', `(${'\\'.repeat(100_000)})@example.com`],
    ['open quoted comments', '("'.repeat(30_000)],
    ['encoded at signs', 'a%40'.repeat(50_000)],
    ['encoded at signs after URL syntax', '?a%40'.repeat(30_000)],
    ['doubly encoded at signs', 'a%2540'.repeat(20_000)],
    ['open literals', 'u@['.repeat(30_000)],
    ['comma lists', 'a@b.c,'.repeat(30_000)],
    ['commas after a label', `a@b${',c'.repeat(50_000)}`],
    ['backslash runs before quotes', ('\\'.repeat(1000) + '"@').repeat(100)],
    ['escaped quotes in quoted words', ('"' + 'a\\"'.repeat(1000) + '"@').repeat(50)],
    ['emoji before at signs', '😀@'.repeat(30_000)],
    ['a solidus run before an at sign', `${'/'.repeat(MAX_PART)}@example.com`],
    ['solidus runs before at signs', `${'/'.repeat(2000)}a@example.com `.repeat(20)],
  ])('reads each character a bounded number of times on %s', (_label, flood) => {
    expect(reads(() => maskEmails(flood))).toBeLessThan(flood.length * READS_PER_CHAR);
  });
});

describe('findEmails and maskSpans', () => {
  it('reports each address span in order', () => {
    const text = 'to "jane doe"@example.com and bob@example.org.';
    expect(findEmails(text).map(({ start, end }) => text.slice(start, end))).toEqual([
      '"jane doe"@example.com',
      'bob@example.org',
    ]);
  });

  it('masks spans up to an end and drops the text after it', () => {
    const text = 'a jane@example.com b bob@example.org c';
    const spans = findEmails(text);
    expect(maskSpans(text, spans, text.indexOf(' b ') + 2)).toBe(`a ${MASK} b`);
    expect(maskSpans(text, spans)).toBe(`a ${MASK} b ${MASK} c`);
  });

  it('bounds a span by MAX_SPAN', () => {
    const text = `${'a'.repeat(MAX_PART * 2)}@example.${'b'.repeat(MAX_PART * 2)}`;
    const [span] = findEmails(text);
    expect(span.end - span.start).toBeLessThanOrEqual(MAX_SPAN);
  });
});

describe('hasAtSign', () => {
  it.each([
    ['jane@example.com', true],
    ['jane%40example.com', true],
    ['jane%2540example.com', true],
    ['jane%2Eexample', false],
    ['plain text', false],
  ])('%j holds an at sign: %s', (text, expected) => {
    expect(hasAtSign(text)).toBe(expected);
  });
});
