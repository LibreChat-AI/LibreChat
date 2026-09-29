import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { Types } from 'mongoose';
import { mergeCodeEnvRef, type CodeEnvRef, type CodeEnvRefMap } from 'librechat-data-provider';
import {
  logger,
  partitionIssues,
  validateSkillName,
  validateSkillBody,
  validateRelativePath,
  inferSkillFileCategory,
  validateSkillFrontmatter,
  validateSkillDescription,
  deriveStructuredFrontmatterFields,
  normalizeSkillFrontmatterKeys,
} from '@librechat/data-schemas';
import type { ValidationIssue } from '@librechat/data-schemas';
import { parseFrontmatter, guessMimeType } from './import';

export const DEPLOYMENT_SKILLS_DIR_ENV = 'DEPLOYMENT_SKILLS_DIR';
export const DEFAULT_DEPLOYMENT_SKILLS_DIR = 'skill';
export const DEPLOYMENT_SKILL_SOURCE = 'deployment';
export const DEPLOYMENT_SKILL_FILE_SOURCE = 'deployment';

const SKILL_MD = 'SKILL.md';
const MAX_CACHED_TEXT_BYTES = 512 * 1024;

let deploymentAuthorId: Types.ObjectId | undefined;

/** Constructed on demand so importing this module never depends on a live mongoose binding. */
function getDeploymentAuthorId(): Types.ObjectId {
  deploymentAuthorId ??= new Types.ObjectId('de9100000000000000000000');
  return deploymentAuthorId;
}

type SkillId = Types.ObjectId | string;

export type DeploymentSkillFile = {
  _id: Types.ObjectId;
  skillId: Types.ObjectId;
  relativePath: string;
  file_id: string;
  filename: string;
  filepath: string;
  source: typeof DEPLOYMENT_SKILL_FILE_SOURCE;
  mimeType: string;
  bytes: number;
  category: 'script' | 'reference' | 'asset' | 'other';
  isExecutable: boolean;
  author: Types.ObjectId;
  content?: string;
  isBinary?: boolean;
  codeEnvRef?: CodeEnvRef;
  codeEnvRefs?: CodeEnvRefMap;
  createdAt: Date;
  updatedAt: Date;
};

export type DeploymentSkill = {
  _id: Types.ObjectId;
  name: string;
  displayTitle?: string;
  description: string;
  body: string;
  frontmatter: Record<string, unknown>;
  category: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  author: Types.ObjectId;
  authorName: string;
  version: number;
  source: typeof DEPLOYMENT_SKILL_SOURCE;
  sourceMetadata: { deployment: true; directory: string; plugin?: string };
  fileCount: number;
  alwaysApply: boolean;
  isPublic: true;
  deployment: true;
  files: DeploymentSkillFile[];
  createdAt: Date;
  updatedAt: Date;
};

type SkillLookupOptions = {
  preferUserInvocable?: boolean;
  preferModelInvocable?: boolean;
};

