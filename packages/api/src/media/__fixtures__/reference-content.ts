function box(type: string, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, content]);
}

/** Small track/container fixtures; encoded frame decoding is outside these contract tests. */
export function mp4ReferenceFixture(): Buffer {
  const handler = Buffer.alloc(24);
  handler.write('vide', 8);
  const sample = Buffer.alloc(78);
  sample.writeUInt16BE(1, 6);
  sample.writeUInt16BE(32, 24);
  sample.writeUInt16BE(24, 26);
  const description = Buffer.alloc(8);
  description.writeUInt32BE(1, 4);
  const sizes = Buffer.alloc(12);
  sizes.writeUInt32BE(6, 4);
  sizes.writeUInt32BE(1, 8);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isomavc1', 'binary')),
    box(
      'moov',
      box(
        'trak',
        box(
          'mdia',
          box('hdlr', handler),
          box(
            'minf',
            box('stbl', box('stsd', description, box('avc1', sample)), box('stsz', sizes)),
          ),
        ),
      ),
    ),
    box('mdat', Buffer.from([0, 0, 0, 2, 0x65, 0x88])),
  ]);
}

function element(id: string, ...parts: Buffer[]): Buffer {
  const data = Buffer.concat(parts);
  const size =
    data.length < 127
      ? Buffer.from([128 + data.length])
      : Buffer.from([64 + (data.length >> 8), data.length & 255]);
  return Buffer.concat([Buffer.from(id, 'hex'), size, data]);
}

export function webmReferenceFixture(trackType = 1): Buffer {
  return Buffer.concat([
    element('1a45dfa3', element('4282', Buffer.from('webm'))),
    element(
      '18538067',
      element(
        '1654ae6b',
        element(
          'ae',
          element('d7', Buffer.from([1])),
          element('83', Buffer.from([trackType])),
          element('86', Buffer.from(trackType === 1 ? 'V_VP9' : 'A_OPUS')),
          element('e0', element('b0', Buffer.from([32])), element('ba', Buffer.from([24]))),
        ),
      ),
      element(
        '1f43b675',
        element('e7', Buffer.from([0])),
        element('a3', Buffer.from([0x81, 0, 0, 0x80, 1])),
      ),
    ),
  ]);
}
