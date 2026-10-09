import {
  fixSubgraphTitleContrast,
  sanitizeMermaidSvg,
  artifactFlowchartConfig,
  inlineFlowchartConfig,
  contrastMermaidVariables,
  getMermaidFiles,
} from '~/utils/mermaid';

const makeSvg = (clusters: string): Element => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${clusters}</svg>`,
    'image/svg+xml',
  );
  return doc.querySelector('svg')!;
};

describe('mermaid config', () => {
  describe('flowchart config invariants', () => {
    it('inlineFlowchartConfig must have htmlLabels: false for blob URL <img> rendering', () => {
      expect(inlineFlowchartConfig.htmlLabels).toBe(false);
    });

    it('artifactFlowchartConfig must have htmlLabels: true for direct DOM injection', () => {
      expect(artifactFlowchartConfig.htmlLabels).toBe(true);
    });

    it('both configs share the same base layout settings', () => {
      expect(inlineFlowchartConfig.curve).toBe(artifactFlowchartConfig.curve);
      expect(inlineFlowchartConfig.nodeSpacing).toBe(artifactFlowchartConfig.nodeSpacing);
      expect(inlineFlowchartConfig.rankSpacing).toBe(artifactFlowchartConfig.rankSpacing);
      expect(inlineFlowchartConfig.padding).toBe(artifactFlowchartConfig.padding);
    });
  });

  describe('getMermaidFiles', () => {
    const content = 'graph TD\n  A-->B';

    it('produces dark theme files when isDarkMode is true', () => {
      const files = getMermaidFiles(content, true);
      expect(files['/components/ui/MermaidDiagram.tsx']).toContain('theme: "dark"');
      expect(files['mermaid.css']).toContain('#212121');
    });

    it('produces neutral theme files when isDarkMode is false', () => {
      const files = getMermaidFiles(content, false);
      expect(files['/components/ui/MermaidDiagram.tsx']).toContain('theme: "neutral"');
      expect(files['mermaid.css']).toContain('#FFFFFF');
    });

    it('defaults to dark mode when isDarkMode is omitted', () => {
      const files = getMermaidFiles(content);
      expect(files['/components/ui/MermaidDiagram.tsx']).toContain('theme: "dark"');
    });

    it('includes securityLevel in generated component', () => {
      const files = getMermaidFiles(content, true);
      expect(files['/components/ui/MermaidDiagram.tsx']).toContain('securityLevel: "strict"');
    });

    it('includes all required file keys', () => {
      const files = getMermaidFiles(content, true);
      expect(files['diagram.mmd']).toBe(content);
      expect(files['App.tsx']).toBeDefined();
      expect(files['index.tsx']).toBeDefined();
      expect(files['/components/ui/MermaidDiagram.tsx']).toBeDefined();
      expect(files['mermaid.css']).toBeDefined();
    });

    it('uses artifact flowchart config with htmlLabels: true', () => {
      const files = getMermaidFiles(content, true);
      expect(files['/components/ui/MermaidDiagram.tsx']).toContain('"htmlLabels": true');
    });

    it('does not inject custom themeVariables into generated component', () => {
      const darkFiles = getMermaidFiles(content, true);
      const lightFiles = getMermaidFiles(content, false);
      expect(darkFiles['/components/ui/MermaidDiagram.tsx']).not.toContain('themeVariables');
      expect(lightFiles['/components/ui/MermaidDiagram.tsx']).not.toContain('themeVariables');
    });

    it('handles empty content', () => {
      const files = getMermaidFiles('', true);
      expect(files['diagram.mmd']).toBe('# No mermaid diagram content provided');
    });

    it('serializes special Mermaid labels as a TSX string literal', () => {
      const specialContent = 'flowchart TD\n  A["`code ${danger} C:\\temp`"] --> B';
      const files = getMermaidFiles(specialContent, true);

      expect(files['App.tsx']).toContain(`content={${JSON.stringify(specialContent)}}`);
      expect(files['App.tsx']).not.toContain('content={`');
    });

    it('declares the generated App component before exporting it', () => {
      const files = getMermaidFiles(content, true);

      expect(files['App.tsx']).toContain('const App = () =>');
      expect(files['App.tsx']).toContain('export default App;');
    });
  });

  describe('fixSubgraphTitleContrast', () => {
    it('darkens title text on light subgraph backgrounds (fill attribute)', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect fill="#FFF9C4"/><g class="cluster-label"><text fill="#E0E0E0">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toContain('fill: #1a1a1a');
    });

    it('darkens title text on light subgraph backgrounds (inline style fill)', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect style="fill: #FFF9C4; stroke: #F9A825"/><g class="cluster-label"><text>Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toContain('fill: #1a1a1a');
    });

    it('lightens title text on dark subgraph backgrounds', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect fill="#1f2020"/><g class="cluster-label"><text fill="#222222">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toContain('fill: #f0f0f0');
    });

    it('leaves title text alone when contrast is already good', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect fill="#FFF9C4"/><g class="cluster-label"><text fill="#333333">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toBeNull();
    });

    it('skips clusters without a rect', () => {
      const svg = makeSvg(
        '<g class="cluster"><g class="cluster-label"><text fill="#E0E0E0">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toBeNull();
    });

    it('skips clusters with non-hex fills', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect fill="rgb(255,249,196)"/><g class="cluster-label"><text fill="#E0E0E0">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toBeNull();
    });

    it('sets dark fill when text has no explicit fill on light backgrounds', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect style="fill:#FFF9C4"/><g class="cluster-label"><text>Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toContain('fill: #1a1a1a');
    });

    it('preserves existing text style when appending fill override', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect fill="#FFF9C4"/><g class="cluster-label"><text style="font-size: 14px" fill="#E0E0E0">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      const style = svg.querySelector('text')!.getAttribute('style')!;
      expect(style).toContain('font-size: 14px');
      expect(style).toContain('fill: #1a1a1a');
    });

    it('handles 3-char hex shorthand fills', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect fill="#FFC"/><g class="cluster-label"><text fill="#EEE">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      expect(svg.querySelector('text')!.getAttribute('style')).toContain('fill: #1a1a1a');
    });

    it('avoids double semicolons when existing style has trailing semicolon', () => {
      const svg = makeSvg(
        '<g class="cluster"><rect fill="#FFF9C4"/><g class="cluster-label"><text style="font-size: 14px;" fill="#E0E0E0">Title</text></g></g>',
      );
      fixSubgraphTitleContrast(svg);
      const style = svg.querySelector('text')!.getAttribute('style')!;
      expect(style).not.toContain(';;');
      expect(style).toContain('fill: #1a1a1a');
    });
  });

  describe('sanitizeMermaidSvg', () => {
    const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

    it('produces valid XML parseable as image/svg+xml', () => {
      const svg = wrap('<rect width="10" height="10"/>');
      const result = sanitizeMermaidSvg(svg);
      const doc = new DOMParser().parseFromString(result, 'image/svg+xml');
      expect(doc.querySelector('parsererror')).toBeNull();
    });

    it('preserves foreignObject and its HTML children', () => {
      const svg = wrap(
        '<foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hello</p></div></foreignObject>',
      );
      const result = sanitizeMermaidSvg(svg);
      expect(result).toContain('<foreignObject');
      expect(result).toContain('<p>Hello</p>');
    });

    it('serializes <br> as self-closing <br /> for XML compatibility', () => {
      const svg = wrap(
        '<foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><p>Line1<br/>Line2</p></div></foreignObject>',
      );
      const result = sanitizeMermaidSvg(svg);
      expect(result).toMatch(/<br\s*\/>/);
      expect(result).not.toMatch(/<br\s*>/);
    });

    it('retains xmlns="http://www.w3.org/2000/svg" on the root svg element', () => {
      const svg = wrap('<rect width="10" height="10"/>');
      const result = sanitizeMermaidSvg(svg);
      expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    it('strips script tags from SVG', () => {
      const svg = wrap('<script>alert("xss")</script><rect width="10" height="10"/>');
      const result = sanitizeMermaidSvg(svg);
      expect(result).not.toContain('<script');
      expect(result).not.toContain('alert');
    });

    it('strips event handler attributes', () => {
      const svg = wrap('<rect width="10" height="10" onclick="alert(1)"/>');
      const result = sanitizeMermaidSvg(svg);
      expect(result).not.toContain('onclick');
    });

    it('strips script tags inside foreignObject HTML', () => {
      const svg = wrap(
        '<foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><script>alert("xss")</script><p>Safe</p></div></foreignObject>',
      );
      const result = sanitizeMermaidSvg(svg);
      expect(result).not.toContain('<script');
      expect(result).toContain('Safe');
    });

    it('strips javascript: URLs in foreignObject HTML', () => {
      const svg = wrap(
        '<foreignObject width="100" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><a href="javascript:alert(1)">click</a></div></foreignObject>',
      );
      const result = sanitizeMermaidSvg(svg);
      expect(result).not.toContain('javascript:');
    });

    it('preserves mermaid-specific attributes on SVG elements', () => {
      const svg = wrap('<text dominant-baseline="middle" text-anchor="start">label</text>');
      const result = sanitizeMermaidSvg(svg);
      expect(result).toContain('dominant-baseline');
      expect(result).toContain('text-anchor');
    });

    it('preserves styled span and class names inside foreignObject', () => {
      const svg = wrap(
        '<foreignObject width="150" height="48"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;"><span class="nodeLabel"><p>Node text<br/>second line</p></span></div></foreignObject>',
      );
      const result = sanitizeMermaidSvg(svg);
      expect(result).toContain('nodeLabel');
      expect(result).toContain('Node text');
      expect(result).toContain('second line');
      expect(result).toMatch(/<br\s*\/>/);
    });
  });
});

