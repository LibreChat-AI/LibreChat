# Model recovery

Build the app, then run the isolated browser test:

```sh
npm run frontend
E2E_BASE_URL=http://localhost:3099 E2E_CHROMIUM_CHANNEL=chrome npx playwright test --config e2e/playwright.config.recovery.ts
```

The test uses a disposable MongoDB and a local discovery server on port 4018.
It uses the existing fake model hook. It does not call a paid provider.
Do not run it alongside another E2E suite in the same checkout: the harness shares auth and database setup files.

The test imports a conversation through Settings while discovery returns no models.
It checks readable history, the recovery message, and blocked sending through the button and Enter key.
It restores discovery and reloads the chat. The existing chat-opening fallback selects an available model. It then sends a message.
It then reloads the page and checks that the original messages and the new reply remain.
Screenshots are saved under `workspace/private-docs/recovery-browser-artifacts/`.

Set `E2E_RECOVERY_PROVIDER_PORT` to use another mock port when 4018 is occupied.
