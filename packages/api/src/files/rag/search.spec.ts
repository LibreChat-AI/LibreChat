import { Tools } from 'librechat-data-provider';
import { selectFileCitationSources } from '../citations';
import { executeFileSearchQuery } from './search';

type Hit = [
  { page_content: string; metadata: { source: string; page?: number; user_id?: string } },
  number,
];

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
    expect(names).toEqual(['Contract.pdf']);
  });
});

/** The same chunk as RAG returns it from one stored copy of a file. */
const copy = (owner: string, distance: number, content: string, page?: number): Hit => [
  {
    page_content: content,
    metadata: { source: `/app/uploads/${owner}/contract.pdf`, user_id: owner, page },
  },
  distance,
];

describe('executeFileSearchQuery stored copies', () => {
  it("lists a passage once when RAG returns the user's copy beside the agent's", async () => {
    const [output, artifact] = await search([{ file_id: 'file-a', filename: 'Contract.pdf' }], {
      'file-a': [
        copy('agent-1', 0.1, 'Either party may terminate.'),
        copy('user-1', 0.1, 'Either party may terminate.'),
        copy('agent-1', 0.2, 'Notice is 30 days.'),
        copy('user-1', 0.2, 'Notice is 30 days.'),
      ],
    });

    const contents = artifact?.[Tools.file_search].sources.map((source) => source.content);
    expect(contents).toEqual(['Either party may terminate.', 'Notice is 30 days.']);
    expect(output.match(/Either party may terminate\./g)).toHaveLength(1);
    expect(output).toContain('\\ue202turn0file1');
    expect(output).not.toContain('\\ue202turn0file2');
  });

  it('lists a passage once when one namespace holds the file twice', async () => {
    const [, artifact] = await search([{ file_id: 'file-a', filename: 'Contract.pdf' }], {
      'file-a': [
        copy('agent-1', 0.1, 'Either party may terminate.', 0),
        copy('agent-1', 0.1, 'Either party may terminate.', 0),
      ],
    });

    expect(artifact?.[Tools.file_search].sources).toEqual([
      expect.objectContaining({ content: 'Either party may terminate.', pages: [1] }),
    ]);
  });

  it("keeps the closest copy's relevance", async () => {
    const [, artifact] = await search([{ file_id: 'file-a', filename: 'Contract.pdf' }], {
      'file-a': [
        copy('user-1', 0.3, 'Either party may terminate.'),
        copy('agent-1', 0.1, 'Either party may terminate.'),
      ],
    });

    const sources = artifact?.[Tools.file_search].sources;
    expect(sources).toHaveLength(1);
    expect(sources?.[0].relevance).toBeCloseTo(0.9);
  });

  it('keeps the same text on two pages of a file, and in two files', async () => {
    const [, artifact] = await search(
      [
        { file_id: 'file-a', filename: 'Contract.pdf' },
        { file_id: 'file-b', filename: 'Addendum.pdf' },
      ],
      {
        'file-a': [
          copy('agent-1', 0.1, 'Confidential.', 0),
          copy('agent-1', 0.2, 'Confidential.', 3),
        ],
        'file-b': [copy('agent-1', 0.3, 'Confidential.', 0)],
      },
    );

    const found = artifact?.[Tools.file_search].sources.map((source) => [
      source.fileId,
      source.pages,
    ]);
    expect(found).toEqual([
      ['file-a', [1]],
      ['file-a', [4]],
      ['file-b', [1]],
    ]);
  });

  it('fills the ten results with distinct passages', async () => {
    const twice = (file: string, count: number, from: number) =>
      Array.from({ length: count }, (_value, index) => {
        const content = `${file} passage ${index}`;
        const distance = from + index / 100;
        return [copy('agent-1', distance, content), copy('user-1', distance, content)];
      }).flat();
    const [, artifact] = await search(
      [
        { file_id: 'file-a', filename: 'Contract.pdf' },
        { file_id: 'file-b', filename: 'Addendum.pdf' },
      ],
      { 'file-a': twice('file-a', 6, 0.1), 'file-b': twice('file-b', 6, 0.15) },
    );

    const contents = artifact?.[Tools.file_search].sources.map((source) => source.content);
    expect(contents).toHaveLength(10);
    expect(new Set(contents).size).toBe(10);
  });
});
