import { useContext } from 'react';
import { Permissions, SystemRoles, EModelEndpoint, PermissionTypes } from 'librechat-data-provider';
import type { ErrorRendererProps } from './parts';
import type { TranslationKeys } from '~/hooks';
import { ErrorActions, ErrorBody, getProviderName, readString, useErrorEndpoint } from './parts';
import { useHasAccess, useLocalize } from '~/hooks';
import { AuthContext } from '~/hooks/AuthContext';

export default function AgentError({ json, message }: ErrorRendererProps) {
  const localize = useLocalize();
  const { agent, provider: endpointProvider, endpointsConfig } = useErrorEndpoint(message);
  const user = useContext(AuthContext)?.user;
  const canUseAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const canCreateAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.CREATE,
  });

  const info = readString(json, 'info');
  const providerName = info != null ? getProviderName(info) : endpointProvider;

  /**
   * "Open the agent builder" has to be something this reader can do. The side panel offers the
   * builder only while agents are configured, the builder is not disabled, and the reader holds both
   * USE and CREATE; inside it, an agent is editable with an EDIT grant or by an administrator, the
   * same checks the builder applies. An absent agent is also the expected state on shared links and
   * search results, so editability is never claimed without the map identifying the agent.
   */
  const agentsConfig = endpointsConfig?.[EModelEndpoint.agents];
  const builderAvailable =
    agentsConfig != null && agentsConfig.disableBuilder !== true && canUseAgents && canCreateAgents;
  const canEdit =
    agent != null &&
    builderAvailable &&
    (agent.isEditable !== false || user?.role === SystemRoles.ADMIN);

  const supportName = agent?.support_contact?.name?.trim() ?? '';
  const supportEmail = agent?.support_contact?.email?.trim() ?? '';
  const ownerName = agent?.owner_contact?.name?.trim() ?? '';
  const hasSupportContact = supportName !== '' || supportEmail !== '';
  const contactName = hasSupportContact ? supportName : ownerName;

  const guidanceKey: TranslationKeys = canEdit
    ? 'com_error_invalid_agent_provider_editable'
    : 'com_error_invalid_agent_provider_admin';
  const guidance =
    !canEdit && contactName !== ''
      ? localize('com_error_invalid_agent_provider_owner', { 0: contactName })
      : localize(guidanceKey);

  return (
    <ErrorBody>
      {providerName ? (
        <div>{localize('com_error_invalid_agent_provider', { 0: providerName })}</div>
      ) : null}
      <div>{guidance}</div>
      {supportEmail ? (
        <ErrorActions>
          <a href={`mailto:${supportEmail}`} className="text-link hover:underline">
            {localize('com_error_agent_contact_email', { 0: supportEmail })}
          </a>
        </ErrorActions>
      ) : null}
    </ErrorBody>
  );
}
