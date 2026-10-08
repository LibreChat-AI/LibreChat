package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	tracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

const (
	defaultListenAddr     = ":4318"
	defaultTraceCollector = "http://127.0.0.1:4319"
	centralName           = "central"
	tenantPrefix          = "/tenant/"
	centralMediaDisabled  = "central-media-disabled"
	mediaUploadProxyPath  = "/__langfuse-fanout/media-upload/"
	otelTracePath         = "/api/public/otel/v1/traces"
	mediaPath             = "/api/public/media"
	metricsPath           = "/metrics"
	tenantExportAttribute = "librechat.langfuse.tenant_export.enabled"
	tenantDestAttribute   = "librechat.langfuse.destination"
	tenantIDAttribute     = "librechat.tenant.id"
	unknownTenantID       = "<unknown>"
	multipleTenantIDs     = "<multiple>"
)

type config struct {
	listenAddr           string
	traceCollectorURL    string
	publicURL            string
	metricsSecret        string
	traceDestinationKeys map[string]bool
	centralMediaExport   bool
	central              destination
	tenants              map[string]string
	redis                redisConfig
	uploadStore          uploadPlanStore
	client               *http.Client
}

type redisConfig struct {
	uri       string
	username  string
	password  string
	keyPrefix string
}

type destination struct {
	name          string
	baseURL       string
	authorization string
}

type route struct {
	destination         string
	path                string
	disableCentralMedia bool
}

type uploadDestination struct {
	Name      string `json:"name"`
	UploadURL string `json:"uploadUrl"`
}

type uploadPlan struct {
	ExpiresAt     time.Time           `json:"expiresAt"`
	Destinations  []uploadDestination `json:"destinations"`
	ContentLength int64               `json:"contentLength"`
}

type uploadPlanStore interface {
	Put(ctx context.Context, uploadID string, plan uploadPlan) error
	Take(ctx context.Context, uploadID string) (uploadPlan, bool, error)
	Ping(ctx context.Context) error
	Close() error
}

type gateway struct {
	cfg         config
	metrics     *gatewayMetrics
	metricsHTTP http.Handler
}

type mediaUploadResponse struct {
	UploadURL *string `json:"uploadUrl"`
	MediaID   string  `json:"mediaId"`
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}
	uploadStore, err := newRedisUploadPlanStore(cfg.redis)
	if err != nil {
		log.Fatalf("failed to initialize Redis upload plan store: %v", err)
	}
	defer uploadStore.Close()
	cfg.uploadStore = uploadStore

	gw := newGateway(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	mux.HandleFunc("/", gw.handle)

	server := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("langfuse fanout gateway listening on %s", cfg.listenAddr)
	errCh := make(chan error, 1)
	go func() {
		errCh <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("server shutdown failed: %v", err)
		}
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}
}

func newGateway(cfg config) *gateway {
	if cfg.uploadStore == nil {
		panic("langfuse fanout gateway requires an upload plan store")
	}
	metrics := newGatewayMetrics()
	return &gateway{
		cfg:         cfg,
		metrics:     metrics,
		metricsHTTP: promhttp.HandlerFor(metrics.registry, promhttp.HandlerOpts{}),
	}
}

