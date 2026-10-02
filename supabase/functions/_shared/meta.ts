import { GRAPH_BASE } from "./env.ts";
import { credentials } from "./account.ts";
import type { MessageContent } from "./types.ts";

export class MetaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message);
    this.name = "MetaError";
  }

  /** Retrying these will never work: the queue row should fail, not back off forever. */
  get permanent(): boolean {
    if (this.status === 400 || this.status === 403) return true;
    // 10: permission denied, 100: bad parameter, 551: user cannot be messaged
    return this.code === 10 || this.code === 100 || this.code === 551;
  }
}

/** Only plain web links may leave as buttons; anything else (javascript:, data:) is refused. */
function safeUrl(url: string): string {
  if (!/^https?:\/\//i.test(url.trim())) {
    throw new MetaError(`Button link must start with https:// (got "${url.slice(0, 40)}")`, 400);
  }
  return url.trim();
}

async function call(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const { token } = await credentials();
  const res = await fetch(`${GRAPH_BASE()}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (body as { error?: Record<string, unknown> }).error ?? {};
    throw new MetaError(
      String(err.message ?? `Graph API returned ${res.status}`),
      res.status,
      err.code as number | undefined,
      err.error_subcode as number | undefined,
    );
  }
  return body as Record<string, unknown>;
}

/**
 * Turn flow node content into a Send API message object.
 *
 * Buttons ride in a button template, which draws them under the message itself. Quick replies
 * would put them above the keyboard instead, detached from the message they belong to.
 */
export function buildMessage(content: MessageContent): Record<string, unknown> {
  // Gallery / carousel: a generic template of up to 10 cards, each with image, text and buttons.
  const cards = (content.cards ?? []).slice(0, 10);
  if (cards.length) {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: cards.map((c) => ({
            title: (c.title || " ").slice(0, 80),
            subtitle: c.subtitle ? c.subtitle.slice(0, 80) : undefined,
            image_url: c.imageUrl || undefined,
            buttons: (c.buttons ?? []).slice(0, 3).map((b) =>
              b.url
                ? { type: "web_url", url: safeUrl(b.url), title: b.title.slice(0, 20) }
                : { type: "postback", title: b.title.slice(0, 20), payload: b.payload },
            ),
          })),
        },
      },
    };
  }

  // A non-image media attachment (audio, video, file) sent by URL.
  if (content.attachment?.url) {
    return {
      attachment: {
        type: content.attachment.type,
        payload: { url: content.attachment.url, is_reusable: true },
      },
    };
  }

  if (content.imageUrl) {
    return { attachment: { type: "image", payload: { url: content.imageUrl, is_reusable: true } } };
  }

  // Quick replies (collect prompts): they ride above the keyboard, which is where a list of
  // choices and a Skip belong. Instagram allows up to 13, 20 characters each.
  const quick = (content.quickReplies ?? []).slice(0, 13);
  if (quick.length) {
    return {
      text: (content.text ?? "").slice(0, 1000),
      quick_replies: quick.map((q) => ({
        content_type: "text",
        title: q.title.slice(0, 20),
        payload: q.payload,
      })),
    };
  }

  const buttons = (content.buttons ?? []).slice(0, 3); // Instagram allows three
  if (buttons.length) {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: (content.text ?? "").slice(0, 640),
          buttons: buttons.map((b) =>
            b.url
              ? { type: "web_url", url: safeUrl(b.url), title: b.title.slice(0, 20) }
              : { type: "postback", title: b.title.slice(0, 20), payload: b.payload },
          ),
        },
      },
    };
  }

  return { text: content.text ?? "" };
}

/**
 * A private reply answers one comment, exactly once. It does not open the 24-hour window,
 * so the message it carries must invite a reply.
 */
export async function sendPrivateReply(commentId: string, content: MessageContent) {
  const { igUserId } = await credentials();
  return call(`/${igUserId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: buildMessage(content),
    }),
  });
}

/** A normal DM. Only legal inside the 24-hour window. Never carries a message tag. */
export async function sendDirectMessage(igsid: string, content: MessageContent) {
  const { igUserId } = await credentials();
  return call(`/${igUserId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      recipient: { id: igsid },
      message: buildMessage(content),
    }),
  });
}

/**
 * A message from a human agent. Inside 24h it is a normal DM; between 24h and 7 days it must
 * carry the HUMAN_AGENT tag. Only ever called from the inbox — automation must not use this.
 */
export async function sendHumanMessage(igsid: string, content: MessageContent, tagged: boolean) {
  const { igUserId } = await credentials();
  const body: Record<string, unknown> = {
    recipient: { id: igsid },
    message: buildMessage(content),
  };
  if (tagged) {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "HUMAN_AGENT";
  }
  return call(`/${igUserId}/messages`, { method: "POST", body: JSON.stringify(body) });
}

/** Write Ice Breakers / Persistent Menu via the Messenger Profile API. */
export function setMessengerProfile(profile: Record<string, unknown>) {
  return call(`/me/messenger_profile`, { method: "POST", body: JSON.stringify(profile) });
}

/** Take Ice Breakers and/or the Persistent Menu off the account (an empty list is not accepted). */
export function deleteMessengerProfile(fields: ("ice_breakers" | "persistent_menu")[]) {
  const query = `fields=${encodeURIComponent(JSON.stringify(fields))}&platform=instagram`;
  return call(`/me/messenger_profile?${query}`, { method: "DELETE" });
}

/**
 * Post a PUBLIC reply under a comment (the "reply to their comment too" step). This is separate
 * from the private reply DM — it shows up publicly beneath the comment, so keep it short and
 * generic ("Sent! Check your DMs"). Never carries personal data.
 */
export function replyToComment(commentId: string, message: string) {
  return call(`/${commentId}/replies`, { method: "POST", body: JSON.stringify({ message }) });
}

/**
 * User Profile API. Fails if the contact has never messaged the account, so only call this
 * after their first reply.
 */
export async function fetchFollowState(
  igsid: string,
): Promise<{ follows: boolean; username?: string }> {
  const body = await call(`/${igsid}?fields=is_user_follow_business,username`, { method: "GET" });
  return {
    follows: body.is_user_follow_business === true,
    username: typeof body.username === "string" ? body.username : undefined,
  };
}

/** Name, username and picture for Live Chat (User Profile API, same rule as above). */
export async function fetchProfile(igsid: string): Promise<{
  name?: string;
  username?: string;
  profile_pic?: string;
  follows: boolean;
}> {
  const body = await call(`/${igsid}?fields=name,username,profile_pic,is_user_follow_business`, { method: "GET" });
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    name: str(body.name),
    username: str(body.username),
    profile_pic: str(body.profile_pic),
    follows: body.is_user_follow_business === true,
  };
}

/** Verify Meta signed this exact body with the app secret. */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const received = header.slice("sha256=".length);
  if (received.length !== expected.length) return false;

  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