type SkillSummaryRow = {
  _id: Types.ObjectId;
  name: string;
  displayTitle?: string;
  description: string;
  category?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  author: Types.ObjectId;
  authorName?: string;
  version?: number;
  source?: string;
  sourceMetadata?: Record<string, unknown>;
  fileCount?: number;
  alwaysApply?: boolean;
  isPublic?: boolean;
  tenantId?: string;
  deployment?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

type SkillDetailRow = SkillSummaryRow & {
  body: string;
  frontmatter?: Record<string, unknown>;
  version: number;
  fileCount: number;
};

type AlwaysApplySkillRow = {
  _id: Types.ObjectId;
  name: string;
  body: string;
  author: Types.ObjectId | string;
  allowedTools?: string[];
  deployment?: boolean;
  updatedAt?: Date;
};

type ListSkillsByAccessParams = {
  accessibleIds: Types.ObjectId[];
  category?: string;
  search?: string;
  limit: number;
  cursor?: string | null;
};

type ListSkillsByAccessResult = {
  skills: SkillSummaryRow[];
  has_more?: boolean;
  after?: string | null;
};

type ListAlwaysApplyParams = {
  accessibleIds: Types.ObjectId[];
  limit: number;
  cursor?: string | null;
};

type ListAlwaysApplyResult = {
  skills: AlwaysApplySkillRow[];
  has_more?: boolean;
  after?: string | null;
};

type SkillFileRow = Omit<
  DeploymentSkillFile,
  'codeEnvRef' | 'codeEnvRefs' | 'content' | 'isBinary'
> & {
  storageKey?: string;
  storageRegion?: string;
  tenantId?: string;
};

type SkillFileContentRow = SkillFileRow & {
  codeEnvRef?: CodeEnvRef;
  codeEnvRefs?: CodeEnvRefMap;
  content?: string;
  isBinary?: boolean;
};

export type DeploymentSkillBaseMethods = {
  getSkillById?: (id: SkillId) => Promise<SkillDetailRow | null>;
  getSkillByName?: (
    name: string,
    accessibleIds: Types.ObjectId[],
    options?: SkillLookupOptions,
  ) => Promise<SkillDetailRow | null>;
  listSkillsByAccess?: (params: ListSkillsByAccessParams) => Promise<ListSkillsByAccessResult>;
  listAlwaysApplySkills?: (params: ListAlwaysApplyParams) => Promise<ListAlwaysApplyResult>;
  listSkillFiles?: (skillId: SkillId) => Promise<SkillFileRow[]>;
  getSkillFileByPath?: (
    skillId: SkillId,
    relativePath: string,
  ) => Promise<SkillFileContentRow | null>;
  updateSkillFileContent?: (
    skillId: SkillId,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ) => Promise<void>;
  updateSkillFileCodeEnvIds?: (
    updates: Array<{ skillId: SkillId; relativePath: string; codeEnvRef: CodeEnvRef }>,
  ) => Promise<{ matchedCount: number; modifiedCount: number } | void>;
};

type Cursor = { updatedAt: Date; _id: Types.ObjectId };
type CollisionFilterResult<T> = {
  rows: T[];
};

type LoadDeploymentSkillsOptions = {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Skills contributed by Agent Plugins packages, which yield to the deployment directory on a name conflict. */
  additionalSkills?: DeploymentSkill[];
};

type DirectoryResolution = {
  directory: string;
  explicitlyConfigured: boolean;
};

export type LoadedSkillDirectory = {
  directory: string;
  relativeDirectory: string;
};

export type SkillIdentity = {
  /** Namespace for the deterministic skill id; keeps same-named skills from different sources distinct. */
  idNamespace?: string;
  /** Agent Plugins package that contributed the skill, when it came from one. */
  plugin?: string;
};

export class DeploymentSkillRegistry {
  private readonly skillsById = new Map<string, DeploymentSkill>();
  private readonly skillsByName = new Map<string, DeploymentSkill>();
  private readonly filesByPath = new Map<string, DeploymentSkillFile>();

  constructor(
    private readonly directory: string | null,
    skills: DeploymentSkill[],
  ) {
    for (const skill of skills) {
      this.skillsById.set(skill._id.toString(), skill);
      this.skillsByName.set(skill.name, skill);
      for (const file of skill.files) {
        this.filesByPath.set(file.filepath, file);
      }
    }
  }

  getDirectory(): string | null {
    return this.directory;
  }

  list(): DeploymentSkill[] {
    return Array.from(this.skillsById.values());
  }

  ids(): Types.ObjectId[] {
    return this.list().map((skill) => skill._id);
  }

  hasId(id: SkillId | undefined): boolean {
    return id != null && this.skillsById.has(id.toString());
  }

  getById(id: SkillId): DeploymentSkill | null {
    return this.skillsById.get(id.toString()) ?? null;
  }

  getByName(
    name: string,
    accessibleIds: Types.ObjectId[],
    _options?: SkillLookupOptions,
  ): DeploymentSkill | null {
    const skill = this.skillsByName.get(name);
    if (!skill) {
      return null;
    }
    if (!hasAccessibleId(accessibleIds, skill._id)) {
      return null;
    }
    return skill;
  }

  namesByAccess(accessibleIds: Types.ObjectId[]): Set<string> {
    const accessibleSet = new Set(accessibleIds.map((id) => id.toString()));
    const names = new Set<string>();
    for (const skill of this.list()) {
      if (accessibleSet.has(skill._id.toString())) {
        names.add(skill.name);
      }
    }
    return names;
  }

  listByAccess(params: ListSkillsByAccessParams): DeploymentSkill[] {
    const accessibleSet = new Set(params.accessibleIds.map((id) => id.toString()));
    const cursor = decodeCursor(params.cursor);
    const search = params.search?.toLowerCase();
    return this.list()
      .filter((skill) => accessibleSet.has(skill._id.toString()))
      .filter((skill) => !params.category || skill.category === params.category)
      .filter((skill) => {
        if (!search) {
          return true;
        }
        return (
          skill.name.toLowerCase().includes(search) ||
          skill.description.toLowerCase().includes(search) ||
          (skill.displayTitle?.toLowerCase().includes(search) ?? false)
        );
      })
      .filter((skill) => isAfterCursor(skill, cursor))
      .sort(compareBySkillCursor);
  }

  listAlwaysApply(params: ListAlwaysApplyParams): DeploymentSkill[] {
    const accessibleSet = new Set(params.accessibleIds.map((id) => id.toString()));
    const cursor = decodeCursor(params.cursor);
    return this.list()
      .filter((skill) => skill.alwaysApply === true)
      .filter((skill) => accessibleSet.has(skill._id.toString()))
      .filter((skill) => isAfterCursor(skill, cursor))
      .sort(compareBySkillCursor);
  }

  listFiles(skillId: SkillId): DeploymentSkillFile[] | null {
    const skill = this.getById(skillId);
    return skill ? [...skill.files] : null;
  }

  getFileByPath(skillId: SkillId, relativePath: string): DeploymentSkillFile | null {
    const skill = this.getById(skillId);
    if (!skill) {
      return null;
    }
    return skill.files.find((file) => file.relativePath === relativePath) ?? null;
  }

  hasFilePath(filepath: string): boolean {
    return this.filesByPath.has(filepath);
  }

  updateFileCodeEnvRefs(
    updates: Array<{ skillId: SkillId; relativePath: string; codeEnvRef: CodeEnvRef }>,
  ): Array<{ skillId: SkillId; relativePath: string; codeEnvRef: CodeEnvRef }> {
    const dbUpdates: Array<{ skillId: SkillId; relativePath: string; codeEnvRef: CodeEnvRef }> = [];
    for (const update of updates) {
      const file = this.getFileByPath(update.skillId, update.relativePath);
      if (!file) {
        dbUpdates.push(update);
        continue;
      }
      Object.assign(file, mergeCodeEnvRef(file, update.codeEnvRef));
    }
    return dbUpdates;
  }
}

let registry = new DeploymentSkillRegistry(null, []);
const warnedDeploymentNameCollisions = new Set<string>();

export function getDeploymentSkillRegistry(): DeploymentSkillRegistry {
  return registry;
}

export function getDeploymentSkillIds(): Types.ObjectId[] {
  return registry.ids();
}

export function mergeDeploymentSkillIds(ids: Array<SkillId>): Types.ObjectId[] {
  const seen = new Set<string>();
  const merged: Types.ObjectId[] = [];
  for (const id of [...ids, ...registry.ids()]) {
    const oid = typeof id === 'string' ? new Types.ObjectId(id) : id;
    const key = oid.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(oid);
  }
  return merged;
}

export function isDeploymentSkillId(id: SkillId | undefined): boolean {
  return registry.hasId(id);
}

export function isDeploymentSkillFileSource(source: unknown): boolean {
  return source === DEPLOYMENT_SKILL_FILE_SOURCE;
}

export function getDeploymentSkillById(id: SkillId): DeploymentSkill | null {
  return registry.getById(id);
}

export function isDeploymentSkillFilePath(filepath: string): boolean {
  return registry.hasFilePath(filepath);
}

export async function getDeploymentSkillDownloadStream(
  filepath: string,
): Promise<NodeJS.ReadableStream> {
  if (!registry.hasFilePath(filepath)) {
    throw new Error('Deployment skill file is not registered');
  }
  return fs.createReadStream(filepath);
}

export function updateDeploymentSkillFileCodeEnvRefs(
  updates: Array<{ skillId: SkillId; relativePath: string; codeEnvRef: CodeEnvRef }>,
): Array<{ skillId: SkillId; relativePath: string; codeEnvRef: CodeEnvRef }> {
  return registry.updateFileCodeEnvRefs(updates);
}

export function resolveDeploymentSkillDirectory(
  options: LoadDeploymentSkillsOptions = {},
): DirectoryResolution {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();
  const configured = env[DEPLOYMENT_SKILLS_DIR_ENV]?.trim();
  const rawDirectory =
    configured && configured.length > 0 ? configured : DEFAULT_DEPLOYMENT_SKILLS_DIR;
  return {
    directory: path.isAbsolute(rawDirectory)
      ? rawDirectory
      : path.resolve(projectRoot, rawDirectory),
    explicitlyConfigured: configured != null && configured.length > 0,
  };
}

export async function initializeDeploymentSkills(
  options: LoadDeploymentSkillsOptions = {},
): Promise<DeploymentSkillRegistry> {
  const resolved = resolveDeploymentSkillDirectory(options);
  registry = await loadDeploymentSkillsFromDirectory(resolved.directory, {
    projectRoot: options.projectRoot ?? process.cwd(),
    explicitlyConfigured: resolved.explicitlyConfigured,
    ...(options.additionalSkills !== undefined && { additionalSkills: options.additionalSkills }),
  });
  const count = registry.list().length;
  if (count > 0) {
    logger.info(
      `[deploymentSkills] Loaded ${count} deployment skill(s) from ${registry.getDirectory()}`,
    );
  } else {
    logger.debug(`[deploymentSkills] No deployment skills loaded from ${resolved.directory}`);
  }
  return registry;
}

/**
 * Plugin-contributed skills yield to the deployment directory on a name
 * conflict: the operator's own `skill/` tree is the more specific source, and a
 * conflict must not fail startup the way a duplicate inside that tree does.
 */
function appendPluginSkills(
  skills: DeploymentSkill[],
  additionalSkills: DeploymentSkill[],
): DeploymentSkill[] {
  const claimed = new Set(skills.map((skill) => skill.name));
  const accepted: DeploymentSkill[] = [];
  for (const skill of additionalSkills) {
    if (claimed.has(skill.name)) {
      logger.warn(
        `[deploymentSkills] Plugin skill "${skill.name}" conflicts with a deployment skill and was skipped`,
      );
      continue;
    }
    claimed.add(skill.name);
    accepted.push(skill);
  }
  return accepted;
}

export async function loadDeploymentSkillsFromDirectory(
  directory: string,
  options: {
    projectRoot?: string;
    explicitlyConfigured?: boolean;
    additionalSkills?: DeploymentSkill[];
  } = {},
): Promise<DeploymentSkillRegistry> {
  const additionalSkills = options.additionalSkills ?? [];
  let rootStat: fs.Stats;
  try {
    rootStat = await fs.promises.stat(directory);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      options.explicitlyConfigured !== true
    ) {
      return new DeploymentSkillRegistry(directory, additionalSkills);
    }
    throw new Error(`Deployment skills directory not found: ${directory}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Deployment skills path must be a directory: ${directory}`);
  }

  const skillDirectories = await findSkillDirectories(directory, options.projectRoot ?? directory);
  const skills = await Promise.all(
    skillDirectories.map((skillDirectory) => loadSkillFromDirectory(skillDirectory, directory)),
  );
  validateUniqueNames(skills);
  const merged = [...skills, ...appendPluginSkills(skills, additionalSkills)];
  return new DeploymentSkillRegistry(directory, merged.sort(compareBySkillCursor));
}

