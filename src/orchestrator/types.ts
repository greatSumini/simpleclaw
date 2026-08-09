import type { RepoEntry } from '../config.js';
import type { MessageContext } from '../messenger/types.js';

export type { MessageContext };
// Kept as alias so existing internal references in discord.ts compile without churn.
export type DiscordMessageContext = MessageContext;

export type RouteDecision =
  | { kind: 'trivial'; answer: string }
  | { kind: 'repo-work'; repo: RepoEntry; instructions?: string }
  | { kind: 'simpleclaw-maintenance'; instructions?: string }
  | { kind: 'wiki-ingest' }
  | { kind: 'root' }
  | { kind: 'ignore'; reason: string };

export interface MailAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface MailSummary {
  /** Recipient account email — the inbox this mail landed in. */
  account: string;
  /** Gmail message id */
  messageId: string;
  /** Gmail thread id */
  threadId: string;
  /** Sender — display + email, e.g. "Foo Bar <foo@bar.com>" */
  from: string;
  /** Bare sender email, lowercased canonical */
  fromEmail: string;
  subject: string;
  /** ISO 8601 received timestamp */
  receivedAtIso: string;
  /** Gmail's snippet field — short preview */
  snippet: string;
  /** Optional plain-text body. The classifier truncates internally. */
  bodyText?: string;
  /** Attachments detected in the Gmail message. */
  attachments?: MailAttachment[];
}

export type ImportanceVerdict =
  | {
      kind: 'important';
      oneLineSummary: string;
      suggestedActions: string[];
      contextNotes?: string;
    }
  | { kind: 'ambiguous'; oneLineSummary: string; reason: string }
  | { kind: 'ignore'; reason: string };

export type { RepoEntry };
