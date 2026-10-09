import { useCallback, useEffect, useRef, useState } from 'react';
import filenamify from 'filenamify';
import exportFromJSON from 'export-from-json';
import { useToastContext } from '@librechat/client';
import { QueryKeys } from 'librechat-data-provider';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilState, useSetRecoilState, useRecoilValue } from 'recoil';
import { useCreatePresetMutation, useGetModelsQuery } from 'librechat-data-provider/react-query';
import type { TPreset, TEndpointsConfig } from 'librechat-data-provider';
import {
  normalizeExportFilename,
  removeUnavailableTools,
  getConvoSwitchLogic,
  cleanupPreset,
} from '~/utils';
import {
  useUpdatePresetMutation,
  useDeletePresetMutation,
  useGetPresetsQuery,
} from '~/data-provider';
import useGetConversation from '~/hooks/Conversations/useGetConversation';
import useDefaultConvo from '~/hooks/Conversations/useDefaultConvo';
import { useAuthContext } from '~/hooks/AuthContext';
import { NotificationSeverity } from '~/common';
import useNewConvo from '~/hooks/useNewConvo';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function usePresets(index = 0) {
  const localize = useLocalize();
  const hasLoaded = useRef(false);
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const getConversation = useGetConversation(index);
  const { user, isAuthenticated } = useAuthContext();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [presetToDelete, setPresetToDelete] = useState<TPreset | null>(null);

  const modularChat = useRecoilValue(store.modularChat);
  const availableTools = useRecoilValue(store.availableTools);
  const setPresetModalVisible = useSetRecoilState(store.presetModalVisible);
  const [_defaultPreset, setDefaultPreset] = useRecoilState(store.defaultPreset);
  const presetsQuery = useGetPresetsQuery({ enabled: !!user && isAuthenticated });
  const preset = useRecoilValue(store.presetByIndex(index));
  const setPreset = useSetRecoilState(store.presetByIndex(index));
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const { data: modelsData } = useGetModelsQuery();
  const { newConversation } = useNewConvo(index);

  useEffect(() => {
    if (modelsData?.initial) {
      return;
    }

    const { data: presets } = presetsQuery;
    if (_defaultPreset || !presets || hasLoaded.current) {
      return;
    }

    if (presets && presets.length > 0 && user && presets[0].user !== user.id) {
      presetsQuery.refetch();
      return;
    }

    const defaultPreset = presets.find((p) => p.defaultPreset);
    if (!defaultPreset) {
      hasLoaded.current = true;
      return;
    }
    setDefaultPreset(defaultPreset);
    if (!conversationId || conversationId === 'new') {
      newConversation({ preset: defaultPreset, modelsData, disableParams: true });
    }
    hasLoaded.current = true;
    // dependencies are stable and only needed once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetsQuery.data, user, modelsData, conversationId]);

  const setPresets = useCallback(
    (presets: TPreset[]) => {
      queryClient.setQueryData<TPreset[]>([QueryKeys.presets], presets);
    },
    [queryClient],
  );

  const deletePresetsMutation = useDeletePresetMutation({
    onMutate: (preset) => {
      if (!preset) {
        setPresets([]);
        return;
      }
      const previousPresets = presetsQuery.data ?? [];
      if (previousPresets) {
        setPresets(previousPresets.filter((p) => p.presetId !== preset.presetId));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.presets]);
      showToast({
        message: localize('com_endpoint_preset_delete_success'),
        severity: NotificationSeverity.SUCCESS,
        showIcon: true,
      });
    },
    onError: (error) => {
      queryClient.invalidateQueries([QueryKeys.presets]);
      console.error('Error deleting the preset:', error);
      showToast({
        message: localize('com_endpoint_preset_delete_error'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    },
  });
  const createPresetMutation = useCreatePresetMutation();
  const updatePreset = useUpdatePresetMutation({
    onSuccess: (data, preset) => {
      const toastTitle = data.title ? `"${data.title}"` : localize('com_endpoint_preset_title');
      let message = `${toastTitle} ${localize('com_ui_saved')}`;
      if (data.defaultPreset && data.presetId !== _defaultPreset?.presetId) {
        message = `${toastTitle} ${localize('com_endpoint_preset_default')}`;
        setDefaultPreset(data);
        newConversation({ preset: data, disableParams: true });
      } else if (preset.defaultPreset === false) {
        setDefaultPreset(null);
        message = `${toastTitle} ${localize('com_endpoint_preset_default_removed')}`;
      }
      showToast({
        message,
      });
      queryClient.invalidateQueries([QueryKeys.presets]);
    },
    onError: (error) => {
      console.error('Error updating the preset:', error);
      showToast({
        message: localize('com_endpoint_preset_save_error'),
        severity: NotificationSeverity.ERROR,
      });
    },
  });

  const getDefaultConversation = useDefaultConvo();

  const importPreset = (jsonPreset: TPreset) => {
    createPresetMutation.mutate(
      { ...jsonPreset },
      {
        onSuccess: () => {
          showToast({
            message: localize('com_endpoint_preset_import'),
          });
          queryClient.invalidateQueries([QueryKeys.presets]);
        },
        onError: (error) => {
          console.error('Error uploading the preset:', error);
          showToast({
            message: localize('com_endpoint_preset_import_error'),
            severity: NotificationSeverity.ERROR,
          });
        },
      },
    );
  };

  const onFileSelected = (jsonData: Record<string, unknown>) => {
    const jsonPreset = { ...cleanupPreset({ preset: jsonData }), presetId: null };
    importPreset(jsonPreset);
  };

  const onSelectPreset = (_newPreset: TPreset) => {
    if (!_newPreset) {
      return;
    }

    const conversation = getConversation();
    const newPreset = removeUnavailableTools(_newPreset, availableTools);

    const toastTitle = newPreset.title
      ? `"${newPreset.title}"`
      : localize('com_endpoint_preset_title');

    showToast({
      message: `${toastTitle} ${localize('com_endpoint_preset_selected_title')}`,
      showIcon: false,
      duration: 750,
    });

    const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);

    const {
      shouldSwitch,
      isNewModular,
      newEndpointType,
      isCurrentModular,
      isExistingConversation,
    } = getConvoSwitchLogic({
      newEndpoint: newPreset.endpoint ?? '',
      modularChat,
      conversation,
      endpointsConfig,
    });

    newPreset.spec = null;
    newPreset.iconURL = newPreset.iconURL ?? null;
    newPreset.modelLabel = newPreset.modelLabel ?? null;
    const isModular = isCurrentModular && isNewModular && shouldSwitch;
    const disableParams = newPreset.defaultPreset === true;
    if (isExistingConversation && isModular) {
      const currentConvo = getDefaultConversation({
        /* target endpointType is necessary to avoid endpoint mixing */
        conversation: {
          ...(conversation ?? {}),
          spec: null,
          iconURL: null,
          modelLabel: null,
          endpointType: newEndpointType,
        },
        preset: { ...newPreset, endpointType: newEndpointType },
        cleanInput: true,
      });

      /* We don't reset the latest message, only when changing settings mid-converstion */
      newConversation({
        template: currentConvo,
        preset: currentConvo,
        keepAddedConvos: true,
        disableParams,
      });
      return;
    }

    newConversation({ preset: newPreset, keepAddedConvos: isModular, disableParams });
  };

  const onChangePreset = (preset: TPreset) => {
    setPreset(preset);
    setPresetModalVisible(true);
  };

  const clearAllPresets = () => deletePresetsMutation.mutate(undefined);

  const onDeletePreset = (preset: TPreset) => {
    setPresetToDelete(preset);
    setShowDeleteDialog(true);
  };

  const confirmDeletePreset = () => {
    if (!presetToDelete) {
      return;
    }
    deletePresetsMutation.mutate(presetToDelete);
    setShowDeleteDialog(false);
    setPresetToDelete(null);
  };

  const submitPreset = () => {
    if (!preset) {
      return;
    }

    updatePreset.mutate(cleanupPreset({ preset }));
  };

  const onSetDefaultPreset = (preset: TPreset, remove = false) => {
    updatePreset.mutate({ ...preset, defaultPreset: !remove });
  };

  const exportPreset = () => {
    if (!preset) {
      return;
    }
    const fileName = normalizeExportFilename(filenamify(preset.title || 'preset'));
    exportFromJSON({
      data: cleanupPreset({ preset }),
      fileName,
      exportType: exportFromJSON.types.json,
    });
  };

  return {
    presetsQuery,
    onSetDefaultPreset,
    onFileSelected,
    onSelectPreset,
    onChangePreset,
    clearAllPresets,
    onDeletePreset,
    submitPreset,
    exportPreset,
    showDeleteDialog,
    setShowDeleteDialog,
    presetToDelete,
    confirmDeletePreset,
  };
}