export function createDeploymentSkillMethods<T extends DeploymentSkillBaseMethods>(
  base: T,
): T & Required<Pick<DeploymentSkillBaseMethods, 'getSkillById'>> {
  const methods = {
    ...base,
    getSkillById: async (id: SkillId): Promise<SkillDetailRow | null> => {
      const deployment = registry.getById(id);
      if (deployment) {
        return toSkillDetailRow(deployment);
      }
      return base.getSkillById ? base.getSkillById(id) : null;
    },
    getSkillByName: async (
      name: string,
      accessibleIds: Types.ObjectId[],
      options?: SkillLookupOptions,
    ): Promise<SkillDetailRow | null> => {
      const deployment = registry.getByName(name, accessibleIds, options);
      if (deployment) {
        return toSkillDetailRow(deployment);
      }
      const dbSkill = base.getSkillByName
        ? await base.getSkillByName(name, stripDeploymentIds(accessibleIds), options)
        : null;
      return dbSkill;
    },
    listSkillsByAccess: async (
      params: ListSkillsByAccessParams,
    ): Promise<ListSkillsByAccessResult> => {
      const dbResult = base.listSkillsByAccess
        ? await base.listSkillsByAccess({
            ...params,
            accessibleIds: stripDeploymentIds(params.accessibleIds),
          })
        : { skills: [], has_more: false, after: null };
      const deploymentNames = registry.namesByAccess(params.accessibleIds);
      const filteredDb = filterDeploymentNameCollisions(dbResult.skills, deploymentNames, 'list');
      const dbPageBoundary = getDbPageBoundary(dbResult);
      const deploymentRows = limitRowsToDbPageBoundary(
        registry.listByAccess(params).map(toSkillSummaryRow),
        dbPageBoundary,
      );
      return mergeSkillPage({
        dbResult: {
          ...dbResult,
          skills: filteredDb.rows,
        },
        dbPageBoundary,
        deploymentRows,
        limit: params.limit,
      });
    },
    listAlwaysApplySkills: async (
      params: ListAlwaysApplyParams,
    ): Promise<ListAlwaysApplyResult> => {
      const dbResult = base.listAlwaysApplySkills
        ? await base.listAlwaysApplySkills({
            ...params,
            accessibleIds: stripDeploymentIds(params.accessibleIds),
          })
        : { skills: [], has_more: false, after: null };
      const deploymentNames = registry.namesByAccess(params.accessibleIds);
      const filteredDb = filterDeploymentNameCollisions(
        dbResult.skills,
        deploymentNames,
        'always-apply',
      );
      const dbPageBoundary = getDbPageBoundary(dbResult);
      return mergeAlwaysApplyPage({
        dbResult: {
          ...dbResult,
          skills: filteredDb.rows,
        },
        dbPageBoundary,
        deploymentRows: limitRowsToDbPageBoundary(
          registry.listAlwaysApply(params).map(toAlwaysApplyRow),
          dbPageBoundary,
        ),
        limit: params.limit,
      });
    },
    listSkillFiles: async (skillId: SkillId): Promise<SkillFileRow[]> => {
      const deploymentFiles = registry.listFiles(skillId);
      if (deploymentFiles) {
        return deploymentFiles.map(toSkillFileRow);
      }
      return base.listSkillFiles ? base.listSkillFiles(skillId) : [];
    },
    getSkillFileByPath: async (
      skillId: SkillId,
      relativePath: string,
    ): Promise<SkillFileContentRow | null> => {
      const deploymentFile = registry.getFileByPath(skillId, relativePath);
      if (deploymentFile) {
        return toSkillFileContentRow(deploymentFile);
      }
      return base.getSkillFileByPath ? base.getSkillFileByPath(skillId, relativePath) : null;
    },
    updateSkillFileContent: async (
      skillId: SkillId,
      relativePath: string,
      update: { content?: string; isBinary?: boolean },
      expectedFileId?: string,
    ): Promise<void> => {
      const deploymentFile = registry.getFileByPath(skillId, relativePath);
      if (deploymentFile) {
        if (update.content !== undefined) {
          deploymentFile.content = update.content;
        }
        if (update.isBinary !== undefined) {
          deploymentFile.isBinary = update.isBinary;
        }
        return;
      }
      if (base.updateSkillFileContent) {
        await base.updateSkillFileContent(skillId, relativePath, update, expectedFileId);
      }
    },
    updateSkillFileCodeEnvIds: async (
      updates: Array<{ skillId: SkillId; relativePath: string; codeEnvRef: CodeEnvRef }>,
    ): Promise<{ matchedCount: number; modifiedCount: number } | void> => {
      const dbUpdates = registry.updateFileCodeEnvRefs(updates);
      if (dbUpdates.length === 0) {
        return { matchedCount: updates.length, modifiedCount: updates.length };
      }
      return base.updateSkillFileCodeEnvIds
        ? base.updateSkillFileCodeEnvIds(dbUpdates)
        : { matchedCount: 0, modifiedCount: 0 };
    },
  };
  return methods as T & Required<Pick<DeploymentSkillBaseMethods, 'getSkillById'>>;
}

