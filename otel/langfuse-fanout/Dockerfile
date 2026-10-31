FROM golang:1.26.10-alpine3.24@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS builder
ENV GOTOOLCHAIN=local
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
