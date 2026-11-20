import TermsAndConditionsModal from '~/components/ui/TermsAndConditionsModal';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks';

/** UI readiness for an authenticated owner-scoped host; the server enforces authorization. */
export function useOwnerActionPolicy() {
  const { logout } = useAuthContext();
  const config = useGetStartupConfig({ refetchOnMount: 'always', retry: false });
  const termsConfig = config.data?.interface?.termsOfService;
  const requiresTerms = termsConfig?.modalAcceptance === true;
  const terms = useUserTermsQuery({
    enabled: requiresTerms && config.isSuccess && !config.isFetching,
    refetchOnMount: 'always',
    retry: false,
  });
  const termsReady =
    config.isSuccess &&
    !config.isFetching &&
    (!requiresTerms || (terms.isSuccess && !terms.isFetching && terms.data.termsAccepted));
  const policyError = config.isError || (requiresTerms && terms.isError);
  return { config, terms, termsConfig, requiresTerms, termsReady, policyError, logout };
}

export function OwnerTermsModal({
  policy,
  onAccepted,
}: {
  policy: ReturnType<typeof useOwnerActionPolicy>;
  onAccepted?: () => void;
}) {
  return (
    <TermsAndConditionsModal
      open={policy.requiresTerms && policy.terms.data?.termsAccepted === false}
      onOpenChange={() => undefined}
      onAccept={onAccepted ?? (() => undefined)}
      onDecline={() => policy.logout('/login?redirect=false')}
      title={policy.termsConfig?.modalTitle}
      modalContent={policy.termsConfig?.modalContent}
    />
  );
}
