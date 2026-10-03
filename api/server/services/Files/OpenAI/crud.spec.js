const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  sleep: jest.fn(),
}));

const { uploadOpenAIFile } = require('./crud');

describe('uploadOpenAIFile', () => {
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-upload-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends the upload under its own name rather than the staged path', async () => {
    const stagedPath = path.join(dir, 'req-123__report.pdf');
    fs.writeFileSync(stagedPath, 'pdf bytes');
    const create = jest.fn(async () => ({ id: 'file-1', status: 'processed' }));

    await uploadOpenAIFile({
      req: { body: {}, user: { id: 'user-1' } },
      file: { path: stagedPath, originalname: 'report.pdf' },
      openai: { files: { create } },
    });

    const sent = create.mock.calls[0][0].file;
    expect(sent).toBeInstanceOf(File);
    expect(sent.name).toBe('report.pdf');
    expect(await sent.text()).toBe('pdf bytes');
  });
});
