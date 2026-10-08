import { z } from 'zod';
import { URL } from 'url';
import _axios from 'axios';
import crypto from 'crypto';
import { load } from 'js-yaml';
import type { OpenAPIV3 } from 'openapi-types';
import type { ActionMetadata, ActionMetadataRuntime } from './types/agents';
import type { FunctionTool, Schema, Reference } from './types/tools';
import { AuthTypeEnum, AuthorizationTypeEnum } from './types/agents';
import { Tools } from './types/tools';

export type ParametersSchema = {
  type: string;
  properties: Record<string, Reference | Schema>;
  required: string[];
  additionalProperties?: boolean;
};

export type OpenAPISchema = OpenAPIV3.SchemaObject &
  ParametersSchema & {
    items?: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject;
  };

export type ApiKeyCredentials = {
  api_key: string;
  custom_auth_header?: string;
  authorization_type?: AuthorizationTypeEnum;
};

export type OAuthCredentials = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
};

export type Credentials = ApiKeyCredentials | OAuthCredentials;

type MediaTypeObject =
  | undefined
  | {
      [media: string]: OpenAPIV3.MediaTypeObject | undefined;
    };

type RequestBodyObject = Omit<OpenAPIV3.RequestBodyObject, 'content'> & {
  content: MediaTypeObject;
};

export function sha1(input: string) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

export function createURL(domain: string, path: string) {
  const cleanDomain = domain.replace(/\/$/, '');
  const cleanPath = path.replace(/^\//, '');
  const fullURL = `${cleanDomain}/${cleanPath}`;
  return new URL(fullURL).toString();
}

const schemaTypeHandlers: Record<string, (schema: OpenAPISchema) => z.ZodTypeAny> = {
  string: (schema) => {
    if (schema.enum) {
      return z.enum(schema.enum as [string, ...string[]]);
    }

    let stringSchema = z.string();
    if (schema.minLength !== undefined) {
      stringSchema = stringSchema.min(schema.minLength);
    }
    if (schema.maxLength !== undefined) {
      stringSchema = stringSchema.max(schema.maxLength);
    }
    return stringSchema;
  },
  number: (schema) => {
    let numberSchema = z.number();
    if (schema.minimum !== undefined) {
      numberSchema = numberSchema.min(schema.minimum);
    }
    if (schema.maximum !== undefined) {
      numberSchema = numberSchema.max(schema.maximum);
    }
    return numberSchema;
  },
  integer: (schema) => (schemaTypeHandlers.number(schema) as z.ZodNumber).int(),
  boolean: () => z.boolean(),
  array: (schema) => {
    if (schema.items) {
      const zodSchema = openAPISchemaToZod(schema.items as OpenAPISchema);
      if (zodSchema) {
        return z.array(zodSchema);
      }

      return z.array(z.unknown());
    }
    return z.array(z.unknown());
  },
  object: (schema) => {
    const shape: { [key: string]: z.ZodTypeAny } = {};
    if (schema.properties) {
      Object.entries(schema.properties).forEach(([key, value]) => {
        const zodSchema = openAPISchemaToZod(value as OpenAPISchema);
        shape[key] = zodSchema || z.unknown();
        if (schema.required && schema.required.includes(key)) {
          shape[key] = shape[key].describe(value.description || '');
        } else {
          shape[key] = shape[key].optional().describe(value.description || '');
        }
      });
    }
    return z.object(shape);
  },
};

function openAPISchemaToZod(schema: OpenAPISchema): z.ZodTypeAny | undefined {
  if (schema.type === 'object' && Object.keys(schema.properties || {}).length === 0) {
    return undefined;
  }

  const handler = schemaTypeHandlers[schema.type as string] || (() => z.unknown());
  return handler(schema);
}

/**
 * Class representing a function signature.
 */
export class FunctionSignature {
  name: string;
  description: string;
  parameters: ParametersSchema;
  strict: boolean;

  constructor(name: string, description: string, parameters: ParametersSchema, strict?: boolean) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.strict = strict ?? false;
  }

  toObjectTool(): FunctionTool {
    const parameters = {
      ...this.parameters,
      additionalProperties: this.strict ? false : undefined,
    };

    return {
      type: Tools.function,
      function: {
        name: this.name,
        description: this.description,
        parameters,
        ...(this.strict ? { strict: this.strict } : {}),
      },
    };
  }
}

