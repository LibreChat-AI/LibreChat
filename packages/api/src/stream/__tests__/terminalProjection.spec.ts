import type { FinalEvent, ServerSentEvent, StreamEvent } from '~/types/events';
import type { ProjectedFinalEvent } from '../terminalProjection';
import { projectTerminalEvent } from '../terminalProjection';

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** `FinalMessageFields` carries an index signature, so nested collections read
 * back as `unknown`; these keep the assertions readable without `any`. */
const entries = (value: unknown): Array<Record<string, unknown>> =>
  (value ?? []) as Array<Record<string, unknown>>;
const filesOf = (message: unknown): Array<Record<string, unknown>> =>
  entries((message as { files?: unknown } | null | undefined)?.files);
const attachmentsOf = (message: unknown): Array<Record<string, unknown>> =>
  entries((message as { attachments?: unknown } | null | undefined)?.attachments);

/** A terminal event shaped like the one `request.js` builds, with the transient
 * prompt-building inputs still attached. */
/** Model-generated attachment body: authoritative output, must survive. */
const GENERATED_OUTPUT = 'row,value\n1,42\n';

function buildAttachmentHeavyFinal(bodyChars: number): FinalEvent {
  const body = 'D'.repeat(bodyChars);
  const base64 = 'A'.repeat(bodyChars);
  return {
    final: true,
    terminalStatus: 'complete',
    conversation: { conversationId: 'conv-1', title: 'Report' },
    title: 'Report',
    requestMessage: {
      messageId: 'um-1',
      parentMessageId: 'root',
      conversationId: 'conv-1',
      text: 'Summarize the attachment',
      sender: 'User',
      isCreatedByUser: true,
      fileContext: body,
      image_urls: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }],
      files: [
        {
          file_id: 'f-1',
          filename: 'report.pdf',
          filepath: '/uploads/report.pdf',
          type: 'application/pdf',
          text: body,
          _id: 'mongo-id',
          __v: 0,
        },
      ],
    },
    responseMessage: {
      messageId: 'rm-1',
      parentMessageId: 'um-1',
      conversationId: 'conv-1',
      sender: 'AI',
      isCreatedByUser: false,
      content: [{ type: 'text', text: 'The report concludes that latency improved.' }],
      attachments: [
        {
          file_id: 'a-1',
          filename: 'result.txt',
          filepath: '/out/result.txt',
          // Generated output that `TextAttachment` renders inline.
          text: GENERATED_OUTPUT,
          _id: 'mongo-id',
          __v: 0,
        },
      ],
    },
  };
}

