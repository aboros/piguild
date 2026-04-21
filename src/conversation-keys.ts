/** Persistent session in a thread. */
export function threadConversationKey(guildId: string, threadId: string): string {
  return `piguild:${guildId}:thread:${threadId}`;
}

/** Persistent DM session per Discord user. */
export function dmConversationKey(userId: string): string {
  return `piguild:dm:${userId}`;
}
