# Langfuse Fanout Gateway

LibreChat can send tenant-scoped agent traces to a tenant Langfuse project and
also copy those traces to a central Langfuse project. When trace payloads
contain Langfuse media references, the gateway can also copy the media upload to
central and tenant Langfuse storage. This is optional and is disabled unless you
explicitly deploy the fanout gateway.

The deployment is a hybrid:

- the Go gateway is the only endpoint LibreChat talks to;
- trace requests are proxied to an internal OpenTelemetry collector;
- the collector owns trace memory limiting, batching, routing, and export;
- the Go gateway owns Langfuse media create/upload/patch fanout.

## How It Works

- Agent traces use Langfuse OTLP ingestion.
- LibreChat sends tenant traces to the local fanout gateway when
  `LANGFUSE_FANOUT_ENABLED=true` and `LANGFUSE_FANOUT_COLLECTOR_URL` points at
  the fanout gateway.
- The gateway forwards trace requests to the internal OpenTelemetry collector
  at `LANGFUSE_FANOUT_TRACE_COLLECTOR_URL`.
- The collector exports every trace to the central Langfuse project using
  `LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER`. This prebuilt header is collector-only;
  the LibreChat app derives central score auth from `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY`.
- The collector also exports tenant-enabled traces to the tenant Langfuse
  project by routing on `librechat.langfuse.destination`, then forwarding the
  tenant `Authorization` header that LibreChat attaches to the OTLP request.
- For tenant-exportable runs, LibreChat uses a destination-scoped gateway URL
  like `http://langfuse-fanout-collector:4318/tenant/us`. Langfuse media upload
  requests do not carry span attributes, so this path gives the gateway the
  destination needed to copy media into the tenant's Langfuse region. For
  traces on this path, the gateway restores the internal tenant routing
  attributes before handing the request to the collector.
- Before export, the collector deletes the internal `librechat.langfuse.*`
  routing attributes from central and tenant traces.
- Langfuse media upload is fanned out by calling `POST /api/public/media` on
  central and tenant Langfuse, returning a one-time gateway upload URL, then
  uploading the received bytes to each upstream presigned upload URL. The SDK's
  `PATCH /api/public/media/{mediaId}` status call is also fanned out.
- Central media export can be disabled independently of central trace export
  with `LANGFUSE_FANOUT_CENTRAL_MEDIA_EXPORT_DISABLED=true`. Per-run central
  trace suppression uses a destination-scoped gateway path that also skips
  central media export for that run.
- Tenant export is conditional. LibreChat uses a destination-scoped gateway URL
  only when the saved connection is enabled with tenant keys, its destination
  key matches a configured startup destination, and
  `LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED` is not true.
  Other traces are still exported to central through the gateway without tenant
  auth.
- User feedback scores use Langfuse's direct REST API from the LibreChat API
  process. Central scores use LibreChat's normal central Langfuse env config;
  tenant scores use tenant app configuration when tenant fanout is enabled.

Tenant Langfuse keys are expected to come from LibreChat app configuration.
When available, an authorized administrator can configure and verify the
connection under **Settings > Langfuse**; LibreChat encrypts the secret key at
rest. The keys are not defined in this gateway config.

## Limitations

- Langfuse base URLs are startup configuration. `LANGFUSE_FANOUT_CENTRAL_BASE_URL`
  and `LANGFUSE_FANOUT_TENANT_DESTINATIONS` must be known when LibreChat and the
  gateway start. Tenant app configuration may choose any configured tenant
  destination.
- Tenant Langfuse API keys can be added, changed, or disabled in tenant app
  configuration at runtime without restarting LibreChat or the gateway.
- Tenant app configuration must select a destination key from
  `LANGFUSE_FANOUT_TENANT_DESTINATIONS` before tenant trace/score export is
  enabled; keys alone do not enable tenant export.
- `LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED=true` can be set on LibreChat as an
  emergency switch to stop tenant trace and score export while keeping central
  gateway export active. When omitted, false, or blank, tenant export remains
  available if tenant keys and a known destination are configured.
- `LANGFUSE_FANOUT_CENTRAL_MEDIA_EXPORT_DISABLED=true` can be set on the gateway
  to stop central media create/upload/patch fanout while leaving central trace
  export unchanged.
