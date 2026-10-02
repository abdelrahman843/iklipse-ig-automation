// Content patterns that get Instagram accounts flagged as spam, checked as the user types. They
// warn, never block: the user decides. Sources: Manychat's help centre (vary public replies, avoid
// very short or emoji-only ones), its Acceptable Use Policy (no masked link destinations) and the
// restriction reports in its community (links typed into the first message).

const SHORTENERS = [
  "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly",
  "rebrand.ly", "shorturl.at", "rb.gy", "tiny.cc", "s.id", "t.ly", "v.gd", "shorte.st",
];

/** A link written into the message text rather than put on a button. */
export function linkInText(text?: string): boolean {
  return /(https?:\/\/|www\.)\S+/i.test(text ?? "");
}

/** A link through a URL shortener, which hides where it really goes. */
export function shortenedLink(url?: string): boolean {
  const v = (url ?? "").trim().toLowerCase();
  if (!v) return false;
  try {
    const host = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`).hostname.replace(/^www\./, "");
    return SHORTENERS.includes(host);
  } catch {
    return false;
  }
}

/** Why a public reply under a comment reads as a bot, or null when it is fine. */
export function weakPublicReply(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (!/\p{L}/u.test(t)) return "Emoji-only replies are flagged as spam. Add a few words.";
  if (t.length < 15) return "Very short replies are flagged as spam. Write a full sentence.";
  return null;
}

/** Problems with the set of public replies as a whole, or null when it is fine. */
export function weakReplySet(replies: string[]): string | null {
  const lines = replies.map((r) => r.trim().toLowerCase()).filter(Boolean);
  if (!lines.length) return null;
  if (new Set(lines).size < lines.length) return "Two replies are the same. Each one should read differently.";
  if (lines.length < 3) return "Add at least 3 versions. The same reply under many comments is what gets accounts flagged.";
  return null;
}

export const LINK_IN_TEXT_HINT = "Links typed into the text are a common spam signal. Put the link on a button instead.";
export const SHORTENED_LINK_HINT = "Use the full link. Shortened links hide where they go and get flagged.";