class RequestConfig {
  constructor(
    readonly domain: string,
    readonly basePath: string,
    readonly method: string,
    readonly operation: string,
    readonly isConsequential: boolean,
    readonly contentType: string,
    readonly parameterLocations?: Record<string, 'query' | 'path' | 'header' | 'body'>,
  ) {}
}

class RequestExecutor {
  path: string;
  params?: Record<string, unknown>;
  private operationHash?: string;
  private authHeaders: Record<string, string> = {};
  private authToken?: string;

  constructor(private config: RequestConfig) {
    this.path = config.basePath;
  }

  setParams(params: Record<string, unknown>) {
    this.operationHash = sha1(JSON.stringify(params));
    this.params = { ...params } as Record<string, unknown>;
    if (this.config.parameterLocations) {
      //Substituting “Path” Parameters:
      for (const [key, value] of Object.entries(params)) {
        if (this.config.parameterLocations[key] === 'path') {
          const paramPattern = `{${key}}`;
          if (this.path.includes(paramPattern)) {
            this.path = this.path.replace(paramPattern, encodeURIComponent(String(value)));
            delete this.params[key];
          }
        }
      }
    } else {
      // Fallback: if no locations are defined, perform path substitution for all keys.
      for (const [key, value] of Object.entries(params)) {
        const paramPattern = `{${key}}`;
        if (this.path.includes(paramPattern)) {
          this.path = this.path.replace(paramPattern, encodeURIComponent(String(value)));
          delete this.params[key];
        }
      }
    }
    return this;
  }

  async setAuth(metadata: ActionMetadataRuntime) {
    if (!metadata.auth) {
      return this;
    }

    const {
      type,
      /* API Key */
      authorization_type,
      custom_auth_header,
      /* OAuth */
      authorization_url,
      client_url,
      scope,
      token_exchange_method,
    } = metadata.auth;

    const {
      /* API Key */
      api_key,
      /* OAuth */
      oauth_client_id,
      oauth_client_secret,
      oauth_token_expires_at,
      oauth_access_token = '',
    } = metadata;

    const isApiKey = api_key != null && api_key.length > 0 && type === AuthTypeEnum.ServiceHttp;
    const isOAuth = !!(
      oauth_client_id != null &&
      oauth_client_id &&
      oauth_client_secret != null &&
      oauth_client_secret &&
      type === AuthTypeEnum.OAuth &&
      authorization_url != null &&
      authorization_url &&
      client_url != null &&
      client_url &&
      scope != null &&
      scope &&
      token_exchange_method
    );

    if (isApiKey && authorization_type === AuthorizationTypeEnum.Basic) {
      const basicToken = Buffer.from(api_key).toString('base64');
      this.authHeaders['Authorization'] = `Basic ${basicToken}`;
    } else if (isApiKey && authorization_type === AuthorizationTypeEnum.Bearer) {
      this.authHeaders['Authorization'] = `Bearer ${api_key}`;
    } else if (
      isApiKey &&
      authorization_type === AuthorizationTypeEnum.Custom &&
      custom_auth_header != null &&
      custom_auth_header
    ) {
      this.authHeaders[custom_auth_header] = api_key;
    } else if (isOAuth) {
      // TODO: maybe doing it in a different way later on. but we want that the user needs to folllow the oauth flow.
      // If we do not have a valid token, bail or ask user to sign in
      const now = new Date();

      // 1. Check if token is set
      if (!oauth_access_token) {
        throw new Error('No access token found. Please log in first.');
      }

      // 2. Check if token is expired
      if (oauth_token_expires_at && now >= new Date(oauth_token_expires_at)) {
        // Optionally check refresh_token logic, or just prompt user to re-login
        throw new Error('Access token is expired. Please re-login.');
      }

      // If valid, use it
      this.authToken = oauth_access_token;
      this.authHeaders['Authorization'] = `Bearer ${this.authToken}`;
    }
    return this;
  }

