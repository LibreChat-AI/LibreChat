# @librechat/chat

The chat state, transport and message components LibreChat's own app renders, as a package another
React app can render too. It draws with [`@librechat/client`](../client/src/theme/README.md), which
supplies the primitives, the theme and the color roles.

The package is at `0.1.0` and not yet published. What it leaves to the app is listed
[at the end](#what-the-app-supplies).

## Entries

| Import                           | What it holds                                                        |
| -------------------------------- | -------------------------------------------------------------------- |
| `@librechat/chat`                | The core: chat state and the generation transport. No React.         |
| `@librechat/chat/react`          | Hooks, contexts and the host providers an app fills in.              |
| `@librechat/chat/components`     | The message, part, composer and side-chat components.                |
| `@librechat/chat/locales/*`      | The strings the components show, one JSON file per language.         |
| `@librechat/chat/style.css`      | The package's own hand-written rules, for an app that runs Tailwind. |
| `@librechat/chat/standalone.css` | Everything, compiled, for an app that does not.                      |

The strings and the compiled stylesheet are written by their own steps, `npm run build:locales` and
`npm run build:css`, which `prepack` runs after `npm run build`.

## Styles

The components are drawn with Tailwind utilities and the client package's color roles. Pick one of
the two ways to load them.

### An app without Tailwind

Import one file and put the `librechat` class on the element the chat renders in:

```css
@import '@librechat/chat/standalone.css';
```

```tsx
<div className="librechat">{/* the chat */}</div>
```

The file holds the utilities both packages use, the tokens with their stock values, and both
packages' stylesheets. Two things keep it out of the rest of the page:

- Every rule that paints applies only inside `.librechat`, at no added specificity. Tailwind's
  reset does not reach the page around the chat, and neither do class names such as `.table` or
  `.collapse`.
- All of it sits in one cascade layer, `librechat`. A rule of the app's that is in no layer wins
  over it without having to outrank a selector. That includes a reset: if the app's own reset is
  unlayered and should lose to the chat, import it into a layer and sort it first.

  ```css
  @import './reset.css' layer(reset);
  @layer reset, librechat;
  ```

The theme's custom properties (`--text-primary` and the rest) are still set on the document, since
that is where `ThemeProvider` writes them.

### An app with Tailwind 4

Follow the client package's [Tailwind setup](../client/src/theme/README.md): its preset, its
`theme.css`, its `style.css` and class-based dark mode. Then add this package's build to the
content Tailwind reads, and its stylesheet to the imports:

```js
content: [
  './src/**/*.{js,jsx,ts,tsx}',
  './node_modules/@librechat/client/dist/**/*.{js,mjs,cjs}',
  './node_modules/@librechat/chat/dist/**/*.{js,mjs,cjs}',
],
```

```css
@import 'tailwindcss';
@import '@librechat/client/theme.css';
@import '@librechat/client/style.css';
@import '@librechat/chat/style.css';
@config '../tailwind.config.js';
```

The typography of a reply (`.prose`, `.markdown`, `.message-content`) is in
`@librechat/client/style.css`.

## Menus, dialogs and tooltips

A menu, a dialog, a popover or a tooltip renders at the end of `<body>`, outside the element the
chat is in. With `standalone.css` that is outside the `librechat` class, so name the element they
render into with `PortalProvider`:

```tsx
import { PortalProvider } from '@librechat/client';

<PortalProvider className="librechat">
  <div className="librechat">{/* the chat */}</div>
</PortalProvider>;
```

Given a `className`, the provider keeps an element of its own at the end of `<body>` with that
class. Pass `container` to use an element of the app's. An app that owns its whole page can skip
the provider and put `librechat` on `<html>`.

## Strings

The components name their copy by key and read it through `react-i18next`. Each language file
holds the keys the chat UI can show, with the copy LibreChat ships, and `index.json` lists the
languages:

```tsx
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '@librechat/chat/locales/en.json';
import de from '@librechat/chat/locales/de.json';

const i18n = createInstance();
await i18n.use(initReactI18next).init({
  lng: 'de',
  fallbackLng: 'en',
  resources: { en: { translation: en }, de: { translation: de } },
  interpolation: { escapeValue: false },
});

<I18nextProvider i18n={i18n}>{/* the chat */}</I18nextProvider>;
```

The app owns the i18next instance, so it decides the language and can add or replace any key.

## Theme

Wrap the chat in `ThemeProvider` from `@librechat/client`. It applies the stock theme, or a
`ThemeDefinition` of the app's, by setting custom properties, and it toggles the `dark` class the
dark styles follow. The client package's [theme guide](../client/src/theme/README.md) covers the
roles a theme can set.

## Code loaded on demand

The package loads some code on first need instead of with the page: the code highlighter's
grammars, and the math and code plugins a markdown renderer runs.

```tsx
import ReactMarkdown from 'react-markdown';
import { toRehypePlugins, useRehypeModules } from '@librechat/chat/react';

function Reply({ text }: { text: string }) {
  /* Null until KaTeX and the highlighter have loaded, and never loaded for text with no math or
     fenced code. The text renders at once and gains its formatting when they arrive. */
  const modules = useRehypeModules(text);
  return <ReactMarkdown rehypePlugins={toRehypePlugins(modules)}>{text}</ReactMarkdown>;
}
```

The loader imports KaTeX's stylesheet (`katex/dist/katex.min.css`) with the plugins, so the app's
bundler has to accept a stylesheet import, as Vite and webpack do. `rehype-katex` and
`rehype-highlight` are typed against the `unified` they were published with; cast the list where
your `react-markdown` is on another major.

To decide what a failed plugin load means, wrap the chat in `LazyImportProvider`. It receives the
load as a function and returns its promise. LibreChat uses it to reload a page whose files a newer
deploy has replaced:

```tsx
import { LazyImportProvider } from '@librechat/chat/react';

const load = <M,>(run: () => Promise<M>) =>
  run().catch((error) => {
    reportFailedLoad(error);
    throw error;
  });

<LazyImportProvider value={load}>{/* the chat */}</LazyImportProvider>;
```

Without the provider the load runs as written; the highlighter's grammars always do.

The remark plugins LibreChat's markdown uses are in the core entry: `remarkApproxTilde`,
`remarkSingleDollarMath` and the `langSubset` of languages a message highlights.

## Markdown elements

`markdownElements` is the set of elements LibreChat draws a reply's markdown with, in the shape
`react-markdown` takes: fenced code as a `CodeBlock` with copy and download, links, images,
tables, and lists, quotes and headings that find their own text direction.
`markdownPreviewElements` is the same for a preview that runs nothing.

```tsx
import ReactMarkdown from 'react-markdown';
import { markdownElements } from '@librechat/chat/components';
import { CodeBlockProvider, toRehypePlugins, useRehypeModules } from '@librechat/chat/react';

function Reply({ text }: { text: string }) {
  const modules = useRehypeModules(text);
  return (
    <CodeBlockProvider>
      <ReactMarkdown components={markdownElements} rehypePlugins={toRehypePlugins(modules)}>
        {text}
      </ReactMarkdown>
    </CodeBlockProvider>
  );
}
```

The elements read the message parts host. Three of its members are optional and change what a
reply can do:

| Host member       | With it                                                     | Without it                          |
| ----------------- | ----------------------------------------------------------- | ----------------------------------- |
| `renderCodeBlock` | The host draws each fence, say with a run button and output | The package's `CodeBlock`           |
| `renderMermaid`   | The host draws a `mermaid` fence as a diagram               | The fence is an ordinary code block |
| `useFileDownload` | A link to the user's own file downloads it                  | The link is an ordinary link        |

A host that runs code composes the package's block: `CodeBlock` takes the run button as
`renderRun` and what the runs printed as `output`. Wrap the tree in `MediaContext.Provider` to
let an image a reply names by filename resolve to the attachment its run produced.

## What the app supplies

- **How content is drawn.** Markdown, code blocks, math, images, files and audio are rendered by
  functions the app passes in through the host providers in `@librechat/chat/react`
  (`MessagePartsHostProvider`, `MessagesHostProvider`). LibreChat's own are still in its app.
  Whatever stylesheets those renderers need, such as a code highlighting theme, come with them;
  KaTeX's is loaded by `useRehypeModules`.
- **The backend.** The transport speaks LibreChat's routes and payloads; the app supplies the
  request functions and the session.
- **The font files.** The client package's stylesheet names its fonts by package path
  (`@librechat/client/fonts/*`) for the app's bundler to resolve.
- **Peer dependencies.** React, `@librechat/client`, `librechat-data-provider` and the rest of the
  `peerDependencies` in `package.json`.