- This supports Langfuse Cloud and self-hosted Langfuse as long as each allowed
  tenant base URL is configured at LibreChat/gateway startup. Runtime tenant
  config selects from those known destinations; it does not inject arbitrary
  export URLs into the gateway.
- The provided Compose gateway config is a three-region Langfuse Cloud preset
  (`eu`, `us`, `jp`). Compose's static collector config routes only those keys;
  the gateway fails startup when `LANGFUSE_FANOUT_TENANT_DESTINATIONS` contains
  a key outside `LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS`. For self-hosted or
  additional destination keys, update the collector config too or use Helm.
- Helm binds the internal collector receiver to `127.0.0.1:4319` because the
  collector is a sidecar. Compose binds it to `0.0.0.0:4319` on the private
  `langfuse-fanout` network. Do not publish the internal collector receiver
  outside the fanout deployment; tenant routing validation happens in the
  gateway before traces reach the collector.
- The gateway stores short-lived one-time media upload plans in Redis. This lets
  media create and byte-upload requests land on different gateway replicas.
  Compose includes a private Redis container; Helm can derive the URI from the
  bundled Redis chart or use an explicit `langfuseFanout.redis.uri`.
- The gateway requires an explicit public/internal base URL for one-time upload
  URLs. Compose sets `LANGFUSE_FANOUT_PUBLIC_URL` to its private gateway
  service URL. Helm derives the fanout Service DNS name unless `publicUrl` is
  set.
- Media fanout is not transactional across central and tenant projects. If one
  destination accepts `POST /api/public/media` and another fails, LibreChat sees
  a gateway error and will not upload bytes, but the successful destination may
  retain a short-lived, unused media record.
- Trace batching is handled by the collector. By default it flushes after 128
  items or 1 second, and tenant batches are separated by the request
  `Authorization` metadata.
- The gateway exposes Prometheus metrics at `/metrics` using the same bearer
  token shape as LibreChat. Set `LANGFUSE_FANOUT_METRICS_SECRET`, or provide
  `METRICS_SECRET` in the gateway environment. When neither is set, `/metrics`
  returns 401.

## Docker Compose

Set the central Langfuse destination in `.env`:

```dotenv
# Used by LibreChat for central feedback scores. Set this to the same non-EU
# region as LANGFUSE_FANOUT_CENTRAL_BASE_URL when applicable.
LANGFUSE_BASE_URL=https://cloud.langfuse.com

# Used by the gateway for central trace and media export.
LANGFUSE_FANOUT_CENTRAL_BASE_URL=https://cloud.langfuse.com
LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER=Basic <base64-public-key-colon-secret-key>
LANGFUSE_FANOUT_CENTRAL_MEDIA_EXPORT_DISABLED=false
# Compose's included gateway config supports these three destination keys.
LANGFUSE_FANOUT_TENANT_DESTINATIONS=eu=https://cloud.langfuse.com,us=https://us.cloud.langfuse.com,jp=https://jp.cloud.langfuse.com
LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS=eu,us,jp
LANGFUSE_FANOUT_TENANT_EU_BASE_URL=https://cloud.langfuse.com
LANGFUSE_FANOUT_TENANT_US_BASE_URL=https://us.cloud.langfuse.com
LANGFUSE_FANOUT_TENANT_JP_BASE_URL=https://jp.cloud.langfuse.com
LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED=false
LANGFUSE_FANOUT_LISTEN_ADDR=:4318
LANGFUSE_FANOUT_UPSTREAM_TIMEOUT=30s
LANGFUSE_FANOUT_PUBLIC_URL=http://langfuse-fanout-collector:4318
LANGFUSE_FANOUT_REDIS_URI=redis://langfuse-fanout-redis:6379
LANGFUSE_FANOUT_REDIS_USERNAME=
LANGFUSE_FANOUT_REDIS_PASSWORD=
LANGFUSE_FANOUT_REDIS_KEY_PREFIX=langfuse-fanout
LANGFUSE_FANOUT_OTEL_RECEIVER_ENDPOINT=0.0.0.0:4319
LANGFUSE_FANOUT_METRICS_SECRET=<metrics-bearer-token>
LANGFUSE_FANOUT_MEMORY_LIMIT_MIB=256
LANGFUSE_FANOUT_MEMORY_SPIKE_LIMIT_MIB=64
LANGFUSE_FANOUT_BATCH_TIMEOUT=1s
LANGFUSE_FANOUT_BATCH_SEND_SIZE=128
LANGFUSE_FANOUT_METADATA_CARDINALITY_LIMIT=1000
```