  async execute(options?: { httpAgent?: unknown; httpsAgent?: unknown }) {
    const url = createURL(this.config.domain, this.path);
    const headers: Record<string, string> = {
      ...this.authHeaders,
      ...(this.config.contentType ? { 'Content-Type': this.config.contentType } : {}),
    };
    const method = this.config.method.toLowerCase();

    /**
     * SECURITY: Disable automatic redirects to prevent SSRF bypass.
     * Attackers could use redirects to access internal services:
     *   1. Set action URL to allowed external domain
     *   2. External domain redirects to internal service (e.g., 127.0.0.1, rag_api)
     *   3. Without this protection, axios would follow the redirect
     *
     * By setting maxRedirects: 0, we prevent this attack vector.
     * The action will receive the redirect response (3xx) instead of following it.
     *
     * SECURITY: When httpAgent/httpsAgent are provided (SSRF-safe agents), they validate
     * the DNS-resolved IP at TCP connect time, preventing TOCTOU DNS rebinding attacks.
     */
    const axios = _axios.create({
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      ...(options?.httpAgent != null ? { httpAgent: options.httpAgent } : {}),
      ...(options?.httpsAgent != null ? { httpsAgent: options.httpsAgent } : {}),
    });

    // Initialize separate containers for query and body parameters.
    const queryParams: Record<string, unknown> = {};
    const bodyParams: Record<string, unknown> = {};

    if (this.config.parameterLocations && this.params) {
      for (const key of Object.keys(this.params)) {
        // Determine parameter placement; default to "query" for GET and "body" for others.
        const loc: 'query' | 'path' | 'header' | 'body' =
          this.config.parameterLocations[key] || (method === 'get' ? 'query' : 'body');

        const val = this.params[key];
        if (loc === 'query') {
          queryParams[key] = val;
        } else if (loc === 'header') {
          headers[key] = String(val);
        } else if (loc === 'body') {
          bodyParams[key] = val;
        }
      }
    } else if (this.params) {
      Object.assign(queryParams, this.params);
      Object.assign(bodyParams, this.params);
    }

    if (method === 'get') {
      return axios.get(url, { headers, params: queryParams });
    } else if (method === 'post') {
      return axios.post(url, bodyParams, { headers, params: queryParams });
    } else if (method === 'put') {
      return axios.put(url, bodyParams, { headers, params: queryParams });
    } else if (method === 'delete') {
      return axios.delete(url, { headers, data: bodyParams, params: queryParams });
    } else if (method === 'patch') {
      return axios.patch(url, bodyParams, { headers, params: queryParams });
    } else {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }
  }

  getConfig() {
    return this.config;
  }
}

export class ActionRequest {
  private config: RequestConfig;

  constructor(
    domain: string,
    path: string,
    method: string,
    operation: string,
    isConsequential: boolean,
    contentType: string,
    parameterLocations?: Record<string, 'query' | 'path' | 'header' | 'body'>,
  ) {
    this.config = new RequestConfig(
      domain,
      path,
      method,
      operation,
      isConsequential,
      contentType,
      parameterLocations,
    );
  }

  // Add getters to maintain backward compatibility
  get domain() {
    return this.config.domain;
  }
  get path() {
    return this.config.basePath;
  }
  get method() {
    return this.config.method;
  }
  get operation() {
    return this.config.operation;
  }
  get isConsequential() {
    return this.config.isConsequential;
  }
  get contentType() {
    return this.config.contentType;
  }

  createExecutor() {
    return new RequestExecutor(this.config);
  }

  // Maintain backward compatibility by delegating to a new executor
  setParams(params: Record<string, unknown>) {
    const executor = this.createExecutor();
    executor.setParams(params);
    return executor;
  }

  async setAuth(metadata: ActionMetadata) {
    const executor = this.createExecutor();
    return executor.setAuth(metadata);
  }

  async execute() {
    const executor = this.createExecutor();
    return executor.execute();
  }
}

export function resolveRef<
  T extends
    | OpenAPIV3.ReferenceObject
    | OpenAPIV3.SchemaObject
    | OpenAPIV3.ParameterObject
    | OpenAPIV3.RequestBodyObject,
