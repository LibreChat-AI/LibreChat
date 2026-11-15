{{/* Render each provider from an isolated values context without changing the chart root. */}}
{{- define "librechat.channelGateway.render" -}}
{{- $root := .root -}}
{{- $template := .template -}}
{{- $manifests := list -}}
{{- range $provider := list "slack" "discord" -}}
{{- $gateway := omit $root.Values.channelGateway "discord" -}}
{{- if eq $provider "discord" -}}
{{- $gateway = merge (dict "enabled" false "mode" "shared" "channelId" "" "tenantId" "_" "replicaCount" 1 "resources" (dict) "podAnnotations" (dict) "ingress" (dict "enabled" false)) (deepCopy (pick $gateway "image" "appTitle" "internalUrl" "existingSecretName")) -}}
{{- range $key, $value := pick (default dict $root.Values.channelGateway.discord) "enabled" "replicaCount" "resources" "podAnnotations" "ingress" -}}
{{- $_ := set $gateway $key $value -}}
{{- end -}}
{{- end -}}
{{- $context := merge (dict) $root -}}
{{- $_ := set $context "Values" (deepCopy $root.Values) -}}
{{- $_ := set $context.Values "channelGateway" $gateway -}}
{{- $_ := set $context "channelProvider" $provider -}}
{{- $rendered := include $template $context | trim -}}
{{- if $rendered }}{{- $manifests = append $manifests $rendered -}}{{- end -}}
{{- end -}}
{{- join "\n---\n" $manifests -}}
{{- end }}

