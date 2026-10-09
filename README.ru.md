<p align="center">
  <a href="https://librechat.ai">
    <img src="client/public/assets/logo.svg" height="256">
  </a>
  <h1 align="center">
    <a href="https://librechat.ai">LibreChat</a>
  </h1>
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">中文</a> ·
  <strong>Русский</strong>
</p>

<p align="center">
  <a href="https://discord.librechat.ai">
    <img
      src="https://img.shields.io/discord/1086345563026489514?label=&logo=discord&style=for-the-badge&logoWidth=20&logoColor=white&labelColor=000000&color=blueviolet">
  </a>
  <a href="https://www.youtube.com/@LibreChat">
    <img
      src="https://img.shields.io/badge/YOUTUBE-red.svg?style=for-the-badge&logo=youtube&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
  <a href="https://docs.librechat.ai">
    <img
      src="https://img.shields.io/badge/DOCS-blue.svg?style=for-the-badge&logo=read-the-docs&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
  <a aria-label="Sponsors" href="https://github.com/sponsors/danny-avila">
    <img
      src="https://img.shields.io/badge/SPONSORS-brightgreen.svg?style=for-the-badge&logo=github-sponsors&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
</p>

<p align="center">
<a href="https://railway.com/deploy/librechat-official?referralCode=HI9hWz&utm_medium=integration&utm_source=readme&utm_campaign=librechat">
  <img src="https://railway.com/button.svg" alt="Deploy on Railway" height="30">
</a>
<a href="https://zeabur.com/templates/0X2ZY8">
  <img src="https://zeabur.com/button.svg" alt="Deploy on Zeabur" height="30"/>
</a>
<a href="https://template.cloud.sealos.io/deploy?templateName=librechat">
  <img src="https://raw.githubusercontent.com/labring-actions/templates/main/Deploy-on-Sealos.svg" alt="Deploy on Sealos" height="30">
</a>
</p>

<p align="center">
  <a href="https://www.librechat.ai/docs/translation">
    <img
      src="https://img.shields.io/badge/dynamic/json.svg?style=for-the-badge&color=2096F3&label=locize&query=%24.translatedPercentage&url=https://api.locize.app/badgedata/4cb2598b-ed4d-469c-9b04-2ed531a8cb45&suffix=%+translated"
      alt="Translation Progress">
  </a>
</p>

## 🚀 Что нового в v0.8.8-rc3

- **Agent Management API (beta):** создание, поиск, обновление и удаление Agents; управление файлами и Skills агентов; аутентификация machine-клиентов через deployment-bound OIDC с сохранением ролей и ACL.
- **Attached workspaces (highly experimental):** workspace по умолчанию для managed/personal code worker; агенты смотрят дерево, читают/ищут файлы, правят код и запускают Bash с таймаутами. Personal workers — self-service enrollment, readiness и Git identity.
- **Background tool controls:** опциональная отмена обычных background tools (включая attached Bash); detached Subagent остаётся независимым.
- **Code approval controls:** **Ask**, **Allow** или **Deny** для записи файлов и команд (где разрешено админом), включая **Full access**. File Search и Run Code тоже учитывают role grants.
- **Manual context compaction:** summarize-only ход до заполнения окна контекста с сохранением недавнего диалога по политике деплоя.
- **Context Usage:** просмотр диалога, tool traffic, инструкций агента, cache, cost и runway без double-counting.
- **Unified attachments:** один upload — маршрутизация в модель или extracted text; File Search и Code подключаются по необходимости.
- **Models:** GPT-6 Astra для OpenAI и Agents endpoints, Responses API routing и tool-call support.
- **Agent and chat UI:** единый tool activity / reasoning / search; draggable Pinned; high-contrast themes; rich-text copy; уточнённые sidebar titles и live phase layouts.
- **Observability:** логи через OpenTelemetry, allowlisted Langfuse metadata, client build IDs, Insights по authorized Agents.
- **Reliability and security:** усилены continuation/checkpoint recovery, Redis liveness, DocumentDB, OpenID/MCP OAuth, shared-link throttling, tenant isolation, attachment bounds.

