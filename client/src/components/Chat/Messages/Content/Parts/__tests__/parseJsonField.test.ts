import parseJsonField, {
  parseJsonFieldOccurrences,
  areToolCallArgsComplete,
} from '../parseJsonField';

describe('parseJsonField', () => {
  describe('object args', () => {
    it('returns the field value when present', () => {
      expect(parseJsonField({ skillName: 'mySkill' }, 'skillName')).toBe('mySkill');
    });

    it('returns empty string when field is missing', () => {
      expect(parseJsonField({ other: 'value' }, 'skillName')).toBe('');
    });

    it('returns empty string when field is null', () => {
      expect(parseJsonField({ skillName: null }, 'skillName')).toBe('');
    });

    it('coerces numeric field values to string', () => {
      expect(parseJsonField({ count: 42 }, 'count')).toBe('42');
    });

    it('handles different field names — file_path', () => {
      expect(parseJsonField({ file_path: '/home/user/file.ts' }, 'file_path')).toBe(
        '/home/user/file.ts',
      );
    });

    it('handles different field names — command', () => {
      expect(parseJsonField({ command: 'ls -la' }, 'command')).toBe('ls -la');
    });
  });

  describe('undefined args', () => {
    it('returns empty string for undefined', () => {
      expect(parseJsonField(undefined, 'skillName')).toBe('');
    });
  });

  describe('valid JSON string args', () => {
    it('returns the field value when present', () => {
      expect(parseJsonField('{"skillName":"mySkill"}', 'skillName')).toBe('mySkill');
    });

    it('returns empty string when field is missing from parsed JSON', () => {
      expect(parseJsonField('{"other":"value"}', 'skillName')).toBe('');
    });

    it('handles different field names — file_path', () => {
      expect(parseJsonField('{"file_path":"/tmp/out.txt"}', 'file_path')).toBe('/tmp/out.txt');
    });

    it('handles different field names — command', () => {
      expect(parseJsonField('{"command":"echo hello"}', 'command')).toBe('echo hello');
    });
  });

  describe('empty string args', () => {
    it('returns empty string for empty string input', () => {
      expect(parseJsonField('', 'skillName')).toBe('');
    });
  });

  describe('partial/streaming JSON — regex fallback', () => {
    it('extracts field from malformed partial JSON', () => {
      const partial = '{"skillName":"mySkill","incomplete":';
      expect(parseJsonField(partial, 'skillName')).toBe('mySkill');
    });

    it('returns empty string when field is absent from partial JSON', () => {
      const partial = '{"other":"value","incomplete":';
      expect(parseJsonField(partial, 'skillName')).toBe('');
    });

    it('unescapes \\n in regex-matched values', () => {
      const partial = '{"command":"line1\\nline2","incomplete":';
      expect(parseJsonField(partial, 'command')).toBe('line1\nline2');
    });

    it('unescapes \\" in regex-matched values', () => {
      const partial = '{"command":"say \\"hello\\"","incomplete":';
      expect(parseJsonField(partial, 'command')).toBe('say "hello"');
    });

    it('unescapes \\\\ in regex-matched values', () => {
      const partial = '{"file_path":"C:\\\\Users\\\\file.txt","incomplete":';
      expect(parseJsonField(partial, 'file_path')).toBe('C:\\Users\\file.txt');
    });

    it('handles whitespace between colon and value', () => {
      const partial = '{"skillName" :  "spaced","incomplete":';
      expect(parseJsonField(partial, 'skillName')).toBe('spaced');
    });

    it('decodes \\\\n as literal backslash + n, not newline', () => {
      const partial = '{"file_path":"C:\\\\note","incomplete":';
      expect(parseJsonField(partial, 'file_path')).toBe('C:\\note');
    });

    it('decodes the full JSON escape set (matches the settled JSON.parse rendering)', () => {
      const partial = '{"command":"tab\\there\\rreturn\\bback\\fform\\/slash","incomplete":';
      expect(parseJsonField(partial, 'command')).toBe('tab\there\rreturn\bback\fform/slash');
    });

    it('preserves genuinely unknown escape sequences', () => {
      const partial = '{"command":"odd\\qescape","incomplete":';
      expect(parseJsonField(partial, 'command')).toBe('odd\\qescape');
    });

    it('decodes \\uXXXX escapes mid-stream, including surrogate pairs', () => {
      const partial = '{"intent":"Checking caf\\u00e9 menu \\ud83d\\ude00 da';
      expect(parseJsonField(partial, 'intent')).toBe('Checking café menu 😀 da');
    });

    it('drops an incomplete \\uXX escape at the stream edge instead of showing it literally', () => {
      const partial = '{"intent":"Checking caf\\u00e';
      expect(parseJsonField(partial, 'intent')).toBe('Checking caf');
    });

    it('holds back the high half of a split surrogate pair at the stream edge', () => {
      const partial = '{"intent":"Searching \\ud83d';
      expect(parseJsonField(partial, 'intent')).toBe('Searching ');
    });

    it.each(['\\', '\\u', '\\uD', '\\uDE0'])(
      'holds the high surrogate while the low escape is still streaming: "\\ud83d%s"',
      (lowPrefix) => {
        const partial = `{"intent":"Searching \\ud83d${lowPrefix}`;
        expect(parseJsonField(partial, 'intent')).toBe('Searching ');
      },
    );

    it('emits a lone high surrogate when followed by ordinary text (matches JSON.parse)', () => {
      const partial = '{"intent":"odd \\ud83d tail","incomplete":';
      expect(parseJsonField(partial, 'intent')).toBe('odd \ud83d tail');
    });

    it('keeps a malformed \\u (bad hex mid-string) literal rather than corrupting the tail', () => {
      const partial = '{"command":"regex \\uZZZZ tail","incomplete":';
      expect(parseJsonField(partial, 'command')).toBe('regex \\uZZZZ tail');
    });
  });

  describe('in-progress streaming fields — unterminated values', () => {
    it('extracts a field whose closing quote has not streamed in yet', () => {
      const partial = '{"file_path":"skills/demo/SKILL.md","content":"# Demo\\nline two';
      expect(parseJsonField(partial, 'content')).toBe('# Demo\nline two');
    });

    it('grows the extracted value as more deltas arrive', () => {
      const full = '{"file_path":"a.md","content":"# Title\\n\\nBody text here"}';
      const lengths = [40, 48, 56, full.length];
      const values = lengths.map((len) => parseJsonField(full.slice(0, len), 'content'));
      expect(values[values.length - 1]).toBe('# Title\n\nBody text here');
      values.slice(1).forEach((value, index) => {
        expect(value.startsWith(values[index])).toBe(true);
      });
    });

    it('drops a dangling backslash from a partially streamed escape', () => {
      const partial = '{"content":"line one\\';
      expect(parseJsonField(partial, 'content')).toBe('line one');
    });

    it('unescapes a complete escaped backslash at the stream edge', () => {
      const partial = '{"content":"path C:\\\\';
      expect(parseJsonField(partial, 'content')).toBe('path C:\\');
    });

    it('handles escaped quotes inside an unterminated value', () => {
      const partial = '{"command":"say \\"hi';
      expect(parseJsonField(partial, 'command')).toBe('say "hi');
    });

    it('returns empty string when the value has not opened yet', () => {
      expect(parseJsonField('{"content":', 'content')).toBe('');
      expect(parseJsonField('{"content":"', 'content')).toBe('');
    });

    it('does not run past a completed field into later args', () => {
      const partial = '{"old_text":"keep this","new_text":"and th';
      expect(parseJsonField(partial, 'old_text')).toBe('keep this');
      expect(parseJsonField(partial, 'new_text')).toBe('and th');
    });
  });
});

