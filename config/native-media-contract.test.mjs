import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(
  process.env.AGENTS_CONTRACT_PACKAGE_ROOT ??
    path.join(path.dirname(require.resolve('@librechat/agents')), '..', '..'),
);
const usage = { input_tokens: 11, output_tokens: 1290, total_tokens: 1301 };
const providerParts = [
  { text: '', thoughtSignature: 'signed-empty' },
  { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
];

async function loadFormat(format) {
  const extension = format === 'cjs' ? 'cjs' : 'mjs';
  const load = (file) => {
    const target = path.join(packageRoot, 'dist', format, `${file}.${extension}`);
    return format === 'cjs' ? require(target) : import(pathToFileURL(target).href);
  };
  return {
    ...(await load('main')),
    ...(await load('llm/google/index')),
  };
}

async function invoke(model, mode, messages, options) {
  if (mode === 'invoke') return model.invoke(messages, options);
  if (mode === 'typed') return model.streamEvents(messages, options);
  let output;
  if (mode === 'legacy') {
    for await (const event of model.streamEvents(messages, {
      ...options,
      version: 'v2',
    })) {
      if (event.event === 'on_chat_model_end') output = event.data.output;
    }
    return output;
  }
  for await (const chunk of await model.stream(messages, options)) {
    output = output == null ? chunk : output.concat(chunk);
  }
  return output;
}

for (const format of ['cjs', 'esm']) {
  const sdk = await loadFormat(format);
  test(`${format}: public tracing lifecycle hides handler internals`, async () => {
    assert.equal(typeof sdk.traceModelInvocation, 'function');
    assert.equal(sdk.createLangfuseHandler, undefined);
    assert.equal(sdk.disposeLangfuseHandler, undefined);
    assert.equal(sdk.withLangfuseAttributes, undefined);
    let calls = 0;
    const result = await sdk.traceModelInvocation(
      {
        langfuse: { enabled: false },
        runId: 'contract',
        provider: 'fixture',
        model: 'fixture',
      },
      async () => {
        calls++;
        return 'result';
      },
    );
    assert.equal(result, 'result');
    assert.equal(calls, 1);
  });
  for (const mode of ['invoke', 'stream', 'legacy', 'typed']) {
    for (const scenario of ['admission', 'success', 'blocked', 'storage']) {
      test(`${format} ${mode}: ${scenario}`, async (t) => {
        const requests = [];
        t.mock.method(globalThis, 'fetch', async (input, init) => {
          const request = new Request(input, init);
          requests.push(JSON.parse(await request.text()));
          const response = {
            ...(scenario === 'blocked'
              ? { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }
              : {
                  candidates: [
                    {
                      index: 0,
                      content: { role: 'model', parts: providerParts },
                    },
                  ],
                }),
            usageMetadata: {
              promptTokenCount: 11,
              candidatesTokenCount: 1290,
              totalTokenCount: 1301,
            },
          };
          const streaming = request.url.includes(':streamGenerateContent');
          return new Response(
            streaming ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response),
            {
              headers: {
                'content-type': streaming ? 'text/event-stream' : 'application/json',
              },
            },
          );
        });
        const stored = new Map();
        const failures = [];
        const errors = [];
        let completions = 0;
        let modelEnds = 0;
        let restores = 0;
        const port = {
          start: async () => {
            if (scenario === 'admission') throw new Error('Admission denied');
            return { responseModalities: ['TEXT', 'IMAGE'] };
          },
          part: async ({ modelRunId, chunkIndex, partIndex, part }) => {
            if (scenario === 'storage') throw new Error('Storage unavailable');
            const continuationRef = `${modelRunId}/${chunkIndex}/${partIndex}`;
            stored.set(continuationRef, part);
            return part.kind === 'text'
              ? {
                  type: 'text',
                  text: part.text,
                  native_media: { continuationRef },
                }
              : {
                  type: 'image_file',
                  image_file: {
                    file_id: continuationRef,
                    filepath: '/fixture.png',
                    filename: 'fixture.png',
                    type: 'image/png',
                    bytes: 5,
                  },
                  native_media: { continuationRef },
                };
          },
          complete: async () => {
            completions++;
          },
          fail: async (failure) => {
            failures.push(failure);
          },
          restore: async () => {
            throw new Error('Expected batch restore');
          },
          restoreBatch: async ({ parts }) => {
            restores++;
            return parts.map(({ continuationRef }) => {
              assert.ok(stored.has(continuationRef));
              return stored.get(continuationRef);
            });
          },
        };
        const model = new sdk.CustomChatGoogleGenerativeAI({
          apiKey: 'synthetic-key',
          model: 'gemini-3-pro-image-preview',
          maxRetries: 0,
          _lc_stream_delay: 0,
          nativeMedia: port,
        });
        const options = {
          callbacks: [
            {
              handleLLMEnd: () => {
                modelEnds++;
              },
              handleLLMError: (error) => {
                errors.push(error);
              },
            },
          ],
        };
        const prompt = new sdk.HumanMessage('Draw');
        const run = () => invoke(model, mode, [prompt], options);
        if (scenario !== 'success') {
          await assert.rejects(run);
          assert.equal(completions, 0);
          assert.equal(modelEnds, 0);
          assert.equal(failures.length, 1);
          assert.equal(errors.length, 1);
          if (scenario === 'admission') {
            assert.equal(requests.length, 0);
            assert.equal(failures[0].usage, undefined);
            return;
          }
          assert.equal(requests.length, 1);
          assert.deepEqual(failures[0].usage, usage);
          assert.ok(errors[0] instanceof sdk.NativeMediaError);
          assert.deepEqual(errors[0].usage, usage);
          if (scenario === 'blocked') {
            assert.deepEqual(failures[0].providerOutcome, {
              kind: 'blocked',
              code: 'SAFETY',
            });
          }
          return;
        }
        const output = await run();
        assert.partialDeepStrictEqual(output.usage_metadata, usage);
        assert.ok(!JSON.stringify(output).includes('signed-empty'));
        assert.ok(!JSON.stringify(output).includes('aW1hZ2U='));
        await invoke(model, mode, [prompt, output, new sdk.HumanMessage('Refine')], options);
        assert.equal(completions, 2);
        assert.equal(modelEnds, 2);
        assert.equal(restores, 1);
        assert.equal(failures.length, 0);
        assert.equal(errors.length, 0);
        assert.deepEqual(requests[1].contents[1].parts, providerParts);
        assert.deepEqual(requests[0].generationConfig.responseModalities, ['TEXT', 'IMAGE']);
      });
    }
  }
}
