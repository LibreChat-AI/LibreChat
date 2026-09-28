/**
 * Token Pricing Configuration
 *
 * Pattern Matching
 * ================
 * `findMatchingPattern` uses `modelName.includes(key)` and selects the **longest**
 * matching key. If a key's length equals the model name's length (exact match), it
 * returns immediately — no further keys are checked.
 *
 * For keys of different lengths, definition order does not affect the result — the
 * longest match always wins. For **same-length ties**, the function iterates in
 * reverse, so the last-defined key wins. Key ordering therefore matters for:
 * 1. **Performance**: list older/legacy models first, newer models last — newer
 *    models are more commonly used and will match earlier in the reverse scan.
 * 2. **Same-length tie-breaking**: when two keys of equal length both match,
 *    the last-defined key wins.
 */

export interface TxDeps {
  /** From @librechat/api — matches a model name to a canonical key. */
  matchModelName: (model: string, endpoint?: string) => string | undefined;
  /** From @librechat/api — finds the longest key in `values` whose key is a substring of `model`. */
  findMatchingPattern: (
    model: string,
    values: Record<string, number | Record<string, number>>,
  ) => string | undefined;
}

export const defaultRate = 6;

/** AWS Bedrock pricing (source: https://aws.amazon.com/bedrock/pricing/) */
const bedrockValues: Record<string, { prompt: number; completion: number }> = {
  llama2: { prompt: 0.75, completion: 1.0 },
  'llama-2': { prompt: 0.75, completion: 1.0 },
  'llama2-13b': { prompt: 0.75, completion: 1.0 },
  'llama2:70b': { prompt: 1.95, completion: 2.56 },
  'llama2-70b': { prompt: 1.95, completion: 2.56 },
  llama3: { prompt: 0.3, completion: 0.6 },
  'llama-3': { prompt: 0.3, completion: 0.6 },
  'llama3-8b': { prompt: 0.3, completion: 0.6 },
  'llama3:8b': { prompt: 0.3, completion: 0.6 },
  'llama3-70b': { prompt: 2.65, completion: 3.5 },
  'llama3:70b': { prompt: 2.65, completion: 3.5 },
  'llama3-1': { prompt: 0.22, completion: 0.22 },
  'llama3-1-8b': { prompt: 0.22, completion: 0.22 },
  'llama3-1-70b': { prompt: 0.72, completion: 0.72 },
  'llama3-1-405b': { prompt: 2.4, completion: 2.4 },
  'llama3-2': { prompt: 0.1, completion: 0.1 },
  'llama3-2-1b': { prompt: 0.1, completion: 0.1 },
  'llama3-2-3b': { prompt: 0.15, completion: 0.15 },
  'llama3-2-11b': { prompt: 0.16, completion: 0.16 },
  'llama3-2-90b': { prompt: 0.72, completion: 0.72 },
  'llama3-3': { prompt: 2.65, completion: 3.5 },
  'llama3-3-70b': { prompt: 2.65, completion: 3.5 },
  'llama3.1': { prompt: 0.22, completion: 0.22 },
  'llama3.1:8b': { prompt: 0.22, completion: 0.22 },
  'llama3.1:70b': { prompt: 0.72, completion: 0.72 },
  'llama3.1:405b': { prompt: 2.4, completion: 2.4 },
  'llama3.2': { prompt: 0.1, completion: 0.1 },
  'llama3.2:1b': { prompt: 0.1, completion: 0.1 },
  'llama3.2:3b': { prompt: 0.15, completion: 0.15 },
  'llama3.2:11b': { prompt: 0.16, completion: 0.16 },
  'llama3.2:90b': { prompt: 0.72, completion: 0.72 },
  'llama3.3': { prompt: 2.65, completion: 3.5 },
  'llama3.3:70b': { prompt: 2.65, completion: 3.5 },
  'llama-3.1': { prompt: 0.22, completion: 0.22 },
  'llama-3.1-8b': { prompt: 0.22, completion: 0.22 },
  'llama-3.1-70b': { prompt: 0.72, completion: 0.72 },
  'llama-3.1-405b': { prompt: 2.4, completion: 2.4 },
  'llama-3.2': { prompt: 0.1, completion: 0.1 },
  'llama-3.2-1b': { prompt: 0.1, completion: 0.1 },
  'llama-3.2-3b': { prompt: 0.15, completion: 0.15 },
  'llama-3.2-11b': { prompt: 0.16, completion: 0.16 },
  'llama-3.2-90b': { prompt: 0.72, completion: 0.72 },
  'llama-3.3': { prompt: 2.65, completion: 3.5 },
  'llama-3.3-70b': { prompt: 2.65, completion: 3.5 },
  /* Llama 4. Per-host rates vary widely (0.08 to 0.22 prompt); these follow the
     published Bedrock/OpenRouter figures. */
  llama4: { prompt: 0.1, completion: 0.3 },
  'llama-4': { prompt: 0.1, completion: 0.3 },
  'llama4-scout': { prompt: 0.1, completion: 0.3 },
  'llama-4-scout': { prompt: 0.1, completion: 0.3 },
  'llama4-maverick': { prompt: 0.2, completion: 0.7 },
  'llama-4-maverick': { prompt: 0.2, completion: 0.7 },
  'mistral-7b': { prompt: 0.15, completion: 0.2 },
  'mistral-small': { prompt: 0.15, completion: 0.2 },
  'mixtral-8x7b': { prompt: 0.45, completion: 0.7 },
  'mistral-large-2402': { prompt: 4.0, completion: 12.0 },
  'mistral-large-2407': { prompt: 3.0, completion: 9.0 },
  'command-text': { prompt: 1.5, completion: 2.0 },
  'command-light': { prompt: 0.3, completion: 0.6 },
  'j2-mid': { prompt: 12.5, completion: 12.5 },
  'j2-ultra': { prompt: 18.8, completion: 18.8 },
  'jamba-instruct': { prompt: 0.5, completion: 0.7 },
  'titan-text-lite': { prompt: 0.15, completion: 0.2 },
  'titan-text-express': { prompt: 0.2, completion: 0.6 },
  'titan-text-premier': { prompt: 0.5, completion: 1.5 },
  'nova-micro': { prompt: 0.035, completion: 0.14 },
  'nova-lite': { prompt: 0.06, completion: 0.24 },
  'nova-pro': { prompt: 0.8, completion: 3.2 },
  'nova-premier': { prompt: 2.5, completion: 12.5 },
  'nova-2-lite': { prompt: 0.3, completion: 2.5 },
  'deepseek.r1': { prompt: 1.35, completion: 5.4 },
  'moonshot.kimi': { prompt: 0.6, completion: 2.5 },
  'moonshot.kimi-k2': { prompt: 0.6, completion: 2.5 },
  'moonshot.kimi-k2.5': { prompt: 0.6, completion: 3.0 },
  'moonshot.kimi-k2-thinking': { prompt: 0.6, completion: 2.5 },
  /* Both dot-prefixed forms need their own row: longest-substring matching
     otherwise reaches `moonshot.kimi` or `moonshot` before `kimi-k3`. */
  'moonshot.kimi-k3': { prompt: 3.0, completion: 15.0 },
  'moonshotai.kimi-k3': { prompt: 3.0, completion: 15.0 },
};

