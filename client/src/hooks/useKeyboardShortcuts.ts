import { useCallback, useEffect, useMemo } from 'react';
import copy from 'copy-to-clipboard';
import { useToastContext } from '@librechat/client';
import { useMatch, useNavigate } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import type { ShortcutBinding } from '~/utils/shortcuts';
import type { ShortcutOverride } from '~/store/misc';
import {
  bindingDisplayString,
  bindingFromEvent,
  bindingHash,
  bindingToString,
  isMacPlatform,
  parseBinding,
} from '~/utils/shortcuts';
import { mainTextareaId, NotificationSeverity } from '~/common';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';
import { useArchiveConvoMutation } from '~/data-provider';
import { useHasAccess, useLocalize } from '~/hooks';
import useNewChat from '~/hooks/Chat/useNewChat';
import store from '~/store';

const isMac = isMacPlatform;
const CUSTOM_STORAGE_KEY = 'customKeyboardShortcuts';

export type ShortcutDefinition = {
  labelKey: string;
  groupKey: string;
  displayMac: string;
  displayOther: string;
  ariaMac: string;
  ariaOther: string;
};

export const shortcutDefinitions = {
  showShortcuts: {
    labelKey: 'com_shortcut_show_shortcuts',
    groupKey: 'com_shortcut_group_general',
    displayMac: '⌘ ⇧ /',
    displayOther: 'Ctrl+Shift+/',
    ariaMac: 'Meta+Shift+/',
    ariaOther: 'Control+Shift+/',
  },
  newChat: {
    labelKey: 'com_ui_new_chat',
    groupKey: 'com_shortcut_group_general',
    displayMac: '⌘ ⇧ O',
    displayOther: 'Ctrl+Shift+O',
    ariaMac: 'Meta+Shift+O',
    ariaOther: 'Control+Shift+O',
  },
  focusChat: {
    labelKey: 'com_shortcut_focus_chat_input',
    groupKey: 'com_shortcut_group_general',
    displayMac: '⇧ Esc',
    displayOther: 'Shift+Esc',
    ariaMac: 'Shift+Escape',
    ariaOther: 'Shift+Escape',
  },
  copyLastResponse: {
    labelKey: 'com_shortcut_copy_last_response',
    groupKey: 'com_shortcut_group_general',
    displayMac: '⌘ ⇧ ;',
    displayOther: 'Ctrl+Shift+;',
    ariaMac: 'Meta+Shift+;',
    ariaOther: 'Control+Shift+;',
  },
  uploadFile: {
    labelKey: 'com_shortcut_upload_file',
    groupKey: 'com_shortcut_group_general',
    displayMac: '⌘ ⇧ U',
    displayOther: 'Ctrl+Shift+U',
    ariaMac: 'Meta+Shift+U',
    ariaOther: 'Control+Shift+U',
  },
  toggleSidebar: {
    labelKey: 'com_shortcut_toggle_sidebar',
    groupKey: 'com_shortcut_group_navigation',
    displayMac: '⌘ ⇧ S',
    displayOther: 'Ctrl+Shift+S',
    ariaMac: 'Meta+Shift+S',
    ariaOther: 'Control+Shift+S',
  },
  openModelSelector: {
    labelKey: 'com_shortcut_open_model_selector',
    groupKey: 'com_shortcut_group_navigation',
    displayMac: '⌘ ⇧ M',
    displayOther: 'Ctrl+Shift+M',
    ariaMac: 'Meta+Shift+M',
    ariaOther: 'Control+Shift+M',
  },
  focusSearch: {
    labelKey: 'com_shortcut_focus_search',
    groupKey: 'com_shortcut_group_navigation',
    displayMac: '⌘ /',
    displayOther: 'Ctrl+/',
    ariaMac: 'Meta+/',
    ariaOther: 'Control+/',
  },
  openSettings: {
    labelKey: 'com_nav_settings',
    groupKey: 'com_shortcut_group_navigation',
    displayMac: '⌘ ⇧ ,',
    displayOther: 'Ctrl+Shift+,',
    ariaMac: 'Meta+Shift+,',
    ariaOther: 'Control+Shift+,',
  },
  stopGenerating: {
    labelKey: 'com_nav_stop_generating',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ X',
    displayOther: 'Ctrl+Shift+X',
    ariaMac: 'Meta+Shift+X',
    ariaOther: 'Control+Shift+X',
  },
  escalateSteer: {
    labelKey: 'com_ui_interrupt_steer_now',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ .',
    displayOther: 'Ctrl+Shift+.',
    ariaMac: 'Meta+Shift+.',
    ariaOther: 'Control+Shift+.',
  },
  regenerateResponse: {
    labelKey: 'com_shortcut_regenerate_response',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ E',
    displayOther: 'Ctrl+Shift+E',
    ariaMac: 'Meta+Shift+E',
    ariaOther: 'Control+Shift+E',
  },
  editLastMessage: {
    labelKey: 'com_shortcut_edit_last_message',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ I',
    displayOther: 'Ctrl+Shift+I',
    ariaMac: 'Meta+Shift+I',
    ariaOther: 'Control+Shift+I',
  },
  copyLastCode: {
    labelKey: 'com_shortcut_copy_last_code',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ K',
    displayOther: 'Ctrl+Shift+K',
    ariaMac: 'Meta+Shift+K',
    ariaOther: 'Control+Shift+K',
  },
  scrollToTop: {
    labelKey: 'com_shortcut_scroll_to_top',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ ↑',
    displayOther: 'Ctrl+Shift+↑',
    ariaMac: 'Meta+Shift+ArrowUp',
    ariaOther: 'Control+Shift+ArrowUp',
  },
  scrollToBottom: {
    labelKey: 'com_shortcut_scroll_to_bottom',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ ↓',
    displayOther: 'Ctrl+Shift+↓',
    ariaMac: 'Meta+Shift+ArrowDown',
    ariaOther: 'Control+Shift+ArrowDown',
  },
  toggleTemporaryChat: {
    labelKey: 'com_ui_temporary',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ Y',
    displayOther: 'Ctrl+Shift+Y',
    ariaMac: 'Meta+Shift+Y',
    ariaOther: 'Control+Shift+Y',
  },
  archiveConversation: {
    labelKey: 'com_shortcut_archive_conversation',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ L',
    displayOther: 'Ctrl+Shift+L',
    ariaMac: 'Meta+Shift+L',
    ariaOther: 'Control+Shift+L',
  },
  deleteConversation: {
    labelKey: 'com_shortcut_delete_conversation',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ ⌫',
    displayOther: 'Ctrl+Shift+Backspace',
    ariaMac: 'Meta+Shift+Backspace',
    ariaOther: 'Control+Shift+Backspace',
  },
  submitMessage: {
    labelKey: 'com_shortcut_submit_message',
    groupKey: 'com_shortcut_group_general',
    displayMac: '⌘ ↵',
    displayOther: 'Ctrl+Enter',
    ariaMac: 'Meta+Enter',
    ariaOther: 'Control+Enter',
  },
  bookmarkConversation: {
    labelKey: 'com_shortcut_bookmark_conversation',
    groupKey: 'com_shortcut_group_navigation',
    displayMac: '⌘ ⇧ B',
    displayOther: 'Ctrl+Shift+B',
    ariaMac: 'Meta+Shift+B',
    ariaOther: 'Control+Shift+B',
  },
  continueResponse: {
    labelKey: 'com_shortcut_continue_response',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ C',
    displayOther: 'Ctrl+Shift+C',
    ariaMac: 'Meta+Shift+C',
    ariaOther: 'Control+Shift+C',
  },
  readAloudLastResponse: {
    labelKey: 'com_shortcut_read_aloud',
    groupKey: 'com_shortcut_group_chat',
    displayMac: '⌘ ⇧ V',
    displayOther: 'Ctrl+Shift+V',
    ariaMac: 'Meta+Shift+V',
    ariaOther: 'Control+Shift+V',
  },
  openAssistants: {
    labelKey: 'com_shortcut_open_assistants',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
  openAgents: {
    labelKey: 'com_shortcut_open_agents',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
  openPrompts: {
    labelKey: 'com_shortcut_open_prompts',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
  openMemories: {
    labelKey: 'com_shortcut_open_memories',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
  openParameters: {
    labelKey: 'com_shortcut_open_parameters',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
  openFiles: {
    labelKey: 'com_shortcut_open_files',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
  openBookmarks: {
    labelKey: 'com_shortcut_open_bookmarks',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
  openMCP: {
    labelKey: 'com_shortcut_open_mcp',
    groupKey: 'com_shortcut_group_panels',
    displayMac: '',
    displayOther: '',
    ariaMac: '',
    ariaOther: '',
  },
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutActionId = keyof typeof shortcutDefinitions;

/**
 * Shortcuts the window-level handler still runs while an input, textarea, or
 * contenteditable has focus. The composer yields chords bound to these by
 * leaving the keypress unclaimed (no `preventDefault`), so only one handler
 * acts on it.
 */
export const EDITING_ALLOWED_SHORTCUTS: ReadonlySet<ShortcutActionId> = new Set([
  'focusChat',
  'focusSearch',
  'showShortcuts',
  'submitMessage',
  'escalateSteer',
  'uploadFile',
]);

export type ShortcutAction = ShortcutDefinition & {
  id: ShortcutActionId;
  /** Returns `false` when the action was a no-op so the native key event is not prevented. */
  run: () => boolean | void;
};

const shortcutActionIds = Object.keys(shortcutDefinitions) as ShortcutActionId[];

function getMainScrollContainer(): Element | null {
  const end = document.getElementById('messages-end');
  let node: HTMLElement | null = end?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return document.querySelector('main[role="main"]');
}

function anyModalOpen(): boolean {
  const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  for (let i = 0; i < dialogs.length; i++) {
    const dialog = dialogs[i];
    if (dialog.hasAttribute('inert')) {
      continue;
    }
    if (dialog.getAttribute('data-state') === 'closed') {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Ariakit menus/popovers render a focus-trapped `role="menu"`/`role="listbox"` overlay rather
 * than a dialog, so they slip past {@link anyModalOpen}. When one is open its focused item is
 * the key event target, so checking the target's ancestry catches it without false positives
 * from hidden menus elsewhere in the tree.
 */
function isWithinOpenMenu(target: HTMLElement | null): boolean {
  return target instanceof Element && target.closest('[role="menu"], [role="listbox"]') != null;
}

function isUnavailableElement(el: HTMLElement): boolean {
  return (
    el.getAttribute('aria-disabled') === 'true' ||
    (el instanceof HTMLButtonElement && el.disabled) ||
    (el instanceof HTMLInputElement && el.disabled)
  );
}

function clickTarget(el: HTMLElement | null | undefined): boolean {
  if (!el || isUnavailableElement(el)) {
    return false;
  }
  el.click();
  return true;
}

function clickElement(selector: string): boolean {
  return clickTarget(document.querySelector<HTMLElement>(selector));
}

function clickLastElement(selector: string): boolean {
  const elements = document.querySelectorAll<HTMLElement>(selector);
  return clickTarget(elements[elements.length - 1]);
}

function defaultAria(actionId: ShortcutActionId): string {
  const def = shortcutDefinitions[actionId];
  return isMac ? def.ariaMac : def.ariaOther;
}

/**
 * Resolves one owner per chord, with persisted user choices ahead of defaults.
 *
 * This ordering matters when a release adds a new default chord that was
 * previously free: an existing custom binding must keep working instead of
 * being silently shadowed by the new action. Losers resolve to `null`, so the
 * dispatcher, shortcut dialog, tooltips, and `aria-keyshortcuts` all describe
 * the same effective ownership.
 */
export function resolveShortcutBindings(
  overrides: Record<string, ShortcutOverride>,
): Map<ShortcutActionId, ShortcutBinding | null> {
  const resolved = new Map<ShortcutActionId, ShortcutBinding | null>();
  const claimed = new Set<string>();
  const explicit = new Set<ShortcutActionId>();

  for (const id of shortcutActionIds) {
    const override = overrides[id];
    let platformValue: string | null | undefined;
    if (override != null) {
      platformValue = isMac ? override.mac : override.other;
    }
    /** Editing the other platform stores this platform's default alongside it.
     *  That copied default is not a user claim here and must still yield to a
     *  genuinely custom binding on the current platform. */
    if (platformValue === undefined || platformValue === defaultAria(id)) {
      continue;
    }
    explicit.add(id);
    const binding = parseBinding(platformValue);
    if (binding == null) {
      resolved.set(id, null);
      continue;
    }
    const hash = bindingHash(binding);
    if (claimed.has(hash)) {
      resolved.set(id, null);
      continue;
    }
    claimed.add(hash);
    resolved.set(id, binding);
  }

  for (const id of shortcutActionIds) {
    if (explicit.has(id)) {
      continue;
    }
    const binding = parseBinding(defaultAria(id));
    if (binding == null) {
      resolved.set(id, null);
      continue;
    }
    const hash = bindingHash(binding);
    if (claimed.has(hash)) {
      resolved.set(id, null);
      continue;
    }
    claimed.add(hash);
    resolved.set(id, binding);
  }

  return resolved;
}

function readOverridesFromStorage(): Record<string, ShortcutOverride> {
  if (typeof window === 'undefined') {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function effectiveBinding(
  actionId: ShortcutActionId,
  overrides?: Record<string, ShortcutOverride>,
): ShortcutBinding | null {
  const map = overrides ?? readOverridesFromStorage();
  return resolveShortcutBindings(map).get(actionId) ?? null;
}

export function getShortcutDisplay(actionId: ShortcutActionId): string {
  const binding = effectiveBinding(actionId);
  if (!binding) {
    return '';
  }
  return bindingDisplayString(binding, isMac);
}

export function getShortcutAriaKey(actionId: ShortcutActionId): string {
  const binding = effectiveBinding(actionId);
  if (!binding) {
    return '';
  }
  return bindingToString(binding) ?? '';
}

export function getShortcutHint(actionId: ShortcutActionId, label: string): string {
  const display = getShortcutDisplay(actionId);
  return display ? `${label} (${display})` : label;
}

export function isOverridden(actionId: ShortcutActionId, override?: ShortcutOverride): boolean {
  if (!override) return false;
  const platformValue = isMac ? override.mac : override.other;
  if (platformValue === null) return true;
  if (typeof platformValue !== 'string') return false;
  return platformValue !== defaultAria(actionId);
}

export function useShortcutActions(): ShortcutAction[] {
  const navigate = useNavigate();
  const localize = useLocalize();
  const { startNewChat, newConversation } = useNewChat();
  const { showToast } = useToastContext();
  const routeMatch = useMatch('/c/:conversationId');
  const routeConvoId = routeMatch?.params.conversationId ?? null;
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(0));
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const { setSidebarOpen, toggleSidebar } = useSidebarToggle();
  const setShowShortcutsDialog = useSetRecoilState(store.showShortcutsDialog);
  const setIsTemporary = useSetRecoilState(store.isTemporary);
  const setDeleteTarget = useSetRecoilState(store.keyboardDeleteTarget);
  const hasAccessToTemporaryChat = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });

  const archiveMutation = useArchiveConvoMutation();

  const handleShowShortcuts = useCallback(() => {
    setShowShortcutsDialog((prev) => !prev);
    return true;
  }, [setShowShortcutsDialog]);

  const handleNewChat = useCallback(() => {
    startNewChat();
    return true;
  }, [startNewChat]);

  const handleFocusChatInput = useCallback(() => {
    const textarea = document.getElementById(mainTextareaId) as HTMLTextAreaElement | null;
    if (!textarea) {
      return false;
    }
    textarea.focus();
    return true;
  }, []);

  const handleToggleSidebar = useCallback(() => {
    toggleSidebar();
    return true;
  }, [toggleSidebar]);

  const handleOpenModelSelector = useCallback(
    () => clickElement('[data-testid="model-selector-button"]'),
    [],
  );

  const handleFocusSearch = useCallback(() => {
    const focusSearchInput = () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[data-testid="nav-search-input"]',
      );
      if (!input) {
        return false;
      }
      input.focus();
      return true;
    };

    const panelButton = document.querySelector<HTMLButtonElement>(
      '[data-testid="nav-panel-conversations"]',
    );
    let switchedPanel = false;
    if (
      panelButton &&
      !isUnavailableElement(panelButton) &&
      panelButton.getAttribute('aria-pressed') !== 'true'
    ) {
      switchedPanel = true;
      panelButton.click();
    }

    if (!sidebarExpanded) {
      /** The focus rides `afterSlide` + a zero timer: it must queue behind
       * the deferred flip's commit (which un-inerts the drawer), where a
       * fixed 350ms guess could fire into the still-inert drawer and be
       * silently ignored. */
      setSidebarOpen(true, () => {
        setTimeout(focusSearchInput, 0);
      });
      return true;
    }

    if (switchedPanel) {
      setTimeout(focusSearchInput, 350);
      return true;
    }

    return focusSearchInput();
  }, [sidebarExpanded, setSidebarOpen]);

  const handleCopyLastResponse = useCallback(() => {
    return clickLastElement('[data-testid="copy-response-button"]');
  }, []);

  const handleCopyLastCode = useCallback(() => {
    const blocks = document.querySelectorAll('.agent-turn pre code');
    if (blocks.length === 0) {
      return false;
    }
    const last = blocks[blocks.length - 1];
    const text = last.textContent ?? '';
    if (!text.trim()) {
      return false;
    }
    return copy(text.trim(), { format: 'text/plain' });
  }, []);

  const handleStopGenerating = useCallback(
    () => clickElement('[data-testid="stop-generation-button"]'),
    [],
  );

  const handleRegenerateResponse = useCallback(
    () => clickElement('[data-testid="regenerate-generation-button"]'),
    [],
  );

  /** Escalate the newest waiting message to an interrupt by pressing its own
   *  visible arrow control, so the shortcut can never diverge from the
   *  button's semantics. A waiting steer bubble beats a queued follow-up (it
   *  is closer to the run); newest-last matches how both stacks append. */
  const handleEscalateSteer = useCallback(() => {
    const active = document.querySelector<HTMLButtonElement>('[data-escalate-steer-active="true"]');
    if (clickTarget(active)) {
      return true;
    }

    const pick = (surface: string) => {
      const list = document.querySelectorAll<HTMLButtonElement>(
        `[data-escalate-steer="${surface}"]`,
      );
      for (let i = list.length - 1; i >= 0; i--) {
        if (!isUnavailableElement(list[i])) {
          return list[i];
        }
      }
      return null;
    };
    return clickTarget(pick('bubble') ?? pick('queued'));
  }, []);

  const handleEditLastMessage = useCallback(() => {
    const userTurns = document.querySelectorAll('.user-turn');
    if (userTurns.length === 0) {
      return false;
    }
    const last = userTurns[userTurns.length - 1];
    const editBtn = last.querySelector<HTMLButtonElement>('button[id^="edit-"]');
    if (!editBtn) {
      return false;
    }
    editBtn.click();
    return true;
  }, []);

  const handleScrollToTop = useCallback(() => {
    const container = getMainScrollContainer();
    if (container) {
      container.scrollTo({ top: 0, behavior: 'smooth' });
      return true;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
  }, []);

  const handleScrollToBottom = useCallback(() => {
    const container = getMainScrollContainer();
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      return true;
    }
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    return true;
  }, []);

  const handleOpenSettings = useCallback(() => {
    const btn = document.querySelector<HTMLElement>('[data-testid="nav-user"]');
    if (!btn || isUnavailableElement(btn)) {
      return false;
    }
    const openSettingsItem = () => {
      const settingsItem = document.querySelector<HTMLElement>('[data-testid="nav-settings"]');
      return clickTarget(settingsItem);
    };
    if (btn.getAttribute('aria-expanded') === 'true') {
      return openSettingsItem();
    }
    btn.click();
    setTimeout(openSettingsItem, 150);
    return true;
  }, []);

  const handleToggleTemporaryChat = useCallback(() => {
    if (hasAccessToTemporaryChat !== true) {
      return false;
    }
    if (!routeConvoId) {
      return false;
    }
    const hasMessages = Array.isArray(conversation?.messages) && conversation.messages.length >= 1;
    if (hasMessages || isSubmitting) {
      return false;
    }
    setIsTemporary((prev) => !prev);
    return true;
  }, [
    hasAccessToTemporaryChat,
    routeConvoId,
    conversation?.messages,
    isSubmitting,
    setIsTemporary,
  ]);

  const handleUploadFile = useCallback(() => {
    const btn =
      document.querySelector<HTMLButtonElement>('#attach-file-menu-button') ??
      document.querySelector<HTMLButtonElement>('#attach-file-button') ??
      document.querySelector<HTMLButtonElement>('#attach-file');
    return clickTarget(btn);
  }, []);

  const handleArchiveConversation = useCallback(() => {
    const convoId = conversation?.conversationId;
    if (!convoId || convoId === 'new') {
      return false;
    }
    if (routeConvoId !== convoId) {
      return false;
    }
    if (archiveMutation.isLoading) {
      return false;
    }
    archiveMutation.mutate(
      { conversationId: convoId, isArchived: true },
      {
        onSuccess: () => {
          newConversation();
          navigate('/c/new', { replace: true });
        },
        onError: () => {
          showToast({
            message: localize('com_ui_archive_error'),
            severity: NotificationSeverity.ERROR,
            showIcon: true,
          });
        },
      },
    );
    return true;
  }, [
    localize,
    showToast,
    routeConvoId,
    archiveMutation,
    newConversation,
    navigate,
    conversation?.conversationId,
  ]);

  const handleDeleteConversation = useCallback(() => {
    const convoId = conversation?.conversationId;
    if (!convoId || convoId === 'new') {
      return false;
    }
    if (routeConvoId !== convoId) {
      return false;
    }
    setDeleteTarget({ conversationId: convoId, title: conversation?.title ?? '' });
    return true;
  }, [conversation?.conversationId, conversation?.title, routeConvoId, setDeleteTarget]);

  const handleSubmitMessage = useCallback(() => {
    const btn = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    return clickTarget(btn);
  }, []);

  const handleContinueResponse = useCallback(
    () => clickElement('[data-testid="continue-generation-button"]'),
    [],
  );

  const handleReadAloudLastResponse = useCallback(
    () => clickElement('[data-testid="read-aloud-button"]'),
    [],
  );

  const handleBookmarkConversation = useCallback(() => clickElement('#bookmark-menu-button'), []);

  const handleOpenPanel = useCallback(
    (panelId: string) => {
      const activatePanel = () => {
        const btn = document.querySelector<HTMLButtonElement>(
          `[data-testid="nav-panel-${panelId}"]`,
        );
        if (!btn || isUnavailableElement(btn)) {
          return false;
        }
        if (btn.getAttribute('aria-pressed') !== 'true') {
          btn.click();
          return true;
        }
        return false;
      };

      const btn = document.querySelector<HTMLButtonElement>(`[data-testid="nav-panel-${panelId}"]`);
      if (!btn || isUnavailableElement(btn)) {
        return false;
      }

      if (!sidebarExpanded) {
        /** Queued behind the deferred flip's commit, like the search focus
         * above — the panel button is unreachable while the drawer is
         * inert. */
        setSidebarOpen(true, () => {
          setTimeout(activatePanel, 0);
        });
        return true;
      }

      return activatePanel();
    },
    [sidebarExpanded, setSidebarOpen],
  );

  const handleOpenAssistants = useCallback(() => handleOpenPanel('assistants'), [handleOpenPanel]);
  const handleOpenAgents = useCallback(() => handleOpenPanel('agents'), [handleOpenPanel]);
  const handleOpenPrompts = useCallback(() => handleOpenPanel('prompts'), [handleOpenPanel]);
  const handleOpenMemories = useCallback(() => handleOpenPanel('memories'), [handleOpenPanel]);
  const handleOpenParameters = useCallback(() => handleOpenPanel('parameters'), [handleOpenPanel]);
  const handleOpenFiles = useCallback(() => handleOpenPanel('files'), [handleOpenPanel]);
  const handleOpenBookmarks = useCallback(() => handleOpenPanel('bookmarks'), [handleOpenPanel]);
  const handleOpenMCP = useCallback(() => handleOpenPanel('mcp-builder'), [handleOpenPanel]);

  const handlers = useMemo<Record<ShortcutActionId, () => boolean | void>>(
    () => ({
      showShortcuts: handleShowShortcuts,
      newChat: handleNewChat,
      focusChat: handleFocusChatInput,
      copyLastResponse: handleCopyLastResponse,
      uploadFile: handleUploadFile,
      toggleSidebar: handleToggleSidebar,
      openModelSelector: handleOpenModelSelector,
      focusSearch: handleFocusSearch,
      openSettings: handleOpenSettings,
      stopGenerating: handleStopGenerating,
      escalateSteer: handleEscalateSteer,
      regenerateResponse: handleRegenerateResponse,
      editLastMessage: handleEditLastMessage,
      copyLastCode: handleCopyLastCode,
      scrollToTop: handleScrollToTop,
      scrollToBottom: handleScrollToBottom,
      toggleTemporaryChat: handleToggleTemporaryChat,
      archiveConversation: handleArchiveConversation,
      deleteConversation: handleDeleteConversation,
      submitMessage: handleSubmitMessage,
      bookmarkConversation: handleBookmarkConversation,
      continueResponse: handleContinueResponse,
      readAloudLastResponse: handleReadAloudLastResponse,
      openAssistants: handleOpenAssistants,
      openAgents: handleOpenAgents,
      openPrompts: handleOpenPrompts,
      openMemories: handleOpenMemories,
      openParameters: handleOpenParameters,
      openFiles: handleOpenFiles,
      openBookmarks: handleOpenBookmarks,
      openMCP: handleOpenMCP,
    }),
    [
      handleShowShortcuts,
      handleNewChat,
      handleFocusChatInput,
      handleCopyLastResponse,
      handleUploadFile,
      handleToggleSidebar,
      handleOpenModelSelector,
      handleEscalateSteer,
      handleFocusSearch,
      handleOpenSettings,
      handleStopGenerating,
      handleRegenerateResponse,
      handleEditLastMessage,
      handleCopyLastCode,
      handleScrollToTop,
      handleScrollToBottom,
      handleToggleTemporaryChat,
      handleArchiveConversation,
      handleDeleteConversation,
      handleSubmitMessage,
      handleBookmarkConversation,
      handleContinueResponse,
      handleReadAloudLastResponse,
      handleOpenAssistants,
      handleOpenAgents,
      handleOpenPrompts,
      handleOpenMemories,
      handleOpenParameters,
      handleOpenFiles,
      handleOpenBookmarks,
      handleOpenMCP,
    ],
  );

  return useMemo(
    () =>
      shortcutActionIds.map((id) => ({
        id,
        ...shortcutDefinitions[id],
        run: handlers[id],
      })),
    [handlers],
  );
}

export function useShortcutDisplay(actionId?: ShortcutActionId): string {
  const overrides = useRecoilValue(store.customShortcuts);
  const enabled = useRecoilValue(store.shortcutsEnabled);
  return useMemo(() => {
    if (!actionId || !enabled) return '';
    const binding = resolveShortcutBindings(overrides).get(actionId) ?? null;
    return binding ? bindingDisplayString(binding, isMac) : '';
  }, [actionId, overrides, enabled]);
}

export function useShortcutAriaKey(actionId?: ShortcutActionId): string | undefined {
  const overrides = useRecoilValue(store.customShortcuts);
  const enabled = useRecoilValue(store.shortcutsEnabled);
  return useMemo(() => {
    if (!actionId || !enabled) return undefined;
    const binding = resolveShortcutBindings(overrides).get(actionId) ?? null;
    return binding ? (bindingToString(binding) ?? undefined) : undefined;
  }, [actionId, overrides, enabled]);
}

export function useShortcutHint(actionId: ShortcutActionId | undefined, label: string): string {
  const display = useShortcutDisplay(actionId);
  return display ? `${label} (${display})` : label;
}

export type ShortcutBindingInfo = {
  id: ShortcutActionId;
  binding: ShortcutBinding | null;
  isCustom: boolean;
  groupKey: string;
  labelKey: string;
};

export function useShortcutBindings(): {
  bindings: ShortcutBindingInfo[];
  bindingMap: Map<string, ShortcutActionId>;
  setBinding: (id: ShortcutActionId, binding: ShortcutBinding | null) => void;
  resetBinding: (id: ShortcutActionId) => void;
  resetAll: () => void;
} {
  const [overrides, setOverrides] = useRecoilState(store.customShortcuts);

  const resolvedBindings = useMemo(() => resolveShortcutBindings(overrides), [overrides]);

  const bindings = useMemo<ShortcutBindingInfo[]>(
    () =>
      shortcutActionIds.map((id) => {
        const def = shortcutDefinitions[id];
        const override = overrides[id];
        const binding = resolvedBindings.get(id) ?? null;
        return {
          id,
          binding,
          isCustom: isOverridden(id, override),
          groupKey: def.groupKey,
          labelKey: def.labelKey,
        };
      }),
    [overrides, resolvedBindings],
  );

  const bindingMap = useMemo<Map<string, ShortcutActionId>>(() => {
    const map = new Map<string, ShortcutActionId>();
    for (const info of bindings) {
      if (info.binding) {
        map.set(bindingHash(info.binding), info.id);
      }
    }
    return map;
  }, [bindings]);

  const setBinding = useCallback(
    (id: ShortcutActionId, binding: ShortcutBinding | null) => {
      setOverrides((prev) => {
        const next = { ...prev };
        const def = shortcutDefinitions[id];
        const platformKey: keyof ShortcutOverride = isMac ? 'mac' : 'other';
        const existing = next[id] ?? { mac: def.ariaMac, other: def.ariaOther };
        const updated: ShortcutOverride = { ...existing };
        updated[platformKey] = binding ? bindingToString(binding) : null;

        const matchesDefault = updated.mac === def.ariaMac && updated.other === def.ariaOther;

        if (matchesDefault) {
          delete next[id];
        } else {
          next[id] = updated;
        }
        return next;
      });
    },
    [setOverrides],
  );

  const resetBinding = useCallback(
    (id: ShortcutActionId) => {
      setOverrides((prev) => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [setOverrides],
  );

  const resetAll = useCallback(() => {
    setOverrides({});
  }, [setOverrides]);

  return { bindings, bindingMap, setBinding, resetBinding, resetAll };
}

export default function useKeyboardShortcuts() {
  const actions = useShortcutActions();
  const overrides = useRecoilValue(store.customShortcuts);
  const shortcutsDialogOpen = useRecoilValue(store.showShortcutsDialog);
  const shortcutsEnabled = useRecoilValue(store.shortcutsEnabled);

  const actionMap = useMemo(() => new Map(actions.map((action) => [action.id, action])), [actions]);

  const resolvedBindings = useMemo(() => resolveShortcutBindings(overrides), [overrides]);

  const bindingMap = useMemo<Map<string, ShortcutActionId>>(() => {
    const map = new Map<string, ShortcutActionId>();
    for (const id of shortcutActionIds) {
      const binding = resolvedBindings.get(id) ?? null;
      if (binding) {
        map.set(bindingHash(binding), id);
      }
    }
    return map;
  }, [resolvedBindings]);

  const handler = useCallback(
    (e: KeyboardEvent) => {
      if (!shortcutsEnabled) {
        return;
      }

      if (e.repeat) {
        return;
      }

      if (e.defaultPrevented) {
        return;
      }

      const binding = bindingFromEvent(e);
      if (!binding) {
        return;
      }

      const matchedId = bindingMap.get(bindingHash(binding));
      if (!matchedId) {
        return;
      }

      const target = e.target as HTMLElement | null;

      if (shortcutsDialogOpen) {
        if (matchedId !== 'showShortcuts') {
          return;
        }
      } else if (anyModalOpen() || isWithinOpenMenu(target)) {
        return;
      }

      const tagName = target?.tagName;
      const isEditing =
        tagName === 'INPUT' || tagName === 'TEXTAREA' || target?.isContentEditable === true;
      const isMainTextarea = target?.id === mainTextareaId;

      // The composer owns every Enter-based submit chord (native and custom), so defer all
      // Enter presses there; other editing contexts handle their own submit too.
      if (
        matchedId === 'submitMessage' &&
        ((isMainTextarea && e.key === 'Enter') || (isEditing && !isMainTextarea))
      ) {
        return;
      }

      if (isEditing && !EDITING_ALLOWED_SHORTCUTS.has(matchedId)) {
        return;
      }

      const handled = actionMap.get(matchedId)?.run();
      if (handled !== false) {
        e.preventDefault();
      }
    },
    [actionMap, bindingMap, shortcutsDialogOpen, shortcutsEnabled],
  );

  useEffect(() => {
    /** window, not document: every element- and document-level owner sits
     *  earlier in the bubble path, so their `preventDefault` claims are
     *  visible here regardless of mount or registration order. */
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}

export { isMac };
