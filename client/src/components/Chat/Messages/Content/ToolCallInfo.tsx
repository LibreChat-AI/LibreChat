import { useState, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { useLocalize, useExpandCollapse } from '~/hooks';
import { OutputRenderer } from './ToolOutput';
import { cn } from '~/utils';

function isSimpleObject(obj: unknown): obj is Record<string, string | number | boolean | null> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return false;
  }
  const entries = Object.entries(obj);
  if (entries.length === 0 || entries.length > 8) {
    return false;
  }
  return entries.every(
    ([, v]) =>
      v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
  );
}

function KeyValueInput({ data }: { data: Record<string, string | number | boolean | null> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-1.5">
          <span className="text-text-secondary font-medium">{key}</span>
          <span className="bg-surface-tertiary text-text-primary rounded px-1.5 py-0.5">
            {String(value ?? 'null')}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatParamValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.length > 200 ? value.slice(0, 200) + '...' : value;
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  const str = JSON.stringify(value);
  return str.length > 200 ? str.slice(0, 200) + '...' : str;
}

function ComplexInput({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {Object.entries(data).map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-1.5">
          <span className="text-text-secondary font-medium">{key}</span>
          <span className="bg-surface-tertiary text-text-primary max-w-[300px] truncate overflow-hidden rounded px-1.5 py-0.5 font-mono">
            {formatParamValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function InputRenderer({ input }: { input: string }) {
  if (!input || input.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(input);
    if (isSimpleObject(parsed)) {
      return <KeyValueInput data={parsed} />;
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return <ComplexInput data={parsed as Record<string, unknown>} />;
    }
    // Valid JSON but not a plain object (array, string, number, boolean) — render formatted
    return (
      <pre className="text-text-primary text-xs whitespace-pre-wrap">
        {typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)}
      </pre>
    );
  } catch {
    // Not JSON — render as plain text
    return <pre className="text-text-primary text-xs whitespace-pre-wrap">{input}</pre>;
  }
}

export default function ToolCallInfo({ input, output }: { input: string; output?: string | null }) {
  const localize = useLocalize();
  const [showParams, setShowParams] = useState(false);
  const { style: paramsExpandStyle, ref: paramsExpandRef } = useExpandCollapse(showParams);

  const hasParams = useMemo(() => {
    if (!input || input.trim().length === 0) {
      return false;
    }
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed === 'object' && parsed !== null) {
        return Object.keys(parsed).length > 0;
      }
    } catch {
      // Not JSON
    }
    return input.trim().length > 0;
  }, [input]);

  return (
    <div className="w-full px-3 py-3.5">
      {output && <OutputRenderer text={output} />}
      {output && hasParams && <div className="border-border-light my-2 border-t" />}
      {hasParams && (
        <>
          <button
            type="button"
            className={cn(
              'text-text-secondary inline-flex items-center gap-1 text-xs',
              'focus-visible:ring-border-heavy focus-visible:ring-2 focus-visible:outline-hidden',
            )}
            onClick={() => setShowParams((prev) => !prev)}
            aria-expanded={showParams}
          >
            <span>{localize('com_ui_parameters')}</span>
            <ChevronDown
              className={cn(
                'size-3 shrink-0 transition-transform duration-200 ease-out',
                showParams && 'rotate-180',
              )}
              aria-hidden="true"
            />
          </button>
          <div style={paramsExpandStyle}>
            <div className="overflow-hidden pt-1" ref={paramsExpandRef}>
              <InputRenderer input={input} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
