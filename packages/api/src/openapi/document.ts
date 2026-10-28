import { securitySchemes, componentSchemas, componentSchemaOverrides, contracts } from './registry';
import { buildOpenApiDocument } from './adapter';

/** Stable document version, independent of the package version, so the artifact does not churn. */
const DOCUMENT_VERSION = '0.1.0';

/** Build the OpenAPI 3.1 document for the public agent and skill management endpoints. */
export function buildAgentsOpenApiDocument(): Record<string, unknown> {
  return buildOpenApiDocument({
    info: {
      title: 'LibreChat Agents API',
      version: DOCUMENT_VERSION,
      description:
        'The public agent and skill management endpoints of the LibreChat Agents API. This API is in beta and may change.',
    },
    servers: [
      {
        url: 'agents/v1',
        description:
          'Relative to where this document is served (`/api/openapi.json`), so it resolves under any deployment base path.',
      },
    ],
    securitySchemes,
    componentSchemas,
    componentSchemaOverrides,
    contracts,
  });
}
