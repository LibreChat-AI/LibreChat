import { ArtifactModes, EModelEndpoint, artifactUIComponents } from 'librechat-data-provider';
import { generateArtifactsPrompt } from './index';

const mountedComponents = new Set(Object.keys(artifactUIComponents));

const promptFor = (endpoint: string, artifacts: ArtifactModes): string => {
  const prompt = generateArtifactsPrompt({ endpoint, artifacts });
  if (prompt == null) {
    throw new Error(`No artifacts prompt for ${endpoint}/${artifacts}`);
  }
  return prompt;
};

const uiImports = (prompt: string): string[] =>
  Array.from(prompt.matchAll(/["']\/components\/ui\/([a-z-]+)["']/g), (match) => match[1]);

describe('generateArtifactsPrompt', () => {
  const defaultPrompt = promptFor(EModelEndpoint.openAI, ArtifactModes.DEFAULT);

  it('returns null in custom mode, where the agent supplies its own instructions', () => {
    expect(
      generateArtifactsPrompt({
        endpoint: EModelEndpoint.anthropic,
        artifacts: ArtifactModes.CUSTOM,
      }),
    ).toBeNull();
  });

  it('gives every provider the same default prompt', () => {
    expect(promptFor(EModelEndpoint.anthropic, ArtifactModes.DEFAULT)).toBe(defaultPrompt);
    expect(promptFor(EModelEndpoint.bedrock, ArtifactModes.DEFAULT)).toBe(defaultPrompt);
  });

  it('appends the shadcn/ui docs after a blank line, as XML for Anthropic', () => {
    const anthropic = promptFor(EModelEndpoint.anthropic, ArtifactModes.SHADCNUI);
    const openAI = promptFor(EModelEndpoint.openAI, ArtifactModes.SHADCNUI);

    expect(anthropic.startsWith(`${defaultPrompt}\n\n## `)).toBe(true);
    expect(openAI.startsWith(`${defaultPrompt}\n\n## `)).toBe(true);
    expect(anthropic).toContain('<component>');
    expect(openAI).not.toContain('<component>');
  });

  it('lists exactly the shadcn/ui components mounted into React artifacts', () => {
    const listed = defaultPrompt.match(/where name is one of: ([^\n]+)\.\n/)?.[1].split(', ');
    expect(listed).toEqual(Object.keys(artifactUIComponents));
  });

  it.each([EModelEndpoint.anthropic, EModelEndpoint.openAI])(
    'only documents shadcn/ui imports that resolve in the sandbox (%s)',
    (endpoint) => {
      const imports = uiImports(promptFor(endpoint, ArtifactModes.SHADCNUI));

      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((name) => !mountedComponents.has(name))).toEqual([]);
    },
  );

  it('does not send models to the placeholder image route, which LibreChat does not serve', () => {
    expect(promptFor(EModelEndpoint.anthropic, ArtifactModes.SHADCNUI)).not.toContain(
      '/api/placeholder',
    );
  });

  it('ends with a well-formed React artifact example', () => {
    const lines = defaultPrompt.slice(defaultPrompt.indexOf('## Example\n')).split('\n');
    const body = lines.slice(3, -2).join('\n');

    expect(lines[1]).toMatch(
      /^:::artifact\{identifier="[a-z0-9-]+" type="application\/vnd\.react" title="[^"]+"\}$/,
    );
    expect(lines[2]).toBe('````');
    expect(lines.slice(-2)).toEqual(['````', ':::']);
    expect(body).toContain('export default function');
    expect(body).not.toMatch(/^`{4,}|^:{3,}\s*$/m);
    expect(uiImports(body).every((name) => mountedComponents.has(name))).toBe(true);
  });
});