func loadConfig() (config, error) {
	centralBaseURL := normalizeBaseURL(os.Getenv("LANGFUSE_FANOUT_CENTRAL_BASE_URL"))
	centralAuth := strings.TrimSpace(os.Getenv("LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER"))
	if centralBaseURL == "" {
		return config{}, errors.New("LANGFUSE_FANOUT_CENTRAL_BASE_URL is required")
	}
	if centralAuth == "" {
		return config{}, errors.New("LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER is required")
	}

	tenants := map[string]string{}
	for _, item := range strings.Split(os.Getenv("LANGFUSE_FANOUT_TENANT_DESTINATIONS"), ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		key, value, ok := strings.Cut(item, "=")
		if !ok {
			continue
		}
		key = normalizeDestinationKey(key)
		if key == "" {
			continue
		}
		if baseURL := normalizeBaseURL(value); baseURL != "" {
			tenants[key] = baseURL
		}
	}
	traceDestinationKeys := parseDestinationKeys(os.Getenv("LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS"))
	if len(tenants) > 0 && len(traceDestinationKeys) == 0 {
		return config{}, errors.New("LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS is required when LANGFUSE_FANOUT_TENANT_DESTINATIONS is set")
	}
	for key := range tenants {
		if len(traceDestinationKeys) > 0 && !traceDestinationKeys[key] {
			return config{}, fmt.Errorf("tenant destination %q is not present in LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS", key)
		}
	}
	rawPublicURL := strings.TrimSpace(os.Getenv("LANGFUSE_FANOUT_PUBLIC_URL"))
	publicURL := normalizeBaseURL(rawPublicURL)
	if publicURL == "" {
		return config{}, errors.New("LANGFUSE_FANOUT_PUBLIC_URL must be an absolute HTTP(S) URL")
	}
	redisURI := strings.TrimSpace(os.Getenv("LANGFUSE_FANOUT_REDIS_URI"))
	if redisURI == "" {
		return config{}, errors.New("LANGFUSE_FANOUT_REDIS_URI is required for media upload plan storage")
	}

	return config{
		listenAddr:           envOrDefault("LANGFUSE_FANOUT_LISTEN_ADDR", defaultListenAddr),
		traceCollectorURL:    normalizeCollectorURL(envOrDefault("LANGFUSE_FANOUT_TRACE_COLLECTOR_URL", defaultTraceCollector)),
		publicURL:            publicURL,
		metricsSecret:        firstNonEmptyEnv("LANGFUSE_FANOUT_METRICS_SECRET", "METRICS_SECRET"),
		traceDestinationKeys: traceDestinationKeys,
		centralMediaExport:   !isTrueEnv("LANGFUSE_FANOUT_CENTRAL_MEDIA_EXPORT_DISABLED"),
		central: destination{
			name:          centralName,
			baseURL:       centralBaseURL,
			authorization: centralAuth,
		},
		tenants: tenants,
		redis: redisConfig{
			uri:       redisURI,
			username:  strings.TrimSpace(os.Getenv("LANGFUSE_FANOUT_REDIS_USERNAME")),
			password:  strings.TrimSpace(os.Getenv("LANGFUSE_FANOUT_REDIS_PASSWORD")),
			keyPrefix: envOrDefault("LANGFUSE_FANOUT_REDIS_KEY_PREFIX", "langfuse-fanout"),
		},
		client: &http.Client{
			Timeout: parseDurationEnv("LANGFUSE_FANOUT_UPSTREAM_TIMEOUT", 30*time.Second),
		},
	}, nil
}

func (g *gateway) handle(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = recorder
	defer func() {
		if r.URL.Path != metricsPath && g.metrics != nil {
			g.metrics.recordHTTP(r.Method, normalizeMetricPath(r.URL.Path), recorder.status, time.Since(startedAt))
		}
	}()

	route := parseRoute(r.URL.Path)
	switch {
	case route.path == otelTracePath && r.Method == http.MethodPost:
		g.handleTraces(w, r, route)
	case route.path == mediaPath && r.Method == http.MethodPost:
		g.handleMediaCreate(w, r, route)
	case strings.HasPrefix(route.path, mediaPath+"/") && r.Method == http.MethodGet:
		g.handleMediaGet(w, r, route)
	case strings.HasPrefix(route.path, mediaPath+"/") && r.Method == http.MethodPatch:
		g.handleMediaPatch(w, r, route)
	case strings.HasPrefix(r.URL.Path, mediaUploadProxyPath) && r.Method == http.MethodPut:
		g.handleMediaUpload(w, r)
	case r.URL.Path == "/healthz":
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	case r.URL.Path == metricsPath && r.Method == http.MethodGet:
		g.handleMetrics(w, r)
	default:
		http.Error(w, "langfuse fanout gateway only supports OTLP traces and media upload APIs", http.StatusNotImplemented)
	}
}

