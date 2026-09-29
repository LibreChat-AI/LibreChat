package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	tracepb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	commonv1 "go.opentelemetry.io/proto/otlp/common/v1"
	resourcev1 "go.opentelemetry.io/proto/otlp/resource/v1"
	tracev1 "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestLoadConfigRejectsDestinationsMissingTraceRoutes(t *testing.T) {
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_BASE_URL", "https://cloud.langfuse.com")
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER", "Basic central")
	t.Setenv("LANGFUSE_FANOUT_PUBLIC_URL", "http://fanout.local:4318")
	t.Setenv("LANGFUSE_FANOUT_TENANT_DESTINATIONS", "eu=https://cloud.langfuse.com,ca=https://example.com")
	t.Setenv("LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS", "eu,us,jp")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), `tenant destination "ca"`) {
		t.Fatalf("expected missing trace route error, got %v", err)
	}
}

func TestLoadConfigRejectsTenantDestinationsWithoutTraceKeys(t *testing.T) {
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_BASE_URL", "https://cloud.langfuse.com")
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER", "Basic central")
	t.Setenv("LANGFUSE_FANOUT_PUBLIC_URL", "http://fanout.local:4318")
	t.Setenv("LANGFUSE_FANOUT_TENANT_DESTINATIONS", "eu=https://cloud.langfuse.com")
	t.Setenv("LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS", "")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "LANGFUSE_FANOUT_TRACE_DESTINATION_KEYS is required") {
		t.Fatalf("expected missing trace keys error, got %v", err)
	}
}

func TestLoadConfigRejectsInvalidPublicURL(t *testing.T) {
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_BASE_URL", "https://cloud.langfuse.com")
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER", "Basic central")
	t.Setenv("LANGFUSE_FANOUT_PUBLIC_URL", "ftp://example.com")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "LANGFUSE_FANOUT_PUBLIC_URL") {
		t.Fatalf("expected invalid public URL error, got %v", err)
	}
}

func TestLoadConfigRequiresRedisURI(t *testing.T) {
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_BASE_URL", "https://cloud.langfuse.com")
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER", "Basic central")
	t.Setenv("LANGFUSE_FANOUT_PUBLIC_URL", "http://fanout.local:4318")

	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "LANGFUSE_FANOUT_REDIS_URI") {
		t.Fatalf("expected missing Redis URI error, got %v", err)
	}
}

func TestLoadConfigDisablesCentralMediaExport(t *testing.T) {
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_BASE_URL", "https://cloud.langfuse.com")
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER", "Basic central")
	t.Setenv("LANGFUSE_FANOUT_PUBLIC_URL", "http://fanout.local:4318")
	t.Setenv("LANGFUSE_FANOUT_REDIS_URI", "redis://localhost:6379")
	t.Setenv("LANGFUSE_FANOUT_CENTRAL_MEDIA_EXPORT_DISABLED", "true")

	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("loadConfig error: %v", err)
	}
	if cfg.centralMediaExport {
		t.Fatal("central media export should be disabled")
	}
}

func TestNormalizeBaseURLAllowsOnlyHTTPAndHTTPS(t *testing.T) {
	if got := normalizeBaseURL("http://localhost:3000/path/"); got != "http://localhost:3000/path" {
		t.Fatalf("http URL normalized to %q", got)
	}
	if got := normalizeBaseURL("https://cloud.langfuse.com/"); got != "https://cloud.langfuse.com" {
		t.Fatalf("https URL normalized to %q", got)
	}
	if got := normalizeBaseURL("file:///tmp/langfuse"); got != "" {
		t.Fatalf("file URL should be rejected, got %q", got)
	}
}

func TestValidateMediaUploadURLRequiresHTTPS(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "public storage", url: "https://bucket.s3.amazonaws.com/object?X-Amz-Signature=value"},
		{name: "self-hosted storage", url: "https://minio.internal:9000/object"},
		{name: "private address", url: "https://10.0.0.8/object"},
		{name: "http", url: "http://minio.internal:9000/object", wantErr: true},
		{name: "unsupported scheme", url: "ftp://storage.example.com/object", wantErr: true},
		{name: "relative", url: "/object", wantErr: true},
		{name: "missing host", url: "https:///object", wantErr: true},
		{name: "malformed", url: "://storage.example.com/object", wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateMediaUploadURL(test.url)
			if (err != nil) != test.wantErr {
				t.Fatalf("validateMediaUploadURL(%q) error = %v, wantErr %t", test.url, err, test.wantErr)
			}
		})
	}
}

func TestPutMediaDoesNotFollowRedirects(t *testing.T) {
	t.Parallel()

	var targetRequests int
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		targetRequests++
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/upload", http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()

	gw := newTestGateway(redirect.URL, nil)
	gw.cfg.client = redirect.Client()
	status, err := gw.putMedia(context.Background(), uploadDestination{
		Name:      centralName,
		UploadURL: redirect.URL + "/upload",
	}, []byte("hello"), http.Header{"Content-Type": []string{"image/png"}})
	if status != http.StatusTemporaryRedirect {
		t.Fatalf("status = %d, want %d", status, http.StatusTemporaryRedirect)
	}
	if err == nil {
		t.Fatal("expected redirect response to fail the upload")
	}
	if targetRequests != 0 {
		t.Fatalf("redirect target requests = %d, want 0", targetRequests)
	}
}

func TestTraceProxyForwardsExistingRoutingAttributesToCollector(t *testing.T) {
	t.Parallel()

	var collectorTrace []byte
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != otelTracePath {
			t.Fatalf("unexpected collector path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Basic tenant" {
			t.Fatalf("collector auth = %q", got)
		}
		collectorTrace, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{}"))
	}))
	defer collector.Close()

	gw := newTestGatewayWithCollector(collector.URL)
	body := buildTraceRequest(t, map[string]string{
		tenantExportAttribute: "true",
		tenantDestAttribute:   "eu",
		"kept":                "value",
	})

	req := httptest.NewRequest(http.MethodPost, otelTracePath, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if resp.Body.String() != "{}" {
		t.Fatalf("expected collector response body, got %s", resp.Body.String())
	}
	if len(collectorTrace) == 0 {
		t.Fatal("expected collector export")
	}

	attrs := parseTraceAttributes(t, collectorTrace)
	if attrs[tenantExportAttribute] != "true" || attrs[tenantDestAttribute] != "eu" {
		t.Fatalf("collector trace missing routing attrs: %#v", attrs)
	}
	if attrs["kept"] != "value" {
		t.Fatalf("collector trace lost kept attr: %#v", attrs)
	}
}

