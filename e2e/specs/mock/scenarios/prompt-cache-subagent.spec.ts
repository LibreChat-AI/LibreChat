import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { TMessage } from 'librechat-data-provider';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  requestJson,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { deleteConversations, deleteMessagesByConversation } from '../db';

const OPENAI_PROVIDER = 'openAI';
const OPENAI_MODEL = 'gpt-5.6';
const SUBAGENT_PROMPT_CACHE_MARKER = 'E2E_ASSERT_SUBAGENT_PROMPT_CACHE:';
const createdAgentIds: string[] = [];
const createdSkillIds: string[] = [];
const cleanupConversationIds: string[] = [];

type CreatedAgent = {
  id: string;
  name: string;
};

type SkillDetail = {
  _id: string;
  version: number;
};

type AgentOptions = {
  instructions: string;
  tools?: string[];
  skills?: string[];
  skills_enabled?: boolean;
  subagents?: {
    enabled: boolean;
    allowSelf: boolean;
    agent_ids: string[];
  };
};

async function createAgent(
  page: Page,
  token: string,
  name: string,
  options: AgentOptions,
): Promise<CreatedAgent> {
  const agent = await requestJson<CreatedAgent>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Prompt cache key subagent scenario fixture.',
      provider: OPENAI_PROVIDER,
      model: OPENAI_MODEL,
      model_parameters: {},
      ...options,
    },
  });
  createdAgentIds.push(agent.id);
  return agent;
}

async function selectAgent(page: Page, agentName: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await expect(async () => {
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agentName, exact: true }).click({ timeout: 5000 });
    await expect(form.getByLabel('Agent name')).toHaveValue(agentName, { timeout: 5000 });
  }).toPass({ timeout: 30000 });
  await form.getByRole('button', { name: 'Select Agent' }).click();
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
}

function persistedText(message: TMessage): string {
  if (message.text) {
    return message.text;
  }
  return (message.content ?? [])
    .map((part) => {
      if (part?.type !== 'text') {
        return '';
      }
      const text = (part as { text?: string | { value?: string } }).text;
      return typeof text === 'string' ? text : (text?.value ?? '');
    })
    .join('');
}

