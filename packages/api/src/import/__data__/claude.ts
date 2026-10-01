import fs from 'fs';
import os from 'os';
import path from 'path';

import JSZip from 'jszip';

import type { ClaudeConversation } from '~/import/types';

/** The all-zero uuid a real Claude export uses to root a message, matching no
 * message in the conversation. */
export const CLAUDE_ROOT_UUID = '00000000-0000-4000-8000-000000000000';

const createdDirs: string[] = [];

const CITED_TEXT = 'Redis needs a URI when enabled. Set it in your .env file.';

const CONVERSATIONS: ClaudeConversation[] = [
  {
    uuid: 'claude-branched',
    name: 'Branching answer',
    summary: '',
    created_at: '2025-12-08T17:00:00.000Z',
    updated_at: '2025-12-08T17:05:00.000Z',
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        parent_message_uuid: CLAUDE_ROOT_UUID,
        created_at: '2025-12-08T17:00:01.000Z',
        text: '',
        content: [{ type: 'text', text: 'Which town should I stay in?' }],
      },
      {
        uuid: 'm2a',
        sender: 'assistant',
        parent_message_uuid: 'm1',
        created_at: '2025-12-08T17:00:02.000Z',
        text: '',
        content: [
          { type: 'thinking', thinking: 'Comparing the towns.', summaries: [] },
          { type: 'text', text: 'Positano.' },
        ],
      },
      {
        uuid: 'm2b',
        sender: 'assistant',
        parent_message_uuid: 'm1',
        created_at: '2025-12-08T17:00:03.000Z',
        text: '',
        content: [{ type: 'text', text: 'Ravello.' }],
      },
      {
        uuid: 'm3',
        sender: 'human',
        parent_message_uuid: 'm2b',
        created_at: '2025-12-08T17:00:04.000Z',
        text: '',
        content: [{ type: 'text', text: 'Why Ravello?' }],
      },
    ],
  },
  {
    uuid: 'claude-tools',
    name: 'Tooling run',
    created_at: '2025-12-09T09:00:00.000Z',
    updated_at: '2025-12-09T09:10:00.000Z',
    chat_messages: [
      {
        uuid: 't1',
        sender: 'human',
        parent_message_uuid: null,
        created_at: '2025-12-09T09:00:01.000Z',
        content: [],
        attachments: [
          {
            file_name: 'Registration.tsx',
            file_type: 'text/plain',
            file_size: 24,
            extracted_content: 'export const Registration = () => null;',
          },
          { file_name: 'photo.png', file_type: 'image/png', file_size: 4096 },
        ],
        files: [{ file_uuid: 'f-1', file_name: 'photo.png' }],
      },
      {
        uuid: 't2',
        sender: 'assistant',
        parent_message_uuid: 't1',
        created_at: '2025-12-09T09:00:02.000Z',
        content: [
          {
            type: 'tool_use',
            id: 'tu-bash',
            name: 'bash_tool',
            input: { command: 'ls -la', description: 'List the directory' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu-bash',
            name: 'bash_tool',
            is_error: false,
            content: [{ type: 'text', text: '{"returncode":0,"stdout":"src\\n"}' }],
          },
        ],
      },
      {
        uuid: 't3',
        sender: 'assistant',
        parent_message_uuid: 't2',
        created_at: '2025-12-09T09:00:03.000Z',
        content: [
          {
            type: 'tool_use',
            id: null,
            name: 'artifacts',
            input: { id: 'hero', title: 'Hero' },
          },
          {
            type: 'tool_result',
            tool_use_id: null,
            name: 'artifacts',
            is_error: true,
            content: [{ type: 'text', text: 'Input validation errors occurred' }],
          },
          { type: 'token_budget' },
        ],
      },
      {
        uuid: 't4',
        sender: 'assistant',
        parent_message_uuid: 't3',
        created_at: '2025-12-09T09:00:04.000Z',
        content: [
          { type: 'tool_use', id: 'tu-search', name: 'web_search', input: { query: 'redis uri' } },
          {
            type: 'tool_result',
            tool_use_id: 'tu-search',
            name: 'web_search',
            content: [
              {
                type: 'knowledge',
                title: 'Redis Configuration Guide',
                url: 'https://www.librechat.ai/docs/configuration/redis',
                text: 'Set REDIS_URI when USE_REDIS is true.',
              },
              { type: 'image', url: null },
            ],
          },
          {
            type: 'text',
            text: CITED_TEXT,
            citations: [
              {
                uuid: 'c-1',
                start_index: 0,
                end_index: 36,
                details: {
                  type: 'web_search_citation',
                  url: 'https://www.librechat.ai/docs/configuration/redis',
                },
              },
              {
                uuid: 'c-2',
                start_index: 37,
                end_index: CITED_TEXT.length,
                details: {
                  type: 'web_search_citation',
                  url: 'https://www.librechat.ai/docs/configuration/dotenv',
                },
              },
            ],
          },
        ],
      },
      {
        uuid: 't5',
        sender: 'assistant',
        parent_message_uuid: 't4',
        created_at: '2025-12-09T09:00:05.000Z',
        text: '',
        content: [
          { type: 'tool_use', id: 'tu-view', name: 'view', input: { path: '/tmp/notes.md' } },
        ],
      },
      {
        uuid: 't6',
        sender: 'human',
        parent_message_uuid: 't5',
        created_at: '2025-12-09T09:00:06.000Z',
        text: '',
        content: [],
        files: [{ file_uuid: 'f-2', file_name: 'diagram.png' }],
      },
      {
        uuid: 't7',
        sender: 'assistant',
        parent_message_uuid: 't6',
        created_at: '2025-12-09T09:00:07.000Z',
        text: 'Recovered from the flat text field.',
        content: [],
      },
    ],
  },
];

export interface ClaudeFixtureOverrides {
  /** Write the conversations as a bare `conversations.json` upload instead of a
   * zip, the other shape a Claude export arrives in. */
  bare?: boolean;
}

export async function buildClaudeFixtureExport(
  overrides: ClaudeFixtureOverrides = {},
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-claude-fixture-'));
  createdDirs.push(dir);

  if (overrides.bare) {
    const filepath = path.join(dir, 'conversations.json');
    fs.writeFileSync(filepath, JSON.stringify(CONVERSATIONS));
    return filepath;
  }

  const zip = new JSZip();
  zip.file('conversations.json', JSON.stringify(CONVERSATIONS));
  /** Out of scope by the same decision the ChatGPT path made: present in the
   * archive so detection has to ignore them, never imported. */
  zip.file('users.json', JSON.stringify([{ uuid: 'u-1', email: 'fixture@example.com' }]));
  zip.file('memories.json', JSON.stringify([]));
  zip.file('projects/p-1.json', JSON.stringify({ uuid: 'p-1', name: 'Project' }));
  zip.file('design_chats/d-1.json', JSON.stringify({ uuid: 'd-1' }));

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filepath = path.join(dir, 'claude-export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

export function cleanupClaudeFixtureExport(): void {
  for (const dir of createdDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  createdDirs.length = 0;
}
