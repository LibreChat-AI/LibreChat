import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  logger,
  createModels,
  createMethods,
  pickValidFrontmatter,
  type AllMethods,
} from '@librechat/data-schemas';
import { parseSkillMarkdown, toCleanFrontmatter } from '../parse';

logger.silent = true;

/**
 * The invariant this PR rests on: the same SKILL.md text must produce the same
 * invocation-mode columns whether it arrives as an upload or is pasted into the
 * skill editor. Both routes parse YAML before deriving the columns, but their
 * persistence entry points remain separate, so a shared corpus keeps them from
 * drifting apart on the next change.
 *
 * Each row is fed through both routes and the resulting columns compared. Add a
 * row here for any frontmatter shape a bug report turns up.
 */

type Columns = {
  alwaysApply?: boolean;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  rejected?: true;
};

let mongoServer: MongoMemoryServer;
let methods: AllMethods;

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

const DESCRIPTION = 'A skill used by the frontmatter parity corpus.';

function bodyFor(name: string, frontmatterLines: string): string {
  return `---\nname: ${name}\ndescription: ${DESCRIPTION}\n${frontmatterLines}\n---\n\nBody.`;
}

function columnsOf(skill: {
  alwaysApply?: boolean;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
}): Columns {
  return {
    alwaysApply: skill.alwaysApply,
    userInvocable: skill.userInvocable,
    disableModelInvocation: skill.disableModelInvocation,
  };
}

/** The upload route: js-yaml parse, cleaned bag, then `createSkill`. */
async function viaImport(name: string, body: string): Promise<Columns> {
  const parsed = parseSkillMarkdown(body);
  if (parsed.parseError || parsed.invalidBooleans.length > 0) {
    return { rejected: true };
  }
  const { skill } = await methods.createSkill({
    name: `${name}-import`,
    description: DESCRIPTION,
    body,
    frontmatter: pickValidFrontmatter(toCleanFrontmatter(parsed)),
    alwaysApply: parsed.alwaysApply,
    author: new Types.ObjectId(),
    authorName: 'Parity',
  });
  return columnsOf(skill);
}

/** The editor route: body only, parsed inside `createSkill`. */
async function viaInlineBody(name: string, body: string): Promise<Columns> {
  try {
    const { skill } = await methods.createSkill({
      name: `${name}-inline`,
      description: DESCRIPTION,
      body,
      author: new Types.ObjectId(),
      authorName: 'Parity',
    });
    return columnsOf(skill);
  } catch {
    return { rejected: true };
  }
}

const CORPUS: Array<[label: string, frontmatterLines: string]> = [
  ['plain booleans', 'user-invocable: false\ndisable-model-invocation: true'],
  ['double-quoted value', 'user-invocable: "false"'],
  ['single-quoted value', "user-invocable: 'false'"],
  ['inline comment', 'user-invocable: false # off'],
  ['quoted value with comment', 'user-invocable: "false" # off'],
  ['comment-only value', 'user-invocable: # todo'],
  ['empty value', 'user-invocable:'],
  ['explicit YAML null', 'user-invocable: null'],
  ['explicit YAML tilde null', 'user-invocable: ~'],
  ['empty value beside an explicit tag', 'published: !!timestamp 2026-08-25\nuser-invocable:'],
  [
    'explicit null beside an explicit tag',
    'published: !!timestamp 2026-08-25\nuser-invocable: null',
  ],
  [
    'continued explicit null beside an explicit tag',
    'published: !!timestamp 2026-08-25\nuser-invocable:\n  null',
  ],
  ['value on the next line', 'user-invocable:\n  false'],
  ['YAML boolean alias', 'default: &off false\nuser-invocable: *off'],
  ['uppercase key and value', 'USER-INVOCABLE: FALSE'],
  ['spaces before the colon', 'user-invocable   : false'],
  ['trailing spaces after the value', 'user-invocable: false   '],
  ['double-quoted key', '"user-invocable": false'],
  ['single-quoted key', "'user-invocable': false"],
  ['empty quoted value', 'user-invocable: ""'],
  [
    'nested duplicate before the real key',
    'metadata:\n  user-invocable: nonsense\nuser-invocable: false',
  ],
  ['nested key only', 'metadata:\n  user-invocable: false'],
  ['flow-style nested mapping', 'metadata: {user-invocable: nonsense}'],
  ['multi-line plain scalar', 'user-invocable:\n  false\n  extra'],
  ['always-apply alias', 'alwaysApply: true'],
  ['both always-apply spellings', 'always-apply: false\nalwaysApply: true'],
  ['always-apply on the next line', 'always-apply:\n  true'],
  ['all three flags', 'always-apply: true\nuser-invocable: false\ndisable-model-invocation: true'],
  ['carriage return after the value', 'user-invocable: false\r'],
];