async function findSkillDirectories(
  directory: string,
  projectRoot: string,
): Promise<LoadedSkillDirectory[]> {
  const directories: LoadedSkillDirectory[] = [];
  if (await fileExists(path.join(directory, SKILL_MD))) {
    directories.push({
      directory,
      relativeDirectory: relativeToRoot(projectRoot, directory),
    });
  }

  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const childDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
  const childSkillChecks = await Promise.all(
    childDirectories.map(async (child) =>
      (await fileExists(path.join(child, SKILL_MD)))
        ? {
            directory: child,
            relativeDirectory: relativeToRoot(projectRoot, child),
          }
        : null,
    ),
  );
  for (const child of childSkillChecks) {
    if (child) {
      directories.push(child);
    }
  }
  return directories;
}

/**
 * Loads one `SKILL.md` directory into a deployment skill. Shared by the
 * deployment skills directory and Agent Plugins packages, which differ only in
 * how the skill is identified and attributed.
 */
export async function loadSkillFromDirectory(
  skillDirectory: LoadedSkillDirectory,
  rootDirectory: string,
  identity: SkillIdentity = {},
): Promise<DeploymentSkill> {
  const skillMdPath = path.join(skillDirectory.directory, SKILL_MD);
  const [content, stat] = await Promise.all([
    fs.promises.readFile(skillMdPath, 'utf8'),
    fs.promises.stat(skillMdPath),
  ]);
  const parsed = parseFrontmatter(content);
  const structured = parseStructuredFrontmatter(content);
  if ('error' in structured) {
    throw new Error(`${skillDirectory.relativeDirectory}/${SKILL_MD}: ${structured.error}`);
  }
  const frontmatter = structured.frontmatter ?? {};
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description : parsed.description;
  const name = typeof frontmatter.name === 'string' ? frontmatter.name : parsed.name;
  const issues: ValidationIssue[] = [
    ...validateSkillName(name),
    ...validateSkillDescription(description),
    ...validateSkillBody(content),
    ...validateSkillFrontmatter(frontmatter),
  ];
  if (parsed.invalidBooleans.length > 0) {
    issues.push(
      ...parsed.invalidBooleans.map((key) => ({
        field: `frontmatter.${key}`,
        code: 'INVALID_TYPE',
        message: `"${key}" must be a boolean (true or false)`,
      })),
    );
  }
  const { errors, warnings } = partitionIssues(issues);
  if (errors.length > 0) {
    throw new Error(
      `${skillDirectory.relativeDirectory}/${SKILL_MD}: ${errors
        .map((issue) => `${issue.field}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  if (warnings.length > 0) {
    logger.warn(
      `[deploymentSkills] ${skillDirectory.relativeDirectory}/${SKILL_MD}: ${warnings
        .map((issue) => `${issue.field}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const derived = deriveStructuredFrontmatterFields(frontmatter);
  const skillId = stableObjectId(`${identity.idNamespace ?? 'deployment-skill'}:${name}`);
  const files = await loadDeploymentSkillFiles({
    skillId,
    skillName: name,
    skillDirectory: skillDirectory.directory,
    rootDirectory,
  });
  return {
    _id: skillId,
    name,
    description,
    body: content,
    frontmatter,
    category: '',
    author: getDeploymentAuthorId(),
    authorName: 'Deployment',
    version: 1,
    source: DEPLOYMENT_SKILL_SOURCE,
    sourceMetadata: {
      deployment: true,
      directory: skillDirectory.relativeDirectory,
      ...(identity.plugin !== undefined && { plugin: identity.plugin }),
    },
    fileCount: files.length,
    alwaysApply: parsed.alwaysApply ?? false,
    isPublic: true,
    deployment: true,
    files,
    createdAt: stat.birthtime,
    updatedAt: stat.mtime,
    ...derived,
  };
}

async function loadDeploymentSkillFiles({
  skillId,
  skillName,
  skillDirectory,
  rootDirectory,
}: {
  skillId: Types.ObjectId;
  skillName: string;
  skillDirectory: string;
  rootDirectory: string;
}): Promise<DeploymentSkillFile[]> {
  const files = await collectSkillFiles(skillDirectory, skillDirectory);
  const rows = await Promise.all(
    files.map(async (filePath) => {
      const relativePath = normalizePath(path.relative(skillDirectory, filePath));
      const issues = validateRelativePath(relativePath);
      if (issues.length > 0) {
        throw new Error(
          `${relativeToRoot(rootDirectory, filePath)}: ${issues
            .map((issue) => `${issue.field}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      const stat = await fs.promises.stat(filePath);
      const mimeType = guessMimeType(relativePath);
      const cache = await readCachedFileContent(filePath, stat.size);
      return {
        _id: stableObjectId(`deployment-skill-file:${skillName}:${relativePath}`),
        skillId,
        relativePath,
        file_id: stableObjectId(`deployment-skill-file-id:${skillName}:${relativePath}`).toString(),
        filename: path.basename(relativePath),
        filepath: filePath,
        source: DEPLOYMENT_SKILL_FILE_SOURCE,
        mimeType,
        bytes: stat.size,
        category: inferSkillFileCategory(relativePath),
        isExecutable: false,
        author: getDeploymentAuthorId(),
        createdAt: stat.birthtime,
        updatedAt: stat.mtime,
        ...cache,
      } satisfies DeploymentSkillFile;
    }),
  );
  return rows.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function collectSkillFiles(root: string, directory: string): Promise<string[]> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const relativePath = normalizePath(path.relative(root, filePath));
      if (relativePath === SKILL_MD) {
        return [];
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`${relativePath}: symlinks are not allowed in deployment skills`);
      }
      if (entry.isDirectory()) {
        return collectSkillFiles(root, filePath);
      }
      if (!entry.isFile()) {
        return [];
      }
      return [filePath];
    }),
  );
  return results.flat();
}

async function readCachedFileContent(
  filePath: string,
  bytes: number,
): Promise<Pick<DeploymentSkillFile, 'content' | 'isBinary'>> {
  const file = await fs.promises.open(filePath, 'r');
  try {
    const probe = Buffer.alloc(Math.min(bytes, 8192));
    if (probe.length > 0) {
      await file.read(probe, 0, probe.length, 0);
    }
    if (probe.includes(0)) {
      return { isBinary: true };
    }
  } finally {
    await file.close();
  }
  if (bytes > MAX_CACHED_TEXT_BYTES) {
    return { isBinary: false };
  }
  return {
    isBinary: false,
    content: await fs.promises.readFile(filePath, 'utf8'),
  };
}

function parseStructuredFrontmatter(
  content: string,
): { frontmatter?: Record<string, unknown>; error?: undefined } | { error: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {} };
  }
  const after = trimmed.slice(3);
  const closingIdx = after.indexOf('\n---');
  if (closingIdx === -1) {
    return { error: `Invalid ${SKILL_MD} frontmatter: missing closing "---".` };
  }
  try {
    const parsed = yaml.load(after.slice(0, closingIdx));
    if (parsed == null) {
      return { frontmatter: {} };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `${SKILL_MD} frontmatter must be a YAML mapping.` };
    }
    const normalized = normalizeSkillFrontmatterKeys(parsed as Record<string, unknown>);
    if ('error' in normalized) {
      return { error: `Invalid ${SKILL_MD} frontmatter: ${normalized.error}` };
    }
    return { frontmatter: normalized.frontmatter };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `Invalid ${SKILL_MD} frontmatter: ${message}` };
  }
}

