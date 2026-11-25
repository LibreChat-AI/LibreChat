import { createContext } from 'react';
import type { TAttachment } from 'librechat-data-provider';
import type { Context } from 'react';

/**
 * The MCP App attachments a message draws as rows of their own. A card or group below reads it
 * so the App views among its files stand down for those and each App is drawn once. The
 * attachments stay with their owning parts for files, search rows and outcome metadata, and
 * object identity keeps independently owned nested attachments visible.
 */
export const AppSuppressionContext: Context<ReadonlySet<TAttachment> | null> =
  createContext<ReadonlySet<TAttachment> | null>(null);
