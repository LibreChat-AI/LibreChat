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
  <strong>中文</strong>
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

## 🚀 v0.8.8 新特性

- **Agent 管理 API (Beta)：** 支持创建、检索、更新与删除 Agent；管理 Agent 文件与技能（Skills）；通过与部署绑定的 OIDC 身份验证机器客户端，同时完整保留现有的角色与 Agent 访问控制权限。公开的 OpenAPI 与 Swagger UI 全面覆盖推理、事件、Agent 管理与 Skill 管理。
- **关联代码工作区 Attached Workspaces（高度实验性）：** 为每个托管或个人代码 Worker 选择或保存基于 Agent 的默认工作区，使 Agent 能够直接检查文件树、读取与搜索文件、编写代码变更，并在有超时限制的环境中执行 Bash。个人 Worker 支持限定自服务接入、就绪状态以及独立于 Agent 的 Git 身份。
- **后台工具执行控制：** 支持按需取消常规后台工具（包括挂载的 Bash 执行），同时保持独立的后台子智能体（Subagent）执行互不干扰。
- **代码审批控制：** 在管理员允许的环境中，支持针对文件写入和命令执行选择“**询问 (Ask)**”、“**允许 (Allow)**”或“**拒绝 (Deny)**”，并针对受信关联环境提供“**完全访问 (Full access)**”模式。文件搜索与代码运行同样严格遵循角色权限。
- **手动上下文压缩 (Manual Context Compaction)：** 在上下文窗口填满前即可主动触发单次摘要压缩，并依据当前部署的摘要策略智能保留近期对话核心内容。
- **上下文用量统计 (Context Usage)：** 实时清晰查看对话消耗、保留工具流量、Agent 指令、缓存、Token 费用及上下文窗口压力，避免类别子集的重复计算。
- **统一附件管理：** 一次上传，由 LibreChat 智能路由至大模型或直接提取文本，仅在必要时才按需调配文件搜索与代码工具。
- **最新模型支持：** 新增 GPT-6 Astra 与 GPT-6.1 Sol，支持 Responses API 路由及原生 Tool-call 工具调用。
- **Agent 与聊天交互界面：** 全面整合工具活动、模型思考推理（Reasoning）、搜索与 Agent 工作流；新增可拖拽的置顶区域（Pinned section）以固定会话与收藏；支持动态变形状态图标、高对比度主题、富文本消息复制、更清晰的侧边栏标题及精致的阶段加载布局。
- **可观测性 (Observability)：** 可在 Trace 跟踪查看器中按序检查模型对话、工具执行轮次与消耗成本；支持通过 OpenTelemetry 导出关联的应用运行日志，配置允许的 Langfuse 跟踪身份与元数据，使用客户端构建 ID 标记浏览器诊断信息，并将 Insights 洞察分析精确限定在已授权的 Agent 范围。
- **稳定性与安全性加固：** 强化 Agent 中断接续与检查点恢复能力、Redis 存活探测、DocumentDB 协调机制、OpenID 与 MCP OAuth 会话生命周期、分享链接防刷限流、租户隔离、附件边界控制以及文件上传异常处理。