async function sendSubagentAssertion(
  page: Page,
  parentName: string,
  childId: string,
  label: string,
): Promise<{ parentKey: string; childKey: string }> {
  await selectAgent(page, parentName);
  const response = await sendMessageAndWaitForCompletion(
    page,
    `${SUBAGENT_PROMPT_CACHE_MARKER}${childId}:${label}\n${label}`,
    { timeout: 60000 },
  );
  expect(response.ok()).toBeTruthy();

  const conversationId = /\/c\/([^/?#]+)/.exec(page.url())?.[1];
  expect(conversationId, 'conversation should have a persisted id').toBeTruthy();
  cleanupConversationIds.push(conversationId as string);

  const token = await getAccessToken(page);
  const messages = await fetchJson<TMessage[]>(
    page,
    `/api/messages/${encodeURIComponent(conversationId as string)}`,
    token,
  );
  const assistantText = messages
    .filter((message) => message.isCreatedByUser === false)
    .map(persistedText)
    .join('\n');
  const parentKey = /PARENT_PROMPT_CACHE_KEY=([^\r\n]*)/.exec(assistantText)?.[1];
  const childKey = /CHILD_PROMPT_CACHE_KEY=([^\r\n]*)/.exec(assistantText)?.[1];
  expect(parentKey, 'assistant reply should report the parent prompt cache key').toBeDefined();
  expect(childKey, 'assistant reply should report the child prompt cache key').toBeDefined();
  return { parentKey: parentKey as string, childKey: childKey as string };
}

function alwaysApplySkillBody(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Prompt cache child skill.\nalwaysApply: true\n---\n\n# ${name}\n\n${body}`;
}

/** Skill names are validated as kebab-case, unlike agent names. */
const uniqueSkillName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

async function createInlineSkill(page: Page, token: string, name: string, body: string) {
  const skill = await requestJson<SkillDetail & { name: string }>(page, {
    path: '/api/skills',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Prompt cache child skill.',
      body: alwaysApplySkillBody(name, body),
    },
  });
  createdSkillIds.push(skill._id);
  return skill;
}

async function deleteSkill(page: Page, token: string, skillId: string): Promise<void> {
  await requestJson(page, {
    path: `/api/skills/${encodeURIComponent(skillId)}`,
    token,
    method: 'DELETE',
  });
}

test.afterEach(async ({ page }) => {
  const conversationIds = cleanupConversationIds.splice(0);
  if (conversationIds.length > 0) {
    try {
      await deleteMessagesByConversation(conversationIds);
    } finally {
      await deleteConversations(conversationIds);
    }
  }

  /**
   * A skipped projection never navigates, so the page has no origin to resolve
   * a token request against; only ask for one when there is something to clean.
   */
  const skillIds = createdSkillIds.splice(0).reverse();
  if (skillIds.length > 0) {
    const token = await getAccessToken(page);
    await Promise.all(skillIds.map((skillId) => deleteSkill(page, token, skillId)));
  }

  const agentIds = createdAgentIds.splice(0).reverse();
  await Promise.all(agentIds.map((agentId) => cleanupAgent(page, agentId)));
});

test.describe('subagent prompt cache key', () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    'Prompt cache key scenarios require desktop Agent Builder',
  );

  test('delegated child keys its own stable prefix @scenario:delegated-child-keys-its-own-stable-prefix', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const child = await createAgent(page, token, uniqueAgentName('E2E Prompt Cache Child'), {
      instructions: 'Use the child-specific stable instruction prefix.',
      tools: ['file_search'],
    });
    const parent = await createAgent(page, token, uniqueAgentName('E2E Prompt Cache Parent'), {
      instructions: 'Use the parent-specific stable instruction prefix.',
      tools: ['web_search'],
      subagents: {
        enabled: true,
        allowSelf: false,
        agent_ids: [child.id],
      },
    });

    const keys = await sendSubagentAssertion(page, parent.name, child.id, 'distinct-prefixes');
    expect(keys.parentKey).not.toBe('');
    expect(keys.parentKey).not.toBe('none');
    expect(keys.childKey).not.toBe('');
    expect(keys.childKey).not.toBe('none');
    expect(keys.childKey).not.toBe(keys.parentKey);
  });

  test('always-apply skill edit retires the child key @scenario:always-apply-skill-edit-retires-the-child-key', async ({
    page,
  }) => {
    test.setTimeout(120000);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    const skillName = uniqueSkillName('e2e-prompt-cache-skill');
    const skill = await createInlineSkill(page, token, skillName, 'Initial child skill body.');
    const child = await createAgent(page, token, uniqueAgentName('E2E Prompt Cache Skill Child'), {
      instructions: 'Use the child skill for this prompt cache scenario.',
      skills: [skill._id],
      skills_enabled: true,
      tools: ['file_search'],
    });
    const parent = await createAgent(
      page,
      token,
      uniqueAgentName('E2E Prompt Cache Skill Parent'),
      {
        instructions: 'Delegate the prompt cache skill scenario to the child.',
        tools: ['web_search'],
        subagents: {
          enabled: true,
          allowSelf: false,
          agent_ids: [child.id],
        },
      },
    );

    const before = await sendSubagentAssertion(page, parent.name, child.id, 'before-skill-edit');
    expect(before.childKey).not.toBe('');
    expect(before.childKey).not.toBe('none');

    const currentSkill = await fetchJson<SkillDetail>(
      page,
      `/api/skills/${encodeURIComponent(skill._id)}`,
      token,
    );
    await requestJson(page, {
      path: `/api/skills/${encodeURIComponent(skill._id)}`,
      token,
      method: 'PATCH',
      body: {
        name: skillName,
        description: 'Prompt cache child skill.',
        body: alwaysApplySkillBody(skillName, 'Materially different edited child skill body.'),
        expectedVersion: currentSkill.version,
      },
    });

    const after = await sendSubagentAssertion(page, parent.name, child.id, 'after-skill-edit');
    expect(after.childKey).not.toBe('');
    expect(after.childKey).not.toBe('none');
    expect(after.childKey).not.toBe(before.childKey);
  });
});
