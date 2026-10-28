# @librechat/chat example

A minimal consumer of `@librechat/chat`: a Vite React page that renders a working, themed chat from
the package's public entries (`@librechat/chat`, `/react`, `/components`) and the
`@librechat/client` theme, with an in-memory transport in place of a LibreChat server. It imports
nothing from the app; ESLint rejects a `~/` import, a `client/src` import, or a relative import into
the package's sources.

It renders what the package holds today and grows as components move in.

```bash
npm run build:data-provider && npm run build:client-package
npm run example -w @librechat/chat
```

Query parameters pick the appearance: `?mode=dark` or `?mode=light` (the system preference by
default) and `?theme=clickhouse` for the ClickHouse reference theme.

`src/transport.ts` is the substitute transport: it answers each turn with the `final` frame a
server ends a turn with. `src/host.tsx` answers what the message parts ask of the app. The smoke
test in `src/__tests__` runs with the package's jest suite.
