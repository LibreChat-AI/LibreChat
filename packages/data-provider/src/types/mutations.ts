import * as types from '../types';
import * as r from '../roles';
import * as p from '../permissions';
import {
  Tools,
  Assistant,
  AssistantCreateParams,
  AssistantUpdateParams,
  FunctionTool,
  AssistantDocument,
  Agent,
  AgentCreateParams,
  AgentUpdateParams,
} from './assistants';
import { Action, ActionMetadata } from './agents';

export type MutationOptions<
  Response,
  Request,
  Context = unknown,
  Error = unknown,
  Snapshot = void,
> = {
  onSuccess?: (data: Response, variables: Request, context?: Context) => void;
  onMutate?: (variables: Request) => Snapshot | Promise<Snapshot>;
  onError?: (error: Error, variables: Request, context?: Context, snapshot?: Snapshot) => void;
  onSettled?: (
    data: Response | undefined,
    error: Error | null,
    variables: Request,
    context?: Context,
  ) => void;
};

export interface IFarmerProfile {
  farmerName: string;
  age: number;
  gender: string;
  villageName: string;
  blockName: string;
  district: string;
  state: string;
  nearestKVK: string;
  phoneNo: string;
  languagePreference: string;
  yearsOfExperience: number;
  cropsCultivated: string[];
  primaryCrop: string;
  secondaryCrop: string;
  awarenessOfKCC: boolean;
  usesAgriApps: boolean;
  highestEducatedPerson: string;
  numberOfSmartphones: number;
  platform?: string;
  location: {
    latitude: number;
    longitude: number;
  };
}

export type SaveFarmerProfileMutationOptions = MutationOptions<{ message: string }, IFarmerProfile>;

export type TGenTitleRequest = {
  conversationId: string;
};

export type TGenTitleResponse = {
  title: string;
};

export type PresetDeleteResponse = {
  acknowledged: boolean;
  deletedCount: number;
};

export type UpdatePresetOptions = MutationOptions<types.TPreset, types.TPreset>;

export type DeletePresetOptions = MutationOptions<PresetDeleteResponse, types.TPreset | undefined>;

/* Assistant mutations */

export type AssistantAvatarVariables = {
  assistant_id: string;
  model: string;
  formData: FormData;
  postCreation?: boolean;
  endpoint: types.AssistantsEndpoint;
  version: number | string;
};

export type UpdateActionVariables = {
  assistant_id: string;
  functions: FunctionTool[];
  metadata: ActionMetadata;
  action_id?: string;
  model: string;
  endpoint: types.AssistantsEndpoint;
  version: number | string;
};

export type UploadAssistantAvatarOptions = MutationOptions<Assistant, AssistantAvatarVariables>;

export type CreateAssistantMutationOptions = MutationOptions<Assistant, AssistantCreateParams>;

export type UpdateAssistantVariables = {
  assistant_id: string;
  data: AssistantUpdateParams;
};

export type UpdateAssistantMutationOptions = MutationOptions<Assistant, UpdateAssistantVariables>;

export type DeleteAssistantBody = {
  assistant_id: string;
  model: string;
  endpoint: types.AssistantsEndpoint;
};

export type DeleteAssistantMutationOptions = MutationOptions<
  void,
  Pick<DeleteAssistantBody, 'assistant_id'>
>;

export type UpdateActionResponse = [AssistantDocument, Assistant, Action];
export type UpdateActionOptions = MutationOptions<UpdateActionResponse, UpdateActionVariables>;

export type DeleteActionVariables = {
  endpoint: types.AssistantsEndpoint;
  assistant_id: string;
  action_id: string;
  model: string;
};

export type DeleteActionOptions = MutationOptions<void, DeleteActionVariables>;

/* Agent mutations */

export type AgentAvatarVariables = {
  agent_id: string;
  formData: FormData;
};

export type UpdateAgentActionVariables = {
  agent_id: string;
  action_id?: string;
  metadata: ActionMetadata;
  functions: FunctionTool[];
};

export type UploadAgentAvatarOptions = MutationOptions<Agent, AgentAvatarVariables>;

export type CreateAgentMutationOptions = MutationOptions<Agent, AgentCreateParams>;