function validateUniqueNames(skills: DeploymentSkill[]): void {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.name)) {
      throw new Error(`Duplicate deployment skill name "${skill.name}"`);
    }
    seen.add(skill.name);
  }
}

function mergeSkillPage({
  dbResult,
  dbPageBoundary,
  deploymentRows,
  limit,
}: {
  dbResult: ListSkillsByAccessResult;
  dbPageBoundary?: Cursor | null;
  deploymentRows: SkillSummaryRow[];
  limit: number;
}): ListSkillsByAccessResult {
  const boundedLimit = Math.min(Math.max(1, limit || 20), 100);
  const merged = [...deploymentRows, ...dbResult.skills].sort(compareBySkillCursor);
  const sliced = merged.slice(0, boundedLimit);
  const hasMore = merged.length > boundedLimit || dbResult.has_more === true;
  const cursorRow = getMergedPageCursor(sliced, boundedLimit, dbPageBoundary);
  return {
    skills: sliced,
    has_more: hasMore,
    after: hasMore && cursorRow ? encodeCursor(cursorRow) : null,
  };
}

function mergeAlwaysApplyPage({
  dbResult,
  dbPageBoundary,
  deploymentRows,
  limit,
}: {
  dbResult: ListAlwaysApplyResult;
  dbPageBoundary?: Cursor | null;
  deploymentRows: AlwaysApplySkillRow[];
  limit: number;
}): ListAlwaysApplyResult {
  const boundedLimit = Math.min(Math.max(1, limit || 20), 100);
  const merged = [...deploymentRows, ...dbResult.skills].sort(compareBySkillCursor);
  const sliced = merged.slice(0, boundedLimit);
  const hasMore = merged.length > boundedLimit || dbResult.has_more === true;
  const cursorRow = getMergedPageCursor(sliced, boundedLimit, dbPageBoundary);
  return {
    skills: sliced,
    has_more: hasMore,
    after: hasMore && cursorRow ? encodeCursor(cursorRow) : null,
  };
}

