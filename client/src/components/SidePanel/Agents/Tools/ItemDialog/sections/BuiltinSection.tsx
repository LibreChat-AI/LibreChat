import { useId } from 'react';
import { Bot, Layers } from 'lucide-react';
import { Radio, ChoiceCards } from '@librechat/client';
import { useFormContext, useWatch } from 'react-hook-form';
import { Tools, MemoryScope, ArtifactModes, AgentCapabilities } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import type { AgentForm, ExtendedFile } from '~/common';
import type { BuiltinId } from '../../items/types';
import OrchestrationHub from '../../../Advanced/OrchestrationHub';
import { useVerifyAgentToolAuth } from '~/data-provider';
import CodeBackground from '../../../Code/Background';
import CodeSettings from '../../../Code/Settings';
import SearchAction from '../../../Search/Action';
import FileContext from '../../../FileContext';
import FileSearch from '../../../FileSearch';
import CodeFiles from '../../../Code/Files';
import { useLocalize } from '~/hooks';

interface Props {
  builtinId: BuiltinId;
  agentId: string;
  contextFiles: Array<[string, ExtendedFile]>;
  knowledgeFiles: Array<[string, ExtendedFile]>;
  codeFiles: Array<[string, ExtendedFile]>;
  description?: string;
}

const ARTIFACTS_CUSTOM_DOCS_URL =
  'https://www.librechat.ai/docs/features/artifacts#custom-instructions';

const ARTIFACT_MODES: Array<{
  value: string;
  labelKey: TranslationKeys;
  infoKey?: TranslationKeys;
  docs?: { url: string; labelKey: TranslationKeys };
}> = [
  {
    value: ArtifactModes.DEFAULT,
    labelKey: 'com_ui_artifacts_mode_default',
    infoKey: 'com_ui_artifacts_mode_default_info',
  },
  {
    value: ArtifactModes.SHADCNUI,
    labelKey: 'com_ui_artifacts_mode_shadcn',
    infoKey: 'com_ui_artifacts_mode_shadcn_info',
  },
  {
    value: ArtifactModes.CUSTOM,
    labelKey: 'com_ui_artifacts_mode_custom',
    infoKey: 'com_ui_artifacts_mode_custom_info',
    docs: { url: ARTIFACTS_CUSTOM_DOCS_URL, labelKey: 'com_ui_artifacts_mode_custom_docs' },
  },
];

interface ArtifactsConfigProps {
  value: string;
  onChange: (next: string) => void;
}

function ArtifactsConfig({ value, onChange }: ArtifactsConfigProps) {
  const localize = useLocalize();
  const options = ARTIFACT_MODES.map((mode) => ({
    value: mode.value,
    label: localize(mode.labelKey),
  }));
  const active = ARTIFACT_MODES.find((mode) => mode.value === value);

  return (
    <div className="flex flex-col gap-3">
      <span id="artifacts-mode-label" className="text-text-primary text-sm font-medium">
        {localize('com_ui_artifacts_mode')}
      </span>
      <Radio
        options={options}
        value={value}
        onChange={onChange}
        fullWidth
        aria-labelledby="artifacts-mode-label"
      />
      {active?.infoKey ? (
        <p className="text-text-secondary text-sm leading-relaxed">
          {localize(active.infoKey)}
          {active.docs ? (
            <>
              {' '}
              <a
                href={active.docs.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={localize(active.docs.labelKey)}
                className="text-link hover:text-link-hover underline"
              >
                {localize('com_ui_learn_more')}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

interface MemoryConfigProps {
  value: string;
  onChange: (next: MemoryScope) => void;
}

function MemoryConfig({ value, onChange }: MemoryConfigProps) {
  const localize = useLocalize();
  const titleId = useId();

  return (
    <div className="flex flex-col gap-3">
      <h3 id={titleId} className="text-text-primary text-sm font-medium">
        {localize('com_agents_memory_scope_title')}
      </h3>
      <ChoiceCards
        aria-labelledby={titleId}
        value={value === MemoryScope.agent ? MemoryScope.agent : MemoryScope.user}
        onChange={(next) => onChange(next as MemoryScope)}
        options={[
          {
            value: MemoryScope.user,
            label: localize('com_agents_memory_scope_shared'),
            description: localize('com_agents_memory_scope_shared_info'),
            icon: <Layers className="size-5" strokeWidth={1.5} />,
          },
          {
            value: MemoryScope.agent,
            label: localize('com_agents_memory_scope_agent'),
            description: localize('com_agents_memory_scope_info'),
            icon: <Bot className="size-5" strokeWidth={1.5} />,
          },
        ]}
      />
    </div>
  );
}

function WebSearchConfig() {
  const { data } = useVerifyAgentToolAuth({ toolId: Tools.web_search }, { retry: 1 });
  return (
    <SearchAction
      authTypes={data?.authTypes}
      isToolAuthenticated={data?.authenticated}
      searchProvider={data?.searchProvider}
      scraperProvider={data?.scraperProvider}
      rerankerType={data?.rerankerType}
    />
  );
}

export default function BuiltinSection({
  builtinId,
  agentId,
  contextFiles,
  knowledgeFiles,
  codeFiles,
  description,
}: Props) {
  const localize = useLocalize();
  const { control, setValue } = useFormContext<AgentForm>();

  const artifactsValue = (useWatch({ control, name: AgentCapabilities.artifacts }) ?? '') as string;
  const memoryScope = (useWatch({ control, name: 'memory_scope' }) ?? MemoryScope.user) as string;

  let body: React.ReactNode = null;

  if (builtinId === 'subagents' || builtinId === 'handoffs') {
    body = <OrchestrationHub currentAgentId={agentId} tool={builtinId} />;
  } else if (builtinId === 'execute_code') {
    body = (
      <div className="flex flex-col gap-4">
        <CodeSettings />
        <CodeBackground />
        <CodeFiles agent_id={agentId} files={codeFiles} />
      </div>
    );
  } else if (builtinId === 'web_search') {
    body = <WebSearchConfig />;
  } else if (builtinId === 'file_search') {
    body = <FileSearch agent_id={agentId} files={knowledgeFiles} showHeader={false} />;
  } else if (builtinId === 'artifacts') {
    body = (
      <ArtifactsConfig
        value={artifactsValue}
        onChange={(next) => setValue(AgentCapabilities.artifacts, next, { shouldDirty: true })}
      />
    );
  } else if (builtinId === 'context') {
    body = <FileContext agent_id={agentId} files={contextFiles} showHeader={false} />;
  } else if (builtinId === 'memory') {
    body = (
      <MemoryConfig
        value={memoryScope}
        onChange={(next) => setValue('memory_scope', next, { shouldDirty: true })}
      />
    );
  }

  const localizedDescription =
    description && builtinId !== 'subagents' && builtinId !== 'handoffs'
      ? localize(description as TranslationKeys)
      : '';

  return (
    <div className="flex flex-col gap-5">
      {localizedDescription && (
        <p className="text-text-secondary text-sm leading-relaxed">{localizedDescription}</p>
      )}
      {body}
    </div>
  );
}