>(obj: T, components?: OpenAPIV3.ComponentsObject): Exclude<T, OpenAPIV3.ReferenceObject> {
  if ('$ref' in obj && components) {
    const refPath = obj.$ref.replace(/^#\/components\//, '').split('/');

    let resolved: unknown = components as Record<string, unknown>;
    for (const segment of refPath) {
      if (typeof resolved === 'object' && resolved !== null && segment in resolved) {
        resolved = (resolved as Record<string, unknown>)[segment];
      } else {
        throw new Error(`Could not resolve reference: ${obj.$ref}`);
      }
    }

    return resolveRef(resolved as typeof obj, components) as Exclude<T, OpenAPIV3.ReferenceObject>;
  }

  return obj as Exclude<T, OpenAPIV3.ReferenceObject>;
}

function sanitizeOperationId(input: string) {
  return input.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Converts an OpenAPI spec to function signatures and request builders.
 */
export function openapiToFunction(
  openapiSpec: OpenAPIV3.Document,
  generateZodSchemas = false,
): {
  functionSignatures: FunctionSignature[];
  requestBuilders: Record<string, ActionRequest>;
  zodSchemas?: Record<string, z.ZodTypeAny>;
} {
  const functionSignatures: FunctionSignature[] = [];
  const requestBuilders: Record<string, ActionRequest> = {};
  const zodSchemas: Record<string, z.ZodTypeAny> = {};
  const baseUrl = openapiSpec.servers?.[0]?.url ?? '';

  // Iterate over each path and method in the OpenAPI spec
  for (const [path, methods] of Object.entries(openapiSpec.paths)) {
    for (const [method, operation] of Object.entries(methods as OpenAPIV3.PathsObject)) {
      const paramLocations: Record<string, 'query' | 'path' | 'header' | 'body'> = {};
      const operationObj = operation as OpenAPIV3.OperationObject & {
        'x-openai-isConsequential'?: boolean;
      } & {
        'x-strict'?: boolean;
      };

      // Operation ID is used as the function name
      const defaultOperationId = `${method}_${path}`;
      const operationId = operationObj.operationId || sanitizeOperationId(defaultOperationId);
      const description = operationObj.summary || operationObj.description || '';
      const isStrict = operationObj['x-strict'] ?? false;

      const parametersSchema: OpenAPISchema = {
        type: 'object',
        properties: {},
        required: [],
      };

      if (operationObj.parameters) {
        for (const param of operationObj.parameters ?? []) {
          const resolvedParam = resolveRef(
            param,
            openapiSpec.components,
          ) as OpenAPIV3.ParameterObject;

          const paramName = resolvedParam.name;
          if (!paramName || !resolvedParam.schema) {
            continue;
          }

          const paramSchema = resolveRef(
            resolvedParam.schema,
            openapiSpec.components,
          ) as OpenAPIV3.SchemaObject;

          parametersSchema.properties[paramName] = paramSchema;
          if (resolvedParam.required) {
            parametersSchema.required.push(paramName);
          }
          // Record the parameter location from the OpenAPI "in" field.
          paramLocations[paramName] =
            resolvedParam.in === 'query' ||
            resolvedParam.in === 'path' ||
            resolvedParam.in === 'header' ||
            resolvedParam.in === 'body'
              ? resolvedParam.in
              : 'query';
        }
      }

      let contentType = '';
      if (operationObj.requestBody) {
        const requestBody = operationObj.requestBody as RequestBodyObject;
        const content = requestBody.content;
        contentType = Object.keys(content ?? {})[0];
        const schema = content?.[contentType]?.schema;
        const resolvedSchema = resolveRef(
          schema as OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
          openapiSpec.components,
        );
        parametersSchema.properties = {
          ...parametersSchema.properties,
          ...resolvedSchema.properties,
        };
        if (resolvedSchema.required) {
          parametersSchema.required.push(...resolvedSchema.required);
        }
        // Mark requestBody properties as belonging to the "body"
        if (resolvedSchema.properties) {
          for (const key in resolvedSchema.properties) {
            paramLocations[key] = 'body';
          }
        }

        contentType = contentType ?? 'application/json';
      }

      const functionSignature = new FunctionSignature(
        operationId,
        description,
        parametersSchema,
        isStrict,
      );
      functionSignatures.push(functionSignature);

      const actionRequest = new ActionRequest(
        baseUrl,
        path,
        method,
        operationId,
        !!(operationObj['x-openai-isConsequential'] ?? false),
        contentType,
        paramLocations,
      );

      requestBuilders[operationId] = actionRequest;

      if (generateZodSchemas && Object.keys(parametersSchema.properties).length > 0) {
        const schema = openAPISchemaToZod(parametersSchema);
        if (schema) {
          zodSchemas[operationId] = schema;
        }
      }
    }
  }

  return { functionSignatures, requestBuilders, zodSchemas };
}

export type ValidationResult = {
  status: boolean;
  message: string;
  spec?: OpenAPIV3.Document;
  serverUrl?: string;
};

/**
 * Cross-platform IP validation (works in Node.js and browser).
 * @param input - String to check if it's an IP address
 * @returns 0 if not IP, 4 for IPv4, 6 for IPv6
 */
function isIP(input: string): number {
  // IPv4 regex - matches 0.0.0.0 to 255.255.255.255
  const ipv4Regex =
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

  if (ipv4Regex.test(input)) {
    return 4;
  }

  // IPv6 regex - simplified but covers most cases
  // Handles compressed (::), full, and mixed notations
  const ipv6Regex =
    /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

  if (ipv6Regex.test(input)) {
    return 6;
  }

  return 0;
}

/**
 * Extracts domain from URL (protocol + hostname).
 * @param url - URL to extract from
 * @returns Protocol and hostname (e.g., "https://example.com")
 */
export function extractDomainFromUrl(url: string): string {
  try {
    /** Parsed URL object */
    const parsedUrl = new URL(url);
    // Preserve brackets for IPv6 addresses using isIP
    const ipVersion = isIP(parsedUrl.hostname);
    const hostname = ipVersion === 6 ? `[${parsedUrl.hostname}]` : parsedUrl.hostname;
    return `${parsedUrl.protocol}//${hostname}`;
  } catch {
    throw new Error(`Invalid URL format: ${url}`);
  }
}

export type DomainValidationResult = {
  isValid: boolean;
  message?: string;
  normalizedSpecDomain?: string;
  normalizedClientDomain?: string;
};

function getExplicitPort(value: string): string | null {
  const normalizedValue = value.trim();
  const protocolSeparatorIndex = normalizedValue.indexOf('://');
  const hasProtocol = protocolSeparatorIndex !== -1;
  const authorityAndPath = hasProtocol
    ? normalizedValue.slice(protocolSeparatorIndex + 3)
    : normalizedValue;

  let port: string;
  try {
    const parsedUrl = new URL(hasProtocol ? normalizedValue : `https://${normalizedValue}`);
    port = parsedUrl.port;

    // WHATWG URL parsing removes explicit default ports, so parse the same authority with
    // the alternate HTTP scheme to distinguish an explicit port from an omitted one.
    if (!port && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')) {
      const alternateProtocol = parsedUrl.protocol === 'http:' ? 'https:' : 'http:';
      port = new URL(`${alternateProtocol}//${authorityAndPath}`).port;
    }
  } catch {
    return null;
  }

  if (!port) {
    return null;
  }

  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`Invalid port in domain: ${value}`);
  }

  return String(parsedPort);
}