func TestTraceProxyDoesNotReturnCollectorErrorDetails(t *testing.T) {
	var logBuffer bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuffer, nil)))
	t.Cleanup(func() {
		slog.SetDefault(previousLogger)
	})
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "failed https://storage.example.com/object?X-Amz-Signature=secret", http.StatusBadGateway)
	}))
	defer collector.Close()

	gw := newTestGatewayWithCollector(collector.URL)
	body := buildTraceRequest(t, nil)
	req := httptest.NewRequest(http.MethodPost, otelTracePath, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-protobuf")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if strings.Contains(resp.Body.String(), "storage.example.com") || strings.Contains(resp.Body.String(), "secret") {
		t.Fatalf("response leaked collector error details: %s", resp.Body.String())
	}
	if strings.TrimSpace(resp.Body.String()) != "trace collector export failed" {
		t.Fatalf("unexpected response body: %s", resp.Body.String())
	}
	logOutput := logBuffer.String()
	if strings.Contains(logOutput, "storage.example.com") || strings.Contains(logOutput, "secret") {
		t.Fatalf("log leaked collector error details: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"operation":"trace_collector"`) {
		t.Fatalf("log missing operation context: %s", logOutput)
	}
	if got := strings.Count(strings.TrimSpace(logOutput), "\n") + 1; got != 1 {
		t.Fatalf("expected one gateway failure log, got %d: %s", got, logOutput)
	}
}

func TestGzipTraceProxyAddsRoutingAttributesFromPath(t *testing.T) {
	t.Parallel()

	var collectorTrace []byte
	var collectorEncoding string
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		collectorEncoding = r.Header.Get("Content-Encoding")
		reader, err := gzip.NewReader(r.Body)
		if err != nil {
			t.Fatalf("collector gzip reader: %v", err)
		}
		defer reader.Close()
		collectorTrace, _ = io.ReadAll(reader)
		_, _ = w.Write([]byte(`{"partialSuccess":{}}`))
	}))
	defer collector.Close()

	var zipped bytes.Buffer
	zipper := gzip.NewWriter(&zipped)
	if _, err := zipper.Write(buildTraceRequest(t, map[string]string{"kept": "value"})); err != nil {
		t.Fatal(err)
	}
	if err := zipper.Close(); err != nil {
		t.Fatal(err)
	}

	gw := newTestGatewayWithCollector(collector.URL)
	req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu"+otelTracePath, bytes.NewReader(zipped.Bytes()))
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if collectorEncoding != "gzip" {
		t.Fatalf("collector encoding = %q", collectorEncoding)
	}
	if resp.Body.String() != `{"partialSuccess":{}}` {
		t.Fatalf("expected collector response body, got %s", resp.Body.String())
	}
	attrs := parseTraceAttributes(t, collectorTrace)
	if attrs[tenantExportAttribute] != "true" || attrs[tenantDestAttribute] != "eu" || attrs["kept"] != "value" {
		t.Fatalf("collector trace attrs = %#v", attrs)
	}
}

func TestJSONTraceProxyAddsRoutingAttributesFromPath(t *testing.T) {
	t.Parallel()

	var collectorTrace []byte
	var collectorContentType string
	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != otelTracePath {
			t.Fatalf("unexpected collector path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Basic tenant" {
			t.Fatalf("collector auth = %q", got)
		}
		collectorContentType = r.Header.Get("Content-Type")
		collectorTrace, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte("{}"))
	}))
	defer collector.Close()

	gw := newTestGatewayWithCollector(collector.URL)
	body := buildJSONTraceRequest(t, map[string]any{
		"kept": "value",
	})

	req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu"+otelTracePath, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if len(collectorTrace) == 0 {
		t.Fatal("expected collector export")
	}
	if collectorContentType != "application/json" {
		t.Fatalf("content type = %q", collectorContentType)
	}
	attrs := parseJSONTraceAttributes(t, collectorTrace)
	if attrs[tenantExportAttribute] != "true" || attrs[tenantDestAttribute] != "eu" {
		t.Fatalf("collector trace missing routing attrs: %#v", attrs)
	}
	if attrs["kept"] != "value" {
		t.Fatalf("collector trace lost kept attr: %#v", attrs)
	}
}

