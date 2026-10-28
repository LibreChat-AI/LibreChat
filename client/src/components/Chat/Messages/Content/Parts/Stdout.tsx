import { useMemo } from 'react';

interface StdoutProps {
  output?: string;
}

export default function Stdout({ output = '' }: StdoutProps) {
  const processedContent = useMemo(() => {
    if (!output) {
      return '';
    }
    const parts = output.split('Generated files:');
    return parts[0].trim();
  }, [output]);

  if (!processedContent) {
    return null;
  }

  return (
    <pre dir="ltr" className="text-text-primary shrink-0 font-mono break-words whitespace-pre-wrap">
      {processedContent}
    </pre>
  );
}
