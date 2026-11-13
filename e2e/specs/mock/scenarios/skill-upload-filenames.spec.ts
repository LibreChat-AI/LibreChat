import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import { loginAdmin, restoreRuntimeFilters, setRuntimeFilters } from '../content-filters.helpers';

const authorization = (token: string) => ({ Authorization: `Bearer ${token}` });

test.describe('skill upload filenames', () => {
  test('a skill file uploaded with a non-Latin name keeps that name @scenario:skill-file-upload-keeps-non-latin-filename', async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const suffix = randomUUID().slice(0, 8);
    const created = await request.post('/api/skills', {
      headers: authorization(token),
      data: {
        name: `filename-skill-${suffix}`,
        description: 'Skill used to check uploaded filenames.',
        body: 'Use only safe deterministic content.',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { _id: skillId } = (await created.json()) as { _id: string };

    try {
      const filename = `Описание-日本語-${suffix}.md`;
      const relativePath = 'references/description.md';
      const uploaded = await request.post(`/api/skills/${skillId}/files`, {
        headers: authorization(token),
        multipart: {
          relativePath,
          file: { name: filename, mimeType: 'text/markdown', buffer: Buffer.from('content') },
        },
      });
      expect(uploaded.status(), await uploaded.text()).toBe(200);

      const stored = await request.get(
        `/api/skills/${skillId}/files/${encodeURIComponent(relativePath)}`,
        { headers: authorization(token) },
      );
      expect(stored.status(), await stored.text()).toBe(200);
      expect(await stored.json()).toMatchObject({ filename });
    } finally {
      await request.delete(`/api/skills/${skillId}`, { headers: authorization(token) });
    }
  });

  test('a file name filter blocks a skill import whose non-Latin name matches @scenario:skill-import-filter-matches-non-latin-filename', async ({
    request,
  }) => {
    const token = await loginAdmin(request);
    const suffix = randomUUID().slice(0, 8);
    await setRuntimeFilters(request, token, {
      skills: {
        pii: {
          fields: ['file_name'],
          starterPatterns: [],
          customPatterns: [
            {
              id: `e2e-filename-${suffix}`,
              label: 'E2E protected value',
              regex: `Секрет-${suffix}`,
            },
          ],
        },
      },
    });

    try {
      const imported = await request.post('/api/skills/import', {
        headers: authorization(token),
        multipart: {
          file: {
            name: `Секрет-${suffix}.md`,
            mimeType: 'text/markdown',
            buffer: Buffer.from(
              `---\nname: filtered-name-${suffix}\ndescription: Imported skill for the file name filter.\n---\n\nBody.\n`,
            ),
          },
        },
      });
      expect(imported.status(), await imported.text()).toBe(400);
      expect(await imported.json()).toMatchObject({ error: 'content_filter_block' });
    } finally {
      await restoreRuntimeFilters(request, token);
    }
  });
});
