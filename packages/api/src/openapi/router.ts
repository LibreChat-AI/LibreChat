import fs from 'fs';
import path from 'path';
import express from 'express';
import { logger, type AppConfig } from '@librechat/data-schemas';
import type { Request, Response, Router, NextFunction } from 'express';
import type { GetAppConfigOptions } from '~/app/service';

export interface OpenApiRouterDeps {
  /**
   * Resolves the app configuration. The docs gate reads the deployment-wide base config,
   * so `openapi.enabled` comes from `librechat.yaml` and needs no per-request database read.
   */
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  /** Absolute path to the bundled Swagger UI assets (from `swagger-ui-dist`). */
  swaggerAssetsPath: string;
}

/** The generated spec is copied next to the built bundle, so it ships wherever `dist` ships. */
const SPEC_PATH = path.join(__dirname, 'agents.openapi.json');

/**
 * URLs are computed in the browser from the current path, so the docs work whether LibreChat
 * is served at the origin root or under a base path (e.g. `/chat`) that a proxy strips.
 */
const DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LibreChat Agents API</title>
    <script>
      window.addEventListener('DOMContentLoaded', function () {
        var apiBase = location.pathname.replace(/\\/+$/, '').replace(/\\/docs$/, '');
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = apiBase + '/docs/assets/swagger-ui.css';
        document.head.appendChild(link);
        var script = document.createElement('script');
        script.src = apiBase + '/docs/assets/swagger-ui-bundle.js';
        script.onload = function () {
          window.ui = SwaggerUIBundle({
            url: apiBase + '/openapi.json',
            dom_id: '#swagger-ui',
            validatorUrl: null,
          });
        };
        document.body.appendChild(script);
      });
    </script>
  </head>
  <body>
    <div id="swagger-ui"></div>
  </body>
</html>`;

/** Serves the OpenAPI spec and Swagger UI docs behind the `openapi.enabled` config flag. */
export function createOpenApiRouter(deps: OpenApiRouterDeps): Router {
  const router = express.Router();
  let cachedSpec: string | undefined;

  function readSpec(): string {
    if (cachedSpec === undefined) {
      cachedSpec = fs.readFileSync(SPEC_PATH, 'utf8');
    }
    return cachedSpec;
  }

  async function isEnabled(): Promise<boolean> {
    try {
      const appConfig = await deps.getAppConfig({ baseOnly: true });
      return appConfig?.config?.openapi?.enabled === true;
    } catch (error) {
      logger.error('[openapi] Failed to read app config', error);
      return false;
    }
  }

  router.get('/openapi.json', async (_req: Request, res: Response): Promise<void> => {
    if (!(await isEnabled())) {
      res.status(404).json({ message: 'Not Found' });
      return;
    }
    try {
      res.type('application/json').send(readSpec());
    } catch (error) {
      logger.error('[openapi] Failed to read the OpenAPI spec', error);
      res.status(500).json({ message: 'Failed to read the OpenAPI spec' });
    }
  });

  const serveAssets = express.static(deps.swaggerAssetsPath);
  router.use(
    '/docs/assets',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      if (!(await isEnabled())) {
        res.status(404).json({ message: 'Not Found' });
        return;
      }
      serveAssets(req, res, next);
    },
  );

  router.get('/docs', async (_req: Request, res: Response): Promise<void> => {
    if (!(await isEnabled())) {
      res.status(404).json({ message: 'Not Found' });
      return;
    }
    res.type('html').send(DOCS_HTML);
  });

  return router;
}
