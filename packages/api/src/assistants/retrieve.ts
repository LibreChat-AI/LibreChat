import { EModelEndpoint } from 'librechat-data-provider';
import { logger, SystemCapabilities } from '@librechat/data-schemas';
import type { Assistant, TAssistantEndpoint, TAzureConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { CapabilityUser, HasCapabilityFn } from '../middleware/capabilities';

interface AssistantRetrievalRequest {
  params: { id: string };
  body?: { endpoint?: string; model?: string };
  query?: { endpoint?: string; model?: string };
  user: CapabilityUser;
  config: {
    endpoints?: Partial<
      Record<
        EModelEndpoint.assistants | EModelEndpoint.azureAssistants,
        Partial<TAssistantEndpoint>
      >
    > & {
      azureOpenAI?: Pick<
        TAzureConfig,
        'assistants' | 'assistantModels' | 'groupMap' | 'modelGroupMap'
      >;
    };
  };
}

type AssistantRetrievalResponse = Pick<Response, 'status' | 'json'>;

interface AssistantRetrievalDeps {
  getOpenAIClient: (input: {
    req: AssistantRetrievalRequest;
    res: AssistantRetrievalResponse;
  }) => Promise<{
    openai: { beta: { assistants: { retrieve: (id: string) => Promise<Assistant> } } };
  }>;
  filterAssistants: (input: {
    assistants: Assistant[];
    userId: string;
    assistantsConfig: Partial<TAssistantEndpoint>;
  }) => Assistant[];
  hasCapability: HasCapabilityFn;
}

function notFound(res: AssistantRetrievalResponse): void {
  res.status(404).json({ error: 'Assistant not found' });
}

export function createAssistantRetriever({
  getOpenAIClient,
  filterAssistants,
  hasCapability,
}: AssistantRetrievalDeps): (
  req: AssistantRetrievalRequest,
  res: AssistantRetrievalResponse,
) => Promise<void> {
  return async (req, res) => {
    try {
      const endpoint = req.body?.endpoint ?? req.query?.endpoint;
      if (endpoint !== EModelEndpoint.assistants && endpoint !== EModelEndpoint.azureAssistants) {
        notFound(res);
        return;
      }

      const assistantsConfig = req.config.endpoints?.[endpoint];
      const azureConfig = req.config.endpoints?.[EModelEndpoint.azureOpenAI];
      let group: TAzureConfig['groupMap'][string];
      if (endpoint === EModelEndpoint.azureAssistants && azureConfig?.assistants) {
        const model = req.body?.model ?? req.query?.model ?? azureConfig.assistantModels?.[0];
        const groupName =
          typeof model === 'string' ? azureConfig.modelGroupMap[model]?.group : undefined;
        group = groupName === undefined ? undefined : azureConfig.groupMap[groupName];
        if (!group || Object.keys(group.models).length === 0) {
          notFound(res);
          return;
        }
      }

      const canManageAssistants = assistantsConfig
        ? hasCapability(req.user, SystemCapabilities.MANAGE_ASSISTANTS).catch(() => {
            logger.warn('[retrieveAssistant] Capability check failed, denying bypass');
            return false;
          })
        : Promise.resolve(false);
      req.body ??= {};
      const { openai } = await getOpenAIClient({ req, res });
      let assistant = await openai.beta.assistants.retrieve(req.params.id);
      if (
        assistantsConfig &&
        !(await canManageAssistants) &&
        filterAssistants({
          assistants: [assistant],
          userId: req.user.id,
          assistantsConfig,
        }).length === 0
      ) {
        notFound(res);
        return;
      }

      if (group) {
        const models = Object.entries(group.models);
        let publicModel = models[0][0];
        if (group.deploymentName !== assistant.model) {
          for (const [model, modelConfig] of models) {
            if (
              typeof modelConfig === 'object' &&
              modelConfig?.deploymentName === assistant.model
            ) {
              publicModel = model;
              break;
            }
          }
        }
        assistant = { ...assistant, model: publicModel };
      }
      res.json(assistant);
    } catch (error) {
      if (
        error != null &&
        typeof error === 'object' &&
        'status' in error &&
        (error.status === 404 || error.status === 403)
      ) {
        notFound(res);
        return;
      }
      logger.warn('[retrieveAssistant] Assistant retrieval failed');
      res.status(500).json({ error: 'Failed to load assistant' });
    }
  };
}