func TestMediaUploadFansOutToCentralAndTenant(t *testing.T) {
	t.Parallel()

	for _, contentType := range []string{
		"image/png", "audio/wav", "video/mp4",
		"text/plain", "text/plain; charset=utf-8", "text/html", "text/css", "text/csv",
		"text/markdown", "text/x-python", "text/x-typescript",
		"application/javascript", "application/x-yaml", "application/pdf", "application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		"application/rtf", "application/json", "Application/JSON; charset=utf-8",
		"application/x-ndjson", "application/xml", "application/vnd.apache.parquet",
		"application/zip", "application/gzip", "application/x-tar",
		"application/x-7z-compressed", "application/octet-stream",
	} {
		t.Run(contentType, func(t *testing.T) {
			t.Parallel()
			var mu sync.Mutex
			uploads := map[string]string{}
			uploadContentTypes := map[string]string{}
			upstream := func(name string) *httptest.Server {
				return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch {
					case r.Method == http.MethodPost && r.URL.Path == mediaPath:
						uploadURL := "https://" + r.Host + "/upload/" + name
						writeJSON(w, http.StatusCreated, mediaUploadResponse{
							MediaID:   "same-media-id",
							UploadURL: &uploadURL,
						})
					case r.Method == http.MethodPut && r.URL.Path == "/upload/"+name:
						body, _ := io.ReadAll(r.Body)
						mu.Lock()
						uploads[name] = string(body)
						uploadContentTypes[name] = r.Header.Get("Content-Type")
						mu.Unlock()
						w.WriteHeader(http.StatusOK)
					case r.Method == http.MethodPatch && r.URL.Path == mediaPath+"/same-media-id":
						w.WriteHeader(http.StatusNoContent)
					default:
						http.NotFound(w, r)
					}
				}))
			}
			central := upstream("central")
			defer central.Close()
			tenant := upstream("tenant")
			defer tenant.Close()

			store := newFakeUploadPlanStore()
			createGateway := newTestGatewayWithStore(central.URL, map[string]string{"eu": tenant.URL}, store)
			uploadGateway := newTestGatewayWithStore(central.URL, map[string]string{"eu": tenant.URL}, store)
			createGateway.cfg.client = central.Client()
			uploadGateway.cfg.client = central.Client()
			createBody := fmt.Sprintf(`{"traceId":"trace","contentType":%q,"contentLength":5,"sha256Hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","field":"input"}`, contentType)
			req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu"+mediaPath, strings.NewReader(createBody))
			req.Header.Set("Authorization", "Basic tenant")
			resp := httptest.NewRecorder()

			createGateway.handle(resp, req)
			if resp.Code != http.StatusCreated {
				t.Fatalf("create status = %d, body = %s", resp.Code, resp.Body.String())
			}
			var create mediaUploadResponse
			if err := json.NewDecoder(resp.Body).Decode(&create); err != nil {
				t.Fatal(err)
			}
			if create.MediaID != "same-media-id" || create.UploadURL == nil || !strings.Contains(*create.UploadURL, mediaUploadProxyPath) {
				t.Fatalf("unexpected create response: %#v", create)
			}
			uploadID := strings.TrimPrefix(newUploadURLPath(t, *create.UploadURL), mediaUploadProxyPath)
			store.mu.Lock()
			storedPlan := store.plans[uploadID]
			store.mu.Unlock()
			storedPlanJSON, err := json.Marshal(storedPlan)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(storedPlanJSON), "Basic ") {
				t.Fatalf("stored upload plan leaked authorization: %s", storedPlanJSON)
			}

			uploadReq := httptest.NewRequest(http.MethodPut, *create.UploadURL, strings.NewReader("hello"))
			uploadReq.Header.Set("Content-Type", contentType)
			uploadResp := httptest.NewRecorder()
			uploadGateway.handle(uploadResp, uploadReq)
			if uploadResp.Code != http.StatusOK {
				t.Fatalf("upload status = %d, body = %s", uploadResp.Code, uploadResp.Body.String())
			}

			patchReq := httptest.NewRequest(http.MethodPatch, tenantPrefix+"eu"+mediaPath+"/same-media-id", strings.NewReader(`{"uploadHttpStatus":200}`))
			patchReq.Header.Set("Authorization", "Basic tenant")
			patchResp := httptest.NewRecorder()
			uploadGateway.handle(patchResp, patchReq)
			if patchResp.Code != http.StatusNoContent {
				t.Fatalf("patch status = %d, body = %s", patchResp.Code, patchResp.Body.String())
			}

			mu.Lock()
			defer mu.Unlock()
			if uploads["central"] != "hello" || uploads["tenant"] != "hello" {
				t.Fatalf("uploads = %#v", uploads)
			}
			if uploadContentTypes["central"] != contentType || uploadContentTypes["tenant"] != contentType {
				t.Fatalf("upload content types = %#v", uploadContentTypes)
			}
		})
	}
}

func TestMediaUploadSkipsCentralForCentralMediaDisabledTenantRoute(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	uploads := map[string]string{}
	upstream := func(name string) *httptest.Server {
		return httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodPost && r.URL.Path == mediaPath:
				uploadURL := "https://" + r.Host + "/upload/" + name
				writeJSON(w, http.StatusCreated, mediaUploadResponse{
					MediaID:   "same-media-id",
					UploadURL: &uploadURL,
				})
			case r.Method == http.MethodPut && r.URL.Path == "/upload/"+name:
				body, _ := io.ReadAll(r.Body)
				mu.Lock()
				uploads[name] = string(body)
				mu.Unlock()
				w.WriteHeader(http.StatusOK)
			case r.Method == http.MethodPatch && r.URL.Path == mediaPath+"/same-media-id":
				w.WriteHeader(http.StatusNoContent)
			default:
				http.NotFound(w, r)
			}
		}))
	}
	central := upstream("central")
	defer central.Close()
	tenant := upstream("tenant")
	defer tenant.Close()

	store := newFakeUploadPlanStore()
	createGateway := newTestGatewayWithStore(central.URL, map[string]string{"eu": tenant.URL}, store)
	uploadGateway := newTestGatewayWithStore(central.URL, map[string]string{"eu": tenant.URL}, store)
	createGateway.cfg.client = central.Client()
	uploadGateway.cfg.client = central.Client()
	createBody := `{"traceId":"trace","contentType":"image/png","contentLength":5,"sha256Hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","field":"input"}`
	req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu/"+centralMediaDisabled+mediaPath, strings.NewReader(createBody))
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	createGateway.handle(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", resp.Code, resp.Body.String())
	}
	var create mediaUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&create); err != nil {
		t.Fatal(err)
	}
	if create.MediaID != "same-media-id" || create.UploadURL == nil {
		t.Fatalf("unexpected create response: %#v", create)
	}

	uploadReq := httptest.NewRequest(http.MethodPut, *create.UploadURL, strings.NewReader("hello"))
	uploadReq.Header.Set("Content-Type", "image/png")
	uploadResp := httptest.NewRecorder()
	uploadGateway.handle(uploadResp, uploadReq)
	if uploadResp.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body = %s", uploadResp.Code, uploadResp.Body.String())
	}

	patchReq := httptest.NewRequest(http.MethodPatch, tenantPrefix+"eu/"+centralMediaDisabled+mediaPath+"/same-media-id", strings.NewReader(`{"uploadHttpStatus":200}`))
	patchReq.Header.Set("Authorization", "Basic tenant")
	patchResp := httptest.NewRecorder()
	uploadGateway.handle(patchResp, patchReq)
	if patchResp.Code != http.StatusNoContent {
		t.Fatalf("patch status = %d, body = %s", patchResp.Code, patchResp.Body.String())
	}

	mu.Lock()
	defer mu.Unlock()
	if _, ok := uploads["central"]; ok {
		t.Fatalf("central upload should be skipped, uploads = %#v", uploads)
	}
	if uploads["tenant"] != "hello" {
		t.Fatalf("tenant upload missing, uploads = %#v", uploads)
	}
}

