import { isBinaryBuffer } from './binary';

describe('isBinaryBuffer', () => {
  it('detects opaque bytes after a long printable prefix', () => {
    expect(isBinaryBuffer(Buffer.concat([Buffer.alloc(8192, 'a'), Buffer.from([0, 255])]))).toBe(
      true,
    );
  });

  it('accepts complete UTF-8 text', () => {
    expect(isBinaryBuffer(Buffer.from('plain text with unicode: café'))).toBe(false);
  });
});
