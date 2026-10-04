const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const createdDirs = [];

function conversation(id, title, createTime, extraNodes = {}) {
  return {
    conversation_id: id,
    title,
    create_time: createTime,
    update_time: createTime + 100,
    default_model_slug: 'gpt-4o',
    is_archived: id === 'ext-cited',
    is_starred: id === 'ext-media',
    pinned_time: null,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        parent: 'root',
        children: Object.keys(extraNodes),
        message: {
          id: 'u1',
          author: { role: 'user', name: null },
          create_time: createTime + 1,
          content: { content_type: 'text', parts: ['Where should I stay?'] },
        },
      },
      ...extraNodes,
    },
  };
}

/**
 * Minimal ChatGPT export archive for route-level tests: two shards, a
 * manifest, an asset name map, and three `.dat` entries of which the
 * conversations reference two.
 * @returns {Promise<string>} path to the written zip
 */
async function buildChatGptExportZip() {
  const zip = new JSZip();

  zip.file(
    'conversations-000.json',
    JSON.stringify([conversation('ext-cited', 'Amalfi trip', 1700000000)]),
  );
  zip.file(
    'conversations-001.json',
    JSON.stringify([
      conversation('ext-media', 'Photo review', 1700001000, {
        a1: {
          id: 'a1',
          parent: 'u1',
          children: [],
          message: {
            id: 'a1',
            author: { role: 'assistant', name: null },
            create_time: 1700001002,
            content: {
              content_type: 'multimodal_text',
              parts: [
                'Here you go.',
                { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-one' },
                { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file-two' },
              ],
            },
            metadata: { model_slug: 'gpt-4o' },
          },
        },
      }),
    ]),
  );
  zip.file(
    'conversation_asset_file_names.json',
    JSON.stringify({ 'file-one.dat': 'first.jpg', 'file-two.dat': 'second.jpg' }),
  );
  zip.file('file-one.dat', Buffer.from([1, 2, 3, 4]));
  zip.file('file-two.dat', Buffer.from([5, 6, 7, 8]));
  zip.file('file-three.dat', Buffer.from([9, 9, 9, 9]));
  zip.file(
    'export_manifest.json',
    JSON.stringify({
      version: 1,
      logical_files: {
        'conversations.json': {
          files: ['conversations-000.json', 'conversations-001.json'],
          sharded: true,
        },
      },
    }),
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-route-fixture-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'chatgpt-export.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * Export archive whose single conversation references one image and one audio
 * attachment, for tests that care about how each asset type is stored rather
 * than about sharding or manifests.
 * @returns {Promise<string>} path to the written zip
 */
async function buildMixedAssetExportZip() {
  const zip = new JSZip();

  zip.file(
    'conversations.json',
    JSON.stringify([
      conversation('ext-mixed', 'Trip notes', 1700002000, {
        a1: {
          id: 'a1',
          parent: 'u1',
          children: [],
          message: {
            id: 'a1',
            author: { role: 'assistant', name: null },
            create_time: 1700002002,
            content: {
              content_type: 'multimodal_text',
              parts: [
                'Here you go.',
                { content_type: 'image_asset_pointer', asset_pointer: 'file-service://asset-img' },
                { content_type: 'audio_asset_pointer', asset_pointer: 'file-service://asset-aud' },
              ],
            },
            metadata: { model_slug: 'gpt-4o' },
          },
        },
      }),
    ]),
  );
  zip.file(
    'conversation_asset_file_names.json',
    JSON.stringify({ 'asset-img.dat': 'photo.jpg', 'asset-aud.dat': 'voice.wav' }),
  );
  /** Real magic bytes: the importer classifies an asset as an image from the
   * content, not from the name or the export's declared mime type, so a
   * placeholder here would land the "image" on the document backend. */
  zip.file('asset-img.dat', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
  zip.file(
    'asset-aud.dat',
    Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]),
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-import-route-fixture-'));
  createdDirs.push(dir);
  const filepath = path.join(dir, 'chatgpt-mixed-assets.zip');
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function cleanupChatGptExportZips() {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  buildChatGptExportZip,
  buildMixedAssetExportZip,
  cleanupChatGptExportZips,
};
