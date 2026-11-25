import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { RequestResult } from '../content-filters.helpers';
import {
  APPROVAL_REASON,
  APPROVAL_TOOL_ID,
  APPROVAL_PROMPT_MARKER,
  uniqueLabel,
  isResumeRequest,
  composerApprovalPanel,
  clearApprovalInvocations,
  createAndSelectApprovalAgent,
  expectApprovalInvocationCount,
} from '../approvals.helpers';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';
import { cleanupAgent, closeMobileDrawer } from '../agents.helpers';
import { loginAdmin, requestResult } from '../content-filters.helpers';
import { MOCK_ENDPOINTS, messagesView, sendMessage } from '../helpers';

/**
 * The mock profile enables `toolApproval.allowAlways`, but the approval probe is the
 * admin's `ask` rule and a programmatic hook's match. Both mean "always prompt", so the
 * choice must never be offered for it, and a client that asks to remember it anyway must
 * be refused without anything being stored on the conversation.
 */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const MCP_SERVER_TOOL_ID = 'sys__server__sys_mcp_e2e-memory';

interface PendingAction {
  actionId?: string;
  conversationId?: string;
  payload?: {
    type?: string;
    action_requests?: Array<{ tool_call_id?: string }>;
    review_configs?: Array<{ tool_call_id?: string; allow_always?: boolean }>;
  };
}

interface StatusResponse {
  status?: string;
  pendingAction?: PendingAction;
}

function expectStatus(result: RequestResult, status: number): void {
  expect(result.status, result.text).toBe(status);
}

async function createApprovalAgent(request: APIRequestContext, token: string): Promise<string> {
  const result = await requestResult(request, {
    path: '/api/agents',
    token,
    method: 'POST',
    data: {
      name: `E2E Allow Always ${randomUUID()}`,
      instructions: 'Use the requested approval probe tools and report their results.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: [MCP_SERVER_TOOL_ID, APPROVAL_TOOL_ID],
    },
  });
  expectStatus(result, 201);
  return (result.body as { id: string }).id;
}

async function startTurn(
  request: APIRequestContext,
  token: string,
  agentId: string,
  text: string,
): Promise<string> {
  const messageId = randomUUID();
  const result = await requestResult(request, {
    path: '/api/agents/chat/agents',
    token,
    method: 'POST',
    data: {
      text,
      sender: 'User',
      clientTimestamp: new Date().toISOString(),
      isCreatedByUser: true,
      parentMessageId: NO_PARENT,
      conversationId: 'new',
      clientRequestId: randomUUID(),
      messageId,
      responseMessageId: `${messageId}_response`,
      endpoint: 'agents',
      endpointType: 'agents',
      agent_id: agentId,
      files: [],
      isTemporary: false,
      isRegenerate: false,
      error: false,
    },
  });
  expectStatus(result, 200);
  return (result.body as { conversationId: string }).conversationId;
}

async function readStatus(
  request: APIRequestContext,
  token: string,
  conversationId: string,
): Promise<StatusResponse | null> {
  const result = await requestResult(request, {
    path: `/api/agents/chat/status/${encodeURIComponent(conversationId)}`,
    token,
  });
  if (result.status === 503) {
    return null;
  }
  expectStatus(result, 200);
  return result.body as StatusResponse;
}

async function waitForStatus(
  request: APIRequestContext,
  token: string,
  conversationId: string,
  status: string,
): Promise<StatusResponse> {
  let latest: StatusResponse | null = null;
  await expect
    .poll(
      async () => {
        latest = await readStatus(request, token, conversationId);
        return latest?.status ?? 'pending';
      },
      { timeout: 30000, intervals: [100, 250, 500, 1000] },
    )
    .toBe(status);
  return latest!;
}

