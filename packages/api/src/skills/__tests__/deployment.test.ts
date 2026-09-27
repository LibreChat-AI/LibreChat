import fs from 'fs';
import os from 'os';
import path from 'path';
import { Types } from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { CodeEnvRef } from 'librechat-data-provider';
import type { DeploymentSkillBaseMethods } from '../deployment';
import {
  DEPLOYMENT_SKILLS_DIR_ENV,
  createDeploymentSkillMethods,
  getDeploymentSkillIds,
  initializeDeploymentSkills,
  loadDeploymentSkillsFromDirectory,
  mergeDeploymentSkillIds,
  resolveDeploymentSkillDirectory,
} from '../deployment';

const DESCRIPTION = 'Use this skill when the deployment needs a shared testing fixture.';

let tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deployment-skills-'));
  tempRoots.push(root);
  return root;
}

async function writeDeploymentSkill(
  root: string,
  options: {
    skillsDir?: string;
    folder?: string;
    name?: string;
    alwaysApply?: boolean;
    frontmatter?: string;
  } = {},
): Promise<string> {
  const skillsDir = options.skillsDir ?? 'skill';
  const folder = options.folder ?? options.name ?? 'analysis-kit';
  const name = options.name ?? folder;
  const skillDir = path.join(root, skillsDir, folder);
  await fs.promises.mkdir(path.join(skillDir, 'references'), { recursive: true });
  await fs.promises.mkdir(path.join(skillDir, 'assets'), { recursive: true });
  await fs.promises.writeFile(
    path.join(skillDir, 'SKILL.md'),
    options.frontmatter ??
      [
        '---',
        `name: ${name}`,
        `description: ${DESCRIPTION}`,
        'allowed-tools:',
        '  - execute_code',
        'disable-model-invocation: true',
        'user-invocable: false',
        `always-apply: ${options.alwaysApply === true ? 'true' : 'false'}`,
        '---',
        '',
        '# Analysis Kit',
        '',
        'Read references/guide.txt before answering.',
      ].join('\n'),
  );
  await fs.promises.writeFile(path.join(skillDir, 'references', 'guide.txt'), 'reference notes');
  await fs.promises.writeFile(path.join(skillDir, 'assets', 'pixel.bin'), Buffer.from([0, 1, 2]));
  return skillDir;
}

function encodeTestCursor(row: { _id: Types.ObjectId; updatedAt: Date }): string {
  return Buffer.from(
    JSON.stringify({
      updatedAt: row.updatedAt.toISOString(),
      _id: row._id.toString(),
    }),
  ).toString('base64');
}

afterEach(async () => {
  const emptyRoot = await makeTempRoot();
  await initializeDeploymentSkills({ projectRoot: emptyRoot, env: {} });
  await Promise.all(
    tempRoots.map((root) => fs.promises.rm(root, { recursive: true, force: true })),
  );
  tempRoots = [];
});

describe('resolveDeploymentSkillDirectory', () => {
  it('defaults to project root ./skill', () => {
    const root = path.join(os.tmpdir(), 'librechat-root');
    expect(resolveDeploymentSkillDirectory({ projectRoot: root, env: {} })).toEqual({
      directory: path.join(root, 'skill'),
      explicitlyConfigured: false,
    });
  });

  it('honors a relative DEPLOYMENT_SKILLS_DIR override', () => {
    const root = path.join(os.tmpdir(), 'librechat-root');
    const env = { [DEPLOYMENT_SKILLS_DIR_ENV]: 'config/skills' };
    expect(resolveDeploymentSkillDirectory({ projectRoot: root, env })).toEqual({
      directory: path.join(root, 'config', 'skills'),
      explicitlyConfigured: true,
    });
  });
});