func TestMediaUploadSkipsCentralWhenCentralMediaExportDisabled(t *testing.T) {
	t.Parallel()

	var centralCreates int
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		centralCreates++
		http.NotFound(w, r)
	}))
	defer central.Close()

	var tenantCreates int
	tenant := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != mediaPath {
			http.NotFound(w, r)
			return
		}
		tenantCreates++
		writeJSON(w, http.StatusCreated, mediaUploadResponse{MediaID: "same-media-id"})
	}))
	defer tenant.Close()

	gw := newTestGateway(central.URL, map[string]string{"eu": tenant.URL})
	gw.cfg.centralMediaExport = false
	req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu"+mediaPath, strings.NewReader(`{"contentLength":0}`))
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if centralCreates != 0 || tenantCreates != 1 {
		t.Fatalf("centralCreates=%d tenantCreates=%d", centralCreates, tenantCreates)
	}
}

func TestMediaUploadRejectsInvalidIDBeforeReadingBody(t *testing.T) {
	t.Parallel()

	gw := newTestGateway("http://central.invalid", nil)
	reader := &failingReader{}
	req := httptest.NewRequest(http.MethodPut, mediaUploadProxyPath+"not-valid", reader)
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if reader.read {
		t.Fatal("invalid upload id should not read request body")
	}
}

func TestUploadPlanStoreErrorsUseGenericResponses(t *testing.T) {
	t.Parallel()

	sensitiveErr := errors.New("redis://internal-redis:6379 leaked-secret")

	t.Run("ping", func(t *testing.T) {
		t.Parallel()

		store := newFakeUploadPlanStore()
		store.pingErr = sensitiveErr
		gw := newTestGatewayWithStore("http://central.invalid", nil, store)

		req := httptest.NewRequest(http.MethodPost, mediaPath, strings.NewReader(`{"contentLength":5}`))
		resp := httptest.NewRecorder()
		gw.handle(resp, req)

		assertGenericErrorResponse(t, resp, http.StatusBadGateway, "media upload plan store unavailable")
	})

	t.Run("put", func(t *testing.T) {
		t.Parallel()

		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			uploadURL := "http://storage.invalid/upload"
			writeJSON(w, http.StatusCreated, mediaUploadResponse{
				MediaID:   "same-media-id",
				UploadURL: &uploadURL,
			})
		}))
		defer upstream.Close()

		store := newFakeUploadPlanStore()
		store.putErr = sensitiveErr
		gw := newTestGatewayWithStore(upstream.URL, nil, store)

		req := httptest.NewRequest(http.MethodPost, mediaPath, strings.NewReader(`{"contentLength":5}`))
		resp := httptest.NewRecorder()
		gw.handle(resp, req)

		assertGenericErrorResponse(t, resp, http.StatusBadGateway, "failed to store media upload plan")
	})

	t.Run("take", func(t *testing.T) {
		t.Parallel()

		store := newFakeUploadPlanStore()
		store.takeErr = sensitiveErr
		gw := newTestGatewayWithStore("http://central.invalid", nil, store)

		req := httptest.NewRequest(http.MethodPut, mediaUploadProxyPath+"abcdef1234", strings.NewReader("hello"))
		resp := httptest.NewRecorder()
		gw.handle(resp, req)

		assertGenericErrorResponse(t, resp, http.StatusBadGateway, "failed to load media upload plan")
	})
}

func TestUploadPlanStoreErrorsUseRedactedLogs(t *testing.T) {
	var logBuffer bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logBuffer, nil)))
	t.Cleanup(func() {
		slog.SetDefault(previousLogger)
	})

	store := newFakeUploadPlanStore()
	store.pingErr = errors.New("redis://internal-redis:6379 leaked-secret")
	gw := newTestGatewayWithStore("http://central.invalid", nil, store)

	req := httptest.NewRequest(http.MethodPost, mediaPath, strings.NewReader(`{"contentLength":5}`))
	resp := httptest.NewRecorder()
	gw.handle(resp, req)

	assertGenericErrorResponse(t, resp, http.StatusBadGateway, "media upload plan store unavailable")
	logOutput := logBuffer.String()
	if strings.Contains(logOutput, "internal-redis") || strings.Contains(logOutput, "leaked-secret") {
		t.Fatalf("log leaked upload plan store details: %s", logOutput)
	}
	if !strings.Contains(logOutput, `"error":"error details redacted"`) {
		t.Fatalf("log missing redacted error context: %s", logOutput)
	}
}

func TestMediaUploadIsOneTime(t *testing.T) {
	t.Parallel()

	var uploads int
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/upload" {
			http.NotFound(w, r)
			return
		}
		uploads++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	store := newFakeUploadPlanStore()
	uploadID := "abcdef1234"
	store.Put(context.Background(), uploadID, uploadPlan{
		ExpiresAt:     time.Now().Add(time.Hour),
		ContentLength: 5,
		Destinations: []uploadDestination{{
			Name:      "central",
			UploadURL: upstream.URL + "/upload",
		}},
	})
	gw := newTestGatewayWithStore(upstream.URL, nil, store)
	gw.cfg.client = upstream.Client()

	for index, expectedStatus := range []int{http.StatusOK, http.StatusNotFound} {
		req := httptest.NewRequest(http.MethodPut, mediaUploadProxyPath+uploadID, strings.NewReader("hello"))
		req.Header.Set("Content-Type", "image/png")
		resp := httptest.NewRecorder()
		gw.handle(resp, req)
		if resp.Code != expectedStatus {
			t.Fatalf("attempt %d status = %d, body = %s", index+1, resp.Code, resp.Body.String())
		}
	}
	if uploads != 1 {
		t.Fatalf("uploads = %d", uploads)
	}
}