function getMergedPageCursor<T extends Pick<SkillSummaryRow, '_id' | 'updatedAt'>>(
  sliced: T[],
  boundedLimit: number,
  dbPageBoundary?: Cursor | null,
): Pick<SkillSummaryRow, '_id' | 'updatedAt'> | null {
  const lastReturned = sliced.length > 0 ? sliced[sliced.length - 1] : null;
  if (sliced.length < boundedLimit && dbPageBoundary) {
    return dbPageBoundary;
  }
  return lastReturned;
}

function getDbPageBoundary<T extends Pick<SkillSummaryRow, '_id' | 'updatedAt'>>(dbResult: {
  skills: T[];
  has_more?: boolean;
  after?: string | null;
}): Cursor | null {
  if (dbResult.has_more !== true) {
    return null;
  }
  const last = dbResult.skills.length > 0 ? dbResult.skills[dbResult.skills.length - 1] : null;
  if (last?.updatedAt) {
    return { _id: last._id, updatedAt: last.updatedAt };
  }
  return decodeCursor(dbResult.after);
}

function limitRowsToDbPageBoundary<T extends Pick<SkillSummaryRow, '_id' | 'updatedAt'>>(
  rows: T[],
  dbPageBoundary: Cursor | null,
): T[] {
  if (!dbPageBoundary) {
    return rows;
  }
  return rows.filter((row) => compareBySkillCursor(row, dbPageBoundary) <= 0);
}

