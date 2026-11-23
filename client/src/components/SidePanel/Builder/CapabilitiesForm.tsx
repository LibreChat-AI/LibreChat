import { useMemo } from 'react';
import { Capabilities } from 'librechat-data-provider';
import { useFormContext, useWatch } from 'react-hook-form';
import type { TConfig, AssistantsEndpoint } from 'librechat-data-provider';
import type { AssistantForm } from '~/common';
import ImageVision from './ImageVision';
import { useLocalize } from '~/hooks';
import Retrieval from './Retrieval';
import CodeFiles from './CodeFiles';
import Code from './Code';

export default function CapabilitiesForm({
  version,
  endpoint,
  codeEnabled,
  retrievalEnabled,
  assistantsConfig,
}: {
  version: number | string;
  codeEnabled?: boolean;
  retrievalEnabled?: boolean;
  endpoint: AssistantsEndpoint;
  assistantsConfig?: TConfig | null;
}) {
  const localize = useLocalize();

  const methods = useFormContext<AssistantForm>();
  const { control } = methods;
  const assistant = useWatch({ control, name: 'assistant' });
  const assistant_id = useWatch({ control, name: 'id' });
  const files = useMemo(() => {
    if (typeof assistant === 'string') {
      return [];
    }
    return assistant.code_files;
  }, [assistant]);

  const retrievalModels = useMemo(
    () => new Set(assistantsConfig?.retrievalModels ?? []),
    [assistantsConfig],
  );
  const imageVisionEnabled = useMemo(
    () => assistantsConfig?.capabilities?.includes(Capabilities.image_vision),
    [assistantsConfig],
  );

  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center">
        <span>
          <label className="text-text-primary block font-medium">
            {localize('com_assistants_capabilities')}
          </label>
        </span>
      </div>
      <div className="flex flex-col items-start gap-2">
        {codeEnabled && <Code version={version} />}
        {retrievalEnabled && (
          <Retrieval endpoint={endpoint} version={version} retrievalModels={retrievalModels} />
        )}
        {imageVisionEnabled && version == 1 && <ImageVision />}
        {codeEnabled && version && (
          <CodeFiles
            assistant_id={assistant_id}
            version={version}
            endpoint={endpoint}
            files={files}
          />
        )}
      </div>
    </div>
  );
}
