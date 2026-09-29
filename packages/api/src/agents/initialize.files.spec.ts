import { Tools, EToolResources } from 'librechat-data-provider';
import type { IConversation } from '@librechat/data-schemas';
import {
  partitionCommittedFiles,
  readResolvedConversationFiles,
  resolveResendToolResources,
} from './initialize';
import { PARTIAL_RESOLVED_CONVERSATION } from './guard';

describe('readResolvedConversationFiles', () => {
  const conversationId = 'conversation-1';

  it('leaves the database read in place when no middleware resolved the conversation', () => {
    expect(readResolvedConversationFiles({}, conversationId)).toBeUndefined();
  });

  it('reports no files when the conversation was looked up and does not exist', () => {
    expect(readResolvedConversationFiles({ resolvedConversation: null }, conversationId)).toEqual(
      [],
    );
  });

  it('uses the resolved document when it carries the files field', () => {
    expect(
      readResolvedConversationFiles(
        { resolvedConversation: { conversationId, files: ['file-1'] } },
        conversationId,
      ),
    ).toEqual(['file-1']);
    expect(
      readResolvedConversationFiles(
        { resolvedConversation: { conversationId, files: [] } },
        conversationId,
      ),
    ).toEqual([]);
  });

  it('treats a stored document without files as having none', () => {
    expect(
      readResolvedConversationFiles(
        { resolvedConversation: { conversationId, title: 'no uploads yet' } },
        conversationId,
      ),
    ).toEqual([]);
  });

  it('falls back to the database for a branded lineage-only partial or another conversation', () => {
    const lineageOnly = {
      [PARTIAL_RESOLVED_CONVERSATION]: true,
      conversationId,
      agent_id: 'child-agent',
    } as unknown as IConversation;
    expect(
      readResolvedConversationFiles({ resolvedConversation: lineageOnly }, conversationId),
    ).toBeUndefined();
    expect(
      readResolvedConversationFiles(
        { resolvedConversation: { conversationId: 'other', files: ['file-1'] } },
        conversationId,
      ),
    ).toBeUndefined();
  });
});

describe('partitionCommittedFiles', () => {
  it('separates files this request already screened from the rest', () => {
    const shared = { file_id: 'shared', bytes: 2 };
    const persistent = { file_id: 'persistent', bytes: 7 };

    const { committed, pending } = partitionCommittedFiles(
      [shared, persistent],
      [{ file_id: 'shared' }, { file_id: 'attachment' }],
    );

    expect(committed).toEqual([shared]);
    expect(pending).toEqual([persistent]);
  });

  it('treats a file with no id as still to screen', () => {
    const anonymous: { file_id?: string; bytes: number } = { bytes: 1 };

    expect(partitionCommittedFiles([anonymous], [{ file_id: 'shared' }])).toEqual({
      committed: [],
      pending: [anonymous],
    });
  });

  it('keeps every file when nothing was committed', () => {
    const files = [{ file_id: 'a' }, { file_id: 'b' }];

    expect(partitionCommittedFiles(files, [])).toEqual({ committed: [], pending: files });
  });
});

describe('resolveResendToolResources', () => {
  const resolve = (tools: string[], flags: { code: boolean; fileSearch?: boolean }) =>
    resolveResendToolResources({
      tools,
      codeEnvAvailable: flags.code,
      fileSearchAvailable: flags.fileSearch,
    });

  it('primes both gated tools when both flags allow them', () => {
    expect([
      ...resolve([Tools.execute_code, Tools.file_search], { code: true, fileSearch: true }),
    ]).toEqual([EToolResources.execute_code, EToolResources.file_search]);
  });

  it('drops only the tool whose flag is false', () => {
    expect([
      ...resolve([Tools.execute_code, Tools.file_search], { code: false, fileSearch: true }),
    ]).toEqual([EToolResources.file_search]);
    expect([
      ...resolve([Tools.execute_code, Tools.file_search], { code: true, fileSearch: false }),
    ]).toEqual([EToolResources.execute_code]);
  });

  it('maps sandbox file tools to execute_code and applies the same code grant', () => {
    expect([...resolve([Tools.bash_tool, Tools.read_file], { code: true })]).toEqual([
      EToolResources.execute_code,
    ]);
    expect([...resolve([Tools.bash_tool, Tools.read_file], { code: false })]).toEqual([]);
  });

  it('primes neither when the role carries neither grant', () => {
    expect([
      ...resolve([Tools.execute_code, Tools.file_search], { code: false, fileSearch: false }),
    ]).toEqual([]);
  });

  /** Callers that never resolved the grant must keep priming as they did, or
   *  adding the parameter would silently drop search files for every embedder
   *  that does not pass it. */
  it('primes file search when the caller resolved no grant at all', () => {
    expect([...resolve([Tools.file_search], { code: false })]).toEqual([
      EToolResources.file_search,
    ]);
  });

  it('leaves ungated tool resources alone and ignores tools that map to none', () => {
    expect([...resolve([EToolResources.ocr, Tools.web_search], { code: false })]).toEqual([
      EToolResources.ocr,
    ]);
  });

  it('reports nothing for an agent with no tools', () => {
    expect([...resolveResendToolResources({ codeEnvAvailable: true })]).toEqual([]);
  });
});
