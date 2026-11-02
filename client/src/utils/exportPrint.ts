/**
 * PDF 내보내기 — 인쇄 문서 빌더 (2026-08-26 전면 재작성).
 *
 * 기존 방식(html-to-image 래스터 → jsPDF)은 2페이지에 14MB 가 나오고,
 * 마크다운이 원문 그대로(##, **, 표 파이프) 노출되고, 인용 [N] 도 치환되지
 * 않았다. 이 모듈은:
 *  1) 마크다운을 실제 HTML 로 렌더링하고 (react-markdown + gfm, 채팅과 동일 문법)
 *  2) 인용 [N]/[[N]](url) 을 실제 파일명 『…』 으로 치환한 뒤
 *  3) 스타일이 입혀진 인쇄 문서를 숨김 iframe 으로 열어 브라우저 네이티브
 *     인쇄(→ PDF 저장)를 띄운다.
 * 결과물은 벡터 텍스트(선택·검색 가능)라 용량이 수백 KB 수준으로 떨어진다.
 */
import { createElement } from 'react';
import { displayNameFromMeta } from './displayName';
import type { BklSource } from '~/components/Chat/Messages/Content/ChunkModal';

// useConversationCitations 와 동일 포맷 (스트리밍 변환 링크 + 원문 낱개/묶음).
// 자릿수 제한 없음 — 세 자리 인용번호가 치환에서 누락되던 문제 (2026-09-01).
// 매핑 실패한 번호는 replaceCitationsWithFilenames 가 [N] 그대로 남긴다.
const CITE_LINK_RE = /\[\[(\d+)\]\]\([^)]*\)/g;
// `[N](url)` 형태의 일반 마크다운 링크를 건드리지 않도록 `(?!\()` 가드.
const CITE_PLAIN_RE = /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g;

/** 출처 메타에서 표시용 파일명 추출 — 『파일명』 프리픽스·OCR .md 제거. */
export function citationFileName(source: BklSource | undefined | null): string {
  return displayNameFromMeta(source?.metadata?.[0]);
}

/**
 * 답변 텍스트의 인용 마커를 실제 파일명으로 치환한다.
 * 매핑 실패(N 에 해당하는 출처 없음) 시 [N] 을 그대로 남긴다.
 */
export function replaceCitationsWithFilenames(
  text: string,
  sources: BklSource[] | null | undefined,
): string {
  if (!text || !sources || sources.length === 0) return text;
  const label = (n: number): string | null => {
    const name = citationFileName(sources[n - 1]);
    return name ? `『${name}』` : null;
  };
  let out = text.replace(CITE_LINK_RE, (_m, nStr: string) => label(Number(nStr)) ?? `[${nStr}]`);
  out = out.replace(CITE_PLAIN_RE, (_m, group: string) => {
    const labels = group.split(',').map((s) => {
      const n = Number(s.trim());
      return label(n) ?? `[${n}]`;
    });
    // 같은 파일 연속 인용은 한 번만 (『a』『a』 → 『a』)
    return labels.filter((l, i) => l !== labels[i - 1]).join('');
  });
  return out;
}

/** 마크다운 → HTML — 채팅 본문과 같은 파서(react-markdown + remark-gfm) 사용. */
export async function renderMarkdownToHtml(markdown: string): Promise<string> {
  const [{ renderToStaticMarkup }, { default: ReactMarkdown }, { default: remarkGfm }] =
    await Promise.all([import('react-dom/server'), import('react-markdown'), import('remark-gfm')]);
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown),
  );
}

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface PrintBlock {
  sender: string;
  isUser: boolean;
  /** 이미 렌더링된 신뢰된 HTML (renderMarkdownToHtml 결과). */
  html: string;
}