func (g *gateway) handleTraces(w http.ResponseWriter, r *http.Request, route route) {
	body, err := readMaybeGzip(r)
	if err != nil {
		g.recordTraceExport(route, "error", unknownTenantID)
		g.writeGatewayError(w, r, route, "trace_export", http.StatusBadRequest, "failed to read request body", err)
		return
	}

	contentType := r.Header.Get("Content-Type")
	tenantID := unknownTenantID
	authorizedTenantRoute := route.destination != "" &&
		g.cfg.tenants[route.destination] != "" &&
		strings.TrimSpace(r.Header.Get("Authorization")) != ""
	if authorizedTenantRoute {
		body, tenantID, err = addTenantRouteAttributes(body, contentType, route.destination)
		if err != nil {
			g.recordTraceExport(route, "error", tenantID)
			g.writeGatewayError(w, r, route, "trace_route_attributes", http.StatusBadRequest, "failed to add OTLP tenant routing attributes", err)
			return
		}
	} else if g.metrics != nil {
		tenantID = extractTraceTenantID(body, contentType)
	}

	contentEncoding := ""
	if strings.EqualFold(r.Header.Get("Content-Encoding"), "gzip") {
		contentEncoding = "gzip"
		body, err = gzipBytes(body)
		if err != nil {
			g.recordTraceExport(route, "error", tenantID)
			g.writeGatewayError(w, r, route, "trace_gzip", http.StatusInternalServerError, "failed to encode request body", err)
			return
		}
	}

	resp, err := g.forwardTraceToCollector(r.Context(), r.Header, body, contentType, contentEncoding)
	if err != nil {
		g.recordTraceExport(route, "error", tenantID)
		g.writeGatewayError(w, r, route, "trace_collector", http.StatusBadGateway, "trace collector export failed", err)
		return
	}
	defer resp.Body.Close()

	g.recordTraceExport(route, "success", tenantID)
	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (g *gateway) handleMediaCreate(w http.ResponseWriter, r *http.Request, route route) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
	if err != nil {
		g.writeGatewayError(w, r, route, "media_create", http.StatusBadRequest, "failed to read media create request", err)
		return
	}
	if err := g.cfg.uploadStore.Ping(r.Context()); err != nil {
		g.recordUploadPlanStoreError("ping")
		g.writeGatewayError(w, r, route, "upload_plan_ping", http.StatusBadGateway, "media upload plan store unavailable", err)
		return
	}

	destinations := g.mediaDestinations(route, r.Header.Get("Authorization"))
	if len(destinations) == 0 {
		g.writeGatewayError(w, r, route, "media_create", http.StatusBadGateway, "no media destinations configured", nil)
		return
	}

	type mediaCreateResult struct {
		destination destination
		response    mediaUploadResponse
		err         error
	}
	responses := make([]mediaCreateResult, len(destinations))
	var wg sync.WaitGroup
	for index, dest := range destinations {
		index, dest := index, dest
		wg.Add(1)
		go func() {
			defer wg.Done()
			response, err := g.postMediaCreate(r.Context(), dest, body, r.Header.Get("Content-Type"))
			responses[index] = mediaCreateResult{destination: dest, response: response, err: err}
		}()
	}
	wg.Wait()
	for _, result := range responses {
		if result.err != nil {
			g.writeGatewayError(w, r, route, "media_create", http.StatusBadGateway, fmt.Sprintf("%s media create failed", result.destination.name), result.err, "upstream_destination", result.destination.name)
			return
		}
	}

	mediaID := responses[0].response.MediaID
	if mediaID == "" {
		g.writeGatewayError(w, r, route, "media_create", http.StatusBadGateway, "upstream media create returned empty mediaId", nil, "upstream_destination", responses[0].destination.name)
		return
	}
	// Langfuse derives mediaId from the content hash today, so all fanout
	// destinations should converge on the same id for the same POST body.
	for _, response := range responses[1:] {
		if response.response.MediaID != mediaID {
			g.recordMediaDivergence("media_id", response.destination.name)
			g.writeGatewayError(w, r, route, "media_create", http.StatusBadGateway, "upstream media IDs differ across destinations", errors.New("upstream media IDs differ across destinations"),
				"kind", "media_id",
				"upstream_destination", response.destination.name,
				"reference_destination", responses[0].destination.name,
			)
			return
		}
	}

	uploadPlan := uploadPlan{
		ExpiresAt:    time.Now().Add(time.Hour),
		Destinations: []uploadDestination{},
	}
	var requestBody struct {
		ContentLength int64 `json:"contentLength"`
	}
	_ = json.Unmarshal(body, &requestBody)
	uploadPlan.ContentLength = requestBody.ContentLength

	hadUploadURL := false
	missingUploadURLDestinations := []string{}
	for _, response := range responses {
		if response.response.UploadURL == nil || *response.response.UploadURL == "" {
			missingUploadURLDestinations = append(missingUploadURLDestinations, response.destination.name)
			continue
		}
		hadUploadURL = true
		uploadPlan.Destinations = append(uploadPlan.Destinations, uploadDestination{
			Name:      response.destination.name,
			UploadURL: *response.response.UploadURL,
		})
	}
	if hadUploadURL {
		for _, destination := range missingUploadURLDestinations {
			g.logGatewayWarning(r, route, "media_create", "upstream media upload URL presence differs across destinations",
				"kind", "upload_url_presence",
				"upstream_destination", destination,
			)
			g.recordMediaDivergence("upload_url_presence", destination)
		}
	}

	result := mediaUploadResponse{MediaID: mediaID}
	if len(uploadPlan.Destinations) > 0 {
		uploadID, err := randomID()
		if err != nil {
			g.writeGatewayError(w, r, route, "upload_plan_create", http.StatusInternalServerError, "failed to create media upload id", err)
			return
		}
		if err := g.storeUpload(r.Context(), uploadID, uploadPlan); err != nil {
			g.recordUploadPlanStoreError("put")
			g.writeGatewayError(w, r, route, "upload_plan_put", http.StatusBadGateway, "failed to store media upload plan", err)
			return
		}
		g.recordUploadPlanCreated(uploadPlan)
		uploadURL := g.absoluteURL(mediaUploadProxyPath + uploadID)
		result.UploadURL = &uploadURL
	}

	writeJSON(w, http.StatusCreated, result)
}

