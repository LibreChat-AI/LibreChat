package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

const (
	maxTenantMetricLabels = 1000
	invalidTenantID       = "<invalid>"
	overflowTenantID      = "<overflow>"
)

type gatewayMetrics struct {
	registry              *prometheus.Registry
	httpRequests          *prometheus.CounterVec
	httpDuration          *prometheus.HistogramVec
	upstreamRequests      *prometheus.CounterVec
	upstreamDuration      *prometheus.HistogramVec
	traceExports          *prometheus.CounterVec
	mediaDivergence       *prometheus.CounterVec
	uploadPlansCreated    prometheus.Counter
	uploadPlansCompleted  prometheus.Counter
	uploadPlanMisses      prometheus.Counter
	uploadPlanStoreErrors *prometheus.CounterVec
	uploadBytes           prometheus.Histogram
	tenantLabelsMu        sync.Mutex
	tenantLabels          map[string]struct{}
}

func newGatewayMetrics() *gatewayMetrics {
	registry := prometheus.NewRegistry()
	registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)

	metrics := &gatewayMetrics{
		registry:     registry,
		tenantLabels: make(map[string]struct{}, maxTenantMetricLabels),
		httpRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "langfuse_fanout_http_requests_total",
			Help: "Total HTTP requests handled by the Langfuse fanout gateway.",
		}, []string{"method", "path", "status"}),
		httpDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "langfuse_fanout_http_request_duration_seconds",
			Help:    "HTTP request duration for the Langfuse fanout gateway.",
			Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30},
		}, []string{"method", "path", "status"}),
		upstreamRequests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "langfuse_fanout_upstream_requests_total",
			Help: "Total upstream requests made by the Langfuse fanout gateway.",
		}, []string{"operation", "destination", "status_class"}),
		upstreamDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "langfuse_fanout_upstream_request_duration_seconds",
			Help:    "Upstream request duration for Langfuse and collector calls.",
			Buckets: []float64{0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30},
		}, []string{"operation", "destination", "status_class"}),
		traceExports: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "langfuse_fanout_trace_exports_total",
			Help: "Total trace export attempts through the Langfuse fanout gateway.",
		}, []string{"destination", "result", "tenant_id"}),
		mediaDivergence: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "langfuse_fanout_media_divergence_total",
			Help: "Media fanout upstream response divergence by kind. Values are counts only; no media IDs or URLs are exposed.",
		}, []string{"kind", "destination"}),
		uploadPlansCreated: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "langfuse_fanout_media_upload_plans_created_total",
			Help: "Total media upload fanout plans stored for SDK byte upload.",
		}),
		uploadPlansCompleted: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "langfuse_fanout_media_upload_plans_completed_total",
			Help: "Total media upload fanout plans consumed by SDK byte upload.",
		}),
		uploadPlanMisses: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "langfuse_fanout_media_upload_plan_misses_total",
			Help: "Total media upload attempts that did not find a stored fanout plan.",
		}),
		uploadPlanStoreErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "langfuse_fanout_media_upload_plan_store_errors_total",
			Help: "Total Redis upload plan store errors by operation.",
		}, []string{"operation"}),
		uploadBytes: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "langfuse_fanout_media_upload_bytes",
			Help:    "Configured media upload content length for fanout upload plans.",
			Buckets: []float64{1_000, 10_000, 100_000, 1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000, 250_000_000},
		}),
	}

	registry.MustRegister(
		metrics.httpRequests,
		metrics.httpDuration,
		metrics.upstreamRequests,
		metrics.upstreamDuration,
		metrics.traceExports,
		metrics.mediaDivergence,
		metrics.uploadPlansCreated,
		metrics.uploadPlansCompleted,
		metrics.uploadPlanMisses,
		metrics.uploadPlanStoreErrors,
		metrics.uploadBytes,
	)
	return metrics
}

func (m *gatewayMetrics) recordHTTP(method string, path string, status int, duration time.Duration) {
	if m == nil {
		return
	}
	labels := prometheus.Labels{
		"method": method,
		"path":   path,
		"status": fmt.Sprintf("%d", status),
	}
	m.httpRequests.With(labels).Inc()
	m.httpDuration.With(labels).Observe(duration.Seconds())
}

