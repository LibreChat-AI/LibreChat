import { Feather } from 'lucide-react';
import { Sparkles } from '@librechat/client';
import { EModelEndpoint } from 'librechat-data-provider';

export function isEntityEndpoint(endpoint?: string | null): boolean {
  return (
    endpoint === EModelEndpoint.agents ||
    endpoint === EModelEndpoint.assistants ||
    endpoint === EModelEndpoint.azureAssistants
  );
}

export function EntityEndpointMark({
  endpoint,
  className = 'icon-md shrink-0',
}: {
  endpoint?: string | null;
  className?: string;
}) {
  if (endpoint === EModelEndpoint.agents) {
    return <Feather className={className} aria-hidden="true" />;
  }

  if (endpoint === EModelEndpoint.assistants || endpoint === EModelEndpoint.azureAssistants) {
    return <Sparkles className={className} aria-hidden="true" />;
  }

  return null;
}
