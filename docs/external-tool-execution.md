# External tool execution for custom endpoints

LibreChat custom OpenAI-compatible endpoints can report tool calls that an external runtime executes. LibreChat renders these calls through its existing native tool-call card while skipping local tool dispatch.

## Endpoint configuration

External execution is disabled by default. Enable it only for a trusted custom endpoint.

```yaml
endpoints:
  custom:
    - name: external-runtime
      apiKey: "${EXTERNAL_RUNTIME_API_KEY}"
      baseURL: "https://example.invalid/v1"
      models:
        default:
          - external-model
      externalToolExecution:
        enabled: true
        acceptedProviders:
          - remote-runtime
```

`acceptedProviders` is optional. When configured, LibreChat accepts external ownership only when the streamed provider identifier exactly matches one of the listed values.

## Stream extension

The endpoint continues to emit normal OpenAI-compatible streamed tool-call deltas. To mark one call as externally owned, include an `execution` object on that tool-call delta.

```json
{
  "object": "chat.completion.chunk",
  "choices": [
    {
      "index": 0,
      "delta": {
        "tool_calls": [
          {
            "index": 0,
            "id": "call_abc123",
            "type": "function",
            "execution": {
              "mode": "external",
              "provider": "remote-runtime"
            },
            "function": {
              "name": "create_document",
              "arguments": "{\"topic\":\"budget\"}"
            }
          }
        ]
      }
    }
  ]
}
```

LibreChat correlates ownership by the normal tool-call stream. The external runtime owns execution and is responsible for continuing the response with the final assistant content.

## Behavior and safety

- Calls without valid opt-in ownership metadata retain existing local behavior.
- Malformed ownership metadata and unapproved providers are ignored.
- Externally owned calls retain the native tool name, arguments, running state, completion state, and accessibility behavior.
- LibreChat does not display executor metadata to the user.
- LibreChat does not perform local lookup or invocation for a validated externally owned call.
- A successful end of the enclosing stream completes the native card when no separate completion event is available.
