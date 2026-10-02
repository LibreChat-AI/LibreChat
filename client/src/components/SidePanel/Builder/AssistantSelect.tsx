import { useMemo, useCallback, useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { SelectDropDown } from '@librechat/client';
import {
  Tools,
  FileSources,
  Capabilities,
  EModelEndpoint,
  isImageVisionTool,
  defaultAssistantFormValues,
} from 'librechat-data-provider';
import type {
  TPlugin,
  Assistant,
  AssistantDocument,
  AssistantsEndpoint,
  AssistantCreateParams,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type { UseFormReset } from 'react-hook-form';
import type { Actions, ExtendedFile, AssistantForm, TAssistantOption } from '~/common';
import { useListAssistantsQuery } from '~/data-provider';
import { cn, createDropdownSetter } from '~/utils';
import { useFileMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';

const keys = new Set([
  'name',
  'id',
  'description',
  'instructions',
  'conversation_starters',
  'model',
  'append_current_datetime',
]);

export default function AssistantSelect({
  reset,
  value,
  endpoint,
  documentsMap,
  selectedAssistant,
  setCurrentAssistantId,
  createMutation,
  allTools,
}: {
  reset: UseFormReset<AssistantForm>;
  value: TAssistantOption;
  endpoint: AssistantsEndpoint;
  selectedAssistant: string | null;
  documentsMap: Map<string, AssistantDocument> | null;
  setCurrentAssistantId: React.Dispatch<React.SetStateAction<string | undefined>>;
  createMutation: UseMutationResult<Assistant, Error, AssistantCreateParams>;
  allTools?: TPlugin[];
}) {
  const localize = useLocalize();
  const fileMap = useFileMapContext();
  const lastSelectedAssistant = useRef<string | null>(null);

  const toolkits = useMemo(
    () => new Set(allTools?.filter((tool) => tool.toolkit === true).map((tool) => tool.pluginKey)),
    [allTools],
  );

  const query = useListAssistantsQuery(endpoint, undefined, {
    select: (res) =>
      res.data.map((_assistant) => {
        const source =
          endpoint === EModelEndpoint.assistants ? FileSources.openai : FileSources.azure;
        const assistant: TAssistantOption = {
          ..._assistant,
          label: _assistant.name ?? '',
          value: _assistant.id,
          files: _assistant.file_ids ? ([] as Array<[string, ExtendedFile]>) : undefined,
          code_files: _assistant.tool_resources?.code_interpreter?.file_ids
            ? ([] as Array<[string, ExtendedFile]>)
            : undefined,
        };

        const handleFile = (file_id: string, list?: Array<[string, ExtendedFile]>) => {
          const file = fileMap?.[file_id];
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
                filepath: endpoint,
                source,
              },
            ]);
          }
        };

        if (assistant.files && _assistant.file_ids) {
          _assistant.file_ids.forEach((file_id) => handleFile(file_id, assistant.files));
        }

        if (assistant.code_files && _assistant.tool_resources?.code_interpreter?.file_ids) {
          _assistant.tool_resources.code_interpreter.file_ids.forEach((file_id) =>
            handleFile(file_id, assistant.code_files),
          );
        }

        const assistantDoc = documentsMap?.get(_assistant.id);
        /* If no user updates, use the latest assistant docs */
        if (assistantDoc) {
          if (!assistant.conversation_starters) {
            assistant.conversation_starters = assistantDoc.conversation_starters;
          }
          assistant.append_current_datetime = assistantDoc.append_current_datetime ?? false;
        }

        return assistant;
      }),
  });

  const onSelect = useCallback(
    (value: string) => {
      const assistant = query.data?.find((assistant) => assistant.id === value);

      createMutation.reset();
      if (!assistant) {
        setCurrentAssistantId(undefined);
        return reset(defaultAssistantFormValues);
      }

      const update = {
        ...assistant,
        label: assistant.name ?? '',
        value: assistant.id || '',
      };

      const actions: Actions = {
        [Capabilities.code_interpreter]: false,
        [Capabilities.image_vision]: false,
        [Capabilities.retrieval]: false,
      };

      (assistant.tools ?? [])
        .filter((tool) => tool.type !== 'function' || isImageVisionTool(tool))
        .map((tool) => (tool.function?.name ?? '') || tool.type)
        .forEach((tool) => {
          if (tool === Tools.file_search) {
            actions[Capabilities.retrieval] = true;
          }
          actions[tool] = true;
        });

      const seenToolkits = new Set<string>();
      const functions = (assistant.tools ?? [])
        .filter((tool) => tool.type === 'function' && !isImageVisionTool(tool))
        .map((tool) => tool.function?.name ?? '')
        .filter((fnName) => {
          const fnPrefix = fnName.split('_')[0];
          const seenToolkit = toolkits.has(fnPrefix);
          if (seenToolkit) {
            seenToolkits.add(fnPrefix);
          }
          return !seenToolkit;
        });

      if (seenToolkits.size > 0) {
        functions.push(...Array.from(seenToolkits));
      }

      const formValues: Partial<AssistantForm & Actions> = {
        functions,
        ...actions,
        assistant: update,
        model: update.model,
      };

      Object.entries(assistant).forEach(([name, value]) => {
        if (!keys.has(name)) {
          return;
        }

        if (name === 'append_current_datetime') {
          formValues[name] = !!value;
          return;
        }

        if (
          name === 'conversation_starters' &&
          Array.isArray(value) &&
          value.every((item) => typeof item === 'string')
        ) {
          formValues[name] = value;
          return;
        }

        if (typeof value !== 'number' && typeof value !== 'object') {
          formValues[name] = value;
        }
      });

      reset(formValues);
      setCurrentAssistantId(assistant.id);
    },
    [query.data, reset, setCurrentAssistantId, createMutation, toolkits],
  );

  useEffect(() => {
    let timerId: NodeJS.Timeout | null = null;

    if (selectedAssistant === lastSelectedAssistant.current) {
      return;
    }

    if (selectedAssistant !== '' && selectedAssistant != null && query.data) {
      timerId = setTimeout(() => {
        lastSelectedAssistant.current = selectedAssistant;
        onSelect(selectedAssistant);
      }, 5);
    }

    return () => {
      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, [selectedAssistant, query.data, onSelect]);

  const createAssistant = localize('com_ui_create_assistant');
  return (
    <SelectDropDown
      value={value || null}
      placeholder={createAssistant}
      setValue={createDropdownSetter(onSelect)}
      availableValues={
        query.data ?? [
          {
            label: 'Loading...',
            value: '',
          },
        ]
      }
      iconSide="left"
      showAbove={false}
      showLabel={false}
      emptyTitle={true}
      containerClassName="grow"
      searchPlaceholder={localize('com_assistants_search_name')}
      optionsListClass="rounded-lg shadow-lg dark:last:border"
      currentValueClass="text-base font-semibold"
      className={cn(
        'mt-1 rounded-md',
        'z-50 flex h-[40px] w-full flex-none items-center justify-center px-4 hover:cursor-pointer',
      )}
      renderOption={() => (
        <span className="flex items-center gap-1.5 truncate">
          <span className="text-text-primary absolute inset-y-0 left-0 flex items-center pl-2">
            <Plus className="w-[16px]" />
          </span>
          <span className={cn('text-text-primary ml-4 flex h-6 items-center gap-1')}>
            {createAssistant}
          </span>
        </span>
      )}
    />
  );
}