func TestMediaUploadOversizeRestoresPlanForRetry(t *testing.T) {
	t.Parallel()

	var uploads int
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/upload" {
			http.NotFound(w, r)
			return
		}
		uploads++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	store := newFakeUploadPlanStore()
	uploadID := "abcdef1234"
	store.Put(context.Background(), uploadID, uploadPlan{
		ExpiresAt:     time.Now().Add(time.Hour),
		ContentLength: 1,
		Destinations: []uploadDestination{{
			Name:      "central",
			UploadURL: upstream.URL + "/upload",
		}},
	})
	gw := newTestGatewayWithStore(upstream.URL, nil, store)
	gw.cfg.client = upstream.Client()

	oversizeReq := httptest.NewRequest(
		http.MethodPut,
		mediaUploadProxyPath+uploadID,
		strings.NewReader(strings.Repeat("x", int(maxUploadBytes(1))+1)),
	)
	oversizeReq.Header.Set("Content-Type", "image/png")
	oversizeResp := httptest.NewRecorder()
	gw.handle(oversizeResp, oversizeReq)
	if oversizeResp.Code != http.StatusBadRequest {
		t.Fatalf("oversize status = %d, body = %s", oversizeResp.Code, oversizeResp.Body.String())
	}

	retryReq := httptest.NewRequest(http.MethodPut, mediaUploadProxyPath+uploadID, strings.NewReader("ok"))
	retryReq.Header.Set("Content-Type", "image/png")
	retryResp := httptest.NewRecorder()
	gw.handle(retryResp, retryReq)
	if retryResp.Code != http.StatusOK {
		t.Fatalf("retry status = %d, body = %s", retryResp.Code, retryResp.Body.String())
	}
	if uploads != 1 {
		t.Fatalf("uploads = %d", uploads)
	}
}

func TestUploadContentTypeRejectsUnsupportedTypes(t *testing.T) {
	t.Parallel()
	for _, contentType := range []string{"", "text/x-unsupported", "application/x-unsupported", "application/jsonp", "text/plain-invalid", "multipart/form-data"} {
		t.Run(contentType, func(t *testing.T) {
			if allowedUploadContentType(contentType) {
				t.Fatalf("unsupported content type accepted: %q", contentType)
			}
		})
	}
}

func TestMediaUploadUnsupportedContentTypeRestoresPlanForRetry(t *testing.T) {
	t.Parallel()

	var uploads int
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/upload" {
			http.NotFound(w, r)
			return
		}
		uploads++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	store := newFakeUploadPlanStore()
	uploadID := "abcdef1234"
	store.Put(context.Background(), uploadID, uploadPlan{
		ExpiresAt:     time.Now().Add(time.Hour),
		ContentLength: 5,
		Destinations: []uploadDestination{{
			Name:      "central",
			UploadURL: upstream.URL + "/upload",
		}},
	})
	gw := newTestGatewayWithStore(upstream.URL, nil, store)
	gw.cfg.client = upstream.Client()

	badReq := httptest.NewRequest(http.MethodPut, mediaUploadProxyPath+uploadID, strings.NewReader("hello"))
	badReq.Header.Set("Content-Type", "application/x-unsupported")
	badResp := httptest.NewRecorder()
	gw.handle(badResp, badReq)
	if badResp.Code != http.StatusBadGateway {
		t.Fatalf("bad content-type status = %d, body = %s", badResp.Code, badResp.Body.String())
	}

	retryReq := httptest.NewRequest(http.MethodPut, mediaUploadProxyPath+uploadID, strings.NewReader("hello"))
	retryReq.Header.Set("Content-Type", "image/png")
	retryResp := httptest.NewRecorder()
	gw.handle(retryResp, retryReq)
	if retryResp.Code != http.StatusOK {
		t.Fatalf("retry status = %d, body = %s", retryResp.Code, retryResp.Body.String())
	}
	if uploads != 1 {
		t.Fatalf("uploads = %d", uploads)
	}
}

func TestMediaCreateUsesConfiguredPublicUploadURL(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != mediaPath {
			http.NotFound(w, r)
			return
		}
		uploadURL := "http://" + r.Host + "/upload"
		writeJSON(w, http.StatusCreated, mediaUploadResponse{
			MediaID:   "same-media-id",
			UploadURL: &uploadURL,
		})
	}))
	defer upstream.Close()

	gw := newTestGateway(upstream.URL, nil)
	gw.cfg.publicURL = "https://fanout.example.com/base"
	req := httptest.NewRequest(http.MethodPost, mediaPath, strings.NewReader(`{"contentLength":5}`))
	req.Host = "attacker.example.com"
	req.Header.Set("X-Forwarded-Host", "attacker.example.com")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	var create mediaUploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&create); err != nil {
		t.Fatal(err)
	}
	if create.UploadURL == nil || !strings.HasPrefix(*create.UploadURL, "https://fanout.example.com/base/") {
		t.Fatalf("unexpected upload URL: %#v", create.UploadURL)
	}
	if strings.Contains(*create.UploadURL, "attacker.example.com") {
		t.Fatalf("upload URL trusted request host: %s", *create.UploadURL)
	}
}

