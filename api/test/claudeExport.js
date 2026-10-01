const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const createdDirs = [];

/** The all-zero uuid a real Claude export uses to root a message. */
const ROOT_UUID = '00000000-0000-4000-8000-000000000000';

const CONVERSATIONS = [
  {
    uuid: 'claude-branched',
    name: 'Branching answer',
    created_at: '2025-12-08T17:00:00.000Z',
    updated_at: '2025-12-08T17:05:00.000Z',
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        parent_message_uuid: ROOT_UUID,
        created_at: '2025-12-08T17:00:01.000Z',
        content: [{ type: 'text', text: 'Which town?' }],
      },
      {
        uuid: 'm2a',
        sender: 'assistant',
        parent_message_uuid: 'm1',
        created_at: '2025-12-08T17:00:02.000Z',
        content: [{ type: 'text', text: 'Positano.' }],
      },
      {
        uuid: 'm2b',
        sender: 'assistant',
        parent_message_uuid: 'm1',
        created_at: '2025-12-08T17:00:03.000Z',
        content: [{ type: 'text', text: 'Ravello.' }],
      },
    ],
  },
  {
    uuid: 'claude-tools',
    name: 'Tooling run',
    created_at: '2025-12-09T09:00:00.000Z',
    chat_messages: [
      {
        uuid: 't1',
        sender: 'human',
        parent_message_uuid: null,
        created_at: '2025-12-09T09:00:01.000Z',
        content: [{ type: 'text', text: 'Run it' }],
      },
      {
        uuid: 't2',
        sender: 'assistant',
        parent_message_uuid: 't1',
        created_at: '2025-12-09T09:00:02.000Z',
        content: [
          {
            type: 'tool_use',
            id: 'tu-1',
            name: 'bash_tool',
            input: { command: 'ls -la' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            name: 'bash_tool',
            content: [{ type: 'text', text: 'src' }],
          },
        ],
      },
    ],
  },
];

/** The conversations array on its own, as a bare `conversations.json` upload. */
function bareClaudeExport() {
  return Buffer.from(JSON.stringify(CONVERSATIONS));
}

/**
 * Minimal Claude export archive for route-level tests: `conversations.json`
 * plus the out-of-scope entries a real export ships, and no binaries at all.
 * @returns {Promise<string>} path to the written zip
 */
async function buildClaudeExportZip() {
  const zip = new JSZip();

  zip.file('conversations.json', JSON.stringify(CONVERSATIONS));
  zip.file('users.json', JSON.stringify([{ uuid: 'u-1', email: 'fixture@example.com' }]));
  zip.file('memories.json', JSON.stringify([]));
  zip.file('projects/p-1.json', JSON.stringify({ uuid: 'p-1', name: 'Project' }));
  zip.file('design_chats/d-1.json', JSON.stringify({ uuid: 'd-1' }));

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-claude-route-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'claude-export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function cleanupClaudeExportZips() {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { bareClaudeExport, buildClaudeExportZip, cleanupClaudeExportZips };
