import type {
  MediaErrorCode,
  MediaImageParameters,
  MediaInput,
  MediaJobPhase,
  MediaOperation,
  MediaOutput,
  MediaThreadListRequest,
  MediaVideoParameters,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

export const mediaOperationLabels = {
  'image.generate': 'com_media_image_generate',
  'image.edit': 'com_media_image_edit',
  'video.generate': 'com_media_video_generate',
} satisfies Record<MediaOperation, TranslationKeys>;

export const mediaControlLabels = {
  count: 'com_media_count',
  durationSeconds: 'com_media_duration_seconds',
  seed: 'com_media_seed',
  size: 'com_media_size',
  aspectRatio: 'com_media_aspect_ratio',
  quality: 'com_media_quality',
  format: 'com_media_format',
  background: 'com_media_background',
  resolution: 'com_media_resolution',
  audio: 'com_media_audio',
  outputCompression: 'com_media_output_compression',
  strength: 'com_media_strength',
  guidance: 'com_media_guidance',
  upscaleFactor: 'com_media_upscale_factor',
  creativity: 'com_media_creativity',
  negativePrompt: 'com_media_negative_prompt',
  providerOptions: 'com_media_provider_options',
} satisfies Record<keyof MediaImageParameters | keyof MediaVideoParameters, TranslationKeys>;

export const mediaInputRoleLabels = {
  reference: 'com_media_role_reference',
  mask: 'com_media_role_mask',
  start_frame: 'com_media_role_start_frame',
  end_frame: 'com_media_role_end_frame',
  video: 'com_media_role_video',
  audio: 'com_media_role_audio',
} satisfies Record<MediaInput['role'], TranslationKeys>;

export const mediaThreadFilterLabels = {
  all: 'com_media_filter_all',
  pending: 'com_media_filter_pending',
  completed: 'com_media_filter_completed',
} satisfies Record<NonNullable<MediaThreadListRequest['filter']>, TranslationKeys>;

export const mediaOutputStateLabels = {
  pending: 'com_media_output_pending',
  failed: 'com_media_output_failed',
  expired: 'com_media_output_expired',
  ready: 'com_media_preview_failed',
} satisfies Record<Exclude<MediaOutput, { kind: 'text' }>['state'], TranslationKeys>;

export const mediaJobPhaseLabels = {
  queued: 'com_media_phase_queued',
  submitting: 'com_media_phase_submitting',
  running: 'com_media_phase_running',
  ingesting: 'com_media_phase_ingesting',
  reconciling: 'com_media_phase_reconciling',
  requires_attention: 'com_media_phase_requires_attention',
  succeeded: 'com_media_phase_succeeded',
  failed: 'com_media_phase_failed',
  cancelled: 'com_media_phase_cancelled',
} satisfies Record<MediaJobPhase, TranslationKeys>;

export const mediaErrorLabels = {
  reference_unavailable: 'com_media_error_reference_unavailable',
  reference_changed: 'com_media_error_reference_changed',
  invalid_request: 'com_media_error_invalid_request',
  not_found: 'com_media_error_not_found',
  forbidden: 'com_media_error_forbidden',
  disabled: 'com_media_error_disabled',
  unsupported: 'com_media_error_unsupported',
  stale_catalog: 'com_media_error_stale_catalog',
  version_conflict: 'com_media_error_version_conflict',
  request_conflict: 'com_media_error_request_conflict',
  quota_exceeded: 'com_media_error_quota_exceeded',
  queue_expired: 'com_media_error_queue_expired',
  credentials_required: 'com_media_error_credentials_required',
  credentials_expired: 'com_media_error_credentials_expired',
  gemini_key_required: 'com_media_error_gemini_key_required',
  provider_rejected: 'com_media_error_provider_rejected',
  submission_uncertain: 'com_media_error_submission_uncertain',
  storage_failed: 'com_media_error_storage_failed',
  output_expired: 'com_media_error_output_expired',
  cancel_unsupported: 'com_media_error_cancel_unsupported',
  not_ready: 'com_media_error_not_ready',
  internal_error: 'com_media_error_internal_error',
} satisfies Record<MediaErrorCode, TranslationKeys>;
