import type { Plugin } from 'vite';

const injection = String.raw`var scriptToInsert = "\n    <script>\n      const scope = ".concat(JSON.stringify(scope), ";\n      ").concat(script, "\n    </script>\n    ").trim();`;
const scopedInjection = String.raw`var scriptToInsert = "\n    <script>\n      (function () {\n      const scope = ".concat(JSON.stringify(scope), ";\n      ").concat(script, "\n      })();\n    </script>\n    ").trim();`;

/** Sandpack 2.19.8 leaks console-hook bindings into the artifact's global scope. */
export function sandpackConsoleIsolation() {
  return {
    name: 'sandpack-console-isolation',
    transform: {
      filter: {
        id: /[\\/]node_modules[\\/]@codesandbox[\\/]sandpack-client[\\/]dist[\\/]index-[^\\/]+\.(?:mjs|js)(?:\?|$)/,
      },
      handler(code: string) {
        if (!code.includes('SandpackStatic.prototype.injectScriptIntoHead')) {
          return null;
        }
        // Fail on dependency drift instead of silently restoring collisions.
        if (code.split(injection).length !== 2) {
          throw new Error('Sandpack static script injection changed; update console isolation.');
        }
        return { code: code.replace(injection, scopedInjection), map: null };
      },
    },
  } satisfies Plugin;
}
