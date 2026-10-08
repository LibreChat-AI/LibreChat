import mongoose from 'mongoose';
import { logger, createModels } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  SKILL_BODY_MAX_LENGTH,
} from 'librechat-data-provider';
import {
  partitionIssues,
  validateSkillName,
  validateSkillDescription,
  validateSkillFrontmatter,
  getCanonicalSkillFrontmatterKey,
  normalizeSkillFrontmatterKeys,
  validateAlwaysApply,
  validateRelativePath,
  inferSkillFileCategory,
  filterExistingSkillIds,
  deriveStructuredFrontmatterFields,
} from './skill';
import { createAclEntryMethods } from './aclEntry';
import { createMethods } from './index';

logger.silent = true;

type LeanUser = {
  _id: mongoose.Types.ObjectId;
  name?: string;
  email: string;
  role?: string;
};

let Skill: mongoose.Model<unknown>;
let SkillFile: mongoose.Model<unknown>;
let AclEntry: mongoose.Model<unknown>;
let AccessRole: mongoose.Model<unknown>;
let User: mongoose.Model<unknown>;
let methods: ReturnType<typeof createMethods>;
let aclMethods: ReturnType<typeof createAclEntryMethods>;
let owner: LeanUser;
let other: LeanUser;

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  createModels(mongoose);
  Skill = mongoose.models.Skill;
  SkillFile = mongoose.models.SkillFile;
  AclEntry = mongoose.models.AclEntry;
  AccessRole = mongoose.models.AccessRole;
  User = mongoose.models.User;

  methods = createMethods(mongoose, {
    removeAllPermissions: async ({ resourceType, resourceId }) => {
      await AclEntry.deleteMany({ resourceType, resourceId });
    },
  });
  aclMethods = createAclEntryMethods(mongoose);

  await AccessRole.create({
    accessRoleId: AccessRoleIds.SKILL_OWNER,
    name: 'Owner',
    description: 'Full control over skills',
    resourceType: ResourceType.SKILL,
    permBits:
      PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
  });
  await AccessRole.create({
    accessRoleId: AccessRoleIds.SKILL_EDITOR,
    name: 'Editor',
    description: 'Can view and edit skills',
    resourceType: ResourceType.SKILL,
    permBits: PermissionBits.VIEW | PermissionBits.EDIT,
  });
  await AccessRole.create({
    accessRoleId: AccessRoleIds.SKILL_VIEWER,
    name: 'Viewer',
    description: 'Can view skills',
    resourceType: ResourceType.SKILL,
    permBits: PermissionBits.VIEW,
  });

  owner = (
    await User.create({
      name: 'Skill Owner',
      email: 'skill-owner@example.com',
      role: SystemRoles.USER,
    })
  ).toObject() as unknown as LeanUser;
  other = (
    await User.create({
      name: 'Other User',
      email: 'skill-other@example.com',
      role: SystemRoles.USER,
    })
  ).toObject() as unknown as LeanUser;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Skill.deleteMany({});
  await SkillFile.deleteMany({});
  await AclEntry.deleteMany({});
  await mongoose.models.Agent.deleteMany({});
});

function makeAgentDoc(skillIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: `agent_${new mongoose.Types.ObjectId().toString()}`,
    name: 'Allowlist Agent',
    provider: 'openai',
    model: 'gpt-4',
    author: owner._id,
    skills: skillIds,
    skills_enabled: true,
    ...overrides,
  };
}

async function grantOwner(resourceId: mongoose.Types.ObjectId | string) {
  const role = (await AccessRole.findOne({ accessRoleId: AccessRoleIds.SKILL_OWNER }).lean()) as {
    _id: mongoose.Types.ObjectId;
    permBits: number;
  } | null;
  if (!role) throw new Error('SKILL_OWNER role not seeded');
  return aclMethods.grantPermission(
    PrincipalType.USER,
    owner._id,
    ResourceType.SKILL,
    resourceId,
    role.permBits,
    owner._id,
    undefined,
    role._id,
  );
}

function makeSkillInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'demo-skill',
    description: 'A small demo skill used in tests.',
    body: '# Demo\n\nBody content',
    frontmatter: { name: 'demo-skill', description: 'A small demo skill used in tests.' },
    author: owner._id,
    authorName: owner.name ?? 'Skill Owner',
    ...overrides,
  };
}

describe('Skill schema indexes', () => {
  it('supports GitHub sync source metadata lookups', () => {
    const indexSpecs = Skill.schema.indexes().map(([fields]) => fields);

    expect(indexSpecs).toContainEqual({
      source: 1,
      'sourceMetadata.upstreamId': 1,
      tenantId: 1,
    });
    expect(indexSpecs).toContainEqual({
      source: 1,
      'sourceMetadata.sourceId': 1,
      tenantId: 1,
    });
  });
});