func (g *gateway) handleMediaPatch(w http.ResponseWriter, r *http.Request, route route) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		g.writeGatewayError(w, r, route, "media_patch", http.StatusBadRequest, "failed to read media patch request", err)
		return
	}

	destinations := g.mediaDestinations(route, r.Header.Get("Authorization"))
	if len(destinations) == 0 {
		g.writeGatewayError(w, r, route, "media_patch", http.StatusBadGateway, "no media destinations configured", nil)
		return
	}

	type patchResult struct {
		destination string
		err         error
	}
	results := make([]patchResult, len(destinations))
	var wg sync.WaitGroup
	for index, dest := range destinations {
		index, dest := index, dest
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[index] = patchResult{
				destination: dest.name,
				err:         g.patchMedia(r.Context(), dest, route.path, body, r.Header.Get("Content-Type")),
			}
		}()
	}
	wg.Wait()
	for _, result := range results {
		if result.err != nil {
			g.writeGatewayError(w, r, route, "media_patch", http.StatusBadGateway, fmt.Sprintf("%s media patch failed", result.destination), result.err, "upstream_destination", result.destination)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (g *gateway) handleMediaGet(w http.ResponseWriter, r *http.Request, route route) {
	destinations := g.mediaDestinations(route, r.Header.Get("Authorization"))
	if len(destinations) == 0 {
		g.writeGatewayError(w, r, route, "media_get", http.StatusBadGateway, "no media destinations configured", nil)
		return
	}
	target := destinations[0]
	if route.destination != "" {
		target = destinations[len(destinations)-1]
	}
	resp, err := g.getMedia(r.Context(), target, route.path, r.URL.RawQuery)
	if err != nil {
		g.writeGatewayError(w, r, route, "media_get", http.StatusBadGateway, "media get failed", err, "upstream_destination", target.name)
		return
	}
	defer resp.Body.Close()
	copyResponseHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (g *gateway) getMedia(ctx context.Context, target destination, path string, rawQuery string) (*http.Response, error) {
	upstreamURL := target.baseURL + path
	if rawQuery != "" {
		upstreamURL += "?" + rawQuery
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", target.authorization)
	resp, err := g.doUpstream(req, "media_get", target.name)
	if err != nil {
		return nil, err
	}
	return resp, nil
}

func (g *gateway) handleMetrics(w http.ResponseWriter, r *http.Request) {
	if g.cfg.metricsSecret == "" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	const prefix = "Bearer "
	auth := r.Header.Get("Authorization")
	if len(auth) < len(prefix) || !strings.EqualFold(auth[:len(prefix)], prefix) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	token := strings.TrimSpace(auth[len(prefix):])
	if subtle.ConstantTimeCompare([]byte(token), []byte(g.cfg.metricsSecret)) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	g.metricsHTTP.ServeHTTP(w, r)
}

func (g *gateway) handleMediaUpload(w http.ResponseWriter, r *http.Request) {
	uploadID := strings.TrimPrefix(r.URL.Path, mediaUploadProxyPath)

	plan, ok, err := g.takeUpload(r.Context(), uploadID)
	if err != nil {
		g.recordUploadPlanStoreError("take")
		g.writeGatewayError(w, r, route{path: r.URL.Path}, "upload_plan_take", http.StatusBadGateway, "failed to load media upload plan", err)
		return
	}
	if !ok {
		g.recordUploadPlanMiss()
		g.writeGatewayError(w, r, route{path: r.URL.Path}, "media_upload", http.StatusNotFound, "unknown or expired upload", nil)
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUploadBytes(plan.ContentLength)))
	if err != nil {
		attrs := []any{}
		if restoreErr := g.restoreUpload(r.Context(), uploadID, plan); restoreErr != nil {
			g.recordUploadPlanStoreError("restore")
			attrs = append(attrs, "restore_error", safeErrorMessage(restoreErr))
		}
		g.writeGatewayError(w, r, route{path: r.URL.Path}, "media_upload", http.StatusBadRequest, "failed to read upload body", err, attrs...)
		return
	}

	type uploadResult struct {
		destination string
		status      int
		err         error
	}
	results := make([]uploadResult, len(plan.Destinations))
	var wg sync.WaitGroup
	for index, dest := range plan.Destinations {
		index, dest := index, dest
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, err := g.putMedia(r.Context(), dest, body, r.Header)
			results[index] = uploadResult{destination: dest.Name, status: code, err: err}
		}()
	}
	wg.Wait()
	status := http.StatusOK
	for _, result := range results {
		if result.err != nil {
			attrs := []any{"upstream_destination", result.destination}
			if restoreErr := g.restoreUpload(r.Context(), uploadID, plan); restoreErr != nil {
				g.recordUploadPlanStoreError("restore")
				attrs = append(attrs, "restore_error", safeErrorMessage(restoreErr))
			}
			g.writeGatewayError(w, r, route{path: r.URL.Path}, "media_upload", http.StatusBadGateway, fmt.Sprintf("%s upload failed", result.destination), result.err, attrs...)
			return
		}
		if result.status > status {
			status = result.status
		}
	}
	g.recordUploadPlanCompleted(plan)
	w.WriteHeader(status)
}

func (g *gateway) mediaDestinations(route route, tenantAuth string) []destination {
	destinations := []destination{}
	if g.cfg.centralMediaExport && !route.disableCentralMedia {
		destinations = append(destinations, g.cfg.central)
	}
	if route.destination == "" {
		return destinations
	}
	baseURL := g.cfg.tenants[route.destination]
	if baseURL == "" || strings.TrimSpace(tenantAuth) == "" {
		return destinations
	}
	return append(destinations, destination{
		name:          "tenant_" + route.destination,
		baseURL:       baseURL,
		authorization: strings.TrimSpace(tenantAuth),
	})
}

func (g *gateway) forwardTraceToCollector(ctx context.Context, headers http.Header, body []byte, contentType string, contentEncoding string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.cfg.traceCollectorURL+otelTracePath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentTypeOrDefault(contentType, "application/x-protobuf"))
	if value := strings.TrimSpace(headers.Get("Authorization")); value != "" {
		req.Header.Set("Authorization", value)
	}
	if contentEncoding != "" {
		req.Header.Set("Content-Encoding", contentEncoding)
	}
	resp, err := g.doUpstream(req, "trace_collector", "collector")
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		drainResponseBody(resp.Body)
		return nil, upstreamStatusError{status: resp.StatusCode}
	}
	return resp, nil
}