/**
 * Mapping of model token sizes to their respective multipliers for prompt and completion.
 * The rates are 1 USD per 1M tokens.
 */
export const tokenValues: Record<string, { prompt: number; completion: number }> = Object.assign(
  {
    '8k': { prompt: 30, completion: 60 },
    '32k': { prompt: 60, completion: 120 },
    '4k': { prompt: 1.5, completion: 2 },
    '16k': { prompt: 3, completion: 4 },
    'claude-': { prompt: 0.8, completion: 2.4 },
    deepseek: { prompt: 0.28, completion: 0.42 },
    command: { prompt: 0.38, completion: 0.38 },
    gemma: { prompt: 0.02, completion: 0.04 },
    gemini: { prompt: 0.5, completion: 1.5 },
    'gpt-oss': { prompt: 0.05, completion: 0.2 },
    'gpt-3.5-turbo-1106': { prompt: 1, completion: 2 },
    'gpt-3.5-turbo-0125': { prompt: 0.5, completion: 1.5 },
    'gpt-4-1106': { prompt: 10, completion: 30 },
    'gpt-4.1': { prompt: 2, completion: 8 },
    'gpt-4.1-nano': { prompt: 0.1, completion: 0.4 },
    'gpt-4.1-mini': { prompt: 0.4, completion: 1.6 },
    'gpt-4.5': { prompt: 75, completion: 150 },
    'gpt-4o': { prompt: 2.5, completion: 10 },
    'gpt-4o-2024-05-13': { prompt: 5, completion: 15 },
    'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
    'gpt-5': { prompt: 1.25, completion: 10 },
    'gpt-5.1': { prompt: 1.25, completion: 10 },
    'gpt-5.2': { prompt: 1.75, completion: 14 },
    'gpt-5.3': { prompt: 1.75, completion: 14 },
    'gpt-5.4': { prompt: 2.5, completion: 15 },
    'gpt-5.4-pro': { prompt: 30, completion: 180 },
    'gpt-5.4-mini': { prompt: 0.75, completion: 4.5 },
    'gpt-5.4-nano': { prompt: 0.2, completion: 1.25 },
    'gpt-5.5': { prompt: 5, completion: 30 },
    'gpt-5.5-pro': { prompt: 30, completion: 180 },
    'gpt-5.6': { prompt: 4, completion: 20 },
    'gpt-5.6-terra': { prompt: 2, completion: 12 },
    'gpt-5.6-luna': { prompt: 0.2, completion: 1.2 },
    'gpt-6-astra': { prompt: 10, completion: 50 },
    'gpt-6-sol': { prompt: 2, completion: 10 },
    'gpt-6-luna': { prompt: 0.1, completion: 0.5 },
    'chat-latest': { prompt: 5, completion: 30 },
    'gpt-5-chat-latest': { prompt: 1.25, completion: 10 },
    'gpt-5.1-chat-latest': { prompt: 1.25, completion: 10 },
    'gpt-5.2-chat-latest': { prompt: 1.75, completion: 14 },
    'gpt-5.3-chat-latest': { prompt: 1.75, completion: 14 },
    'gpt-5-nano': { prompt: 0.05, completion: 0.4 },
    'gpt-5-mini': { prompt: 0.25, completion: 2 },
    'gpt-5-pro': { prompt: 15, completion: 120 },
    'gpt-5.2-pro': { prompt: 21, completion: 168 },
    o1: { prompt: 15, completion: 60 },
    'o1-mini': { prompt: 1.1, completion: 4.4 },
    'o1-preview': { prompt: 15, completion: 60 },
    o3: { prompt: 2, completion: 8 },
    'o3-mini': { prompt: 1.1, completion: 4.4 },
    'o4-mini': { prompt: 1.1, completion: 4.4 },
    'claude-instant': { prompt: 0.8, completion: 2.4 },
    'claude-2': { prompt: 8, completion: 24 },
    'claude-2.1': { prompt: 8, completion: 24 },
    'claude-3-haiku': { prompt: 0.25, completion: 1.25 },
    'claude-3-sonnet': { prompt: 3, completion: 15 },
    'claude-3-opus': { prompt: 15, completion: 75 },
    'claude-3-5-haiku': { prompt: 0.8, completion: 4 },
    'claude-3.5-haiku': { prompt: 0.8, completion: 4 },
    'claude-3-5-sonnet': { prompt: 3, completion: 15 },
    'claude-3.5-sonnet': { prompt: 3, completion: 15 },
    'claude-3-7-sonnet': { prompt: 3, completion: 15 },
    'claude-3.7-sonnet': { prompt: 3, completion: 15 },
    'claude-haiku-4-5': { prompt: 1, completion: 5 },
    'claude-opus-4': { prompt: 15, completion: 75 },
    'claude-opus-4-5': { prompt: 5, completion: 25 },
    'claude-opus-4-6': { prompt: 5, completion: 25 },
    'claude-opus-4-7': { prompt: 5, completion: 25 },
    'claude-opus-4-8': { prompt: 5, completion: 25 },
    'claude-opus-5': { prompt: 5, completion: 25 },
    'claude-opus-5-5': { prompt: 4, completion: 20 },
    'claude-opus-5.5': { prompt: 4, completion: 20 },
    'claude-fable-5': { prompt: 10, completion: 50 },
    'claude-mythos-5': { prompt: 10, completion: 50 },
    'claude-fable-5-1': { prompt: 10, completion: 50 },
    'claude-mythos-5-1': { prompt: 10, completion: 50 },
    'claude-sonnet-4': { prompt: 3, completion: 15 },
    'claude-sonnet-4-5': { prompt: 3, completion: 15 },
    'claude-sonnet-4-6': { prompt: 3, completion: 15 },
    // Sonnet 5 introductory pricing through 2026-08-31; revert to { prompt: 3, completion: 15 } after.
    'claude-sonnet-5': { prompt: 2, completion: 10 },
    'command-r': { prompt: 0.5, completion: 1.5 },
    'command-r-plus': { prompt: 3, completion: 15 },
    'command-text': { prompt: 1.5, completion: 2.0 },
    'command-a': { prompt: 2.5, completion: 10.0 },
    'deepseek-chat': { prompt: 0.28, completion: 0.42 },
    'deepseek-reasoner': { prompt: 0.28, completion: 0.42 },
    'deepseek-r1': { prompt: 0.4, completion: 2.0 },
    'deepseek-v3': { prompt: 0.2, completion: 0.8 },
    'deepseek-v4-flash': { prompt: 0.14, completion: 0.28 },
    'deepseek-v4-pro': { prompt: 0.435, completion: 0.87 },
    'gemma-2': { prompt: 0.01, completion: 0.03 },
    'gemma-3': { prompt: 0.02, completion: 0.04 },
    'gemma-3-27b': { prompt: 0.09, completion: 0.16 },
    'gemini-1.5': { prompt: 2.5, completion: 10 },
    'gemini-1.5-flash': { prompt: 0.15, completion: 0.6 },
    'gemini-1.5-flash-8b': { prompt: 0.075, completion: 0.3 },
    'gemini-2.0': { prompt: 0.1, completion: 0.4 },
    'gemini-2.0-flash': { prompt: 0.1, completion: 0.4 },
    'gemini-2.0-flash-lite': { prompt: 0.075, completion: 0.3 },
    'gemini-2.5': { prompt: 0.3, completion: 2.5 },
    'gemini-2.5-flash': { prompt: 0.3, completion: 2.5 },
    'gemini-2.5-flash-lite': { prompt: 0.1, completion: 0.4 },
    'gemini-2.5-pro': { prompt: 1.25, completion: 10 },
    'gemini-2.5-flash-image': { prompt: 0.15, completion: 30 },
    'gemini-3': { prompt: 2, completion: 12 },
    'gemini-3-pro-image': { prompt: 2, completion: 120 },
    'gemini-3.1': { prompt: 2, completion: 12 },
    'gemini-3.1-flash-lite': { prompt: 0.25, completion: 1.5 },
    'gemini-3.5-flash': { prompt: 1.5, completion: 9 },
    'gemini-3.5-flash-lite': { prompt: 0.3, completion: 2.5 },
    // Gemini 3.6/3.7/3.8 Flash introductory pricing through 2026-12-31; revert to { prompt: 1.5, completion: 7.5 } after.
    'gemini-3.6-flash': { prompt: 0.75, completion: 3.75 },
    'gemini-3.7-flash': { prompt: 0.75, completion: 3.75 },
    'gemini-3.8-flash': { prompt: 0.75, completion: 3.75 },
    'gemini-pro-vision': { prompt: 0.5, completion: 1.5 },
    grok: { prompt: 2.0, completion: 10.0 },
    'grok-beta': { prompt: 5.0, completion: 15.0 },
    'grok-vision-beta': { prompt: 5.0, completion: 15.0 },
    'grok-2': { prompt: 2.0, completion: 10.0 },
    'grok-2-1212': { prompt: 2.0, completion: 10.0 },
    'grok-2-latest': { prompt: 2.0, completion: 10.0 },
    'grok-2-vision': { prompt: 2.0, completion: 10.0 },
    'grok-2-vision-1212': { prompt: 2.0, completion: 10.0 },
    'grok-2-vision-latest': { prompt: 2.0, completion: 10.0 },
    'grok-3': { prompt: 3.0, completion: 15.0 },
    'grok-3-fast': { prompt: 5.0, completion: 25.0 },
    'grok-3-mini': { prompt: 0.3, completion: 0.5 },
    'grok-3-mini-fast': { prompt: 0.6, completion: 4 },
    'grok-4': { prompt: 3.0, completion: 15.0 },
    'grok-4-fast': { prompt: 0.2, completion: 0.5 },
    'grok-4-1-fast': { prompt: 0.2, completion: 0.5 },
    /* Standard tier. The doubled rate above a 200K prompt lives in
       `premiumTokenValues`, since the 500K window makes it reachable. */
    'grok-4.5': { prompt: 2.0, completion: 6.0 },
    'grok-4-5': { prompt: 2.0, completion: 6.0 },
    'grok-4.6': { prompt: 2.0, completion: 6.0 },
    'grok-4-6': { prompt: 2.0, completion: 6.0 },
    'grok-4.7': { prompt: 2.0, completion: 6.0 },
    'grok-4-7': { prompt: 2.0, completion: 6.0 },
    'grok-code-fast': { prompt: 0.2, completion: 1.5 },
    codestral: { prompt: 0.3, completion: 0.9 },
    devstral: { prompt: 0.4, completion: 2.0 },
    'mistral-medium': { prompt: 1.5, completion: 7.5 },
    voxtral: { prompt: 0.1, completion: 0.4 },
    holo2: { prompt: 0.3, completion: 0.7 },
    'ministral-3b': { prompt: 0.04, completion: 0.04 },
    'ministral-8b': { prompt: 0.1, completion: 0.1 },
    'ministral-8b-2512': { prompt: 0.15, completion: 0.15 },
    'ministral-14b-2512': { prompt: 0.2, completion: 0.2 },
    'mistral-nemo': { prompt: 0.15, completion: 0.15 },
    'mistral-saba': { prompt: 0.2, completion: 0.6 },
    'pixtral-large': { prompt: 2.0, completion: 6.0 },
    'mistral-large': { prompt: 2.0, completion: 6.0 },
    'mixtral-8x22b': { prompt: 0.65, completion: 0.65 },
    kimi: { prompt: 0.6, completion: 2.5 },
    moonshot: { prompt: 2.0, completion: 5.0 },
    'kimi-latest': { prompt: 0.2, completion: 2.0 },
    'kimi-k2': { prompt: 0.6, completion: 2.5 },
    'kimi-k2.5': { prompt: 0.6, completion: 3.0 },
    'kimi-k2-turbo': { prompt: 1.15, completion: 8.0 },
    'kimi-k2-turbo-preview': { prompt: 1.15, completion: 8.0 },
    'kimi-k2-0905': { prompt: 0.6, completion: 2.5 },
    'kimi-k2-0905-preview': { prompt: 0.6, completion: 2.5 },
    'kimi-k2-0711': { prompt: 0.6, completion: 2.5 },
    'kimi-k2-0711-preview': { prompt: 0.6, completion: 2.5 },
    'kimi-k2-thinking': { prompt: 0.6, completion: 2.5 },
    'kimi-k2-thinking-turbo': { prompt: 1.15, completion: 8.0 },
    'kimi-k3': { prompt: 3.0, completion: 15.0 },
    'moonshot-v1': { prompt: 2.0, completion: 5.0 },
    'moonshot-v1-auto': { prompt: 2.0, completion: 5.0 },
    'moonshot-v1-8k': { prompt: 0.2, completion: 2.0 },
    'moonshot-v1-8k-vision': { prompt: 0.2, completion: 2.0 },
    'moonshot-v1-8k-vision-preview': { prompt: 0.2, completion: 2.0 },
    'moonshot-v1-32k': { prompt: 1.0, completion: 3.0 },
    'moonshot-v1-32k-vision': { prompt: 1.0, completion: 3.0 },
    'moonshot-v1-32k-vision-preview': { prompt: 1.0, completion: 3.0 },
    'moonshot-v1-128k': { prompt: 2.0, completion: 5.0 },
    'moonshot-v1-128k-vision': { prompt: 2.0, completion: 5.0 },
    'moonshot-v1-128k-vision-preview': { prompt: 2.0, completion: 5.0 },
    'gpt-oss:20b': { prompt: 0.05, completion: 0.2 },
    'gpt-oss-20b': { prompt: 0.05, completion: 0.2 },
    'gpt-oss:120b': { prompt: 0.15, completion: 0.6 },
    'gpt-oss-120b': { prompt: 0.15, completion: 0.6 },
    glm4: { prompt: 0.1, completion: 0.1 },
    'glm-4': { prompt: 0.1, completion: 0.1 },
    'glm-4-32b': { prompt: 0.1, completion: 0.1 },
    'glm-4.5': { prompt: 0.35, completion: 1.55 },
    'glm-4.5-air': { prompt: 0.14, completion: 0.86 },
    'glm-4.5v': { prompt: 0.6, completion: 1.8 },
    'glm-4.6': { prompt: 0.5, completion: 1.75 },
    'glm-4.7': { prompt: 0.6, completion: 2.2 },
    'glm-4.7-flash': { prompt: 0.06, completion: 0.4 },
    'glm-5': { prompt: 1.4, completion: 4.4 },
    'glm-5.1': { prompt: 1.4, completion: 4.4 },
    'glm-5.2': { prompt: 1.4, completion: 4.4 },
    'glm-5.3': { prompt: 1.4, completion: 4.4 },
    'minimax-m1': { prompt: 0.55, completion: 2.2 },
    'minimax-m2': { prompt: 0.3, completion: 1.2 },
    'minimax-m2.7': { prompt: 0.3, completion: 1.2 },
    'minimax-m3': { prompt: 0.3, completion: 1.2 },
    qwen: { prompt: 0.08, completion: 0.33 },
    'qwen2.5': { prompt: 0.08, completion: 0.33 },
    'qwen-turbo': { prompt: 0.05, completion: 0.2 },
    'qwen-plus': { prompt: 0.4, completion: 1.2 },
    'qwen-max': { prompt: 1.6, completion: 6.4 },
    'qwq-32b': { prompt: 0.15, completion: 0.4 },
    qwen3: { prompt: 0.035, completion: 0.138 },
    'qwen3-8b': { prompt: 0.035, completion: 0.138 },
    'qwen3-14b': { prompt: 0.05, completion: 0.22 },
    'qwen3-30b-a3b': { prompt: 0.06, completion: 0.22 },
    'qwen3-32b': { prompt: 0.05, completion: 0.2 },
    'qwen3-235b-a22b': { prompt: 0.08, completion: 0.55 },
    'qwen3-vl-8b-thinking': { prompt: 0.18, completion: 2.1 },
    'qwen3-vl-8b-instruct': { prompt: 0.18, completion: 0.69 },
    'qwen3-vl-30b-a3b': { prompt: 0.29, completion: 1.0 },
    'qwen3-vl-235b-a22b': { prompt: 0.3, completion: 1.2 },
    'qwen3-max': { prompt: 1.2, completion: 6 },
    'qwen3-coder': { prompt: 0.22, completion: 0.95 },
    'qwen3-coder-30b-a3b': { prompt: 0.06, completion: 0.25 },
    'qwen3-coder-plus': { prompt: 1, completion: 5 },
    'qwen3-coder-flash': { prompt: 0.3, completion: 1.5 },
    'qwen3-next-80b-a3b': { prompt: 0.1, completion: 0.8 },
    'qwen3-coder-next': { prompt: 0.12, completion: 0.8 },
    musespark: { prompt: 1.25, completion: 4.25 },
    'muse-spark': { prompt: 1.25, completion: 4.25 },
    'muse-spark-1.1': { prompt: 1.25, completion: 4.25 },
    'muse-spark-1.2': { prompt: 1.25, completion: 4.25 },
    'muse-glimmer': { prompt: 0.3, completion: 1.2 },
    'muse-glimmer-30b': { prompt: 0.3, completion: 1.2 },
  },
  bedrockValues,
);

