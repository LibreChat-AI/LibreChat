import { FileSources } from 'librechat-data-provider';

import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';

import { extractFileContext } from './context';

const makeReq = () =>
  ({
    body: { fileTokenLimit: 1000 },
    config: { fileConfig: {} },
  }) as ServerRequest;

const countTokens = (text: string) => text.length;

describe('extractFileContext', () => {
  it('should skip files with llmDeliveryPath "none"', async () => {
    const file = {
      filename: 'hidden.txt',
      source: FileSources.text,
      text: 'do not include this',
      llmDeliveryPath: 'none',
    } as IMongoFile;

    await expect(
      extractFileContext({ attachments: [file], req: makeReq(), tokenCountFn: countTokens }),
    ).resolves.toBeUndefined();
  });

  it('should include legacy text-source files with undefined llmDeliveryPath', async () => {
    const file = {
      filename: 'legacy.txt',
      source: FileSources.text,
      text: 'legacy text',
    } as IMongoFile;

    const result = await extractFileContext({
      attachments: [file],
      req: makeReq(),
      tokenCountFn: countTokens,
    });

    expect(result).toContain('# "legacy.txt"');
    expect(result).toContain('legacy text');
  });

  it('should include standard-storage files with text and llmDeliveryPath "text"', async () => {
    const file = {
      filename: 'stored.txt',
      source: FileSources.local,
      text: 'stored extracted text',
      llmDeliveryPath: 'text',
    } as IMongoFile;

    const result = await extractFileContext({
      attachments: [file],
      req: makeReq(),
      tokenCountFn: countTokens,
    });

    expect(result).toContain('# "stored.txt"');
    expect(result).toContain('stored extracted text');
  });
});
