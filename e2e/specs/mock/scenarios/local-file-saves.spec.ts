import zlib from 'zlib';
import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { RequestResult } from '../content-filters.helpers';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { loginAdmin, requestResult } from '../content-filters.helpers';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { MOCK_ENDPOINTS } from '../helpers';

/**
 * Guards the async local file save path (uploads written without blocking the
 * event loop must still land on disk whole and be served byte for byte) and the
 * artifact edit closing-fence check (a fence longer than the opening one still
 * closes the code block, so an edit keeps the content and the closing fence).
 */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type JsonObject = Record<string, unknown>;

function expectSuccess(result: RequestResult, status?: number): void {
  expect(result.ok, result.text).toBe(true);
  if (status != null) {
    expect(result.status, result.text).toBe(status);
  }
}

function asObject(value: unknown): JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid RGB PNG with a gradient, so the encoded size is not trivially tiny. */
function buildPng(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = y * stride + 1 + x * 3;
      raw[offset] = (x * 255) / size;
      raw[offset + 1] = (y * 255) / size;
      raw[offset + 2] = ((x + y) * 255) / (2 * size);
    }
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function deleteUploadedFile(
  request: APIRequestContext,
  token: string,
  file: { file_id: string; filepath: string; source?: string },
): Promise<void> {
  const result = await requestResult(request, {
    path: '/api/files',
    token,
    method: 'DELETE',
    data: { files: [file] },
  });
  expect([200, 204], `file cleanup failed: ${result.text}`).toContain(result.status);
}

test('an uploaded document downloads byte identical @scenario:uploaded-document-downloads-byte-identical', async ({
  request,
}) => {
  const token = await loginAdmin(request);
  const buffer = Buffer.from(`E2E local save ${randomUUID()}\nsecond line ${randomUUID()}\n`);
  let uploaded: { file_id: string; filepath: string; source?: string } | undefined;
  try {
    const upload = await requestResult(request, {
      path: '/api/files',
      token,
      method: 'POST',
      multipart: {
        endpoint: MOCK_ENDPOINTS[0].label,
        endpointType: 'custom',
        message_file: 'true',
        file_id: randomUUID(),
        file: { name: `local-save-${randomUUID()}.txt`, mimeType: 'text/plain', buffer },
      },
    });
    expectSuccess(upload, 200);
    const body = asObject(upload.body);
    uploaded = {
      file_id: requireString(body.file_id, 'uploaded file id'),
      filepath: requireString(body.filepath, 'uploaded file path'),
      ...(typeof body.source === 'string' ? { source: body.source } : {}),
    };
    const userId = requireString(body.user, 'uploaded file owner');

    const download = await request.get(
      `/api/files/download/${encodeURIComponent(userId)}/${encodeURIComponent(uploaded.file_id)}`,
      { headers: { Authorization: `Bearer ${token}` }, failOnStatusCode: false },
    );
    expect(download.status(), await download.text()).toBe(200);
    const downloaded = await download.body();
    expect(downloaded.equals(buffer)).toBe(true);
  } finally {
    if (uploaded) {
      await deleteUploadedFile(request, token, uploaded);
    }
  }
});

test('an uploaded image serves the whole image @scenario:uploaded-image-serves-whole-image', async ({
  request,
}) => {
  const token = await loginAdmin(request);
  let uploaded: { file_id: string; filepath: string; source?: string } | undefined;
  try {
    const upload = await requestResult(request, {
      path: '/api/files/images',
      token,
      method: 'POST',
      multipart: {
        endpoint: MOCK_ENDPOINTS[0].label,
        endpointType: 'custom',
        message_file: 'true',
        file_id: randomUUID(),
        width: '96',
        height: '96',
        file: {
          name: `local-save-${randomUUID()}.png`,
          mimeType: 'image/png',
          buffer: buildPng(96),
        },
      },
    });
    expectSuccess(upload, 200);
    const body = asObject(upload.body);
    uploaded = {
      file_id: requireString(body.file_id, 'uploaded image id'),
      filepath: requireString(body.filepath, 'uploaded image path'),
      ...(typeof body.source === 'string' ? { source: body.source } : {}),
    };

    const image = await request.get(uploaded.filepath, {
      headers: { Authorization: `Bearer ${token}` },
      failOnStatusCode: false,
    });
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toMatch(/^image\//);
    const bytes = await image.body();
    expect(bytes.length).toBeGreaterThan(PNG_SIGNATURE.length);
    /* imageOutputType defaults to png, which the e2e config does not override. */
    expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)).toBe(true);
    if (typeof body.bytes === 'number') {
      expect(bytes.length).toBe(body.bytes);
    }
  } finally {
    if (uploaded) {
      await deleteUploadedFile(request, token, uploaded);
    }
  }
});

test('an artifact edit keeps a closing fence longer than the opening one @scenario:artifact-edit-keeps-longer-closing-fence', async ({
  request,
}) => {
  const token = await loginAdmin(request);
  const { email } = getPrimaryE2EUser();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const body = ['first line', '~~~', 'edit-target', 'last line'].join('\n');
  const text = `:::artifact{identifier="fence" type="text/markdown" title="Fence"}\n\`\`\`md\n${body}\n\`\`\`\`\n:::\n`;
  try {
    await seedConversations(email, [
      { conversationId, title: 'E2E closing fence', updatedAt: new Date() },
    ]);
    await seedMessages(email, conversationId, [
      {
        messageId,
        parentMessageId: NO_PARENT,
        text: '',
        isCreatedByUser: false,
        sender: 'Assistant',
        content: [{ type: 'text', text }],
      },
    ]);

    const save = await requestResult(request, {
      path: `/api/messages/artifact/${encodeURIComponent(messageId)}`,
      token,
      method: 'POST',
      data: { index: 0, original: 'edit-target', updated: 'edit-target (edited)' },
    });
    expectSuccess(save, 200);

    const read = await requestResult(request, {
      path: `/api/messages/${conversationId}/${messageId}`,
      token,
    });
    expectSuccess(read, 200);
    /* The route answers with the matching messages as an array. */
    const [stored] = read.body as Array<{ content?: Array<{ text?: string }> }>;
    const saved = stored?.content?.[0]?.text;
    const expected = text.replace('edit-target', 'edit-target (edited)');
    expect(saved).toBe(expected);
    expect(saved).toContain('last line\n````\n:::');
  } finally {
    await deleteMessagesByConversation([conversationId]);
    await deleteConversations([conversationId]);
  }
});
