import type { TSubmission } from '../src/types';
import { EModelEndpoint } from '../src/schemas';
import { EndpointURLs } from '../src/config';
import createPayload from '../src/createPayload';

const agentsChatRoot = EndpointURLs[EModelEndpoint.agents];

const makeSubmission = (endpoint: string): TSubmission =>
  ({
    conversation: { conversationId: 'convo-1', endpoint },
    userMessage: { text: 'hello' },
    endpointOption: { endpoint },
  }) as unknown as TSubmission;

describe('createPayload server URL', () => {
  it('builds the chat URL from a plain custom endpoint name', () => {
    const { server } = createPayload(makeSubmission('OpenRouter'));

    expect(server).toBe(`${agentsChatRoot}/OpenRouter`);
  });

  it('percent-encodes a slash so the name stays a single path segment', () => {
    /** A raw `/` would split into an extra path segment and miss the server's
     * `/:endpoint` route, which answers with a generic 404 "Endpoint not found"
     * (danny-avila/LibreChat#15270). */
    const { server } = createPayload(makeSubmission('Company/API'));

    expect(server).toBe(`${agentsChatRoot}/Company%2FAPI`);
    expect(server.slice(agentsChatRoot.length + 1)).not.toContain('/');
  });

  it('round-trips the encoded name back to the configured value', () => {
    const { server } = createPayload(makeSubmission('Company/API'));

    expect(decodeURIComponent(server.slice(agentsChatRoot.length + 1))).toBe('Company/API');
  });

  it('encodes other characters that are unsafe in a path segment', () => {
    const { server } = createPayload(makeSubmission('Team A?v=1#x'));

    expect(server).toBe(`${agentsChatRoot}/Team%20A%3Fv%3D1%23x`);
  });

  it('leaves the endpoint name itself untouched in the payload body', () => {
    const { payload } = createPayload(makeSubmission('Company/API'));

    expect(payload.endpoint).toBe('Company/API');
  });

  it('forwards the conversation-selected code workspace to agents', () => {
    const submission = makeSubmission('agents');
    submission.codeEnvironmentMode = 'attached';
    submission.codeWorkspaces = [{ environmentId: 'personal-vm', workspaceId: 'project-a' }];

    expect(createPayload(submission).payload.codeEnvironmentMode).toBe('attached');
    expect(createPayload(submission).payload.codeWorkspaces).toEqual([
      { environmentId: 'personal-vm', workspaceId: 'project-a' },
    ]);
  });

  it('does not touch the assistants URL, which carries no endpoint segment', () => {
    const { server } = createPayload(makeSubmission(EModelEndpoint.assistants));

    expect(server).toBe(EndpointURLs[EModelEndpoint.assistants]);
  });
});

describe('createPayload compaction', () => {
  const compactionSubmission = (compact: boolean): TSubmission =>
    ({
      conversation: { conversationId: 'convo-1', endpoint: 'openAI' },
      userMessage: { messageId: 'leaf', text: '' },
      endpointOption: { endpoint: 'openAI' },
      isRegenerate: true,
      ...(compact ? { compact: true } : {}),
    }) as unknown as TSubmission;

  it('sends a compaction as such, never as a regenerated user turn', () => {
    /** The regenerate shape is a client-side rendering choice (no new user
     *  bubble); the server keying off `isRegenerate` would rewrite the leaf
     *  as a user message. */
    const { payload } = createPayload(compactionSubmission(true));

    expect(payload.compact).toBe(true);
    expect(payload.isRegenerate).toBeUndefined();
    expect(payload.text).toBe('');
  });

  it('leaves an ordinary regenerate untouched', () => {
    const { payload } = createPayload(compactionSubmission(false));

    expect(payload.isRegenerate).toBe(true);
    expect('compact' in payload).toBe(false);
  });
});
