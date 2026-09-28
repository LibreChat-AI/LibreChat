import { z } from 'zod';
import { logger, ResourceCapabilityMap, validateRelativePath } from '@librechat/data-schemas';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  ResourceType,
} from 'librechat-data-provider';
import type { SkillFrontmatterValue, TSkill, TUpdateSkillPayload } from 'librechat-data-provider';
import type { Request, Response, RequestHandler } from 'express';
import type { SkillsHandlers, SkillsHandlersDeps } from './handlers';
import type { AgentManagementReadDeps } from '../agents/reads';
import type { ServerRequest } from '~/types';
import { agentManagementListSchema, mapAgentManagementError } from '../agents/management';
import { isContentFilterError } from '../middleware/contentFilter';
import { checkAccessWithRequestCache } from '../middleware/access';
import { assertSkillFileContentAllowed } from './protection';
import { getDeploymentSkillById } from './deployment';
import { resolveSkillFilePathParam } from './path';

const idSchema = z.string().regex(/^[a-f\d]{24}$/i);
const fields = {
  name: z.string(),
  displayTitle: z.string().optional(),
  description: z.string(),
  category: z.string().optional(),
  alwaysApply: z.boolean().optional(),
};
export const skillFrontmatterValueSchema: z.ZodType<SkillFrontmatterValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(skillFrontmatterValueSchema),
    z.record(skillFrontmatterValueSchema),
  ]),
);
export type SkillManagementUpdate = TUpdateSkillPayload & { expectedVersion: number };

