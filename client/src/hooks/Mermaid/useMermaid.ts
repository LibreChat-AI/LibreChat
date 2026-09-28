import { useContext, useMemo, useState } from 'react';
import useSWR from 'swr';
import { Md5 } from 'ts-md5';
import { ThemeContext } from '@librechat/client';
import type { MermaidConfig } from 'mermaid';
import {
  contrastMermaidVariables,
  inlineFlowchartConfig,
  sanitizeMermaidSvg,
} from '~/utils/mermaid';

// Constants
const MD5_LENGTH_THRESHOLD = 10_000;
const DEFAULT_ID_PREFIX = 'mermaid-diagram';

// Lazy load mermaid library (~2MB)
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

const loadMermaid = () => {
  if (typeof window === 'undefined') {
    return Promise.resolve(null);
  }

  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default);
  }

  return mermaidPromise;
};

interface UseMermaidOptions {
  /** Mermaid diagram content */
  content: string;
  /** Unique identifier for this diagram */
  id?: string;
  /** Custom mermaid theme */
  theme?: string;
  /** Custom mermaid configuration */
  config?: Partial<MermaidConfig>;
  /** Whether rendering should run */
  enabled?: boolean;
}

interface UseMermaidReturn {
  /** The rendered SVG string */
  svg: string | undefined;
  /** Loading state */
  isLoading: boolean;
  /** Error object if rendering failed */
  error: Error | undefined;
  /** Whether content is being validated */
  isValidating: boolean;
}

export const useMermaid = ({
  content,
  id = DEFAULT_ID_PREFIX,
  theme: customTheme,
  config,
  enabled = true,
}: UseMermaidOptions): UseMermaidReturn => {
  /** Read from context rather than derived here: under `system` both the scheme
   *  and the contrast come from media queries, so deriving either locally would
   *  keep whatever this hook computed on its last render. */
  const { resolvedMode, highContrast } = useContext(ThemeContext);
  const isDarkMode = resolvedMode === 'dark';

  // Store last valid SVG for fallback on errors
  const [validContent, setValidContent] = useState<string>('');

  // Generate cache key based on content, theme, and ID
  const cacheKey = useMemo((): string | null => {
    if (!enabled) {
      return null;
    }

    // For large diagrams, use MD5 hash instead of full content
    const contentHash = content.length < MD5_LENGTH_THRESHOLD ? content : Md5.hashStr(content);

    /** Scheme and contrast belong in the key even when a custom theme is set:
     *  `mermaidConfig` still rebuilds `themeVariables` per appearance, so a
     *  key that stopped at `customTheme` would replay the stale SVG. */
    const appearanceKey = `${isDarkMode ? 'd' : 'l'}${highContrast ? 'h' : ''}`;

    return [id, customTheme, appearanceKey, contentHash].filter(Boolean).join('-');
  }, [content, enabled, id, isDarkMode, highContrast, customTheme]);

  // Generate unique diagram ID (mermaid requires unique IDs in the DOM)
  // Include cacheKey to regenerate when content/theme changes, preventing mermaid internal conflicts
  const diagramId = useMemo(() => {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${id}-${timestamp}-${random}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cacheKey]);

  // Build mermaid configuration
  const mermaidConfig = useMemo((): MermaidConfig => {
    const defaultTheme = isDarkMode ? 'dark' : 'neutral';
    const themeVariables = contrastMermaidVariables(isDarkMode, highContrast);

    return {
      startOnLoad: false,
      theme: (customTheme as MermaidConfig['theme']) || defaultTheme,
      ...config,
      flowchart: { ...inlineFlowchartConfig, ...config?.flowchart, htmlLabels: false },
      /** A contrast mode is an accessibility need rather than a caller
       *  preference, and mermaid honours `themeVariables` only under `base`, so
       *  both MUST come after the `config` spread and outrank `customTheme`.
       *  Otherwise the diagram keeps a built-in palette no token can reach. */
      ...(themeVariables ? { theme: 'base' as const, themeVariables } : {}),
      // Security hardening: MUST come after ...config spread to prevent override
      securityLevel: 'strict',
      maxTextSize: config?.maxTextSize ?? 50000,
      maxEdges: config?.maxEdges ?? 500,
    };
  }, [customTheme, isDarkMode, highContrast, config]);

  // Fetch/render function
  const fetchSvg = async (): Promise<string> => {
    // SSR guard
    if (typeof window === 'undefined') {
      return '';
    }

    try {
      // Load mermaid library (cached after first load)
      const mermaidInstance = await loadMermaid();

      if (!mermaidInstance) {
        throw new Error('Failed to load mermaid library');
      }

      // Validate syntax first and capture detailed error
      try {
        await mermaidInstance.parse(content);
      } catch (parseError) {
        // Extract meaningful error message from mermaid's parse error
        let errorMessage = 'Invalid mermaid syntax';
        if (parseError instanceof Error) {
          errorMessage = parseError.message;
        } else if (typeof parseError === 'string') {
          errorMessage = parseError;
        }

        throw new Error(errorMessage);
      }

      // Initialize with config
      mermaidInstance.initialize(mermaidConfig);

      // Render to SVG
      const { svg } = await mermaidInstance.render(diagramId, content);

      const sanitizedSvg = sanitizeMermaidSvg(svg);

      // Store as last valid content
      setValidContent(sanitizedSvg);

      return sanitizedSvg;
    } catch (error) {
      console.error('Mermaid rendering error:', error);

      // Return last valid content if available (graceful degradation)
      if (validContent) {
        return validContent;
      }

      throw error;
    }
  };

  // Use SWR for caching and revalidation
  const { data, error, isLoading, isValidating } = useSWR<string, Error>(cacheKey, fetchSvg, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    dedupingInterval: 3000,
    errorRetryCount: 2,
    errorRetryInterval: 1000,
    shouldRetryOnError: true,
  });

  return {
    svg: data,
    isLoading,
    error,
    isValidating,
  };
};

export default useMermaid;
