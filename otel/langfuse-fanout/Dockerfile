FROM golang:1.25-alpine AS builder
WORKDIR /src
COPY otel/langfuse-fanout/go.mod otel/langfuse-fanout/go.sum* ./
RUN go mod download
COPY otel/langfuse-fanout/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/langfuse-fanout ./cmd/langfuse-fanout

FROM alpine:3.22
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /out/langfuse-fanout /usr/local/bin/langfuse-fanout
USER app
EXPOSE 4318
ENTRYPOINT ["/usr/local/bin/langfuse-fanout"]
