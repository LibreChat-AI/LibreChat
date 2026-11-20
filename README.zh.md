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
  <strong>中文</strong> ·
  <a href="README.ru.md">Русский</a>
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
  <a aria-label="赞助者" href="https://github.com/sponsors/danny-avila">
    <img
      src="https://img.shields.io/badge/SPONSORS-brightgreen.svg?style=for-the-badge&logo=github-sponsors&logoColor=white&labelColor=000000&logoWidth=20">
  </a>
</p>

<p align="center">
<a href="https://railway.com/deploy/librechat-official?referralCode=HI9hWz&utm_medium=integration&utm_source=readme&utm_campaign=librechat">
  <img src="https://railway.com/button.svg" alt="在 Railway 上部署" height="30">
</a>
<a href="https://template.cloud.sealos.io/deploy?templateName=librechat">
  <img src="https://raw.githubusercontent.com/labring-actions/templates/main/Deploy-on-Sealos.svg" alt="在 Sealos 上部署" height="30">
</a>
</p>

<p align="center">
  <a href="https://www.librechat.ai/docs/translation">
    <img 
      src="https://img.shields.io/badge/dynamic/json.svg?style=for-the-badge&color=2096F3&label=locize&query=%24.translatedPercentage&url=https://api.locize.app/badgedata/4cb2598b-ed4d-469c-9b04-2ed531a8cb45&suffix=%+translated" 
      alt="翻译进度">
  </a>
</p>

## 🚀 v0.8.9 新特性

- **聊天项目：** 通过共享指令和参考文件来组织对话。
- **账户保护：** 注册 passkey、更改电子邮箱，并管理更强大的账户安全控制。
- **Agent Channels（测试版）：** 将 Agents 连接到 Slack，支持账号关联、审批和反馈。
- **后台响应（Background Responses）：** 保存、查看、取消和恢复 Agent API 响应，且不依赖于聊天连接。
- **SDK 支持的 Agents（实验性）：** 注册具有已授权主机工具访问权限的本地或远程运行时。
- **工具与提示词：** 在目录和 Agent 指令中使用 MCP Apps、延迟加载的工具搜索（Tool Search）、更清晰的审批流程以及 Langfuse 提示词。
- **BYOM（高度实验性）：** 注册个人机器、为每个聊天选择工作区、复制附件，并跟踪拉取请求。
- **Agent controls:** 可直接在对话中回答 Ask User 问题，并通过更清晰的任务进度跟踪可恢复的后台 Subagents。
- **模型：** 新增 Gemini 4 Hydrogen、GPT-6.1 Terra、Claude Fable 5.2、GPT Image 2.6 Sunburst/Flare，以及限制访问的 Mythos 5.2/GPT-6 Cyber。
- **界面优化：** 部署主题、聊天控件、通知、从右到左布局、恢复草稿、思考设置和朗读功能。
- **性能与安全：** 聊天加载更快，输入框重新渲染次数更少，Node.js 安全更新，并强化了身份验证、文件和工具方面的安全防护。

