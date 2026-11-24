# OpenAI, Gemini, and Claude on Render

This fork uses LibreChat's built-in OpenAI, Google, and Anthropic endpoints. The tracked `librechat.yaml`
sets each provider's models and conversation title model. `.dockerignore` includes
this configuration in the Docker image built from the repository.

## Setup

1. In the existing Render service, change **Settings > Build > Source** to
   `premsunpet/LibreChat-fork`, branch `main`, using the existing Docker runtime.
2. In **Environment**, set `GOOGLE_KEY` to your Google AI Studio API key.
   Set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` to their provider API keys, or
   use `user_provided` to let each user enter their own key in LibreChat.
   Never commit the actual key to GitHub.
3. If `ENDPOINTS` is already set, include `openAI,google,anthropic` in its comma-separated list.
   To show these providers and Agents, set `ENDPOINTS=openAI,google,anthropic,agents`. If it is unset, LibreChat uses
   its default endpoint selection.
4. Set `CONFIG_PATH=/app/librechat.yaml` so this deployment loads the bundled file.
5. Model lists in this version's `librechat.yaml` override `OPENAI_MODELS`,
   `GOOGLE_MODELS`, and `ANTHROPIC_MODELS`. Edit the YAML to change these lists.
6. Save the environment settings and deploy the merged commit. Select **OpenAI**,
   **Google**, or **Anthropic** in LibreChat and choose a model.

Keep the existing database, authentication, and other deployment environment
variables. Model availability, quotas, and pricing depend on the Google account;
this configuration does not guarantee free API usage. OpenAI and Anthropic API
billing is separate from ChatGPT and Claude consumer subscriptions. A listed
model still requires API access on the corresponding provider account.

## Updating models

The list was checked against official provider documentation on 2026-10-15.
The newest general chat models are listed before older options. Gemini 2.5 is
retained for existing users, but Google restricts it for newly created projects.
Some Gemini models are previews and may be withdrawn. Specialized audio,
embedding, image-only, and restricted-release models are not included.

Update the lists under `endpoints.openAI.models`, `endpoints.google.models`, and
`endpoints.anthropic.models` in `librechat.yaml`, commit, then redeploy. Keep the
`titleModel` value pointing to a model your provider key can use. This fork
already routes GPT-6 models through the appropriate Responses API path.

If the UI still shows the old built-in list, verify that the PR is merged, Render
uses this fork and the intended commit, and `CONFIG_PATH=/app/librechat.yaml`.
An Admin Panel role or group override can also replace deployment configuration.

## Docker Compose

For Docker Compose deployments, keep the existing bind mount from
`./librechat.yaml` to `/app/librechat.yaml`. A mounted file overrides the bundled
configuration. Render builds this repository's Dockerfile directly and does not
use Docker Compose volume mounts.

## References

- https://www.librechat.ai/docs/configuration/pre_configured_ai/google
- https://www.librechat.ai/docs/configuration/librechat_yaml
- https://developers.openai.com/api/docs/models
- https://ai.google.dev/gemini-api/docs/models
- https://platform.claude.com/docs/en/claude_api_primer
