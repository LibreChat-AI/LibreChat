import JSZip from 'jszip';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { logger, createModels, createMethods } from '@librechat/data-schemas';
import type { AllMethods, ISkill } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ImportSkillDeps } from '../import';
import { createImportHandler } from '../import';

logger.silent = true;

/**
 * End-to-end coverage for #14208: the import handler wired to the REAL
 * `createSkill`, asserting the persisted document rather than the arguments a
 * mock received. `import.test.ts` pins the frontmatter bag the handler builds;
 * this pins the columns that bag actually produces, so the two halves of the
 * fix can't drift apart silently.
 */

type ImportRequest = Parameters<ReturnType<typeof createImportHandler>>[0];
type CapturedResponse = Response & { statusCode?: number; body?: unknown };

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let author: Types.ObjectId;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  author = new Types.ObjectId();
  await mongoose.connection.collection('skills').deleteMany({});
});

function captureResponse(): CapturedResponse {
  const res = {} as CapturedResponse;
  res.status = jest.fn((statusCode: number) => {
    res.statusCode = statusCode;
    return res;
  }) as CapturedResponse['status'];
  res.json = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as CapturedResponse['json'];
  return res;
}

function importDeps(): ImportSkillDeps {
  return {
    createSkill: methods.createSkill,
    getSkillById: methods.getSkillById,
    deleteSkill: methods.deleteSkill,
    upsertSkillFile: methods.upsertSkillFile,
    saveBuffer: jest.fn(async () => ({ filepath: '/tmp/skill-file', source: 'local' })),
    grantPermission: jest.fn(async () => undefined),
  };
}

function request(content: string | Buffer, originalname: string): ImportRequest {
  return {
    user: { id: author.toString(), _id: author, username: 'importer' },
    file: {
      originalname,
      buffer: typeof content === 'string' ? Buffer.from(content) : content,
    },
  } as unknown as ImportRequest;
}

async function zipped(skillMarkdown: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('SKILL.md', skillMarkdown);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function persisted(res: CapturedResponse): Promise<ISkill> {
  const created = res.body as ISkill & { _id: Types.ObjectId };
  const reloaded = await methods.getSkillById(created._id);
  if (!reloaded) {
    throw new Error('Imported skill was not persisted');
  }
  return reloaded;
}

/** Verbatim from the issue's reproduction steps. */
const REPORTED_SKILL_MD = [
  '---',
  'name: test-skill',
  'description: test',
  'always-apply: true',
  'user-invocable: false',
  'disable-model-invocation: true',
  '---',
  'Test body.',
].join('\n');

describe('POST /api/skills/import — invocation-mode frontmatter (#14208)', () => {
  it('persists all three invocation-mode flags from a markdown upload', async () => {
    const res = captureResponse();
    await createImportHandler(importDeps())(request(REPORTED_SKILL_MD, 'test-skill.md'), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const skill = await persisted(res);
    expect(skill.name).toBe('test-skill');
    expect(skill.alwaysApply).toBe(true);
    expect(skill.userInvocable).toBe(false);
    expect(skill.disableModelInvocation).toBe(true);
  });

  it('persists all three invocation-mode flags from an archive upload', async () => {
    const res = captureResponse();
    await createImportHandler(importDeps())(
      request(await zipped(REPORTED_SKILL_MD), 'test-skill.skill'),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const skill = await persisted(res);
    expect(skill.alwaysApply).toBe(true);
    expect(skill.userInvocable).toBe(false);
    expect(skill.disableModelInvocation).toBe(true);
  });

  it('leaves the schema defaults in place when the file declares no flags', async () => {
    const res = captureResponse();
    const markdown = '---\nname: plain-skill\ndescription: A skill with no flags.\n---\n\nbody';
    await createImportHandler(importDeps())(request(markdown, 'plain-skill.md'), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const skill = await persisted(res);
    expect(skill.alwaysApply).toBe(false);
    expect(skill.userInvocable).toBe(true);
    expect(skill.disableModelInvocation).toBe(false);
    expect(skill.allowedTools).toBeUndefined();
  });

  it('persists the allowedTools column declared by the uploaded file', async () => {
    const res = captureResponse();
    const markdown = [
      '---',
      'name: tooled-skill',
      'description: A skill declaring extra tools.',
      'allowed-tools:',
      '  - web_search',
      '  - file_search',
      '---',
      'body',
    ].join('\n');
    await createImportHandler(importDeps())(request(markdown, 'tooled-skill.md'), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const skill = await persisted(res);
    expect(skill.allowedTools).toEqual(['web_search', 'file_search']);
  });

  it('imports a file whose extra frontmatter would fail strict validation', async () => {
    const res = captureResponse();
    const markdown = [
      '---',
      'name: ecosystem-skill',
      'description: Authored for another skill ecosystem.',
      'icon: rocket',
      'version: 1.0',
      'user-invocable: false',
      '---',
      'body',
    ].join('\n');
    await createImportHandler(importDeps())(request(markdown, 'ecosystem-skill.md'), res);

    expect(res.status).toHaveBeenCalledWith(201);
    const skill = await persisted(res);
    expect(skill.userInvocable).toBe(false);
    expect(skill.frontmatter).toEqual({ 'user-invocable': false });
  });

  it('rejects a malformed flag value instead of persisting a skill at the default', async () => {
    const res = captureResponse();
    const markdown =
      '---\nname: broken-skill\ndescription: A skill with a bad flag.\nuser-invocable: yes\n---\n\nbody';
    await createImportHandler(importDeps())(request(markdown, 'broken-skill.md'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    await expect(
      mongoose.connection.collection('skills').countDocuments({ name: 'broken-skill' }),
    ).resolves.toBe(0);
  });
});
