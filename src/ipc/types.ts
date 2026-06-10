export interface MessageContext {
  platform: string;
  channelId: string;
  channelName?: string;
  threadId: string | null;
  authorId: string;
  authorName: string;
  text: string;
  isMention: boolean;
  isDm: boolean;
  isBot: boolean;
  attachments: Array<{ name: string; url: string }>;
}

export interface SerializedMessage {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  attachments: Array<{ name: string; url: string }>;
  createdAt: string;
}

/** Gateway → Worker: inbound Discord events */
export type G2WEvent =
  | { type: 'discord.message'; ctx: MessageContext; threadKey: string; msgId: string; channelId: string }
  | { type: 'discord.reaction'; emoji: string; msgId: string; channelId: string; userId: string; isOwner: boolean; isThread: boolean }
  | { type: 'discord.button'; customId: string; channelId: string; msgId: string; interactionId: string; token: string };

/** Gateway → Worker: responses to requests */
export type G2WResponse =
  | { type: 'ipc.ok'; reqId: string; data?: unknown }
  | { type: 'ipc.err'; reqId: string; error: string };

export type G2W = G2WEvent | G2WResponse;

/** Worker → Gateway: lifecycle + Discord API requests */
export type W2G =
  | { type: 'worker.ready' }
  | { type: 'worker.drain' }
  | { type: 'discord.send'; reqId: string; channelId: string; content: string }
  | { type: 'discord.send.file'; reqId: string; channelId: string; filePath: string; caption?: string }
  | { type: 'discord.send.url'; reqId: string; channelId: string; url: string; caption?: string }
  | { type: 'discord.send.components'; reqId: string; channelId: string; content: string; components: unknown[] }
  | { type: 'discord.thread.create'; reqId: string; channelId: string; msgId: string; name: string }
  | { type: 'discord.thread.delete'; reqId: string; channelId: string }
  | { type: 'discord.message.delete'; channelId: string; msgId: string }
  | { type: 'discord.typing.start'; channelId: string }
  | { type: 'discord.typing.stop'; channelId: string }
  | { type: 'discord.fetch.message'; reqId: string; channelId: string; msgId: string }
  | { type: 'discord.fetch.messages'; reqId: string; channelId: string; limit: number; before?: string }
  | { type: 'discord.fetch.starter'; reqId: string; channelId: string }
  | { type: 'discord.interaction.reply'; reqId: string; interactionId: string; token: string; content: string; ephemeral?: boolean };
