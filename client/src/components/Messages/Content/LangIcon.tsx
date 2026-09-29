import React from 'react';
import { FileText } from 'lucide-react';
import LANG_ICON_PATHS from './langIconPaths';

interface LangIconProps {
  lang: string;
  className?: string;
}

const LANG_ALIASES: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  rs: 'rust',
  golang: 'go',
  rb: 'ruby',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  powershell: 'bash',
  cmd: 'bash',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  dotnet: 'csharp',
  htm: 'html',
  html5: 'html',
  css3: 'css',
  scss: 'sass',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  mysql: 'json',
  postgresql: 'json',
  sqlite: 'json',
  sql: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  pl: 'perl',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  jl: 'julia',
  ml: 'ocaml',
  mli: 'ocaml',
  fs: 'fsharp',
  fsx: 'fsharp',
  cr: 'crystal',
  coffee: 'coffeescript',
  sol: 'solidity',
  wasm: 'webassembly',
  wat: 'webassembly',
  gql: 'graphql',
  tex: 'latex',
  md: 'markdown',
  mdx: 'markdown',
  pas: 'delphi',
  pascal: 'delphi',
  rkt: 'racket',
  purs: 'purescript',
};

/** Map from alias used in LANG_ICON_PATHS to the name used in ICON_IMPORTS on the old code. */
const NAME_MAP: Record<string, string> = {
  java: 'openjdk',
  c: 'c',
  cpp: 'cplusplus',
  csharp: 'dotnet',
  html: 'html5',
  bash: 'gnubash',
  groovy: 'apachegroovy',
};

/**
 * Whether `lang` resolves to a brand glyph. Callers that need a fallback
 * icon of their own can't infer it from `LangIcon` returning `null`,
 * since that happens inside React's render.
 */
export function hasLangIcon(lang: string): boolean {
  const key = lang.toLowerCase();
  if (key === 'txt' || key === 'text') {
    return true;
  }
  const resolved = LANG_ALIASES[key] ?? key;
  return LANG_ICON_PATHS[NAME_MAP[resolved] ?? resolved] != null;
}

const LangIcon = React.memo(function LangIcon({ lang, className }: LangIconProps) {
  const key = lang.toLowerCase();
  if (key === 'txt' || key === 'text') {
    return <FileText className={className} aria-hidden="true" />;
  }
  const resolved = LANG_ALIASES[key] ?? key;
  const pathKey = NAME_MAP[resolved] ?? resolved;
  const path = LANG_ICON_PATHS[pathKey];
  if (!path) {
    return null;
  }
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
});

export default LangIcon;