describe('loadDeploymentSkillsFromDirectory', () => {
  it('treats a missing default directory as an empty deployment catalog', async () => {
    const root = await makeTempRoot();
    const registry = await loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), {
      projectRoot: root,
    });
    expect(registry.list()).toEqual([]);
  });

  it('fails startup validation when an explicitly configured directory is missing', async () => {
    const root = await makeTempRoot();
    await expect(
      loadDeploymentSkillsFromDirectory(path.join(root, 'missing-skills'), {
        projectRoot: root,
        explicitlyConfigured: true,
      }),
    ).rejects.toThrow(/Deployment skills directory not found/);
  });

  it('loads bundled skills and their files without touching the DB', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, { name: 'analysis-kit', alwaysApply: true });

    const registry = await loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), {
      projectRoot: root,
    });
    const [skill] = registry.list();

    expect(skill).toMatchObject({
      name: 'analysis-kit',
      description: DESCRIPTION,
      source: 'deployment',
      deployment: true,
      isPublic: true,
      alwaysApply: true,
      allowedTools: ['execute_code'],
      disableModelInvocation: true,
      userInvocable: false,
      authorName: 'Deployment',
      sourceMetadata: { deployment: true, directory: 'skill/analysis-kit' },
    });
    expect(skill.fileCount).toBe(2);
    expect(skill.files.map((file) => [file.relativePath, file.category])).toEqual([
      ['assets/pixel.bin', 'asset'],
      ['references/guide.txt', 'reference'],
    ]);
    expect(skill.files.find((file) => file.relativePath === 'references/guide.txt')).toMatchObject({
      source: 'deployment',
      content: 'reference notes',
      isBinary: false,
      mimeType: 'text/plain',
    });
    expect(skill.files.find((file) => file.relativePath === 'assets/pixel.bin')).toMatchObject({
      isBinary: true,
    });
  });

  it('loads a skill with an unrecognized frontmatter key and warns about it', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      name: 'unknown-key-frontmatter',
      frontmatter: [
        '---',
        'name: unknown-key-frontmatter',
        `description: ${DESCRIPTION}`,
        'unknown-key: nope',
        'references:',
        '  - references/guide.txt',
        '---',
        '',
        'Body',
      ].join('\n'),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    const registry = await loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), {
      projectRoot: root,
    });

    expect(registry.list().map((skill) => skill.name)).toEqual(['unknown-key-frontmatter']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('frontmatter.unknown-key'));
    warn.mockRestore();
  });

  it('canonicalizes recognized frontmatter key variants before deriving runtime fields', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      name: 'case-variant-frontmatter',
      frontmatter: [
        '---',
        'name: case-variant-frontmatter',
        `description: ${DESCRIPTION}`,
        'Allowed-Tools:',
        '  - execute_code',
        'User-Invocable: false',
        '---',
        '',
        'Body',
      ].join('\n'),
    });

    const registry = await loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), {
      projectRoot: root,
    });

    expect(registry.list()[0]).toMatchObject({
      allowedTools: ['execute_code'],
      userInvocable: false,
      frontmatter: {
        'allowed-tools': ['execute_code'],
        'user-invocable': false,
      },
    });
  });

  it('rejects case-colliding recognized frontmatter keys at startup', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      name: 'case-collision-frontmatter',
      frontmatter: [
        '---',
        'name: case-collision-frontmatter',
        `description: ${DESCRIPTION}`,
        'allowed-tools:',
        '  - read_file',
        'Allowed-Tools:',
        '  - execute_code',
        '---',
        '',
        'Body',
      ].join('\n'),
    });

    await expect(
      loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), { projectRoot: root }),
    ).rejects.toThrow(/both resolve to "allowed-tools"/);
  });

  it('rejects malformed SKILL.md frontmatter at startup', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      name: 'bad-frontmatter',
      frontmatter: [
        '---',
        'name: bad-frontmatter',
        `description: ${DESCRIPTION}`,
        'user-invocable: maybe',
        '---',
        '',
        'Body',
      ].join('\n'),
    });

    await expect(
      loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), { projectRoot: root }),
    ).rejects.toThrow(/frontmatter\.user-invocable/);
  });

  it('validates bundled file paths at startup', async () => {
    const root = await makeTempRoot();
    const skillDir = await writeDeploymentSkill(root, { name: 'bad-path' });
    await fs.promises.writeFile(path.join(skillDir, 'references', 'bad path.txt'), 'bad');

    await expect(
      loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), { projectRoot: root }),
    ).rejects.toThrow(/relativePath: Relative path contains invalid characters/);
  });

  it('rejects duplicate deployment skill names', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, { folder: 'one', name: 'duplicate-name' });
    await writeDeploymentSkill(root, { folder: 'two', name: 'duplicate-name' });

    await expect(
      loadDeploymentSkillsFromDirectory(path.join(root, 'skill'), { projectRoot: root }),
    ).rejects.toThrow(/Duplicate deployment skill name "duplicate-name"/);
  });
});

