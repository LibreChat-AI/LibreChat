import fs from 'fs';
import os from 'os';
import path from 'path';

import JSZip from 'jszip';

import type { ChatGptConversation } from '~/import/types';

const CITE = '';

export const FIXTURE_ASSET_BYTES = 4;

const createdDirs: string[] = [];

const SHARD_ONE: ChatGptConversation[] = [
  {
    conversation_id: 'ext-cited',
    title: 'Amalfi trip',
    create_time: 1700000000,
    update_time: 1700000100,
    default_model_slug: 'gpt-5-thinking',
    is_archived: true,
    is_starred: false,
    pinned_time: null,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['t1'],
        message: {
          id: 'u1',
          author: { role: 'user', name: null },
          create_time: 1700000001,
          content: { content_type: 'text', parts: ['Where should I stay?'] },
        },
      },
      t1: {
        id: 't1',
        parent: 'u1',
        children: ['r1'],
        message: {
          id: 't1',
          author: { role: 'assistant', name: null },
          create_time: 1700000002,
          content: {
            content_type: 'thoughts',
            thoughts: [{ content: 'Comparing towns', summary: 'Towns' }],
          },
        },
      },
      r1: {
        id: 'r1',
        parent: 't1',
        children: ['a1'],
        message: {
          id: 'r1',
          author: { role: 'assistant', name: null },
          create_time: 1700000002,
          content: {
            content_type: 'reasoning_recap',
            content: 'Thought for 7 seconds',
          },
        },
      },
      a1: {
        id: 'a1',
        parent: 'r1',
        children: ['a2'],
        message: {
          id: 'a1',
          author: { role: 'assistant', name: null },
          create_time: 1700000003,
          content: {
            content_type: 'text',
            parts: [`Stay in Positano.${CITE}turn0search0`],
          },
          metadata: {
            model_slug: 'gpt-5-thinking',
            content_references: [
              {
                type: 'webpage',
                alt: null,
                url: 'https://earthtrekkers.com/amalfi',
                title: 'Amalfi Coast Itinerary',
                snippet: 'Plan your trip',
                attribution: null,
              },
            ],
          },
        },
      },
      a2: {
        id: 'a2',
        parent: 'a1',
        children: [],
        message: {
          id: 'a2',
          author: { role: 'assistant', name: null },
          create_time: 1700000004,
          content: {
            content_type: 'multimodal_text',
            parts: [
              'Here is the coastline.',
              {
                content_type: 'image_asset_pointer',
                asset_pointer: 'sediment://file_generated',
                width: 1024,
                height: 1536,
              },
            ],
          },
          metadata: { model_slug: 'gpt-5-thinking' },
        },
      },
    },
  },
];

const SHARD_TWO: ChatGptConversation[] = [
  {
    conversation_id: 'ext-media',
    title: 'Photo review',
    create_time: 1700001000,
    update_time: 1700001100,
    default_model_slug: 'gpt-4o',
    is_archived: false,
    is_starred: true,
    pinned_time: null,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        parent: 'root',
        children: ['u2'],
        message: {
          id: 'u1',
          author: { role: 'user', name: null },
          create_time: 1700001001,
          content: {
            content_type: 'multimodal_text',
            parts: [
              { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-one' },
              { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-two' },
              'compare these',
            ],
          },
          metadata: {
            attachments: [
              {
                id: 'file-one',
                name: 'first.jpg',
                mime_type: 'image/jpeg',
                size: 4,
                width: 768,
                height: 1560,
              },
              {
                id: 'file-two',
                name: 'second.jpg',
                mime_type: 'image/jpeg',
                size: 4,
                width: 1080,
                height: 2340,
              },
            ],
          },
        },
      },
      u2: {
        id: 'u2',
        parent: 'u1',
        children: [],
        message: {
          id: 'u2',
          author: { role: 'user', name: null },
          create_time: 1700001002,
          content: {
            content_type: 'multimodal_text',
            parts: [
              { content_type: 'audio_transcription', text: 'Allora iniziamo', direction: 'out' },
              { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_gone' },
            ],
          },
        },
      },
    },
  },
];

export interface FixtureOverrides {
  omitManifest?: boolean;
}

export async function buildFixtureExport(overrides: FixtureOverrides = {}): Promise<string> {
  const zip = new JSZip();

  zip.file('conversations-000.json', JSON.stringify(SHARD_ONE));
  zip.file('conversations-001.json', JSON.stringify(SHARD_TWO));
  zip.file(
    'conversation_asset_file_names.json',
    JSON.stringify({
      'file-one.dat': 'first.jpg',
      /** Real ChatGPT exports map many `.dat` entries to an original name
       * that also encodes the asset's nested conversation folder (e.g.
       * `<conversation-id>/audio/<file>.wav`), not a bare leaf name. This
       * entry mirrors that shape so every suite building on this fixture
       * exercises it. */
      'file-two.dat': '69a6e640-9640-8397-9003-84ae676527f2/images/second.jpg',
      'file-three.dat': 'orphan.jpg',
    }),
  );
  zip.file('file-one.dat', Buffer.from([1, 2, 3, 4]));
  zip.file('file-two.dat', Buffer.from([5, 6, 7, 8]));
  zip.file('file-three.dat', Buffer.from([9, 9, 9, 9]));
  /** Deliberately absent from the asset-name map and carrying no
   * extension, so its MIME type can only come from its magic bytes. */
  zip.file('file_generated.dat', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  zip.file('user.json', JSON.stringify({ email: 'fixture@example.com' }));

  if (!overrides.omitManifest) {
    zip.file(
      'export_manifest.json',
      JSON.stringify({
        version: 1,
        manifest_file: 'export_manifest.json',
        logical_files: {
          'conversations.json': {
            files: ['conversations-000.json', 'conversations-001.json'],
            sharded: true,
          },
        },
      }),
    );
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-fixture-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'chatgpt-export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

export function cleanupFixtureExport(): void {
  for (const dir of createdDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  createdDirs.length = 0;
}
