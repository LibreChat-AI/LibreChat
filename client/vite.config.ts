import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { constants } from 'zlib';
import { defineConfig } from 'vite';
import { createRequire } from 'module';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { compression, defineAlgorithm } from 'vite-plugin-compression2';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

/**
 * vite-plugin-node-polyfills uses @rollup/plugin-inject to replace bare globals (e.g. `process`)
 * with imports like `import process from 'vite-plugin-node-polyfills/shims/process'`. When the
 * consuming module (e.g. recoil) is hoisted to the monorepo root, Vite's ESM resolver walks up
 * from there and never finds the shims (installed only in client/node_modules). This map resolves
 * the shim specifiers to absolute paths via CJS require.resolve anchored to the client directory.
 */
const NODE_POLYFILL_SHIMS: Record<string, string> = {
  'vite-plugin-node-polyfills/shims/process': require.resolve(
    'vite-plugin-node-polyfills/shims/process',
  ),
  'vite-plugin-node-polyfills/shims/buffer': require.resolve(
    'vite-plugin-node-polyfills/shims/buffer',
  ),
  'vite-plugin-node-polyfills/shims/global': require.resolve(
    'vite-plugin-node-polyfills/shims/global',
  ),
};

// https://vitejs.dev/config/
const backendPort = (process.env.BACKEND_PORT && Number(process.env.BACKEND_PORT)) || 3080;
/** IPv6 hosts arrive unbracketed (valid for the listen address) but must be
 *  bracketed inside a URL, or the proxy target parses as host `:` port soup. */
const backendHost = process.env.HOST?.includes(':') ? `[${process.env.HOST}]` : process.env.HOST;
const backendURL = backendHost
  ? `http://${backendHost}:${backendPort}`
  : `http://localhost:${backendPort}`;
const buildSourceMap = process.env.NODE_ENV === 'development';
const QUERY_DEVTOOLS_CHUNK_MODULES = [
  '@tanstack/react-query-devtools',
  '@tanstack/match-sorter-utils',
  'node_modules/superjson',
  'node_modules/copy-anything',
  'node_modules/is-what',
];