阅读 [完整的 v0.8.9 更新日志](https://www.librechat.ai/changelog/v0.8.9)。

# ✨ 功能特性

- 🖥️ **UI 与体验** 灵感来自 ChatGPT，并在设计和功能上进行了增强

- 🤖 **AI 模型选择**：  
  - Anthropic (Claude)、AWS Bedrock、OpenAI、Azure OpenAI、Google、Vertex AI、OpenAI Responses API (含 Azure)
  - [自定义端点](https://www.librechat.ai/docs/quick_start/custom_endpoints)：在 LibreChat 中使用任何兼容 OpenAI 的 API，无需代理
  - 兼容[本地和远程 AI 提供商](https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints)：
    - Ollama, [AMD Lemonade](https://lemonade-server.ai/), groq, Cohere, Mistral AI, Apple MLX, koboldcpp, together.ai,
    - OpenRouter, Helicone, Perplexity, ShuttleAI, Deepseek, Qwen 等

- 🔧 **[Code Interpreter API](https://www.librechat.ai/docs/features/code_interpreter)**: 
  - 在沙盒中安全执行 Python、Node.js (JS/TS)、Go、C/C++、Java、PHP、Rust 和 Fortran 代码
  - 无缝文件处理：可直接上传、处理和下载文件
  - 无需担心隐私问题：完全隔离且安全的执行环境
  - 开源且可自托管：由 [ClickHouse/code-interpreter](https://github.com/ClickHouse/code-interpreter) 提供支持

- 🔦 **Agents 与工具集成**：  
  - **[LibreChat Agents](https://www.librechat.ai/docs/features/agents)**:
    - 无代码自定义助手：构建专业的 AI 驱动助手
    - Agent 市场：发现并部署社区构建的 Agents
    - 协作共享：与特定用户和群组共享 Agents
    - 灵活可扩展：支持使用 MCP 服务器、工具、文件搜索、代码执行等
    - [Skills](https://www.librechat.ai/docs/features/skills)：创建可复用的 `SKILL.md` 指令包，用于手动、自动或始终启用的 Agent 工作流
    - [Agent 插件](https://www.librechat.ai/docs/features/agent_plugins)：实验性地将部署级 Skills 和 MCP 服务器打包为启动时加载的软件包
    - [Subagents](https://www.librechat.ai/docs/features/subagents)：将专注的任务委派给拥有各自独立上下文窗口的隔离子 Agent 运行
    - Agent 管理 API：通过绑定部署的 OIDC 客户端自动化管理 Agent、文件和 Skill
    - 附加代码工作区：让 Agents 在受管或个人工作区中检查、搜索、编辑并运行命令(高度实验性)
    - 兼容自定义端点、OpenAI、Azure、Anthropic、AWS Bedrock、Google、Vertex AI、Responses API 等
    - 工具支持 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/clients#librechat)

- 🔍 **网络搜索**：  
  - 搜索互联网并检索相关信息，以增强您的 AI 上下文
  - 结合搜索提供商、内容抓取器和结果重排序器，以获得最佳结果
  - **可自定义的 Jina 重排序**：为重排序服务配置自定义的 Jina API URL
  - **[了解更多 →](https://www.librechat.ai/docs/features/web_search)**

- 🪄 **使用 Code Artifacts 的生成式 UI**：  
  - [Code Artifacts](https://youtu.be/GfTj7O4gmd0?si=WJbdnemZpJzBrJo3) 可直接在聊天中创建 React、HTML 和 Mermaid 内容
  - 可全屏打开预览，并将 Mermaid 图表导出为 SVG 或 PNG

- 🎨 **图像生成与编辑**
  - 使用 [GPT-Image-1](https://www.librechat.ai/docs/features/image_gen#1--openai-image-tools-recommended) 实现文生图和图生图
  - 使用 [Stable Diffusion](https://www.librechat.ai/docs/features/image_gen#3--stable-diffusion-local)、[Flux](https://www.librechat.ai/docs/features/image_gen#4--flux) 或任意 [MCP 服务器](https://www.librechat.ai/docs/features/image_gen#5--model-context-protocol-mcp) 实现文生图
  - 只需一条指令，即可根据提示词生成惊艳的视觉作品，或对现有图像进行优化调整

- 💾 **预设与上下文管理**：  
  - 创建、保存和分享自定义预设  
  - 在对话过程中切换 AI 端点和预设
  - 通过对话分支编辑、重新提交和继续消息  
  - 创建提示词并与特定用户和群组分享
  - [分叉消息与对话](https://www.librechat.ai/docs/features/fork)，实现更高级的上下文控制
  - 按需压缩较长的对话，同时保留最近的上下文

- 💬 **多模态与文件交互**：  
  - 使用 Claude 3、GPT-4.5、GPT-4o、o1、Llama-Vision 和 Gemini 上传并分析图片 📸  
  - 通过自定义端点、OpenAI、Azure、Anthropic、AWS Bedrock 和 Google 与文件对话 🗃️
  - 将消息复制为格式化的富文本，用于文档、电子邮件和协作应用

- 🌎 **多语言界面**：
  - English, 中文 (简体), 中文 (繁體), العربية, Deutsch, Español, Français, Italiano
  - Polski, Português (PT), Português (BR), Русский, 日本語, Svenska, 한국어, Tiếng Việt
  - Türkçe, Nederlands, עברית, Català, Čeština, Dansk, Eesti, فارسی
  - Suomi, Magyar, Հայերեն, Bahasa Indonesia, ქართული, Latviešu, ไทย, ئۇيغۇرچە

- 🧠 **推理界面**：  
  - 为 DeepSeek-R1 等思维链/推理 AI 模型提供动态推理界面

- 🎨 **可自定义界面**：  
  - 可自定义的下拉菜单和界面，同时适合高级用户和新手
  - 浅色、深色、跟随系统以及高对比度外观模式

- 📈 **可观测性**：
  - 使用 OpenTelemetry 导出追踪和日志，并连接 Langfuse，以获得对 Agent 和模型的洞察

- 🌊 **[可恢复流](https://www.librechat.ai/docs/features/resumable_streams)**：  
  - 绝不丢失回复：如果连接中断，AI 回复会自动重新连接并继续
  - 多标签页与多设备同步：可在多个标签页中打开同一对话，或在另一台设备上继续
  - 可用于生产环境：从单服务器部署到使用 Redis 的横向扩展部署均可运行

- 🗣️ **语音与音频**：  
  - 通过语音转文字和文字转语音实现免提聊天  
  - 自动发送并播放音频  
  - 支持 OpenAI、Azure OpenAI 和 Elevenlabs

- 📥 **导入与导出对话**：  
  - 支持从 LibreChat、ChatGPT、Chatbot UI 导入对话  
  - 可将对话导出为截图、markdown、文本、JSON

- 🔍 **搜索与发现**：  
  - 搜索所有消息/对话

- 👥 **多用户与安全访问**：
  - 多用户、安全认证，支持 OAuth2、LDAP 和电子邮件登录
  - 内置内容审核和 Token 消费统计工具

- 🎛️ **[管理面板](https://www.librechat.ai/docs/features/admin_panel)**：
  - 基于浏览器的界面，用于管理用户、群组、角色以及配置覆盖
  - 实时编辑设置和按角色/群组划分的权限，无需重新部署
  - 已内置于 Docker Compose 技术栈中，一条命令即可完成设置

- ⚙️ **配置与部署**：  
  - 配置代理、反向代理、Docker 以及多种部署选项  
  - 使用 [S3 与 CloudFront](https://www.librechat.ai/docs/configuration/cdn/cloudfront) 实现稳定的媒体链接、边缘分发、签名 Cookie 和安全下载
  - 可完全本地运行，也可部署到云端

- 📖 **开源与社区**：  
  - 完全开源，公开构建  
  - 社区驱动的开发、支持与反馈

[想全面了解我们的功能，请查看我们的文档](https://docs.librechat.ai/) 📚

## 🪶 使用 LibreChat 实现一站式 AI 对话

LibreChat 是一个自托管的 AI 聊天平台，将所有主流 AI 提供商整合到一个注重隐私的统一界面中。

除了聊天功能之外，LibreChat 还提供 AI Agents、Model Context Protocol (MCP) 支持、Artifacts、Code Interpreter、自定义操作、对话搜索，以及可用于企业级场景的多用户身份验证。

开源、持续积极开发，专为所有重视对其 AI 基础设施拥有掌控权的用户而打造。

---

## 🌐 资源

**GitHub 仓库：**

- **RAG API:** [github.com/LibreChat-AI/rag-api](https://github.com/LibreChat-AI/rag-api)
- **网站：** [github.com/LibreChat-AI/librechat.ai](https://github.com/LibreChat-AI/librechat.ai)

**其他：**

- **网站：** [librechat.ai](https://librechat.ai)
- **文档：** [librechat.ai/docs](https://librechat.ai/docs)
- **博客：** [librechat.ai/blog](https://librechat.ai/blog)

---

## 📝 更新日志

通过访问发布页面和发布说明，随时了解最新动态：

- [发布版本](https://github.com/LibreChat-AI/LibreChat/releases)
- [更新日志](https://www.librechat.ai/changelog)

**⚠️ 更新之前，请查阅 [更新日志](https://www.librechat.ai/changelog) 了解重大变更。**

---

## ⭐ Star 历史

<p align="center">
  <a href="https://www.star-history.com/?type=date&repos=danny-avila%2FLibreChat">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&theme=dark&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
      <img alt="星标历史图表" src="https://api.star-history.com/chart?repos=danny-avila/LibreChat&type=date&legend=top-left&sealed_token=CXsk3L39t1nlibOv3pQloYwrz8R_yXxCAe1X3DG8sEnmu3PZvzSRZGf7JvisknF83yXqMwR6IcuKLolIQBulChAOseTYP1TDglfT6clOHXzspF-DJhmmsnGasrGpLfCeOEU56Bx761CJp9xDxza5rbyXW3F1GqWNtDf9pMroBq86vS70ilRWu16VyucF" />
    </picture>
  </a>
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/4685" target="_blank" style="padding: 10px;">
    <img src="https://trendshift.io/api/badge/repositories/4685" alt="LibreChat-AI%2FLibreChat | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>
  <a href="https://runacap.com/ross-index/q1-24/" target="_blank" rel="noopener" style="margin-left: 20px;">
    <img style="width: 260px; height: 56px" src="https://runacap.com/wp-content/uploads/2024/04/ROSS_badge_white_Q1_2024.svg" alt="ROSS 指数 - 2024 年第一季度增长最快的开源初创公司 | Runa Capital" width="260" height="56"/>
  </a>
</p>

---

## ✨ 贡献

欢迎贡献代码、提出建议、报告 bug 和提交修复！

对于新功能、组件或扩展，请先提交 issue 进行讨论，然后再发送 PR。

如果您愿意帮助将 LibreChat 翻译成您的语言，我们非常期待您的贡献！改进我们的翻译不仅能让全世界的用户更方便地使用 LibreChat，还能提升整体用户体验。请查看我们的[翻译指南](https://www.librechat.ai/docs/translation)。

---

## 💖 这个项目能够发展到现在的样子，要感谢所有贡献者

<a href="https://github.com/LibreChat-AI/LibreChat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=LibreChat-AI/LibreChat" />
</a>

---

## 🎉 特别鸣谢

我们感谢 [Locize](https://locize.com) 提供的翻译管理工具，为 LibreChat 的多语言支持提供了助力。

<p align="center">
  <a href="https://locize.com" target="_blank" rel="noopener noreferrer">
    <img src="https://github.com/user-attachments/assets/d6b70894-6064-475e-bb65-92a9e23e0077" alt="Locize 标志" height="50">
  </a>
</p>
