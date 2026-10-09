import {
  claimCodeDestination,
  reserveCodeDestination,
  createCodeDestinationSet,
  sortCodeFilesByDestinationPriority,
} from './destinations';
import { deterministicHexSuffix } from '~/utils/files';

/** The suffix the implementation derives for a displaced file, spelled the
 *  same way so the expectations read as names rather than as digests. */
const suffixFor = (identity: string): string => `-${deterministicHexSuffix(identity)}`;

describe('claimCodeDestination', () => {
  it('returns the name untouched when nothing has claimed it', () => {
    const set = createCodeDestinationSet();
    expect(claimCodeDestination(set, 'image.png', 'file-a')).toBe('image.png');
  });

  it('moves a displaced file onto its identity suffix, keeping the extension', () => {
    const set = createCodeDestinationSet();
    expect(claimCodeDestination(set, 'image.png', 'file-a')).toBe('image.png');
    expect(claimCodeDestination(set, 'image.png', 'file-b')).toBe(
      `image${suffixFor('file-b')}.png`,
    );
    expect(claimCodeDestination(set, 'image.png', 'file-c')).toBe(
      `image${suffixFor('file-c')}.png`,
    );
  });

  /**
   * The reason the suffix is not a collision counter. With `-2`, `-3`, a
   * third file arriving under the literal name a displaced file had been
   * given would push that file along, and code the model wrote in an earlier
   * turn would silently start reading the newcomer.
   */
  it('gives a displaced file the same destination whatever else is present', () => {
    const alone = createCodeDestinationSet();
    claimCodeDestination(alone, 'image.png', 'winner');
    const withoutNewcomer = claimCodeDestination(alone, 'image.png', 'displaced');

    const crowded = createCodeDestinationSet();
    claimCodeDestination(crowded, 'image.png', 'winner');
    claimCodeDestination(crowded, 'image-2.png', 'newcomer');
    claimCodeDestination(crowded, `image${suffixFor('unrelated')}.png`, 'unrelated');
    const withNewcomer = claimCodeDestination(crowded, 'image.png', 'displaced');

    expect(withNewcomer).toBe(withoutNewcomer);
  });

  /**
   * The one case where a displaced file does move, and why that is right.
   * The model is told the displaced file is at `<stem>-<hash>.png`, rewrites
   * it in place, and `processCodeOutput` registers the output under that
   * literal name. Next turn the output is the newest holder of that path, so
   * it keeps it and the superseded original steps aside — the model's
   * familiar path resolves to its own edit rather than to the bytes it
   * replaced.
   */
  it('leaves an alias with the later file that rewrote it, not the superseded original', () => {
    const firstTurn = createCodeDestinationSet();
    claimCodeDestination(firstTurn, 'image.png', 'newer-upload');
    const alias = claimCodeDestination(firstTurn, 'image.png', 'original');
    expect(alias).toBe(`image${suffixFor('original')}.png`);

    const secondTurn = createCodeDestinationSet();
    const rewrite = claimCodeDestination(secondTurn, alias, 'rewrite-output');
    claimCodeDestination(secondTurn, 'image.png', 'newer-upload');
    const originalNow = claimCodeDestination(secondTurn, 'image.png', 'original');

    expect(rewrite).toBe(alias);
    expect(originalNow).toBe(`image${suffixFor('original')}-2.png`);
  });

  it('preserves directory structure when disambiguating', () => {
    const set = createCodeDestinationSet();
    claimCodeDestination(set, 'out/plots/fig.png', 'file-a');
    expect(claimCodeDestination(set, 'out/plots/fig.png', 'file-b')).toBe(
      `out/plots/fig${suffixFor('file-b')}.png`,
    );
  });

  it('appends to names without an extension', () => {
    const set = createCodeDestinationSet();
    claimCodeDestination(set, 'README', 'file-a');
    expect(claimCodeDestination(set, 'README', 'file-b')).toBe(`README${suffixFor('file-b')}`);
  });

  it('treats a leading dot as part of the name, not an extension', () => {
    const set = createCodeDestinationSet();
    claimCodeDestination(set, '_.env', 'file-a');
    expect(claimCodeDestination(set, '_.env', 'file-b')).toBe(`_${suffixFor('file-b')}.env`);
  });

  it('falls back to a counter when two claims share an identity', () => {
    const set = createCodeDestinationSet();
    claimCodeDestination(set, 'image.png', 'same');
    expect(claimCodeDestination(set, 'image.png', 'same')).toBe(`image${suffixFor('same')}.png`);
    expect(claimCodeDestination(set, 'image.png', 'same')).toBe(`image${suffixFor('same')}-2.png`);
  });

  it('rejects a destination that a claimed directory prefix would swallow', () => {
    const set = createCodeDestinationSet();
    claimCodeDestination(set, 'data/rows.csv', 'file-a');
    expect(claimCodeDestination(set, 'data', 'file-b')).toBe(`data${suffixFor('file-b')}`);
  });

  it('flattens a destination nested under a claimed file', () => {
    const set = createCodeDestinationSet();
    claimCodeDestination(set, 'data', 'file-a');
    expect(claimCodeDestination(set, 'data/rows.csv', 'file-b')).toBe('data__rows.csv');
  });

  it('still disambiguates once a nested destination has been flattened', () => {
    const set = createCodeDestinationSet();
    claimCodeDestination(set, 'data', 'file-a');
    claimCodeDestination(set, 'data__rows.csv', 'file-b');
    expect(claimCodeDestination(set, 'data/rows.csv', 'file-c')).toBe(
      `data__rows${suffixFor('file-c')}.csv`,
    );
  });

  it('keeps a disambiguated leaf inside the per-segment byte budget', () => {
    const set = createCodeDestinationSet();
    const longName = `${'a'.repeat(251)}.png`;
    expect(Buffer.byteLength(longName, 'utf8')).toBe(255);
    claimCodeDestination(set, longName, 'file-a');
    const second = claimCodeDestination(set, longName, 'file-b');
    expect(second).not.toBe(longName);
    expect(Buffer.byteLength(second, 'utf8')).toBeLessThanOrEqual(255);
    expect(second.endsWith(`${suffixFor('file-b')}.png`)).toBe(true);
  });

  /**
   * The search only terminates while trimming a name to the byte cap leaves
   * the suffix intact. An earlier cut-from-the-end trim handed back the
   * original name for every attempt and hung the request thread, so this
   * asserts distinctness at the cap rather than trusting the composition.
   */
  it('keeps destinations distinct at the byte cap across repeated collisions', () => {
    const set = createCodeDestinationSet();
    const longName = `${'a'.repeat(251)}.png`;
    const claimed = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const destination = claimCodeDestination(set, longName, `file-${i}`);
      expect(Buffer.byteLength(destination, 'utf8')).toBeLessThanOrEqual(255);
      expect(claimed.has(destination)).toBe(false);
      claimed.add(destination);
    }
    expect(claimed.size).toBe(12);
  });

  /**
   * A name that arrives over budget is passed through untouched — capping
   * every name would rewrite paths the caller never had a collision on. Only
   * the disambiguated forms are held to the cap, and they must stay distinct
   * even when the extension leaves no stem to trim.
   */
  it('keeps destinations distinct when the extension consumes the whole budget', () => {
    const set = createCodeDestinationSet();
    const longExtension = `_.${'b'.repeat(260)}`;
    expect(claimCodeDestination(set, longExtension, 'file-0')).toBe(longExtension);

    const claimed = new Set<string>();
    for (let i = 1; i < 6; i++) {
      const destination = claimCodeDestination(set, longExtension, `file-${i}`);
      expect(Buffer.byteLength(destination, 'utf8')).toBeLessThanOrEqual(255);
      expect(claimed.has(destination)).toBe(false);
      claimed.add(destination);
    }
    expect(claimed.size).toBe(5);
  });
});