export default defineConfig(({ command }) => ({
  base: '',
  server: {
    allowedHosts:
      (process.env.VITE_ALLOWED_HOSTS && process.env.VITE_ALLOWED_HOSTS.split(',')) || [],
    host: process.env.HOST || 'localhost',
    port: (process.env.PORT && Number(process.env.PORT)) || 3090,
    strictPort: false,
    proxy: {
      '/api': {
        target: backendURL,
        changeOrigin: true,
      },
      '/oauth': {
        target: backendURL,
        changeOrigin: true,
      },
    },
  },
  // Set the directory where environment variables are loaded from and restrict prefixes
  envDir: '../',
  envPrefix: ['VITE_', 'SCRIPT_', 'DOMAIN_', 'ALLOW_', 'REACT_APP_THEME_'],
  plugins: [
    react(),
    {
      name: 'node-polyfills-shims-resolver',
      resolveId(id) {
        return NODE_POLYFILL_SHIMS[id] ?? null;
      },
    },
    nodePolyfills(),
    {
      name: 'emit-sw-heal',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'sw-heal.js',
          source: fs.readFileSync(path.resolve(import.meta.dirname, 'sw/heal.js'), 'utf8'),
        });
      },
    },
    copyPublicAssets(),
    VitePWA({
      injectRegister: 'auto', // 'auto' | 'manual' | 'disabled'
      registerType: 'autoUpdate', // 'prompt' | 'autoUpdate'
      devOptions: {
        enabled: false, // disable service worker registration in development mode
      },
      useCredentials: true,
      includeManifestIcons: false,
      workbox: {
        globPatterns: [
          '**/*.{js,css,html}',
          'assets/favicon*.png',
          'assets/icon-*.png',
          'assets/apple-touch-icon*.png',
          /** `manifest.webmanifest` is not listed: vite-plugin-pwa always appends it as an
           * additional manifest entry, so globbing it too duplicates the precache entry. */
          'assets/maskable-icon.png',
        ],
        globIgnores: [
          'images/**/*',
          '**/*.map',
          'index.html',
          'sw-heal.js',
          'assets/rum.*.js',
          'assets/locale-*.js',
          'assets/query-devtools*.js',
        ],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        /**
         * vite-plugin-pwa defaults this to `/^assets\//`, which is only true for the
         * hashed bundle output: the icons live in `assets/` under stable filenames, so the
         * default marks them immutable (`revision: null`) and an installed PWA would keep
         * a rebranded icon forever. Match Vite's `[name].[hash].[ext]` shape instead so
         * hashed chunks stay revision-free while the icons get content revisions.
         */
        dontCacheBustURLsMatching: /\.[\w-]{8}\.(?:js|css)$/,
        /** LibreChat mutates index.html per request for subpath and language support. */
        navigateFallback: null,
        /** Reloads window clients that cannot answer a ping after activation —
         * pages stuck on a previous build's purged precache (stale index.html)
         * have no working code of their own to recover with. */
        importScripts: ['sw-heal.js'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => /\/assets\/locale-[^/]+\.js$/.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'locale-chunks',
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 80,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
            },
          },
        ],
      },
      includeAssets: [],
      manifest: {
        name: 'LibreChat',
        short_name: 'LibreChat',
        display: 'standalone',
        background_color: '#000000',
        theme_color: '#009688',
        icons: [
          {
            src: 'assets/favicon-32x32.png',
            sizes: '32x32',
            type: 'image/png',
          },
          {
            src: 'assets/favicon-16x16.png',
            sizes: '16x16',
            type: 'image/png',
          },
          {
            src: 'assets/apple-touch-icon-180x180.png',
            sizes: '180x180',
            type: 'image/png',
          },
          {
            src: 'assets/icon-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'assets/maskable-icon.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
    }),
    ...(buildSourceMap ? [sourcemapExclude({ excludeNodeModules: true })] : []),
    compression({
      threshold: 10240,
      /**
       * Brotli's default quality of 11 costs ~13s of single-threaded CPU on this bundle
       * against ~0.5s for gzip, and the plugin's scheduler serializes quality >= 10 as a
       * high-memory operation. Quality 5 compresses in ~0.2s, still lands under gzip
       * (4.3MB vs 5.0MB), and parallelizes. `.br` is only served when
       * ENABLE_STATIC_ASSET_BROTLI is set, so the extra 0.5MB buys far less than it costs
       * on every build of every platform.
       */
      algorithms: [
        defineAlgorithm('gzip', { level: 9 }),
        defineAlgorithm('brotliCompress', {
          params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
        }),
      ],
    }),
  ],
  optimizeDeps: {
    include: [
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/process',
      'vite-plugin-node-polyfills/shims/global',
    ],
  },
  publicDir: command === 'serve' ? './public' : false,
  build: {
    sourcemap: buildSourceMap,
    outDir: './dist',
    minify: 'oxc',
    rolldownOptions: {
      preserveEntrySignatures: 'strict',
      output: {
        codeSplitting: {
          groups: [
            {
              name(id: string) {
                const normalizedId = id.replace(/\\/g, '/');
                if (normalizedId.includes('node_modules')) {
                  if (normalizedId.includes('/node_modules/regenerator-runtime/')) {
                    return 'polyfills';
                  }

                  if (normalizedId.includes('@hyperdx/')) {
                    return 'rum';
                  }

                  // IMPORTANT: mermaid and ALL its dependencies must be in the same chunk
                  // to avoid initialization order issues. This includes chevrotain, langium,
                  // dagre-d3-es, and their nested lodash-es dependencies.
                  if (
                    normalizedId.includes('mermaid') ||
                    normalizedId.includes('dagre-d3-es') ||
                    normalizedId.includes('chevrotain') ||
                    normalizedId.includes('langium') ||
                    normalizedId.includes('lodash-es')
                  ) {
                    return 'mermaid';
                  }

                  if (normalizedId.includes('@codesandbox/sandpack')) {
                    return 'sandpack';
                  }
                  if (normalizedId.includes('react-vtree')) {
                    return 'react-vtree';
                  }
                  if (normalizedId.includes('react-virtualized')) {
                    return 'virtualization';
                  }
                  if (normalizedId.includes('i18next') || normalizedId.includes('react-i18next')) {
                    return 'i18n';
                  }
                  // Only regular lodash (not lodash-es which goes to mermaid chunk)
                  if (normalizedId.includes('/lodash/')) {
                    return 'utilities';
                  }
                  if (normalizedId.includes('date-fns')) {
                    return 'date-utils';
                  }
                  if (normalizedId.includes('@dicebear')) {
                    return 'avatars';
                  }
                  if (
                    normalizedId.includes('react-dnd') ||
                    normalizedId.includes('dnd-core') ||
                    normalizedId.includes('react-flip-toolkit') ||
                    normalizedId.includes('flip-toolkit')
                  ) {
                    return 'react-interactions';
                  }
                  if (normalizedId.includes('react-hook-form')) {
                    return 'forms';
                  }
                  if (normalizedId.includes('react-router')) {
                    return 'routing';
                  }
                  if (
                    normalizedId.includes('qrcode.react') ||
                    normalizedId.includes('@marsidev/react-turnstile')
                  ) {
                    return 'security-ui';
                  }

                  if (normalizedId.includes('@codemirror/view')) {
                    return 'codemirror-view';
                  }
                  if (normalizedId.includes('@codemirror/state')) {
                    return 'codemirror-state';
                  }
                  if (normalizedId.includes('@codemirror/language')) {
                    return 'codemirror-language';
                  }
                  if (normalizedId.includes('@codemirror')) {
                    return 'codemirror-core';
                  }

                  if (
                    normalizedId.includes('react-markdown') ||
                    normalizedId.includes('remark-') ||
                    normalizedId.includes('rehype-')
                  ) {
                    return 'markdown-processing';
                  }
                  if (
                    normalizedId.includes('monaco-editor') ||
                    normalizedId.includes('@monaco-editor')
                  ) {
                    return 'code-editor';
                  }
                  if (
                    normalizedId.includes('react-window') ||
                    normalizedId.includes('react-virtual')
                  ) {
                    return 'virtualization';
                  }
                  if (
                    normalizedId.includes('zod') ||
                    normalizedId.includes('yup') ||
                    normalizedId.includes('joi')
                  ) {
                    return 'validation';
                  }
                  if (
                    normalizedId.includes('axios') ||
                    normalizedId.includes('ky') ||
                    normalizedId.includes('fetch')
                  ) {
                    return 'http-client';
                  }
                  if (
                    normalizedId.includes('react-spring') ||
                    normalizedId.includes('react-transition-group')
                  ) {
                    return 'animations';
                  }
                  if (normalizedId.includes('react-select') || normalizedId.includes('downshift')) {
                    return 'advanced-inputs';
                  }
                  if (normalizedId.includes('heic-to')) {
                    return 'heic-converter';
                  }

                  // Existing chunks
                  if (normalizedId.includes('@radix-ui')) {
                    return 'radix-ui';
                  }
                  if (normalizedId.includes('framer-motion')) {
                    return 'framer-motion';
                  }
                  if (
                    normalizedId.includes('node_modules/highlight.js') ||
                    normalizedId.includes('node_modules/lowlight')
                  ) {
                    return 'markdown_highlight';
                  }
                  if (
                    normalizedId.includes('katex') ||
                    normalizedId.includes('node_modules/katex')
                  ) {
                    return 'math-katex';
                  }
                  if (normalizedId.includes('node_modules/hast-util-raw')) {
                    return 'markdown_large';
                  }
                  if (
                    QUERY_DEVTOOLS_CHUNK_MODULES.some((moduleName) =>
                      normalizedId.includes(moduleName),
                    )
                  ) {
                    return 'query-devtools';
                  }
                  if (normalizedId.includes('@tanstack')) {
                    return 'tanstack-vendor';
                  }
                  if (normalizedId.includes('@headlessui')) {
                    return 'headlessui';
                  }

                  if (normalizedId.includes('@icons-pack/react-simple-icons/icons/')) {
                    return null;
                  }

                  // Everything else falls into a generic vendor chunk.
                  return 'vendor';
                }
                if (normalizedId.includes('/src/polyfills/')) {
                  return 'polyfills';
                }
                // Keep lazy-loaded locale files in one chunk per locale.
                const localeMatch = normalizedId.match(
                  /\/src\/locales\/([^/]+)\/translation\.json$/,
                );
                if (localeMatch) {
                  return localeMatch[1] === 'en' ? null : `locale-${localeMatch[1]}`;
                }
                // Let Rolldown decide automatically for any other files.
                return null;
              },
            },
          ],
        },
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.names?.[0] && /\.(woff|woff2|eot|ttf|otf)$/.test(assetInfo.names[0])) {
            return 'assets/fonts/[name][extname]';
          }
          return 'assets/[name].[hash][extname]';
        },
      },
      /**
       * Ignore "use client" warning since we are not using SSR
       * @see {@link https://github.com/TanStack/query/pull/5161#issuecomment-1477389761 Preserve 'use client' directives TanStack/query#5161}
       */
      onwarn(warning, warn) {
        if (warning.message.includes('Error when using sourcemap')) {
          return;
        }
        warn(warning);
      },
    },
    chunkSizeWarningLimit: 1500,
  },
  resolve: {
    alias: {
      '~': path.join(import.meta.dirname, 'src/'),
      $fonts: path.resolve(import.meta.dirname, 'public/fonts'),
      'micromark-extension-math': 'micromark-extension-llm-math',
    },
  },
}));