/**
 * Mapping of model token sizes to their respective multipliers for cached input, read and write.
 * The rates are 1 USD per 1M tokens.
 */
export const cacheTokenValues: Record<string, { write: number; read: number }> = {
  'claude-3.7-sonnet': { write: 3.75, read: 0.3 },
  'claude-3-7-sonnet': { write: 3.75, read: 0.3 },
  'claude-3.5-sonnet': { write: 3.75, read: 0.3 },
  'claude-3-5-sonnet': { write: 3.75, read: 0.3 },
  'claude-3.5-haiku': { write: 1, read: 0.08 },
  'claude-3-5-haiku': { write: 1, read: 0.08 },
  'claude-3-haiku': { write: 0.3, read: 0.03 },
  'claude-haiku-4-5': { write: 1.25, read: 0.1 },
  'claude-sonnet-4': { write: 3.75, read: 0.3 },
  'claude-sonnet-4-5': { write: 3.75, read: 0.3 },
  'claude-sonnet-4-6': { write: 3.75, read: 0.3 },
  // Sonnet 5 introductory pricing through 2026-08-31; revert to { write: 3.75, read: 0.3 } after.
  'claude-sonnet-5': { write: 2.5, read: 0.2 },
  'claude-opus-4': { write: 18.75, read: 1.5 },
  'claude-opus-4-5': { write: 6.25, read: 0.5 },
  'claude-opus-4-6': { write: 6.25, read: 0.5 },
  'claude-opus-4-7': { write: 6.25, read: 0.5 },
  'claude-opus-4-8': { write: 6.25, read: 0.5 },
  'claude-opus-5': { write: 6.25, read: 0.5 },
  'claude-opus-5-5': { write: 5, read: 0.2 },
  'claude-opus-5.5': { write: 5, read: 0.2 },
  'claude-fable-5': { write: 12.5, read: 1 },
  'claude-mythos-5': { write: 12.5, read: 1 },
  // Fable/Mythos 5.1 cache reads are 0.025x base input, not the usual 0.1x.
  'claude-fable-5-1': { write: 12.5, read: 0.25 },
  'claude-mythos-5-1': { write: 12.5, read: 0.25 },
  'gpt-4o': { write: 2.5, read: 1.25 },
  'gpt-4o-mini': { write: 0.15, read: 0.075 },
  'gpt-4.1': { write: 2, read: 0.5 },
  'gpt-4.1-mini': { write: 0.4, read: 0.1 },
  'gpt-4.1-nano': { write: 0.1, read: 0.025 },
  'gpt-5': { write: 1.25, read: 0.125 },
  'gpt-5.1': { write: 1.25, read: 0.125 },
  'gpt-5.2': { write: 1.75, read: 0.175 },
  'gpt-5.3': { write: 1.75, read: 0.175 },
  'gpt-5.4': { write: 2.5, read: 0.25 },
  'gpt-5.4-mini': { write: 0.75, read: 0.075 },
  'gpt-5.4-nano': { write: 0.2, read: 0.02 },
  'gpt-5.5': { write: 5, read: 0.5 },
  'gpt-5.6': { write: 5, read: 0.4 },
  'gpt-5.6-terra': { write: 2.5, read: 0.2 },
  'gpt-5.6-luna': { write: 0.25, read: 0.02 },
  'gpt-6-astra': { write: 12.5, read: 1 },
  'gpt-6-sol': { write: 2.5, read: 0.2 },
  'gpt-6-luna': { write: 0.125, read: 0.01 },
  'chat-latest': { write: 5, read: 0.5 },
  'gpt-5-chat-latest': { write: 1.25, read: 0.125 },
  'gpt-5.1-chat-latest': { write: 1.25, read: 0.125 },
  'gpt-5.2-chat-latest': { write: 1.75, read: 0.175 },
  'gpt-5.3-chat-latest': { write: 1.75, read: 0.175 },
  'gpt-5-mini': { write: 0.25, read: 0.025 },
  'gpt-5-nano': { write: 0.05, read: 0.005 },
  o1: { write: 15, read: 7.5 },
  'o1-mini': { write: 1.1, read: 0.55 },
  'o1-preview': { write: 15, read: 7.5 },
  o3: { write: 2, read: 0.5 },
  'o3-mini': { write: 1.1, read: 0.275 },
  'o4-mini': { write: 1.1, read: 0.275 },
  'grok-4.7': { write: 2, read: 0.5 },
  'grok-4-7': { write: 2, read: 0.5 },
  deepseek: { write: 0.28, read: 0.028 },
  'deepseek-chat': { write: 0.28, read: 0.028 },
  'deepseek-reasoner': { write: 0.28, read: 0.028 },
  kimi: { write: 0.6, read: 0.15 },
  'kimi-k2': { write: 0.6, read: 0.15 },
  'kimi-k2.5': { write: 0.6, read: 0.1 },
  'kimi-k2-turbo': { write: 1.15, read: 0.15 },
  'kimi-k2-turbo-preview': { write: 1.15, read: 0.15 },
  'kimi-k2-0905': { write: 0.6, read: 0.15 },
  'kimi-k2-0905-preview': { write: 0.6, read: 0.15 },
  'kimi-k2-0711': { write: 0.6, read: 0.15 },
  'kimi-k2-0711-preview': { write: 0.6, read: 0.15 },
  'kimi-k2-thinking': { write: 0.6, read: 0.15 },
  'kimi-k2-thinking-turbo': { write: 1.15, read: 0.15 },
  // Gemini 3.1 Pro - cache write: $2.00/1M, cache read: $0.20/1M
  'gemini-3.1': { write: 2, read: 0.2 },
  // Gemini 3.1 Flash-Lite - cache write: $0.25/1M, cache read: $0.025/1M
  'gemini-3.1-flash-lite': { write: 0.25, read: 0.025 },
  // Gemini 3.5 Flash - cache write: $1.50/1M, cache read: $0.15/1M
  'gemini-3.5-flash': { write: 1.5, read: 0.15 },
  // Gemini 3.5 Flash-Lite - cache write: $0.30/1M, cache read: $0.03/1M
  'gemini-3.5-flash-lite': { write: 0.3, read: 0.03 },
  // Gemini 3.6/3.7/3.8 Flash introductory pricing through 2026-12-31; revert to { write: 1.5, read: 0.15 } after.
  'gemini-3.6-flash': { write: 0.75, read: 0.075 },
  'gemini-3.7-flash': { write: 0.75, read: 0.075 },
  'gemini-3.8-flash': { write: 0.75, read: 0.075 },
};