describe('parseJsonFieldOccurrences', () => {
  it('returns empty array for non-string args', () => {
    expect(parseJsonFieldOccurrences(undefined, 'old_text')).toEqual([]);
    expect(parseJsonFieldOccurrences({ old_text: 'x' }, 'old_text')).toEqual([]);
    expect(parseJsonFieldOccurrences('', 'old_text')).toEqual([]);
  });

  it('extracts repeated fields from a partial edits array in document order', () => {
    const partial =
      '{"file_path":"a.md","edits":[' +
      '{"old_text":"first old","new_text":"first new"},' +
      '{"old_text":"second old","new_text":"second n';
    expect(parseJsonFieldOccurrences(partial, 'old_text')).toEqual(['first old', 'second old']);
    expect(parseJsonFieldOccurrences(partial, 'new_text')).toEqual(['first new', 'second n']);
  });

  it('extracts a single top-level field', () => {
    const partial = '{"file_path":"a.md","old_text":"only one';
    expect(parseJsonFieldOccurrences(partial, 'old_text')).toEqual(['only one']);
  });
});

describe('areToolCallArgsComplete', () => {
  it.each([undefined, '', '   ', '{"command":"ls"', '{"command":"ls","timeout":'])(
    'returns false for missing or partial args %s',
    (args) => {
      expect(areToolCallArgsComplete(args)).toBe(false);
    },
  );

  it.each([
    [{ command: 'ls -la' }],
    ['{"command":"ls -la"}'],
    ['{"command":"sleep 1","timeout":1000}'],
  ])('returns true for complete object args %s', (args) => {
    expect(areToolCallArgsComplete(args)).toBe(true);
  });

  it('returns false for complete non-object JSON', () => {
    expect(areToolCallArgsComplete('"ls -la"')).toBe(false);
    expect(areToolCallArgsComplete('[]')).toBe(false);
  });
});

describe('cached field regexes', () => {
  it('returns identical results across repeated calls on the same field', () => {
    const partial = '{"command":"echo hi';
    expect(parseJsonField(partial, 'command')).toBe('echo hi');
    expect(parseJsonField(partial, 'command')).toBe('echo hi');
    const many = '{"a":"1","a":"2","a":"3';
    expect(parseJsonFieldOccurrences(many, 'a')).toEqual(['1', '2', '3']);
    expect(parseJsonFieldOccurrences(many, 'a')).toEqual(['1', '2', '3']);
  });
});