interface SourcemapExclude {
  excludeNodeModules?: boolean;
}

export function sourcemapExclude(opts?: SourcemapExclude): Plugin {
  return {
    name: 'sourcemap-exclude',
    transform(code: string, id: string) {
      if (opts?.excludeNodeModules && id.includes('node_modules')) {
        return {
          code,
          // https://github.com/rollup/rollup/blob/master/docs/plugin-development/index.md#source-code-transformations
          map: { mappings: '' },
        };
      }
    },
  };
}

/**
 * Production builds set `publicDir: false`, so nothing under public/ reaches dist on its
 * own. This copies what the server actually has to serve: all of public/assets (the PWA
 * icons plus the endpoint, tool and language logos referenced at runtime) and robots.txt.
 * public/fonts is deliberately left out, since fonts are emitted as bundle assets through
 * the `$fonts` alias.
 *
 * The copy MUST happen inside the build. vite-plugin-pwa globs dist/ for
 * `workbox.globPatterns` from its `closeBundle` hook, which runs after every plugin's
 * `writeBundle`, so copying here is what lets the `assets/*.png` icon patterns match. An
 * `npm run build && node scripts/post-build.cjs` chain cannot: it runs after the service
 * worker has already been generated, so the icons were silently absent from the precache
 * manifest.
 */
export function copyPublicAssets(): Plugin {
  const publicDir = path.resolve(import.meta.dirname, 'public');
  let outDir = path.resolve(import.meta.dirname, 'dist');
  return {
    name: 'copy-public-assets',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async writeBundle() {
      await fs.promises.cp(path.join(publicDir, 'assets'), path.join(outDir, 'assets'), {
        recursive: true,
      });
      await fs.promises.copyFile(
        path.join(publicDir, 'robots.txt'),
        path.join(outDir, 'robots.txt'),
      );
    },
  };
}
