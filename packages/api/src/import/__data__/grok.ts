import fs from 'fs';
import os from 'os';
import path from 'path';

import JSZip from 'jszip';

import type { GrokResponse, GrokConversationMeta } from '~/import/types';

/** The per-export uuid directory a real Grok archive nests everything under. */
export const GROK_EXPORT_UUID = 'e618db0b-b890-4728-b3ec-ab25abeb068b';
export const GROK_ENTRY_PATH = `ttl/30d/export_data/${GROK_EXPORT_UUID}/prod-grok-backend.json`;
/** Real Grok archives write asset paths with a doubled separator after the
 * service name. Mirrored here so the archive layer is exercised on the same
 * entry names production sees. */
export const GROK_ASSET_PATH = `ttl/30d/export_data/${GROK_EXPORT_UUID}/prod-mc-asset-server//0380cd07-a199-4623-bcd8-5f42cc28a9be/content`;

const createdDirs: string[] = [];

/** The out-of-scope fields a real response carries beside `message`: reasoning
 * traces, search results, aborted-generation flags and an echo of the URLs
 * already present in the text. Included verbatim so every suite proves the
 * converter ignores them rather than tripping over them. */
interface GrokFixtureResponse extends GrokResponse {
  thinking_trace?: string;
  web_search_results?: { url: string; title: string }[];
  webpage_urls?: string[];
  partial?: boolean;
}

interface GrokFixtureEntry {
  conversation: GrokConversationMeta;
  responses: { response: GrokFixtureResponse; share_link: null }[];
}

function response(value: GrokFixtureResponse): { response: GrokFixtureResponse; share_link: null } {
  return { response: value, share_link: null };
}

const CONVERSATIONS: GrokFixtureEntry[] = [
  {
    conversation: {
      id: 'grok-branched',
      title: 'Amalfi trip planning',
      summary: '',
      starred: false,
      create_time: '2026-07-14T03:25:09.401949Z',
    },
    responses: [
      /** No `parent_response_id` at all: a real export omits the field on the
       * first response of every conversation. */
      response({
        _id: 'g1',
        sender: 'human',
        model: '',
        message: 'Where should I stay? https://earthtrekkers.com/amalfi',
        create_time: { $date: { $numberLong: '1783999510820' } },
        webpage_urls: ['https://earthtrekkers.com/amalfi'],
      }),
      response({
        _id: 'g2a',
        sender: 'ASSISTANT',
        model: 'grok-4-1-thinking-1129',
        parent_response_id: 'g1',
        message: 'Positano.',
        create_time: { $date: { $numberLong: '1783999520820' } },
        thinking_trace: '<xai:tool_usage_card>\n  <xai:tool_name>web_search</xai:tool_name>\n',
        partial: false,
      }),
      response({
        _id: 'g2b',
        sender: 'assistant',
        model: 'grok-3',
        parent_response_id: 'g1',
        message: 'Ravello.',
        create_time: { $date: { $numberLong: '1783999530820' } },
        web_search_results: [{ url: 'https://example.com/ravello', title: 'Ravello' }],
      }),
      /** A human turn carrying a real model slug, which a real export does on
       * 210 of its 386 human responses. */
      response({
        _id: 'g3',
        sender: 'human',
        model: 'grok-4-auto',
        parent_response_id: 'g2b',
        message: 'Why Ravello?',
        create_time: { $date: { $numberLong: '1783999540820' } },
      }),
      /** An assistant turn with a blank model and real text, the shape a real
       * export produces 149 times. */
      response({
        _id: 'g4',
        sender: 'ASSISTANT',
        model: '',
        parent_response_id: 'g3',
        message: 'Quieter, and the gardens.',
        create_time: { $date: { $numberLong: '1783999550820' } },
      }),
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
      response({
        _id: 't1',
        sender: 'human',
        model: 'grok-4p3-0430-v2-s320-memory',
        message: 'Complete this script.',
        create_time: { $date: { $numberLong: '1784102400000' } },
      }),
      /** An aborted generation: no text, but a child, so it must be skipped and
       * its child re-parented rather than orphaned. */
      response({
        _id: 't2',
        sender: 'ASSISTANT',
        model: 'grok-4-1-non-thinking-w-tool',
        parent_response_id: 't1',
        message: '',
        create_time: { $date: { $numberLong: '1784102410000' } },
        partial: true,
      }),
      response({
        _id: 't3',
        sender: 'assistant',
        model: 'grok-4-mini-thinking-tahoe',
        parent_response_id: 't2',
        message: 'Here is the completed script.',
        create_time: { $date: { $numberLong: '1784102420000' } },
      }),
      /** A retry of the opening prompt, rooted the same way: a genuine second
       * root rather than a lost link. */
      response({
        _id: 't4',
        sender: 'human',
        model: 'grok-420',
        message: 'Complete this script.',
        create_time: { $date: { $numberLong: '1784102430000' } },
      }),
      /** Extended JSON's relaxed form, the other encoding the spec allows. */
      response({
        _id: 't5',
        sender: 'ASSISTANT',
        model: 'grok-4',
        parent_response_id: 't4',
        message: 'Second attempt.',
        create_time: { $date: '2026-07-15T10:01:00.000Z' },
      }),
      /** A parent id matching no response, which a real export contains once. */
      response({
        _id: 't6',
        sender: 'assistant',
        model: 'grok-4-1-thinking-1108b',
        parent_response_id: 'missing-response',
        message: 'Orphaned follow-up.',
        create_time: { $date: { $numberLong: '1784102450000' } },
      }),
    ],
  },
];

/** The whole export object, including the keys that are out of scope. */
function grokExportPayload(): string {
  return JSON.stringify({
    conversations: CONVERSATIONS,
    projects: [{ workspace_id: 'w-1', name: 'New Workspace' }],
    tasks: [],
    media_posts: [
      {
        id: '0380cd07-a199-4623-bcd8-5f42cc28a9be',
        original_prompt: 'a cat',
        media_type: 'image',
        link: 'https://imagine.grok.com/0380cd07',
      },
    ],
  });
}

export interface GrokFixtureOverrides {
  /** Write the export as a bare `prod-grok-backend.json` upload instead of a
   * zip, the other shape a Grok export arrives in. */
  bare?: boolean;
}

export async function buildGrokFixtureExport(
  overrides: GrokFixtureOverrides = {},
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-grok-fixture-'));
  createdDirs.push(dir);

  if (overrides.bare) {
    const filepath = path.join(dir, 'prod-grok-backend.json');
    fs.writeFileSync(filepath, grokExportPayload());
    return filepath;
  }

  const zip = new JSZip();
  zip.file(GROK_ENTRY_PATH, grokExportPayload());
  /** Out of scope by the same decision the ChatGPT and Claude paths made:
   * present in the archive so detection has to ignore them, never imported.
   * The two sibling JSON files also make the lone-json fallback inapplicable,
   * so the conversation file has to be found by name. */
  zip.file(
    `ttl/30d/export_data/${GROK_EXPORT_UUID}/prod-mc-auth-mgmt-api.json`,
    JSON.stringify({ accounts: [{ email: 'fixture@example.com' }] }),
  );
  zip.file(
    `ttl/30d/export_data/${GROK_EXPORT_UUID}/prod-mc-billing.json`,
    JSON.stringify({ invoices: [] }),
  );
  zip.file(GROK_ASSET_PATH, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filepath = path.join(dir, 'grok-export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

export function cleanupGrokFixtureExport(): void {
  for (const dir of createdDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  createdDirs.length = 0;
}

export { CONVERSATIONS as GROK_FIXTURE_CONVERSATIONS };