export type UpdateAgentVariables = {
  agent_id: string;
  data: AgentUpdateParams;
};

export type DuplicateVersionError = Error & {
  statusCode?: number;
  details?: {
    duplicateVersion?: unknown;
    versionIndex?: number;
  };
};

export type UpdateAgentMutationOptions = MutationOptions<Agent, UpdateAgentVariables>;

export type DuplicateAgentBody = {
  agent_id: string;
};

export type DuplicateAgentMutationOptions = MutationOptions<
  { agent: Agent; actions: Action[] },
  Pick<DuplicateAgentBody, 'agent_id'>
>;

export type DeleteAgentBody = {
  agent_id: string;
};

export type DeleteAgentMutationOptions = MutationOptions<void, Pick<DeleteAgentBody, 'agent_id'>>;

export type UpdateAgentActionResponse = [Agent, Action];
export type UpdateAgentActionOptions = MutationOptions<
  UpdateAgentActionResponse,
  UpdateAgentActionVariables
>;

export type DeleteAgentActionVariables = {
  agent_id: string;
  action_id: string;
};

export type DeleteAgentActionOptions = MutationOptions<void, DeleteAgentActionVariables>;

export type RevertAgentVersionVariables = {
  agent_id: string;
  version_index: number;
};

export type RevertAgentVersionOptions = MutationOptions<Agent, RevertAgentVersionVariables>;

export type DeleteConversationOptions = MutationOptions<
  types.TDeleteConversationResponse,
  types.TDeleteConversationRequest
>;

export type ArchiveConversationOptions = MutationOptions<
  types.TArchiveConversationResponse,
  types.TArchiveConversationRequest
>;

export type DuplicateConvoOptions = MutationOptions<
  types.TDuplicateConvoResponse,
  types.TDuplicateConvoRequest
>;

export type ForkConvoOptions = MutationOptions<types.TForkConvoResponse, types.TForkConvoRequest>;

export type CreateSharedLinkOptions = MutationOptions<
  types.TSharedLink,
  Partial<types.TSharedLink>
>;

export type updateTagsInConvoOptions = MutationOptions<
  types.TTagConversationResponse,
  types.TTagConversationRequest
>;

export type UpdateSharedLinkOptions = MutationOptions<
  types.TSharedLink,
  Partial<types.TSharedLink>
>;

export type ArchiveConvoOptions = MutationOptions<
  types.TArchiveConversationResponse,
  types.TArchiveConversationRequest
>;

export type DeleteSharedLinkContext = { previousQueries?: Map<string, TDeleteSharedLinkResponse> };
export type DeleteSharedLinkOptions = MutationOptions<
  TDeleteSharedLinkResponse,
  { shareId: string },
  DeleteSharedLinkContext
>;

export type TUpdatePromptContext =
  | {
      group?: types.TPromptGroup;
      previousListData?: types.PromptGroupListData;
    }
  | undefined;

export type UpdatePromptGroupOptions = MutationOptions<
  types.TUpdatePromptGroupResponse,
  types.TUpdatePromptGroupVariables,
  TUpdatePromptContext
>;

export type CreatePromptOptions = MutationOptions<types.TCreatePromptResponse, types.TCreatePrompt>;

export type DeletePromptOptions = MutationOptions<
  types.TDeletePromptResponse,
  types.TDeletePromptVariables
>;

export type DeletePromptGroupOptions = MutationOptions<
  types.TDeletePromptGroupResponse,
  types.TDeletePromptGroupRequest
>;

export type UpdatePromptLabelOptions = MutationOptions<
  types.TUpdatePromptLabelsResponse,
  types.TUpdatePromptLabelsRequest
>;

export type MakePromptProductionOptions = MutationOptions<
  types.TMakePromptProductionResponse,
  types.TMakePromptProductionRequest,
  TUpdatePromptContext
>;

/* Auth mutations */
export type VerifyEmailOptions = MutationOptions<types.VerifyEmailResponse, types.TVerifyEmail>;
export type ResendVerifcationOptions = MutationOptions<
  types.VerifyEmailResponse,
  types.TResendVerificationEmail
>;
export type RegistrationOptions = MutationOptions<
  types.TRegisterUserResponse,
  types.TRegisterUser,
  unknown,
  types.TError