async function resume(
  request: APIRequestContext,
  token: string,
  agentId: string,
  pending: PendingAction,
  scope?: 'session',
): Promise<RequestResult> {
  return requestResult(request, {
    path: '/api/agents/chat/resume',
    token,
    method: 'POST',
    data: {
      actionId: pending.actionId,
      agent_id: agentId,
      conversationId: pending.conversationId,
      endpoint: 'agents',
      endpointType: 'agents',
      decisions: (pending.payload?.action_requests ?? []).map((action) => ({
        tool_call_id: action.tool_call_id,
        decision: 'approve',
        ...(scope != null && { scope }),
      })),
    },
  });
}

async function storedAllows(conversationId: string): Promise<unknown> {
  return withMongo(async (db) => {
    const convo = await db.collection('conversations').findOne({ conversationId });
    return convo?.toolApprovalAllows ?? null;
  });
}

test.describe('remembered tool approvals', () => {
  test('a tool the admin always prompts for is not offered Always allow @scenario:always-allow-not-offered-for-admin-ask-tool', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    const value = `original-${label}`;
    let agentId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = await createAndSelectApprovalAgent(page);
      await closeMobileDrawer(page);
      await sendMessage(page, `${APPROVAL_PROMPT_MARKER}${label}`);
      await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

      const panel = composerApprovalPanel(page);
      await expect(panel).toBeVisible({ timeout: 30000 });
      await expect(panel).toContainText(APPROVAL_REASON);
      await expect(panel.getByRole('button', { name: 'Approve' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Always allow' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Always allow' })).toHaveCount(0);

      await panel.getByRole('button', { name: 'Approve' }).click();
      const [response] = await Promise.all([
        page.waitForResponse((candidate) => isResumeRequest(candidate.request())),
        panel.getByRole('button', { name: 'Continue', exact: true }).click(),
      ]);
      expect(response.status()).toBe(200);
      const body = response.request().postDataJSON() as {
        decisions?: Array<{ scope?: string }>;
      };
      expect(body.decisions?.every((decision) => decision.scope == null)).toBe(true);

      await expect(
        messagesView(page)
          .getByText(/^E2E approval outcomes:/)
          .last(),
      ).toBeVisible({ timeout: 30000 });
      await expectApprovalInvocationCount(value, 1);
    } finally {
      clearApprovalInvocations(value);
      await cleanupAgent(page, agentId);
    }
  });

  test('a request to remember a tool the pause did not offer is refused and nothing is stored @scenario:always-allow-unoffered-scope-refused', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const token = await loginAdmin(request);
    const label = uniqueLabel();
    const value = `original-${label}`;
    let agentId: string | undefined;
    let conversationId: string | undefined;
    clearApprovalInvocations(value);

    try {
      agentId = await createApprovalAgent(request, token);
      conversationId = await startTurn(
        request,
        token,
        agentId,
        `${APPROVAL_PROMPT_MARKER}${label}`,
      );
      const paused = await waitForStatus(request, token, conversationId, 'requires_action');
      const pending = paused.pendingAction!;
      expect(pending.payload?.type).toBe('tool_approval');
      expect(pending.payload?.review_configs?.length).toBeGreaterThan(0);
      expect(pending.payload?.review_configs?.some((config) => config.allow_always)).toBe(false);

      const forged = await resume(request, token, agentId, pending, 'session');
      expectStatus(forged, 403);
      expect(forged.body).toEqual(
        expect.objectContaining({ error: 'Decision not permitted for one or more tools' }),
      );
      expect(await storedAllows(conversationId)).toBeNull();
      await expectApprovalInvocationCount(value, 0);

      // The refusal does not consume the pause: a one-time approval still runs the tool.
      const approved = await resume(request, token, agentId, pending);
      expectStatus(approved, 200);
      await waitForStatus(request, token, conversationId, 'complete');
      await expectApprovalInvocationCount(value, 1);
      expect(await storedAllows(conversationId)).toBeNull();
    } finally {
      clearApprovalInvocations(value);
      if (agentId != null) {
        await requestResult(request, {
          path: `/api/agents/${encodeURIComponent(agentId)}`,
          token,
          method: 'DELETE',
        }).catch(() => undefined);
      }
      if (conversationId != null) {
        await deleteMessagesByConversation([conversationId]);
        await deleteConversations([conversationId]);
      }
    }
  });
});
