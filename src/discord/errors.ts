/** Short user-facing error strings for Discord. */
export function truncateErrorMessage(text: string, verbose = false): string {
  if (verbose) {
    return text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
  }

  if (/\b429\b/i.test(text) || /rate.limit|quota.exceeded/i.test(text)) {
    return "Provider Error: Rate limited.";
  }

  if (/Unknown Message/i.test(text)) {
    return "Message was deleted or unavailable.";
  }
  if (/Unknown Interaction|Interaction has already been acknowledged/i.test(text)) {
    return "Interaction expired. Please retry the command.";
  }

  const sentence = (text.split(/[.\n]/)[0] || "").trim().replace(/\s+/g, " ");
  return sentence.length > 150 ? `${sentence.slice(0, 147)}...` : sentence;
}
