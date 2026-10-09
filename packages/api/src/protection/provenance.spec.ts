import { getUserSubmittedMessageFieldPathState, getUserSubmittedPathState } from './provenance';

describe('getUserSubmittedPathState', () => {
  it('keeps only pointers that resolve through safe own properties and expands steer parts', () => {
    const inherited = { inherited: 'not submitted' };
    const message = Object.assign(Object.create(inherited), {
      text: 'submitted text',
      messageId: 'not submitted content',
      attachments: [{ file_id: 'submitted-file' }],
      content: [
        { type: 'text', text: 'model text' },
        { type: 'steer', steer: 'submitted steer' },
        Object.create({ type: 'steer' }),
      ],
      userSubmittedPaths: [
        '/text',
        '/attachments/0',
        '/text',
        '/missing',
        '/messageId',
        '/inherited',
        '/__proto__/polluted',
        '/content/~2invalid',
        'not-a-pointer',
      ],
    });

    expect(getUserSubmittedPathState(message)).toEqual({
      paths: ['/text', '/attachments/0', '/content/1'],
      overflowed: false,
    });
  });

  it('supports the additional protected metadata roots in shared-message projections', () => {
    const message = {
      iconURL: 'submitted icon',
      userSubmittedPaths: ['/iconURL'],
    };

    expect(getUserSubmittedPathState(message)).toEqual({ paths: [], overflowed: false });
    expect(getUserSubmittedPathState(message, { scope: 'shared_message' })).toEqual({
      paths: ['/iconURL'],
      overflowed: false,
    });
  });

  it('discovers semantic steer provenance only at retained source indices', () => {
    let contentReads = 0;
    const values = new Array<unknown>(4_096);
    values[0] = { type: 'steer', steer: 'pruned steer' };
    values[4_095] = { type: 'steer', steer: 'retained steer' };
    const content = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          contentReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(getUserSubmittedPathState({ content }, { semanticContentPartIndices: [4_095] })).toEqual(
      { paths: ['/content/4095'], overflowed: false },
    );
    expect(contentReads).toBe(1);
  });

  it('fails closed when unique bounded pointer candidates exceed 256', () => {
    const content = Array.from({ length: 257 }, (_, index) => ({ text: `part-${index}` }));

    const result = getUserSubmittedPathState({
      content,
      userSubmittedPaths: content.map((_, index) => `/content/${index}/text`),
    });

    expect(result.overflowed).toBe(true);
    expect(result.paths).toHaveLength(256);
    expect(result.paths[0]).toBe('/content/0/text');
    expect(result.paths[255]).toBe('/content/255/text');
  });

  it('bounds sparse provenance carriers before walking their declared lengths', () => {
    let contentReads = 0;
    let pathReads = 0;
    const sparseContent = new Proxy(new Array<unknown>(10_000_000), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          contentReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const sparsePaths = new Proxy(new Array<unknown>(10_000_000), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          pathReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    sparsePaths[0] = '/text';

    const result = getUserSubmittedPathState({
      text: 'submitted',
      content: sparseContent,
      userSubmittedPaths: sparsePaths,
    });

    expect(result).toEqual({ paths: ['/text'], overflowed: true });
    expect(pathReads).toBeLessThanOrEqual(257);
    expect(contentReads).toBe(0);
  });

  it('bounds sparse semantic content and marks the incomplete scan fail-closed', () => {
    let contentReads = 0;
    const values = new Array<unknown>(10_000_000);
    values[0] = { type: 'steer', steer: 'visible steer' };
    const content = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          contentReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(getUserSubmittedPathState({ content })).toEqual({
      paths: ['/content/0'],
      overflowed: true,
    });
    expect(contentReads).toBeLessThanOrEqual(4_096);
  });

  it('rejects invalid provenance array lengths without dispatching iterators', () => {
    let iteratorReads = 0;
    const invalidPaths = new Proxy(['/text'], {
      get(target, property, receiver) {
        if (property === 'length') {
          return Number.NaN;
        }
        if (property === Symbol.iterator) {
          iteratorReads++;
          throw new Error('provenance iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const invalidContent = new Proxy([{ type: 'steer', steer: 'submitted' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          return -1;
        }
        if (property === Symbol.iterator) {
          iteratorReads++;
          throw new Error('content iterator must not run');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      getUserSubmittedPathState({ text: 'submitted', userSubmittedPaths: invalidPaths }),
    ).toEqual({ paths: [], overflowed: true });
    expect(getUserSubmittedPathState({ content: invalidContent })).toEqual({
      paths: [],
      overflowed: true,
    });
    expect(iteratorReads).toBe(0);
  });

  it('captures a changing provenance length once', () => {
    let lengthReads = 0;
    const paths = new Proxy(['/text'], {
      get(target, property, receiver) {
        if (property === 'length') {
          lengthReads++;
          return lengthReads === 1 ? 1 : Number.NaN;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(getUserSubmittedPathState({ text: 'submitted', userSubmittedPaths: paths })).toEqual({
      paths: ['/text'],
      overflowed: false,
    });
    expect(lengthReads).toBe(1);
  });

  it('ignores overlong pointers without weakening effective bounded paths', () => {
    const overlong = `/${'x'.repeat(2048)}`;

    expect(
      getUserSubmittedPathState({
        text: 'submitted text',
        userSubmittedPaths: [overlong, '/text'],
      }),
    ).toEqual({ paths: ['/text'], overflowed: false });
  });

  it('keeps exact HITL field identity separate from generic provenance paths', () => {
    const message = {
      content: [{ tool_call: { output: 'submitted answer' } }],
      userSubmittedMessageFieldPaths: [
        { path: '/content/0/tool_call/output', field: 'answer' },
        { path: '/content/0/tool_call/output', field: 'content_part' },
        { path: '/missing', field: 'decision_reason' },
      ],
    };

    expect(getUserSubmittedPathState(message)).toEqual({ paths: [], overflowed: false });
    expect(getUserSubmittedMessageFieldPathState(message)).toEqual({
      entries: [{ path: '/content/0/tool_call/output', field: 'answer' }],
      overflowed: false,
    });
  });

  it('does not read content when exact HITL field metadata is absent', () => {
    let contentReads = 0;
    const message = {
      get content(): never {
        contentReads++;
        throw new Error('unrelated hostile content accessor');
      },
    };

    expect(getUserSubmittedMessageFieldPathState(message)).toEqual({
      entries: [],
      overflowed: false,
    });
    expect(contentReads).toBe(0);
  });

  it('bounds sparse semantic field carriers and treats access failures as overflow', () => {
    let fieldPathReads = 0;
    const values = new Array<unknown>(10_000_000);
    values[0] = { path: '/content/0/tool_call/output', field: 'answer' };
    const fieldPaths = new Proxy(values, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          fieldPathReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const content = [{ tool_call: { output: 'submitted answer' } }];

    expect(
      getUserSubmittedMessageFieldPathState({
        content,
        userSubmittedMessageFieldPaths: fieldPaths,
      }),
    ).toEqual({
      entries: [{ path: '/content/0/tool_call/output', field: 'answer' }],
      overflowed: true,
    });
    expect(fieldPathReads).toBeLessThanOrEqual(256);

    const throwingPaths: unknown[] = [];
    Object.defineProperty(throwingPaths, '0', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('hostile path accessor');
      },
    });
    throwingPaths.length = 1;
    expect(
      getUserSubmittedMessageFieldPathState({
        content,
        userSubmittedMessageFieldPaths: throwingPaths,
      }),
    ).toEqual({ entries: [], overflowed: true });
  });

  it('captures provenance carrier properties and array lengths exactly once', () => {
    let contentCarrierReads = 0;
    let pathCarrierReads = 0;
    let fieldCarrierReads = 0;
    let contentLengthReads = 0;
    let pathLengthReads = 0;
    let fieldLengthReads = 0;
    const content = new Proxy([{ type: 'steer', steer: 'submitted steer' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          contentLengthReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const paths = new Proxy(['/content/0'], {
      get(target, property, receiver) {
        if (property === 'length') {
          pathLengthReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const fieldPaths = new Proxy([{ path: '/content/0/steer', field: 'answer' }], {
      get(target, property, receiver) {
        if (property === 'length') {
          fieldLengthReads++;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const message = {
      get content() {
        contentCarrierReads++;
        return content;
      },
      get userSubmittedPaths() {
        pathCarrierReads++;
        return paths;
      },
      get userSubmittedMessageFieldPaths() {
        fieldCarrierReads++;
        return fieldPaths;
      },
    };

    expect(getUserSubmittedPathState(message)).toEqual({
      paths: ['/content/0'],
      overflowed: false,
    });
    expect(getUserSubmittedMessageFieldPathState(message)).toEqual({
      entries: [{ path: '/content/0/steer', field: 'answer' }],
      overflowed: false,
    });
    expect(contentCarrierReads).toBe(2);
    expect(pathCarrierReads).toBe(1);
    expect(fieldCarrierReads).toBe(1);
    expect(contentLengthReads).toBe(1);
    expect(pathLengthReads).toBe(1);
    expect(fieldLengthReads).toBe(1);
  });
});