func (g *gateway) postMediaCreate(ctx context.Context, dest destination, body []byte, contentType string) (mediaUploadResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dest.baseURL+mediaPath, bytes.NewReader(body))
	if err != nil {
		return mediaUploadResponse{}, err
	}
	req.Header.Set("Authorization", dest.authorization)
	req.Header.Set("Content-Type", contentTypeOrDefault(contentType, "application/json"))
	resp, err := g.doUpstream(req, "media_create", dest.name)
	if err != nil {
		return mediaUploadResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		drainResponseBody(resp.Body)
		return mediaUploadResponse{}, upstreamStatusError{status: resp.StatusCode}
	}
	var result mediaUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return mediaUploadResponse{}, err
	}
	return result, nil
}

func (g *gateway) patchMedia(ctx context.Context, dest destination, path string, body []byte, contentType string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, dest.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", dest.authorization)
	req.Header.Set("Content-Type", contentTypeOrDefault(contentType, "application/json"))
	return g.doExpect2xx("media_patch", dest.name, req)
}

func (g *gateway) putMedia(ctx context.Context, dest uploadDestination, body []byte, originalHeaders http.Header) (int, error) {
	if err := validateMediaUploadURL(dest.UploadURL); err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, dest.UploadURL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	if value := originalHeaders.Get("Content-Type"); value != "" {
		if !allowedUploadContentType(value) {
			return 0, fmt.Errorf("unsupported upload content type %q", value)
		}
		req.Header.Set("Content-Type", value)
	}
	if value := originalHeaders.Get("Content-Encoding"); value != "" {
		req.Header.Set("Content-Encoding", value)
	}
	if isAzureUploadURL(dest.UploadURL) {
		if value := originalHeaders.Get("x-ms-blob-type"); value != "" {
			req.Header.Set("x-ms-blob-type", value)
		}
	} else if !isGCSUploadURL(dest.UploadURL) {
		if value := originalHeaders.Get("x-amz-checksum-sha256"); value != "" {
			req.Header.Set("x-amz-checksum-sha256", value)
		}
	}
	uploadClient := *g.cfg.client
	uploadClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	resp, err := g.doUpstreamWithClient(&uploadClient, req, "media_upload", dest.Name)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		drainResponseBody(resp.Body)
		return resp.StatusCode, upstreamStatusError{status: resp.StatusCode}
	}
	return resp.StatusCode, nil
}

func (g *gateway) doExpect2xx(operation string, destination string, req *http.Request) error {
	resp, err := g.doUpstream(req, operation, destination)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		drainResponseBody(resp.Body)
		return upstreamStatusError{status: resp.StatusCode}
	}
	return nil
}

func (g *gateway) doUpstream(req *http.Request, operation string, destination string) (*http.Response, error) {
	return g.doUpstreamWithClient(g.cfg.client, req, operation, destination)
}

func (g *gateway) doUpstreamWithClient(client *http.Client, req *http.Request, operation string, destination string) (*http.Response, error) {
	startedAt := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		duration := time.Since(startedAt)
		if g.metrics != nil {
			g.metrics.recordUpstream(operation, destination, "error", duration)
		}
		return nil, err
	}
	duration := time.Since(startedAt)
	upstreamStatusClass := statusClass(resp.StatusCode)
	if g.metrics != nil {
		g.metrics.recordUpstream(operation, destination, upstreamStatusClass, duration)
	}
	return resp, nil
}

func (g *gateway) recordTraceExport(route route, result string, tenantID string) {
	if g.metrics == nil {
		return
	}
	destination := centralName
	if _, ok := g.cfg.tenants[route.destination]; ok {
		destination = routeDestinationLabel(route)
	}
	g.metrics.recordTraceExport(destination, result, tenantID)
}