function getDefaultActionPort(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}

/**
 * Validates client domain matches OpenAPI spec server URL domain (SSRF prevention).
 * @param clientProvidedDomain - Domain from client (with/without protocol)
 * @param specServerUrl - Server URL from OpenAPI spec
 * @returns Validation result with normalized domains
 */
export function validateActionDomain(
  clientProvidedDomain: string,
  specServerUrl: string,
): DomainValidationResult {
  try {
    /** Parsed spec URL */
    const specUrl = new URL(specServerUrl);

    if (specUrl.protocol !== 'http:' && specUrl.protocol !== 'https:') {
      return {
        isValid: false,
        message: `Invalid protocol: Only HTTP and HTTPS are allowed, got ${specUrl.protocol}`,
      };
    }

    /** Spec hostname only */
    const specHostname = specUrl.hostname;
    /** Spec domain with protocol (handle IPv6 brackets) */
    const specIpVersion = isIP(specHostname);
    const normalizedSpecDomain =
      specIpVersion === 6
        ? `${specUrl.protocol}//[${specHostname}]`
        : `${specUrl.protocol}//${specHostname}`;

    /** Extract hostname from client domain if it's a full URL */
    let clientHostname = clientProvidedDomain;
    let clientHasProtocol = false;
    const clientExplicitPort = getExplicitPort(clientProvidedDomain);

    // Check for any protocol in the client domain
    if (clientProvidedDomain.includes('://')) {
      if (
        !clientProvidedDomain.startsWith('http://') &&
        !clientProvidedDomain.startsWith('https://')
      ) {
        return {
          isValid: false,
          message: `Invalid protocol: Only HTTP and HTTPS are allowed in client domain`,
        };
      }
      try {
        const clientUrl = new URL(clientProvidedDomain);
        clientHostname = clientUrl.hostname;
        clientHasProtocol = true;
      } catch {
        // If parsing fails, treat as hostname
        clientHasProtocol = false;
      }
    } else if (clientExplicitPort !== null) {
      const clientUrl = new URL(`https://${clientProvidedDomain}`);
      clientHostname = clientUrl.hostname;
    }

    /** Normalize IPv6 addresses by removing brackets for comparison */
    const normalizedClientHostname = clientHostname.replace(/^\[(.+)\]$/, '$1');
    const normalizedSpecHostname = specHostname.replace(/^\[(.+)\]$/, '$1');

    /** Check if hostname is valid IP using cross-platform isIP */
    const isIPAddress = isIP(normalizedClientHostname) !== 0;

    /** Normalized client domain */
    let normalizedClientDomain: string;
    if (clientHasProtocol) {
      normalizedClientDomain = extractDomainFromUrl(clientProvidedDomain);
    } else {
      // No protocol specified by client
      if (isIPAddress) {
        // IPs inherit protocol from spec (for legitimate internal services)
        const ipVersion = isIP(normalizedClientHostname);
        const hostname =
          ipVersion === 6 && !clientHostname.startsWith('[')
            ? `[${normalizedClientHostname}]`
            : clientHostname;
        normalizedClientDomain = `${specUrl.protocol}//${hostname}`;
      } else {
        // Domain names default to HTTPS for security (forces explicit protocol)
        normalizedClientDomain = `https://${clientHostname}`;
      }
    }

    const domainMatches =
      normalizedSpecDomain === normalizedClientDomain ||
      (!clientHasProtocol && isIPAddress && normalizedClientHostname === normalizedSpecHostname);

    if (!domainMatches) {
      return {
        isValid: false,
        message: `Domain mismatch: Client provided '${clientProvidedDomain}', but spec uses '${specHostname}'`,
        normalizedSpecDomain,
        normalizedClientDomain,
      };
    }

    if (clientExplicitPort !== null) {
      const specEffectivePort = specUrl.port || getDefaultActionPort(specUrl.protocol);
      if (clientExplicitPort !== specEffectivePort) {
        return {
          isValid: false,
          message: `Port mismatch: Client provided '${clientProvidedDomain}', but spec uses effective port '${specEffectivePort}'`,
          normalizedSpecDomain,
          normalizedClientDomain,
        };
      }
    }

    return {
      isValid: true,
      normalizedSpecDomain,
      normalizedClientDomain,
    };
  } catch (error) {
    return {
      isValid: false,
      message: `Failed to validate domain: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Validates and parses an OpenAPI spec.
 */
export function validateAndParseOpenAPISpec(specString: string): ValidationResult {
  try {
    let parsedSpec;
    try {
      parsedSpec = JSON.parse(specString);
    } catch {
      parsedSpec = load(specString);
    }

    // Check for servers
    if (
      !parsedSpec.servers ||
      !Array.isArray(parsedSpec.servers) ||
      parsedSpec.servers.length === 0
    ) {
      return { status: false, message: 'Could not find a valid URL in `servers`' };
    }

    if (!parsedSpec.servers[0].url) {
      return { status: false, message: 'Could not find a valid URL in `servers`' };
    }

    // Check for paths
    const paths = parsedSpec.paths;
    if (!paths || typeof paths !== 'object' || Object.keys(paths).length === 0) {
      return { status: false, message: 'No paths found in the OpenAPI spec.' };
    }

    const components = parsedSpec.components?.schemas || {};
    const messages = [];

    for (const [path, methods] of Object.entries(paths)) {
      for (const [httpMethod, operation] of Object.entries(methods as OpenAPIV3.PathItemObject)) {
        // Ensure operation is a valid operation object
        const { responses } = operation as OpenAPIV3.OperationObject | { responses: undefined };
        if (typeof operation === 'object' && responses) {
          for (const [statusCode, response] of Object.entries(responses)) {
            const content = (response as OpenAPIV3.ResponseObject).content as MediaTypeObject;
            if (content && content['application/json'] && content['application/json'].schema) {
              const schema = content['application/json'].schema;
              if ('$ref' in schema && typeof schema.$ref === 'string') {
                const refName = schema.$ref.split('/').pop();
                if (refName && !components[refName]) {
                  messages.push(
                    `In context=('paths', '${path}', '${httpMethod}', '${statusCode}', 'response', 'content', 'application/json', 'schema'), reference to unknown component ${refName}; using empty schema`,
                  );
                }
              }
            }
          }
        }
      }
    }

    return {
      status: true,
      message: messages.join('\n') || 'OpenAPI spec is valid.',
      spec: parsedSpec,
      serverUrl: parsedSpec.servers[0].url,
    };
  } catch (error) {
    console.error(error);
    return { status: false, message: 'Error parsing OpenAPI spec.' };
  }
}
