import React, { useMemo } from 'react';
import SearchApiKeyDialog from '~/components/SidePanel/Agents/Search/ApiKeyDialog';
import { useBadgeRowContext } from '~/Providers';

function ToolDialogs() {
  const context = useBadgeRowContext();
  const { webSearch, searchApiKeyForm } = context ?? {};
  const { authData: webSearchAuthData } = webSearch ?? {};
  const searchAuthTypes = useMemo(
    () => webSearchAuthData?.authTypes ?? [],
    [webSearchAuthData?.authTypes],
  );

  if (!searchApiKeyForm) {
    return null;
  }

  const {
    methods: searchMethods,
    onSubmit: searchOnSubmit,
    isDialogOpen: searchDialogOpen,
    setIsDialogOpen: setSearchDialogOpen,
    handleRevokeApiKey: searchHandleRevoke,
    badgeTriggerRef: searchBadgeTriggerRef,
    menuTriggerRef: searchMenuTriggerRef,
  } = searchApiKeyForm;

  return (
    <SearchApiKeyDialog
      onSubmit={searchOnSubmit}
      authTypes={searchAuthTypes}
      isOpen={searchDialogOpen}
      onRevoke={searchHandleRevoke}
      register={searchMethods.register}
      setValue={searchMethods.setValue}
      onOpenChange={setSearchDialogOpen}
      handleSubmit={searchMethods.handleSubmit}
      triggerRefs={[searchMenuTriggerRef, searchBadgeTriggerRef]}
      isToolAuthenticated={webSearchAuthData?.authenticated ?? false}
      searchProvider={webSearchAuthData?.searchProvider}
      scraperProvider={webSearchAuthData?.scraperProvider}
      rerankerType={webSearchAuthData?.rerankerType}
    />
  );
}

export default ToolDialogs;
