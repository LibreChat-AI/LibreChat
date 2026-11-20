<!-- Generated from README.md by .github/workflows/readme-translate.yml. Do not edit by hand. -->

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
  <a aria-label="Спонсоры" href="https://github.com/sponsors/danny-avila">
    <img
      src="https://img.shields.io/badge/SPONSORS-brightgreen.svg?style=for-the-badge&logo=github-sponsors&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
</p>

<p align="center">
<a href="https://railway.com/deploy/librechat-official?referralCode=HI9hWz&utm_medium=integration&utm_source=readme&utm_campaign=librechat">
  <img src="https://railway.com/button.svg" alt="Развернуть на Railway" height="30">
</a>
<a href="https://template.cloud.sealos.io/deploy?templateName=librechat">
  <img src="https://raw.githubusercontent.com/labring-actions/templates/main/Deploy-on-Sealos.svg" alt="Развернуть на Sealos" height="30">
</a>
</p>

<p align="center">
  <a href="https://www.librechat.ai/docs/translation">
    <img 
      src="https://img.shields.io/badge/dynamic/json.svg?style=for-the-badge&color=2096F3&label=locize&query=%24.translatedPercentage&url=https://api.locize.app/badgedata/4cb2598b-ed4d-469c-9b04-2ed531a8cb45&suffix=%+translated" 
      alt="Прогресс перевода">
  </a>
</p>

## 🚀 Что нового в v0.8.9

- **Chat Projects:** Организуйте беседы с помощью общих инструкций и справочных файлов.
- **Защита аккаунта:** Регистрируйте passkeys, меняйте адрес электронной почты и управляйте расширенными настройками безопасности аккаунта.
- **Agent Channels (бета):** Подключайте Agents к Slack со связанными аккаунтами, подтверждениями и обратной связью.
- **Фоновые ответы:** Сохраняйте, просматривайте, отменяйте и восстанавливайте ответы Agent API независимо от соединения с чатом.
- **Agents на базе SDK (экспериментально):** Регистрируйте локальные или удалённые среды выполнения с авторизованным доступом к инструментам хоста.
- **Инструменты и промпты:** Используйте MCP Apps, отложенный Tool Search, более понятные подтверждения и промпты Langfuse в каталоге и в инструкциях Agent.
- **BYOM (крайне экспериментально):** подключайте личные компьютеры, выбирайте рабочие пространства для каждого чата, копируйте вложения и отслеживайте pull request'ы.
- **Управление Agents:** Отвечайте на встроенные вопросы Ask User и следите за возобновляемыми фоновыми Subagents с более наглядным отображением хода выполнения задач.
- **Модели:** Добавлены Gemini 4 Hydrogen, GPT-6.1 Terra, Claude Fable 5.2, GPT Image 2.6 Sunburst/Flare, а также Mythos 5.2/GPT-6 Cyber с ограниченным доступом.
- **Улучшение интерфейса:** темы для развёртывания, элементы управления чатом, уведомления, макеты с письмом справа налево, восстановление черновиков, настройки режима рассуждений и Read Aloud.
- **Производительность и безопасность:** более быстрая загрузка чата, меньше повторных рендеров composer, обновления безопасности Node.js, а также более надёжная защита аутентификации, файлов и инструментов.

