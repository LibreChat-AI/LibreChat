import { getConfigDefaults } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';

const defaultInterface = getConfigDefaults().interface;

/** The selector has nothing to offer when model selection is off and no model specs exist. */
export function isModelSelectorShown(startupConfig?: TStartupConfig | null): boolean {
  const interfaceConfig = startupConfig?.interface ?? defaultInterface;
  const modelSpecs = startupConfig?.modelSpecs?.list ?? [];
  return interfaceConfig.modelSelect !== false || modelSpecs.length > 0;
}

/** `interface.messageAuthor`: a response need not repeat the author a shown selector names. */
export function useHideSelectedAuthor(): boolean {
  const { data: startupConfig } = useGetStartupConfig();
  return (
    startupConfig?.interface?.messageAuthor === 'whenDifferent' &&
    isModelSelectorShown(startupConfig)
  );
}
