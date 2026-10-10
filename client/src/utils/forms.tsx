import { EarthIcon } from 'lucide-react';
import {
  FileSources,
  alternateName,
  EModelEndpoint,
  EToolResources,
  defaultAgentFormValues,
} from 'librechat-data-provider';
import type { Agent, TFile, StatefulCodeEnvironment } from 'librechat-data-provider';
import type { DropdownValueSetter, TAgentOption, ExtendedFile } from '~/common';

/**
 * Creates a Dropdown value setter that always passes a string value,
 * for when options (object with label/value fields) are used for the
 * available values, and a string value is expected when selected.
 *
 * Only necessary when the available values are objects with label/value fields
 * and the selected value is expected to be a string.
 **/
export const createDropdownSetter = (setValue: (value: string) => void): DropdownValueSetter => {
  return (value) => {
    if (!value) {
      setValue('');
      return;
    }

    if (typeof value === 'string') {
      setValue(value);
      return;
    }

    if (value.value) {
      setValue(value.value + '');
    }
  };
};

/**
 * Creates an Option object for a provider dropdown.
 **/
export const createProviderOption = (provider: string) => ({
  label: (alternateName[provider] as string | undefined) ?? provider,
  value: provider,
});

/** Gets default agent form values. */
export const getDefaultAgentFormValues = (
  statefulCodeEnvironment: StatefulCodeEnvironment = 'user',
) => ({
  ...defaultAgentFormValues,
  stateful_code_environment: statefulCodeEnvironment,
  avatar_file: null,
  avatar_preview: '',
  avatar_action: null,
  conversation_starter_draft: '',
  instructionsSource: 'inline' as const,
  instructionsPrompt: null,
});

export const processAgentOption = ({
  agent: _agent,
  fileMap,
}: {
  agent?: Agent;
  fileMap?: Record<string, TFile | undefined>;
}): TAgentOption => {
  const isGlobal = _agent?.isPublic ?? false;

  const context_files = _agent?.tool_resources?.context?.file_ids ?? [];
  if (_agent?.tool_resources?.ocr?.file_ids) {
    /** Backwards-compatibility */
    context_files.push(..._agent.tool_resources.ocr.file_ids);
  }

  const agent: TAgentOption = {
    ...(_agent ?? ({} as Agent)),
    label: _agent?.name ?? '',
    value: _agent?.id ?? '',
    icon: isGlobal ? <EarthIcon className="icon-md text-status-success" /> : null,
    context_files: context_files.length > 0 ? ([] as Array<[string, ExtendedFile]>) : undefined,
    knowledge_files: _agent?.tool_resources?.file_search?.file_ids
      ? ([] as Array<[string, ExtendedFile]>)
      : undefined,
    code_files: _agent?.tool_resources?.execute_code?.file_ids
      ? ([] as Array<[string, ExtendedFile]>)
      : undefined,
  };

  if (!fileMap) {
    return agent;
  }

  const handleFile = ({
    file_id,
    tool_resource,
    list,
  }: {
    file_id: string;
    tool_resource: EToolResources;
    list?: Array<[string, ExtendedFile]>;
  }) => {
    const file = fileMap[file_id];
    const source =
      tool_resource === EToolResources.file_search
        ? FileSources.vectordb
        : (file?.source ?? FileSources.local);

    if (file) {
      list?.push([
        file_id,
        {
          file_id: file.file_id,
          type: file.type,
          filepath: file.filepath,
          filename: file.filename,
          width: file.width,
          height: file.height,
          size: file.bytes,
          preview: file.filepath,
          metadata: file.metadata,
          progress: 1,
          source,
        },
      ]);
    } else {
      list?.push([
        file_id,
        {
          file_id,
          type: '',
          filename: '',
          size: 1,
          progress: 1,
          filepath: EModelEndpoint.agents,
          source,
        },
      ]);
    }
  };

  if (agent.context_files && context_files.length > 0) {
    context_files.forEach((file_id) =>
      handleFile({
        file_id,
        list: agent.context_files,
        tool_resource: EToolResources.context,
      }),
    );
  }

  if (agent.knowledge_files && _agent?.tool_resources?.file_search?.file_ids) {
    _agent.tool_resources.file_search.file_ids.forEach((file_id) =>
      handleFile({
        file_id,
        list: agent.knowledge_files,
        tool_resource: EToolResources.file_search,
      }),
    );
  }

  if (agent.code_files && _agent?.tool_resources?.execute_code?.file_ids) {
    _agent.tool_resources.execute_code.file_ids.forEach((file_id) =>
      handleFile({ file_id, list: agent.code_files, tool_resource: EToolResources.execute_code }),
    );
  }

  return agent;
};