Langfuse Cloud base URL options:

| Region | Base URL                        |
| ------ | ------------------------------- |
| EU     | `https://cloud.langfuse.com`    |
| US     | `https://us.cloud.langfuse.com` |
| JP     | `https://jp.cloud.langfuse.com` |

Then start LibreChat with the fanout override:

```sh
docker compose -f docker-compose.yml -f docker-compose.langfuse-fanout.yml up -d
```

For the deployed compose stack:

```sh
docker compose -f deploy-compose.yml -f deploy-compose.langfuse-fanout.yml up -d
```

The override builds the fanout gateway image, sets `LANGFUSE_FANOUT_ENABLED=true`, and points LibreChat at
`http://langfuse-fanout-collector:4318`. It also starts an internal
`langfuse-fanout-otel` service on the private fanout network for trace export.

## Helm

The Compose overrides build the gateway image locally. For Kubernetes, build
the same image from the repository root, push it to a registry available to
the cluster, and set `langfuseFanout.image.repository` and `.tag` to match:

```sh
docker build \
  -f otel/langfuse-fanout/Dockerfile \
  -t registry.example.com/librechat-langfuse-fanout:<tag> .
docker push registry.example.com/librechat-langfuse-fanout:<tag>
```

Create a secret containing the central Langfuse Basic auth header:

```sh
kubectl create secret generic langfuse-central \
  --from-literal=LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER='Basic <base64-public-key-colon-secret-key>'
```

Enable the gateway in values. Use either the bundled Redis chart as shown here
or set `langfuseFanout.redis.uri` to an external Redis service.

```yaml
redis:
  enabled: true

langfuseFanout:
  enabled: true
  image:
    repository: registry.example.com/librechat-langfuse-fanout
    tag: '<tag>'
    pullPolicy: IfNotPresent
  central:
    baseUrl: https://cloud.langfuse.com
    authHeaderSecret:
      name: langfuse-central
      key: LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER
  metrics:
    secret:
      name: librechat-metrics
      key: METRICS_SECRET
  tenant:
    destinations:
      eu:
        baseUrl: https://cloud.langfuse.com
      us:
        baseUrl: https://us.cloud.langfuse.com
      jp:
        baseUrl: https://jp.cloud.langfuse.com
  upstreamTimeout: 30s
  publicUrl: ''
  otelCollector:
    receiverEndpoint: 127.0.0.1:4319
  redis:
    uri: ''
    username: ''
    passwordSecret:
      name: ''
      key: REDIS_PASSWORD
    keyPrefix: langfuse-fanout
  memoryLimitMiB: 256
  memorySpikeLimitMiB: 64
  batchTimeout: 1s
  batchSendSize: 128
  metadataCardinalityLimit: 1000
```

The chart renders one fanout Deployment with two containers: the gateway on
`4318` and an internal OpenTelemetry collector on `4319`. The Service exposes
only the gateway. The chart also injects `LANGFUSE_FANOUT_ENABLED` plus
`LANGFUSE_FANOUT_COLLECTOR_URL` into the LibreChat app ConfigMap when they are
not already supplied in `librechat.configEnv`.

Set `langfuseFanout.redis.uri` when using an external Redis service. If Redis
requires auth, set `langfuseFanout.redis.username` and point
`langfuseFanout.redis.passwordSecret.name`/`.key` at an existing Kubernetes
Secret. When using the bundled Redis chart with auth enabled, create a password
Secret for the gateway or provide an explicit authenticated URI.
Prefer `passwordSecret` over embedding credentials in `redis.uri`, because the
URI is rendered directly into the Deployment environment.
Scale the gateway manually with `langfuseFanout.replicaCount`; the chart does
not create a fanout HPA. The gateway container has configurable `/healthz`
liveness and readiness probes under `langfuseFanout`.

Useful gateway metrics include:

