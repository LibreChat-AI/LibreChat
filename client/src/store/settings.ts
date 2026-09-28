import { atom } from 'recoil';
import { SettingsViews, LocalStorageKeys } from 'librechat-data-provider';
import type { TOptionSettings } from '~/common';
import { CHAT_TITLE_IN_TAB_KEY } from '~/utils/documentTitle';
import { atomWithLocalStorage } from '~/store/utils';
import { STTEndpoints } from '~/common';

const VALID_SPEECH_ENGINES = new Set<string>(Object.values(STTEndpoints));
const LEGACY_EXTERNAL_STT_ENGINES = new Set<string>(['openai', 'azureOpenAI']);
const LEGACY_EXTERNAL_TTS_ENGINES = new Set<string>([
  'openai',
  'azureOpenAI',
  'elevenlabs',
  'localai',
]);

const normalizeSavedSpeechEngine = (
  engine: string,
  legacyExternalEngines: ReadonlySet<string>,
): string => {
  if (VALID_SPEECH_ENGINES.has(engine)) return engine;
  return legacyExternalEngines.has(engine) ? STTEndpoints.external : STTEndpoints.browser;
};

// Static atoms without localStorage
const staticAtoms = {
  abortScroll: atom<boolean>({ key: 'abortScroll', default: false }),
  optionSettings: atom<TOptionSettings>({ key: 'optionSettings', default: {} }),
  currentSettingsView: atom<SettingsViews>({
    key: 'currentSettingsView',
    default: SettingsViews.default,
  }),
  showPopover: atom<boolean>({ key: 'showPopover', default: false }),
  speechSettingsInitialized: atom<boolean>({ key: 'speechSettingsInitialized', default: false }),
};

/** Read synchronously: `useMediaQuery` only resolves after the first paint. */
function isSmallViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
}

