import { Tools } from 'librechat-data-provider';
import { selectFileCitationSources } from '../citations';
import { executeFileSearchQuery } from './search';

type Hit = [{ page_content: string; metadata: { source: string; page?: number } }, number];

function search(files: { file_id: string; filename?: string }[], hits: Record<string, Hit[]>) {
  const post = jest.fn((_url: string, body: { file_id: string }) =>
    Promise.resolve({ data: hits[body.file_id] ?? [] }),
  );
  return executeFileSearchQuery({
    query: 'termination clause',
    userId: 'user-1',
    files,
    fileCitations: true,
    ragApiUrl: 'http://rag',
    httpClient: { post } as never,
    generateShortLivedToken: () => 'token',
    logAxiosError: jest.fn(),
    selectFileCitationSources,
    logger: { debug: jest.fn() },
  });
}

const hit = (source: string, distance: number, content = 'Passage'): Hit => [
  { page_content: content, metadata: { source } },
  distance,
];

describe('executeFileSearchQuery result names', () => {
  it('names a provisioned file after its record, not the temp copy', async () => {
    const [output, artifact] = await search([{ file_id: 'file-a', filename: 'Contract.pdf' }], {
      'file-a': [hit('/tmp/uploads/provision-file-a-9f2c1e_a1b2.pdf', 0.1)],
    });

    expect(output).toContain('File: Contract.pdf');
    expect(output).toContain('(Contract.pdf)');
    expect(output).not.toContain('provision-');
    expect(artifact?.[Tools.file_search].sources[0]).toMatchObject({
      fileId: 'file-a',
      fileName: 'Contract.pdf',
    });
  });

  it('keeps the RAG source name when the record has no filename', async () => {
    const [output, artifact] = await search([{ file_id: 'file-a' }], {
      'file-a': [hit('/uploads/user-1/report.docx', 0.2)],
    });

    expect(output).toContain('File: report.docx');
    expect(artifact?.[Tools.file_search].sources[0].fileName).toBe('report.docx');
  });

  it('keeps distinct RAG source names when two searched files share a name', async () => {
    const [output, artifact] = await search(
      [
        { file_id: 'file-a', filename: 'Contract.pdf' },
        { file_id: 'file-b', filename: 'contract.pdf' },
        { file_id: 'file-c', filename: 'Notes.txt' },
      ],
      {
        'file-a': [hit('/uploads/file-a__Contract.pdf', 0.1)],
        'file-b': [hit('/tmp/provision-file-b-77aa.pdf', 0.2)],
        'file-c': [hit('/tmp/provision-file-c-88bb.txt', 0.3)],
      },
    );

    const names = artifact?.[Tools.file_search].sources.map((source) => source.fileName);
    expect(names).toEqual(['file-a__Contract.pdf', 'provision-file-b-77aa.pdf', 'Notes.txt']);
    expect(output).toContain('File: Notes.txt');
  });

  it('treats one file listed twice as a single name', async () => {
    const [, artifact] = await search(
      [
        { file_id: 'file-a', filename: 'Contract.pdf' },
        { file_id: 'file-a', filename: 'Contract.pdf' },
      ],
      { 'file-a': [hit('/tmp/provision-file-a-1.pdf', 0.1)] },
    );

    const names = artifact?.[Tools.file_search].sources.map((source) => source.fileName);
    expect(names).toEqual(['Contract.pdf', 'Contract.pdf']);
  });
});
