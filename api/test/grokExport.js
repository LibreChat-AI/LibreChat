const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const createdDirs = [];

/** The per-export uuid directory a real Grok archive nests everything under. */
const EXPORT_UUID = 'e618db0b-b890-4728-b3ec-ab25abeb068b';
const ENTRY_PATH = `ttl/30d/export_data/${EXPORT_UUID}/prod-grok-backend.json`;
/** Real Grok archives write asset paths with a doubled separator after the
 * service name; mirrored so the archive layer sees production entry names. */
const ASSET_PATH = `ttl/30d/export_data/${EXPORT_UUID}/prod-mc-asset-server//0380cd07/content`;

const EXPORT = {
  conversations: [
    {
      conversation: {
        id: 'grok-branched',
        title: 'Amalfi trip planning',
        summary: '',
        starred: false,
        create_time: '2026-07-14T03:25:09.401949Z',
      },
      responses: [
        {
          /** No `parent_response_id` at all, and a blank model on a human turn. */
          response: {
            _id: 'g1',
            sender: 'human',
            model: '',
            message: 'Where should I stay?',
            create_time: { $date: { $numberLong: '1783999510820' } },
          },
          share_link: null,
        },
        {
          /** Uppercase sender, which a real export uses on 206 responses. */
          response: {
            _id: 'g2a',
            sender: 'ASSISTANT',
            model: 'grok-4-1-thinking-1129',
            parent_response_id: 'g1',
            message: 'Positano.',
            create_time: { $date: { $numberLong: '1783999520820' } },
            thinking_trace: '<xai:tool_usage_card>\n  <xai:tool_name>web_search</xai:tool_name>\n',
          },
          share_link: null,
        },
        {
          response: {
            _id: 'g2b',
            sender: 'assistant',
            model: 'grok-3',
            parent_response_id: 'g1',
            message: 'Ravello.',
            create_time: { $date: { $numberLong: '1783999530820' } },
          },
          share_link: null,
        },
      ],
    },
    {
      conversation: {
        id: 'grok-retried',
        title: '',
        summary: 'Recovering a cut-off script',
        starred: true,
        create_time: '2026-07-15T10:00:00.000000Z',
      },
      responses: [
        {
          response: {
            _id: 't1',
            sender: 'human',
            model: 'grok-4p3-0430-v2-s320-memory',
            message: 'Complete this script.',
            create_time: { $date: { $numberLong: '1784102400000' } },
          },
          share_link: null,
        },
        {
          /** An aborted generation with a child: skipped, child re-parented. */
          response: {
            _id: 't2',
            sender: 'ASSISTANT',
            model: 'grok-4-1-non-thinking-w-tool',
            parent_response_id: 't1',
            message: '',
            partial: true,
            create_time: { $date: { $numberLong: '1784102410000' } },
          },
          share_link: null,
        },
        {
          response: {
            _id: 't3',
            sender: 'assistant',
            model: 'grok-4-mini-thinking-tahoe',
            parent_response_id: 't2',
            message: 'Here is the completed script.',
            create_time: { $date: { $numberLong: '1784102420000' } },
          },
          share_link: null,
        },
      ],
    },
  ],
  projects: [{ workspace_id: 'w-1', name: 'New Workspace' }],
  tasks: [],
  media_posts: [{ id: '0380cd07', media_type: 'image', original_prompt: 'a cat' }],
};

/** The export object on its own, as a bare `prod-grok-backend.json` upload. */
function bareGrokExport() {
  return Buffer.from(JSON.stringify(EXPORT));
}

/**
 * Minimal Grok export archive for route-level tests: the conversation file
 * nested under a per-export uuid, the two unrelated JSON files a real export
 * ships beside it, and one `media_posts` binary no conversation references.
 * @returns {Promise<string>} path to the written zip
 */
async function buildGrokExportZip() {
  const zip = new JSZip();

  zip.file(ENTRY_PATH, JSON.stringify(EXPORT));
  zip.file(
    `ttl/30d/export_data/${EXPORT_UUID}/prod-mc-auth-mgmt-api.json`,
    JSON.stringify({ accounts: [{ email: 'fixture@example.com' }] }),
  );
  zip.file(`ttl/30d/export_data/${EXPORT_UUID}/prod-mc-billing.json`, JSON.stringify({}));
  zip.file(ASSET_PATH, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-grok-route-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'grok-export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function cleanupGrokExportZips() {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { bareGrokExport, buildGrokExportZip, cleanupGrokExportZips, EXPORT };
