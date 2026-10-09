package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

type upstreamStatusError struct {
	status int
}

func (e upstreamStatusError) Error() string {
	return fmt.Sprintf("upstream status %d", e.status)
}

func (g *gateway) writeGatewayError(w http.ResponseWriter, r *http.Request, route route, operation string, status int, message string, err error, attrs ...any) {
	g.logGatewayFailure(r, route, operation, status, err, attrs...)
	http.Error(w, message, status)
}

func (g *gateway) logGatewayFailure(r *http.Request, route route, operation string, status int, err error, attrs ...any) {
	fields := gatewayLogFields(r, route, operation, attrs...)
	fields = append(fields, "status", status)
	if err != nil {
		fields = append(fields, "error", safeErrorMessage(err))
	}
	if status >= http.StatusInternalServerError {
		slog.Error("langfuse fanout gateway request failed", fields...)
		return
	}
	slog.Warn("langfuse fanout gateway request failed", fields...)
}

func (g *gateway) logGatewayWarning(r *http.Request, route route, operation string, message string, attrs ...any) {
	fields := gatewayLogFields(r, route, operation, attrs...)
	fields = append(fields, "warning", message)
	slog.Warn("langfuse fanout gateway warning", fields...)
}

func gatewayLogFields(r *http.Request, route route, operation string, attrs ...any) []any {
	fields := []any{
		"method", r.Method,
		"path", normalizeMetricPath(r.URL.Path),
		"operation", operation,
		"destination", routeDestinationLabel(route),
	}
	return append(fields, attrs...)
}

func routeDestinationLabel(route route) string {
	if strings.HasPrefix(route.path, mediaUploadProxyPath) {
		return "fanout"
	}
	if route.destination == "" {
		return centralName
	}
	return "tenant_" + route.destination
}

func safeErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	var upstreamErr upstreamStatusError
	if errors.As(err, &upstreamErr) {
		return upstreamErr.Error()
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return fmt.Sprintf("%s: URL request failed", urlErr.Op)
	}
	return "error details redacted"
}
