import dedent from 'dedent';
import DOMPurify from 'dompurify';
import { highContrastDarkTheme, highContrastLightTheme } from '@librechat/client';
import type { IThemeRGB } from '@librechat/client';

interface MermaidButtonStyles {
  bg: string;
  bgHover: string;
  border: string;
  text: string;
  textSecondary: string;
  shadow: string;
  divider: string;
}

const darkButtonStyles: MermaidButtonStyles = {
  bg: 'rgba(40, 40, 40, 0.95)',
  bgHover: 'rgba(60, 60, 60, 0.95)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  text: '#D1D5DB',
  textSecondary: '#9CA3AF',
  shadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
  divider: 'rgba(255, 255, 255, 0.1)',
};

const lightButtonStyles: MermaidButtonStyles = {
  bg: 'rgba(255, 255, 255, 0.95)',
  bgHover: 'rgba(243, 244, 246, 0.95)',
  border: '1px solid rgba(0, 0, 0, 0.1)',
  text: '#374151',
  textSecondary: '#6B7280',
  shadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
  divider: 'rgba(0, 0, 0, 0.1)',
};

/**
 * The standard control palettes hold fixed greys and 10%-alpha borders, which
 * leave the zoom label below AAA and the border and divider below the 3:1
 * non-text floor against a pure canvas, so a contrast mode builds its controls
 * from the same tokens the diagram uses.
 */
const contrastButtonStyles = (isDarkMode: boolean): MermaidButtonStyles => {
  const palette = isDarkMode ? highContrastDarkTheme : highContrastLightTheme;
  const canvas = tokenHex(palette['rgb-surface-primary'], isDarkMode ? '#000000' : '#ffffff');
  const ink = tokenHex(palette['rgb-text-primary'], isDarkMode ? '#ffffff' : '#000000');
  const active = tokenHex(palette['rgb-surface-active'], isDarkMode ? '#5c5c5c' : '#8c8c8c');

  return {
    bg: canvas,
    bgHover: active,
    border: `2px solid ${ink}`,
    text: ink,
    textSecondary: ink,
    shadow: 'none',
    divider: ink,
  };
};

const getButtonStyles = (isDarkMode: boolean, highContrast = false): MermaidButtonStyles => {
  if (highContrast) {
    return contrastButtonStyles(isDarkMode);
  }
  return isDarkMode ? darkButtonStyles : lightButtonStyles;
};

const baseFlowchartConfig = {
  curve: 'basis' as const,
  nodeSpacing: 50,
  rankSpacing: 50,
  diagramPadding: 8,
  useMaxWidth: true,
  padding: 15,
  wrappingWidth: 200,
};

/** Artifact renderer injects SVG directly into the DOM where foreignObject works */
const artifactFlowchartConfig = {
  ...baseFlowchartConfig,
  htmlLabels: true,
};

/** Inline renderer converts SVG to a blob URL <img>; browsers block foreignObject in that context */
const inlineFlowchartConfig = {
  ...baseFlowchartConfig,
  htmlLabels: false,
};

export { inlineFlowchartConfig, artifactFlowchartConfig };

const tokenHex = (triplet: string | undefined, fallback: string): string => {
  const channels = triplet?.trim().split(/\s+/).map(Number);
  if (channels?.length !== 3 || channels.some(Number.isNaN)) {
    return fallback;
  }
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
};

const seriesColors = (palette: IThemeRGB): string[] =>
  Array.from({ length: 7 }, (_, index) =>
    tokenHex(palette[`rgb-series-${index + 1}` as keyof IThemeRGB], '#000000'),
  );

/** Mermaid reads twelve pie slots; the palette ships seven, so they wrap. */
const seriesVariables = (slots: string[]): Record<string, string> => {
  return Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`pie${index + 1}`, slots[index % slots.length]]),
  );
};

/**
 * Mermaid keeps a Git branch palette (`git0`-`git7`) separate from the pie and
 * Gantt ones, so the base theme's bright green, yellow, cyan and white survive
 * into a contrast mode unless these slots are populated too.
 *
 * Eight slots against a seven-slot ramp. Wrapping would give branch 8 the same
 * colour as branch 1, which is the one thing a categorical scale must not do,
 * so the last slot takes the ink instead: 21:1 on the canvas and outside the
 * ramp, therefore distinct from all seven. `gitBranchLabel*` is the label drawn
 * ON the branch colour, so it takes the canvas rather than the ink — the ramp
 * lives on the far side of the canvas precisely so the branches are visible.
 */
