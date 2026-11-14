# Qwen Image MCP Server

MCP (Model Context Protocol) server per integrar el model de generació d'imatges **qwen-image-2.0-pro** de Qwen/DashScope amb LibreChat.

## Funcionalitats

- **generate_image**: Genera imatges a partir de text
- **edit_image**: Edita imatges existents amb instruccions textuals

## Configuració

El servidor es configura automàticament al `librechat.yaml`:

```yaml
mcpServers:
  qwen-image:
    type: stdio
    command: node
    args:
      - '/app/mcp-servers/qwen-image/index.js'
    env:
      DASHSCOPE_API_KEY: '${QWEN_API_KEY}'
    timeout: 120000
```

## Variables d'entorn

- `DASHSCOPE_API_KEY`: API key de DashScope (Alibaba Cloud)
- `DASHSCOPE_BASE_URL` (opcional): URL base de l'API. Per defecte: `https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
- `QWEN_IMAGE_MODEL` (opcional): Model a utilitzar. Per defecte: `qwen-image-2.0-pro`

## Mides d'imatge suportades

- `1024*1024` (quadrat, per defecte)
- `720*1280` (vertical)
- `1280*720` (horitzontal)
- `2048*2048` (alta resolució)

## Ús a LibreChat

Un cop configurat, els usuaris poden demanar als agents que generin o editin imatges utilitzant el servidor MCP `qwen-image`.

Exemples:
- "Genera una imatge d'un paisatge de muntanya al capvespre"
- "Edita aquesta imatge per afegir-hi un cel estrellat"

## Obtenir API Key

1. Ves a [Alibaba Cloud DashScope](https://dashscope.console.aliyun.com/)
2. Crea un compte o inicia sessió
3. Genera una API key a la secció de credencials
4. Afegeix-la al `.env` com a `QWEN_API_KEY`

## Desenvolupament local

```bash
cd mcp-servers/qwen-image
npm install
DASHSCOPE_API_KEY=la-teva-key node index.js
```

## Llicència

MIT