const PRINT_CSS = `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
body {
  font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', 'Segoe UI', system-ui, sans-serif;
  font-size: 12.5px; line-height: 1.7; color: #111827; margin: 0;
  word-break: break-word; -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
.doc-title { font-size: 20px; font-weight: 700; margin: 0 0 6px; }
.doc-meta { font-size: 10.5px; color: #6b7280; border-bottom: 1px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 20px; }
.msg { margin: 0 0 20px; }
.msg-sender { font-weight: 700; font-size: 11px; letter-spacing: 0.05em; margin-bottom: 5px; }
.msg-user .msg-sender { color: #1d4ed8; }
.msg-assistant .msg-sender { color: #047857; }
.msg-user .msg-body { background: #f3f4f6; border-radius: 8px; padding: 8px 12px; }
.msg-body > :first-child { margin-top: 0; }
.msg-body > :last-child { margin-bottom: 0; }
h1, h2, h3, h4 { line-height: 1.4; margin: 18px 0 8px; break-after: avoid; }
h1 { font-size: 16px; } h2 { font-size: 15px; } h3 { font-size: 13.5px; } h4 { font-size: 12.5px; }
p { margin: 8px 0; }
table { border-collapse: collapse; width: 100%; font-size: 11px; margin: 10px 0; }
th, td { border: 1px solid #d1d5db; padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: #f3f4f6; font-weight: 600; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
code { background: #f3f4f6; border-radius: 4px; padding: 1px 4px; font-size: 11px; }
pre { background: #f6f8fa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #d1d5db; margin: 8px 0; padding: 2px 12px; color: #4b5563; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 16px 0; }
a { color: #1d4ed8; text-decoration: none; }
ul, ol { padding-left: 20px; margin: 6px 0; }
li { margin: 2px 0; }
img { max-width: 100%; }
`;

/** 대화 전체를 하나의 인쇄용 HTML 문서 문자열로 조립한다. */
export function buildPrintHtml(opts: {
  title: string;
  /** 브라우저 인쇄 → PDF 저장 시 기본 파일명이 되는 문서 제목. */
  documentTitle: string;
  metaLines: string[];
  blocks: PrintBlock[];
}): string {
  const meta = opts.metaLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  const body = opts.blocks
    .map(
      (b) =>
        `<section class="msg ${b.isUser ? 'msg-user' : 'msg-assistant'}">` +
        `<div class="msg-sender">${escapeHtml(b.sender)}</div>` +
        `<div class="msg-body">${b.html}</div>` +
        `</section>`,
    )
    .join('');
  return (
    '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8" />' +
    `<title>${escapeHtml(opts.documentTitle)}</title>` +
    `<style>${PRINT_CSS}</style></head><body>` +
    `<h1 class="doc-title">${escapeHtml(opts.title)}</h1>` +
    `<div class="doc-meta">${meta}</div>` +
    body +
    '</body></html>'
  );
}

/**
 * 숨김 iframe 으로 HTML 문서를 로드해 네이티브 인쇄 대화상자를 띄운다.
 * (macOS/Windows 모두 "PDF로 저장" 지원 — 벡터 텍스트, 페이지 나눔 자동)
 */
export function printHtmlDocument(html: string): Promise<void> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    // 0×0 이면 일부 엔진이 레이아웃을 잡지 않아 빈 페이지가 인쇄된다.
    // 실제 지면 크기를 주고 화면 밖으로 밀어낸다.
    iframe.style.position = 'fixed';
    iframe.style.left = '-10000px';
    iframe.style.top = '0';
    iframe.style.width = '210mm';
    iframe.style.height = '297mm';
    iframe.style.border = '0';
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      iframe.remove();
      resolve();
    };
    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) {
        cleanup();
        return;
      }
      win.addEventListener('afterprint', () => setTimeout(cleanup, 100), { once: true });
      // afterprint 미발화(브라우저별 편차) 대비 — 인쇄 스냅샷은 이미 찍힌 뒤라 안전.
      setTimeout(cleanup, 120_000);
      const doPrint = () => {
        win.focus();
        win.print();
      };
      const fonts = (win.document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts?.ready) {
        fonts.ready.then(doPrint).catch(doPrint);
      } else {
        doPrint();
      }
    };
    // srcdoc 은 appendChild 전에 넣어야 한다. 먼저 붙이면 about:blank 로
    // onload 가 한 번 발화해 빈 문서가 인쇄된다.
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}