describe('reserveCodeDestination', () => {
  it('accepts a free name and refuses the repeat', () => {
    const set = createCodeDestinationSet();
    expect(reserveCodeDestination(set, 'image.png')).toBe(true);
    expect(reserveCodeDestination(set, 'image.png')).toBe(false);
  });

  it('refuses either direction of a directory-prefix conflict', () => {
    const nested = createCodeDestinationSet();
    reserveCodeDestination(nested, 'data/rows.csv');
    expect(reserveCodeDestination(nested, 'data')).toBe(false);

    const flat = createCodeDestinationSet();
    reserveCodeDestination(flat, 'data');
    expect(reserveCodeDestination(flat, 'data/rows.csv')).toBe(false);
  });

  it('leaves unrelated names alone', () => {
    const set = createCodeDestinationSet();
    reserveCodeDestination(set, 'data/rows.csv');
    expect(reserveCodeDestination(set, 'database.csv')).toBe(true);
    expect(reserveCodeDestination(set, 'data/other.csv')).toBe(true);
  });

  it('does not reserve a name it refused', () => {
    const set = createCodeDestinationSet();
    reserveCodeDestination(set, 'data');
    expect(reserveCodeDestination(set, 'data/rows.csv')).toBe(false);
    expect(claimCodeDestination(set, 'data/rows.csv', 'file-b')).toBe('data__rows.csv');
  });
});

