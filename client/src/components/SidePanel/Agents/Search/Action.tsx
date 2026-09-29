import { useRef } from 'react';
import { KeyRound, CircleCheck } from 'lucide';
import { useFormContext } from 'react-hook-form';
import { Button, MorphIcon } from '@librechat/client';
import {
  AuthType,
  RerankerTypes,
  SearchProviders,
  ScraperProviders,
  AgentCapabilities,
} from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useLocalize, useSearchApiKeyForm } from '~/hooks';
import ApiKeyDialog from './ApiKeyDialog';
import { cn } from '~/utils';

export default function Action({
  authTypes = [],
  isToolAuthenticated = false,
  searchProvider,
  scraperProvider,
  rerankerType,
}: {
  authTypes?: [string, AuthType][];
  isToolAuthenticated?: boolean;
  searchProvider?: SearchProviders;
  scraperProvider?: ScraperProviders;
  rerankerType?: RerankerTypes;
}) {
  const localize = useLocalize();
  const { setValue } = useFormContext<AgentForm>();
  const apiKeyButtonRef = useRef<HTMLButtonElement>(null);
  const {
    onSubmit,
    isDialogOpen,
    setIsDialogOpen,
    handleRevokeApiKey,
    methods: keyFormMethods,
  } = useSearchApiKeyForm({
    onSubmit: () => {
      setValue(AgentCapabilities.web_search, true, { shouldDirty: true });
      setTimeout(() => apiKeyButtonRef.current?.focus(), 100);
    },
    onRevoke: () => {
      setValue(AgentCapabilities.web_search, false, { shouldDirty: true });
      setTimeout(() => apiKeyButtonRef.current?.focus(), 100);
    },
  });

  const isUserProvided = authTypes?.some(([, authType]) => authType === AuthType.USER_PROVIDED);

  if (!isUserProvided) {
    return null;
  }

  return (
    <>
      <Button
        ref={apiKeyButtonRef}
        type="button"
        variant="outline"
        onClick={() => setIsDialogOpen(true)}
        aria-haspopup="dialog"
        className="w-full justify-center gap-2"
      >
        <MorphIcon
          icon={isToolAuthenticated ? CircleCheck : KeyRound}
          className={cn('h-4 w-4', isToolAuthenticated && 'text-status-success')}
        />
        {localize(
          isToolAuthenticated
            ? 'com_ui_manage_web_search_api_keys'
            : 'com_ui_add_web_search_api_keys',
        )}
      </Button>
      <ApiKeyDialog
        onSubmit={onSubmit}
        authTypes={authTypes}
        isOpen={isDialogOpen}
        onRevoke={handleRevokeApiKey}
        onOpenChange={setIsDialogOpen}
        register={keyFormMethods.register}
        setValue={keyFormMethods.setValue}
        isToolAuthenticated={isToolAuthenticated}
        handleSubmit={keyFormMethods.handleSubmit}
        triggerRef={apiKeyButtonRef}
        searchProvider={searchProvider}
        scraperProvider={scraperProvider}
        rerankerType={rerankerType}
      />
    </>
  );
}