const localStorageAtoms = {
  // General settings
  sidebarExpanded: atomWithLocalStorage(
    'unifiedSidebarExpanded',
    !isSmallViewport(),
    /**
     * The mobile drawer covers the viewport, so a persisted open state would
     * launch the app into the navigation instead of the conversation.
     * Normalized during atom initialization so the closed state reaches the
     * first paint rather than animating shut after it.
     */
    (saved) => (isSmallViewport() ? false : saved),
  ),
  enableUserMsgMarkdown: atomWithLocalStorage<boolean>(
    LocalStorageKeys.ENABLE_USER_MSG_MARKDOWN,
    true,
  ),
  keepScreenAwake: atomWithLocalStorage('keepScreenAwake', true),
  newChatSwitchToHistory: atomWithLocalStorage('newChatSwitchToHistory', true),
  chatTitleInTab: atomWithLocalStorage(CHAT_TITLE_IN_TAB_KEY, true),

  // Chat settings
  enterToSend: atomWithLocalStorage('enterToSend', true),
  /** What Enter does while a run is generating: steer (inject mid-run) or queue (send after). */
  duringRunDefaultAction: atomWithLocalStorage<'steer' | 'queue'>(
    'duringRunDefaultAction',
    'steer',
  ),
  /**
   * Whether a steer interrupts generation at the next safe boundary instead of
   * waiting for the run's next tool step. Orthogonal to
   * `duringRunDefaultAction`: that chooses steer-vs-queue, this chooses how
   * soon a steer lands. The composer's interrupt button always interrupts
   * regardless — this only governs the default Enter/steer route.
   */
  steerInterruptsByDefault: atomWithLocalStorage('steerInterruptsByDefault', false),
  maximizeChatSpace: atomWithLocalStorage('maximizeChatSpace', false),
  chatDirection: atomWithLocalStorage('chatDirection', 'LTR'),
  autoExpandTools: atomWithLocalStorage(LocalStorageKeys.AUTO_EXPAND_TOOLS, false),
  saveDrafts: atomWithLocalStorage('saveDrafts', true),
  /**
   * Whether long user messages render collapsed to a preview with a
   * "Show more" toggle. The clamp is visual only; the full text stays in
   * the DOM, copyable and searchable.
   */
  collapseLongUserMessages: atomWithLocalStorage('collapseLongUserMessages', false),
  /**
   * Whether pasting a large block of text attaches it as a `.txt` file instead of
   * flooding the composer. The text still reaches the model in full.
   */
  pasteLongTextAsFile: atomWithLocalStorage('pasteLongTextAsFile', true),
  showScrollButton: atomWithLocalStorage('showScrollButton', true),
  forkSetting: atomWithLocalStorage('forkSetting', ''),
  splitAtTarget: atomWithLocalStorage('splitAtTarget', false),
  rememberDefaultFork: atomWithLocalStorage(LocalStorageKeys.REMEMBER_FORK_OPTION, false),
  saveBadgesState: atomWithLocalStorage('saveBadgesState', false),
  /** User preference for downscaling images before upload; ignored when the admin config sets it */
  clientImageResize: atomWithLocalStorage('clientImageResize', false),
  /**
   * Whether copying a message also puts a rendered HTML version on the
   * clipboard, so apps that ignore Markdown (Teams, Outlook, Word) paste the
   * formatting instead of the raw syntax.
   */
  copyRichText: atomWithLocalStorage('copyRichText', false),

  // Beta features settings
  modularChat: atomWithLocalStorage('modularChat', true),
  LaTeXParsing: atomWithLocalStorage('LaTeXParsing', true),
  centerFormOnLanding: atomWithLocalStorage('centerFormOnLanding', true),
  /**
   * Whether the mobile drawer stops short of the edge, leaving a strip of the
   * conversation visible that also closes it when tapped. Off by default: the
   * drawer covers the screen and the swipe closes it.
   */
  mobileDrawerStrip: atomWithLocalStorage('mobileDrawerStrip', false),
  showFooter: atomWithLocalStorage('showFooter', true),

  // Commands settings
  atCommand: atomWithLocalStorage('atCommand', true),
  plusCommand: atomWithLocalStorage('plusCommand', true),
  slashCommand: atomWithLocalStorage('slashCommand', true),
  dollarCommand: atomWithLocalStorage('dollarCommand', true),

  // Speech settings
  conversationMode: atomWithLocalStorage('conversationMode', false),
  advancedMode: atomWithLocalStorage('advancedMode', false),

  speechToText: atomWithLocalStorage('speechToText', true),
  engineSTT: atomWithLocalStorage('engineSTT', 'browser', (engine) =>
    normalizeSavedSpeechEngine(engine, LEGACY_EXTERNAL_STT_ENGINES),
  ),
  languageSTT: atomWithLocalStorage('languageSTT', ''),
  autoTranscribeAudio: atomWithLocalStorage('autoTranscribeAudio', false),
  decibelValue: atomWithLocalStorage('decibelValue', -45),
  autoSendText: atomWithLocalStorage('autoSendText', -1),

  textToSpeech: atomWithLocalStorage('textToSpeech', true),
  engineTTS: atomWithLocalStorage('engineTTS', 'browser', (engine) =>
    normalizeSavedSpeechEngine(engine, LEGACY_EXTERNAL_TTS_ENGINES),
  ),
  voice: atomWithLocalStorage<string | undefined>('voice', undefined),
  cloudBrowserVoices: atomWithLocalStorage('cloudBrowserVoices', false),
  languageTTS: atomWithLocalStorage('languageTTS', ''),
  automaticPlayback: atomWithLocalStorage('automaticPlayback', false),
  playbackRate: atomWithLocalStorage<number | null>('playbackRate', null),
  cacheTTS: atomWithLocalStorage('cacheTTS', true),

  // Account settings
  UsernameDisplay: atomWithLocalStorage('UsernameDisplay', true),
};

export default { ...staticAtoms, ...localStorageAtoms };
