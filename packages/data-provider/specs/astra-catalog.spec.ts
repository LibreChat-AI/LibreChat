import { EModelEndpoint } from '../src/schemas';
import { defaultModels, initialModelsConfig } from '../src/config';

/**
 * GPT-6 Astra serves tool calls only from the Responses API. The Assistants
 * endpoints do not route through `getOpenAILLMConfig`, so listing it there
 * would offer a configuration the provider rejects.
 */
describe('GPT-6 Astra catalog placement', () => {
  it('is offered on the endpoints that route through the OpenAI config', () => {
    expect(defaultModels[EModelEndpoint.openAI]).toContain('gpt-6-astra');
    expect(defaultModels[EModelEndpoint.agents]).toContain('gpt-6-astra');
  });

  it('is kept out of both Assistants catalogs', () => {
    expect(defaultModels[EModelEndpoint.assistants]).not.toContain('gpt-6-astra');
    expect(defaultModels[EModelEndpoint.azureAssistants]).not.toContain('gpt-6-astra');
  });

  it('is kept out of the initial Azure and Assistants catalogs', () => {
    /**
     * Azure shares the OpenAI list, but Astra gets neither Responses routing nor
     * its request constraints there — and being first in the list would let it
     * become the default selection.
     */
    expect(initialModelsConfig[EModelEndpoint.azureOpenAI]).not.toContain('gpt-6-astra');
    expect(initialModelsConfig[EModelEndpoint.assistants]).not.toContain('gpt-6-astra');
  });

  it('keeps Astra in the initial catalogs that can run it', () => {
    expect(initialModelsConfig[EModelEndpoint.openAI]).toContain('gpt-6-astra');
    expect(initialModelsConfig[EModelEndpoint.agents]).toContain('gpt-6-astra');
  });

  it('does not disturb the rest of the shared OpenAI catalog', () => {
    for (const endpoint of [
      EModelEndpoint.openAI,
      EModelEndpoint.agents,
      EModelEndpoint.assistants,
      EModelEndpoint.azureAssistants,
    ]) {
      expect(defaultModels[endpoint]).toContain('gpt-5.6');
    }
  });
});
