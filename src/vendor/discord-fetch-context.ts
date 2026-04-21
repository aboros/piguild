const THREAD_CONVERSATION_KEY = /^piguild:(\d+):thread:(\d+)$/;

export interface DiscordFetchContext {
  channelId: string;
  guildId?: string;
  /** When set, the first page uses `before: anchorMessageId` unless the tool passes `before_message_id`. */
  anchorMessageId?: string;
}

export function resolveDiscordFetchContext(
  conversationKey: string,
  explicit?: DiscordFetchContext,
): DiscordFetchContext | undefined {
  if (explicit) {
    return explicit;
  }

  const match = THREAD_CONVERSATION_KEY.exec(conversationKey);
  if (match) {
    const guildId = match[1];
    const channelId = match[2];
    return { channelId, guildId };
  }

  return undefined;
}
