import type { Application, RequestHandler } from 'express';
import type { MediaActivityTransportOptions } from './eventTransport';
import type { createMediaCatalogCache } from './catalogCache';
import type { registerShutdownTask } from '~/app/shutdown';
import type { MediaHostDependencies } from './host';
import type { MediaRuntime } from './runtime';
import { createMediaCatalogCache as catalogCache } from './catalogCache';
import { createMediaActivityTransport } from './eventTransport';
import { createMediaWorkerStop } from './lifecycle';
import { createMediaRuntimeFromApp } from './host';

type HostConfiguration = Pick<
  MediaHostDependencies,
  'appConfig' | 'mediaMetrics' | 'isLeader' | 'eventTransport'
>;
type CommonHost = Omit<MediaHostDependencies, keyof HostConfiguration | 'catalogCache'>;

/** Both server entries supply their deadlines and leader; shared wiring stays in one place. */
export function createMediaApplication(deps: {
  activityTransport?: MediaActivityTransportOptions;
  host: CommonHost;
  createCache: Parameters<typeof createMediaCatalogCache>[0]['createCache'];
  registerShutdownTask: typeof registerShutdownTask;
  getRemainingShutdownMs(): number | null;
  requireJwtAuth: RequestHandler;
  optionalJwtAuth: RequestHandler;
  checkBan: RequestHandler;
  optionalShareFileAuth: RequestHandler;
  tenantContextMiddleware: RequestHandler;
}): {
  initialize(
    options: HostConfiguration & {
      app: Application;
      externalDeadlineAt?: () => number | null;
    },
  ): MediaRuntime;
  mount(app: Application, runtime: MediaRuntime): void;
} {
  return {
    initialize({ app, externalDeadlineAt, ...configuration }) {
      const ownedTransport =
        deps.activityTransport &&
        !configuration.eventTransport &&
        configuration.appConfig.media?.enabled &&
        configuration.appConfig.media.events.enabled
          ? createMediaActivityTransport(deps.activityTransport)
          : undefined;
      const runtime = createMediaRuntimeFromApp({
        ...deps.host,
        ...configuration,
        eventTransport: configuration.eventTransport ?? ownedTransport?.transport,
        catalogCache: catalogCache({
          appConfig: configuration.appConfig,
          createCache: deps.createCache,
        }),
      });
      app.locals.mediaRuntime = runtime;
      deps.registerShutdownTask('media activity', runtime.closeActivity, { phase: 'pre-drain' });
      if (ownedTransport)
        deps.registerShutdownTask('media activity transport', ownedTransport.destroy, {
          priority: 90,
        });
      deps.registerShutdownTask('media admission', runtime.worker.prepareForShutdown, {
        phase: 'pre-drain',
      });
      deps.registerShutdownTask(
        'media worker',
        createMediaWorkerStop(runtime.worker, deps.getRemainingShutdownMs, externalDeadlineAt),
        { priority: 100 },
      );
      return runtime;
    },
    mount(app, runtime) {
      app.use(
        '/api/media/assets',
        deps.optionalJwtAuth,
        deps.checkBan,
        deps.optionalShareFileAuth,
        deps.tenantContextMiddleware,
        runtime.contentRouter,
      );
      app.use('/api/media', deps.requireJwtAuth, runtime.router);
    },
  };
}