describe('skill validation helpers', () => {
  it('rejects names starting with reserved brand prefixes', () => {
    expect(validateSkillName('anthropic-helper').some((i) => i.code === 'RESERVED_PREFIX')).toBe(
      true,
    );
    expect(validateSkillName('claude-helper').some((i) => i.code === 'RESERVED_PREFIX')).toBe(true);
  });

  it('allows names that merely contain reserved words as substrings', () => {
    expect(validateSkillName('research-anthropic-helper')).toEqual([]);
    expect(validateSkillName('about-claude')).toEqual([]);
  });

  it('rejects reserved CLI command names', () => {
    for (const word of ['help', 'clear', 'compact', 'model', 'exit', 'quit', 'settings']) {
      expect(validateSkillName(word).some((i) => i.code === 'RESERVED_WORD')).toBe(true);
    }
  });

  it('rejects non-kebab-case names', () => {
    expect(validateSkillName('My Skill').some((i) => i.code === 'INVALID_FORMAT')).toBe(true);
    expect(validateSkillName('UPPER').some((i) => i.code === 'INVALID_FORMAT')).toBe(true);
  });

  it('rejects names longer than 64 chars', () => {
    const long = 'a'.repeat(65);
    expect(validateSkillName(long).some((i) => i.code === 'TOO_LONG')).toBe(true);
  });

  it('accepts valid kebab-case names', () => {
    expect(validateSkillName('my-skill-1')).toEqual([]);
  });

  it('requires description', () => {
    expect(validateSkillDescription('').some((i) => i.code === 'REQUIRED')).toBe(true);
    expect(validateSkillDescription('   ').some((i) => i.code === 'REQUIRED')).toBe(true);
  });

  it('rejects description over 1024 chars', () => {
    expect(validateSkillDescription('x'.repeat(1025)).some((i) => i.code === 'TOO_LONG')).toBe(
      true,
    );
  });

  it('emits a warning (not an error) for short descriptions', () => {
    const issues = validateSkillDescription('too short');
    const warnings = issues.filter((i) => i.severity === 'warning' && i.code === 'TOO_SHORT');
    const errors = issues.filter((i) => i.severity !== 'warning');
    expect(warnings.length).toBe(1);
    expect(errors.length).toBe(0);
  });

  it('does not warn for descriptions at or above the threshold', () => {
    expect(
      validateSkillDescription('This description is comfortably over the threshold length.'),
    ).toEqual([]);
  });

  it('rejects path traversal', () => {
    expect(validateRelativePath('../evil').some((i) => i.code === 'TRAVERSAL')).toBe(true);
    expect(validateRelativePath('scripts/../../etc').some((i) => i.code === 'TRAVERSAL')).toBe(
      true,
    );
  });

  it('rejects absolute paths', () => {
    expect(validateRelativePath('/abs/path').some((i) => i.code === 'ABSOLUTE_PATH')).toBe(true);
  });

  it('rejects SKILL.md explicitly', () => {
    expect(validateRelativePath('SKILL.md').some((i) => i.code === 'RESERVED')).toBe(true);
  });

  it('accepts well-formed relative paths', () => {
    expect(validateRelativePath('scripts/parse.sh')).toEqual([]);
    expect(validateRelativePath('references/schema.md')).toEqual([]);
  });

  it('infers category from top-level prefix', () => {
    expect(inferSkillFileCategory('scripts/parse.sh')).toBe('script');
    expect(inferSkillFileCategory('references/notes.md')).toBe('reference');
    expect(inferSkillFileCategory('assets/image.png')).toBe('asset');
    expect(inferSkillFileCategory('readme.txt')).toBe('other');
  });

  describe('validateSkillFrontmatter', () => {
    it('canonicalizes recognized keys without rewriting unknown keys', () => {
      expect(getCanonicalSkillFrontmatterKey('Allowed-Tools')).toBe('allowed-tools');
      expect(getCanonicalSkillFrontmatterKey('ALWAYSAPPLY')).toBe('alwaysApply');
      expect(getCanonicalSkillFrontmatterKey('customConfig')).toBeUndefined();
      expect(
        normalizeSkillFrontmatterKeys({
          'Allowed-Tools': ['execute_code'],
          customConfig: { mode: 'strict' },
        }),
      ).toEqual({
        frontmatter: {
          'allowed-tools': ['execute_code'],
          customConfig: { mode: 'strict' },
        },
      });
    });

    it('rejects case-colliding recognized keys', () => {
      const frontmatter = {
        'allowed-tools': ['read_file'],
        'Allowed-Tools': ['execute_code'],
      };

      expect(normalizeSkillFrontmatterKeys(frontmatter)).toEqual({
        error:
          'Recognized frontmatter keys "allowed-tools" and "Allowed-Tools" both resolve to "allowed-tools"',
      });
      expect(validateSkillFrontmatter(frontmatter)).toEqual([
        expect.objectContaining({ field: 'frontmatter', code: 'DUPLICATE_KEY' }),
      ]);
    });

    it('accepts an undefined or empty frontmatter', () => {
      expect(validateSkillFrontmatter(undefined)).toEqual([]);
      expect(validateSkillFrontmatter(null)).toEqual([]);
      expect(validateSkillFrontmatter({})).toEqual([]);
    });

    it('rejects non-object frontmatter', () => {
      expect(validateSkillFrontmatter('not an object').some((i) => i.code === 'INVALID_TYPE')).toBe(
        true,
      );
      expect(validateSkillFrontmatter([]).some((i) => i.code === 'INVALID_TYPE')).toBe(true);
    });

    it('warns about unknown keys instead of rejecting them', () => {
      const issues = validateSkillFrontmatter({ 'not-a-real-key': 'value' });
      expect(issues).toEqual([
        expect.objectContaining({
          field: 'frontmatter.not-a-real-key',
          code: 'UNKNOWN_KEY',
          severity: 'warning',
        }),
      ]);
      expect(partitionIssues(issues).errors).toEqual([]);
    });

    it('still bounds the value of an unknown key', () => {
      /* The key is tolerated, the payload is not: an unrecognized key is
         persisted, so it stays inside the same limits as every other key. */
      const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
      const issues = validateSkillFrontmatter({ 'not-a-real-key': deep });

      expect(issues.some((i) => i.code === 'UNKNOWN_KEY' && i.severity === 'warning')).toBe(true);
      expect(
        partitionIssues(issues).errors.some(
          (i) => i.code === 'INVALID_SHAPE' && i.field === 'frontmatter.not-a-real-key',
        ),
      ).toBe(true);
    });

    it('rejects non-plain object values under unknown keys', () => {
      const issues = validateSkillFrontmatter({ created: new Date('2026-08-11T00:00:00.000Z') });

      expect(issues.some((i) => i.code === 'UNKNOWN_KEY' && i.severity === 'warning')).toBe(true);
      expect(
        partitionIssues(issues).errors.some(
          (i) => i.code === 'INVALID_SHAPE' && i.field === 'frontmatter.created',
        ),
      ).toBe(true);
    });

    it('rejects NUL characters in unknown key names before persistence', () => {
      const issues = validateSkillFrontmatter({ ['custom\u0000key']: 'value' });

      expect(partitionIssues(issues).errors).toEqual([
        expect.objectContaining({
          field: 'frontmatter',
          code: 'INVALID_KEY',
        }),
      ]);
      expect(issues.some((i) => i.code === 'UNKNOWN_KEY')).toBe(false);
    });

    it('rejects object property names that Mongoose cannot persist at any depth', () => {
      for (const key of ['__proto__', 'constructor', 'prototype']) {
        const topLevel = validateSkillFrontmatter(Object.fromEntries([[key, 'value']]));
        const nested = validateSkillFrontmatter({
          metadata: Object.fromEntries([[key, 'value']]),
        });

        expect(partitionIssues(topLevel).errors).toEqual([
          expect.objectContaining({ field: 'frontmatter', code: 'INVALID_KEY' }),
        ]);
        expect(partitionIssues(nested).errors).toEqual([
          expect.objectContaining({ field: 'frontmatter.metadata', code: 'INVALID_KEY' }),
        ]);
      }
    });

    it('accepts the references key in every shape real SKILL.md files use', () => {
      expect(validateSkillFrontmatter({ references: ['workers', 'pages', 'd1'] })).toEqual([]);
      expect(validateSkillFrontmatter({ references: 'references/api.md' })).toEqual([]);
      expect(
        validateSkillFrontmatter({
          references: [{ path: 'references/api.md', description: 'API surface' }],
        }),
      ).toEqual([]);
      expect(
        validateSkillFrontmatter({ references: { workers: 'references/workers.md' } }),
      ).toEqual([]);
    });

    it('rejects a references value with excessive nesting', () => {
      const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
      expect(
        validateSkillFrontmatter({ references: deep }).some(
          (i) => i.code === 'INVALID_SHAPE' && i.field === 'frontmatter.references',
        ),
      ).toBe(true);
    });

    it('accepts known keys with correct types', () => {
      expect(
        validateSkillFrontmatter({
          name: 'demo-skill',
          description: 'A demo skill',
          'when-to-use': 'When the user needs a demo.',
          'allowed-tools': ['read', 'write'],
          'user-invocable': true,
          effort: 5,
          version: '1.0.0',
          license: 'MIT',
          compatibility: 'Requires GitHub MCP to access the repository content.',
          hooks: { 'pre-run': 'echo hi' },
          metadata: { owner: 'data-team' },
        }),
      ).toEqual([]);
    });

    it('accepts the spec-defined compatibility field as a string', () => {
      expect(
        validateSkillFrontmatter({
          compatibility: 'Designed for Claude Code (or similar products)',
        }),
      ).toEqual([]);
    });

    it('rejects a non-string compatibility field', () => {
      expect(
        validateSkillFrontmatter({ compatibility: ['a', 'b'] }).some(
          (i) => i.code === 'INVALID_TYPE',
        ),
      ).toBe(true);
    });

    it('rejects known keys with wrong types', () => {
      expect(
        validateSkillFrontmatter({ 'user-invocable': 'yes' }).some(
          (i) => i.code === 'INVALID_TYPE',
        ),
      ).toBe(true);
      expect(
        validateSkillFrontmatter({ 'allowed-tools': [1, 2, 3] }).some(
          (i) => i.code === 'INVALID_TYPE',
        ),
      ).toBe(true);
    });

    it('rejects hooks object with excessive nesting', () => {
      const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
      expect(
        validateSkillFrontmatter({ hooks: deep }).some((i) => i.code === 'INVALID_SHAPE'),
      ).toBe(true);
    });

    it('accepts always-apply as a boolean', () => {
      expect(validateSkillFrontmatter({ 'always-apply': true })).toEqual([]);
      expect(validateSkillFrontmatter({ 'always-apply': false })).toEqual([]);
      expect(validateSkillFrontmatter({ alwaysApply: true })).toEqual([]);
      expect(validateSkillFrontmatter({ alwaysApply: false })).toEqual([]);
    });

    it('rejects always-apply with non-boolean values', () => {
      expect(
        validateSkillFrontmatter({ 'always-apply': 'yes' }).some(
          (i) => i.code === 'INVALID_TYPE' && i.field === 'frontmatter.always-apply',
        ),
      ).toBe(true);
      expect(
        validateSkillFrontmatter({ 'always-apply': 1 }).some((i) => i.code === 'INVALID_TYPE'),
      ).toBe(true);
      expect(
        validateSkillFrontmatter({ alwaysApply: 'yes' }).some(
          (i) => i.code === 'INVALID_TYPE' && i.field === 'frontmatter.alwaysApply',
        ),
      ).toBe(true);
    });
  });

  describe('validateAlwaysApply', () => {
    it('accepts undefined and booleans (undefined = no change)', () => {
      expect(validateAlwaysApply(undefined)).toEqual([]);
      expect(validateAlwaysApply(true)).toEqual([]);
      expect(validateAlwaysApply(false)).toEqual([]);
    });

    it('rejects null (PATCH forwards any non-undefined value to $set, and null in a boolean column is an ambiguous state)', () => {
      expect(validateAlwaysApply(null).some((i) => i.code === 'INVALID_TYPE')).toBe(true);
    });

    it('rejects string payloads (defends against loosely-typed clients)', () => {
      expect(validateAlwaysApply('true').some((i) => i.code === 'INVALID_TYPE')).toBe(true);
      expect(validateAlwaysApply('false').some((i) => i.code === 'INVALID_TYPE')).toBe(true);
    });

    it('rejects numeric / object / array payloads', () => {
      expect(validateAlwaysApply(1).some((i) => i.code === 'INVALID_TYPE')).toBe(true);
      expect(validateAlwaysApply({}).some((i) => i.code === 'INVALID_TYPE')).toBe(true);
      expect(validateAlwaysApply([]).some((i) => i.code === 'INVALID_TYPE')).toBe(true);
    });
  });

  describe('deriveStructuredFrontmatterFields', () => {
    it('returns empty object for missing or non-object frontmatter', () => {
      expect(deriveStructuredFrontmatterFields(undefined)).toEqual({});
      expect(deriveStructuredFrontmatterFields(null as unknown as Record<string, unknown>)).toEqual(
        {},
      );
    });

    it('extracts disable-model-invocation only when explicitly boolean', () => {
      expect(deriveStructuredFrontmatterFields({ 'disable-model-invocation': true })).toEqual({
        disableModelInvocation: true,
      });
      expect(deriveStructuredFrontmatterFields({ 'disable-model-invocation': false })).toEqual({
        disableModelInvocation: false,
      });
      /* Non-boolean values are silently ignored — the validator already
         rejects them upstream with INVALID_TYPE, so deriving here would
         double-fire the failure. */
      expect(deriveStructuredFrontmatterFields({ 'disable-model-invocation': 'yes' })).toEqual({});
    });

    it('extracts user-invocable only when explicitly boolean', () => {
      expect(deriveStructuredFrontmatterFields({ 'user-invocable': true })).toEqual({
        userInvocable: true,
      });
      expect(deriveStructuredFrontmatterFields({ 'user-invocable': false })).toEqual({
        userInvocable: false,
      });
      /* Field absent → no override; downstream uses schema default of true. */
      expect(deriveStructuredFrontmatterFields({})).toEqual({});
    });

    it('normalizes a string allowed-tools to a one-element array', () => {
      expect(deriveStructuredFrontmatterFields({ 'allowed-tools': 'web_search' })).toEqual({
        allowedTools: ['web_search'],
      });
      /* Empty string → not extracted; an explicit empty array is the
         author's way to say "no extras". */
      expect(deriveStructuredFrontmatterFields({ 'allowed-tools': '' })).toEqual({});
      expect(deriveStructuredFrontmatterFields({ 'Allowed-Tools': 'execute_code' })).toEqual({
        allowedTools: ['execute_code'],
      });
    });

    it('passes through array allowed-tools, dropping non-string entries', () => {
      expect(
        deriveStructuredFrontmatterFields({
          'allowed-tools': ['execute_code', 'read_file', '', 42 as unknown as string, null],
        }),
      ).toEqual({ allowedTools: ['execute_code', 'read_file'] });
      expect(deriveStructuredFrontmatterFields({ 'allowed-tools': [] })).toEqual({
        allowedTools: [],
      });
    });

    it('combines all three fields when present together', () => {
      expect(
        deriveStructuredFrontmatterFields({
          'disable-model-invocation': true,
          'user-invocable': false,
          'allowed-tools': ['execute_code'],
        }),
      ).toEqual({
        disableModelInvocation: true,
        userInvocable: false,
        allowedTools: ['execute_code'],
      });
    });
  });
});