/**
 * Premium (tiered) pricing for models whose rates change based on prompt size.
 */
export const premiumTokenValues: Record<
  string,
  { threshold: number; prompt: number; completion: number }
> = {
  'gemini-3.1': { threshold: 200000, prompt: 4, completion: 18 },
  'gpt-5.4': { threshold: 272000, prompt: 5, completion: 22.5 },
  'gpt-5.4-pro': { threshold: 272000, prompt: 60, completion: 270 },
  'gpt-5.5': { threshold: 272000, prompt: 10, completion: 45 },
  'gpt-5.5-pro': { threshold: 272000, prompt: 60, completion: 270 },
  'gpt-5.6': { threshold: 272000, prompt: 8, completion: 30 },
  'gpt-5.6-terra': { threshold: 272000, prompt: 4, completion: 18 },
  'gpt-5.6-luna': { threshold: 272000, prompt: 0.4, completion: 1.8 },
  'gpt-6-astra': { threshold: 272000, prompt: 20, completion: 75 },
  'gpt-6-sol': { threshold: 272000, prompt: 4, completion: 15 },
  'gpt-6-luna': { threshold: 272000, prompt: 0.2, completion: 0.75 },
  'grok-4.5': { threshold: 200000, prompt: 4, completion: 12 },
  'grok-4-5': { threshold: 200000, prompt: 4, completion: 12 },
  'grok-4.6': { threshold: 200000, prompt: 4, completion: 12 },
  'grok-4-6': { threshold: 200000, prompt: 4, completion: 12 },
  /** xAI bills >=200K at the long-context rate; this table uses exclusive thresholds. */
  'grok-4.7': { threshold: 199999, prompt: 4, completion: 12 },
  'grok-4-7': { threshold: 199999, prompt: 4, completion: 12 },
};