func (m *gatewayMetrics) recordUpstream(operation string, destination string, statusClass string, duration time.Duration) {
	if m == nil {
		return
	}
	labels := prometheus.Labels{
		"operation":    operation,
		"destination":  normalizeMetricLabel(destination),
		"status_class": statusClass,
	}
	m.upstreamRequests.With(labels).Inc()
	m.upstreamDuration.With(labels).Observe(duration.Seconds())
}

func (m *gatewayMetrics) recordTraceExport(destination string, result string, tenantID string) {
	if m == nil {
		return
	}
	m.traceExports.WithLabelValues(normalizeMetricLabel(destination), result, m.tenantMetricLabel(tenantID)).Inc()
}

func (m *gatewayMetrics) tenantMetricLabel(tenantID string) string {
	tenantID = strings.TrimSpace(tenantID)
	if tenantID == "" {
		return unknownTenantID
	}
	if tenantID == unknownTenantID || tenantID == multipleTenantIDs {
		return tenantID
	}
	if !validTenantMetricID(tenantID) {
		return invalidTenantID
	}

	m.tenantLabelsMu.Lock()
	defer m.tenantLabelsMu.Unlock()
	if _, ok := m.tenantLabels[tenantID]; ok {
		return tenantID
	}
	if len(m.tenantLabels) >= maxTenantMetricLabels {
		return overflowTenantID
	}
	m.tenantLabels[tenantID] = struct{}{}
	return tenantID
}

func validTenantMetricID(tenantID string) bool {
	if len(tenantID) > 128 {
		return false
	}
	for _, r := range tenantID {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '.':
		default:
			return false
		}
	}
	return true
}

func (m *gatewayMetrics) recordMediaDivergence(kind string, destination string) {
	if m == nil {
		return
	}
	m.mediaDivergence.WithLabelValues(normalizeMetricLabel(kind), normalizeMetricLabel(destination)).Inc()
}

func (m *gatewayMetrics) recordUploadPlanCreated(contentLength int64) {
	if m == nil {
		return
	}
	m.uploadPlansCreated.Inc()
	if contentLength > 0 {
		m.uploadBytes.Observe(float64(contentLength))
	}
}

func (m *gatewayMetrics) recordUploadPlanCompleted() {
	if m == nil {
		return
	}
	m.uploadPlansCompleted.Inc()
}

func (m *gatewayMetrics) recordUploadPlanMiss() {
	if m == nil {
		return
	}
	m.uploadPlanMisses.Inc()
}

func (m *gatewayMetrics) recordUploadPlanStoreError(operation string) {
	if m == nil {
		return
	}
	m.uploadPlanStoreErrors.WithLabelValues(normalizeMetricLabel(operation)).Inc()
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (w *statusRecorder) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func normalizeMetricPath(path string) string {
	route := parseRoute(path)
	switch {
	case route.path == otelTracePath:
		if route.destination == "" {
			return otelTracePath
		}
		return tenantPrefix + "#destination" + otelTracePath
	case route.path == mediaPath:
		if route.destination == "" {
			return mediaPath
		}
		return tenantPrefix + "#destination" + mediaPath
	case strings.HasPrefix(route.path, mediaPath+"/"):
		if route.destination == "" {
			return mediaPath + "/#mediaId"
		}
		return tenantPrefix + "#destination" + mediaPath + "/#mediaId"
	case strings.HasPrefix(path, mediaUploadProxyPath):
		return mediaUploadProxyPath + "#uploadId"
	case path == "/healthz":
		return "/healthz"
	default:
		return "/#path"
	}
}

func normalizeMetricLabel(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return "unknown"
	}
	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '_' || r == '-' || r == ':':
			builder.WriteRune(r)
		default:
			builder.WriteRune('_')
		}
		if builder.Len() >= 80 {
			break
		}
	}
	if builder.Len() == 0 {
		return "unknown"
	}
	return builder.String()
}

func statusClass(status int) string {
	if status <= 0 {
		return "error"
	}
	return fmt.Sprintf("%dxx", status/100)
}
