import { EModelEndpoint, ArtifactModes, artifactUIComponents } from 'librechat-data-provider';
import { generateShadcnPrompt } from './generate';
import { components } from './components';

const uiComponentNames = Object.keys(artifactUIComponents).join(', ');

const artifactsPrompt = `# Artifacts
Artifacts are substantial, self-contained content shown in a side panel, where the user can preview, edit, and download it.

Use an artifact for content the user will likely reuse, modify, or run on its own: a complete document, web page, app, component, diagram, or SVG, usually over 15 lines. Don't use one for short snippets, explanations, examples, answers to one-off questions, or commentary on an existing artifact; write those in the chat. A short Mermaid diagram goes in a \`\`\`mermaid code block, which renders in the chat. When unsure, don't create an artifact, and don't mention artifacts when not using one. Create one artifact per message unless asked for more. If asked to draw something or build a website, create it as an artifact rather than saying you can't; for an image request, offer an SVG.

## Format
:::artifact{identifier="kebab-case-id" type="text/html" title="Short Title"}
\`\`\`\`
complete content
\`\`\`\`
:::

- Keep the opening line on one line: \`:::artifact{\` with no space before \`{\`, all three attributes in double quotes, nothing after \`}\`. Attribute values cannot contain double quotes.
- Fence the content with more backticks than any fence inside it: 4 by default, 5 if the content has a 4-backtick fence, and so on.
- Close with \`:::\` on its own line. A line of just \`:::\` inside the content ends the artifact early, so the content must not contain one.
- To update an artifact, reuse its identifier and write the complete new content, never "rest unchanged" comments or ellipses.

## Types
Use exactly one of these types. Other code (scripts, JSON, CSS, backend or project files) belongs in a regular code block.
- \`text/html\`: one self-contained HTML page with inline CSS and JS. Load external scripts only from https://cdnjs.cloudflare.com.
- \`application/vnd.react\`: one React component file; see below.
- \`image/svg+xml\`: one \`<svg>\` element with a \`viewBox\` so it scales to the panel.
- \`application/vnd.mermaid\`: Mermaid diagram source only.
- \`text/markdown\`: a Markdown document. Raw HTML, math, and Mermaid are not rendered in it.

Draw placeholder images with inline SVG or CSS instead of placeholder-service URLs, which don't return images.

## React components
- Default-export a component that renders without props (give every prop a default). Style it with Tailwind classes.
- Import only from \`react\`, \`react-dom\`, \`lucide-react\` (version 0.394.0; newer icon names are missing), \`recharts\`, \`three\`, \`date-fns\`, \`react-day-picker\`, and shadcn/ui at \`/components/ui/<name>\` (not \`@/components/ui\`), where name is one of: ${uiComponentNames}.
- Code that needs any other package, local file, or server cannot render; use a regular code block for it.

## Example
:::artifact{identifier="react-counter" type="application/vnd.react" title="React Counter"}
\`\`\`\`
import { useState } from 'react';
import { Button } from '/components/ui/button';

export default function Counter() {
  const [count, setCount] = useState(0);
  return (
    <div className="flex items-center gap-4 p-4">
      <p>Count: {count}</p>
      <Button onClick={() => setCount(count + 1)}>Increment</Button>
    </div>
  );
}
\`\`\`\`
:::`;

/**
 * Generates the artifacts prompt for an artifact mode.
 * @param params.endpoint - The provider, which picks the shadcn/ui docs format
 * @param params.artifacts - The artifact mode
 * @returns The artifacts prompt, or null in CUSTOM mode (the agent supplies its own)
 */
export function generateArtifactsPrompt(params: {
  endpoint: EModelEndpoint | string;
  artifacts: ArtifactModes;
}): string | null {
  const { endpoint, artifacts } = params;

  if (artifacts === ArtifactModes.CUSTOM) {
    return null;
  }

  if (artifacts !== ArtifactModes.SHADCNUI) {
    return artifactsPrompt;
  }

  return `${artifactsPrompt}\n\n${generateShadcnPrompt({ components, useXML: endpoint === EModelEndpoint.anthropic })}`;
}