describe('high contrast mermaid palette', () => {
  it('stays out of the way in the standard themes', () => {
    expect(contrastMermaidVariables(false, false)).toBeUndefined();
    expect(contrastMermaidVariables(true, false)).toBeUndefined();
  });

  /** Mermaid's own `neutral` and `dark` palettes are unreachable from a theme
   *  token, so a contrast mode has to drive them through themeVariables. */
  it('puts diagrams on the canvas with ink marks in both contrast modes', () => {
    const light = contrastMermaidVariables(false, true)!;
    expect(light.background).toBe('#ffffff');
    expect(light.mainBkg).toBe('#ffffff');
    expect(light.lineColor).toBe('#000000');
    expect(light.textColor).toBe('#000000');
    expect(light.nodeBorder).toBe('#000000');

    const dark = contrastMermaidVariables(true, true)!;
    expect(dark.background).toBe('#000000');
    expect(dark.mainBkg).toBe('#000000');
    expect(dark.lineColor).toBe('#ffffff');
    expect(dark.textColor).toBe('#ffffff');
    expect(dark.nodeBorder).toBe('#ffffff');
  });

  it('switches the artifact document to the base theme and the contrast canvas', () => {
    const standard = getMermaidFiles('graph TD; a-->b', true, false);
    const component = standard['/components/ui/MermaidDiagram.tsx'];
    expect(component).toContain('theme: "dark"');
    expect(component).not.toContain('themeVariables');
    expect(standard['mermaid.css']).toContain('#212121');

    const contrast = getMermaidFiles('graph TD; a-->b', true, true);
    const contrastComponent = contrast['/components/ui/MermaidDiagram.tsx'];
    expect(contrastComponent).toContain('theme: "base"');
    expect(contrastComponent).toContain('"lineColor":"#ffffff"');
    expect(contrast['mermaid.css']).toContain('#000000');
  });

  it('builds the artifact controls from the contrast palette', () => {
    const standard = getMermaidFiles('graph TD; a-->b', false, false)[
      '/components/ui/MermaidDiagram.tsx'
    ];
    expect(standard).toContain('rgba(0, 0, 0, 0.1)');

    const contrast = getMermaidFiles('graph TD; a-->b', false, true)[
      '/components/ui/MermaidDiagram.tsx'
    ];
    /** Fixed greys and 10%-alpha borders cannot clear the floors on a pure
     *  canvas, so none of them may survive into the contrast document. */
    expect(contrast).not.toContain('rgba(0, 0, 0, 0.1)');
    expect(contrast).not.toContain('#374151');
    expect(contrast).not.toContain('#6B7280');
    expect(contrast).toContain('2px solid #000000');
    expect(contrast).toContain('color: "#000000"');
  });

  it('maps Gantt tasks and labels to contrast-safe semantic colors', () => {
    const light = contrastMermaidVariables(false, true)!;
    expect(light).toMatchObject({
      taskBkgColor: '#0b4fa0',
      activeTaskBkgColor: '#8f3b00',
      doneTaskBkgColor: '#005c2e',
      doneTaskBorderColor: '#005c2e',
      critBkgColor: '#a10000',
      critBorderColor: '#a10000',
      gridColor: '#000000',
      taskTextColor: '#ffffff',
      taskTextDarkColor: '#ffffff',
      taskTextOutsideColor: '#000000',
    });

    const dark = contrastMermaidVariables(true, true)!;
    expect(dark).toMatchObject({
      taskBkgColor: '#6bb8ff',
      activeTaskBkgColor: '#ffb366',
      doneTaskBkgColor: '#7ff0b3',
      doneTaskBorderColor: '#7ff0b3',
      critBkgColor: '#ff8f8f',
      critBorderColor: '#ff8f8f',
      gridColor: '#ffffff',
      taskTextColor: '#000000',
      taskTextDarkColor: '#000000',
      taskTextOutsideColor: '#ffffff',
    });
  });

  /** Eight branch slots against a seven-slot ramp. The contract is that no two
   *  branches share a colour and none of them disappears into the canvas, which
   *  is exactly what wrapping the eighth slot back to the first would break. */
  it('gives every Git branch a distinct, visible colour', () => {
    for (const isDarkMode of [false, true]) {
      const vars = contrastMermaidVariables(isDarkMode, true)!;
      const branches = Array.from({ length: 8 }, (_, index) => vars[`git${index}`]);

      expect(new Set(branches).size).toBe(8);
      expect(branches).not.toContain(vars.background);
      /** The first seven are the palette's categorical ramp, the same one the
       *  pie slots draw from; the eighth falls back to the ink. */
      expect(branches.slice(0, 7)).toEqual(
        Array.from({ length: 7 }, (_, index) => vars[`pie${index + 1}`]),
      );
      expect(branches[7]).toBe(vars.textColor);
      /** Branch labels are drawn on the branch colour, not on the canvas, and
       *  the ramp sits on the far side of the canvas, so the canvas is the
       *  readable label here. */
      expect(Array.from({ length: 8 }, (_, index) => vars[`gitBranchLabel${index}`])).toEqual(
        Array(8).fill(vars.background),
      );
      expect(Array.from({ length: 8 }, (_, index) => vars[`gitInv${index}`])).toEqual(
        Array(8).fill(vars.textColor),
      );
      expect(vars).toMatchObject({
        commitLabelColor: vars.textColor,
        commitLabelBackground: vars.background,
        tagLabelColor: vars.textColor,
        tagLabelBackground: vars.background,
        tagLabelBorder: isDarkMode ? '#ffffff' : '#000000',
      });
    }
  });

  it('themes artifact render errors with the semantic destructive color', () => {
    const light = getMermaidFiles('invalid', false, true);
    const lightComponent = light['/components/ui/MermaidDiagram.tsx'];
    expect(lightComponent).toContain('class="mermaid-error"');
    expect(light['mermaid.css']).toContain('color: #a10000');

    const dark = getMermaidFiles('invalid', true, true);
    const darkComponent = dark['/components/ui/MermaidDiagram.tsx'];
    expect(darkComponent).toContain('class="mermaid-error"');
    expect(dark['mermaid.css']).toContain('color: #ff8f8f');
  });

  /** Every node fill is the canvas here, and mermaid derives `pie1..pie3` from
   *  the primary, secondary and tertiary colours, so without the series ramp a
   *  pie chart loses its encoding entirely. */
  it('keeps pie slices distinct from each other and the canvas', () => {
    for (const isDarkMode of [false, true]) {
      const vars = contrastMermaidVariables(isDarkMode, true)!;
      const slices = Array.from({ length: 12 }, (_, index) => vars[`pie${index + 1}`]);

      expect(slices.every(Boolean)).toBe(true);
      expect(slices.some((slice) => slice === vars.background)).toBe(false);
      /** Seven distinct slots, wrapping after that, so no neighbour repeats. */
      expect(new Set(slices).size).toBe(7);
      slices.slice(0, 6).forEach((slice, index) => {
        expect(slice).not.toBe(slices[index + 1]);
      });
    }
  });

  /** Slice labels sit on a series colour, and the ramp lives on the far side of
   *  the canvas so the slices are visible, so the canvas ink is the wrong ink
   *  for them. Title and legend are drawn on the canvas and keep it. */
  it('labels slices with the opposing ink and titles with the canvas ink', () => {
    const light = contrastMermaidVariables(false, true)!;
    expect(light.pieSectionTextColor).toBe('#ffffff');
    expect(light.pieTitleTextColor).toBe('#000000');
    expect(light.pieLegendTextColor).toBe('#000000');

    const dark = contrastMermaidVariables(true, true)!;
    expect(dark.pieSectionTextColor).toBe('#000000');
    expect(dark.pieTitleTextColor).toBe('#ffffff');
    expect(dark.pieLegendTextColor).toBe('#ffffff');
  });
});
