import fs from 'fs';
import os from 'os';
import path from 'path';
import { openNamedUpload } from './disk';

describe('openNamedUpload', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'named-upload-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the staged file after the upload and reads it from disk', async () => {
    const staged = path.join(dir, 'req-123__report.pdf');
    fs.writeFileSync(staged, 'pdf bytes');

    const upload = await openNamedUpload(staged, 'report.pdf');

    expect(upload).toBeInstanceOf(File);
    expect(upload.name).toBe('report.pdf');
    expect(upload.size).toBe(9);
    expect(await upload.text()).toBe('pdf bytes');
  });
});
