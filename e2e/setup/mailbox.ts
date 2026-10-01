const DEFAULT_MAILBOX_URL = 'http://127.0.0.1:8025';

export interface MailboxMessage {
  id: number;
  from: string;
  to: string[];
  subject: string;
  body: string;
  urls: string[];
}

interface MailboxResponse {
  messages: MailboxMessage[];
}

interface MessageFilter {
  to: string;
  subject: string;
}

function mailboxURL(pathname: string): URL {
  return new URL(pathname, process.env.E2E_MAILBOX_URL ?? DEFAULT_MAILBOX_URL);
}

async function readMessages(url: URL): Promise<MailboxMessage[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to read E2E mailbox: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as MailboxResponse).messages;
}

export async function clearMailbox(): Promise<void> {
  const response = await fetch(mailboxURL('/messages'), { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`Failed to clear E2E mailbox: ${response.status} ${await response.text()}`);
  }
}

async function findMessages(filter: MessageFilter): Promise<MailboxMessage[]> {
  const url = mailboxURL('/messages');
  url.searchParams.set('to', filter.to);
  url.searchParams.set('subject', filter.subject);
  return readMessages(url);
}

export async function getMailboxMessages(): Promise<MailboxMessage[]> {
  return readMessages(mailboxURL('/messages'));
}

export async function waitForMessage(
  filter: MessageFilter,
  timeout = 15_000,
): Promise<MailboxMessage> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const [message] = await findMessages(filter);
    if (message) {
      return message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for email "${filter.subject}" to ${filter.to}`);
}

export function getVerificationURL(message: MailboxMessage, baseURL: string): string {
  const expectedOrigin = new URL(baseURL).origin;
  const verificationURL = message.urls.find((candidate) => {
    const url = new URL(candidate);
    return url.origin === expectedOrigin && url.pathname === '/verify';
  });
  if (!verificationURL) {
    throw new Error(`No verification URL found in email "${message.subject}"`);
  }
  return verificationURL;
}
