



{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "librechat.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}


{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "librechat.fullname" -}}
{{- if $.Values.fullnameOverride }}
{{- $.Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "librechat.labels" -}}
{{- include "librechat.standardLabels" (dict "root" . "selectorLabels" (include "librechat.selectorLabels" .)) }}
{{- end }}

{{/*
Standard labels for chart-managed workloads.
*/}}
{{- define "librechat.standardLabels" -}}
{{- $root := .root -}}
helm.sh/chart: {{ include "librechat.chart" $root }}
{{ .selectorLabels }}
{{- if $root.Chart.AppVersion }}
app.kubernetes.io/version: {{ $root.Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
{{- end -}}

{{/*
Selector labels
*/}}
{{- define "librechat.selectorLabels" -}}
app.kubernetes.io/name: {{ include "librechat.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Langfuse fanout collector service name.
*/}}
{{- define "librechat.langfuseFanout.fullname" -}}
{{- printf "%s-langfuse-fanout" (include "librechat.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Langfuse fanout collector selector labels.
*/}}
{{- define "librechat.langfuseFanout.selectorLabels" -}}
app.kubernetes.io/name: {{ include "librechat.langfuseFanout.fullname" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Langfuse fanout collector labels.
*/}}
{{- define "librechat.langfuseFanout.labels" -}}
{{- include "librechat.standardLabels" (dict "root" . "selectorLabels" (include "librechat.langfuseFanout.selectorLabels" .)) }}
{{- end }}

{{/*
Validate Langfuse fanout destination keys. LibreChat normalizes destination
keys to lowercase before putting them on trace attributes, so Helm values must
already use the same lowercase key shape for collector routing to match.
*/}}
{{- define "librechat.langfuseFanout.validateDestinationKey" -}}
{{- $name := printf "%v" . -}}
{{- if not (regexMatch "^[a-z][a-z0-9_-]*$" $name) -}}
{{- fail (printf "langfuseFanout.tenant.destinations key %q is invalid; use lowercase keys matching ^[a-z][a-z0-9_-]*$ so LibreChat trace attributes match collector routes" $name) -}}
{{- end -}}
{{- end }}

{{/*
Render the environment variable name used by the collector for a destination.
*/}}
{{- define "librechat.langfuseFanout.destinationBaseUrlEnvName" -}}
{{- printf "LANGFUSE_FANOUT_TENANT_%s_BASE_URL" (. | printf "%v" | upper | replace "-" "_") -}}
{{- end }}

{{/*
Validate the full destination key set. Destination keys can contain hyphens and
underscores, but the collector base URL env vars replace hyphens with
underscores. Reject keys such as foo-bar and foo_bar because they would render
the same LANGFUSE_FANOUT_TENANT_FOO_BAR_BASE_URL env var.
*/}}
{{- define "librechat.langfuseFanout.validateDestinationKeys" -}}
{{- $seenEnvNames := dict -}}
{{- range $name, $_destination := .Values.langfuseFanout.tenant.destinations -}}
{{- include "librechat.langfuseFanout.validateDestinationKey" $name -}}
{{- $envName := include "librechat.langfuseFanout.destinationBaseUrlEnvName" $name -}}
{{- if hasKey $seenEnvNames $envName -}}
{{- fail (printf "langfuseFanout.tenant.destinations keys %q and %q both render %s; use destination keys that remain unique after uppercasing and replacing '-' with '_' for env vars" (get $seenEnvNames $envName) $name $envName) -}}
{{- end -}}
{{- $_ := set $seenEnvNames $envName $name -}}
{{- end -}}
{{- end }}

{{/*
Render the fanout destination list consumed by LibreChat and the fanout gateway.
*/}}
{{- define "librechat.langfuseFanout.tenantDestinationsEnv" -}}
{{- include "librechat.langfuseFanout.validateDestinationKeys" . -}}
{{- $tenantDestinations := list -}}
{{- range $name, $destination := .Values.langfuseFanout.tenant.destinations -}}
{{- $tenantDestinations = append $tenantDestinations (printf "%s=%s" $name $destination.baseUrl) -}}
{{- end -}}
{{- join "," $tenantDestinations -}}
{{- end }}

{{/*
Render the fanout destination key list consumed by the gateway as a startup
guard against media destinations the collector cannot route traces to.
*/}}
{{- define "librechat.langfuseFanout.tenantDestinationKeysEnv" -}}
{{- include "librechat.langfuseFanout.validateDestinationKeys" . -}}
{{- $tenantDestinationKeys := list -}}
{{- range $name, $_destination := .Values.langfuseFanout.tenant.destinations -}}
{{- $tenantDestinationKeys = append $tenantDestinationKeys $name -}}
{{- end -}}
{{- join "," $tenantDestinationKeys -}}
{{- end }}

{{/*
Bundled Redis URI used when the Redis subchart is enabled.
*/}}
{{- define "librechat.bundledRedisURI" -}}
{{- printf "redis://%s-master.%s.svc.cluster.local:6379" (include "common.names.fullname" .Subcharts.redis) (.Release.Namespace | lower) -}}
{{- end }}

{{/*
RAG Selector labels
*/}}
{{- define "rag.selectorLabels" -}}
app.kubernetes.io/name: {{ include "librechat.fullname" . }}-rag
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "librechat.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "librechat.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Define apiVersion of HorizontalPodAutoscaler
*/}}
{{- define "librechat.hpa.apiVersion" -}}
{{- if .Capabilities.APIVersions.Has "autoscaling/v2" -}}
{{- print "autoscaling/v2" -}}
{{- else if .Capabilities.APIVersions.Has "autoscaling/v2beta2" -}}
{{- print "autoscaling/v2beta2" -}}
{{- else -}}
{{- print "autoscaling/v2beta1" -}}
{{- end -}}
{{- end -}}