- `langfuse_fanout_http_requests_total`
- `langfuse_fanout_upstream_requests_total`
- `langfuse_fanout_trace_exports_total` (`destination`, `result`, and `tenant_id` labels)
- `langfuse_fanout_media_upload_plans_created_total`
- `langfuse_fanout_media_upload_plans_completed_total`
- `langfuse_fanout_media_upload_plan_misses_total`
- `langfuse_fanout_media_upload_plan_store_errors_total`
- `langfuse_fanout_media_upload_bytes`
- `langfuse_fanout_media_divergence_total`

LibreChat stamps `librechat.tenant.id`, `librechat.langfuse.export_plan`, and
`librechat.langfuse.export_reason` on Langfuse run spans. The gateway reads the
tenant ID from each OTLP batch for the trace export counter. Batches without a
tenant ID use `<unknown>`; batches containing more than one tenant use `<multiple>`.
Invalid tenant IDs use `<invalid>`. The gateway retains up to 1,000 valid tenant
labels and aggregates additional IDs under `<overflow>`, bounding the trace
counter's cardinality. Angle brackets keep these synthetic values outside
LibreChat's accepted tenant-ID grammar.

Successful admin connection updates emit the structured log event
`librechat.langfuse.connection.changed`. It includes the tenant, configuration
state, destination, verification result, a primary `change`, and all `changes`.
It does not include the Langfuse public or secret key.

`langfuse_fanout_media_divergence_total{kind="media_id"}` is the correctness
signal for trace/media token fanout. `kind="upload_url_presence"` records that
some destinations returned an upload URL while others treated the media as
already uploaded.

## Notes

- The gateway handles Langfuse media uploads and proxies traces to the internal
  collector. Feedback scores go directly to Langfuse's REST API from the
  LibreChat API process.
- `LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER` must be a full Basic auth header and is
  consumed by the fanout deployment only. The app does not use it for scores.
- `LANGFUSE_FANOUT_CENTRAL_BASE_URL` is also consumed by the fanout deployment only.
  For non-EU central feedback scores, set LibreChat's normal `LANGFUSE_BASE_URL`
  to the same central Langfuse region.
- Tenant destinations default to the three configured Langfuse Cloud regions. Add or
  override `langfuseFanout.tenant.destinations` in Helm for self-hosted or
  custom destinations.
- `LANGFUSE_FANOUT_LISTEN_ADDR` controls the gateway HTTP bind address and
  defaults to `:4318`.
- `LANGFUSE_FANOUT_UPSTREAM_TIMEOUT` tunes the timeout for gateway calls to
  Langfuse APIs and presigned media upload URLs.
- `LANGFUSE_FANOUT_PUBLIC_URL` pins the base URL returned for the SDK's
  one-time media upload. The gateway fails startup when it is unset or invalid;
  this avoids trusting request `Host` or `X-Forwarded-Host` headers.
- `LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS` is a startup guard that must contain
  every key in `LANGFUSE_FANOUT_TENANT_DESTINATIONS`; this prevents media
  fanout from accepting a destination the collector cannot route traces to.
- `LANGFUSE_FANOUT_REDIS_URI`, optional `LANGFUSE_FANOUT_REDIS_USERNAME`,
  optional `LANGFUSE_FANOUT_REDIS_PASSWORD`, and
  `LANGFUSE_FANOUT_REDIS_KEY_PREFIX` configure the shared one-time media upload
  plan store. The gateway fails startup without a Redis URI.
- `LANGFUSE_FANOUT_OTEL_RECEIVER_ENDPOINT` controls the internal collector
  receiver bind address.
- `LANGFUSE_FANOUT_METRICS_SECRET` protects the gateway `/metrics` endpoint.
  If unset, the gateway falls back to `METRICS_SECRET` when present.
- `LANGFUSE_FANOUT_MEMORY_LIMIT_MIB`,
  `LANGFUSE_FANOUT_MEMORY_SPIKE_LIMIT_MIB`, `LANGFUSE_FANOUT_BATCH_TIMEOUT`,
  `LANGFUSE_FANOUT_BATCH_SEND_SIZE`, and
  `LANGFUSE_FANOUT_METADATA_CARDINALITY_LIMIT` tune the internal collector.
- `LANGFUSE_FANOUT_COLLECTOR_URL` is the local gateway URL used by LibreChat.
  The env name is kept for compatibility with the original collector shape; it
  is not a Langfuse Cloud base URL.