describe('createDeploymentSkillMethods', () => {
  it('merges deployment skills into read paths while stripping them from DB calls', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      skillsDir: 'config/skills',
      name: 'analysis-kit',
      alwaysApply: true,
    });
    await initializeDeploymentSkills({
      projectRoot: root,
      env: { [DEPLOYMENT_SKILLS_DIR_ENV]: 'config/skills' },
    });

    const deploymentId = getDeploymentSkillIds()[0];
    const dbId = new Types.ObjectId();
    const dbAuthor = new Types.ObjectId();
    const dbSkill = {
      _id: dbId,
      name: 'db-skill',
      description: 'A persisted skill.',
      body: 'persisted body',
      author: dbAuthor,
      version: 3,
      fileCount: 0,
      updatedAt: new Date(0),
    };
    const base: DeploymentSkillBaseMethods = {
      getSkillById: jest.fn(async (id) => (id.toString() === dbId.toString() ? dbSkill : null)),
      getSkillByName: jest.fn(async (name) => (name === dbSkill.name ? dbSkill : null)),
      listSkillsByAccess: jest.fn(async () => ({
        skills: [dbSkill],
        has_more: false,
        after: null,
      })),
      listAlwaysApplySkills: jest.fn(async () => ({
        skills: [{ _id: dbId, name: 'db-always', body: 'db always', author: dbAuthor }],
        has_more: false,
        after: null,
      })),
      listSkillFiles: jest.fn(async () => []),
      getSkillFileByPath: jest.fn(async () => null),
      updateSkillFileContent: jest.fn(async () => undefined),
      updateSkillFileCodeEnvIds: jest.fn(async (updates) => ({
        matchedCount: updates.length,
        modifiedCount: updates.length,
      })),
    };

    const methods = createDeploymentSkillMethods(base);
    const mergedIds = mergeDeploymentSkillIds([dbId]);

    expect(mergedIds.map((id) => id.toString())).toEqual([
      dbId.toString(),
      deploymentId.toString(),
    ]);

    const deploymentSkill = await methods.getSkillById(deploymentId);
    expect(deploymentSkill).toMatchObject({ name: 'analysis-kit', source: 'deployment' });
    expect(base.getSkillById).not.toHaveBeenCalled();

    const listed = await methods.listSkillsByAccess?.({
      accessibleIds: mergedIds,
      limit: 10,
    });
    expect(listed?.skills.map((skill) => skill.name).sort()).toEqual(['analysis-kit', 'db-skill']);
    expect(base.listSkillsByAccess).toHaveBeenCalledWith({
      accessibleIds: [dbId],
      limit: 10,
    });

    const alwaysApply = await methods.listAlwaysApplySkills?.({
      accessibleIds: mergedIds,
      limit: 10,
    });
    expect(alwaysApply?.skills.map((skill) => skill.name).sort()).toEqual([
      'analysis-kit',
      'db-always',
    ]);
    expect(base.listAlwaysApplySkills).toHaveBeenCalledWith({
      accessibleIds: [dbId],
      limit: 10,
    });

    const files = await methods.listSkillFiles?.(deploymentId);
    expect(files?.map((file) => file.relativePath).sort()).toEqual([
      'assets/pixel.bin',
      'references/guide.txt',
    ]);
    const guideFile = files?.find((file) => file.relativePath === 'references/guide.txt');
    expect(guideFile?._id).toBeInstanceOf(Types.ObjectId);
    expect(guideFile?.skillId.toString()).toBe(deploymentId.toString());
    expect(guideFile).toMatchObject({
      file_id: expect.any(String),
      filename: 'guide.txt',
      source: 'deployment',
      mimeType: 'text/plain',
      bytes: 'reference notes'.length,
      category: 'reference',
      isExecutable: false,
      author: expect.any(Types.ObjectId),
    });
    expect(guideFile?.createdAt.getTime()).toEqual(expect.any(Number));
    expect(guideFile?.updatedAt.getTime()).toEqual(expect.any(Number));
    expect(guideFile).not.toHaveProperty('content');
    expect(base.listSkillFiles).not.toHaveBeenCalled();

    await methods.updateSkillFileContent?.(deploymentId, 'references/guide.txt', {
      content: 'updated content',
      isBinary: false,
    });
    const updatedFile = await methods.getSkillFileByPath?.(deploymentId, 'references/guide.txt');
    expect(updatedFile?.content).toBe('updated content');
    expect(base.updateSkillFileContent).not.toHaveBeenCalled();
    await methods.updateSkillFileContent?.(
      dbId,
      'references/db.txt',
      { content: 'db text' },
      'db-revision',
    );
    expect(base.updateSkillFileContent).toHaveBeenCalledWith(
      dbId,
      'references/db.txt',
      { content: 'db text' },
      'db-revision',
    );

    const codeEnvRef: CodeEnvRef = {
      kind: 'skill',
      id: deploymentId.toString(),
      version: 1,
      storage_session_id: 'storage-session',
      file_id: 'file-id',
    };
    const updateResult = await methods.updateSkillFileCodeEnvIds?.([
      { skillId: deploymentId, relativePath: 'references/guide.txt', codeEnvRef },
      { skillId: dbId, relativePath: 'references/db.txt', codeEnvRef },
    ]);

    expect(updateResult).toEqual({ matchedCount: 1, modifiedCount: 1 });
    expect(base.updateSkillFileCodeEnvIds).toHaveBeenCalledWith([
      { skillId: dbId, relativePath: 'references/db.txt', codeEnvRef },
    ]);
    expect(
      (await methods.getSkillFileByPath?.(deploymentId, 'references/guide.txt'))?.codeEnvRef,
    ).toEqual(codeEnvRef);
  });

  it('lets deployment skills shadow persisted skills with the same name', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      skillsDir: 'config/skills',
      name: 'analysis-kit',
      alwaysApply: true,
    });
    await initializeDeploymentSkills({
      projectRoot: root,
      env: { [DEPLOYMENT_SKILLS_DIR_ENV]: 'config/skills' },
    });

    const deploymentId = getDeploymentSkillIds()[0];
    const dbId = new Types.ObjectId();
    const otherId = new Types.ObjectId();
    const dbAuthor = new Types.ObjectId();
    const shadowedSkill = {
      _id: dbId,
      name: 'analysis-kit',
      description: 'A persisted duplicate skill.',
      body: 'persisted duplicate body',
      author: dbAuthor,
      version: 9,
      fileCount: 0,
      updatedAt: new Date(Date.now() + 60_000),
    };
    const otherSkill = {
      _id: otherId,
      name: 'db-skill',
      description: 'A persisted non-duplicate skill.',
      body: 'persisted body',
      author: dbAuthor,
      version: 1,
      fileCount: 0,
      updatedAt: new Date(0),
    };
    const base: DeploymentSkillBaseMethods = {
      getSkillByName: jest.fn(async (name) => (name === shadowedSkill.name ? shadowedSkill : null)),
      listSkillsByAccess: jest.fn(async () => ({
        skills: [shadowedSkill, otherSkill],
        has_more: false,
        after: null,
      })),
      listAlwaysApplySkills: jest.fn(async () => ({
        skills: [
          {
            _id: dbId,
            name: shadowedSkill.name,
            body: shadowedSkill.body,
            author: dbAuthor,
            updatedAt: shadowedSkill.updatedAt,
          },
          {
            _id: otherId,
            name: 'db-always',
            body: 'db always',
            author: dbAuthor,
            updatedAt: otherSkill.updatedAt,
          },
        ],
        has_more: false,
        after: null,
      })),
    };

    const methods = createDeploymentSkillMethods(base);
    const mergedIds = mergeDeploymentSkillIds([dbId, otherId]);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    const byName = await methods.getSkillByName?.(shadowedSkill.name, mergedIds, {
      preferUserInvocable: true,
    });
    expect(byName).toMatchObject({
      _id: deploymentId,
      name: shadowedSkill.name,
      source: 'deployment',
    });
    expect(base.getSkillByName).not.toHaveBeenCalled();

    const listed = await methods.listSkillsByAccess?.({
      accessibleIds: mergedIds,
      limit: 10,
    });
    expect(listed?.skills.map((skill) => [skill.name, skill._id.toString()]).sort()).toEqual([
      ['analysis-kit', deploymentId.toString()],
      ['db-skill', otherId.toString()],
    ]);

    await methods.listSkillsByAccess?.({
      accessibleIds: mergedIds,
      limit: 10,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('persisted list skill row(s) shadowed'),
    );

    const alwaysApply = await methods.listAlwaysApplySkills?.({
      accessibleIds: mergedIds,
      limit: 10,
    });
    expect(alwaysApply?.skills.map((skill) => [skill.name, skill._id.toString()]).sort()).toEqual([
      ['analysis-kit', deploymentId.toString()],
      ['db-always', otherId.toString()],
    ]);

    await methods.listAlwaysApplySkills?.({
      accessibleIds: mergedIds,
      limit: 10,
    });
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('persisted always-apply skill row(s) shadowed'),
    );
    warnSpy.mockRestore();
  });

  it('preserves pagination when an always-apply DB page only contains shadowed skills', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      skillsDir: 'config/skills',
      name: 'analysis-kit',
      alwaysApply: false,
    });
    await initializeDeploymentSkills({
      projectRoot: root,
      env: { [DEPLOYMENT_SKILLS_DIR_ENV]: 'config/skills' },
    });

    const dbId = new Types.ObjectId();
    const nextId = new Types.ObjectId();
    const dbAuthor = new Types.ObjectId();
    const shadowedUpdatedAt = new Date('2026-01-02T00:00:00.000Z');
    const shadowedSkill = {
      _id: dbId,
      name: 'analysis-kit',
      body: 'persisted duplicate body',
      author: dbAuthor,
    };
    const nextSkill = {
      _id: nextId,
      name: 'db-next',
      body: 'next persisted body',
      author: dbAuthor,
    };
    const shadowedCursor = encodeTestCursor({ _id: dbId, updatedAt: shadowedUpdatedAt });
    const base: DeploymentSkillBaseMethods = {
      listAlwaysApplySkills: jest.fn(async (params) => {
        if (params.cursor) {
          return {
            skills: [nextSkill],
            has_more: false,
            after: null,
          };
        }
        return {
          skills: [shadowedSkill],
          has_more: true,
          after: shadowedCursor,
        };
      }),
    };

    const methods = createDeploymentSkillMethods(base);
    const mergedIds = mergeDeploymentSkillIds([dbId, nextId]);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    const first = await methods.listAlwaysApplySkills?.({
      accessibleIds: mergedIds,
      limit: 1,
    });
    expect(first?.skills).toEqual([]);
    expect(first?.has_more).toBe(true);
    expect(first?.after).toBe(shadowedCursor);

    const second = await methods.listAlwaysApplySkills?.({
      accessibleIds: mergedIds,
      limit: 1,
      cursor: first?.after,
    });
    expect(second?.skills.map((skill) => skill.name)).toEqual(['db-next']);
    expect(second?.has_more).toBe(false);
    expect(base.listAlwaysApplySkills).toHaveBeenNthCalledWith(2, {
      accessibleIds: [dbId, nextId],
      limit: 1,
      cursor: first?.after,
    });
    warnSpy.mockRestore();
  });

  it('waits to return older deployment rows until the DB page boundary advances', async () => {
    const root = await makeTempRoot();
    await writeDeploymentSkill(root, {
      skillsDir: 'config/skills',
      name: 'analysis-kit',
      alwaysApply: false,
    });
    await initializeDeploymentSkills({
      projectRoot: root,
      env: { [DEPLOYMENT_SKILLS_DIR_ENV]: 'config/skills' },
    });

    const hiddenId = new Types.ObjectId();
    const visibleId = new Types.ObjectId();
    const nextId = new Types.ObjectId();
    const dbAuthor = new Types.ObjectId();
    const hiddenSkill = {
      _id: hiddenId,
      name: 'analysis-kit',
      description: 'A persisted duplicate skill.',
      author: dbAuthor,
      version: 1,
      fileCount: 0,
      updatedAt: new Date('2026-12-03T00:00:00.000Z'),
    };
    const visibleSkill = {
      _id: visibleId,
      name: 'db-visible',
      description: 'A visible persisted skill.',
      author: dbAuthor,
      version: 1,
      fileCount: 0,
      updatedAt: new Date('2026-12-02T00:00:00.000Z'),
    };
    const nextSkill = {
      _id: nextId,
      name: 'db-next',
      description: 'The next persisted skill.',
      author: dbAuthor,
      version: 1,
      fileCount: 0,
      updatedAt: new Date('2026-12-01T00:00:00.000Z'),
    };
    const visibleCursor = encodeTestCursor({
      _id: visibleId,
      updatedAt: visibleSkill.updatedAt,
    });
    const base: DeploymentSkillBaseMethods = {
      listSkillsByAccess: jest.fn(async (params) => {
        if (params.cursor) {
          return {
            skills: [nextSkill],
            has_more: false,
            after: null,
          };
        }
        return {
          skills: [hiddenSkill, visibleSkill],
          has_more: true,
          after: visibleCursor,
        };
      }),
    };

    const methods = createDeploymentSkillMethods(base);
    const mergedIds = mergeDeploymentSkillIds([hiddenId, visibleId, nextId]);
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    const first = await methods.listSkillsByAccess?.({
      accessibleIds: mergedIds,
      limit: 2,
    });
    expect(first?.skills.map((skill) => skill.name)).toEqual(['db-visible']);
    expect(first?.has_more).toBe(true);
    expect(first?.after).toBe(visibleCursor);

    const second = await methods.listSkillsByAccess?.({
      accessibleIds: mergedIds,
      limit: 2,
      cursor: first?.after,
    });
    expect(second?.skills.map((skill) => skill.name)).toEqual(['db-next', 'analysis-kit']);
    expect(second?.has_more).toBe(false);
    warnSpy.mockRestore();
  });
});