describe('projectTerminalEvent', () => {
  describe('exclusion of transient prompt data', () => {
    it('excludes fileContext, image_urls and embedded file bodies', () => {
      const projected = projectTerminalEvent(buildAttachmentHeavyFinal(64));

      expect(projected.requestMessage).not.toHaveProperty('fileContext');
      expect(projected.requestMessage).not.toHaveProperty('image_urls');
      expect(filesOf(projected.requestMessage)[0]).not.toHaveProperty('text');
    });

    it('excludes storage bookkeeping from files and attachments alike', () => {
      const projected = projectTerminalEvent(buildAttachmentHeavyFinal(64));

      for (const entry of [
        filesOf(projected.requestMessage)[0],
        attachmentsOf(projected.responseMessage)[0],
      ]) {
        expect(entry).not.toHaveProperty('_id');
        expect(entry).not.toHaveProperty('__v');
      }
    });

    it('excludes transient fields from every runMessages entry', () => {
      const event: FinalEvent = {
        final: true,
        runMessages: [
          { messageId: 'r-1', text: 'kept', fileContext: 'X'.repeat(128) },
          {
            messageId: 'r-2',
            text: 'also kept',
            image_urls: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
            files: [{ file_id: 'f-2', filename: 'a.pdf', text: 'Y'.repeat(128) }],
          },
        ],
      };

      const projected = projectTerminalEvent(event);

      expect(projected.runMessages?.[0]).not.toHaveProperty('fileContext');
      expect(projected.runMessages?.[0]?.text).toBe('kept');
      expect(projected.runMessages?.[1]).not.toHaveProperty('image_urls');
      expect(projected.runMessages?.[1]?.text).toBe('also kept');
      expect(filesOf(projected.runMessages?.[1])[0]).not.toHaveProperty('text');
    });
  });

  describe('preservation of authoritative final state', () => {
    it('keeps legitimate message content and structured response content', () => {
      const projected = projectTerminalEvent(buildAttachmentHeavyFinal(64));

      expect(projected.requestMessage?.text).toBe('Summarize the attachment');
      expect(projected.responseMessage?.content).toEqual([
        { type: 'text', text: 'The report concludes that latency improved.' },
      ]);
    });

    it('keeps attachment references and display metadata needed to render FINAL', () => {
      const projected = projectTerminalEvent(buildAttachmentHeavyFinal(64));

      expect(filesOf(projected.requestMessage)[0]).toEqual({
        file_id: 'f-1',
        filename: 'report.pdf',
        filepath: '/uploads/report.pdf',
        type: 'application/pdf',
      });
      expect(attachmentsOf(projected.responseMessage)[0]).toEqual({
        file_id: 'a-1',
        filename: 'result.txt',
        filepath: '/out/result.txt',
        text: GENERATED_OUTPUT,
      });
    });

    it('keeps the terminal and reconciliation protocol fields', () => {
      const event: FinalEvent = {
        final: true,
        reconcile: true,
        reconcileReason: 'generation_replaced',
        terminalStatus: 'aborted',
        generationCreatedAt: 1234,
        aborted: true,
        earlyAbort: true,
        title: 'T',
        conversation: { conversationId: 'conv-1' },
        pendingSteers: [{ id: 's-1' } as never],
        error: { message: 'boom' },
        requestMessage: { messageId: 'um-1', fileContext: 'drop me' },
      };

      const projected = projectTerminalEvent(event);

      expect(projected).toMatchObject({
        final: true,
        reconcile: true,
        reconcileReason: 'generation_replaced',
        terminalStatus: 'aborted',
        generationCreatedAt: 1234,
        aborted: true,
        earlyAbort: true,
        title: 'T',
        conversation: { conversationId: 'conv-1' },
        error: { message: 'boom' },
      });
      expect(projected.pendingSteers).toEqual(event.pendingSteers);
      expect(projected.requestMessage).not.toHaveProperty('fileContext');
    });

    it('does not remove a legitimate text field from a message or content part', () => {
      const event: FinalEvent = {
        final: true,
        responseMessage: {
          messageId: 'rm-1',
          text: 'top level answer text',
          content: [{ type: 'text', text: { value: 'nested structured text' } }],
        },
      };

      const projected = projectTerminalEvent(event);

      expect(projected.responseMessage?.text).toBe('top level answer text');
      expect(projected.responseMessage?.content).toEqual([
        { type: 'text', text: { value: 'nested structured text' } },
      ]);
    });
  });

  /** Regression for the review finding that the `text` denylist was applied to
   * `attachments` as well as `files`. `attachments` are resolved
   * `artifactPromises` whose `text` the client renders, and
   * `useAttachmentPreviewSync` only re-fetches while `status === 'pending'`, so
   * excluding it blanks the preview irrecoverably. */
  describe('output attachment text is authoritative, not transient', () => {
    it('preserves generated attachment text while excluding prompt file bodies', () => {
      const promptBody = 'D'.repeat(256);
      const event: FinalEvent = {
        final: true,
        requestMessage: {
          messageId: 'um-1',
          files: [{ file_id: 'f-1', filename: 'report.pdf', text: promptBody }],
        },
        responseMessage: {
          messageId: 'rm-1',
          attachments: [
            { file_id: 'a-1', filename: 'out.csv', text: GENERATED_OUTPUT, status: 'ready' },
          ],
        },
      };

      const projected = projectTerminalEvent(event);

      expect(filesOf(projected.requestMessage)[0]).not.toHaveProperty('text');
      expect(attachmentsOf(projected.responseMessage)[0]).toMatchObject({
        text: GENERATED_OUTPUT,
        status: 'ready',
      });
      expect(JSON.stringify(projected)).not.toContain(promptBody);
    });

    it('preserves attachment text on a runMessages entry too', () => {
      const event: FinalEvent = {
        final: true,
        runMessages: [
          {
            messageId: 'r-1',
            fileContext: 'X'.repeat(128),
            attachments: [{ file_id: 'a-2', filename: 'a.txt', text: GENERATED_OUTPUT }],
          },
        ],
      };

      const projected = projectTerminalEvent(event);

      expect(projected.runMessages?.[0]).not.toHaveProperty('fileContext');
      expect(attachmentsOf(projected.runMessages?.[0])[0]).toMatchObject({
        text: GENERATED_OUTPUT,
      });
    });
  });

  describe('optional and null semantics', () => {
    it('preserves an explicit null message slot', () => {
      const event: FinalEvent = {
        final: true,
        earlyAbort: true,
        requestMessage: null,
        responseMessage: null,
      };

      const projected = projectTerminalEvent(event);

      expect(projected.requestMessage).toBeNull();
      expect(projected.responseMessage).toBeNull();
    });

    it('leaves an absent slot absent rather than inventing it', () => {
      const projected = projectTerminalEvent({ final: true } as FinalEvent);

      expect('requestMessage' in projected).toBe(false);
      expect('responseMessage' in projected).toBe(false);
      expect('runMessages' in projected).toBe(false);
    });
  });

  /** Regression for the review finding that the declared return type was the
   * input type `T`, so the exported projected contract was never enforced: a
   * caller could still dereference an excluded field after projection. The
   * `@ts-expect-error` lines below are the assertion — if the projected type
   * stops excluding these, `tsc --noEmit` fails on the unused directive. */
  describe('the projected contract is enforced by the type system', () => {
    it('types an excluded field as statically absent, not as unknown data', () => {
      const projected = projectTerminalEvent(buildAttachmentHeavyFinal(32));

      /** `undefined`, not `unknown`: a caller cannot treat either field as
       * present data after projection. Annotating the exact type is the
       * assertion — widening it to `unknown` would still compile, so the narrow
       * annotation is what pins the contract. */
      const fileContext: undefined = projected.requestMessage?.fileContext;
      const imageUrls: undefined = projected.requestMessage?.image_urls;

      expect(fileContext).toBeUndefined();
      expect(imageUrls).toBeUndefined();
    });

    it('refuses to construct a projected event that carries an excluded field', () => {
      const projected: ProjectedFinalEvent = {
        final: true,
        requestMessage: {
          messageId: 'um-1',
          // @ts-expect-error a transient field cannot pass through the boundary
          fileContext: 'must not compile',
        },
      };

      expect(projected.final).toBe(true);
    });

    it('keeps a non-terminal event at its exact input type', () => {
      const chunk: StreamEvent = { event: 'on_message_delta', data: { delta: 'hi' } };
      const projected: StreamEvent = projectTerminalEvent(chunk);

      expect(projected).toBe(chunk);
      expect(projected.event).toBe('on_message_delta');
    });
  });

  describe('input ownership and idempotence', () => {
    it('does not mutate the input event or its nested objects', () => {
      const event = buildAttachmentHeavyFinal(64);
      const snapshot = structuredClone(event);

      projectTerminalEvent(event);

      expect(event).toEqual(snapshot);
      expect(event.requestMessage).toHaveProperty('fileContext');
      expect(event.requestMessage).toHaveProperty('image_urls');
      expect(filesOf(event.requestMessage)[0]).toHaveProperty('text');
    });

    it('is idempotent', () => {
      const once = projectTerminalEvent(buildAttachmentHeavyFinal(64));
      const twice = projectTerminalEvent(once);

      expect(twice).toEqual(once);
    });

    it('returns the identical reference for an already-safe event', () => {
      const safe: FinalEvent = {
        final: true,
        requestMessage: { messageId: 'um-1', text: 'clean', files: [{ file_id: 'f-1' }] },
        responseMessage: { messageId: 'rm-1', content: [{ type: 'text', text: 'answer' }] },
      };

      expect(projectTerminalEvent(safe)).toBe(safe);
    });

    it('returns non-terminal events unchanged', () => {
      const chunk: ServerSentEvent = { event: 'on_message_delta', data: { delta: 'x' } };
      const created: ServerSentEvent = {
        created: true,
        message: { messageId: 'um-1', sender: 'User', isCreatedByUser: true },
        streamId: 's-1',
      };

      expect(projectTerminalEvent(chunk)).toBe(chunk);
      expect(projectTerminalEvent(created)).toBe(created);
    });
  });

  describe('payload scaling', () => {
    it('does not scale with excluded attachment bodies', () => {
      const small = byteLength(projectTerminalEvent(buildAttachmentHeavyFinal(1_000)));
      const large = byteLength(projectTerminalEvent(buildAttachmentHeavyFinal(200_000)));

      expect(byteLength(buildAttachmentHeavyFinal(200_000))).toBeGreaterThan(400_000);
      expect(large).toBe(small);
    });

    it('does not truncate legitimate response content to satisfy a size bound', () => {
      const answer = 'Legitimate answer sentence. '.repeat(5_000);
      const event: FinalEvent = {
        final: true,
        requestMessage: { messageId: 'um-1', fileContext: 'D'.repeat(200_000) },
        responseMessage: { messageId: 'rm-1', content: [{ type: 'text', text: answer }] },
      };

      const projected = projectTerminalEvent(event);

      expect((projected.responseMessage?.content as Array<{ text: string }>)[0]?.text).toBe(answer);
      expect(byteLength(projected)).toBeGreaterThan(100_000);
    });
  });
});