{{- define "librechat.channelGateway.workload" -}}
{{- if .Values.channelGateway.enabled }}
{{- $gateway := .Values.channelGateway }}
{{- $setting := ternary "channelGateway.discord" "channelGateway" (eq .channelProvider "discord") }}
{{- $mode := $gateway.mode | default "single" }}
{{- if not (has $mode (list "single" "shared")) }}
{{- fail "channelGateway.mode must be single or shared" }}
{{- end }}
{{- if and (eq $mode "shared") (or $gateway.channelId (ne $gateway.tenantId "_")) }}
{{- fail "Shared gateway mode requires an empty channelId and the default tenantId _" }}
{{- end }}
{{- $externalMongo := or (get (default dict .Values.librechat.configEnv) "MONGO_URI") (include "librechat.userEnvHas" (dict "root" . "name" "MONGO_URI")) (eq (toString (default dict .Values.librechat.injectBundledCredentials).mongodb) "false") }}
{{- if and (eq $mode "shared") .Values.mongodb.enabled (not $externalMongo) (ne (.Values.mongodb.architecture | default "standalone") "replicaset") }}
{{- fail "Shared gateways require transaction-capable MongoDB: set mongodb.architecture=replicaset, or configure an external transaction-capable MONGO_URI" }}
{{- end }}
{{- $replicas := $gateway.replicaCount | toString }}
{{- if not (regexMatch "^[1-9][0-9]*$" $replicas) }}
{{- fail (printf "%s.replicaCount must be a positive integer" $setting) }}
{{- end }}
{{- if and (eq $mode "single") (ne $replicas "1") }}
{{- fail "Single gateway mode requires channelGateway.replicaCount: 1" }}
{{- end }}
{{- $tag := include "librechat.channelGateway.imageTag" . }}
{{- $secret := required "channelGateway.existingSecretName or global.librechat.existingSecretName is required" ($gateway.existingSecretName | default .Values.global.librechat.existingSecretName) }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "librechat.channelGateway.fullname" . }}
  labels:
    {{- merge (include "librechat.channelGateway.labels" . | fromYaml) (default dict .Values.deploymentLabels) | toYaml | nindent 4 }}
  {{- with .Values.deploymentAnnotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  replicas: {{ $replicas }}
  strategy:
    {{- if eq $mode "shared" }}
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
    {{- else }}
    type: Recreate
    {{- end }}
  selector:
    matchLabels:
      {{- include "librechat.channelGateway.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      annotations:
        checksum/channel-gateway: {{ toYaml $gateway | sha256sum }}
        {{- with mergeOverwrite (deepCopy (default dict .Values.podAnnotations)) (default dict $gateway.podAnnotations) }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      labels:
        {{- merge (include "librechat.channelGateway.labels" . | fromYaml) (default dict .Values.podLabels) | toYaml | nindent 8 }}
    spec:
      automountServiceAccountToken: false
      {{- include "librechat.podSettings" . | nindent 6 }}
      securityContext:
        {{- mergeOverwrite (dict "runAsNonRoot" true "seccompProfile" (dict "type" "RuntimeDefault")) (deepCopy (default dict .Values.podSecurityContext)) | toYaml | nindent 8 }}
      containers:
        - name: channel-gateway
          image: "{{ $gateway.image.repository }}:{{ $tag }}"
          imagePullPolicy: {{ $gateway.image.pullPolicy }}
          securityContext:
            {{- mergeOverwrite (dict "allowPrivilegeEscalation" false "readOnlyRootFilesystem" true "runAsNonRoot" true "runAsUser" 1000 "capabilities" (dict "drop" (list "ALL"))) (deepCopy (default dict .Values.securityContext)) | toYaml | nindent 12 }}
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: APP_TITLE
              value: {{ include "librechat.channelGateway.appTitle" . | quote }}
            - name: PORT
              value: "8080"
            - name: LISTEN_HOST
              value: "0.0.0.0"
            - name: LIBRECHAT_INTERNAL_URL
              value: {{ $gateway.internalUrl | default (printf "http://%s:%v" (include "librechat.fullname" .) .Values.service.port) | quote }}
            {{- if eq $mode "single" }}
            - name: CHANNEL_ID
              value: {{ required "channelGateway.channelId is required when enabled" $gateway.channelId | quote }}
            - name: CHANNEL_TENANT_ID
              value: {{ $gateway.tenantId | quote }}
            {{- end }}
            {{- if eq .channelProvider "discord" }}
            - name: CHANNEL_PROVIDER
              value: "discord"
            {{- end }}
            - name: CHANNEL_SERVICE_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ $secret | quote }}
                  key: CHANNEL_SERVICE_TOKEN
            {{- if eq $mode "single" }}
            {{- with $gateway.slackAppTokenKey }}
            - name: SLACK_APP_TOKEN
              valueFrom:
                secretKeyRef:
                  name: {{ $secret | quote }}
                  key: {{ . | quote }}
            {{- end }}
            {{- end }}
          startupProbe:
            httpGet:
              path: /livez
              port: http
            periodSeconds: 5
            failureThreshold: 24
          livenessProbe:
            httpGet:
              path: /livez
              port: http
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
          resources:
            {{- toYaml $gateway.resources | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ include "librechat.channelGateway.fullname" . }}
  labels:
    {{- include "librechat.channelGateway.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  ports:
    - name: http
      port: 8080
      targetPort: http
  selector:
    {{- include "librechat.channelGateway.selectorLabels" . | nindent 4 }}
{{- end }}
{{- end }}

{{- define "librechat.channelGateway.ingress" -}}
{{- $ingress := .Values.channelGateway.ingress -}}
{{- $setting := ternary "channelGateway.discord" "channelGateway" (eq .channelProvider "discord") -}}
{{- if $ingress.enabled -}}
{{- if not .Values.channelGateway.enabled -}}
{{- fail (printf "Enable %s.enabled before enabling its ingress" $setting) -}}
{{- end -}}
{{- if not (semverCompare ">=1.19-0" .Capabilities.KubeVersion.GitVersion) -}}
{{- fail "The gateway Ingress requires Kubernetes 1.19 or newer" -}}
{{- end -}}
{{- $name := include "librechat.channelGateway.fullname" . -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ $name }}
  labels:
    {{- include "librechat.channelGateway.labels" . | nindent 4 }}
  {{- with $ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with $ingress.className | default .Values.ingress.className }}
  ingressClassName: {{ . | quote }}
  {{- end }}
  {{- with $ingress.tls }}
  tls:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  rules:
    - host: {{ required (printf "%s.ingress.host is required when its ingress is enabled" $setting) $ingress.host | quote }}
      http:
        paths:
          {{- $paths := list "/slack/events" "/slack/interactions" }}
          {{- if eq .channelProvider "discord" }}{{- $paths = list "/discord/" }}{{- end }}
          {{- range $paths }}
          - path: {{ . }}
            pathType: Prefix
            backend:
              service:
                name: {{ $name }}
                port:
                  number: 8080
          {{- end }}
{{- end }}
{{- end }}