func TestMediaGetUsesTenantDestinationForTenantRoute(t *testing.T) {
	t.Parallel()

	var centralGets int
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		centralGets++
		writeJSON(w, http.StatusOK, map[string]string{"url": "central"})
	}))
	defer central.Close()
	var tenantGets int
	tenant := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenantGets++
		if r.URL.Path != mediaPath+"/media-id" {
			t.Fatalf("unexpected tenant path %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Basic tenant" {
			t.Fatalf("tenant auth = %q", got)
		}
		writeJSON(w, http.StatusOK, map[string]string{"url": "tenant"})
	}))
	defer tenant.Close()

	gw := newTestGateway(central.URL, map[string]string{"eu": tenant.URL})
	req := httptest.NewRequest(http.MethodGet, tenantPrefix+"eu"+mediaPath+"/media-id", nil)
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if centralGets != 0 || tenantGets != 1 {
		t.Fatalf("centralGets=%d tenantGets=%d", centralGets, tenantGets)
	}
	if !strings.Contains(resp.Body.String(), "tenant") {
		t.Fatalf("unexpected body: %s", resp.Body.String())
	}
}

func TestMediaGetUsesCentralDestinationForCentralRoute(t *testing.T) {
	t.Parallel()

	var centralGets int
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		centralGets++
		if got := r.Header.Get("Authorization"); got != "Basic central" {
			t.Fatalf("central auth = %q", got)
		}
		writeJSON(w, http.StatusOK, map[string]string{"url": "central"})
	}))
	defer central.Close()
	var tenantGets int
	tenant := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tenantGets++
		w.WriteHeader(http.StatusOK)
	}))
	defer tenant.Close()

	gw := newTestGateway(central.URL, map[string]string{"eu": tenant.URL})
	req := httptest.NewRequest(http.MethodGet, mediaPath+"/media-id", nil)
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if centralGets != 1 || tenantGets != 0 {
		t.Fatalf("centralGets=%d tenantGets=%d", centralGets, tenantGets)
	}
	if !strings.Contains(resp.Body.String(), "central") {
		t.Fatalf("unexpected body: %s", resp.Body.String())
	}
}

func TestMediaCreateRejectsDifferentMediaIDs(t *testing.T) {
	t.Parallel()

	upstream := func(mediaID string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.URL.Path != mediaPath {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, http.StatusCreated, mediaUploadResponse{MediaID: mediaID})
		}))
	}
	central := upstream("central-id")
	defer central.Close()
	tenant := upstream("tenant-id")
	defer tenant.Close()

	gw := newTestGateway(central.URL, map[string]string{"eu": tenant.URL})
	req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu"+mediaPath, strings.NewReader(`{"contentLength":0}`))
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if !strings.Contains(resp.Body.String(), "media IDs differ") {
		t.Fatalf("unexpected body: %s", resp.Body.String())
	}

	metrics := scrapeMetrics(t, gw)
	if !strings.Contains(metrics, `langfuse_fanout_media_divergence_total{destination="tenant_eu",kind="media_id"} 1`) {
		t.Fatalf("missing media_id divergence metric:\n%s", metrics)
	}
}

func TestMediaCreateRecordsUploadURLPresenceDivergenceIndependentOfOrder(t *testing.T) {
	t.Parallel()

	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != mediaPath {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusCreated, mediaUploadResponse{MediaID: "same-media-id"})
	}))
	defer central.Close()

	tenant := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != mediaPath {
			http.NotFound(w, r)
			return
		}
		uploadURL := "http://" + r.Host + "/upload"
		writeJSON(w, http.StatusCreated, mediaUploadResponse{
			MediaID:   "same-media-id",
			UploadURL: &uploadURL,
		})
	}))
	defer tenant.Close()

	gw := newTestGateway(central.URL, map[string]string{"eu": tenant.URL})
	req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu"+mediaPath, strings.NewReader(`{"contentLength":5}`))
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}

	metrics := scrapeMetrics(t, gw)
	if !strings.Contains(metrics, `langfuse_fanout_media_divergence_total{destination="central",kind="upload_url_presence"} 1`) {
		t.Fatalf("missing upload_url_presence divergence metric:\n%s", metrics)
	}
}

func TestMetricsEndpointRequiresBearerToken(t *testing.T) {
	t.Parallel()

	gw := newTestGateway("http://central.invalid", nil)

	unauthorized := httptest.NewRecorder()
	gw.handle(unauthorized, httptest.NewRequest(http.MethodGet, metricsPath, nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	wrong := httptest.NewRecorder()
	wrongReq := httptest.NewRequest(http.MethodGet, metricsPath, nil)
	wrongReq.Header.Set("Authorization", "Bearer wrong")
	gw.handle(wrong, wrongReq)
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status = %d", wrong.Code)
	}

	authorized := httptest.NewRecorder()
	authorizedReq := httptest.NewRequest(http.MethodGet, metricsPath, nil)
	authorizedReq.Header.Set("Authorization", "Bearer test-secret")
	gw.handle(authorized, authorizedReq)
	if authorized.Code != http.StatusOK {
		t.Fatalf("authorized status = %d, body = %s", authorized.Code, authorized.Body.String())
	}
	if !strings.Contains(authorized.Body.String(), "go_goroutines") {
		t.Fatalf("missing gateway metrics:\n%s", authorized.Body.String())
	}
}

func TestSafeErrorMessageRedactsURLErrorURL(t *testing.T) {
	t.Parallel()

	err := &url.Error{
		Op:  "Put",
		URL: "https://storage.example.com/object?X-Amz-Signature=secret",
		Err: errors.New("lookup bucket.storage.example.com: connection refused"),
	}

	message := safeErrorMessage(err)
	if strings.Contains(message, "storage.example.com") || strings.Contains(message, "bucket") || strings.Contains(message, "secret") {
		t.Fatalf("safe error leaked URL details: %q", message)
	}
	if !strings.Contains(message, "Put") || !strings.Contains(message, "URL request failed") {
		t.Fatalf("safe error lost useful context: %q", message)
	}
}

func TestSafeErrorMessageRedactsGenericError(t *testing.T) {
	t.Parallel()

	message := safeErrorMessage(errors.New("redis://internal-redis:6379 leaked-secret"))
	if strings.Contains(message, "internal-redis") || strings.Contains(message, "leaked-secret") {
		t.Fatalf("safe error leaked generic error details: %q", message)
	}
	if message != "error details redacted" {
		t.Fatalf("unexpected generic error message: %q", message)
	}
}

func TestTraceProxyRecordsPrometheusMetrics(t *testing.T) {
	t.Parallel()

	collector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("{}"))
	}))
	defer collector.Close()

	gw := newTestGatewayWithCollector(collector.URL)
	body := buildTraceRequest(t, map[string]string{tenantIDAttribute: "tenant-123"})
	req := httptest.NewRequest(http.MethodPost, tenantPrefix+"eu"+otelTracePath, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}

	metrics := scrapeMetrics(t, gw)
	if !strings.Contains(metrics, `langfuse_fanout_trace_exports_total{destination="tenant_eu",result="success",tenant_id="tenant-123"} 1`) {
		t.Fatalf("missing trace export metric:\n%s", metrics)
	}
	if !strings.Contains(metrics, `langfuse_fanout_upstream_requests_total{destination="collector",operation="trace_collector",status_class="2xx"} 1`) {
		t.Fatalf("missing upstream collector metric:\n%s", metrics)
	}
}

