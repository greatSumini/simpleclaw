// Platform-agnostic messenger abstractions.
// Each platform adapter (Discord, Telegram, …) implements MessengerAdapter
// and normalises its native messages into MessageContext.

export interface MessageContext {
  /** Adapter-reported platform identifier, e.g. 'discord', 'telegram'. */
  platform: string;
  channelId: string;
  /** Channel name, e.g. "vmc-context-hub". Optional — not all platforms expose it. */
  channelName?: string;
  /** null = top-level message (not inside a thread/reply chain) */
  threadId: string | null;
  authorId: string;
  authorName: string;
  text: string;
  /** True if claw was @-mentioned in this message. */
  isMention: boolean;
  /** True if this message arrived via a direct/private conversation. */
  isDm: boolean;
  /** True if the message author is a bot (defense-in-depth filter). */
  isBot: boolean;
  attachments?: Array<{ name: string; url: string }>;
}

/** Minimal interface required by GmailAdapter to post mail-alert threads. */
export interface MailAlertPoster {
  postMailAlert(args: {
    channelId: string;
    threadName: string;
    initialMessage: string;
    /** Full mail body posted as the first message inside the thread. */
    threadFirstMessage?: string;
    /** Local file paths uploaded as attachments in the thread. */
    attachmentFiles?: { path: string; filename: string }[];
    /** When provided, an "이 발신자 무시" button is attached to the first message. */
    senderEmail?: string;
    senderAccount?: string;
  }): Promise<{ threadId: string; firstMessageId: string }>;
  postToChannel(channelId: string, content: string): Promise<void>;
}

/** Full adapter contract shared by all messenger integrations. */
export interface MessengerAdapter extends MailAlertPoster {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  postToChannel(channelId: string, content: string): Promise<void>;
  /**
   * Send a file attachment to a thread (or channel-level if threadId is null).
   * `filePath` must be an absolute local path that exists at call time.
   */
  sendFile(args: {
    channelId: string;
    threadId: string | null;
    filePath: string;
    caption?: string;
  }): Promise<void>;
}