function toSkillSummaryRow(skill: DeploymentSkill): SkillSummaryRow {
  const { body: _body, frontmatter: _frontmatter, files: _files, ...row } = skill;
  return row;
}

function toSkillDetailRow(skill: DeploymentSkill): SkillDetailRow {
  const { files: _files, ...row } = skill;
  return row;
}

function toAlwaysApplyRow(skill: DeploymentSkill): AlwaysApplySkillRow {
  return {
    _id: skill._id,
    name: skill.name,
    body: skill.body,
    author: skill.author,
    deployment: true,
    updatedAt: skill.updatedAt,
    ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
  };
}

function toSkillFileRow(file: DeploymentSkillFile): SkillFileRow {
  const {
    codeEnvRef: _codeEnvRef,
    codeEnvRefs: _codeEnvRefs,
    content: _content,
    isBinary: _isBinary,
    ...row
  } = file;
  return row;
}

function toSkillFileContentRow(file: DeploymentSkillFile): SkillFileContentRow {
  return {
    ...toSkillFileRow(file),
    codeEnvRef: file.codeEnvRef,
    codeEnvRefs: file.codeEnvRefs,
    content: file.content,
    isBinary: file.isBinary,
  };
}

function stripDeploymentIds(ids: Types.ObjectId[]): Types.ObjectId[] {
  return ids.filter((id) => !registry.hasId(id));
}

