jest.mock('sharp', () => jest.fn(), { virtual: true });

const { cleanFileName, getContentDisposition } = require('./files');

describe('file utilities', () => {
  describe('cleanFileName', () => {
    it('removes storage UUID prefixes', () => {
      expect(cleanFileName('123e4567-e89b-12d3-a456-426614174000__report.txt')).toBe('report.txt');
    });
  });

  describe('getContentDisposition', () => {
    it('adds RFC 8187 encoding for Unicode filenames', () => {
      const filename = '日本語レポート.xlsx';
      const header = getContentDisposition(`123e4567-e89b-12d3-a456-426614174000__${filename}`);

      expect(header).toMatch(/^attachment; filename=".*"; filename\*=UTF-8''/);
      expect(header).not.toContain('123e4567-e89b-12d3-a456-426614174000__');
      expect(header).toContain(`filename*=UTF-8''${encodeURIComponent(filename)}`);
    });

    it('escapes the ASCII fallback without dropping the encoded filename', () => {
      const filename = 'bad"name\r\n.txt';
      const header = getContentDisposition(filename);

      expect(header).toContain('filename="bad_name__.txt"');
      expect(header).toContain("filename*=UTF-8''bad%22name%0D%0A.txt");
      expect(header).not.toMatch(/[\r\n]/);
    });
  });
});
