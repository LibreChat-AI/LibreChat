import Rum from '@hyperdx/otel-web';
import Recorder from '@hyperdx/otel-web-session-recorder';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { RumRecorderConfig } from '@hyperdx/otel-web-session-recorder';
import type { RumActionAttributes } from './diagnostics';
import { createReplayPrivacyPlugin, isReplayRouteAllowed } from './privacy';
import { PrivacyTraceExporter } from './exporter';

export type BrowserConfig = {
  advancedNetworkCapture: boolean;
  apiKey: string;
  consoleCapture: boolean;
  disableReplay: boolean;
  maskAllInputs: boolean;
  maskAllText: boolean;
  service: string;
  tracePropagationTargets?: string[];
  url: string;
};

let advancedNetworkCapture = false;
let replayConfig: RumRecorderConfig | undefined;
let replayPathname = () => window.location.pathname;

function startRecorder(): void {
  if (replayConfig && isReplayRouteAllowed(replayPathname()) && !Recorder.inited) {
    Recorder.init(replayConfig);
  }
}

/** Compose the same SDK components directly so both exporters have pre-serialization privacy hooks. */
const browser = {
  init(config: BrowserConfig): void {
    advancedNetworkCapture = config.advancedNetworkCapture;
    const network = {
      ...(config.tracePropagationTargets
        ? { propagateTraceHeaderCorsUrls: config.tracePropagationTargets }
        : {}),
      advancedNetworkCapture: () => advancedNetworkCapture,
    };
    Rum._internalInit({
      allowInsecureUrl: true,
      apiKey: config.apiKey,
      applicationName: config.service,
      url: `${config.url}/v1/traces`,
      exporter: {
        factory: ({ url, authHeader }) =>
          new PrivacyTraceExporter(
            new OTLPTraceExporter({
              url,
              headers: authHeader ? { authorization: authHeader } : {},
            }),
          ),
      },
      instrumentations: {
        visibility: true,
        console: config.consoleCapture,
        fetch: network,
        xhr: network,
      },
    });
    const base = new URL(
      document.querySelector('base')?.getAttribute('href') ?? '/',
      window.location.origin,
    ).pathname.replace(/\/$/, '');
    const getPathname = () => {
      const pathname = window.location.pathname;
      if (pathname === base) return '/';
      return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname;
    };
    replayPathname = getPathname;
    replayConfig = undefined;
    if (!config.disableReplay && isReplayRouteAllowed(getPathname())) {
      replayConfig = {
        apiKey: config.apiKey,
        url: `${config.url}/v1/logs`,
        maskAllInputs: true,
        maskTextSelector: '*',
        recordCanvas: false,
        plugins: [createReplayPrivacyPlugin(getPathname)],
      };
      startRecorder();
    } else {
      Recorder.deinit();
    }
  },
  stopSessionRecorder: () => Recorder.deinit(),
  resumeSessionRecorder: startRecorder,
  getSessionId: () => Rum.getSessionId(),
  addAction: (name: string, attributes?: RumActionAttributes) => Rum.addAction(name, attributes),
  setGlobalAttributes: (attributes: Record<string, string>) => Rum.setGlobalAttributes(attributes),
};

export default browser;
