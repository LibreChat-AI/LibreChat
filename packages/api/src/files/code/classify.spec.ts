import { classifyCodeArtifact } from './classify';

describe('classifyCodeArtifact', () => {
  describe('utf8-text by extension', () => {
    it.each([
      ['report.txt', 'application/octet-stream'],
      ['notes.md', 'application/octet-stream'],
      ['data.csv', 'application/octet-stream'],
      ['rows.tsv', 'application/octet-stream'],
      ['payload.json', 'application/octet-stream'],
      ['stream.jsonl', 'application/octet-stream'],
      ['config.yaml', 'application/octet-stream'],
      ['feed.xml', 'application/octet-stream'],
      ['index.html', 'application/octet-stream'],
      ['icon.svg', 'application/octet-stream'],
      ['build.log', 'application/octet-stream'],
      ['server.py', 'application/octet-stream'],
      ['handler.ts', 'application/octet-stream'],
      ['app.tsx', 'application/octet-stream'],
      ['main.go', 'application/octet-stream'],
      ['lib.rs', 'application/octet-stream'],
      ['Service.java', 'application/octet-stream'],
      ['query.sql', 'application/octet-stream'],
      ['schema.graphql', 'application/octet-stream'],
      ['Makefile.txt', 'application/octet-stream'],
    ])('classifies %s as utf8-text', (name, mime) => {
      expect(classifyCodeArtifact(name, mime)).toBe('utf8-text');
    });
  });

  describe('utf8-text by MIME', () => {
    it.each([
      ['unknown', 'text/plain'],
      ['unknown', 'text/csv'],
      ['unknown', 'application/json'],
      ['unknown', 'application/xml'],
      ['unknown', 'application/javascript'],
      ['unknown', 'image/svg+xml'],
    ])('classifies %s with mime %s as utf8-text', (name, mime) => {
      expect(classifyCodeArtifact(name, mime)).toBe('utf8-text');
    });
  });

  describe('document by extension', () => {
    it.each([
      ['report.docx', 'application/octet-stream'],
      ['data.xlsx', 'application/octet-stream'],
      ['legacy.xls', 'application/octet-stream'],
      ['sheet.ods', 'application/octet-stream'],
      ['notes.odt', 'application/octet-stream'],
    ])('classifies %s as document', (name, mime) => {
      expect(classifyCodeArtifact(name, mime)).toBe('document');
    });
  });

  describe('document by MIME', () => {
    it('classifies docx mime', () => {
      expect(
        classifyCodeArtifact(
          'unknown',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).toBe('document');
    });

    it('classifies xlsx mime', () => {
      expect(
        classifyCodeArtifact(
          'unknown',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ),
      ).toBe('document');
    });

    it('classifies ods mime', () => {
      expect(
        classifyCodeArtifact('unknown', 'application/vnd.oasis.opendocument.spreadsheet'),
      ).toBe('document');
    });
  });

  describe('presentation', () => {
    it.each([
      ['slides.pptx', 'application/octet-stream'],
      ['template.potx', 'application/octet-stream'],
      ['unknown', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['unknown', 'application/vnd.openxmlformats-officedocument.presentationml.template'],
    ])('classifies %s with MIME %s as a presentation', (name, mime) => {
      expect(classifyCodeArtifact(name, mime)).toBe('presentation');
    });
  });

  describe('other', () => {
    it.each([
      ['photo.png', 'image/png'],
      ['archive.zip', 'application/zip'],
      ['binary.exe', 'application/octet-stream'],
      ['noext', 'application/octet-stream'],
      ['', ''],
      ['trailing.dot.', 'application/octet-stream'],
    ])('classifies %s as other', (name, mime) => {
      expect(classifyCodeArtifact(name, mime)).toBe('other');
    });
  });

  describe('extension wins over MIME', () => {
    it('treats .py as utf8-text even when MIME is octet-stream', () => {
      expect(classifyCodeArtifact('script.py', 'application/octet-stream')).toBe('utf8-text');
    });

    it('treats .docx as document even when MIME is octet-stream', () => {
      expect(classifyCodeArtifact('letter.docx', 'application/octet-stream')).toBe('document');
    });
  });

  it('is case-insensitive on extensions', () => {
    expect(classifyCodeArtifact('PHOTO.PNG', 'application/octet-stream')).toBe('other');
    expect(classifyCodeArtifact('REPORT.DOCX', 'application/octet-stream')).toBe('document');
    expect(classifyCodeArtifact('SCRIPT.PY', 'application/octet-stream')).toBe('utf8-text');
  });

  describe('diagram files', () => {
    it.each([
      ['flow.mmd', 'application/octet-stream'],
      ['diagram.mermaid', 'application/octet-stream'],
      ['FLOW.MMD', 'application/octet-stream'],
    ])('classifies %s as utf8-text', (name, mime) => {
      expect(classifyCodeArtifact(name, mime)).toBe('utf8-text');
    });
  });

  describe('extensionless filenames', () => {
    it.each([
      ['Makefile', 'application/octet-stream'],
      ['makefile', 'application/octet-stream'],
      ['MAKEFILE', 'application/octet-stream'],
      ['Dockerfile', 'application/octet-stream'],
      ['dockerfile', 'application/octet-stream'],
      ['/tmp/Dockerfile', 'application/octet-stream'],
    ])('matches %s as utf8-text', (name, mime) => {
      expect(classifyCodeArtifact(name, mime)).toBe('utf8-text');
    });

    it('falls through to other for unknown bare names', () => {
      expect(classifyCodeArtifact('mystery', 'application/octet-stream')).toBe('other');
    });
  });
});