>;

export type UpdatePermVars<T> = {
  roleName: string;
  updates: Partial<T>;
};

export type UpdatePromptPermVars = UpdatePermVars<p.TPromptPermissions>;
export type UpdateMemoryPermVars = UpdatePermVars<p.TMemoryPermissions>;
export type UpdateAgentPermVars = UpdatePermVars<p.TAgentPermissions>;
export type UpdatePeoplePickerPermVars = UpdatePermVars<p.TPeoplePickerPermissions>;
export type UpdateMCPServersPermVars = UpdatePermVars<p.TMcpServersPermissions>;

export type UpdatePermResponse = r.TRole;

export type UpdatePromptPermOptions = MutationOptions<
  UpdatePermResponse,
  UpdatePromptPermVars,
  unknown,
  types.TError | null | undefined
>;

export type UpdateMemoryPermOptions = MutationOptions<
  UpdatePermResponse,
  UpdateMemoryPermVars,
  unknown,
  types.TError | null | undefined
>;

export type UpdateAgentPermOptions = MutationOptions<
  UpdatePermResponse,
  UpdateAgentPermVars,
  unknown,
  types.TError | null | undefined
>;

export type UpdatePeoplePickerPermOptions = MutationOptions<
  UpdatePermResponse,
  UpdatePeoplePickerPermVars,
  unknown,
  types.TError | null | undefined
>;

export type UpdateMCPServersPermOptions = MutationOptions<
  UpdatePermResponse,
  UpdateMCPServersPermVars,
  unknown,
  types.TError | null | undefined
>;

export type UpdateMarketplacePermVars = UpdatePermVars<p.TMarketplacePermissions>;

export type UpdateMarketplacePermOptions = MutationOptions<
  UpdatePermResponse,
  UpdateMarketplacePermVars,
  unknown,
  types.TError | null | undefined
>;

export type UpdateConversationTagOptions = MutationOptions<
  types.TConversationTag,
  types.TConversationTagRequest
>;
export type DeleteConversationTagOptions = MutationOptions<types.TConversationTag, string>;

export type AcceptTermsMutationOptions = MutationOptions<
  types.TAcceptTermsResponse,
  void,
  unknown,
  void
>;

export type AcceptSecondTermsMutationOptions = MutationOptions<
  types.TAcceptTermsResponse,
  void,
  unknown,
  void
>;

/* Tools */
export type UpdatePluginAuthOptions = MutationOptions<types.TUser, types.TUpdateUserPlugins>;

export type ToolParamsMap = {
  [Tools.execute_code]: {
    lang: string;
    code: string;
  };
};

export type ToolId = keyof ToolParamsMap;

export type ToolParams<T extends ToolId> = ToolParamsMap[T] & {
  messageId: string;
  partIndex?: number;
  blockIndex?: number;
  conversationId: string;
};
export type ToolCallResponse = { result: unknown; attachments?: types.TAttachment[] };
export type ToolCallMutationOptions<T extends ToolId> = MutationOptions<
  ToolCallResponse,
  ToolParams<T>
>;

export type TDeleteSharedLinkResponse = {
  success: boolean;
  shareId: string;
  message: string;
};

export type TEditArtifactRequest = {
  index: number;
  messageId: string;
  original: string;
  updated: string;
};

export type TEditArtifactResponse = Pick<types.TMessage, 'content' | 'text' | 'conversationId'>;

export type EditArtifactOptions = MutationOptions<
  TEditArtifactResponse,
  TEditArtifactRequest,
  unknown,
  Error
>;

export type TBranchMessageRequest = {
  messageId: string;
  agentId: string;
};

export type TBranchMessageResponse = types.TMessage;

export type BranchMessageOptions = MutationOptions<
  TBranchMessageResponse,
  TBranchMessageRequest,
  unknown,
  Error
>;

export type TLogoutResponse = {
  message: string;
  redirect?: string;
};

export type LogoutOptions = MutationOptions<TLogoutResponse, undefined>;

export interface AssistantInitialize {
  message: string;
  error?: string;
}

export interface CancelMCPOAuthResponse {
  success: boolean;
  message: string;
}