/**
 * Premium (tiered) cache pricing for models whose cache rates change once the
 * prompt crosses the long-context threshold. Cache write/read scale by the same
 * multiplier the long-context tier applies to input (e.g. 2x for the gpt-5.x
 * family), so these mirror `premiumTokenValues` on the cache dimension.
 */
export const premiumCacheTokenValues: Record<
  string,
  { threshold: number; write: number; read: number }
> = {
  'gpt-5.4': { threshold: 272000, write: 5, read: 0.5 },
  'gpt-5.5': { threshold: 272000, write: 10, read: 1 },
  'gpt-5.6': { threshold: 272000, write: 10, read: 0.8 },
  'gpt-5.6-terra': { threshold: 272000, write: 5, read: 0.4 },
  'gpt-5.6-luna': { threshold: 272000, write: 0.5, read: 0.04 },
  'gpt-6-astra': { threshold: 272000, write: 25, read: 2 },
  'gpt-6-sol': { threshold: 272000, write: 5, read: 0.4 },
  'gpt-6-luna': { threshold: 272000, write: 0.25, read: 0.02 },
  'grok-4.7': { threshold: 199999, write: 4, read: 1 },
  'grok-4-7': { threshold: 199999, write: 4, read: 1 },
};

export function createTxMethods(
  _mongoose: typeof import('mongoose'),
  txDeps: TxDeps,
): {
  tokenValues: Record<
    string,
    {
      prompt: number;
      completion: number;
    }
  >;
  premiumTokenValues: Record<
    string,
    {
      threshold: number;
      prompt: number;
      completion: number;
    }
  >;
  getValueKey: (model: string, endpoint?: string) => string | undefined;
  getMultiplier: ({
    model,
    valueKey,
    endpoint,
    tokenType,
    inputTokenCount,
    endpointTokenConfig,
  }: {
    model?: string;
    valueKey?: string;
    endpoint?: string;
    tokenType?: 'prompt' | 'completion';
    inputTokenCount?: number;
    endpointTokenConfig?: Record<string, Record<string, number>>;
  }) => number;
  getPremiumRate: (
    valueKey: string,
    tokenType: string,
    inputTokenCount?: number | null,
  ) => number | null;
  getCacheMultiplier: ({
    valueKey,
    cacheType,
    model,
    endpoint,
    endpointTokenConfig,
    inputTokenCount,
  }: {
    valueKey?: string;
    cacheType?: 'write' | 'read';
    model?: string;
    endpoint?: string;
    endpointTokenConfig?: Record<string, Record<string, number>>;
    inputTokenCount?: number | null;
  }) => number | null;
  defaultRate: number;
  cacheTokenValues: Record<
    string,
    {
      write: number;
      read: number;
    }
  >;
} {
  const { matchModelName, findMatchingPattern } = txDeps;

  /**
   * Retrieves the key associated with a given model name.
   */
  function getValueKey(model: string, endpoint?: string): string | undefined {
    if (!model || typeof model !== 'string') {
      return undefined;
    }

    if (!endpoint || (typeof endpoint === 'string' && !tokenValues[endpoint])) {
      const matchedKey = findMatchingPattern(model, tokenValues);
      if (matchedKey) {
        return matchedKey;
      }
    }

    const modelName = matchModelName(model, endpoint);
    if (!modelName) {
      return undefined;
    }

    if (modelName.includes('gpt-3.5-turbo-16k')) {
      return '16k';
    } else if (modelName.includes('gpt-3.5')) {
      return '4k';
    } else if (modelName.includes('gpt-4-vision')) {
      return 'gpt-4-1106';
    } else if (modelName.includes('gpt-4-0125')) {
      return 'gpt-4-1106';
    } else if (modelName.includes('gpt-4-turbo')) {
      return 'gpt-4-1106';
    } else if (modelName.includes('gpt-4-32k')) {
      return '32k';
    } else if (modelName.includes('gpt-4')) {
      return '8k';
    }

    return undefined;
  }

  /**
   * Checks if premium (tiered) pricing applies and returns the premium rate.
   */
  function getPremiumRate(
    valueKey: string,
    tokenType: string,
    inputTokenCount?: number | null,
  ): number | null {
    if (inputTokenCount == null) {
      return null;
    }
    const premiumEntry = premiumTokenValues[valueKey];
    if (!premiumEntry || inputTokenCount <= premiumEntry.threshold) {
      return null;
    }
    return premiumEntry[tokenType as 'prompt' | 'completion'] ?? null;
  }

  /**
   * Retrieves the multiplier for a given value key and token type.
   */
  function getMultiplier({
    model,
    valueKey,
    endpoint,
    tokenType,
    inputTokenCount,
    endpointTokenConfig,
  }: {
    model?: string;
    valueKey?: string;
    endpoint?: string;
    tokenType?: 'prompt' | 'completion';
    inputTokenCount?: number;
    endpointTokenConfig?: Record<string, Record<string, number>>;
  }): number {
    if (endpointTokenConfig && model) {
      const modelConfig = endpointTokenConfig[model];
      /** A partial override only prices the models it lists; others fall
       *  through to the standard tables so billing matches the advertised
       *  token config instead of charging defaultRate */
      if (modelConfig) {
        return modelConfig[tokenType as string] ?? defaultRate;
      }
    }

    if (valueKey && tokenType) {
      const premiumRate = getPremiumRate(valueKey, tokenType, inputTokenCount);
      if (premiumRate != null) {
        return premiumRate;
      }
      return tokenValues[valueKey]?.[tokenType] ?? defaultRate;
    }

    if (!tokenType || !model) {
      return 1;
    }

    valueKey = getValueKey(model, endpoint);
    if (!valueKey) {
      return defaultRate;
    }

    const premiumRate = getPremiumRate(valueKey, tokenType, inputTokenCount);
    if (premiumRate != null) {
      return premiumRate;
    }

    return tokenValues[valueKey]?.[tokenType] ?? defaultRate;
  }

  /**
   * Checks if premium (tiered) cache pricing applies and returns the premium rate.
   */
  function getPremiumCacheRate(
    valueKey: string,
    cacheType: 'write' | 'read',
    inputTokenCount?: number | null,
  ): number | null {
    if (inputTokenCount == null) {
      return null;
    }
    const premiumEntry = premiumCacheTokenValues[valueKey];
    if (!premiumEntry || inputTokenCount <= premiumEntry.threshold) {
      return null;
    }
    return premiumEntry[cacheType] ?? null;
  }

  /**
   * Retrieves the cache multiplier for a given value key and token type.
   * When `inputTokenCount` crosses a model's long-context threshold, the
   * premium cache rate applies instead of the standard one.
   */
  function getCacheMultiplier({
    valueKey,
    cacheType,
    model,
    endpoint,
    endpointTokenConfig,
    inputTokenCount,
  }: {
    valueKey?: string;
    cacheType?: 'write' | 'read';
    model?: string;
    endpoint?: string;
    endpointTokenConfig?: Record<string, Record<string, number>>;
    inputTokenCount?: number | null;
  }): number | null {
    if (endpointTokenConfig && model) {
      const modelConfig = endpointTokenConfig[model];
      /** Models absent from a partial override fall through to standard
       *  cache rates rather than reporting no cache pricing */
      if (modelConfig) {
        return modelConfig[cacheType as string] ?? null;
      }
    }

    if (valueKey && cacheType) {
      return (
        getPremiumCacheRate(valueKey, cacheType, inputTokenCount) ??
        cacheTokenValues[valueKey]?.[cacheType] ??
        null
      );
    }

    if (!cacheType || !model) {
      return null;
    }

    valueKey = getValueKey(model, endpoint);
    if (!valueKey) {
      return null;
    }

    return (
      getPremiumCacheRate(valueKey, cacheType, inputTokenCount) ??
      cacheTokenValues[valueKey]?.[cacheType] ??
      null
    );
  }

  return {
    tokenValues,
    premiumTokenValues,
    getValueKey,
    getMultiplier,
    getPremiumRate,
    getCacheMultiplier,
    defaultRate,
    cacheTokenValues,
  };
}

export type TxMethods = ReturnType<typeof createTxMethods>;