const gitVariables = (slots: string[], canvas: string, ink: string): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      [`git${index}`, slots[index] ?? ink],
      [`gitBranchLabel${index}`, canvas],
      [`gitInv${index}`, ink],
    ]).flat(),
  );

/**
 * Mermaid's built-in `neutral` and `dark` themes carry their own palette, which
 * no app token can reach, so a diagram keeps mid-grey nodes and mid-grey edges
 * in a contrast mode. These variables put the diagram on the canvas with ink
 * nodes, ink edges and ink labels, which is 21:1 for every mark and every
 * label. Returns undefined outside the contrast modes so the standard themes
 * keep rendering exactly as they do today.
 */
export const contrastMermaidVariables = (
  isDarkMode: boolean,
  highContrast: boolean,
): Record<string, string> | undefined => {
  if (!highContrast) {
    return undefined;
  }

  const palette = isDarkMode ? highContrastDarkTheme : highContrastLightTheme;
  const canvas = tokenHex(palette['rgb-surface-primary'], isDarkMode ? '#000000' : '#ffffff');
  const ink = tokenHex(palette['rgb-text-primary'], isDarkMode ? '#ffffff' : '#000000');
  /** The label colour for anything drawn on a solid fill rather than the canvas. */
  const onFill = tokenHex(palette['rgb-text-on-status'], isDarkMode ? '#000000' : '#ffffff');
  const series = seriesColors(palette);
  const active = tokenHex(palette['rgb-surface-active'], ink);
  const successFill = tokenHex(palette['rgb-status-success-strong'], series[2]);
  const successBorder = tokenHex(palette['rgb-status-success-border'], successFill);
  const errorFill = tokenHex(palette['rgb-status-error-strong'], series[4]);
  const errorBorder = tokenHex(palette['rgb-status-error-border'], errorFill);
  const errorText = tokenHex(palette['rgb-text-destructive'], errorBorder);

  return {
    background: canvas,
    mainBkg: canvas,
    primaryColor: canvas,
    secondaryColor: canvas,
    tertiaryColor: canvas,
    clusterBkg: canvas,
    edgeLabelBackground: canvas,
    primaryTextColor: ink,
    secondaryTextColor: ink,
    tertiaryTextColor: ink,
    textColor: ink,
    titleColor: ink,
    primaryBorderColor: ink,
    secondaryBorderColor: ink,
    tertiaryBorderColor: ink,
    nodeBorder: ink,
    clusterBorder: ink,
    lineColor: ink,
    errorBkgColor: canvas,
    errorTextColor: errorText,
    sectionBkgColor: series[2],
    sectionBkgColor2: series[3],
    altSectionBkgColor: series[4],
    excludeBkgColor: active,
    taskBkgColor: series[0],
    taskBorderColor: series[0],
    activeTaskBkgColor: series[1],
    activeTaskBorderColor: series[1],
    doneTaskBkgColor: successFill,
    doneTaskBorderColor: successBorder,
    critBkgColor: errorFill,
    critBorderColor: errorBorder,
    todayLineColor: errorBorder,
    vertLineColor: errorBorder,
    gridColor: ink,
    taskTextColor: onFill,
    taskTextOutsideColor: ink,
    taskTextLightColor: onFill,
    taskTextDarkColor: onFill,
    taskTextClickableColor: onFill,
    /**
     * `pie1`..`pie12` otherwise derive from the primary, secondary and tertiary
     * colours, which are all the canvas here, so every slice would collapse
     * into the background and into its neighbours. The series scale is the
     * palette's own categorical ramp: seven slots that clear the 3:1 mark floor
     * on this canvas and stay separable under simulated deuteranopia. Slices
     * beyond the seventh wrap, which mermaid's own palettes do as well.
     */
    ...seriesVariables(series),
    ...gitVariables(series, canvas, ink),
    commitLabelColor: ink,
    commitLabelBackground: canvas,
    tagLabelColor: ink,
    tagLabelBackground: canvas,
    tagLabelBorder: tokenHex(palette['rgb-border-medium'], ink),
    pieStrokeColor: ink,
    pieOuterStrokeColor: ink,
    pieTitleTextColor: ink,
    /**
     * Labels drawn inside a slice sit on a series colour, not on the canvas, and
     * the series ramp deliberately lives on the far side of the canvas so the
     * slices are visible. So this one takes the opposing ink, the same
     * `text-on-status` the palette uses for a label on a solid fill. Title and
     * legend stay on the canvas ink, since they are drawn on the canvas.
     */
    pieSectionTextColor: onFill,
    pieLegendTextColor: ink,
  };
};

