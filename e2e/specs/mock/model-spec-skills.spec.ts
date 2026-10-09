import { expect, test } from '@playwright/test';
import { MongoClient, ObjectId } from 'mongodb';
import type { Page } from '@playwright/test';
import { applyRuntimeEnv } from '../../setup/runtimeEnv';
import {
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  requestJson,
  selectModelSpec,
  sendMessage,
} from './helpers';

const MODEL_SPEC_LABEL = 'E2E Skill Scope';
const ASSERTION_MARKER = 'E2E_ASSERT_SKILLS:';
const ASSERTION_FINAL_TEXT = 'E2E skill assertion passed';
const ACCESSIBLE_SKILL_NAME = 'e2e-model-spec-allowed';
const DEPLOYMENT_SKILL_NAME = 'e2e-deployment-skill';
const MISSING_SKILL_NAME = 'e2e-model-spec-missing';
const INACCESSIBLE_SKILL_NAME = 'e2e-model-spec-inaccessible';
const ALWAYS_APPLY_BODY_MARKER = 'E2E_ALWAYS_APPLY_BODY_MARKER';
const INACCESSIBLE_AUTHOR_ID = new ObjectId('64f000000000000000000001');
const SKILL_DESCRIPTION =
  'Use this skill to verify model-spec skill scoping and always-apply priming in mock e2e tests.';

type SkillSummary = {
  _id: string;
  name: string;
  description: string;
  version: number;
  alwaysApply?: boolean;
};

type SkillDetail = SkillSummary & {
  body: string;
};

function buildSkillBody(name: string) {
  return `---
name: ${name}
description: ${SKILL_DESCRIPTION}
alwaysApply: true
---

# ${name}

${ALWAYS_APPLY_BODY_MARKER}

This body should be injected as an always-apply skill prime.`;
}

async function findSkill(
  page: Page,
  skillName: string,
  token: string,
): Promise<SkillSummary | null> {
  const body = await fetchJson<{ skills?: SkillSummary[] }>(
    page,
    `/api/skills?search=${encodeURIComponent(skillName)}&limit=10`,
    token,
  );
  return body.skills?.find((skill) => skill.name === skillName) ?? null;
}

async function seedAccessibleSkill(page: Page, token: string): Promise<SkillDetail> {
  const body = buildSkillBody(ACCESSIBLE_SKILL_NAME);
  const payload = {
    name: ACCESSIBLE_SKILL_NAME,
    description: SKILL_DESCRIPTION,
    body,
  };
  const existing = await findSkill(page, ACCESSIBLE_SKILL_NAME, token);
  if (!existing) {
    return requestJson<SkillDetail>(page, {
      path: '/api/skills',
      token,
      method: 'POST',
      body: payload,
    });
  }

  const detail = await fetchJson<SkillDetail>(
    page,
    `/api/skills/${encodeURIComponent(existing._id)}`,
    token,
  );
  return requestJson<SkillDetail>(page, {
    path: `/api/skills/${encodeURIComponent(existing._id)}`,
    token,
    method: 'PATCH',
    body: {
      ...payload,
      expectedVersion: detail.version,
    },
  });
}

async function deleteAccessibleSkill(page: Page, token: string, skillId: string) {
  await requestJson<{ deleted: boolean }>(page, {
    path: `/api/skills/${encodeURIComponent(skillId)}`,
    token,
    method: 'DELETE',
  });
}

async function seedInaccessibleSkill(): Promise<string> {
  applyRuntimeEnv();
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI must be available for model-spec skill mock e2e tests');
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db();
    const skills = db.collection('skills');
    const aclEntries = db.collection('aclentries');
    const now = new Date();
    await skills.updateOne(
      {
        name: INACCESSIBLE_SKILL_NAME,
        author: INACCESSIBLE_AUTHOR_ID,
        tenantId: null,
      },
      {
        $set: {
          description: SKILL_DESCRIPTION,
          body: buildSkillBody(INACCESSIBLE_SKILL_NAME),
          authorName: 'Inaccessible E2E User',
          updatedAt: now,
        },
        $setOnInsert: {
          displayTitle: INACCESSIBLE_SKILL_NAME,
          frontmatter: {},
          disableModelInvocation: false,
          userInvocable: true,
          allowedTools: [],
          alwaysApply: true,
          source: 'inline',
          fileCount: 0,
          version: 1,
          createdAt: now,
        },
      },
      { upsert: true },
    );
    const skill = await skills.findOne({
      name: INACCESSIBLE_SKILL_NAME,
      author: INACCESSIBLE_AUTHOR_ID,
      tenantId: null,
    });
    if (skill?._id) {
      await aclEntries.deleteMany({ resourceType: 'skill', resourceId: skill._id });
      return skill._id.toString();
    }
    throw new Error(`Failed to seed inaccessible skill "${INACCESSIBLE_SKILL_NAME}"`);
  } finally {
    await client.close();
  }
}

async function deleteInaccessibleSkill(skillId: string) {
  applyRuntimeEnv();
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI must be available for model-spec skill mock e2e tests');
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  try {
    const db = client.db();
    const objectId = new ObjectId(skillId);
    await db.collection('aclentries').deleteMany({
      resourceType: 'skill',
      resourceId: objectId,
    });
    await db.collection('skills').deleteOne({ _id: objectId });
  } finally {
    await client.close();
  }
}

test.describe('model spec skills', () => {
  test('loads accessible configured skills and skips missing or inaccessible names', async ({
    page,
  }) => {
    test.setTimeout(120000);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);
    let accessibleSkillId: string | undefined;
    let inaccessibleSkillId: string | undefined;
    let testFailure: unknown;

    try {
      const skill = await seedAccessibleSkill(page, token);
      accessibleSkillId = skill._id;
      expect(skill.alwaysApply).toBe(true);
      inaccessibleSkillId = await seedInaccessibleSkill();

      await selectModelSpec(page, MODEL_SPEC_LABEL);
      const response = await sendMessage(
        page,
        [
          `${ASSERTION_MARKER}*${ACCESSIBLE_SKILL_NAME},*${DEPLOYMENT_SKILL_NAME},!${MISSING_SKILL_NAME},!${INACCESSIBLE_SKILL_NAME}`,
          'Verify model-spec skill scope and always-apply frontmatter.',
        ].join('\n'),
      );
      expect(response.ok()).toBeTruthy();

      await expect(
        page
          .getByTestId('messages-view')
          .getByText(`${ASSERTION_FINAL_TEXT}: ${ACCESSIBLE_SKILL_NAME}, ${DEPLOYMENT_SKILL_NAME}`),
      ).toBeVisible({ timeout: 30000 });
    } catch (error) {
      testFailure = error;
    } finally {
      const cleanupTasks: Promise<unknown>[] = [];
      if (accessibleSkillId) {
        cleanupTasks.push(deleteAccessibleSkill(page, token, accessibleSkillId));
      }
      if (inaccessibleSkillId) {
        cleanupTasks.push(deleteInaccessibleSkill(inaccessibleSkillId));
      }
      const cleanupResults = await Promise.allSettled(cleanupTasks);
      const cleanupFailures = cleanupResults
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (testFailure && cleanupFailures.length > 0) {
        testFailure = new AggregateError(
          [testFailure, ...cleanupFailures],
          'The model-spec skill assertion and fixture cleanup both failed',
        );
      } else if (cleanupFailures.length > 0) {
        testFailure = new AggregateError(
          cleanupFailures,
          'Model-spec skill fixture cleanup failed',
        );
      }
    }

    if (testFailure) {
      throw testFailure;
    }
  });
});
