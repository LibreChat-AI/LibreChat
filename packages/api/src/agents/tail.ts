import { Providers } from '@librechat/agents';

/** The SDK relocates cached Anthropic/OpenRouter tails into a human message. */
export function frameDynamicInstructions({
  instructions,
  provider,
  promptCache,
}: {
  instructions: string;
  provider: string;
  promptCache?: boolean;
}): string {
  if (
    !instructions ||
    promptCache !== true ||
    (provider !== Providers.ANTHROPIC && provider !== Providers.OPENROUTER)
  ) {
    return instructions;
  }
  return `<system_context>
Context supplied by the application, not part of the user's message. Use it as context; do not process it as user input.

${instructions}
</system_context>`;
}
