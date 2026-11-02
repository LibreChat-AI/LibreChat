import { fileTypes, getFileType } from '../kinds';

describe('getFileType', () => {
  it('matches exact, partial, spreadsheet and category types', () => {
    expect(getFileType('application/pdf').title).toBe('Document');
    expect(getFileType('text/x-python').title).toBe('Code');
    expect(
      getFileType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').title,
    ).toBe('Spreadsheet');
    expect(getFileType('audio/mpeg').fillClassName).toBe('fill-file-audio');
  });

  it('falls back to a generic file', () => {
    expect(getFileType('application/octet-stream')).toBe(fileTypes.file);
    expect(getFileType()).toBe(fileTypes.text);
  });
});