describe('sortCodeFilesByDestinationPriority', () => {
  it('puts the newest record first so it keeps the bare name', () => {
    const older = { file_id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') };
    const newer = { file_id: 'b', createdAt: new Date('2026-02-01T00:00:00Z') };
    expect(sortCodeFilesByDestinationPriority([older, newer])).toEqual([newer, older]);
  });

  it('accepts serialized dates and epoch millis', () => {
    const older = { file_id: 'a', createdAt: '2026-01-01T00:00:00.000Z' };
    const newer = { file_id: 'b', createdAt: Date.parse('2026-02-01T00:00:00.000Z') };
    expect(sortCodeFilesByDestinationPriority([older, newer])).toEqual([newer, older]);
  });

  /**
   * `processCodeOutput` claims one row per `(filename, conversationId)` and
   * rewrites it in place with `$setOnInsert`, so a repeatedly written output
   * keeps its original `createdAt`. Ranking on that alone would hand the bare
   * path to an upload the output has since been rewritten over.
   */
  it('ranks a rewritten output by its last content write, not its creation', () => {
    const output = {
      file_id: 'output',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      metadata: { sourceDispatchedAt: Date.parse('2026-03-01T00:00:00Z') },
    };
    const upload = { file_id: 'upload', createdAt: new Date('2026-02-01T00:00:00Z') };
    expect(sortCodeFilesByDestinationPriority([upload, output])).toEqual([output, upload]);
  });

  it('never lets a stale write stamp drag a record below its creation', () => {
    const output = {
      file_id: 'output',
      createdAt: new Date('2026-03-01T00:00:00Z'),
      metadata: { sourceDispatchedAt: Date.parse('2026-01-01T00:00:00Z') },
    };
    const upload = { file_id: 'upload', createdAt: new Date('2026-02-01T00:00:00Z') };
    expect(sortCodeFilesByDestinationPriority([upload, output])).toEqual([output, upload]);
  });

  /**
   * Every agent in a run primes the conversation's files plus its own. If a
   * private file could outrank a shared one, two agents would advertise
   * different paths for the same shared file into one mount namespace.
   */
  it('sinks contributor-private files below shared ones regardless of age', () => {
    const shared = { file_id: 'shared', createdAt: new Date('2026-01-01T00:00:00Z') };
    const priv = { file_id: 'private', createdAt: new Date('2026-06-01T00:00:00Z') };
    expect(sortCodeFilesByDestinationPriority([priv, shared], new Set(['private']))).toEqual([
      shared,
      priv,
    ]);
  });

  it('still ranks by recency within each scope', () => {
    const sharedOld = { file_id: 's1', createdAt: new Date('2026-01-01T00:00:00Z') };
    const sharedNew = { file_id: 's2', createdAt: new Date('2026-02-01T00:00:00Z') };
    const privOld = { file_id: 'p1', createdAt: new Date('2026-03-01T00:00:00Z') };
    const privNew = { file_id: 'p2', createdAt: new Date('2026-04-01T00:00:00Z') };
    expect(
      sortCodeFilesByDestinationPriority(
        [privOld, sharedOld, privNew, sharedNew],
        new Set(['p1', 'p2']),
      ),
    ).toEqual([sharedNew, sharedOld, privNew, privOld]);
  });

  it('breaks ties on file_id so the order is stable across turns', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const first = { file_id: 'aaa', createdAt };
    const second = { file_id: 'bbb', createdAt };
    expect(sortCodeFilesByDestinationPriority([second, first])).toEqual([first, second]);
    expect(sortCodeFilesByDestinationPriority([first, second])).toEqual([first, second]);
  });

  it('sorts records without a timestamp last rather than dropping them', () => {
    const dated = { file_id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') };
    const undatedEarly = { file_id: 'b' };
    const unparsable = { file_id: 'c', createdAt: 'not-a-date' };
    expect(sortCodeFilesByDestinationPriority([undatedEarly, unparsable, dated])).toEqual([
      dated,
      undatedEarly,
      unparsable,
    ]);
  });

  it('preserves holes instead of throwing on them', () => {
    const dated = { file_id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') };
    expect(sortCodeFilesByDestinationPriority([null, dated, undefined])).toEqual([
      dated,
      null,
      undefined,
    ]);
  });

  it('does not mutate its input', () => {
    const older = { file_id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') };
    const newer = { file_id: 'b', createdAt: new Date('2026-02-01T00:00:00Z') };
    const input = [older, newer];
    sortCodeFilesByDestinationPriority(input);
    expect(input).toEqual([older, newer]);
  });
});
