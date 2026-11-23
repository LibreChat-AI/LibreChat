import { ProviderId } from 'librechat-data-provider';
import { getProviderIconDef, providerIcons } from './registry';

describe('providerIcons', () => {
  it('has an entry for every ProviderId', () => {
    for (const id of Object.values(ProviderId)) {
      expect(providerIcons[id]).toBeDefined();
      expect(providerIcons[id].label).toBeTruthy();
    }
  });

  it('draws every provider as a mark that follows the theme', () => {
    for (const def of Object.values(providerIcons)) {
      expect(def.art.kind).toBe('component');
      expect(def.mono).toBe(true);
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

  it.each([
    [ProviderId.openrouter, 'anthropic/claude-sonnet-4.5', 'Anthropic'],
    [ProviderId.bedrock, 'us.anthropic.claude-opus-5-5-v1:0', 'Anthropic'],
    [ProviderId.azure, 'gpt-5.6', 'OpenAI'],
    [ProviderId.openrouter, 'openai/o4-mini', 'OpenAI'],
    [ProviderId.ollama, 'gemma4:12b-it-qat', 'Gemma'],
    [ProviderId.openrouter, 'google/gemini-3.7-flash', 'Gemini'],
    [ProviderId.openrouter, 'x-ai/grok-4', 'xAI'],
    [ProviderId.openrouter, 'moonshotai/kimi-k2', 'Moonshot'],
    [ProviderId.groq, 'qwen/qwen3-32b', 'Qwen'],
    [ProviderId.openrouter, 'mistralai/devstral-small', 'Mistral'],
    [ProviderId.ollama, 'mathstral:7b', 'Mistral'],
    [ProviderId.openrouter, 'openai/chatgpt-4o-latest', 'OpenAI'],
    [ProviderId.azure, 'gpt-35-turbo', 'OpenAI'],
    [ProviderId.openrouter, 'cohere/command-a', 'Cohere'],
    [ProviderId.openrouter, 'perplexity/sonar-pro', 'Perplexity'],
    [ProviderId.groq, 'llama-3.3-70b-versatile', 'Meta'],
    [ProviderId.ollama, 'llama3.1:8b', 'Meta'],
    [ProviderId.together, 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', 'DeepSeek'],
    [ProviderId.openrouter, 'nvidia/llama-3.1-nemotron-70b-instruct', 'NVIDIA'],
    [ProviderId.openrouter, 'minimax/minimax-m3', 'MiniMax'],
    [ProviderId.ollama, 'phi4:14b', 'Microsoft'],
    [ProviderId.ollama, 'phi:2.7b', 'Microsoft'],
    [ProviderId.ollama, 'phi', 'Microsoft'],
    [ProviderId.ollama, 'phind-codellama:34b', 'Meta'],
    [ProviderId.openrouter, 'microsoft/phi-3.5-mini-128k-instruct', 'Microsoft'],
    [ProviderId.openrouter, 'z-ai/glm-4.6', 'Z.ai'],
    [ProviderId.ollama, 'chatglm3:6b', 'Z.ai'],
    [ProviderId.ollama, 'granite3.3:8b', 'IBM'],
    [ProviderId.bedrock, 'us.amazon.nova-pro-v1:0', 'Amazon Nova'],
    [ProviderId.openrouter, 'amazon/nova-lite-v1', 'Amazon Nova'],
    [null, 'gpt-4o', 'OpenAI'],
  ])('shows the maker for %s serving %s', (provider, model, label) => {
    expect(getProviderIconDef(provider, model).label).toBe(label);
  });

  it.each([
    [ProviderId.anthropic, 'claude-opus-5-5', 'Anthropic'],
    [ProviderId.ollama, 'starcoder2:15b', 'Ollama'],
    [ProviderId.ollama, 'sophia:7b', 'Ollama'],
    [ProviderId.openrouter, 'thudm/supernova-medium', 'OpenRouter'],
    [ProviderId.ollama, 'my-ollama-finetune', 'Ollama'],
    [ProviderId.openrouter, 'openrouter/auto', 'OpenRouter'],
    [ProviderId.groq, 'yolo1-vision', 'Groq'],
    [ProviderId.ollama, 'gpt4all-j', 'Ollama'],
    [ProviderId.ollama, 'nomic-ai/gpt4all-falcon', 'Ollama'],
  ])('keeps the host for %s serving %s', (provider, model, label) => {
    expect(getProviderIconDef(provider, model).label).toBe(label);
  });

  it('keeps the OpenAI tile color rule for OpenAI models on another host', () => {
    expect(getProviderIconDef(ProviderId.openrouter, 'openai/o4-mini').brandColor).toBe(
      'var(--provider-openai-reasoning, #000000)',
    );
  });

  it('varies the OpenAI tile color by model generation', () => {
    const gpt4 = getProviderIconDef(ProviderId.openai, 'gpt-4o');
    const gpt5 = getProviderIconDef(ProviderId.openai, 'gpt-5.6');
    expect(gpt4.brandColor).toBe('var(--provider-openai-gpt4, #AB68FF)');
    expect(gpt5.brandColor).toBe('var(--provider-openai-reasoning, #000000)');
  });
});