func (g *gateway) recordMediaDivergence(kind string, destination string) {
	if g.metrics != nil {
		g.metrics.recordMediaDivergence(kind, destination)
	}
}

func (g *gateway) recordUploadPlanCreated(plan uploadPlan) {
	if g.metrics != nil {
		g.metrics.recordUploadPlanCreated(plan.ContentLength)
	}
}

func (g *gateway) recordUploadPlanCompleted(plan uploadPlan) {
	if len(plan.Destinations) == 0 {
		return
	}
	if g.metrics != nil {
		g.metrics.recordUploadPlanCompleted()
	}
}

func (g *gateway) recordUploadPlanMiss() {
	if g.metrics != nil {
		g.metrics.recordUploadPlanMiss()
	}
}

func (g *gateway) recordUploadPlanStoreError(operation string) {
	if g.metrics != nil {
		g.metrics.recordUploadPlanStoreError(operation)
	}
}

func addTenantRouteAttributes(body []byte, contentType string, destination string) ([]byte, string, error) {
	if isJSONContentType(contentType) {
		return addJSONTenantRouteAttributes(body, destination)
	}
	return addProtobufTenantRouteAttributes(body, destination)
}

func extractTraceTenantID(body []byte, contentType string) string {
	if isJSONContentType(contentType) {
		return extractJSONTraceTenantID(body)
	}
	return extractProtobufTraceTenantID(body)
}

func resolveTraceTenantID(tenantIDs map[string]struct{}) string {
	if len(tenantIDs) == 0 {
		return unknownTenantID
	}
	if len(tenantIDs) > 1 {
		return multipleTenantIDs
	}
	for tenantID := range tenantIDs {
		return tenantID
	}
	return unknownTenantID
}

func extractProtobufTraceTenantID(body []byte) string {
	var request tracepb.ExportTraceServiceRequest
	if err := proto.Unmarshal(body, &request); err != nil {
		return unknownTenantID
	}
	return protobufTraceTenantID(&request)
}

func protobufTraceTenantID(request *tracepb.ExportTraceServiceRequest) string {
	tenantIDs := make(map[string]struct{})
	for _, resourceSpan := range request.ResourceSpans {
		for _, scopeSpan := range resourceSpan.ScopeSpans {
			for _, span := range scopeSpan.Spans {
				for _, attribute := range span.Attributes {
					if attribute.Key != tenantIDAttribute {
						continue
					}
					tenantID := strings.TrimSpace(attribute.Value.GetStringValue())
					if tenantID != "" {
						tenantIDs[tenantID] = struct{}{}
						if len(tenantIDs) > 1 {
							return multipleTenantIDs
						}
					}
				}
			}
		}
	}
	return resolveTraceTenantID(tenantIDs)
}

func extractJSONTraceTenantID(body []byte) string {
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		return unknownTenantID
	}
	return jsonTraceTenantID(request)
}

func jsonTraceTenantID(request map[string]any) string {
	tenantIDs := make(map[string]struct{})
	resourceSpans, _ := request["resourceSpans"].([]any)
	for _, resourceSpan := range resourceSpans {
		resourceSpanMap, _ := resourceSpan.(map[string]any)
		scopeSpans, _ := resourceSpanMap["scopeSpans"].([]any)
		for _, scopeSpan := range scopeSpans {
			scopeSpanMap, _ := scopeSpan.(map[string]any)
			spans, _ := scopeSpanMap["spans"].([]any)
			for _, span := range spans {
				spanMap, _ := span.(map[string]any)
				attributes, _ := spanMap["attributes"].([]any)
				for _, attribute := range attributes {
					attributeMap, _ := attribute.(map[string]any)
					if attributeMap["key"] != tenantIDAttribute {
						continue
					}
					value, _ := attributeMap["value"].(map[string]any)
					tenantID, _ := value["stringValue"].(string)
					tenantID = strings.TrimSpace(tenantID)
					if tenantID != "" {
						tenantIDs[tenantID] = struct{}{}
						if len(tenantIDs) > 1 {
							return multipleTenantIDs
						}
					}
				}
			}
		}
	}
	return resolveTraceTenantID(tenantIDs)
}

func addProtobufTenantRouteAttributes(body []byte, destination string) ([]byte, string, error) {
	var request tracepb.ExportTraceServiceRequest
	if err := proto.Unmarshal(body, &request); err != nil {
		return nil, unknownTenantID, err
	}
	tenantID := protobufTraceTenantID(&request)

	for _, resourceSpan := range request.ResourceSpans {
		for _, scopeSpan := range resourceSpan.ScopeSpans {
			for _, span := range scopeSpan.Spans {
				upsertSpanStringAttribute(span, tenantDestAttribute, destination)
				upsertSpanStringAttribute(span, tenantExportAttribute, "true")
			}
		}
	}

	updatedBody, err := proto.Marshal(&request)
	return updatedBody, tenantID, err
}