func TestTraceProxyBoundsTenantMetricLabels(t *testing.T) {
	t.Parallel()

	metrics := newGatewayMetrics()
	for i := 0; i < maxTenantMetricLabels+10; i++ {
		metrics.recordTraceExport(centralName, "success", fmt.Sprintf("tenant-%d", i))
	}
	metrics.recordTraceExport(centralName, "success", strings.Repeat("x", 129))

	metricFamilies, err := metrics.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range metricFamilies {
		if family.GetName() != "langfuse_fanout_trace_exports_total" {
			continue
		}
		if got, want := len(family.Metric), maxTenantMetricLabels+2; got != want {
			t.Fatalf("trace metric children = %d, want %d", got, want)
		}
		labels := make(map[string]struct{}, len(family.Metric))
		for _, metric := range family.Metric {
			for _, label := range metric.Label {
				if label.GetName() == "tenant_id" {
					labels[label.GetValue()] = struct{}{}
				}
			}
		}
		for _, label := range []string{overflowTenantID, invalidTenantID} {
			if _, ok := labels[label]; !ok {
				t.Fatalf("missing bounded tenant label %q", label)
			}
		}
		return
	}
	t.Fatal("missing trace export metric family")
}

func TestTraceProxyBoundsUnknownDestinationLabel(t *testing.T) {
	t.Parallel()

	gw := newTestGatewayWithCollector("http://collector.invalid")
	gw.recordTraceExport(route{destination: "attacker-controlled"}, "error", "tenant-123")

	metrics := scrapeMetrics(t, gw)
	if !strings.Contains(metrics, `langfuse_fanout_trace_exports_total{destination="central",result="error",tenant_id="tenant-123"} 1`) {
		t.Fatalf("missing bounded trace destination metric:\n%s", metrics)
	}
}

func TestExtractTraceTenantID(t *testing.T) {
	t.Parallel()

	t.Run("protobuf", func(t *testing.T) {
		body := buildTraceRequest(t, map[string]string{tenantIDAttribute: "tenant-123"})
		if tenantID := extractTraceTenantID(body, "application/x-protobuf"); tenantID != "tenant-123" {
			t.Fatalf("tenant ID = %q", tenantID)
		}
	})

	t.Run("json", func(t *testing.T) {
		body := []byte(`{"resourceSpans":[{"scopeSpans":[{"spans":[{"attributes":[{"key":"librechat.tenant.id","value":{"stringValue":"tenant-456"}}]}]}]}]}`)
		if tenantID := extractTraceTenantID(body, "application/json"); tenantID != "tenant-456" {
			t.Fatalf("tenant ID = %q", tenantID)
		}
	})

	t.Run("missing", func(t *testing.T) {
		body := buildTraceRequest(t, nil)
		if tenantID := extractTraceTenantID(body, "application/x-protobuf"); tenantID != unknownTenantID {
			t.Fatalf("tenant ID = %q", tenantID)
		}
	})

	t.Run("multiple", func(t *testing.T) {
		tenantIDs := map[string]struct{}{"tenant-1": {}, "tenant-2": {}}
		if tenantID := resolveTraceTenantID(tenantIDs); tenantID != multipleTenantIDs {
			t.Fatalf("tenant ID = %q", tenantID)
		}
	})

	t.Run("sentinels are outside tenant ID grammar", func(t *testing.T) {
		validTenantID := regexp.MustCompile(`^[-a-zA-Z0-9_.]+$`)
		for _, sentinel := range []string{unknownTenantID, multipleTenantIDs} {
			if validTenantID.MatchString(sentinel) {
				t.Fatalf("sentinel %q is a valid tenant ID", sentinel)
			}
		}
	})
}

func TestMalformedTenantTraceRecordsErrorMetric(t *testing.T) {
	t.Parallel()

	gw := newTestGatewayWithCollector("http://collector.invalid")
	req := httptest.NewRequest(
		http.MethodPost,
		tenantPrefix+"eu"+otelTracePath,
		bytes.NewReader([]byte("not protobuf")),
	)
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("Authorization", "Basic tenant")
	resp := httptest.NewRecorder()

	gw.handle(resp, req)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}

	metrics := scrapeMetrics(t, gw)
	if !strings.Contains(metrics, `langfuse_fanout_trace_exports_total{destination="tenant_eu",result="error",tenant_id="<unknown>"} 1`) {
		t.Fatalf("missing invalid trace export metric:\n%s", metrics)
	}
}

func newTestGateway(centralURL string, tenants map[string]string) *gateway {
	return newTestGatewayWithStore(centralURL, tenants, newFakeUploadPlanStore())
}

func newTestGatewayWithStore(centralURL string, tenants map[string]string, store uploadPlanStore) *gateway {
	return newGateway(config{
		traceCollectorURL:  "http://collector.invalid",
		publicURL:          "http://fanout.local:4318",
		metricsSecret:      "test-secret",
		centralMediaExport: true,
		central: destination{
			name:          centralName,
			baseURL:       centralURL,
			authorization: "Basic central",
		},
		tenants:     tenants,
		uploadStore: store,
		client:      &http.Client{Timeout: 5 * time.Second},
	})
}