export const skillManagementUpdateSchema: z.ZodType<SkillManagementUpdate> = z
  .object({
    name: fields.name.optional(),
    displayTitle: fields.displayTitle,
    description: fields.description.optional(),
    category: fields.category,
    alwaysApply: fields.alwaysApply,
    body: z.string().optional(),
    frontmatter: z.record(skillFrontmatterValueSchema).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 1, 'At least one update field is required');

export const skillSummarySchema: z.AnyZodObject = z.object({
  ...fields,
  id: idSchema,
  version: z.number().int().positive(),
  fileCount: z.number().int().nonnegative(),
  disableModelInvocation: z.boolean().optional(),
  userInvocable: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SkillManagementResponse = Pick<
  TSkill,
  | 'name'
  | 'displayTitle'
  | 'description'
  | 'category'
  | 'alwaysApply'
  | 'version'
  | 'fileCount'
  | 'disableModelInvocation'
  | 'userInvocable'
  | 'allowedTools'
  | 'createdAt'
  | 'updatedAt'
  | 'body'
  | 'frontmatter'
> & { id: string };

export const skillManagementResponseSchema: z.ZodType<SkillManagementResponse> = z.object({
  ...fields,
  id: idSchema,
  version: z.number().int().positive(),
  fileCount: z.number().int().nonnegative(),
  disableModelInvocation: z.boolean().optional(),
  userInvocable: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  body: z.string(),
  frontmatter: z.record(skillFrontmatterValueSchema).optional(),
});
export const skillFileSchema: z.AnyZodObject = z.object({
  relativePath: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().nonnegative(),
});
export const skillFileContentSchema: z.AnyZodObject = skillFileSchema.extend({
  content: z.string().optional(),
  isBinary: z.boolean(),
});
export const skillFileUpdateSchema: z.AnyZodObject = z
  .object({ content: z.string().max(1024 * 1024) })
  .strict();
const listSchema = agentManagementListSchema;

type ManagementRequest = Request &
  Pick<ServerRequest, 'user' | 'config'> & {
    resourceAccess?: {
      resourceInfo: NonNullable<Awaited<ReturnType<SkillsHandlersDeps['getSkillById']>>>;
    };
  };

type SkillHandler = (req: ServerRequest, res: Response) => Promise<Response | undefined>;
type Projector = (body: unknown) => object;
export interface SkillManagementDeps {
  handlers: SkillsHandlers;
  beforeList?: (req: ServerRequest) => Promise<void>;
  fileWriteLimiters?: RequestHandler[];
  getSkillById: SkillsHandlersDeps['getSkillById'];
  getRoleByName: AgentManagementReadDeps['getRoleByName'];
  checkPermission: AgentManagementReadDeps['checkPermission'];
  hasCapability: AgentManagementReadDeps['hasCapability'];
  saveFile: (input: {
    req: ServerRequest;
    skillId: string;
    relativePath: string;
    content: string;
    mimeType: string;
  }) => Promise<{ relativePath: string; bytes: number }>;
}

function projectSkill(body: unknown, detail: boolean): object {
  const source = z.object({ _id: idSchema }).passthrough().parse(body);
  return (detail ? skillManagementResponseSchema : skillSummarySchema).parse({
    ...source,
    id: source._id,
  });
}
function sendError(
  res: Response,
  code: Parameters<typeof mapAgentManagementError>[0],
  error?: unknown,
) {
  const mapped = mapAgentManagementError(code, error);
  if (code === 'not_found') mapped.body.error.message = 'Skill or file not found';
  return res.status(mapped.status).json(mapped.body);
}

/** Keep browser errors and persistence fields behind the versioned management contract. */
async function runHandler(
  req: ManagementRequest,
  res: Response,
  handler: SkillHandler,
  project: Projector,
) {
  let status = 200;
  let sent = false;
  const adapter = Object.create(res) as Response;
  adapter.status = (value: number) => {
    status = value;
    return adapter;
  };
  adapter.json = (body: unknown) => {
    sent = true;
    if (status >= 200 && status < 300) return res.status(status).json(project(body));
    if (status === 409) return sendError(res, 'conflict');
    if (status === 404) return sendError(res, 'not_found');
    if (status === 400) return sendError(res, 'invalid_request');
    if (status === 401 || status === 403) return sendError(res, 'permission_denied');
    return sendError(res, 'internal_error');
  };
  await handler(req as ServerRequest, adapter);
  return sent ? res : sendError(res, 'internal_error');
}

/** Wait for limiter admission or a terminal response; release listeners on every outcome. */
async function admitFileWrite(req: Request, res: Response, limiters: RequestHandler[]) {
  for (const limiter of limiters) {
    const admitted = await new Promise<boolean>((resolve, reject) => {
      const finish = () => settle(false);
      const settle = (allowed: boolean, error?: unknown) => {
        res.off('finish', finish);
        res.off('close', finish);
        if (error) reject(error);
        else resolve(allowed);
      };
      if (res.writableEnded || res.destroyed) return settle(false);
      res.once('finish', finish);
      res.once('close', finish);
      try {
        Promise.resolve(limiter(req, res, (error) => settle(!error, error))).catch((error) =>
          settle(false, error),
        );
      } catch (error) {
        settle(false, error);
      }
    });
    if (!admitted) return false;
  }
  return !res.writableEnded && !res.destroyed;
}

/** Machine API adapters reuse the browser Skills behavior after principal and resource checks. */
export function createSkillManagementHandlers(
  deps: SkillManagementDeps,
): Record<
  'list' | 'get' | 'update' | 'listFiles' | 'getFile' | 'updateFile',
  (request: Request, res: Response) => Promise<Response>
> {
  async function canManageSkills(req: ManagementRequest): Promise<boolean> {
    if (!req.user) return false;
    const capability = ResourceCapabilityMap[ResourceType.SKILL];
    try {
      return capability != null && (await deps.hasCapability(req.user, capability));
    } catch {
      return false;
    }
  }
  function wrap(
    permission: PermissionBits | undefined,
    operation: (req: ManagementRequest, res: Response) => Promise<Response>,
  ) {
    return async (request: Request, res: Response): Promise<Response> => {
      const req = request as ManagementRequest;
      try {
        if (!req.user?.id || !req.user.tenantId) return sendError(res, 'permission_denied');
        const editing = permission === PermissionBits.EDIT;
        const allowed = await checkAccessWithRequestCache({
          req,
          user: req.user,
          permissionType: PermissionTypes.SKILLS,
          permissions: editing ? [Permissions.USE, Permissions.CREATE] : [Permissions.USE],
          getRoleByName: deps.getRoleByName,
        });
        if (!allowed) return sendError(res, 'permission_denied');
        if (permission !== undefined) {
          if (!idSchema.safeParse(req.params.id).success) return sendError(res, 'not_found');
          const [skill, canManage] = await Promise.all([
            deps.getSkillById(req.params.id),
            canManageSkills(req),
          ]);
          const deployment = getDeploymentSkillById(req.params.id);
          if (!skill || (!deployment && skill.tenantId !== req.user.tenantId))
            return sendError(res, 'not_found');
          if (
            !deployment &&
            !canManage &&
            !(await deps.checkPermission({
              userId: req.user.id,
              role: req.user.role,
              resourceType: ResourceType.SKILL,
              resourceId: skill._id,
              requiredPermission: permission,
            }))
          )
            return sendError(res, 'not_found');
          if (editing && (deployment || skill.source !== 'inline'))
            return sendError(res, 'permission_denied');
          req.resourceAccess = { resourceInfo: skill };
        }
        return await operation(req, res);
      } catch (error) {
        logger.error('[SkillManagement] Request failed', error);
        return sendError(res, 'internal_error');
      }
    };
  }
  return {
    list: wrap(undefined, async (req, res) => {
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) return sendError(res, 'invalid_request', parsed.error);
      try {
        await deps.beforeList?.(req as ServerRequest);
      } catch (error) {
        logger.error('[SkillManagement] Failed to start request-scoped skill sync', error);
      }
      const manageTenantId = (await canManageSkills(req)) ? req.user?.tenantId : undefined;
      return runHandler(
        req,
        res,
        (request, response) =>
          deps.handlers.list(request, response, {
            ...parsed.data,
            manageTenantId,
          }),
        (body) => {
          const result = z
            .object({
              skills: z.array(z.unknown()),
              has_more: z.boolean(),
              after: z.string().nullable(),
            })
            .parse(body);
          const data = result.skills.map((skill) => projectSkill(skill, false));
          const ids = result.skills.map((skill) => z.object({ _id: idSchema }).parse(skill)._id);
          return {
            object: 'list',
            data,
            first_id: ids[0] ?? null,
            last_id: ids[ids.length - 1] ?? null,
            has_more: result.has_more,
            after: result.after,
          };
        },
      );
    }),
    get: wrap(PermissionBits.VIEW, (req, res) =>
      runHandler(
        req,
        res,
        (request, response) => deps.handlers.get(request, response, { includePublicStatus: false }),
        (body) => projectSkill(body, true),
      ),
    ),
    update: wrap(PermissionBits.EDIT, async (req, res) => {
      const parsed = skillManagementUpdateSchema.safeParse(req.body);
      if (!parsed.success) return sendError(res, 'invalid_request', parsed.error);
      req.body = parsed.data;
      return runHandler(
        req,
        res,
        (request, response) =>
          deps.handlers.patch(request, response, { includePublicStatus: false }),
        (body) => projectSkill(body, true),
      );
    }),
    listFiles: wrap(PermissionBits.VIEW, (req, res) =>
      runHandler(req, res, deps.handlers.listFiles, (body) => ({
        object: 'list',
        data: z.object({ files: z.array(skillFileSchema) }).parse(body).files,
      })),
    ),
    getFile: wrap(PermissionBits.VIEW, async (req, res) => {
      if (Object.keys(req.query).length > 0) return sendError(res, 'invalid_request');
      return runHandler(req, res, deps.handlers.downloadFile, (body) =>
        skillFileContentSchema.parse(body),
      );
    }),
    updateFile: wrap(PermissionBits.EDIT, async (req, res) => {
      const parsed = skillFileUpdateSchema.safeParse(req.body);
      if (!parsed.success) return sendError(res, 'invalid_request', parsed.error);
      const relativePath = resolveSkillFilePathParam(req.params.relativePath);
      if (relativePath == null || validateRelativePath(relativePath).length > 0)
        return sendError(res, 'invalid_request');
      const buffer = Buffer.from(parsed.data.content, 'utf8');
      if (buffer.length > 1024 * 1024 || buffer.includes(0))
        return sendError(res, 'invalid_request');
      try {
        assertSkillFileContentAllowed(req.config?.filters, {
          buffer,
          originalName: relativePath,
          relativePath,
        });
      } catch (error) {
        if (!isContentFilterError(error)) throw error;
        return sendError(res, 'invalid_request');
      }
      if (!(await admitFileWrite(req, res, deps.fileWriteLimiters ?? []))) return res;
      try {
        const result = await deps.saveFile({
          req: req as ServerRequest,
          skillId: req.params.id,
          relativePath,
          content: parsed.data.content,
          mimeType: 'text/plain',
        });
        return res.status(200).json({ relativePath: result.relativePath, bytes: result.bytes });
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'SKILL_FILE_CONFLICT') {
          return sendError(res, 'conflict');
        }
        throw error;
      }
    }),
  };
}
