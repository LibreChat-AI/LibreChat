import { getLangfusePromptUrl } from './links';

describe('getLangfusePromptUrl', () => {
  it('builds a prompt URL from a plain base URL', () => {
    expect(getLangfusePromptUrl('https://cloud.langfuse.test', 'project-1', 'greeting')).toBe(
      'https://cloud.langfuse.test/project/project-1/prompts/greeting',
    );
  });

  it('preserves a path prefix on the base URL and drops its trailing slash', () => {
    expect(getLangfusePromptUrl('https://host.test/lf/', 'project-1', 'greeting')).toBe(
      'https://host.test/lf/project/project-1/prompts/greeting',
    );
  });

  it('encodes a prompt name with spaces and slashes', () => {
    expect(
      getLangfusePromptUrl('https://cloud.langfuse.test', 'project-1', 'support/greeting one'),
    ).toBe('https://cloud.langfuse.test/project/project-1/prompts/support%2Fgreeting%20one');
  });

  it('encodes the project id', () => {
    expect(getLangfusePromptUrl('https://cloud.langfuse.test', 'project one', 'greeting')).toBe(
      'https://cloud.langfuse.test/project/project%20one/prompts/greeting',
    );
  });
});
