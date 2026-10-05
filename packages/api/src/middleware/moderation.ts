import { z } from 'zod';
import type { AxiosInstance } from 'axios';
import { isEnabled } from '../utils/common';

const moderationResponse = z.object({
  results: z.array(z.object({ flagged: z.boolean() })),
});
export type ModerationCheck = (inputs: readonly string[]) => Promise<boolean>;

/** The host supplies its existing moderation configuration and HTTP client to every inference surface. */
export function createModerationCheck({
  http,
  environment,
}: {
  http: Pick<AxiosInstance, 'post'>;
  environment: {
    OPENAI_MODERATION?: string;
    OPENAI_MODERATION_REVERSE_PROXY?: string;
    OPENAI_MODERATION_API_KEY?: string;
  };
}): ModerationCheck {
  return async (inputs) => {
    if (!isEnabled(environment.OPENAI_MODERATION) || !inputs.length) return false;
    const response = await http.post(
      environment.OPENAI_MODERATION_REVERSE_PROXY || 'https://api.openai.com/v1/moderations',
      { input: inputs.length === 1 ? inputs[0] : inputs },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${environment.OPENAI_MODERATION_API_KEY}`,
        },
      },
    );
    return moderationResponse.parse(response.data).results.some((result) => result.flagged);
  };
}