func upsertSpanStringAttribute(span *tracev1.Span, key string, value string) {
	for _, attribute := range span.Attributes {
		if attribute.Key == key {
			attribute.Value = stringAnyValue(value)
			return
		}
	}
	span.Attributes = append(span.Attributes, &commonv1.KeyValue{
		Key:   key,
		Value: stringAnyValue(value),
	})
}

func stringAnyValue(value string) *commonv1.AnyValue {
	return &commonv1.AnyValue{
		Value: &commonv1.AnyValue_StringValue{StringValue: value},
	}
}

func addJSONTenantRouteAttributes(body []byte, destination string) ([]byte, string, error) {
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		return nil, unknownTenantID, err
	}
	tenantID := jsonTraceTenantID(request)
	resourceSpans, _ := request["resourceSpans"].([]any)
	for _, resourceSpan := range resourceSpans {
		resourceSpanMap, _ := resourceSpan.(map[string]any)
		scopeSpans, _ := resourceSpanMap["scopeSpans"].([]any)
		for _, scopeSpan := range scopeSpans {
			scopeSpanMap, _ := scopeSpan.(map[string]any)
			spans, _ := scopeSpanMap["spans"].([]any)
			for _, span := range spans {
				spanMap, _ := span.(map[string]any)
				upsertJSONSpanStringAttribute(spanMap, tenantDestAttribute, destination)
				upsertJSONSpanStringAttribute(spanMap, tenantExportAttribute, "true")
			}
		}
	}
	updatedBody, err := json.Marshal(request)
	return updatedBody, tenantID, err
}

func upsertJSONSpanStringAttribute(span map[string]any, key string, value string) {
	attrs, _ := span["attributes"].([]any)
	for _, attr := range attrs {
		attrMap, _ := attr.(map[string]any)
		if attrMap["key"] == key {
			attrMap["value"] = map[string]any{"stringValue": value}
			return
		}
	}
	span["attributes"] = append(attrs, map[string]any{
		"key":   key,
		"value": map[string]any{"stringValue": value},
	})
}

func stringValue(value *commonv1.AnyValue) string {
	if value == nil {
		return ""
	}
	if stringValue := value.GetStringValue(); stringValue != "" {
		return stringValue
	}
	if value.GetBoolValue() {
		return "true"
	}
	return ""
}

func (g *gateway) storeUpload(ctx context.Context, uploadID string, plan uploadPlan) error {
	return g.cfg.uploadStore.Put(ctx, uploadID, plan)
}

func (g *gateway) takeUpload(ctx context.Context, uploadID string) (uploadPlan, bool, error) {
	if !validUploadID(uploadID) {
		return uploadPlan{}, false, nil
	}
	plan, ok, err := g.cfg.uploadStore.Take(ctx, uploadID)
	if err != nil || !ok {
		return uploadPlan{}, ok, err
	}
	return plan, true, nil
}

func (g *gateway) restoreUpload(ctx context.Context, uploadID string, plan uploadPlan) error {
	if time.Now().After(plan.ExpiresAt) {
		return nil
	}
	return g.cfg.uploadStore.Put(ctx, uploadID, plan)
}

type redisUploadPlanStore struct {
	client *redis.Client
	prefix string
}

func newRedisUploadPlanStore(cfg redisConfig) (*redisUploadPlanStore, error) {
	options, err := redis.ParseURL(cfg.uri)
	if err != nil {
		return nil, fmt.Errorf("parse LANGFUSE_FANOUT_REDIS_URI: %w", err)
	}
	if cfg.username != "" {
		options.Username = cfg.username
	}
	if cfg.password != "" {
		options.Password = cfg.password
	}
	client := redis.NewClient(options)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("ping Redis: %w", err)
	}
	return &redisUploadPlanStore{
		client: client,
		prefix: normalizeRedisKeyPrefix(cfg.keyPrefix),
	}, nil
}

func (s *redisUploadPlanStore) Put(ctx context.Context, uploadID string, plan uploadPlan) error {
	if !validUploadID(uploadID) {
		return errors.New("invalid upload id")
	}
	ttl := time.Until(plan.ExpiresAt)
	if ttl <= 0 {
		return errors.New("upload plan already expired")
	}
	body, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, s.key(uploadID), body, ttl).Err()
}

func (s *redisUploadPlanStore) Take(ctx context.Context, uploadID string) (uploadPlan, bool, error) {
	if !validUploadID(uploadID) {
		return uploadPlan{}, false, nil
	}
	value, err := redisTakeScript.Run(ctx, s.client, []string{s.key(uploadID)}).Text()
	if errors.Is(err, redis.Nil) {
		return uploadPlan{}, false, nil
	}
	if err != nil {
		return uploadPlan{}, false, err
	}
	var plan uploadPlan
	if err := json.Unmarshal([]byte(value), &plan); err != nil {
		return uploadPlan{}, false, err
	}
	return plan, true, nil
}