Полный [changelog v0.8.8-rc3](https://www.librechat.ai/changelog/v0.8.8-rc3).

# ✨ Возможности

- 🖥️ **UI & Experience** в духе ChatGPT с расширенным дизайном и фичами

- 🤖 **Выбор AI-моделей**:
  - Anthropic (Claude), AWS Bedrock, OpenAI, Azure OpenAI, Google, Vertex AI, OpenAI Responses API (вкл. Azure)
  - [Custom Endpoints](https://www.librechat.ai/docs/quick_start/custom_endpoints): любой OpenAI-compatible API без proxy
  - [Local & Remote AI Providers](https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints):
    - Ollama, [AMD Lemonade](https://lemonade-server.ai/), groq, Cohere, Mistral AI, Apple MLX, koboldcpp, together.ai,
    - OpenRouter, Helicone, Perplexity, ShuttleAI, Deepseek, Qwen и др.

- 🔧 **[Code Interpreter API](https://www.librechat.ai/docs/features/code_interpreter)**:
  - Безопасный sandbox: Python, Node.js (JS/TS), Go, C/C++, Java, PHP, Rust, Fortran
  - Upload / process / download файлов напрямую
  - Полная изоляция исполнения
  - Open-source & self-hostable: [ClickHouse/code-interpreter](https://github.com/ClickHouse/code-interpreter)

- 🔦 **Agents & Tools**:
  - **[LibreChat Agents](https://www.librechat.ai/docs/features/agents)**:
    - No-code кастомные ассистенты
    - Agent Marketplace
    - Sharing с пользователями и группами
    - MCP Servers, tools, file search, code execution
    - [Skills](https://www.librechat.ai/docs/features/skills): reusable `SKILL.md` bundles
    - [Agent Plugins](https://www.librechat.ai/docs/features/agent_plugins): Skills + MCP в startup packages
    - [Subagents](https://www.librechat.ai/docs/features/subagents): делегирование в изолированные child runs
    - Agent Management API с deployment-bound OIDC
    - Attached Code Workspaces (highly experimental)
    - Совместимость с Custom Endpoints, OpenAI, Azure, Anthropic, AWS Bedrock, Google, Vertex AI, Responses API
    - [MCP Support](https://modelcontextprotocol.io/clients#librechat)

- 🔍 **Web Search**: поиск в интернете + scrapers + rerankers; кастомный Jina. [Learn More →](https://www.librechat.ai/docs/features/web_search)

- 🪄 **Generative UI / Code Artifacts**: React, HTML, Mermaid в чате; fullscreen preview; экспорт SVG/PNG

- 🎨 **Image Generation & Editing**:
  - Text-to-image / image-to-image: [GPT-Image-1](https://www.librechat.ai/docs/features/image_gen#1--openai-image-tools-recommended)
  - [DALL-E](https://www.librechat.ai/docs/features/image_gen#2--dalle-legacy), [Stable Diffusion](https://www.librechat.ai/docs/features/image_gen#3--stable-diffusion-local), [Flux](https://www.librechat.ai/docs/features/image_gen#4--flux), [MCP](https://www.librechat.ai/docs/features/image_gen#5--model-context-protocol-mcp)

- 💾 **Presets & Context**:
  - Создание, сохранение и шаринг presets
  - Смена endpoints/presets mid-chat
  - Edit / resubmit / continue с branching
  - [Fork Messages & Conversations](https://www.librechat.ai/docs/features/fork)
  - Compaction длинных диалогов по запросу

- 💬 **Multimodal & Files**: анализ изображений (Claude 3, GPT-4o, Gemini и др.); чат с файлами; rich-text copy

- 🌎 **Multilingual UI**: English, 中文, العربية, Deutsch, Español, Français, Italiano, Polski, Português, **Русский**, 日本語, 한국어 и многие другие

- 🧠 **Reasoning UI** для CoT/Reasoning моделей (например DeepSeek-R1)

- 🎨 **Customizable Interface**: light / dark / system / high-contrast

- 📈 **Observability**: OpenTelemetry + Langfuse

- 🌊 **[Resumable Streams](https://www.librechat.ai/docs/features/resumable_streams)**: авто-reconnect ответов; multi-tab / multi-device; Redis для horizontal scale

- 🗣️ **Speech & Audio**: STT/TTS; OpenAI, Azure OpenAI, Elevenlabs

- 📥 **Import & Export**: LibreChat, ChatGPT, Chatbot UI → screenshots, markdown, text, json

- 🔍 **Search**: поиск по всем сообщениям/диалогам

- 👥 **Multi-User & Secure Access**: OAuth2, LDAP, Email; moderation и token spend tools

- 🎛️ **[Admin Panel](https://www.librechat.ai/docs/features/admin_panel)**: users, groups, roles, live config overrides; bundled в Docker Compose

- ⚙️ **Configuration & Deployment**: Proxy, Reverse Proxy, Docker; [S3 + CloudFront](https://www.librechat.ai/docs/configuration/cdn/cloudfront); local или cloud

- 📖 **Open-Source & Community**: полностью open-source, community-driven

[Подробнее о возможностях в документации](https://docs.librechat.ai/) 📚

## 🪶 All-In-One AI Conversations with LibreChat

LibreChat — self-hosted AI chat платформа, объединяющая крупных провайдеров в одном privacy-focused интерфейсе.

Помимо чата: AI Agents, MCP, Artifacts, Code Interpreter, custom actions, поиск по диалогам и enterprise-ready multi-user auth.

Open source, активно развивается — для тех, кто хочет контролировать свою AI-инфраструктуру.

---

## 🌐 Resources

**GitHub Repo:**
  - **RAG API:** [github.com/danny-avila/rag_api](https://github.com/danny-avila/rag_api)
  - **Website:** [github.com/LibreChat-AI/librechat.ai](https://github.com/LibreChat-AI/librechat.ai)

**Other:**
  - **Website:** [librechat.ai](https://librechat.ai)
  - **Documentation:** [librechat.ai/docs](https://librechat.ai/docs)
  - **Blog:** [librechat.ai/blog](https://librechat.ai/blog)

---

## 📝 Changelog

Следите за обновлениями:
- [Releases](https://github.com/danny-avila/LibreChat/releases)
- [Changelog](https://www.librechat.ai/changelog)

**⚠️ Перед обновлением сверяйтесь с [changelog](https://www.librechat.ai/changelog) на breaking changes.**

---

## ⭐ Star History

<p align="center">
  <a href="https://www.star-history.com/?type=date&repos=danny-avila%2FLibreChat">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&theme=dark&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
      <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/4685" target="_blank" style="padding: 10px;">
    <img src="https://trendshift.io/api/badge/repositories/4685" alt="danny-avila%2FLibreChat | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>
  <a href="https://runacap.com/ross-index/q1-24/" target="_blank" rel="noopener" style="margin-left: 20px;">
    <img style="width: 260px; height: 56px" src="https://runacap.com/wp-content/uploads/2024/04/ROSS_badge_white_Q1_2024.svg" alt="ROSS Index - Fastest Growing Open-Source Startups in Q1 2024 | Runa Capital" width="260" height="56"/>
  </a>
</p>

---

## ✨ Contributions

Контрибьюции, предложения, баг-репорты и фиксы приветствуются!

Для новых фич, компонентов или расширений сначала откройте issue и обсудите, затем присылайте PR.

Хотите помочь с переводом LibreChat? Смотрите [Translation Guide](https://www.librechat.ai/docs/translation).

---

## 💖 Этот проект существует благодаря всем, кто вносит вклад

<a href="https://github.com/danny-avila/LibreChat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=danny-avila/LibreChat" />
</a>

---

## 🎉 Special Thanks

Спасибо [Locize](https://locize.com) за инструменты управления переводами LibreChat.

<p align="center">
  <a href="https://locize.com" target="_blank" rel="noopener noreferrer">
    <img src="https://github.com/user-attachments/assets/d6b70894-6064-475e-bb65-92a9e23e0077" alt="Locize Logo" height="50">
  </a>
</p>
