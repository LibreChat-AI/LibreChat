import { soraVideoGenSchema } from '../registry/definitions';
import { oaiToolkit } from './oai';

describe('Azure OpenAI Sora Video Generation Toolkit', () => {
  it('exports video_gen_sora_azure tool definition in oaiToolkit', () => {
    expect(oaiToolkit.video_gen_sora_azure).toBeDefined();
    expect(oaiToolkit.video_gen_sora_azure.name).toBe('video_gen_sora_azure');
    expect(oaiToolkit.video_gen_sora_azure.responseFormat).toBe('content_and_artifact');
  });

  it('validates soraVideoGenSchema parameter requirements', () => {
    expect(soraVideoGenSchema).toBeDefined();
    expect(soraVideoGenSchema.type).toBe('object');
    expect(soraVideoGenSchema.required).toContain('prompt');

    const properties = soraVideoGenSchema.properties;
    expect(properties?.prompt).toBeDefined();
    expect(properties?.duration?.enum).toEqual([5, 10, 15, 20]);
    expect(properties?.resolution?.enum).toEqual(['1080p', '720p', '480p']);
    expect(properties?.aspect_ratio?.enum).toEqual(['16:9', '9:16', '1:1']);
    expect(properties?.fps?.enum).toEqual([24, 30, 60]);
  });
});
