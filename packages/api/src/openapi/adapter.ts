import { z } from 'zod';
import { createDocument } from 'zod-openapi';
import type { ZodTypeAny } from 'zod';

/**
 * The seam. This is the only file that imports the Zod-to-OpenAPI converter.
 * If we replace the converter, only this file changes.
 */

export type SecurityScheme = {
  type: string;
  scheme?: string;
  bearerFormat?: string;
  description?: string;
};

/** A media-type object written by hand, for requests or responses that have no Zod schema. */
export type RawContent = Record<string, { schema: Record<string, unknown> }>;

export type ResponseContract = {
  status: number;
  description: string /** A Zod schema. When it is also listed in `componentSchemas`, the document uses a `$ref`. */;
  schema?: ZodTypeAny;
  /** A hand-written media-type object, used when there is no Zod schema. */
  content?: RawContent;
  /** Hand-written media types added alongside a generated JSON schema. */
  additionalContent?: RawContent;
};

export type EndpointContract = {
  operationId: string;
  method: 'get' | 'post' | 'patch' | 'delete' | 'put';
  /** OpenAPI-style path, relative to the server base, e.g. `/agents/{id}`. */
  path: string;
  tags: string[];
  summary: string;
  description?: string;
  /** Names of the security schemes that apply to this endpoint. */
  security: string[];
  pathParams?: { name: string; description?: string }[];
  /** An object schema whose fields become query parameters. */
  query?: ZodTypeAny;
  /** A JSON request body. When it is also listed in `componentSchemas`, the document uses a `$ref`. */
  body?: ZodTypeAny;
  /** A hand-written request body, used for multipart uploads. */
  rawBody?: { description?: string; required?: boolean; content: RawContent };
  responses: ResponseContract[];
};

export type OpenApiInput = {
  info: { title: string; version: string; description?: string };
  servers: { url: string; description?: string }[];
  securitySchemes: Record<string, SecurityScheme>;
  /** Named schemas that become reusable `#/components/schemas` entries. */
  componentSchemas: Record<string, ZodTypeAny>;
  /**
   * Extra OpenAPI keywords merged into a generated component schema, keyed by component name.
   * Use this for constraints the converter cannot express, such as an object-level `.refine()`.
   */
  componentSchemaOverrides?: Record<string, Record<string, unknown>>;
  contracts: EndpointContract[];
};

function buildResponses(responses: ResponseContract[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const response of responses) {
    if (response.content) {
      result[response.status] = { description: response.description, content: response.content };
      continue;
    }
    if (response.schema) {
      result[response.status] = {
        description: response.description,
        content: {
          'application/json': { schema: response.schema },
          ...response.additionalContent,
        },
      };
      continue;
    }
    result[response.status] = { description: response.description };
  }
  return result;
}

function buildOperation(contract: EndpointContract): Record<string, unknown> {
  const operation: Record<string, unknown> = {
    operationId: contract.operationId,
    summary: contract.summary,
    tags: contract.tags,
    security: contract.security.map((name) => ({ [name]: [] })),
    responses: buildResponses(contract.responses),
  };
  if (contract.description) {
    operation.description = contract.description;
  }
  const requestParams: Record<string, unknown> = {};
  if (contract.pathParams?.length) {
    requestParams.path = z.object(
      Object.fromEntries(
        contract.pathParams.map((param) => [
          param.name,
          param.description ? z.string().describe(param.description) : z.string(),
        ]),
      ),
    );
  }
  if (contract.query) {
    requestParams.query = contract.query;
  }
  if (Object.keys(requestParams).length > 0) {
    operation.requestParams = requestParams;
  }
  if (contract.rawBody) {
    operation.requestBody = {
      description: contract.rawBody.description,
      required: contract.rawBody.required ?? false,
      content: contract.rawBody.content,
    };
  } else if (contract.body) {
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: contract.body } },
    };
  }
  return operation;
}

/** Merge extra OpenAPI keywords into generated component schemas the converter built too loosely. */
function applyComponentSchemaOverrides(
  document: Record<string, unknown>,
  overrides?: Record<string, Record<string, unknown>>,
): void {
  if (!overrides) {
    return;
  }
  const components = document.components as
    | { schemas?: Record<string, Record<string, unknown>> }
    | undefined;
  const schemas = components?.schemas;
  if (!schemas) {
    return;
  }
  for (const [name, extra] of Object.entries(overrides)) {
    if (schemas[name]) {
      Object.assign(schemas[name], extra);
    }
  }
}

export function buildOpenApiDocument(input: OpenApiInput): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const contract of input.contracts) {
    paths[contract.path] ??= {};
    paths[contract.path][contract.method] = buildOperation(contract);
  }
  const spec = {
    openapi: '3.1.0',
    info: input.info,
    servers: input.servers,
    components: {
      securitySchemes: input.securitySchemes,
      schemas: input.componentSchemas,
    },
    paths,
  } as unknown as Parameters<typeof createDocument>[0];
  const document = createDocument(spec) as unknown as Record<string, unknown>;
  applyComponentSchemaOverrides(document, input.componentSchemaOverrides);
  return document;
}