function hasAccessibleId(ids: Types.ObjectId[], skillId: Types.ObjectId): boolean {
  const key = skillId.toString();
  return ids.some((id) => id.toString() === key);
}

function filterDeploymentNameCollisions<
  T extends { name: string } & Pick<SkillSummaryRow, '_id' | 'updatedAt'>,
>(rows: T[], deploymentNames: Set<string>, context: string): CollisionFilterResult<T> {
  if (rows.length === 0 || deploymentNames.size === 0) {
    return { rows };
  }
  const hiddenNames = new Set<string>();
  const filtered = rows.filter((row) => {
    if (!deploymentNames.has(row.name)) {
      return true;
    }
    hiddenNames.add(row.name);
    return false;
  });
  if (hiddenNames.size > 0) {
    const unwarnedNames = Array.from(hiddenNames).filter((name) => {
      const key = `${context}:${name}`;
      if (warnedDeploymentNameCollisions.has(key)) {
        return false;
      }
      warnedDeploymentNameCollisions.add(key);
      return true;
    });
    if (unwarnedNames.length > 0) {
      logger.warn(
        `[deploymentSkills] Hid persisted ${context} skill row(s) shadowed by deployment skill name(s): ${unwarnedNames.join(', ')}`,
      );
    }
  }
  return { rows: filtered };
}

function compareBySkillCursor(
  a: Pick<SkillSummaryRow, '_id' | 'updatedAt'>,
  b: Pick<SkillSummaryRow, '_id' | 'updatedAt'>,
): number {
  const aTime = (a.updatedAt ?? new Date(0)).getTime();
  const bTime = (b.updatedAt ?? new Date(0)).getTime();
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  return a._id.toString().localeCompare(b._id.toString());
}

function isAfterCursor(row: Pick<SkillSummaryRow, '_id' | 'updatedAt'>, cursor: Cursor | null) {
  if (!cursor) {
    return true;
  }
  const rowTime = (row.updatedAt ?? new Date(0)).getTime();
  const cursorTime = cursor.updatedAt.getTime();
  if (rowTime < cursorTime) {
    return true;
  }
  if (rowTime > cursorTime) {
    return false;
  }
  return row._id.toString() > cursor._id.toString();
}

function decodeCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor || cursor === 'undefined' || cursor === 'null') {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
      updatedAt?: string;
      _id?: string;
    };
    if (!decoded.updatedAt || !decoded._id || !Types.ObjectId.isValid(decoded._id)) {
      return null;
    }
    const updatedAt = new Date(decoded.updatedAt);
    if (Number.isNaN(updatedAt.getTime())) {
      return null;
    }
    return { updatedAt, _id: new Types.ObjectId(decoded._id) };
  } catch {
    return null;
  }
}

function encodeCursor(row: Pick<SkillSummaryRow, '_id' | 'updatedAt'>): string {
  return Buffer.from(
    JSON.stringify({
      updatedAt: (row.updatedAt ?? new Date(0)).toISOString(),
      _id: row._id.toString(),
    }),
  ).toString('base64');
}

function stableObjectId(seed: string): Types.ObjectId {
  return new Types.ObjectId(crypto.createHash('sha1').update(seed).digest('hex').slice(0, 24));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}

function relativeToRoot(root: string, target: string): string {
  const relative = normalizePath(path.relative(root, target));
  return relative.length > 0 ? relative : '.';
}
