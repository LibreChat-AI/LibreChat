import { Tools, replaceSpecialVars, formatPromptTimestamp } from 'librechat-data-provider';

/**
 * Builds the web search tool context with citation format instructions. With
 * `stableContext` the recency hint refers to the conversation start and to
 * date-change notes in the history.
 */
export function buildWebSearchContext(stableContext = false): string {
  return `# \`${Tools.web_search}\`:
Use this tool when the user's request calls for it, whether directly, indirectly, or implicitly, or when answering requires information that is current, real-time, or otherwise beyond your own knowledge; for questions you can answer reliably on your own, respond directly without searching. When searching, execute immediately without preface, then provide a brief summary addressing the query directly, then structure your response with clear Markdown formatting (## headers, lists, tables). Cite sources properly, tailor tone to query type, and provide comprehensive details.

${
  stableContext
    ? 'When recency matters, use the conversation start time from the runtime context; if the date changes later, a <context_update> block at the start of a user message states the new date.'
    : 'Use the conversation date/time from the dynamic runtime context when recency matters.'
}

**CITATION FORMAT - UNICODE ESCAPE SEQUENCES ONLY:**
Use these EXACT escape sequences (copy verbatim): \\ue202 (before each anchor), \\ue200 (group start), \\ue201 (group end), \\ue203 (highlight start), \\ue204 (highlight end)

Anchor pattern: \\ue202turn{N}{type}{index} where N=turn number, type=search|news|image|ref, index=0,1,2...

**Examples (copy these exactly):**
- Single: "Statement.\\ue202turn0search0"
- Multiple: "Statement.\\ue202turn0search0\\ue202turn0news1"
- Group: "Statement. \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Highlight: "\\ue203Cited text.\\ue204\\ue202turn0search0"
- Image: "See photo\\ue202turn0image0."

**CRITICAL:** Output escape sequences EXACTLY as shown. Do NOT substitute with † or other symbols. Place anchors AFTER punctuation. Cite every non-obvious fact/quote. NEVER use markdown links, [1], footnotes, or HTML tags.`.trim();
}

/**
 * Builds the web search runtime context. With `stableContext` it is anchored to
 * the conversation start, so it stays byte-identical across the turns of one
 * conversation; otherwise it states the logical turn start time.
 */
export function buildWebSearchDynamicContext({
  turnStartedAt,
  conversationStartedAt,
  timezone,
  stableContext = false,
}: {
  turnStartedAt?: string | number | Date;
  conversationStartedAt?: string | number | Date;
  timezone?: string;
  stableContext?: boolean;
}): string {
  if (!stableContext) {
    return `# \`${Tools.web_search}\` Runtime Context
Conversation Date & Time: ${replaceSpecialVars({ text: '{{iso_datetime}}', now: turnStartedAt })}`.trim();
  }
  const now = conversationStartedAt ?? turnStartedAt ?? Date.now();
  return `# \`${Tools.web_search}\` Runtime Context
Conversation started: ${formatPromptTimestamp({ now, timezone })}`;
}