Прочитайте [полный список изменений v0.8.9](https://www.librechat.ai/changelog/v0.8.9).

# ✨ Возможности

- 🖥️ **Интерфейс и пользовательский опыт**, вдохновлённые ChatGPT, с улучшенным дизайном и расширенными функциями

- 🤖 **Выбор модели ИИ**:  
  - Anthropic (Claude), AWS Bedrock, OpenAI, Azure OpenAI, Google, Vertex AI, OpenAI Responses API (включая Azure)
  - [Пользовательские конечные точки](https://www.librechat.ai/docs/quick_start/custom_endpoints): используйте любой OpenAI-совместимый API с LibreChat, прокси не требуется
  - Совместимость с [локальными и удалёнными провайдерами ИИ](https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints):
    - Ollama, [AMD Lemonade](https://lemonade-server.ai/), groq, Cohere, Mistral AI, Apple MLX, koboldcpp, together.ai,
    - OpenRouter, Helicone, Perplexity, ShuttleAI, Deepseek, Qwen и другие

- 🔧 **[Code Interpreter API](https://www.librechat.ai/docs/features/code_interpreter)**: 
  - Безопасное выполнение кода в изолированной среде (песочнице) на Python, Node.js (JS/TS), Go, C/C++, Java, PHP, Rust и Fortran
  - Удобная работа с файлами: загружайте, обрабатывайте и скачивайте файлы напрямую
  - Никаких проблем с конфиденциальностью: полностью изолированное и безопасное выполнение
  - Открытый исходный код и возможность самостоятельного размещения: работает на базе [ClickHouse/code-interpreter](https://github.com/ClickHouse/code-interpreter)

- 🔦 **Интеграция Agents и инструментов**:  
  - **[LibreChat Agents](https://www.librechat.ai/docs/features/agents)**:
    - Кастомные ассистенты без кода: создавайте специализированных помощников на основе ИИ
    - Agent Marketplace: находите и разворачивайте агентов, созданных сообществом
    - Совместная работа: делитесь агентами с отдельными пользователями и группами
    - Гибкость и расширяемость: используйте MCP-серверы, инструменты, поиск по файлам, выполнение кода и многое другое
    - [Skills](https://www.librechat.ai/docs/features/skills): создавайте многоразовые наборы инструкций `SKILL.md` для ручных, автоматических или постоянно включённых рабочих процессов агентов
    - [Agent Plugins](https://www.librechat.ai/docs/features/agent_plugins): экспериментальная возможность объединять Skills и MCP-серверы развёртывания в пакеты, загружаемые при запуске
    - [Subagents](https://www.librechat.ai/docs/features/subagents): делегируйте узкие задачи изолированным дочерним запускам агентов с собственными контекстными окнами
    - Agent Management API: автоматизируйте управление агентами, файлами и Skills с помощью OIDC-клиентов, привязанных к развёртыванию
    - Подключаемые кодовые рабочие пространства: позвольте Agents просматривать, искать, редактировать и запускать команды в управляемых или личных рабочих пространствах (крайне экспериментально)
    - Совместимость с Custom Endpoints, OpenAI, Azure, Anthropic, AWS Bedrock, Google, Vertex AI, Responses API и другими
    - [Поддержка Model Context Protocol (MCP)](https://modelcontextprotocol.io/clients#librechat) для инструментов

- 🔍 **Веб-поиск**:  
  - Ищите информацию в интернете и получайте нужные данные, чтобы обогатить контекст для вашего ИИ
  - Объединяет поисковые провайдеры, скрапперы контента и реранкеры результатов для достижения оптимального результата
  - **Настраиваемое ранжирование Jina**: настройте собственные URL Jina API для сервисов реранкинга
  - **[Подробнее →](https://www.librechat.ai/docs/features/web_search)**

- 🪄 **Генеративный UI с Code Artifacts**:  
  - [Code Artifacts](https://youtu.be/GfTj7O4gmd0?si=WJbdnemZpJzBrJo3) создают контент React, HTML и Mermaid прямо в чате
  - Открывайте предпросмотр в полноэкранном режиме и экспортируйте диаграммы Mermaid в SVG или PNG

- 🎨 **Генерация и редактирование изображений**
  - Преобразование текста в изображение и изображения в изображение с помощью [GPT-Image-1](https://www.librechat.ai/docs/features/image_gen#1--openai-image-tools-recommended)
  - Преобразование текста в изображение с помощью [Stable Diffusion](https://www.librechat.ai/docs/features/image_gen#3--stable-diffusion-local), [Flux](https://www.librechat.ai/docs/features/image_gen#4--flux) или любого [MCP server](https://www.librechat.ai/docs/features/image_gen#5--model-context-protocol-mcp)
  - Создавайте потрясающие визуальные работы по текстовым запросам или дорабатывайте существующие изображения одной инструкцией

- 💾 **Пресеты и управление контекстом**:  
  - Создание, сохранение и публикация пользовательских пресетов  
  - Переключение между конечными точками AI и пресетами прямо во время чата
  - Редактирование, повторная отправка и продолжение сообщений с ветвлением диалога  
  - Создание промптов и обмен ими с отдельными пользователями и группами
  - [Ответвление сообщений и диалогов](https://www.librechat.ai/docs/features/fork) для расширенного управления контекстом
  - Сжатие длинных диалогов по запросу с сохранением недавнего контекста

- 💬 **Мультимодальность и работа с файлами**:  
  - Загружайте и анализируйте изображения с помощью Claude 3, GPT-4.5, GPT-4o, o1, Llama-Vision и Gemini 📸  
  - Общайтесь с файлами, используя пользовательские эндпоинты, OpenAI, Azure, Anthropic, AWS Bedrock и Google 🗃️
  - Копируйте сообщения в виде форматированного текста для документов, электронной почты и приложений для совместной работы

- 🌎 **Многоязычный интерфейс**:
  - English, 中文 (简体), 中文 (繁體), العربية, Deutsch, Español, Français, Italiano
  - Polski, Português (PT), Português (BR), Русский, 日本語, Svenska, 한국어, Tiếng Việt
  - Türkçe, Nederlands, עברית, Català, Čeština, Dansk, Eesti, فارسی
  - Suomi, Magyar, Հայերեն, Bahasa Indonesia, ქართული, Latviešu, ไทย, ئۇيغۇرچە

- 🧠 **Интерфейс рассуждений**:  
  - Динамический интерфейс для ИИ-моделей с цепочкой рассуждений (Chain-of-Thought/Reasoning), таких как DeepSeek-R1

- 🎨 **Настраиваемый интерфейс**:  
  - Настраиваемое выпадающее меню и интерфейс, который подходит как опытным пользователям, так и новичкам
  - Светлый, тёмный, системный и высококонтрастный режимы оформления

- 📈 **Наблюдаемость**:
  - Экспортируйте трассировки и логи с помощью OpenTelemetry и подключайте Langfuse для получения аналитики по Agent и моделям

- 🌊 **[Возобновляемые потоки](https://www.librechat.ai/docs/features/resumable_streams)**:  
  - Никогда не теряйте ответ: ответы ИИ автоматически переподключаются и возобновляются, если соединение прерывается
  - Синхронизация между вкладками и устройствами: откройте один и тот же чат в нескольких вкладках или продолжите на другом устройстве
  - Готово к продакшену: работает как на одиночных серверах, так и в горизонтально масштабируемых развёртываниях с Redis

- 🗣️ **Речь и аудио**:  
  - Общайтесь без помощи рук с помощью преобразования речи в текст и текста в речь  
  - Автоматически отправляйте и воспроизводите аудио  
  - Поддерживает OpenAI, Azure OpenAI и Elevenlabs

- 📥 **Импорт и экспорт диалогов**:  
  - Импорт диалогов из LibreChat, ChatGPT, Chatbot UI  
  - Экспорт диалогов в виде скриншотов, markdown, текста, JSON

- 🔍 **Поиск и обнаружение**:  
  - Поиск по всем сообщениям/диалогам

- 👥 **Многопользовательский режим и безопасный доступ**:
  - Многопользовательская безопасная аутентификация с поддержкой OAuth2, LDAP и входа по электронной почте
  - Встроенные инструменты модерации и учёта расходов токенов

- 🎛️ **[Панель администратора](https://www.librechat.ai/docs/features/admin_panel)**:
  - Браузерный интерфейс для управления пользователями, группами, ролями и переопределениями конфигурации
  - Настройка параметров и разрешений для ролей и групп в реальном времени, без повторного развёртывания
  - Входит в состав стеков Docker Compose для настройки одной командой

- ⚙️ **Конфигурация и развёртывание**:  
  - Настраивайте Proxy, Reverse Proxy, Docker и множество других вариантов развёртывания  
  - Используйте [S3 с CloudFront](https://www.librechat.ai/docs/configuration/cdn/cloudfront) для стабильных ссылок на медиафайлы, доставки через edge-серверы, подписанных cookie и защищённых загрузок
  - Работайте полностью локально или развёртывайте в облаке

- 📖 **Открытый исходный код и сообщество**:  
  - Полностью открытый исходный код, разработка ведётся публично  
  - Разработка, поддержка и обратная связь на основе усилий сообщества

[Для подробного обзора наших функций см. нашу документацию здесь](https://docs.librechat.ai/) 📚

## 🪶 Все ИИ-диалоги в одном месте с LibreChat

LibreChat — это self-hosted платформа для общения с ИИ, которая объединяет всех крупных провайдеров ИИ в едином интерфейсе, ориентированном на конфиденциальность.

Помимо чата, LibreChat предоставляет AI Agents, поддержку Model Context Protocol (MCP), Artifacts, Code Interpreter, пользовательские действия, поиск по беседам и многопользовательскую аутентификацию корпоративного уровня.

Проект с открытым исходным кодом, который активно развивается и создан для тех, кто ценит контроль над своей ИИ-инфраструктурой.

---

## 🌐 Ресурсы

**Репозиторий GitHub:**

- **RAG API:** [github.com/LibreChat-AI/rag-api](https://github.com/LibreChat-AI/rag-api)
- **Сайт:** [github.com/LibreChat-AI/librechat.ai](https://github.com/LibreChat-AI/librechat.ai)

**Другое:**

- **Веб-сайт:** [librechat.ai](https://librechat.ai)
- **Документация:** [librechat.ai/docs](https://librechat.ai/docs)
- **Блог:** [librechat.ai/blog](https://librechat.ai/blog)

---

## 📝 История изменений

Следите за последними обновлениями на странице релизов и в примечаниях к ним:

- [Релизы](https://github.com/LibreChat-AI/LibreChat/releases)
- [Список изменений](https://www.librechat.ai/changelog)

**⚠️ Пожалуйста, перед обновлением ознакомьтесь с [списком изменений](https://www.librechat.ai/changelog), чтобы узнать о критических изменениях.**

---

## ⭐ История звёзд

<p align="center">
  <a href="https://www.star-history.com/?type=date&repos=danny-avila%2FLibreChat">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&theme=dark&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
      <img alt="График истории звёзд" src="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/4685" target="_blank" style="padding: 10px;">
    <img src="https://trendshift.io/api/badge/repositories/4685" alt="LibreChat-AI%2FLibreChat | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>
  <a href="https://runacap.com/ross-index/q1-24/" target="_blank" rel="noopener" style="margin-left: 20px;">
    <img style="width: 260px; height: 56px" src="https://runacap.com/wp-content/uploads/2024/04/ROSS_badge_white_Q1_2024.svg" alt="ROSS Index - самые быстрорастущие стартапы с открытым исходным кодом в первом квартале 2024 года | Runa Capital" width="260" height="56"/>
  </a>
</p>

---

## ✨ Вклад в проект

Приветствуются вклады, предложения, сообщения об ошибках и исправления!

Для новых функций, компонентов или расширений, пожалуйста, сначала создайте issue и обсудите предложение, а затем отправляйте PR.

Если вы хотите помочь перевести LibreChat на свой язык, мы будем рады вашему вкладу! Улучшение переводов не только делает LibreChat доступнее для пользователей по всему миру, но и повышает удобство работы в целом. Пожалуйста, ознакомьтесь с нашим [руководством по переводу](https://www.librechat.ai/docs/translation).

---

## 💖 Этот проект существует в нынешнем виде благодаря всем людям, которые вносят свой вклад

<a href="https://github.com/LibreChat-AI/LibreChat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=LibreChat-AI/LibreChat" />
</a>

---

## 🎉 Особая благодарность

Мы благодарим [Locize](https://locize.com) за инструменты управления переводами, которые обеспечивают поддержку нескольких языков в LibreChat.

<p align="center">
  <a href="https://locize.com" target="_blank" rel="noopener noreferrer">
    <img src="https://github.com/user-attachments/assets/d6b70894-6064-475e-bb65-92a9e23e0077" alt="Логотип Locize" height="50">
  </a>
</p>
