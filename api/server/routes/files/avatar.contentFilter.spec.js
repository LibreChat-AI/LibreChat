jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  inspectContent: jest.fn(),
  extractFileContent: jest.fn((input) => [input]),
  hasActiveFileFieldPolicy: jest.fn((filters, candidates) => {
    const pii = filters?.files?.pii;
    if (pii == null) {
      return false;
    }
    const fieldSelected = candidates.some(
      (field) => pii.fields == null || pii.fields.includes(field),
    );
    const hasPatterns =
      pii.starterPatterns == null ||
      pii.starterPatterns.length > 0 ||
      (pii.customPatterns?.length ?? 0) > 0;
    const failClosed =
      pii.uninspectable === 'block' &&
      candidates.some(
        (field) =>
          ['content', 'extracted_text', 'transcript'].includes(field) &&
          (pii.fields == null || pii.fields.includes(field)),
      );
    return (hasPatterns && fieldSelected) || failClosed;
  }),
  contentFilterBlockResponse: jest.fn((finding) => ({
    error: 'content_filter_block',
    source: finding.source,
    field: finding.field,
  })),
  getBlockedUninspectableFileField: jest.fn(),
  contentFilterUninspectableResponse: jest.fn((field) => ({
    error: 'content_filter_uninspectable',
    source: 'file',
    field,
  })),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));
jest.mock('~/server/services/Files/images/avatar', () => ({
  resizeAvatar: jest.fn(),
}));
jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
}));

const fs = require('fs').promises;
const {
  inspectContent,
  extractFileContent,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  getBlockedUninspectableFileField,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { resizeAvatar } = require('~/server/services/Files/images/avatar');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { filterFile } = require('~/server/services/Files/process');
const router = require('./avatar');

const uploadAvatar = router.stack[0].route.stack[0].handle;

describe('profile avatar filename content filtering', () => {
  let readFileSpy;
  let unlinkSpy;
  let processAvatar;

  const createRequest = (config) => ({
    config,
    file: {
      path: '/tmp/avatar.png',
      originalname: 'avatar.png',
      mimetype: 'image/png',
      size: 10,
    },
    user: { id: 'user-1', tenantId: 'tenant-1' },
    body: { manual: 'true' },
  });

  const createResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    readFileSpy = jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('image'));
    unlinkSpy = jest.spyOn(fs, 'unlink').mockResolvedValue();
    processAvatar = jest.fn().mockResolvedValue('https://example.com/avatar.png');
    getFileStrategy.mockReturnValue('local');
    getStrategyFunctions.mockReturnValue({ processAvatar });
    resizeAvatar.mockResolvedValue(Buffer.from('resized'));
    inspectContent.mockReturnValue(null);
    getBlockedUninspectableFileField.mockReturnValue(null);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    unlinkSpy.mockRestore();
  });

  it('blocks a configured filename before reading or storing the image', async () => {
    const filters = { files: { pii: { fields: ['name'] } } };
    const finding = {
      label: 'protected value',
      source: 'file',
      field: 'name',
    };
    inspectContent.mockReturnValueOnce(finding);
    const req = createRequest({ filters });
    const res = createResponse();

    await uploadAvatar(req, res);

    expect(filterFile).toHaveBeenCalledWith({
      req,
      file: req.file,
      image: true,
      isAvatar: true,
    });
    expect(extractFileContent).toHaveBeenCalledWith({ name: 'avatar.png' });
    expect(inspectContent).toHaveBeenCalledWith([{ name: 'avatar.png' }], { filters });
    expect(contentFilterBlockResponse).toHaveBeenCalledWith(finding);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(processAvatar).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/avatar.png');
  });

  it('blocks uninspectable image content before reading or storing it', async () => {
    const filters = {
      files: {
        pii: {
          fields: ['content'],
          uninspectable: 'block',
        },
      },
    };
    getBlockedUninspectableFileField.mockReturnValueOnce('content');
    const req = createRequest({ filters });
    const res = createResponse();

    await uploadAvatar(req, res);

    expect(getBlockedUninspectableFileField).toHaveBeenCalledWith(filters, ['content']);
    expect(contentFilterUninspectableResponse).toHaveBeenCalledWith('content');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'content_filter_uninspectable',
      source: 'file',
      field: 'content',
    });
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(resizeAvatar).not.toHaveBeenCalled();
    expect(processAvatar).not.toHaveBeenCalled();
    expect(unlinkSpy).toHaveBeenCalledWith('/tmp/avatar.png');
  });

  it('preserves the default-off upload path', async () => {
    const req = createRequest({});
    const res = createResponse();

    await uploadAvatar(req, res);

    expect(inspectContent).not.toHaveBeenCalled();
    expect(readFileSpy).toHaveBeenCalledWith('/tmp/avatar.png');
    expect(processAvatar).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ url: 'https://example.com/avatar.png' });
  });

  it('preserves the upload path when the selected file policy has no active patterns', async () => {
    const filters = {
      files: {
        pii: { fields: ['name'], starterPatterns: [], customPatterns: [] },
      },
    };
    const req = createRequest({ filters });
    const res = createResponse();

    await uploadAvatar(req, res);

    expect(inspectContent).not.toHaveBeenCalled();
    expect(readFileSpy).toHaveBeenCalledWith('/tmp/avatar.png');
    expect(processAvatar).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ url: 'https://example.com/avatar.png' });
  });
});