describe('frontmatter parity between the upload and inline-body routes', () => {
  let index = 0;

  it.each(CORPUS)('%s', async (_label, frontmatterLines) => {
    const name = `parity-${index++}`;
    const body = bodyFor(name, frontmatterLines);

    expect(await viaInlineBody(name, body)).toEqual(await viaImport(name, body));
  });

  it('rejects invalid YAML indentation on both routes', async () => {
    const name = 'parity-tab-indent';
    const body = bodyFor(name, 'metadata:\n\tuser-invocable: false');

    expect(await viaImport(name, body)).toEqual({ rejected: true });
    expect(await viaInlineBody(name, body)).toEqual({ rejected: true });
  });

  it('rejects recognized keys that collide after case normalization on both routes', async () => {
    const name = 'parity-case-duplicate';
    const body = bodyFor(name, 'user-invocable: false\nUSER-INVOCABLE: true');

    expect(await viaImport(name, body)).toEqual({ rejected: true });
    expect(await viaInlineBody(name, body)).toEqual({ rejected: true });
  });

  it('derives flags from a flow-style top-level mapping on both routes', async () => {
    const name = 'parity-flow-top-level';
    const body = `---\n{name: ${name}, description: ${DESCRIPTION}, user-invocable: false}\n---\n\nBody.`;

    expect(await viaInlineBody(name, body)).toEqual(await viaImport(name, body));
  });

  it('accepts an empty flow-style flag beside an unrelated explicit tag on both routes', async () => {
    const name = 'parity-flow-empty-explicit-tag';
    const body = `---\n{name: ${name}, description: ${DESCRIPTION}, published: !!timestamp 2026-08-25, user-invocable: }\n---\n\nBody.`;
    const expected = {
      alwaysApply: false,
      userInvocable: true,
      disableModelInvocation: false,
    };

    expect(await viaInlineBody(name, body)).toEqual(expected);
    expect(await viaImport(name, body)).toEqual(expected);
  });

  it.each([
    [
      'an indented mapping',
      `---\n  name: parity-null-indented\n  description: ${DESCRIPTION}\n  user-invocable: null\n---\n\nBody.`,
    ],
    [
      'a flow-style mapping',
      `---\n{name: parity-null-flow, description: ${DESCRIPTION}, user-invocable: null}\n---\n\nBody.`,
    ],
    [
      'an explicitly tagged null in a flow-style mapping',
      `---\n{name: parity-null-tagged-flow, description: ${DESCRIPTION}, user-invocable: !!null null}\n---\n\nBody.`,
    ],
    [
      'an alias',
      `---\nname: parity-null-alias\ndescription: ${DESCRIPTION}\ndefault: &null-value null\nuser-invocable: *null-value\n---\n\nBody.`,
    ],
  ])('rejects explicit YAML null in %s on both routes', async (_label, body) => {
    const name = `parity-null-${_label.replaceAll(/\W+/g, '-')}`;

    expect(await viaImport(name, body)).toEqual({ rejected: true });
    expect(await viaInlineBody(name, body)).toEqual({ rejected: true });
  });
});
