import { useEffect } from 'react';
import { Search } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { isAgentsEndpoint } from 'librechat-data-provider';
import { useUpdateUserPluginsMutation } from 'librechat-data-provider/react-query';
import {
  Alert,
  Input,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import type {
  AssistantsEndpoint,
  EModelEndpoint,
  TPluginAction,
  TError,
} from 'librechat-data-provider';
import type { ToolDialogProps } from '~/common/types';
import { PluginPagination, PluginAuthForm } from '~/components/Plugins/Store';
import { useLocalize, usePluginDialogHelpers } from '~/hooks';
import { useAvailableToolsQuery } from '~/data-provider';
import ToolItem from './ToolItem';

function AssistantToolsDialog({
  isOpen,
  endpoint,
  setIsOpen,
}: ToolDialogProps & {
  endpoint: AssistantsEndpoint | EModelEndpoint.agents;
}) {
  const localize = useLocalize();
  const { getValues, setValue } = useFormContext();
  const { data: tools } = useAvailableToolsQuery(endpoint);
  const isAgentTools = isAgentsEndpoint(endpoint);

  const {
    maxPage,
    setMaxPage,
    currentPage,
    setCurrentPage,
    itemsPerPage,
    searchChanged,
    setSearchChanged,
    searchValue,
    setSearchValue,
    gridRef,
    handleSearch,
    handleChangePage,
    error,
    setError,
    errorMessage,
    setErrorMessage,
    showPluginAuthForm,
    setShowPluginAuthForm,
    selectedPlugin,
    setSelectedPlugin,
  } = usePluginDialogHelpers();

  const updateUserPlugins = useUpdateUserPluginsMutation();
  const handleInstallError = (error: TError) => {
    setError(true);
    const errorMessage = error.response?.data?.message ?? '';
    if (errorMessage) {
      setErrorMessage(errorMessage);
    }
    setTimeout(() => {
      setError(false);
      setErrorMessage('');
    }, 5000);
  };

  const handleInstall = (pluginAction: TPluginAction) => {
    const addFunction = () => {
      const fns = getValues('functions').slice();
      fns.push(pluginAction.pluginKey);
      setValue('functions', fns);
    };

    if (!pluginAction.auth) {
      return addFunction();
    }

    updateUserPlugins.mutate(pluginAction, {
      onError: (error: unknown) => {
        handleInstallError(error as TError);
      },
      onSuccess: addFunction,
    });

    setShowPluginAuthForm(false);
  };

  const onRemoveTool = (tool: string) => {
    setShowPluginAuthForm(false);
    updateUserPlugins.mutate(
      { pluginKey: tool, action: 'uninstall', auth: null, isEntityTool: true },
      {
        onError: (error: unknown) => {
          handleInstallError(error as TError);
        },
        onSuccess: () => {
          const fns = getValues('functions').filter((fn: string) => fn !== tool);
          setValue('functions', fns);
        },
      },
    );
  };

  const onAddTool = (pluginKey: string) => {
    setShowPluginAuthForm(false);
    const getAvailablePluginFromKey = tools?.find((p) => p.pluginKey === pluginKey);
    setSelectedPlugin(getAvailablePluginFromKey);

    const { authConfig, authenticated = false } = getAvailablePluginFromKey ?? {};

    if (authConfig && authConfig.length > 0 && !authenticated) {
      setShowPluginAuthForm(true);
    } else {
      handleInstall({ pluginKey, action: 'install', auth: null });
    }
  };

  const filteredTools = tools?.filter((tool) =>
    tool.name.toLowerCase().includes(searchValue.toLowerCase()),
  );

  useEffect(() => {
    if (filteredTools) {
      setMaxPage(Math.ceil(filteredTools.length / itemsPerPage));
      if (searchChanged) {
        setCurrentPage(1);
        setSearchChanged(false);
      }
    }
  }, [
    tools,
    itemsPerPage,
    searchValue,
    filteredTools,
    searchChanged,
    setMaxPage,
    setCurrentPage,
    setSearchChanged,
  ]);

  return (
    <OGDialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          setIsOpen(false);
          setCurrentPage(1);
          setSearchValue('');
        }
      }}
    >
      <OGDialogContent
        className="gap-0 overflow-hidden overflow-y-auto p-0 text-left max-sm:h-full sm:mx-7 sm:my-8 sm:max-w-2xl lg:max-w-5xl xl:max-w-7xl"
        style={{ minHeight: 'min(38.125rem, 90vh)' }}
      >
        <div>
          <div className="border-border-medium flex items-center justify-between border-b px-4 pt-5 pb-4 sm:p-6">
            <div className="flex items-center">
              <div className="text-center sm:text-left">
                <OGDialogTitle className="text-lg leading-6 font-medium">
                  {isAgentTools
                    ? localize('com_nav_tool_dialog_agents')
                    : localize('com_nav_tool_dialog')}
                </OGDialogTitle>
                <OGDialogDescription className="text-sm">
                  {localize('com_nav_tool_dialog_description')}
                </OGDialogDescription>
              </div>
            </div>
          </div>
          {error && (
            <Alert variant="error" icon={false} className="m-4">
              {localize('com_nav_plugin_auth_error')} {errorMessage}
            </Alert>
          )}
          {showPluginAuthForm && (
            <div className="p-4 sm:p-6 sm:pt-4">
              <PluginAuthForm
                plugin={selectedPlugin}
                onSubmit={(installActionData: TPluginAction) => handleInstall(installActionData)}
                isEntityTool={true}
              />
            </div>
          )}
          <div className="p-4 sm:p-6 sm:pt-4">
            <div className="mt-4 flex flex-col gap-4">
              <div className="flex min-w-0 items-center justify-center gap-4">
                <Search className="text-text-tertiary h-6 w-6 shrink-0" aria-hidden="true" />
                <Input
                  type="text"
                  value={searchValue}
                  onChange={handleSearch}
                  placeholder={localize('com_nav_tool_search')}
                  aria-label={localize('com_nav_tool_search')}
                  className="border-border-medium max-w-64 min-w-0 flex-1 rounded border px-2 py-1"
                />
              </div>
              <div
                ref={gridRef}
                className="grid grid-cols-1 grid-rows-2 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                style={{ minHeight: '25.625rem' }}
              >
                {filteredTools &&
                  filteredTools
                    .slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
                    .map((tool, index) => (
                      <ToolItem
                        key={index}
                        tool={tool}
                        isInstalled={getValues('functions').includes(tool.pluginKey)}
                        onAddTool={() => onAddTool(tool.pluginKey)}
                        onRemoveTool={() => onRemoveTool(tool.pluginKey)}
                      />
                    ))}
              </div>
            </div>
            <div className="mt-2 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
              {maxPage > 0 ? (
                <PluginPagination
                  currentPage={currentPage}
                  maxPage={maxPage}
                  onChangePage={handleChangePage}
                />
              ) : (
                <div className="h-[1.3125rem]"></div>
              )}
            </div>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

export default AssistantToolsDialog;
