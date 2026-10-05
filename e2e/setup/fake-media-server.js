const express = require('express');
const sharp = require('sharp');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const app = express();
app.use(express.json({ limit: '2mb' }));
let submissions = 0;
const videos = new Map();
app.get('/health', (_req, res) => res.send('ready'));
app.get('/counts', (_req, res) => res.json({ submissions }));
const nativeCompletions = new Map();

function waitForNativeCompletion(token, res) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (released) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      res.off('close', closed);
      nativeCompletions.delete(token);
      resolve(released);
    };
    const closed = () => finish(false);
    /** A failed browser must not leave the fixture stream or token alive. */
    const watchdog = setTimeout(() => {
      finish(false);
      res.destroy();
    }, 30_000);
    nativeCompletions.set(token, () => finish(true));
    res.once('close', closed);
  });
}

app.post('/__fixture/native/:token/complete', (req, res) => {
  const complete = nativeCompletions.get(req.params.token);
  if (!complete) return res.sendStatus(404);
  complete();
  res.sendStatus(200);
});

const nativeImage = sharp({
  create: {
    width: 320,
    height: 240,
    channels: 4,
    background: { r: 120, g: 80, b: 170, alpha: 1 },
  },
})
  .png()
  .toBuffer()
  .then((bytes) => bytes.toString('base64'));

app.post(
  /^\/v1beta\/models\/gemini-3-pro-image-preview:(streamGenerateContent|generateContent)$/,
  async (req, res) => {
    const text = (req.body.contents ?? [])
      .findLast((content) => content.role === 'user')
      ?.parts?.map((part) => part.text ?? '')
      .join('');
    const continuation = text?.includes('E2E_NATIVE_CONTINUATION:');
    const token = text?.match(
      /E2E_NATIVE_(?:MEDIA|CONTINUATION):([A-Za-z0-9_-]{1,128})(?:\s|$)/,
    )?.[1];
    if (
      req.headers['x-goog-api-key'] !== 'e2e-native-fixture' ||
      !token ||
      (!continuation && !text?.includes('E2E_NATIVE_MEDIA:')) ||
      !req.body.generationConfig?.responseModalities?.includes('IMAGE')
    ) {
      return res.status(400).json({ error: { message: 'Native fixture admission is missing' } });
    }
    const data = await nativeImage;
    if (continuation) {
      const restored = (req.body.contents ?? []).some((content) => {
        if (content.role !== 'model') return false;
        const parts = content.parts ?? [];
        return parts.some(
          (part, index) =>
            part.inlineData?.mimeType === 'image/png' &&
            part.inlineData.data === data &&
            part.thoughtSignature === 'e2e-private-image-signature' &&
            parts[index - 1]?.text === 'E2E native image begins' &&
            parts[index - 1]?.thoughtSignature === 'e2e-private-text-signature',
        );
      });
      if (!restored) {
        return res.status(400).json({
          error: { message: 'Native continuation did not restore ordered signed original bytes' },
        });
      }
    }
    const chunks = continuation
      ? [[{ text: 'E2E native continuation ready' }]]
      : [
          [{ text: 'E2E native image begins', thoughtSignature: 'e2e-private-text-signature' }],
          [
            {
              inlineData: { mimeType: 'image/png', data },
              thoughtSignature: 'e2e-private-image-signature',
            },
          ],
          [{ text: 'E2E native image ready' }],
        ];
    const response = (parts, complete) => ({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts },
          ...(complete ? { finishReason: 'STOP' } : {}),
        },
      ],
      ...(complete
        ? { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 5, totalTokenCount: 12 } }
        : {}),
    });
    if (req.params[0] === 'generateContent') {
      return res.json(response(chunks.flat(), true));
    }
    if (!continuation && nativeCompletions.has(token)) {
      return res.status(409).json({ error: { message: 'Native fixture token is already active' } });
    }
    const completion = continuation ? undefined : waitForNativeCompletion(token, res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    for (let index = 0; index < chunks.length; index++) {
      /** The browser releases completion after observing decoded image pixels and the stop control. */
      if (index === 2 && !(await completion)) return;
      if (res.destroyed) return;
      res.write(
        `data: ${JSON.stringify(response(chunks[index], index === chunks.length - 1))}\n\n`,
      );
    }
    res.end();
  },
);
app.post('/v1/videos', (_req, res) => {
  const id = `fixture-video-${++submissions}`;
  videos.set(id, 0);
  res.json({ id, status: 'queued', progress: 0 });
});
app.get('/v1/videos/:id', (req, res) => {
  if (!videos.has(req.params.id)) return res.sendStatus(404);
  const polls = videos.get(req.params.id) + 1;
  videos.set(req.params.id, polls);
  res.json({
    id: req.params.id,
    status: polls > 1 ? 'completed' : 'in_progress',
    progress: polls > 1 ? 100 : 50,
  });
});
app.get('/v1/videos/:id/content', (req, res) => {
  if (!videos.has(req.params.id)) return res.sendStatus(404);
  res.type('video/mp4').send(readFileSync(path.join(__dirname, '../fixtures/media-video.mp4')));
});
app.post('/v1/images/generations', async (req, res) => {
  submissions++;
  if (req.body.prompt?.includes('E2E_MEDIA_PROVIDER_REJECTION:')) {
    return res
      .status(400)
      .set('x-request-id', 'e2e-media-provider-rejection')
      .json({
        error: {
          code: 400,
          status: 'FAILED_PRECONDITION',
          message:
            'Async process failed with the following error: The task field is not supported.',
        },
      });
  }
  const bytes = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 4,
      background: { r: 80, g: 140, b: 170, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  res.json({ data: [{ b64_json: bytes.toString('base64') }] });
});
app.post('/v1/images/edits', async (_req, res) => {
  submissions++;
  const bytes = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 4,
      background: { r: 170, g: 110, b: 90, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  res.json({ data: [{ b64_json: bytes.toString('base64') }] });
});
const port = Number(process.env.E2E_MEDIA_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('E2E_MEDIA_PORT must be a valid TCP port');
}
app.listen(port, '127.0.0.1');
