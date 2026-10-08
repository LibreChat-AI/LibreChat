# Setup: websearch-dialog-ready

Branch with the Web Search dialog UI work, plus a working `npm run dev`.

## Prerequisites
- Node.js 20+ (this machine used 24)
- MongoDB on `127.0.0.1:27017`
- Optional: MeiliSearch (conversation search; app runs without it)

## Get the code
```bash
git clone https://github.com/dv130703/LibreChat.git
cd LibreChat
git fetch origin websearch-dialog-ready
git checkout websearch-dialog-ready
```

## Configure (local only — not in git)
```bash
cp .env.example .env          # set MONGO_URI, secrets, keys
cp librechat.example.yaml librechat.yaml
```
Edit `librechat.yaml` for your endpoints/webSearch. On this branch, `webSearch.rerankerType` must be `jina` or `cohere` (or omit it). Do not use `none`. `customParams.reasoningKey` is not accepted by this branch’s schema — remove it if you copy a newer yaml.

## Install & build
```bash
npm ci
npm run build:packages
npm run build:client   # production client bundle
```

## Run
```bash
npm run dev
```
- App/API: http://localhost:3080  
- Vite: http://localhost:3090  

`npm run dev` runs `backend:dev` + `frontend:dev` via `concurrently`.

## Notes
- MeiliSearch missing → search disabled; chat still works.
- RAG at `http://localhost:2222` is optional (logged if reachable).
