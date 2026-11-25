import { resolveModelCatalogKey } from 'librechat-data-provider';

type ProviderOption = string | { value?: string | number | null };

export function getAvailableModelSelection(model: string, models: readonly string[]): string {
  return models.includes(model) ? model : '';
}

export function getAvailableAgentSelection({
  provider,
  model,
  providers,
  models,
}: {
  provider: string;
  model: string;
  providers: readonly ProviderOption[];
  models: Record<string, string[] | undefined>;
}): { provider: string; model: string } {
  const providerExists =
    models[resolveModelCatalogKey(provider, models)] != null &&
    providers.some((option) =>
      typeof option === 'string' ? option === provider : option.value === provider,
    );

  if (!providerExists) {
    return { provider: '', model: '' };
  }

  return {
    provider,
    model: getAvailableModelSelection(
      model,
      models[resolveModelCatalogKey(provider, models)] ?? [],
    ),
  };
}
