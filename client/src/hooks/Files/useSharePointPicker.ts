import { useRef, useCallback } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import type { SPPickerConfig } from '~/components/SidePanel/Agents/config';
import { useLocalize, useAuthContext } from '~/hooks';
import { useGetStartupConfig } from '~/data-provider';
import useSharePointToken from './useSharePointToken';
import store from '~/store';

interface UseSharePointPickerProps {
  containerNode: HTMLDivElement | null;
  onFilesSelected?: (files: any[]) => void;
  onClose?: () => void;
  disabled?: boolean;
  maxSelectionCount?: number;
}

interface UseSharePointPickerReturn {
  openSharePointPicker: () => void;
  closeSharePointPicker: () => void;
  error: string | null;
  cleanup: () => void;
  isTokenLoading: boolean;
}

export default function useSharePointPicker({
  containerNode,
  onFilesSelected,
  onClose,
  disabled = false,
  maxSelectionCount = 10,
}: UseSharePointPickerProps): UseSharePointPickerReturn {
  const [langcode] = useRecoilState(store.lang);
  const { user } = useAuthContext();
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const portRef = useRef<MessagePort | null>(null);
  const channelIdRef = useRef<string>('');

  const { data: startupConfig } = useGetStartupConfig();

  const sharePointBaseUrl = startupConfig?.sharePointBaseUrl;
  const isEntraIdUser = user?.provider === 'openid';

  const {
    token,
    isLoading: isTokenLoading,
    error: tokenError,
  } = useSharePointToken({
    enabled: isEntraIdUser && !disabled && !!sharePointBaseUrl,
    purpose: 'Pick',
  });

  const generateChannelId = useCallback(() => {
    return `sharepoint-picker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  const portMessageHandler = useCallback(
    async (message: MessageEvent) => {
      const port = portRef.current;
      if (!port) {
        console.error('No port available for communication');
        return;
      }

      try {
        switch (message.data.type) {
          case 'notification':
            console.log('SharePoint picker notification:', message.data);
            break;

          case 'command': {
            // Always acknowledge the command first
            port.postMessage({
              type: 'acknowledge',
              id: message.data.id,
            });

            const command = message.data.data;
            console.log('SharePoint picker command:', command);

            switch (command.command) {
              case 'authenticate':
                console.log('Authentication requested, providing token');
                console.log('Command details:', command); // Add this line
                console.log('Token available:', !!token?.access_token); // Add this line
                if (token?.access_token) {
                  port.postMessage({
                    type: 'result',
                    id: message.data.id,
                    data: {
                      result: 'token',
                      token: token.access_token,
                    },
                  });
                } else {
                  console.error('No token available for authentication');
                  port.postMessage({
                    type: 'result',
                    id: message.data.id,
                    data: {
                      result: 'error',
                      error: {
                        code: 'noToken',
                        message: 'No authentication token available',
                      },
                    },
                  });
                }
                break;

              case 'close':
                console.log('Close command received');
                port.postMessage({
                  type: 'result',
                  id: message.data.id,
                  data: {
                    result: 'success',
                  },
                });
                onClose?.();
                break;

              case 'pick': {
                console.log('Files picked from SharePoint:', command);

                const items = command.items || command.files || [];
                console.log('Extracted items:', items);

                if (items && items.length > 0) {
                  const selectedFiles = items.map((item: any) => ({
                    id: item.id || item.shareId || item.driveItem?.id,
                    name: item.name || item.driveItem?.name,
                    size: item.size || item.driveItem?.size,
                    webUrl: item.webUrl || item.driveItem?.webUrl,
                    downloadUrl:
                      item.downloadUrl || item.driveItem?.['@microsoft.graph.downloadUrl'],
                    driveId:
                      item.driveId ||
                      item.parentReference?.driveId ||
                      item.driveItem?.parentReference?.driveId,
                    itemId: item.id || item.driveItem?.id,
                    sharePointItem: item,
                  }));

                  console.log('Processed SharePoint files:', selectedFiles);

                  if (onFilesSelected) {
                    onFilesSelected(selectedFiles);
                  }

                  showToast({
                    message: `Selected ${selectedFiles.length} file(s) from SharePoint`,
                    status: 'success',
                  });
                }

                port.postMessage({
                  type: 'result',
                  id: message.data.id,
                  data: {
                    result: 'success',
                  },
                });
                break;
              }

              default:
                console.warn(`Unsupported command: ${command.command}`);
                port.postMessage({
                  type: 'result',
                  id: message.data.id,
                  data: {
                    result: 'error',
                    error: {
                      code: 'unsupportedCommand',
                      message: command.command,
                    },
                  },
                });
                break;
            }
            break;
          }

          default:
            console.log('Unknown message type:', message.data.type);
            break;
        }
      } catch (error) {
        console.error('Error processing port message:', error);
      }
    },
    [token, onFilesSelected, showToast, onClose],
  );

  // Initialization message handler - establishes MessagePort communication
  const initMessageHandler = useCallback(
    (event: MessageEvent) => {
      console.log('=== SharePoint picker init message received ===');
      console.log('Event source:', event.source);
      console.log('Event data:', event.data);
      console.log('Expected channelId:', channelIdRef.current);

      // Check if this message is from our iframe
      if (event.source && event.source === iframeRef.current?.contentWindow) {
        const message = event.data;

        if (message.type === 'initialize' && message.channelId === channelIdRef.current) {
          console.log('Establishing MessagePort communication');

          // Get the MessagePort from the event
          portRef.current = event.ports[0];

          if (portRef.current) {
            // Set up the port message listener
            portRef.current.addEventListener('message', portMessageHandler);
            portRef.current.start();

            // Send activate message to start the picker
            portRef.current.postMessage({
              type: 'activate',
            });

            console.log('MessagePort established and activated');
          } else {
            console.error('No MessagePort found in initialize event');
          }
        }
      }
    },
    [portMessageHandler],
  );

  const openSharePointPicker = async () => {
    if (!token) {
      showToast({
        message: 'Unable to access SharePoint. Please ensure you are logged in with Microsoft.',
        status: 'error',
      });
      return;
    }

    if (!containerNode) {
      console.error('No container ref provided for SharePoint picker');
      return;
    }

    try {
      const channelId = generateChannelId();
      channelIdRef.current = channelId;

      console.log('=== SharePoint File Picker v8 (MessagePort) ===');
      console.log('Token available:', {
        hasToken: !!token.access_token,
        tokenType: token.token_type,
        expiresIn: token.expires_in,
        scopes: token.scope,
      });
      console.log('Channel ID:', channelId);

      const pickerOptions: SPPickerConfig = {
        sdk: '8.0',
        entry: {
          sharePoint: {},
        },
        messaging: {
          origin: window.location.origin,
          channelId: channelId,
        },
        authentication: {
          enabled: false, // Host app handles authentication
        },
        typesAndSources: {
          mode: 'files',
          pivots: {
            oneDrive: true,
            recent: true,
            shared: true,
            sharedLibraries: true,
            myOrganization: true,
            site: true,
          },
        },
        selection: {
          mode: 'multiple',
          /** Without this the picker drops the current selection every time the user
           * opens another folder or switches pivot, so a selection can only ever be
           * assembled from one location. */
          enablePersistence: true,
          maximumCount: maxSelectionCount,
        },
        title: localize('com_files_sharepoint_picker_title'),
        commands: {
          upload: {
            enabled: false,
          },
          createFolder: {
            enabled: false,
          },
        },
        search: { enabled: true },
      };

      const iframe = document.createElement('iframe');
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.background = '#F5F5F5';
      iframe.style.border = 'none';
      iframe.title = 'SharePoint File Picker';
      iframe.setAttribute(
        'sandbox',
        'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox',
      );
      iframeRef.current = iframe;

      containerNode.innerHTML = '';
      containerNode.appendChild(iframe);

      activeEventListenerRef.current = initMessageHandler;
      window.addEventListener('message', initMessageHandler);

      iframe.src = 'about:blank';
      iframe.onload = () => {
        const win = iframe.contentWindow;
        if (!win) return;

        const queryString = new URLSearchParams({
          filePicker: JSON.stringify(pickerOptions),
          locale: langcode || 'en-US',
        });

        const url = sharePointBaseUrl + `/_layouts/15/FilePicker.aspx?${queryString}`;

        const form = win.document.createElement('form');
        form.setAttribute('action', url);
        form.setAttribute('method', 'POST');

        const tokenInput = win.document.createElement('input');
        tokenInput.setAttribute('type', 'hidden');
        tokenInput.setAttribute('name', 'access_token');
        tokenInput.setAttribute('value', token.access_token);
        form.appendChild(tokenInput);

        win.document.body.appendChild(form);
        form.submit();
      };
    } catch (error) {
      console.error('SharePoint file picker error:', error);
      showToast({
        message: 'Failed to open SharePoint file picker.',
        status: 'error',
      });
    }
  };
  const activeEventListenerRef = useRef<((event: MessageEvent) => void) | null>(null);

  const cleanup = useCallback(() => {
    if (activeEventListenerRef.current) {
      window.removeEventListener('message', activeEventListenerRef.current);
      activeEventListenerRef.current = null;
    }
    if (portRef.current) {
      portRef.current.close();
      portRef.current = null;
    }
    if (containerNode) {
      containerNode.innerHTML = '';
    }
    channelIdRef.current = '';
  }, [containerNode]);

  const handleDialogClose = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const isAvailable = startupConfig?.sharePointFilePickerEnabled && isEntraIdUser && !tokenError;

  return {
    openSharePointPicker: isAvailable ? openSharePointPicker : () => {},
    closeSharePointPicker: handleDialogClose,
    error: tokenError ? 'Failed to authenticate with SharePoint' : null,
    cleanup,
    isTokenLoading,
  };
}