/** Perceived luminance (0 = black, 1 = white) via BT.601 luma coefficients */
const hexLuminance = (hex: string): number => {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  if (h.length < 6) {
    return -1;
  }
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

/**
 * Fixes subgraph title text contrast in mermaid SVGs rendered with htmlLabels: false.
 * When a subgraph has an explicit light fill via `style` directives, the title <text>
 * gets its fill from a CSS rule (.cluster-label text / .cluster text) set to titleColor.
 * In dark mode, titleColor is light, producing invisible text on light backgrounds.
 * This walks cluster groups and overrides the text fill attribute when contrast is poor.
 */
export const fixSubgraphTitleContrast = (svgElement: Element): void => {
  const clusters = svgElement.querySelectorAll('g.cluster');
  for (const cluster of clusters) {
    const rect = cluster.querySelector(':scope > rect, :scope > polygon');
    if (!rect) {
      continue;
    }

    const inlineStyle = rect.getAttribute('style') || '';
    const attrFill = rect.getAttribute('fill') || '';
    const styleFillMatch = inlineStyle.match(/fill\s*:\s*(#[0-9a-fA-F]{3,8})/);
    const hex = styleFillMatch?.[1] ?? (attrFill.startsWith('#') ? attrFill : '');
    if (!hex) {
      continue;
    }

    const bgLum = hexLuminance(hex);
    if (bgLum < 0) {
      continue;
    }

    const textElements = cluster.querySelectorAll(
      ':scope > g.cluster-label text, :scope > text, :scope > g > text',
    );
    for (const textEl of textElements) {
      const textFill = textEl.getAttribute('fill') || '';
      const textStyle = textEl.getAttribute('style') || '';
      const textStyleFill = textStyle.match(/fill\s*:\s*(#[0-9a-fA-F]{3,8})/);
      const currentHex = textStyleFill?.[1] ?? (textFill.startsWith('#') ? textFill : '');
      const isLightBg = bgLum > 0.5;

      let newFill = '';
      if (!currentHex) {
        if (isLightBg) {
          newFill = '#1a1a1a';
        }
      } else {
        const textLum = hexLuminance(currentHex);
        if (textLum < 0) {
          continue;
        }
        if (isLightBg && textLum > 0.5) {
          newFill = '#1a1a1a';
        } else if (!isLightBg && textLum < 0.4) {
          newFill = '#f0f0f0';
        }
      }

      if (newFill) {
        let sep = '';
        if (textStyle) {
          sep = textStyle.trimEnd().endsWith(';') ? ' ' : '; ';
        }
        textEl.setAttribute('style', `${textStyle}${sep}fill: ${newFill}`);
      }
    }
  }
};

const buildMermaidComponent = (
  mermaidTheme: string,
  bgColor: string,
  btnStyles: MermaidButtonStyles,
  themeVariables?: Record<string, string>,
) =>
  dedent(`import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  TransformWrapper,
  TransformComponent,
  ReactZoomPanPinchRef,
} from "react-zoom-pan-pinch";
import mermaid from "mermaid";

const ZoomInIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" x2="16.65" y1="21" y2="16.65"/>
    <line x1="11" x2="11" y1="8" y2="14"/>
    <line x1="8" x2="14" y1="11" y2="11"/>
  </svg>
);

const ZoomOutIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" x2="16.65" y1="21" y2="16.65"/>
    <line x1="8" x2="14" y1="11" y2="11"/>
  </svg>
);

const ResetIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 4v6h6"/>
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
  </svg>
);

const CopyIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
  </svg>
);

const CheckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const btnBase = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "28px",
  height: "28px",
  borderRadius: "4px",
  background: "transparent",
  border: "none",
  color: "${btnStyles.text}",
  cursor: "pointer",
  padding: "6px",
  transition: "background 0.15s ease",
};

const btnHover = {
  ...btnBase,
  background: "${btnStyles.bgHover}",
};

const toolbarStyle = {
  position: "absolute",
  bottom: "12px",
  right: "12px",
  display: "flex",
  alignItems: "center",
  gap: "2px",
  padding: "4px",
  borderRadius: "8px",
  background: "${btnStyles.bg}",
  boxShadow: "${btnStyles.shadow}",
  backdropFilter: "blur(8px)",
  border: "${btnStyles.border}",
  zIndex: 10,
};

const dividerStyle = {
  width: "1px",
  height: "16px",
  background: "${btnStyles.divider}",
  margin: "0 4px",
};

const zoomTextStyle = {
  minWidth: "3rem",
  textAlign: "center",
  fontSize: "12px",
  color: "${btnStyles.textSecondary}",
  userSelect: "none",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

interface MermaidDiagramProps {
  content: string;
}

interface IconButtonProps {
  onClick: () => void;
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
}

const IconButton = ({ onClick, children, title, disabled = false }: IconButtonProps) => {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      style={{
        ...(hovered && !disabled ? btnHover : btnBase),
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  );
};

const ZOOM_STEP = 0.1;
const MIN_SCALE = 0.1;
const MAX_SCALE = 10;

const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ content }) => {
  const mermaidRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const [isRendered, setIsRendered] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "${mermaidTheme}",
      ${themeVariables ? `themeVariables: ${JSON.stringify(themeVariables)},` : ''}
      securityLevel: "strict",
      flowchart: ${JSON.stringify(artifactFlowchartConfig, null, 8)},
    });

    const renderDiagram = async () => {
      if (!mermaidRef.current) {
        return;
      }
      try {
        const { svg } = await mermaid.render("mermaid-diagram", content);
        mermaidRef.current.innerHTML = svg;

        const svgElement = mermaidRef.current.querySelector("svg");
        if (svgElement) {
          svgElement.style.width = "100%";
          svgElement.style.height = "100%";
        }
        setIsRendered(true);
      } catch (error) {
        console.error("Mermaid rendering error:", error);
        if (mermaidRef.current) {
          mermaidRef.current.innerHTML = '<p class="mermaid-error">Error rendering diagram</p>';
        }
      }
    };

    renderDiagram();
  }, [content]);

  const centerAndFitDiagram = useCallback(() => {
    if (transformRef.current && mermaidRef.current) {
      const { centerView, zoomToElement } = transformRef.current;
      zoomToElement(mermaidRef.current);
      centerView(1, 0);
      setZoomLevel(100);
    }
  }, []);

  useEffect(() => {
    if (isRendered) {
      centerAndFitDiagram();
    }
  }, [isRendered, centerAndFitDiagram]);

  const handleTransform = useCallback((ref) => {
    if (ref && ref.state) {
      setZoomLevel(Math.round(ref.state.scale * 100));
    }
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [content]);

  const handlePanning = useCallback(() => {
    if (!transformRef.current) {
      return;
    }
    const { state, instance } = transformRef.current;
    if (!state) {
      return;
    }
    const { scale, positionX, positionY } = state;
    const { wrapperComponent, contentComponent } = instance;

    if (!wrapperComponent || !contentComponent) {
      return;
    }

    const wrapperRect = wrapperComponent.getBoundingClientRect();
    const contentRect = contentComponent.getBoundingClientRect();
    const maxX = wrapperRect.width - contentRect.width * scale;
    const maxY = wrapperRect.height - contentRect.height * scale;

    let newX = positionX;
    let newY = positionY;

    if (newX > 0) {
      newX = 0;
    }
    if (newY > 0) {
      newY = 0;
    }
    if (newX < maxX) {
      newX = maxX;
    }
    if (newY < maxY) {
      newY = maxY;
    }

    if (newX !== positionX || newY !== positionY) {
      instance.setTransformState(scale, newX, newY);
    }
  }, []);

  return (
    <div style={{ position: "relative", height: "100vh", width: "100vw", cursor: "move", padding: "20px", backgroundColor: "${bgColor}" }}>
      <TransformWrapper
        ref={transformRef}
        initialScale={1}
        minScale={MIN_SCALE}
        maxScale={MAX_SCALE}
        limitToBounds={false}
        centerOnInit={true}
        initialPositionY={0}
        wheel={{ step: ZOOM_STEP }}
        panning={{ velocityDisabled: true }}
        alignmentAnimation={{ disabled: true }}
        onPanning={handlePanning}
        onTransformed={handleTransform}
      >
        {({ zoomIn, zoomOut }) => (
          <>
            <TransformComponent
              wrapperStyle={{
                width: "100%",
                height: "100%",
                overflow: "hidden",
              }}
            >
              <div
                ref={mermaidRef}
                style={{
                  width: "auto",
                  height: "auto",
                  minWidth: "100%",
                  minHeight: "100%",
                }}
              />
            </TransformComponent>
            <div style={toolbarStyle}>
              <IconButton onClick={() => zoomOut(ZOOM_STEP)} title="Zoom out">
                <ZoomOutIcon />
              </IconButton>
              <span style={zoomTextStyle}>{zoomLevel}%</span>
              <IconButton onClick={() => zoomIn(ZOOM_STEP)} title="Zoom in">
                <ZoomInIcon />
              </IconButton>
              <div style={dividerStyle} />
              <IconButton onClick={centerAndFitDiagram} title="Reset view">
                <ResetIcon />
              </IconButton>
              <div style={dividerStyle} />
              <IconButton onClick={handleCopy} title="Copy code">
                {copied ? <CheckIcon /> : <CopyIcon />}
              </IconButton>
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
};

export default MermaidDiagram;`);

const wrapMermaidDiagram = (content: string) => {
  const serializedContent = JSON.stringify(content);
  return dedent(`import React from 'react';
import MermaidDiagram from '/components/ui/MermaidDiagram';

const App = () => (
  <MermaidDiagram content={${serializedContent}} />
);

export default App;
`);
};

export const getMermaidFiles = (content: string, isDarkMode = true, highContrast = false) => {
  const themeVariables = contrastMermaidVariables(isDarkMode, highContrast);
  const standardTheme = isDarkMode ? 'dark' : 'neutral';
  /** `base` is the only built-in mermaid theme that honours themeVariables. */
  const mermaidTheme = themeVariables ? 'base' : standardTheme;
  const btnStyles = getButtonStyles(isDarkMode, highContrast);
  const bgColor = themeVariables?.background ?? (isDarkMode ? '#212121' : '#FFFFFF');
  const errorTextColor = themeVariables?.errorTextColor ?? btnStyles.text;
  const mermaidCSS = `
body {
  background-color: ${bgColor};
}
.mermaid-error {
  color: ${errorTextColor};
}
`;

  return {
    'diagram.mmd': content || '# No mermaid diagram content provided',
    'App.tsx': wrapMermaidDiagram(content),
    'index.tsx': dedent(`import React, { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./mermaid.css";

import App from "./App";

const root = createRoot(document.getElementById("root"));
root.render(<App />);
;`),
    '/components/ui/MermaidDiagram.tsx': buildMermaidComponent(
      mermaidTheme,
      bgColor,
      btnStyles,
      themeVariables,
    ),
    'mermaid.css': mermaidCSS,
  };
};

/** Sanitize mermaid SVG and serialize as XML, preserving foreignObject HTML (cure53/DOMPurify#1002). */
export const sanitizeMermaidSvg = (svg: string): string =>
  new XMLSerializer().serializeToString(
    DOMPurify().sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: ['foreignObject', 'use', 'switch'],
      ADD_ATTR: [
        'dominant-baseline',
        'text-anchor',
        'requiredFeatures',
        'systemLanguage',
        'xmlns:xlink',
      ],
      HTML_INTEGRATION_POINTS: { foreignobject: true },
      RETURN_DOM_FRAGMENT: true,
    }),
  );
