import { toPromptGroupRecord, toPromptRecord } from './records';

const baseGroup = {
  _id: 'group-1',
  name: 'Welcome Prompt',
  author: 'author-1',
  authorName: 'Ada',
};

describe('toPromptGroupRecord', () => {
  it('defaults a stored group with no source to native', () => {
    const record = toPromptGroupRecord({ ...baseGroup, productionId: 'prompt-1' });
    expect(record.source).toBe('native');
  });

  it('keeps a langfuse group source and identity fields', () => {
    const record = toPromptGroupRecord({
      ...baseGroup,
      source: 'langfuse',
      sourcePromptName: 'welcome-prompt',
      sourceProjectId: 'project-1',
      sourceDestination: 'eu',
    });
    expect(record.source).toBe('langfuse');
    expect(record.sourcePromptName).toBe('welcome-prompt');
    expect(record.sourceProjectId).toBe('project-1');
    expect(record.sourceDestination).toBe('eu');
  });

  it('converts ObjectId-like fields to strings, including on a nested production revision', () => {
    const record = toPromptGroupRecord({
      ...baseGroup,
      _id: { toString: () => 'group-1' },
      author: { toString: () => 'author-1' },
      productionId: { toString: () => 'prompt-1' },
      productionPrompt: {
        _id: { toString: () => 'prompt-1' },
        groupId: { toString: () => 'group-1' },
        author: { toString: () => 'author-1' },
        prompt: 'Hello',
      },
    });
    expect(record._id).toBe('group-1');
    expect(record.author).toBe('author-1');
    expect(record.productionId).toBe('prompt-1');
    expect(record.productionPrompt).toMatchObject({
      _id: 'prompt-1',
      groupId: 'group-1',
      author: 'author-1',
    });
  });
});

describe('toPromptRecord', () => {
  it('converts ObjectId-like fields to strings', () => {
    const record = toPromptRecord({
      _id: { toString: () => 'prompt-1' },
      groupId: { toString: () => 'group-1' },
      author: { toString: () => 'author-1' },
      prompt: 'Hello',
      type: 'text',
    });
    expect(record).toMatchObject({
      _id: 'prompt-1',
      groupId: 'group-1',
      author: 'author-1',
      prompt: 'Hello',
      type: 'text',
    });
  });
});