func newTestGatewayWithCollector(collectorURL string) *gateway {
	gateway := newTestGateway("http://central.invalid", map[string]string{"eu": "http://tenant.invalid"})
	gateway.cfg.traceCollectorURL = collectorURL
	return gateway
}

func buildTraceRequest(t *testing.T, attrs map[string]string) []byte {
	t.Helper()
	spanAttrs := make([]*commonv1.KeyValue, 0, len(attrs))
	for key, value := range attrs {
		spanAttrs = append(spanAttrs, &commonv1.KeyValue{
			Key: key,
			Value: &commonv1.AnyValue{
				Value: &commonv1.AnyValue_StringValue{StringValue: value},
			},
		})
	}
	request := &tracepb.ExportTraceServiceRequest{
		ResourceSpans: []*tracev1.ResourceSpans{{
			Resource: &resourcev1.Resource{},
			ScopeSpans: []*tracev1.ScopeSpans{{
				Spans: []*tracev1.Span{{
					TraceId:    []byte("1234567890123456"),
					SpanId:     []byte("12345678"),
					Name:       "test-span",
					Attributes: spanAttrs,
				}},
			}},
		}},
	}
	body, err := proto.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func buildJSONTraceRequest(t *testing.T, attrs map[string]any) []byte {
	t.Helper()
	spanAttrs := make([]map[string]any, 0, len(attrs))
	for key, value := range attrs {
		anyValue := map[string]any{}
		switch typed := value.(type) {
		case bool:
			anyValue["boolValue"] = typed
		default:
			anyValue["stringValue"] = typed
		}
		spanAttrs = append(spanAttrs, map[string]any{
			"key":   key,
			"value": anyValue,
		})
	}
	request := map[string]any{
		"resourceSpans": []any{
			map[string]any{
				"resource": map[string]any{},
				"scopeSpans": []any{
					map[string]any{
						"spans": []any{
							map[string]any{
								"traceId":    "31323334353637383930313233343536",
								"spanId":     "3132333435363738",
								"name":       "test-span",
								"attributes": spanAttrs,
							},
						},
					},
				},
			},
		},
	}
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func parseTraceAttributes(t *testing.T, body []byte) map[string]string {
	t.Helper()
	var request tracepb.ExportTraceServiceRequest
	if err := proto.Unmarshal(body, &request); err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	for _, resourceSpan := range request.ResourceSpans {
		for _, scopeSpan := range resourceSpan.ScopeSpans {
			for _, span := range scopeSpan.Spans {
				for _, attr := range span.Attributes {
					result[attr.Key] = stringValue(attr.Value)
				}
			}
		}
	}
	return result
}

func parseJSONTraceAttributes(t *testing.T, body []byte) map[string]string {
	t.Helper()
	var request map[string]any
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	resourceSpans, _ := request["resourceSpans"].([]any)
	for _, resourceSpan := range resourceSpans {
		resourceSpanMap, _ := resourceSpan.(map[string]any)
		scopeSpans, _ := resourceSpanMap["scopeSpans"].([]any)
		for _, scopeSpan := range scopeSpans {
			scopeSpanMap, _ := scopeSpan.(map[string]any)
			spans, _ := scopeSpanMap["spans"].([]any)
			for _, span := range spans {
				spanMap, _ := span.(map[string]any)
				attrs, _ := spanMap["attributes"].([]any)
				for _, attr := range attrs {
					attrMap, _ := attr.(map[string]any)
					valueMap, _ := attrMap["value"].(map[string]any)
					if key, ok := attrMap["key"].(string); ok {
						if value, ok := valueMap["stringValue"].(string); ok {
							result[key] = value
						}
					}
				}
			}
		}
	}
	return result
}

func scrapeMetrics(t *testing.T, gw *gateway) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, metricsPath, nil)
	req.Header.Set("Authorization", "Bearer test-secret")
	resp := httptest.NewRecorder()
	gw.handle(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("metrics status = %d, body = %s", resp.Code, resp.Body.String())
	}
	return resp.Body.String()
}

func assertGenericErrorResponse(t *testing.T, resp *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if resp.Code != status {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if strings.TrimSpace(resp.Body.String()) != body {
		t.Fatalf("unexpected body: %s", resp.Body.String())
	}
	if strings.Contains(resp.Body.String(), "internal-redis") || strings.Contains(resp.Body.String(), "leaked-secret") {
		t.Fatalf("response leaked upload plan store details: %s", resp.Body.String())
	}
}

func newUploadURLPath(t *testing.T, value string) string {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed.Path
}

type fakeUploadPlanStore struct {
	mu    sync.Mutex
	plans map[string]uploadPlan

	putErr  error
	takeErr error
	pingErr error
}

func newFakeUploadPlanStore() *fakeUploadPlanStore {
	return &fakeUploadPlanStore{plans: map[string]uploadPlan{}}
}

func (s *fakeUploadPlanStore) Put(_ context.Context, uploadID string, plan uploadPlan) error {
	if s.putErr != nil {
		return s.putErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.plans[uploadID] = plan
	return nil
}

func (s *fakeUploadPlanStore) Take(_ context.Context, uploadID string) (uploadPlan, bool, error) {
	if s.takeErr != nil {
		return uploadPlan{}, false, s.takeErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	plan, ok := s.plans[uploadID]
	delete(s.plans, uploadID)
	return plan, ok, nil
}

func (s *fakeUploadPlanStore) Ping(_ context.Context) error {
	if s.pingErr != nil {
		return s.pingErr
	}
	return nil
}

func (s *fakeUploadPlanStore) Close() error {
	return nil
}

type failingReader struct {
	read bool
}

func (r *failingReader) Read(_ []byte) (int, error) {
	r.read = true
	return 0, errors.New("read should not be called")
}