func (s *redisUploadPlanStore) Ping(ctx context.Context) error {
	return s.client.Ping(ctx).Err()
}

func (s *redisUploadPlanStore) Close() error {
	return s.client.Close()
}

func (s *redisUploadPlanStore) key(uploadID string) string {
	return s.prefix + ":media-upload:" + uploadID
}

var redisTakeScript = redis.NewScript(`
local value = redis.call("GET", KEYS[1])
if value then
  redis.call("DEL", KEYS[1])
end
return value
`)

func normalizeRedisKeyPrefix(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "langfuse-fanout"
	}
	return strings.TrimRight(value, ":")
}

func validUploadID(value string) bool {
	if value == "" || len(value) > 128 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'f':
		case r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return true
}

func parseRoute(path string) route {
	if !strings.HasPrefix(path, tenantPrefix) {
		return route{path: path}
	}
	rest := strings.TrimPrefix(path, tenantPrefix)
	destination, suffix, ok := strings.Cut(rest, "/")
	if !ok {
		return route{path: path}
	}
	normalizedDestination := normalizeDestinationKey(destination)
	if normalizedDestination == "" {
		return route{path: path}
	}
	disableCentralMedia := false
	if marker, markerSuffix, ok := strings.Cut(suffix, "/"); ok && marker == centralMediaDisabled {
		disableCentralMedia = true
		suffix = markerSuffix
	}
	return route{
		destination:         normalizedDestination,
		path:                "/" + suffix,
		disableCentralMedia: disableCentralMedia,
	}
}

func readMaybeGzip(r *http.Request) ([]byte, error) {
	if !strings.EqualFold(r.Header.Get("Content-Encoding"), "gzip") {
		return io.ReadAll(io.LimitReader(r.Body, 20<<20))
	}
	reader, err := gzip.NewReader(r.Body)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	return io.ReadAll(io.LimitReader(reader, 20<<20))
}

func gzipBytes(body []byte) ([]byte, error) {
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(body); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func (g *gateway) absoluteURL(path string) string {
	return g.cfg.publicURL + path
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func copyResponseHeaders(target http.Header, source http.Header) {
	for key, values := range source {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, value := range values {
			target.Add(key, value)
		}
	}
}

func drainResponseBody(body io.Reader) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 4096))
}

func normalizeBaseURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

func normalizeCollectorURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultTraceCollector
	}
	return strings.TrimRight(value, "/")
}

func normalizeDestinationKey(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	if value == "" {
		return ""
	}
	var builder strings.Builder
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
			builder.WriteRune(r)
		case r >= '0' && r <= '9':
			builder.WriteRune(r)
		case r == '_' || r == '-':
			builder.WriteRune(r)
		default:
			builder.WriteRune('_')
		}
	}
	normalized := builder.String()
	if normalized == "" || normalized[0] < 'a' || normalized[0] > 'z' {
		return ""
	}
	return normalized
}

func parseDestinationKeys(value string) map[string]bool {
	result := map[string]bool{}
	for _, item := range strings.Split(value, ",") {
		key := normalizeDestinationKey(item)
		if key != "" {
			result[key] = true
		}
	}
	return result
}

func contentTypeOrDefault(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func isJSONContentType(value string) bool {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}

func isGCSUploadURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return host == "storage.googleapis.com" || strings.HasSuffix(host, ".storage.googleapis.com")
}

func validateMediaUploadURL(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" {
		return errors.New("media upload URL must be an absolute HTTPS URL")
	}
	if parsed.Scheme != "https" {
		return errors.New("media upload URL must use HTTPS")
	}
	return nil
}

func isAzureUploadURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	host := parsed.Hostname()
	return strings.Contains(host, ".blob.core.") || strings.Contains(host, ".blob.storage.")
}

func allowedUploadContentType(value string) bool {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	switch mediaType {
	case "text/plain", "text/html", "text/css", "text/csv", "text/markdown",
		"text/x-python", "text/x-typescript", "application/javascript", "application/x-yaml",
		"application/pdf", "application/msword", "application/rtf",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/json", "application/x-ndjson", "application/xml",
		"application/vnd.apache.parquet", "application/zip", "application/gzip",
		"application/x-tar", "application/x-7z-compressed", "application/octet-stream":
		return true
	}
	return strings.HasPrefix(mediaType, "image/") ||
		strings.HasPrefix(mediaType, "audio/") ||
		strings.HasPrefix(mediaType, "video/")
}

func envOrDefault(key string, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func firstNonEmptyEnv(keys ...string) string {
	for _, key := range keys {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			return value
		}
	}
	return ""
}

func isTrueEnv(key string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func parseDurationEnv(key string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	duration, err := time.ParseDuration(value)
	if err == nil {
		return duration
	}
	seconds, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func randomID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

func maxUploadBytes(contentLength int64) int64 {
	if contentLength <= 0 {
		return 256 << 20
	}
	return contentLength + (1 << 20)
}