阅读完整的 [v0.8.8 更新日志](https://www.librechat.ai/changelog/v0.8.8)。

# ✨ 功能

- 🖥️ **UI 与交互体验**：灵感源于 ChatGPT，带来更具美感的设计与丰富特性

- 🤖 **广泛的 AI 模型支持**：  
  - Anthropic (Claude)、AWS Bedrock、OpenAI、Azure OpenAI、Google、Vertex AI、OpenAI Responses API（含 Azure）
  - [自定义端点 (Custom Endpoints)](https://www.librechat.ai/docs/quick_start/custom_endpoints)：在 LibreChat 中使用任何兼容 OpenAI 的 API，无需搭建额外反向代理
  - 兼容各类[本地与远程 AI 服务商](https://www.librechat.ai/docs/configuration/librechat_yaml/ai_endpoints)：
    - Ollama、[AMD Lemonade](https://lemonade-server.ai/)、Groq、Cohere、Mistral AI、Apple MLX、KoboldCPP、Together.ai、
    - OpenRouter、Helicone、Perplexity、ShuttleAI、DeepSeek、Qwen（通义千问）等

- 🔧 **[代码解释器 API (Code Interpreter)](https://www.librechat.ai/docs/features/code_interpreter)**： 
  - 支持 Python、Node.js (JS/TS)、Go、C/C++、Java、PHP、Rust 和 Fortran 的安全沙箱执行
  - 无缝文件处理：直接上传、处理与下载文件
  - 无隐私隐患：完全隔离的安全执行环境
  - 开源且支持私有化部署：基于 [ClickHouse/code-interpreter](https://github.com/ClickHouse/code-interpreter) 驱动

- 🔦 **Agent 与工具生态集成**：  
  - **[LibreChat Agents 智能体](https://www.librechat.ai/docs/features/agents)**：
    - 无代码自定义助手：快速构建专属的 AI 驱动助手
    - Agent 市场：发现并部署社区构建的优质 Agent
    - 协同共享：向指定用户或用户组共享 Agent
    - 灵活可扩展：支持 MCP 服务器、内置工具、文件检索、代码执行等
    - [Skills 技能系统](https://www.librechat.ai/docs/features/skills)：创建可复用的 `SKILL.md` 指令包，用于手动、自动或常驻的 Agent 工作流
    - [Agent 插件](https://www.librechat.ai/docs/features/agent_plugins)：实验性支持在启动时将部署的 Skills 和 MCP 服务器打包加载
    - [Subagents 子智能体](https://www.librechat.ai/docs/features/subagents)：将专注的子任务委派给拥有独立上下文窗口的隔离子智能体运行
    - Agent 管理 API：通过部署绑定的 OIDC 客户端实现 Agent、文件与 Skill 的全自动化管理
    - 关联代码工作区：让 Agent 在托管或个人工作区中检查、搜索、编辑并执行命令（高度实验性）
    - 兼容自定义端点、OpenAI、Azure、Anthropic、AWS Bedrock、Google、Vertex AI、Responses API 等
    - 支持工具领域的 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/clients#librechat) 协议

- 🔍 **联网搜索 (Web Search)**：  
  - 搜索互联网并检索相关信息以扩充 AI 上下文
  - 融合搜索服务商、网页内容抓取器与重排器（Reranker），确保最佳答案质量
  - **支持自定义 Jina Reranking**：可为重排服务配置自定义 Jina API 地址
  - **[了解更多 →](https://www.librechat.ai/docs/features/web_search)**

- 🪄 **Generative UI 与代码工件 (Code Artifacts)**：  
  - [Code Artifacts](https://youtu.be/GfTj7O4gmd0?si=WJbdnemZpJzBrJo3) 可在对话中直接渲染 React、HTML 与 Mermaid 内容
  - 支持全屏预览并将 Mermaid 架构图导出为 SVG 或 PNG 格式

- 🎨 **图像生成与编辑**：
  - 使用 [GPT-Image-1](https://www.librechat.ai/docs/features/image_gen#1--openai-image-tools-recommended) 进行文生图与图生图
  - 支持 [DALL-E (3/2)](https://www.librechat.ai/docs/features/image_gen#2--dalle-legacy)、[Stable Diffusion](https://www.librechat.ai/docs/features/image_gen#3--stable-diffusion-local)、[Flux](https://www.librechat.ai/docs/features/image_gen#4--flux) 或任何 [MCP 服务器](https://www.librechat.ai/docs/features/image_gen#5--model-context-protocol-mcp)
  - 根据提示词生成震撼视觉效果，或通过单条指令迭代精修现有图像

- 💾 **预设与上下文精细管理**：  
  - 创建、保存并分享自定义预设（Presets）  
  - 在对话过程中随时切换 AI 端点与预设
  - 支持消息编辑、重新提交与分支继续对话（Conversation Branching）  
  - 向指定用户与用户组创建和共享提示词模版
  - [Fork 分叉消息与会话](https://www.librechat.ai/docs/features/fork)，实现高阶上下文控制  
  - 按需压缩长对话上下文，同时保留近期对话精髓

- 💬 **多模态与文件交互**：  
  - 通过 Claude 3、GPT-4.5、GPT-4o、o1、Llama-Vision 与 Gemini 上传并分析图像 📸  
  - 借助自定义端点、OpenAI、Azure、Anthropic、AWS Bedrock 与 Google 与文件对话 🗃️
  - 消息支持复制为格式化富文本，便于粘贴至文档、邮件及办公协作软件

- 🌎 **多语言交互界面**：
  - 简体中文、繁體中文、English、العربية、Deutsch、Español、Français、Italiano
  - Polski、Português (PT)、Português (BR)、Русский、日本語、Svenska、한국어、Tiếng Việt
  - Türkçe、Nederlands、עברית、Català、Čeština、Dansk、Eesti、فارسی
  - Suomi、Magyar、Հայերեն、Bahasa Indonesia、ქართული、Latviešu、ไทย、ئۇيغۇرچە

- 🧠 **推理可视化 UI (Reasoning UI)**：  
  - 专为 DeepSeek-R1 等具有思维链（Chain-of-Thought）/ 深度思考能力的推理模型打造的动态可视化交互界面

- 🎨 **高度可定制界面**：  
  - 可定制下拉菜单与界面排版，兼顾高阶极客与初学者
  - 提供浅色、深色、跟随系统以及高对比度外观模式

- 📈 **系统可观测性 (Observability)**：
  - 通过 OpenTelemetry 导出链路追踪与日志，连接 Langfuse 洞察 Agent 与模型表现

- 🌊 **[可恢复流式传输 (Resumable Streams)](https://www.librechat.ai/docs/features/resumable_streams)**：  
  - 永不丢失回复：网络连接中断时自动重连并恢复流式响应
  - 多标签页与跨设备同步：在多个标签页打开同一对话，或无缝切换至另一台设备继续
  - 生产就绪：从单机部署到基于 Redis 的水平伸缩集群均稳定支持

- 🗣️ **语音与音频支持**：  
  - 通过语音转文字（STT）与文字转语音（TTS）实现解放双手畅聊  
  - 自动发送并播放音频  
  - 支持 OpenAI、Azure OpenAI 与 ElevenLabs

- 📥 **会话导入与导出**：  
  - 支持从 LibreChat、ChatGPT、Chatbot UI 导入历史会话  
  - 支持导出为屏幕截图、Markdown、TXT 及 JSON 文件

- 🔍 **全局搜索**：  
  - 毫秒级搜索所有历史消息与对话内容

- 👥 **多用户与安全访问控制**：
  - 多用户权限隔离，支持 OAuth2、LDAP 及邮箱密码登录
  - 内置内容审核系统与 Token 消耗限额管控

- 🎛️ **[管理后台 (Admin Panel)](https://www.librechat.ai/docs/features/admin_panel)**：
  - 基于浏览器的直观 Web 控制台，管理用户、用户组、权限角色及全局配置覆盖
  - 实时调整配置与各角色权限，无需重启服务或重新部署
  - 原生整合至 Docker Compose 配置栈，一条命令即可轻松启动

- ⚙️ **灵活配置与多环境部署**：  
  - 支持正向代理、反向代理、Docker 及各类私有化部署方案  
  - 支持配置 [S3 与 CloudFront](https://www.librechat.ai/docs/configuration/cdn/cloudfront)，提供稳健的媒体链接、边缘分发、签名 Cookie 及安全下载  
  - 支持纯本地运行或云端弹性集群部署

- 📖 **开源与繁荣社区**：  
  - 100% 完全开源，公开构建（Built in Public）  
  - 社区驱动开发，活跃支持与敏捷反馈

[如需查阅全部特性的详细评测，请点击访问我们的文档中心](https://docs.librechat.ai/) 📚

## 🪶 LibreChat 一体化全能 AI 对话平台

LibreChat 是一款支持自主托管的 AI 聊天与智能体平台，在注重隐私安全的单一界面中汇聚了全球主流 AI 模型。

除即时对话外，LibreChat 更集成了 AI Agents 智能体、Model Context Protocol (MCP) 支持、Artifacts 工件预览、代码解释器、自定义操作、会话搜索以及面向企业级的多用户认证管控。

100% 开源，持续敏捷迭代，专为注重自身 AI 基础设施掌控力的开发者与团队打造。

---

## 🌐 相关资源

**GitHub 仓库：**
  - **RAG API：** [github.com/LibreChat-AI/rag-api](https://github.com/LibreChat-AI/rag-api)
  - **官方网站源码：** [github.com/LibreChat-AI/librechat.ai](https://github.com/LibreChat-AI/librechat.ai)

**其他：**
  - **官方网站：** [librechat.ai](https://librechat.ai)
  - **文档中心：** [librechat.ai/docs](https://librechat.ai/docs)
  - **YouTube 频道：** [youtube.com/@LibreChat](https://www.youtube.com/@LibreChat)
  - **社区论坛：** [github.com/danny-avila/LibreChat/discussions](https://github.com/danny-avila/LibreChat/discussions)
  - **Discord 社区：** [discord.librechat.ai](https://discord.librechat.ai)

---

## 📝 更新日志

访问发布页面和更新日志以了解最新动态：
- [发布页面 (Releases)](https://github.com/LibreChat-AI/LibreChat/releases)
- [更新日志 (Changelog)](https://www.librechat.ai/changelog)

**⚠️ 在更新前请务必查看[更新日志](https://www.librechat.ai/changelog)以了解破坏性更改。**

---

## ⭐ Star 历史

<p align="center">
  <a href="https://star-history.com/#LibreChat-AI/LibreChat&Date">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=LibreChat-AI/LibreChat&type=Date&theme=dark" onerror="this.src='https://api.star-history.com/svg?repos=LibreChat-AI/LibreChat&type=Date'" />
  </a>
</p>
<p align="center">
  <a href="https://trendshift.io/repositories/4685" target="_blank" style="padding: 10px;">
    <img src="https://trendshift.io/api/badge/repositories/4685" alt="LibreChat-AI%2FLibreChat | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/>
  </a>
  <a href="https://runacap.com/ross-index/q1-24/" target="_blank" rel="noopener" style="margin-left: 20px;">
    <img style="width: 260px; height: 56px" src="https://runacap.com/wp-content/uploads/2024/04/ROSS_badge_white_Q1_2024.svg" alt="ROSS Index - 2024年第一季度增长最快的开源初创公司 | Runa Capital" width="260" height="56"/>
  </a>
</p>

---

## ✨ 参与贡献

欢迎任何形式的贡献、建议、错误报告和修复！

对于新功能、组件或扩展，请在发送 PR 前开启 issue 进行讨论。

如果您想帮助我们将 LibreChat 翻译成您的母语，我们非常欢迎！改进翻译不仅能让全球用户更轻松地使用 LibreChat，还能提升整体用户体验。请查看我们的[翻译指南](https://www.librechat.ai/docs/translation)。

---

## 💖 感谢所有贡献者

<a href="https://github.com/LibreChat-AI/LibreChat/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=LibreChat-AI/LibreChat" />
</a>

---

## 🎉 特别鸣谢

感谢 [Locize](https://locize.com) 提供的翻译管理工具，支持 LibreChat 的多语言功能。

<p align="center">
  <a href="https://locize.com" target="_blank" rel="noopener noreferrer">
    <img src="https://locize.com/img/ads/github_locize.png" width="350px" alt="locize" />
  </a>
</p>

---

> 💡 **文档维护说明**：本中文文档由社区志愿者（[@JasonYeYuhe](https://github.com/JasonYeYuhe)）翻译维护，最后同步更新于 2026年10月02日（对应官方 v0.8.8 正式版）。如发现内容与官方英文原版存在差异或新特性滞后，欢迎提交 PR 共同完善！
