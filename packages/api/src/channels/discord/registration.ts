import { z } from 'zod';
import { channelSnowflakeSchema } from 'librechat-data-provider';

/** Explicitly upsert this one global CHAT_INPUT command; bulk replacement would erase other commands. */
export const discordCommandManifest = {
  type: 1,
  name: 'librechat',
  description: 'Use LibreChat with your linked account',
  integration_types: [0],
  contexts: [0, 1],
  default_member_permissions: null,
  nsfw: false,
  options: [
    {
      type: 1,
      name: 'ask',
      description: 'Send a prompt to this channel agent',
      options: [
        {
          type: 3,
          name: 'prompt',
          description: 'Prompt to send',
          required: true,
          min_length: 1,
          max_length: 6000,
        },
      ],
    },
    { type: 1, name: 'link', description: 'Link or confirm your LibreChat account' },
    { type: 1, name: 'status', description: 'Check your current run' },
    { type: 1, name: 'cancel', description: 'Cancel your current run' },
    {
      type: 1,
      name: 'select',
      description: 'Select a private agent using a LibreChat code',
      options: [
        {
          type: 3,
          name: 'code',
          description: 'Private selection code from LibreChat',
          required: true,
          min_length: 43,
          max_length: 43,
        },
      ],
    },
  ],
};
const plain = <T extends string>(name: T) =>
  z.object({
    type: z.literal(1),
    name: z.literal(name),
    options: z.array(z.never()).optional(),
  });

/** Discord's snowflake version is read-only and distinct from our manifest version. */
export const registeredDiscordCommandSchema = z.object({
  id: channelSnowflakeSchema,
  application_id: channelSnowflakeSchema,
  version: channelSnowflakeSchema,
  guild_id: z.never().optional(),
  type: z.literal(1),
  name: z.literal('librechat'),
  integration_types: z.tuple([z.literal(0)]),
  contexts: z
    .array(z.union([z.literal(0), z.literal(1)]))
    .length(2)
    .refine((value) => new Set(value).size === 2),
  default_member_permissions: z.null(),
  nsfw: z.literal(false).optional(),
  options: z.tuple([
    z.object({
      type: z.literal(1),
      name: z.literal('ask'),
      options: z.tuple([
        z.object({
          type: z.literal(3),
          name: z.literal('prompt'),
          required: z.literal(true),
          min_length: z.literal(1),
          max_length: z.literal(6000),
          choices: z.never().optional(),
          autocomplete: z.literal(false).optional(),
        }),
      ]),
    }),
    plain('link'),
    plain('status'),
    plain('cancel'),
    z.object({
      type: z.literal(1),
      name: z.literal('select'),
      options: z.tuple([
        z.object({
          type: z.literal(3),
          name: z.literal('code'),
          required: z.literal(true),
          min_length: z.literal(43),
          max_length: z.literal(43),
          choices: z.never().optional(),
          autocomplete: z.literal(false).optional(),
        }),
      ]),
    }),
  ]),
});
