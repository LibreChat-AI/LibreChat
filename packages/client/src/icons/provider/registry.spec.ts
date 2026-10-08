import fs from 'fs';
import path from 'path';
import { ProviderId } from 'librechat-data-provider';
import { getProviderIconDef, providerIcons } from './registry';

const packageAssets = path.join(__dirname, 'assets');

describe('providerIcons', () => {
  it('has an entry for every ProviderId', () => {
    for (const id of Object.values(ProviderId)) {
      expect(providerIcons[id]).toBeDefined();
      expect(providerIcons[id].label).toBeTruthy();
    }
  });

  it('points every asset entry at a file shipped with the package', () => {
    for (const def of Object.values(providerIcons)) {
      if (def.art.kind === 'asset') {
        const assetPath = path.resolve(__dirname, def.art.src);
        const relativePath = path.relative(packageAssets, assetPath);
        expect(path.isAbsolute(def.art.src)).toBe(false);
        expect(relativePath.split(path.sep)).not.toContain('..');
        expect(fs.statSync(assetPath).isFile()).toBe(true);
      }
    }
  });

  it('marks raster art as not monochrome', () => {
    for (const def of Object.values(providerIcons)) {
      if (def.art.kind === 'asset') {
        expect(def.mono).not.toBe(true);
      }
    }
  });

  it('does not attach landing padding to every Cohere icon', () => {
    expect(providerIcons[ProviderId.cohere].className).toBeUndefined();
  });

  it('refines Google by model so Gemini and Gemma keep distinct labels', () => {
    expect(getProviderIconDef(ProviderId.google, 'gemini-2.5-pro').label).toBe('Gemini');
    expect(getProviderIconDef(ProviderId.google, 'gemma-3-27b').label).toBe('Gemma');
    expect(getProviderIconDef(ProviderId.google, 'some-other-model').label).toBe('Google');
  });

  it('varies the OpenAI tile color by model generation', () => {
    const gpt4 = getProviderIconDef(ProviderId.openai, 'gpt-4o');
    const gpt5 = getProviderIconDef(ProviderId.openai, 'gpt-5.6');
    expect(gpt4.brandColor).toBe('var(--provider-openai-gpt4, #AB68FF)');
    expect(gpt5.brandColor).toBe('var(--provider-openai-reasoning, #000000)');
  });
});
