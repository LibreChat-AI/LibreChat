import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from './helpers';

const DEPLOYMENT_SKILL_NAME = 'e2e-deployment-skill';
const DEPLOYMENT_SKILL_DESCRIPTION =
  'Use this deployment skill to verify shared skills load during Playwright startup.';

type RefreshTokenBody = {
  token?: string;
};

type SkillSummary = {
  _id: string;
  name: string;
  description: string;
  source?: string;
  sourceMetadata?: Record<string, unknown>;
  fileCount?: number;
  alwaysApply?: boolean;
  isPublic?: boolean;
};

type SkillDetail = SkillSummary & {
  body: string;
  frontmatter?: Record<string, unknown>;
};

type SkillFile = {
  _id: string;
  skillId: string;
  relativePath: string;
  file_id: string;
  filename: string;
  filepath: string;
  source: string;
  mimeType: string;
  bytes: number;
  category: string;
  isExecutable: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
  content?: string;
};

type SkillFileContent = Pick<
  SkillFile,
  'relativePath' | 'filename' | 'mimeType' | 'bytes' | 'content'
> & {
  isBinary?: boolean;
};

type ApiResult<T> = {
  ok: boolean;
  status: number;
  text: string;
  json: T | null;
};

async function getAccessToken(page: Page): Promise<string> {
  const result = await page.evaluate(async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: response.ok, status: response.status, text, json };
  });

  if (!result.ok) {
    throw new Error(
      `Expected /api/auth/refresh to return 2xx, got ${result.status}: ${result.text}`,
    );
  }

  const body = result.json as RefreshTokenBody | null;
  if (!body?.token) {
    throw new Error(`Expected /api/auth/refresh to return a token, got: ${result.text}`);
  }

  return body.token;
}

async function apiJson<T>(
  page: Page,
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  return page.evaluate(
    async ({ accessToken, body, method, urlPath }) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(urlPath, {
        method,
        credentials: 'include',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { ok: response.ok, status: response.status, text, json };
    },
    {
      accessToken: token,
      body: init.body,
      method: init.method,
      urlPath: path,
    },
  ) as Promise<ApiResult<T>>;
}

async function fetchJson<T>(page: Page, path: string, token: string): Promise<T> {
  const result = await apiJson<T>(page, path, token);
  if (!result.ok) {
    throw new Error(`Expected ${path} to return 2xx, got ${result.status}: ${result.text}`);
  }
  return result.json as T;
}

test.describe('deployment skills', () => {
  test('loads configured deployment skills for every authenticated user as read-only', async ({
    page,
  }) => {
    const fixture = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../fixtures/deployment-skills',
        DEPLOYMENT_SKILL_NAME,
        'guide.txt',
      ),
    );
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const token = await getAccessToken(page);

    const list = await fetchJson<{ skills?: SkillSummary[] }>(
      page,
      `/api/skills?search=${encodeURIComponent(DEPLOYMENT_SKILL_NAME)}&limit=10`,
      token,
    );
    const skill = list.skills?.find((item) => item.name === DEPLOYMENT_SKILL_NAME);
    expect(skill).toMatchObject({
      name: DEPLOYMENT_SKILL_NAME,
      description: DEPLOYMENT_SKILL_DESCRIPTION,
      source: 'deployment',
      sourceMetadata: { deployment: true },
      fileCount: 1,
      alwaysApply: true,
      isPublic: true,
    });

    const detail = await fetchJson<SkillDetail>(
      page,
      `/api/skills/${encodeURIComponent(skill!._id)}`,
      token,
    );
    expect(detail.body).toContain('E2E deployment skill loaded through Playwright');
    expect(detail.frontmatter).toMatchObject({
      name: DEPLOYMENT_SKILL_NAME,
      description: DEPLOYMENT_SKILL_DESCRIPTION,
      'always-apply': true,
    });

    const files = await fetchJson<{ files?: SkillFile[] }>(
      page,
      `/api/skills/${encodeURIComponent(skill!._id)}/files`,
      token,
    );
    expect(files.files).toHaveLength(1);
    expect(files.files?.[0]).toMatchObject({
      skillId: skill!._id,
      relativePath: 'guide.txt',
      filename: 'guide.txt',
      source: 'deployment',
      mimeType: 'text/plain',
      bytes: fixture.length,
      category: 'other',
      isExecutable: false,
    });
    expect(files.files?.[0]).not.toHaveProperty('content');

    const downloaded = await fetchJson<SkillFileContent>(
      page,
      `/api/skills/${encodeURIComponent(skill!._id)}/files/guide.txt`,
      token,
    );
    expect(downloaded).toMatchObject({
      relativePath: 'guide.txt',
      filename: 'guide.txt',
      mimeType: 'text/plain',
      bytes: fixture.length,
      isBinary: false,
      content: fixture.toString('utf8'),
    });

    const patch = await apiJson<{ message?: string }>(
      page,
      `/api/skills/${encodeURIComponent(skill!._id)}`,
      token,
      {
        method: 'PATCH',
        body: {
          description: 'Deployment skills should stay read-only.',
        },
      },
    );
    expect(patch.status).toBe(403);
    expect(patch.json).toMatchObject({ message: 'Deployment skills are read-only' });
  });
});