describe('Skill CRUD methods', () => {
  it('rejects an oversized body before scanning its frontmatter on create', async () => {
    const body = `---\nalways-apply: a${' '.repeat(SKILL_BODY_MAX_LENGTH)}b\n---`;

    await expect(methods.createSkill(makeSkillInput({ body }))).rejects.toMatchObject({
      code: 'SKILL_VALIDATION_FAILED',
      issues: [expect.objectContaining({ field: 'body', code: 'TOO_LONG' })],
    });
  });

  it('rejects an oversized body before scanning its frontmatter on update', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    const body = `---\nalways-apply: a${' '.repeat(SKILL_BODY_MAX_LENGTH)}b\n---`;

    await expect(
      methods.updateSkill({
        id: skill._id.toString(),
        expectedVersion: 1,
        update: { body },
      }),
    ).rejects.toMatchObject({
      code: 'SKILL_VALIDATION_FAILED',
      issues: [expect.objectContaining({ field: 'body', code: 'TOO_LONG' })],
    });
  });

  it('creates a skill with version 1 and default fileCount 0', async () => {
    const { skill, warnings } = await methods.createSkill(makeSkillInput());
    expect(skill.name).toBe('demo-skill');
    expect(skill.version).toBe(1);
    expect(skill.fileCount).toBe(0);
    expect(skill.source).toBe('inline');
    expect(skill.author.toString()).toBe(owner._id.toString());
    expect(warnings).toEqual([]);
  });

  it('emits a too-short warning when the description is under 20 chars', async () => {
    const { skill, warnings } = await methods.createSkill(
      makeSkillInput({ name: 'short-desc-skill', description: 'Too short.' }),
    );
    expect(skill._id).toBeDefined();
    expect(warnings).toEqual([
      expect.objectContaining({
        field: 'description',
        code: 'TOO_SHORT',
        severity: 'warning',
      }),
    ]);
  });

  it('creates the skill and warns when frontmatter carries an unknown key', async () => {
    /* One unrecognized key in one SKILL.md must not fail the skill: the GitHub
       sync runner marks the whole source failed on a validation error, so a
       stray key used to block every other skill in the repository. */
    const { skill, warnings } = await methods.createSkill(
      makeSkillInput({
        name: 'unknown-key-frontmatter',
        frontmatter: { name: 'unknown-key-frontmatter', 'bogus-key': 'nope' },
      }),
    );
    expect(skill._id).toBeDefined();
    expect(skill.frontmatter).toMatchObject({ 'bogus-key': 'nope' });
    expect(warnings).toEqual([
      expect.objectContaining({
        field: 'frontmatter.bogus-key',
        code: 'UNKNOWN_KEY',
        severity: 'warning',
      }),
    ]);
  });

  it('canonicalizes recognized frontmatter variants before persistence and derivation', async () => {
    const { skill, warnings } = await methods.createSkill(
      makeSkillInput({
        name: 'case-variant-frontmatter',
        frontmatter: {
          name: 'case-variant-frontmatter',
          'Allowed-Tools': ['execute_code'],
          'User-Invocable': false,
        },
      }),
    );

    expect(skill.frontmatter).toMatchObject({
      'allowed-tools': ['execute_code'],
      'user-invocable': false,
    });
    expect(skill.frontmatter).not.toHaveProperty('Allowed-Tools');
    expect(skill.allowedTools).toEqual(['execute_code']);
    expect(skill.userInvocable).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('rejects case-colliding recognized frontmatter keys', async () => {
    await expect(
      methods.createSkill(
        makeSkillInput({
          name: 'case-collision-frontmatter',
          frontmatter: {
            'allowed-tools': ['read_file'],
            'Allowed-Tools': ['execute_code'],
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
  });

  it('creates a skill whose frontmatter carries a references list', async () => {
    const { skill, warnings } = await methods.createSkill(
      makeSkillInput({
        name: 'references-frontmatter',
        frontmatter: {
          name: 'references-frontmatter',
          description: 'A small demo skill used in tests.',
          references: ['workers', 'pages', 'd1'],
        },
      }),
    );
    expect(skill.frontmatter).toMatchObject({ references: ['workers', 'pages', 'd1'] });
    expect(warnings).toEqual([]);
  });

  it('still rejects malformed frontmatter', async () => {
    await expect(
      methods.createSkill(
        makeSkillInput({
          name: 'malformed-frontmatter',
          frontmatter: { 'user-invocable': 'yes' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
    await expect(
      methods.createSkill(
        makeSkillInput({
          name: 'non-object-frontmatter',
          frontmatter: 'not an object',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
    await expect(
      methods.createSkill(
        makeSkillInput({
          name: 'deep-hooks-frontmatter',
          frontmatter: { hooks: { a: { b: { c: { d: { e: { f: 'too deep' } } } } } } },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
  });

  it('rejects names that start with reserved brand prefixes', async () => {
    await expect(
      methods.createSkill(makeSkillInput({ name: 'anthropic-helper' })),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
    await expect(
      methods.createSkill(makeSkillInput({ name: 'claude-helper' })),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
  });

  it('allows names that merely contain the reserved words as substrings', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'research-anthropic-helper' }),
    );
    expect(skill.name).toBe('research-anthropic-helper');
  });

  it('rejects reserved CLI command names', async () => {
    await expect(methods.createSkill(makeSkillInput({ name: 'help' }))).rejects.toMatchObject({
      code: 'SKILL_VALIDATION_FAILED',
    });
    await expect(methods.createSkill(makeSkillInput({ name: 'settings' }))).rejects.toMatchObject({
      code: 'SKILL_VALIDATION_FAILED',
    });
  });

  it('enforces name uniqueness per author', async () => {
    await methods.createSkill(makeSkillInput());
    await expect(methods.createSkill(makeSkillInput())).rejects.toBeDefined();
  });

  it('throws with validation issues on bad input', async () => {
    await expect(methods.createSkill(makeSkillInput({ name: 'BAD NAME' }))).rejects.toMatchObject({
      code: 'SKILL_VALIDATION_FAILED',
    });
  });

  it('optimistic concurrency — stale version returns conflict with current state', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    const id = skill._id.toString();
    const first = await methods.updateSkill({
      id,
      expectedVersion: 1,
      update: { description: 'First update description (long enough).' },
    });
    expect(first.status).toBe('updated');
    if (first.status === 'updated') {
      expect(first.skill.version).toBe(2);
    }

    const stale = await methods.updateSkill({
      id,
      expectedVersion: 1,
      update: { description: 'Second update description (long enough).' },
    });
    expect(stale.status).toBe('conflict');
    if (stale.status === 'conflict') {
      expect(stale.current.version).toBe(2);
      expect(stale.current.description).toBe('First update description (long enough).');
    }
  });

  it('deleteSkill cascades ACL entries and skill files', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    await grantOwner(skill._id);
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-123',
      filename: 'parse.sh',
      filepath: '/tmp/parse.sh',
      source: 'local',
      mimeType: 'text/x-shellscript',
      bytes: 42,
      author: owner._id,
    });

    expect(await AclEntry.countDocuments({ resourceId: skill._id })).toBe(1);
    expect(await SkillFile.countDocuments({ skillId: skill._id })).toBe(1);

    const res = await methods.deleteSkill(skill._id.toString());
    expect(res.deleted).toBe(true);
    expect(await AclEntry.countDocuments({ resourceId: skill._id })).toBe(0);
    expect(await SkillFile.countDocuments({ skillId: skill._id })).toBe(0);
  });

  it('filterExistingSkillIds matches uppercase-hex candidates and returns canonical ids', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'case-skill' }));
    const canonical = skill._id.toString();

    const filtered = await filterExistingSkillIds(mongoose, [canonical.toUpperCase()]);
    expect(filtered).toEqual([canonical]);
  });

  it('deleteSkill remains retryable after skill file cleanup fails', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'flaky-files' }));
    const Agent = mongoose.models.Agent;
    const agent = await Agent.create(makeAgentDoc([skill._id.toString()]));

    const deleteManySpy = jest
      .spyOn(SkillFile, 'deleteMany')
      .mockRejectedValueOnce(new Error('transient storage failure'));
    try {
      const first = await methods.deleteSkill(skill._id.toString());
      expect(first).toEqual({
        deleted: true,
        skillAbsent: true,
        cleanupComplete: false,
        failedCleanupSteps: ['skill_files'],
      });

      const retry = await methods.deleteSkill(skill._id.toString());
      expect(retry).toEqual({
        deleted: false,
        skillAbsent: true,
        cleanupComplete: true,
        failedCleanupSteps: [],
      });
    } finally {
      deleteManySpy.mockRestore();
    }

    const agentAfter = (await Agent.findById(agent._id).lean()) as {
      skills?: string[];
      skills_enabled?: boolean;
    } | null;
    expect(agentAfter?.skills).toEqual([]);
    expect(agentAfter?.skills_enabled).toBe(false);
  });

  it('deleteSkill disables skills when the deleted id was the entire allowlist', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'only-skill' }));
    const Agent = mongoose.models.Agent;
    const agent = await Agent.create(makeAgentDoc([skill._id.toString()]));

    const res = await methods.deleteSkill(skill._id.toString().toUpperCase());
    expect(res.deleted).toBe(true);

    const agentAfter = (await Agent.findById(agent._id).lean()) as {
      skills?: string[];
      skills_enabled?: boolean;
    } | null;
    expect(agentAfter?.skills).toEqual([]);
    expect(agentAfter?.skills_enabled).toBe(false);
  });

  it('deleteSkill keeps skills enabled when the entire allowlist is deleted from an all-scoped agent', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'all-scoped-only-skill' }));
    const Agent = mongoose.models.Agent;
    const agent = await Agent.create(makeAgentDoc([skill._id.toString()], { skills_scope: 'all' }));

    const res = await methods.deleteSkill(skill._id.toString());
    expect(res.deleted).toBe(true);

    const agentAfter = (await Agent.findById(agent._id).lean()) as {
      skills?: string[];
      skills_enabled?: boolean;
      skills_scope?: string;
    } | null;
    expect(agentAfter?.skills).toEqual([]);
    expect(agentAfter?.skills_enabled).toBe(true);
    expect(agentAfter?.skills_scope).toBe('all');
  });

  it('deleteSkill keeps skills enabled when the entire allowlist is deleted from a selected-scoped agent', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'selected-scoped-only-skill' }),
    );
    const Agent = mongoose.models.Agent;
    const agent = await Agent.create(
      makeAgentDoc([skill._id.toString()], { skills_scope: 'selected' }),
    );

    const res = await methods.deleteSkill(skill._id.toString());
    expect(res.deleted).toBe(true);

    const agentAfter = (await Agent.findById(agent._id).lean()) as {
      skills?: string[];
      skills_enabled?: boolean;
      skills_scope?: string;
    } | null;
    expect(agentAfter?.skills).toEqual([]);
    expect(agentAfter?.skills_enabled).toBe(true);
    expect(agentAfter?.skills_scope).toBe('selected');
  });

  it('deleteSkill disables skills when the entire allowlist is deleted from a none-scoped agent', async () => {
    /** `skills_enabled: true` with `skills_scope: none` is a shape the API
     *  accepts. It renders as Off, and `skillDeps` reads the master flag on
     *  its own as permission to expose the authoring tools, so cleanup has to
     *  clear it rather than treat the explicit scope as an opt-out. */
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'none-scoped-only-skill' }));
    const Agent = mongoose.models.Agent;
    const agent = await Agent.create(
      makeAgentDoc([skill._id.toString()], { skills_scope: 'none' }),
    );

    const res = await methods.deleteSkill(skill._id.toString());
    expect(res.deleted).toBe(true);

    const agentAfter = (await Agent.findById(agent._id).lean()) as {
      skills?: string[];
      skills_enabled?: boolean;
      skills_scope?: string;
    } | null;
    expect(agentAfter?.skills).toEqual([]);
    expect(agentAfter?.skills_enabled).toBe(false);
    expect(agentAfter?.skills_scope).toBe('none');
  });

  it('deleteSkill prunes the deleted id from agent skill allowlists', async () => {
    const { skill: doomed } = await methods.createSkill(makeSkillInput({ name: 'doomed-skill' }));
    const { skill: kept } = await methods.createSkill(makeSkillInput({ name: 'kept-skill' }));
    const Agent = mongoose.models.Agent;
    const scoped = await Agent.create(makeAgentDoc([doomed._id.toString(), kept._id.toString()]));
    const untouched = await Agent.create(
      makeAgentDoc([kept._id.toString()], { name: 'Untouched Agent' }),
    );

    const res = await methods.deleteSkill(doomed._id.toString());
    expect(res.deleted).toBe(true);

    const scopedAfter = (await Agent.findById(scoped._id).lean()) as {
      skills?: string[];
      skills_enabled?: boolean;
    } | null;
    expect(scopedAfter?.skills).toEqual([kept._id.toString()]);
    expect(scopedAfter?.skills_enabled).toBe(true);

    const untouchedAfter = (await Agent.findById(untouched._id).lean()) as {
      skills?: string[];
    } | null;
    expect(untouchedAfter?.skills).toEqual([kept._id.toString()]);
  });

  it('findSkillBySourceIdentity searches only the requested tenant bucket', async () => {
    const upstreamId = 'librechat-skills:skills/research';
    const sourceMetadata = {
      provider: 'github',
      sourceId: 'librechat-skills',
      upstreamId,
    };
    const author = new mongoose.Types.ObjectId();
    const tenantSkill = await Skill.create({
      name: 'research',
      description: 'A tenant-scoped GitHub skill mirror.',
      body: 'tenant body',
      author,
      authorName: 'GitHub Sync',
      tenantId: 'tenant-a',
      source: 'github',
      sourceMetadata,
    });
    const ambientSkill = await Skill.create({
      name: 'research',
      description: 'An ambient GitHub skill mirror.',
      body: 'ambient body',
      author,
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata,
    });

    const ambientResult = await methods.findSkillBySourceIdentity({
      source: 'github',
      upstreamId,
    });
    const tenantResult = await methods.findSkillBySourceIdentity({
      source: 'github',
      upstreamId,
      tenantId: 'tenant-a',
    });

    expect(ambientResult?._id.toString()).toBe(ambientSkill._id.toString());
    expect(tenantResult?._id.toString()).toBe(tenantSkill._id.toString());
  });

  it('listSkillsByAccess returns only accessible skills and paginates by cursor', async () => {
    const ids: mongoose.Types.ObjectId[] = [];
    for (let i = 0; i < 3; i++) {
      const { skill } = await methods.createSkill(
        makeSkillInput({
          name: `demo-skill-${i}`,
          description: `A demo skill used to test pagination (${i}).`,
        }),
      );
      ids.push(skill._id);
      await new Promise((r) => setTimeout(r, 5));
    }

    const page1 = await methods.listSkillsByAccess({ accessibleIds: ids, limit: 2 });
    expect(page1.skills.length).toBe(2);
    expect(page1.has_more).toBe(true);
    expect(page1.after).not.toBeNull();

    const page2 = await methods.listSkillsByAccess({
      accessibleIds: ids,
      limit: 2,
      cursor: page1.after,
    });
    expect(page2.skills.length).toBe(1);
    expect(page2.has_more).toBe(false);
  });

  it('persists disableModelInvocation / userInvocable / allowedTools derived from frontmatter', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'frontmatter-derived',
        frontmatter: {
          name: 'frontmatter-derived',
          description: 'A demo skill used in tests.',
          'disable-model-invocation': true,
          'user-invocable': false,
          'allowed-tools': ['execute_code', 'read_file'],
        },
      }),
    );
    expect(skill.disableModelInvocation).toBe(true);
    expect(skill.userInvocable).toBe(false);
    expect(skill.allowedTools).toEqual(['execute_code', 'read_file']);

    /* Re-fetch via getSkillById to confirm the columns survive the round-trip
       (proving they're persisted, not just echoed in the create response). */
    const reloaded = await methods.getSkillById(skill._id);
    expect(reloaded?.disableModelInvocation).toBe(true);
    expect(reloaded?.userInvocable).toBe(false);
    expect(reloaded?.allowedTools).toEqual(['execute_code', 'read_file']);
  });

  it('defaults disableModelInvocation=false / userInvocable=true / allowedTools=undefined when frontmatter omits them', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'defaults' }));
    expect(skill.disableModelInvocation).toBe(false);
    expect(skill.userInvocable).toBe(true);
    expect(skill.allowedTools).toBeUndefined();
  });

  it('updateSkill re-derives the structured columns when frontmatter changes', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'mutating',
        frontmatter: {
          name: 'mutating',
          description: 'A demo skill used in tests.',
          'disable-model-invocation': true,
          'user-invocable': false,
          'allowed-tools': ['execute_code'],
        },
      }),
    );
    expect(skill.disableModelInvocation).toBe(true);

    const updated = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: 1,
      update: {
        frontmatter: {
          name: 'mutating',
          description: 'A demo skill used in tests.',
          /* Drops disable-model-invocation, allowed-tools; flips user-invocable. */
          'user-invocable': true,
        },
      },
    });
    expect(updated.status).toBe('updated');
    if (updated.status !== 'updated') return;
    /* Fields the new frontmatter omits are `$unset` so a re-fetch returns
       undefined. Functionally equivalent to the schema default for all three:
       runtime catalog filter checks `disableModelInvocation === true` (so
       undefined passes through), `resolveManualSkills` checks
       `userInvocable === false` (undefined passes through), and the tool-
       union helper treats undefined `allowedTools` as "no extras". */
    expect(updated.skill.disableModelInvocation).toBeUndefined();
    expect(updated.skill.userInvocable).toBe(true);
    expect(updated.skill.allowedTools).toBeUndefined();
  });

  it('backfills legacy skills from frontmatter when columns are unset (getSkillByName)', async () => {
    /* Simulate a pre-Phase-6 skill: it has `user-invocable` /
       `disable-model-invocation` / `allowed-tools` set in frontmatter
       but the structured columns were never populated (no migration). */
    const legacy = await Skill.create({
      name: 'legacy-skill',
      description: 'A legacy skill from before Phase 6.',
      body: 'body',
      frontmatter: {
        name: 'legacy-skill',
        description: 'A legacy skill from before Phase 6.',
        'disable-model-invocation': true,
        'user-invocable': false,
        'allowed-tools': ['execute_code'],
      },
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      version: 1,
      source: 'inline',
      fileCount: 0,
    });
    /* Strip the columns to simulate pre-Phase-6 state — `Skill.create`
       above would have run the new derive helper, so we explicitly unset
       to recreate the legacy shape. */
    await Skill.collection.updateOne(
      { _id: legacy._id },
      { $unset: { disableModelInvocation: '', userInvocable: '', allowedTools: '' } },
    );

    const fetched = await methods.getSkillByName('legacy-skill', [
      legacy._id as mongoose.Types.ObjectId,
    ]);
    /* Backfill must populate the columns from frontmatter so runtime
       gates fire correctly without a write migration. */
    expect(fetched?.disableModelInvocation).toBe(true);
    expect(fetched?.userInvocable).toBe(false);
    expect(fetched?.allowedTools).toEqual(['execute_code']);
  });

  it('getAuthorSkillByName resolves only the matching author and tenant', async () => {
    const sharedName = 'author-owned-lookup';
    const ownerSkill = await Skill.create({
      name: sharedName,
      description: 'Owner tenant skill.',
      body: 'owner body',
      frontmatter: {},
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      tenantId: 'tenant-a',
      version: 1,
      source: 'inline',
      fileCount: 0,
    });
    await Skill.create({
      name: sharedName,
      description: 'Other author skill.',
      body: 'other body',
      frontmatter: {},
      author: other._id,
      authorName: other.name ?? 'Other',
      tenantId: 'tenant-a',
      version: 1,
      source: 'inline',
      fileCount: 0,
    });
    await Skill.create({
      name: sharedName,
      description: 'Owner different tenant skill.',
      body: 'tenant b body',
      frontmatter: {},
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      tenantId: 'tenant-b',
      version: 1,
      source: 'inline',
      fileCount: 0,
    });

    const fetched = await methods.getAuthorSkillByName({
      name: sharedName,
      author: owner._id,
      tenantId: 'tenant-a',
    });

    expect(fetched?._id.toString()).toBe(ownerSkill._id.toString());
    expect(fetched?.body).toBe('owner body');
  });

  it('preferModelInvocable picks the model-invocable doc on same-name collision (does NOT filter on userInvocable)', async () => {
    /* Same-name collision scenario the model paths must handle: an older
       user-invocable variant and a newer model-only variant
       (`userInvocable: false`) — both are model-invocable. The model
       path uses preferModelInvocable, which deliberately does NOT
       filter on userInvocable; otherwise the older doc would shadow the
       cataloged model-only doc the model targeted. */
    const olderUserInvocable = await Skill.create({
      name: 'model-collision',
      description: 'Older user-invocable variant of the colliding name.',
      body: 'user-invocable body',
      frontmatter: {},
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      version: 1,
      source: 'inline',
      fileCount: 0,
      userInvocable: true,
    });
    const newerModelOnly = await Skill.create({
      name: 'model-collision',
      description: 'Newer model-only variant of the colliding name.',
      body: 'model-only body',
      frontmatter: {},
      author: other._id,
      authorName: other.name ?? 'Other',
      version: 1,
      source: 'inline',
      fileCount: 0,
      userInvocable: false,
    });
    /* Set updatedAt explicitly so the "older / newer" assertion is
       deterministic across CI runners — relying on wall-clock spacing
       between two `Skill.create` calls would race on a fast machine. */
    await Skill.collection.updateOne(
      { _id: olderUserInvocable._id },
      { $set: { updatedAt: new Date(Date.now() - 1000) } },
    );

    const accessibleIds = [
      olderUserInvocable._id as mongoose.Types.ObjectId,
      newerModelOnly._id as mongoose.Types.ObjectId,
    ];

    /* preferModelInvocable: both are model-invocable (neither has
       disableModelInvocation: true), so newest wins → model-only doc. */
    const modelLookup = await methods.getSkillByName('model-collision', accessibleIds, {
      preferModelInvocable: true,
    });
    expect(modelLookup?._id.toString()).toBe(newerModelOnly._id.toString());
  });

  it('preferUserInvocable picks the user-invocable doc on same-name collision (does NOT filter on disableModelInvocation)', async () => {
    /* Manual path scenario: older user-invocable variant + newer
       model-only variant. The popover surfaced the older doc; the
       resolver must look it up with preferUserInvocable so the
       newer model-only doc doesn't shadow the user's selection. */
    const olderUserInvocable = await Skill.create({
      name: 'user-collision',
      description: 'Older user-invocable variant.',
      body: 'user-invocable body',
      frontmatter: {},
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      version: 1,
      source: 'inline',
      fileCount: 0,
      userInvocable: true,
    });
    const newerModelOnly = await Skill.create({
      name: 'user-collision',
      description: 'Newer model-only variant.',
      body: 'model-only body',
      frontmatter: {},
      author: other._id,
      authorName: other.name ?? 'Other',
      version: 1,
      source: 'inline',
      fileCount: 0,
      userInvocable: false,
    });
    /* Deterministic ordering — see the model-collision test above. */
    await Skill.collection.updateOne(
      { _id: olderUserInvocable._id },
      { $set: { updatedAt: new Date(Date.now() - 1000) } },
    );

    const accessibleIds = [
      olderUserInvocable._id as mongoose.Types.ObjectId,
      newerModelOnly._id as mongoose.Types.ObjectId,
    ];

    /* Default behavior: newest wins → model-only doc returned. */
    const defaultLookup = await methods.getSkillByName('user-collision', accessibleIds);
    expect(defaultLookup?._id.toString()).toBe(newerModelOnly._id.toString());

    /* preferUserInvocable: user-invocable doc wins → older doc returned.
       Disabled-model status is irrelevant here. */
    const preferred = await methods.getSkillByName('user-collision', accessibleIds, {
      preferUserInvocable: true,
    });
    expect(preferred?._id.toString()).toBe(olderUserInvocable._id.toString());
  });

  it('preferUserInvocable still returns disabled docs (manual prime of disabled is supported)', async () => {
    /* Manual path with a disabled-but-user-invocable skill: the user
       can still pick it from the popover; resolveManualSkills uses
       preferUserInvocable, which doesn't filter on
       disableModelInvocation. */
    const disabled = await Skill.create({
      name: 'disabled-user-invocable',
      description: 'User-invocable but model-disabled.',
      body: 'body',
      frontmatter: {},
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      version: 1,
      source: 'inline',
      fileCount: 0,
      userInvocable: true,
      disableModelInvocation: true,
    });

    const result = await methods.getSkillByName(
      'disabled-user-invocable',
      [disabled._id as mongoose.Types.ObjectId],
      { preferUserInvocable: true },
    );
    expect(result?._id.toString()).toBe(disabled._id.toString());
    expect(result?.disableModelInvocation).toBe(true);
  });

  it('preferred lookups fall back to the newest match when no preferred doc exists', async () => {
    /* Sole-disabled name: only a disable-model-invocation doc exists.
       preferModelInvocable must still return it so handleSkillToolCall
       can fire the explicit-rejection error path. */
    const disabledOnly = await Skill.create({
      name: 'sole-disabled-fallback',
      description: 'Only a model-disabled variant of this name exists.',
      body: 'disabled body',
      frontmatter: {},
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      version: 1,
      source: 'inline',
      fileCount: 0,
      disableModelInvocation: true,
    });

    const result = await methods.getSkillByName(
      'sole-disabled-fallback',
      [disabledOnly._id as mongoose.Types.ObjectId],
      { preferModelInvocable: true },
    );
    expect(result?._id.toString()).toBe(disabledOnly._id.toString());
    expect(result?.disableModelInvocation).toBe(true);
  });

  it('does not overwrite explicit columns with frontmatter values (column wins)', async () => {
    /* If both column and frontmatter are set (e.g. an admin edited the
       column directly via the API but the frontmatter still says
       otherwise), the column is authoritative — backfill only fills
       undefined fields. */
    const skill = await Skill.create({
      name: 'column-wins',
      description: 'A demo skill used in tests.',
      body: 'body',
      frontmatter: {
        name: 'column-wins',
        description: 'A demo skill used in tests.',
        'disable-model-invocation': true,
        'user-invocable': false,
      },
      author: owner._id,
      authorName: owner.name ?? 'Skill Owner',
      version: 1,
      source: 'inline',
      fileCount: 0,
      disableModelInvocation: false,
      userInvocable: true,
    });

    const fetched = await methods.getSkillByName('column-wins', [
      skill._id as mongoose.Types.ObjectId,
    ]);
    expect(fetched?.disableModelInvocation).toBe(false);
    expect(fetched?.userInvocable).toBe(true);
  });

  it('listSkillsByAccess returns disableModelInvocation / userInvocable / allowedTools on summary rows', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'list-summary',
        frontmatter: {
          name: 'list-summary',
          description: 'A demo skill used in tests.',
          'disable-model-invocation': true,
          'user-invocable': false,
          'allowed-tools': ['web_search'],
        },
      }),
    );
    const result = await methods.listSkillsByAccess({
      accessibleIds: [skill._id],
      limit: 10,
    });
    expect(result.skills.length).toBe(1);
    /* These are the fields injectSkillCatalog filters on; if they're
       missing from the projection, the catalog can't enforce
       disableModelInvocation. */
    expect(result.skills[0].disableModelInvocation).toBe(true);
    expect(result.skills[0].userInvocable).toBe(false);
    expect(result.skills[0].allowedTools).toEqual(['web_search']);
  });

  it('listSkillsByAccess filters by category and search', async () => {
    const { skill: a } = await methods.createSkill(
      makeSkillInput({ name: 'alpha-skill', category: 'tools' }),
    );
    await methods.createSkill(
      makeSkillInput({
        name: 'beta-skill',
        category: 'other',
        description: 'A beta description that is long enough.',
      }),
    );
    const ids = await Skill.find().distinct('_id');

    const byCat = await methods.listSkillsByAccess({
      accessibleIds: ids as unknown as mongoose.Types.ObjectId[],
      limit: 10,
      category: 'tools',
    });
    expect(byCat.skills.length).toBe(1);
    expect(byCat.skills[0].name).toBe(a.name);

    const bySearch = await methods.listSkillsByAccess({
      accessibleIds: ids as unknown as mongoose.Types.ObjectId[],
      limit: 10,
      search: 'beta',
    });
    expect(bySearch.skills.length).toBe(1);
    expect(bySearch.skills[0].name).toBe('beta-skill');
  });

  it('listAlwaysApplySkills returns only alwaysApply:true rows within accessibleIds', async () => {
    const { skill: a } = await methods.createSkill(
      makeSkillInput({ name: 'always-a', alwaysApply: true }),
    );
    const { skill: b } = await methods.createSkill(
      makeSkillInput({ name: 'always-b', alwaysApply: true }),
    );
    const { skill: c } = await methods.createSkill(
      makeSkillInput({ name: 'not-always-c' /* alwaysApply defaults false */ }),
    );
    const ids = [a._id, b._id, c._id];
    const result = await methods.listAlwaysApplySkills({
      accessibleIds: ids as unknown as mongoose.Types.ObjectId[],
      limit: 10,
    });
    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(['always-a', 'always-b']);
    expect(result.skills.map((skill) => skill.version)).toEqual([1, 1]);
  });

  it('listAlwaysApplySkills excludes rows outside accessibleIds', async () => {
    const { skill: mine } = await methods.createSkill(
      makeSkillInput({ name: 'mine-always', alwaysApply: true }),
    );
    await methods.createSkill(makeSkillInput({ name: 'other-always', alwaysApply: true }));
    const result = await methods.listAlwaysApplySkills({
      accessibleIds: [mine._id] as unknown as mongoose.Types.ObjectId[],
      limit: 10,
    });
    expect(result.skills.map((s) => s.name)).toEqual(['mine-always']);
  });

  it('listAlwaysApplySkills respects the limit and reports has_more for pagination', async () => {
    const created = [];
    for (let i = 0; i < 3; i++) {
      const { skill } = await methods.createSkill(
        makeSkillInput({ name: `always-${i}`, alwaysApply: true }),
      );
      created.push(skill);
    }
    const result = await methods.listAlwaysApplySkills({
      accessibleIds: created.map((s) => s._id) as unknown as mongoose.Types.ObjectId[],
      limit: 2,
    });
    expect(result.skills).toHaveLength(2);
    expect(result.has_more).toBe(true);
    expect(result.after).not.toBeNull();
  });

  it('listAlwaysApplySkills paginates via cursor to return subsequent rows without duplicates', async () => {
    const created = [];
    for (let i = 0; i < 5; i++) {
      const { skill } = await methods.createSkill(
        makeSkillInput({ name: `paged-${i}`, alwaysApply: true }),
      );
      created.push(skill);
    }
    const ids = created.map((s) => s._id) as unknown as mongoose.Types.ObjectId[];
    const first = await methods.listAlwaysApplySkills({ accessibleIds: ids, limit: 2 });
    expect(first.skills).toHaveLength(2);
    expect(first.has_more).toBe(true);
    const second = await methods.listAlwaysApplySkills({
      accessibleIds: ids,
      limit: 2,
      cursor: first.after,
    });
    expect(second.skills).toHaveLength(2);
    const third = await methods.listAlwaysApplySkills({
      accessibleIds: ids,
      limit: 2,
      cursor: second.after,
    });
    expect(third.has_more).toBe(false);
    expect(third.after).toBeNull();
    const seenIds = [...first.skills, ...second.skills, ...third.skills].map((s) =>
      s._id.toString(),
    );
    expect(new Set(seenIds).size).toBe(5);
  });

  it('createSkill persists alwaysApply first-class column', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'flagged', alwaysApply: true }),
    );
    expect(skill.alwaysApply).toBe(true);

    const { skill: defaulted } = await methods.createSkill(makeSkillInput({ name: 'defaulted' }));
    expect(defaulted.alwaysApply).toBe(false);
  });

  it('createSkill rejects a non-boolean top-level alwaysApply', async () => {
    await expect(
      methods.createSkill(
        makeSkillInput({ name: 'bad-always', alwaysApply: 'false' as unknown as boolean }),
      ),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
  });

  it('updateSkill rejects a non-boolean top-level alwaysApply', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'type-guard' }));
    await expect(
      methods.updateSkill({
        id: skill._id.toString(),
        expectedVersion: skill.version,
        update: { alwaysApply: 'true' as unknown as boolean },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
  });

  it('updateSkill rejects explicit null for alwaysApply (cannot persist ambiguous state)', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'null-guard', alwaysApply: true }),
    );
    await expect(
      methods.updateSkill({
        id: skill._id.toString(),
        expectedVersion: skill.version,
        update: { alwaysApply: null as unknown as boolean },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
  });

  it('createSkill derives alwaysApply from frontmatter when the top-level flag is absent', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'frontmatter-on',
        frontmatter: {
          name: 'frontmatter-on',
          description: 'A small demo skill used in tests.',
          'always-apply': true,
        },
      }),
    );
    expect(skill.alwaysApply).toBe(true);
  });

  it('createSkill derives alwaysApply from the camel-case frontmatter alias', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'frontmatter-alias-on',
        frontmatter: {
          name: 'frontmatter-alias-on',
          description: 'A small demo skill used in tests.',
          alwaysApply: true,
        },
      }),
    );
    expect(skill.alwaysApply).toBe(true);
  });

  it('createSkill lets always-apply win when both frontmatter spellings are present', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'frontmatter-canonical-wins',
        frontmatter: {
          name: 'frontmatter-canonical-wins',
          description: 'A small demo skill used in tests.',
          'always-apply': false,
          alwaysApply: true,
        },
      }),
    );
    expect(skill.alwaysApply).toBe(false);
  });

  it('createSkill prefers explicit top-level alwaysApply over frontmatter', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'explicit-wins',
        alwaysApply: false,
        frontmatter: {
          name: 'explicit-wins',
          description: 'A small demo skill used in tests.',
          'always-apply': true,
        },
      }),
    );
    expect(skill.alwaysApply).toBe(false);
  });

  it('updateSkill syncs alwaysApply column from a frontmatter-only update', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'sync-test' }));
    expect(skill.alwaysApply).toBe(false);
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: {
        frontmatter: {
          name: 'sync-test',
          description: 'A small demo skill used in tests.',
          'always-apply': true,
        },
      },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill syncs alwaysApply column from the camel-case frontmatter alias', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'sync-alias-test' }));
    expect(skill.alwaysApply).toBe(false);
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: {
        frontmatter: {
          name: 'sync-alias-test',
          description: 'A small demo skill used in tests.',
          alwaysApply: true,
        },
      },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill keeps alwaysApply column untouched when the frontmatter update omits always-apply', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'no-flip', alwaysApply: true }),
    );
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: {
        frontmatter: { name: 'no-flip', description: 'Updated desc without touching the flag.' },
      },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill top-level alwaysApply wins over a frontmatter flag in the same update', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'explicit-update-wins' }));
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: {
        alwaysApply: false,
        frontmatter: {
          name: 'explicit-update-wins',
          description: 'A small demo skill used in tests.',
          'always-apply': true,
        },
      },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(false);
    }
  });

  it('updateSkill derives alwaysApply from a body edit that flips `always-apply:` inline', async () => {
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'body-flip', alwaysApply: true }),
    );
    const newBody = `---\nname: body-flip\ndescription: still a demo skill.\nalways-apply: false\n---\n\n# Edited body`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: { body: newBody },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(false);
      expect(result.skill.body).toBe(newBody);
    }
  });

  it('updateSkill derives alwaysApply=true from a body edit that adds `always-apply: true` inline', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'body-enable' }));
    expect(skill.alwaysApply).toBe(false);
    const newBody = `---\nname: body-enable\ndescription: now opting in.\nalways-apply: true\n---\n\n# Body`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: { body: newBody },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill derives alwaysApply=true from a body edit that adds `alwaysApply: true` inline', async () => {
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'body-enable-alias' }));
    expect(skill.alwaysApply).toBe(false);
    const newBody = `---\nname: body-enable-alias\ndescription: now opting in.\nalwaysApply: true\n---\n\n# Body`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: { body: newBody },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill flips alwaysApply to false when the body removes the `always-apply:` line', async () => {
    /* Regression for the “durable mismatch” case: a previously-
       always-apply skill whose SKILL.md body no longer declares the
       flag must stop auto-priming. Without this, the column would
       stick at `true` and the UI pin badge would persist even though
       the file itself no longer opts in. */
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'body-remove', alwaysApply: true }),
    );
    const bodyWithoutKey = `---\nname: body-remove\ndescription: opting out by removing the line.\n---\n\n# Body`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: { body: bodyWithoutKey },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(false);
      expect(result.skill.body).toBe(bodyWithoutKey);
    }
  });

  it('updateSkill flips alwaysApply to false when the body update carries no frontmatter block at all', async () => {
    /* An author rewriting SKILL.md without any YAML frontmatter is an
       implicit opt-out — there is no declaration anywhere, so the
       column should reflect that. */
    const { skill } = await methods.createSkill(
      makeSkillInput({ name: 'body-strip-fm', alwaysApply: true }),
    );
    const plainBody = `# Just the body now — no frontmatter.`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: { body: plainBody },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(false);
    }
  });

  it('updateSkill explicit alwaysApply still wins when body would otherwise flip it to false', async () => {
    /* Higher-precedence sources still override: an API caller sending
       both `alwaysApply: true` and a body without the key keeps the
       column `true`, because explicit top-level is the authoritative
       source for programmatic callers. */
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'explicit-trumps-body' }));
    const bodyWithoutKey = `---\nname: explicit-trumps-body\ndescription: frontmatter block without the flag.\n---\n\n# Body`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: { alwaysApply: true, body: bodyWithoutKey },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill accepts a body typo when an explicit top-level alwaysApply overrides it', async () => {
    /* Validation respects the same precedence as derivation: a caller
       sending `alwaysApply: true` alongside a body whose frontmatter
       carries a typo (`always-apply: tru`) should NOT be rejected —
       the body value is never consulted. Rejecting would be
       user-hostile for programmatic callers that legitimately own the
       explicit field. */
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'typo-overridden' }));
    const bodyWithTypo = `---\nname: typo-overridden\ndescription: body has a broken flag.\nalways-apply: tru\n---\n\n# Body`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: { alwaysApply: true, body: bodyWithTypo },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill accepts a body typo when a structured frontmatter override carries a valid boolean', async () => {
    /* Same precedence rule for the frontmatter-bag layer: a caller
       that sends a structured `frontmatter['always-apply']: true`
       plus a body with a typo is overriding the body at derivation
       time, so the body typo should not reject the update. */
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'fm-overrides-body' }));
    const bodyWithTypo = `---\nname: fm-overrides-body\ndescription: broken body flag.\nalways-apply: yes\n---\n\n# Body`;
    const result = await methods.updateSkill({
      id: skill._id.toString(),
      expectedVersion: skill.version,
      update: {
        frontmatter: {
          name: 'fm-overrides-body',
          description: 'A small demo skill used in tests.',
          'always-apply': true,
        },
        body: bodyWithTypo,
      },
    });
    expect(result.status).toBe('updated');
    if (result.status === 'updated') {
      expect(result.skill.alwaysApply).toBe(true);
    }
  });

  it('updateSkill still rejects a body typo when no higher-precedence source is provided', async () => {
    /* Body-inline validation must still fire when nothing else is
       carrying the value — otherwise a body PATCH with `tru` would
       silently drop the typo + keep the old column value. */
    const { skill } = await methods.createSkill(makeSkillInput({ name: 'typo-body-only' }));
    const bodyWithTypo = `---\nname: typo-body-only\ndescription: nothing else carries the flag.\nalways-apply: tru\n---\n\n# Body`;
    await expect(
      methods.updateSkill({
        id: skill._id.toString(),
        expectedVersion: skill.version,
        update: { body: bodyWithTypo },
      }),
    ).rejects.toMatchObject({ code: 'SKILL_VALIDATION_FAILED' });
  });

  it('createSkill accepts a body typo when an explicit top-level alwaysApply overrides it', async () => {
    /* Same precedence-aware validation on the create path: explicit
       top-level `alwaysApply` short-circuits body-inline validation. */
    const bodyWithTypo = `---\nname: create-typo-overridden\ndescription: broken body flag.\nalways-apply: tru\n---\n\n# Body`;
    const { skill } = await methods.createSkill(
      makeSkillInput({
        name: 'create-typo-overridden',
        alwaysApply: false,
        body: bodyWithTypo,
      }),
    );
    expect(skill.alwaysApply).toBe(false);
  });
});

