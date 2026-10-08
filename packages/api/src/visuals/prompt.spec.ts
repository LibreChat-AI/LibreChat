import { VISUAL_THEME_VARIABLES } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { generateVisualsPrompt, getVisualsPrompt } from './prompt';

describe('generateVisualsPrompt', () => {
  it('teaches the visual directive around an html fence', () => {
    const prompt = generateVisualsPrompt({ sources: [] });
    expect(prompt).toContain(':::visual{title="');
    expect(prompt).toContain('```html');
  });

  it('names the configured library sources', () => {
    const prompt = generateVisualsPrompt({ sources: ['https://cdn.example.com'] });
    expect(prompt).toContain('Libraries may load from https://cdn.example.com');
  });

  it('asks for inline code when no source is allowed', () => {
    const prompt = generateVisualsPrompt({ sources: [] });
    expect(prompt).not.toContain('Libraries may load from');
    expect(prompt).toContain('No external origins are allowed');
  });

  it('documents every theme variable the client injects', () => {
    const prompt = generateVisualsPrompt({ sources: [] });
    for (const name of VISUAL_THEME_VARIABLES) {
      expect(prompt).toContain(name);
    }
  });
});

describe('getVisualsPrompt', () => {
  const config = (visuals?: boolean) =>
    ({
      interfaceConfig: visuals === undefined ? {} : { visuals },
      visuals: { sources: ['https://cdn.example.com'] },
    }) as unknown as AppConfig;

  it('returns the instructions with the configured sources when the user asks for them', () => {
    expect(getVisualsPrompt({ requested: true, appConfig: config(true) })).toContain(
      'Libraries may load from https://cdn.example.com',
    );
    expect(getVisualsPrompt({ requested: true, appConfig: config() })).not.toBeNull();
  });

  it.each([
    ['the user setting is off', false, config(true)],
    ['the request does not say', undefined, config(true)],
    ['the deployment turned visuals off', true, config(false)],
  ])('returns null when %s', (_label, requested, appConfig) => {
    expect(getVisualsPrompt({ requested, appConfig })).toBeNull();
  });
});