describe('SkillFile methods', () => {
  it('allows exactly one conditional writer and rejects a stale or deleted revision', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    const input = {
      skillId: skill._id,
      relativePath: 'references/race.md',
      file_id: 'original',
      filename: 'race.md',
      filepath: '/tmp/original',
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 10,
      author: owner._id,
    };
    await methods.upsertSkillFile(input);
    const results = await Promise.allSettled(
      ['a', 'b'].map((revision) =>
        methods.upsertSkillFile({ ...input, expectedFileId: 'original', file_id: revision }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'SKILL_FILE_CONFLICT' },
    });
    const current = await methods.getSkillFileByPath(skill._id, input.relativePath);
    expect(['a', 'b']).toContain(current?.file_id);
    expect(await methods.getSkillById(skill._id)).toMatchObject({ version: 3, fileCount: 1 });

    // An unconditional authoring/agent write also invalidates a captured editor revision.
    await methods.upsertSkillFile({ ...input, file_id: 'agent' });
    await expect(
      methods.upsertSkillFile({
        ...input,
        expectedFileId: current!.file_id,
        file_id: 'stale-editor',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
    await methods.deleteSkillFile(skill._id, input.relativePath);
    await expect(
      methods.upsertSkillFile({
        ...input,
        expectedFileId: 'agent',
        file_id: 'resurrected',
      }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
    expect(await methods.getSkillFileByPath(skill._id, input.relativePath)).toBeNull();
  });

  it('creates only absent skill files and leaves the winner intact when creation races', async () => {
    await SkillFile.init();
    const { skill } = await methods.createSkill(makeSkillInput());
    const original = {
      skillId: skill._id,
      relativePath: 'references/new.md',
      file_id: 'browser',
      filename: 'new.md',
      filepath: '/tmp/browser',
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 7,
      author: owner._id,
    };
    await methods.upsertSkillFile(original);
    await expect(
      methods.upsertSkillFile({ ...original, createOnly: true, file_id: 'late-agent' }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
    expect(await methods.getSkillFileByPath(skill._id, original.relativePath)).toMatchObject({
      file_id: 'browser',
      filepath: '/tmp/browser',
    });
    expect(await methods.getSkillById(skill._id)).toMatchObject({ version: 2, fileCount: 1 });

    const results = await Promise.allSettled(
      ['first', 'second'].map((id) =>
        methods.upsertSkillFile({
          ...original,
          relativePath: 'references/concurrent.md',
          filename: 'concurrent.md',
          filepath: `/tmp/${id}`,
          file_id: id,
          createOnly: true,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'SKILL_FILE_CONFLICT' },
    });
    expect(['first', 'second']).toContain(
      (await methods.getSkillFileByPath(skill._id, 'references/concurrent.md'))?.file_id,
    );
    expect(await methods.getSkillById(skill._id)).toMatchObject({ version: 3, fileCount: 2 });
  });

  it('does not let a delayed read cache old bytes on a replaced file', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    const input = {
      skillId: skill._id,
      relativePath: 'references/cache.md',
      file_id: 'before',
      filename: 'cache.md',
      filepath: '/tmp/before',
      source: 'local',
      mimeType: 'text/markdown',
      bytes: 10,
      author: owner._id,
    };
    await methods.upsertSkillFile(input);
    await methods.upsertSkillFile({ ...input, expectedFileId: 'before', file_id: 'after' });
    await methods.updateSkillFileContent(
      skill._id,
      input.relativePath,
      {
        content: 'stale read',
        isBinary: false,
      },
      'before',
    );
    expect(await methods.getSkillFileByPath(skill._id, input.relativePath)).not.toHaveProperty(
      'content',
    );
    await methods.updateSkillFileContent(
      skill._id,
      input.relativePath,
      {
        content: 'new bytes',
        isBinary: false,
      },
      'after',
    );
    expect(await methods.getSkillFileByPath(skill._id, input.relativePath)).toMatchObject({
      file_id: 'after',
      content: 'new bytes',
    });
  });

  it('upsertSkillFile bumps parent skill version and updates fileCount', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    expect(skill.version).toBe(1);
    expect(skill.fileCount).toBe(0);

    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-abc',
      filename: 'parse.sh',
      filepath: '/tmp/parse.sh',
      source: 'local',
      mimeType: 'text/plain',
      bytes: 10,
      author: owner._id,
    });

    const updated = await methods.getSkillById(skill._id);
    expect(updated?.version).toBe(2);
    expect(updated?.fileCount).toBe(1);
  });

  it('upsertSkillFile replaces an existing row and bumps version again', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-1',
      filename: 'parse.sh',
      filepath: '/tmp/v1',
      source: 'local',
      mimeType: 'text/plain',
      bytes: 10,
      author: owner._id,
    });
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-2',
      filename: 'parse.sh',
      filepath: '/tmp/v2',
      source: 'local',
      mimeType: 'text/plain',
      bytes: 20,
      author: owner._id,
    });
    const after = await methods.getSkillById(skill._id);
    expect(after?.fileCount).toBe(1);
    expect(after?.version).toBe(3);
    const files = await methods.listSkillFiles(skill._id);
    expect(files.length).toBe(1);
    expect(files[0].file_id).toBe('file-2');
  });

  it('upsertSkillFile persists storage metadata', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-1',
      filename: 'parse.sh',
      filepath: '/tmp/v1',
      storageKey: 'r/us-east-2/uploads/user123/parse.sh',
      storageRegion: 'us-east-2',
      source: 's3',
      mimeType: 'text/plain',
      bytes: 10,
      author: owner._id,
    });

    const files = await methods.listSkillFiles(skill._id);
    expect(files[0].storageKey).toBe('r/us-east-2/uploads/user123/parse.sh');
    expect(files[0].storageRegion).toBe('us-east-2');
  });

  it('throws an explicit error when the upsert returns no saved file row', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    const missingUpsert = {
      lean: jest.fn().mockResolvedValue({
        value: null,
        lastErrorObject: { updatedExisting: false },
      }),
    } as unknown as ReturnType<typeof SkillFile.findOneAndUpdate>;
    const findOneAndUpdateSpy = jest
      .spyOn(SkillFile, 'findOneAndUpdate')
      .mockReturnValueOnce(missingUpsert);
    const bumpSpy = jest.spyOn(Skill, 'findByIdAndUpdate');

    try {
      await expect(
        methods.upsertSkillFile({
          skillId: skill._id,
          relativePath: 'scripts/parse.sh',
          file_id: 'file-1',
          filename: 'parse.sh',
          filepath: '/tmp/v1',
          source: 'local',
          mimeType: 'text/plain',
          bytes: 10,
          author: owner._id,
        }),
      ).rejects.toMatchObject({ code: 'SKILL_FILE_UPSERT_NOT_FOUND' });
      expect(bumpSpy).not.toHaveBeenCalled();
    } finally {
      findOneAndUpdateSpy.mockRestore();
      bumpSpy.mockRestore();
    }
  });

  it('clears all code environment refs when a skill file is upserted (replacement)', async () => {
    /* A re-upload of a skill file replaces the row's contents — but the
     * cached `codeEnvRef` refers to the OLD bytes living in codeapi.
     * Leaving it populated would make the next prime resolve a stale
     * pointer. The upsert MUST $unset codeEnvRef. */
    const { skill } = await methods.createSkill(makeSkillInput());
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-1',
      filename: 'parse.sh',
      filepath: '/tmp/v1',
      source: 'local',
      mimeType: 'text/plain',
      bytes: 10,
      author: owner._id,
    });

    const entityId = skill._id.toString();
    await methods.updateSkillFileCodeEnvIds([
      {
        skillId: skill._id,
        relativePath: 'scripts/parse.sh',
        codeEnvRef: {
          kind: 'skill',
          id: entityId,
          storage_session_id: 'sess-old',
          file_id: 'file-old',
          version: 1,
        },
      },
    ]);

    /* Sanity: ref is persisted before the replacement. */
    const before = await methods.listSkillFiles(skill._id);
    expect(before[0].codeEnvRef).toMatchObject({
      kind: 'skill',
      storage_session_id: 'sess-old',
      file_id: 'file-old',
      version: 1,
    });

    /* Replace the row with new bytes. */
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/parse.sh',
      file_id: 'file-2',
      filename: 'parse.sh',
      filepath: '/tmp/v2',
      source: 'local',
      mimeType: 'text/plain',
      bytes: 20,
      author: owner._id,
    });

    const after = await methods.listSkillFiles(skill._id);
    expect(after).toHaveLength(1);
    expect(after[0].file_id).toBe('file-2');
    expect(after[0].codeEnvRef).toBeUndefined();
    expect(after[0].codeEnvRefs).toBeUndefined();
  });

  it('deleteSkillFile recounts and bumps version', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/a.sh',
      file_id: 'f1',
      filename: 'a.sh',
      filepath: '/a',
      source: 'local',
      mimeType: 'text/plain',
      bytes: 1,
      author: owner._id,
    });
    await methods.upsertSkillFile({
      skillId: skill._id,
      relativePath: 'scripts/b.sh',
      file_id: 'f2',
      filename: 'b.sh',
      filepath: '/b',
      source: 'local',
      mimeType: 'text/plain',
      bytes: 1,
      author: owner._id,
    });
    const res = await methods.deleteSkillFile(skill._id, 'scripts/a.sh');
    expect(res.deleted).toBe(true);
    const after = await methods.getSkillById(skill._id);
    expect(after?.fileCount).toBe(1);
    expect(after?.version).toBe(4);
  });

  it('rejects invalid paths via upsertSkillFile', async () => {
    const { skill } = await methods.createSkill(makeSkillInput());
    await expect(
      methods.upsertSkillFile({
        skillId: skill._id,
        relativePath: '../evil',
        file_id: 'f1',
        filename: 'evil',
        filepath: '/x',
        source: 'local',
        mimeType: 'text/plain',
        bytes: 1,
        author: owner._id,
      }),
    ).rejects.toMatchObject({ code: 'SKILL_FILE_VALIDATION_FAILED' });
  });

  describe('updateSkillFileCodeEnvIds (skill-bundle cache pointer)', () => {
    /**
     * The returned `{matchedCount, modifiedCount}` shape is the diagnostic
     * contract `primeSkillFiles` relies on — a silently-dropped write
     * turns every subsequent prime into a fresh codeapi upload (N×M
     * egress per chat load). Pinning the contract here so the caller
     * can warn-log on partial writes instead of failing closed.
     */
    it('persists codeEnvRef and reports matched/modified counts', async () => {
      const { skill } = await methods.createSkill(makeSkillInput());
      await methods.upsertSkillFile({
        skillId: skill._id,
        relativePath: 'scripts/a.sh',
        file_id: 'f1',
        filename: 'a.sh',
        filepath: '/a',
        source: 'local',
        mimeType: 'text/plain',
        bytes: 1,
        author: owner._id,
      });

      const entityId = skill._id.toString();
      const result = await methods.updateSkillFileCodeEnvIds([
        {
          skillId: skill._id,
          relativePath: 'scripts/a.sh',
          codeEnvRef: {
            kind: 'skill',
            id: entityId,
            storage_session_id: 'session-1',
            file_id: 'file-1',
            version: 1,
          },
        },
      ]);

      expect(result.matchedCount).toBe(1);
      expect(result.modifiedCount).toBe(1);

      const files = await methods.listSkillFiles(skill._id);
      expect(files[0].codeEnvRef).toMatchObject({
        kind: 'skill',
        id: entityId,
        storage_session_id: 'session-1',
        file_id: 'file-1',
        version: 1,
      });
      expect(files[0].codeEnvRefs?.default).toMatchObject({
        kind: 'skill',
        id: entityId,
        storage_session_id: 'session-1',
        file_id: 'file-1',
        version: 1,
      });
    });

    it('retains pointers for both execution profiles', async () => {
      const { skill } = await methods.createSkill(makeSkillInput());
      await methods.upsertSkillFile({
        skillId: skill._id,
        relativePath: 'scripts/a.sh',
        file_id: 'f1',
        filename: 'a.sh',
        filepath: '/a',
        source: 'local',
        mimeType: 'text/plain',
        bytes: 1,
        author: owner._id,
      });
      const base = {
        kind: 'skill' as const,
        id: skill._id.toString(),
        version: 1,
      };

      await methods.updateSkillFileCodeEnvIds([
        {
          skillId: skill._id,
          relativePath: 'scripts/a.sh',
          codeEnvRef: {
            ...base,
            storage_session_id: 'default-session',
            file_id: 'default-file',
            executionProfile: 'default',
          },
        },
        {
          skillId: skill._id,
          relativePath: 'scripts/a.sh',
          codeEnvRef: {
            ...base,
            storage_session_id: 'stateful-session',
            file_id: 'stateful-file',
            executionProfile: 'stateful',
          },
        },
      ]);

      const [file] = await methods.listSkillFiles(skill._id);
      expect(file.codeEnvRefs?.default?.file_id).toBe('default-file');
      expect(file.codeEnvRefs?.stateful?.file_id).toBe('stateful-file');
    });

    it('persists deployment-specific route keys and their reference metadata', async () => {
      const { skill } = await methods.createSkill(makeSkillInput());
      await methods.upsertSkillFile({
        skillId: skill._id,
        relativePath: 'scripts/a.sh',
        file_id: 'f1',
        filename: 'a.sh',
        filepath: '/a',
        source: 'local',
        mimeType: 'text/plain',
        bytes: 1,
        author: owner._id,
      });
      const executionRouteKey = 'stateful:0123456789abcdef0123456789abcdef';

      await methods.updateSkillFileCodeEnvIds([
        {
          skillId: skill._id,
          relativePath: 'scripts/a.sh',
          codeEnvRef: {
            kind: 'skill',
            id: skill._id.toString(),
            version: 1,
            storage_session_id: 'route-session',
            file_id: 'route-file',
            executionProfile: 'stateful',
            executionRouteKey,
          },
        },
      ]);

      const [file] = await methods.listSkillFiles(skill._id);
      expect(file.codeEnvRefs?.[executionRouteKey]).toMatchObject({
        file_id: 'route-file',
        executionProfile: 'stateful',
        executionRouteKey,
      });
    });

    it('reports modifiedCount=0 when no SkillFile rows match the (skillId, relativePath) filter', async () => {
      const { skill } = await methods.createSkill(makeSkillInput());
      const result = await methods.updateSkillFileCodeEnvIds([
        {
          skillId: skill._id,
          relativePath: 'does/not/exist.sh',
          codeEnvRef: {
            kind: 'skill',
            id: 'x',
            storage_session_id: 'sid',
            file_id: 'fid',
            version: 1,
          },
        },
      ]);
      expect(result.modifiedCount).toBe(0);
      expect(result.matchedCount).toBe(0);
    });

    it('returns zero counts when called with an empty update list', async () => {
      const result = await methods.updateSkillFileCodeEnvIds([]);
      expect(result).toEqual({ matchedCount: 0, modifiedCount: 0 });
    });
  });
});

describe('deleteUserSkills', () => {
  it('removes sole-owned skills only', async () => {
    const { skill: mine } = await methods.createSkill(makeSkillInput({ name: 'mine' }));
    await grantOwner(mine._id);

    // Create a second skill owned by someone else
    const shared = await Skill.create({
      name: 'shared',
      description: 'shared skill',
      body: '',
      frontmatter: {},
      category: '',
      author: other._id,
      authorName: other.name ?? 'Other',
      version: 1,
      source: 'inline',
      fileCount: 0,
    });
    const sharedId = (shared.toObject() as { _id: mongoose.Types.ObjectId })._id;
    // Owner user has viewer access to shared — so it's NOT sole-owned
    const viewerRole = (await AccessRole.findOne({
      accessRoleId: AccessRoleIds.SKILL_VIEWER,
    }).lean()) as { _id: mongoose.Types.ObjectId; permBits: number } | null;
    await aclMethods.grantPermission(
      PrincipalType.USER,
      owner._id,
      ResourceType.SKILL,
      sharedId,
      viewerRole!.permBits,
      other._id,
      undefined,
      viewerRole!._id,
    );
    // And other is owner of the shared skill
    const ownerRole = (await AccessRole.findOne({
      accessRoleId: AccessRoleIds.SKILL_OWNER,
    }).lean()) as { _id: mongoose.Types.ObjectId; permBits: number } | null;
    await aclMethods.grantPermission(
      PrincipalType.USER,
      other._id,
      ResourceType.SKILL,
      sharedId,
      ownerRole!.permBits,
      other._id,
      undefined,
      ownerRole!._id,
    );

    const deleted = await methods.deleteUserSkills(owner._id as mongoose.Types.ObjectId);
    expect(deleted).toBe(1);
    expect(await Skill.countDocuments()).toBe(1);
    expect(await Skill.countDocuments({ _id: sharedId })).toBe(1);
  });

  it('prunes deleted sole-owned skill ids from agent allowlists', async () => {
    const { skill: mine } = await methods.createSkill(makeSkillInput({ name: 'mine' }));
    await grantOwner(mine._id);
    const Agent = mongoose.models.Agent;
    const agent = await Agent.create(makeAgentDoc([mine._id.toString()]));

    const deleted = await methods.deleteUserSkills(owner._id as mongoose.Types.ObjectId);
    expect(deleted).toBe(1);

    const agentAfter = (await Agent.findById(agent._id).lean()) as {
      skills?: string[];
      skills_enabled?: boolean;
    } | null;
    expect(agentAfter?.skills).toEqual([]);
    expect(agentAfter?.skills_enabled).toBe(false);
  });
});
