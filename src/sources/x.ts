import type { Item, Profile } from "../types.js";

/**
 * X (Twitter) ingestion via the public syndication embed endpoint
 * (https://syndication.twitter.com/srv/timeline-profile/screen-name/<handle>).
 *
 * This is the same backend that powers Twitter's official embeddable timeline
 * widget. It is unauthenticated, undocumented, and rate-limited per source IP,
 * but it returns structured JSON inside the page's __NEXT_DATA__ script tag
 * and does not require API access. Reach is bounded to the most recent ~20-100
 * tweets that the syndication widget would render for a public profile —
 * comparable in spirit to what `fetchReddit` returns for Reddit, just smaller.
 *
 * Caveats (documented for the user in README):
 *   - Private / suspended / protected accounts return an empty timeline.
 *   - Some high-traffic profiles are intermittently blocked from the widget
 *     (returns 200 with `entries: []`); retrying or lowering request rate may
 *     help, but there is no auth path that this scraper can fall back to.
 *   - The endpoint is not officially supported by X; format may change.
 */

const TIMELINE_URL =
  "https://syndication.twitter.com/srv/timeline-profile/screen-name";

interface SyndicationUser {
  screen_name?: string;
  name?: string;
  description?: string;
  url?: string;
  entities?: {
    url?: { urls?: Array<{ expanded_url?: string }> };
    description?: { urls?: Array<{ expanded_url?: string }> };
  };
  location?: string;
}

interface SyndicationTweet {
  id_str: string;
  full_text?: string;
  text?: string;
  created_at: string;
  permalink?: string;
  user?: SyndicationUser;
  in_reply_to_screen_name?: string;
  in_reply_to_status_id_str?: string;
  retweeted_status?: SyndicationTweet;
  quoted_tweet?: SyndicationTweet;
  entities?: {
    urls?: Array<{ expanded_url?: string; url?: string }>;
    user_mentions?: Array<{ screen_name?: string }>;
    hashtags?: Array<{ text?: string }>;
    media?: Array<{ expanded_url?: string }>;
  };
  self_thread?: { id_str?: string };
}

interface SyndicationEntry {
  type?: string;
  entry_id?: string;
  content?: {
    tweet?: SyndicationTweet;
  };
}

interface NextData {
  props?: {
    pageProps?: {
      timeline?: { entries?: SyndicationEntry[] };
      headerProps?: { screenName?: string };
    };
  };
}

const NEXT_DATA_RE =
  /<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 deanonymizer/0.1 (privacy self-audit)";

function parseCreatedAt(raw: string): number {
  // Twitter's syndication format: "Wed Sep 11 19:31:57 +0000 2024"
  const t = Date.parse(raw);
  if (Number.isFinite(t)) return Math.floor(t / 1000);
  return Math.floor(Date.now() / 1000);
}

function tweetBody(t: SyndicationTweet): string {
  const main = (t.full_text ?? t.text ?? "").trim();
  const expandedUrls = (t.entities?.urls ?? [])
    .map((u) => u.expanded_url)
    .filter((u): u is string => Boolean(u));
  const mediaUrls = (t.entities?.media ?? [])
    .map((m) => m.expanded_url)
    .filter((u): u is string => Boolean(u));
  const tail = [...expandedUrls, ...mediaUrls];
  return tail.length ? `${main}\n${tail.join("\n")}` : main;
}

function tweetPermalink(t: SyndicationTweet, fallbackUser: string): string {
  if (t.permalink) return `https://x.com${t.permalink}`;
  const screen = t.user?.screen_name ?? fallbackUser;
  return `https://x.com/${screen}/status/${t.id_str}`;
}

function tweetContext(t: SyndicationTweet, subject: string): string {
  if (t.retweeted_status) {
    const original = t.retweeted_status.user?.screen_name;
    return original ? `retweet of @${original}` : "retweet";
  }
  if (t.in_reply_to_screen_name && t.in_reply_to_screen_name !== subject) {
    return `reply to @${t.in_reply_to_screen_name}`;
  }
  if (t.quoted_tweet) {
    const original = t.quoted_tweet.user?.screen_name;
    return original ? `quote of @${original}` : "quote";
  }
  return "tweet";
}

function profileUrlFromUser(user: SyndicationUser | undefined): string | undefined {
  const direct = user?.entities?.url?.urls?.[0]?.expanded_url;
  if (direct) return direct;
  return user?.url;
}

async function fetchTimelineHtml(user: string): Promise<string> {
  // showReplies=true asks the syndication widget to include replies/retweets,
  // which is the broadest signal surface for the privacy audit.
  const url = new URL(`${TIMELINE_URL}/${encodeURIComponent(user)}`);
  url.searchParams.set("showReplies", "true");

  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (res.status === 404) return "";
  if (!res.ok) {
    throw new Error(`X syndication ${res.status}: ${await res.text()}`);
  }
  return await res.text();
}

function extractNextData(html: string): NextData | undefined {
  const m = html.match(NEXT_DATA_RE);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]) as NextData;
  } catch {
    return undefined;
  }
}

export async function fetchX(username: string, max: number): Promise<Profile> {
  const user = username.replace(/^@/, "").trim();

  const html = await fetchTimelineHtml(user);
  const data = html ? extractNextData(html) : undefined;
  const entries = data?.props?.pageProps?.timeline?.entries ?? [];

  const items: Item[] = [];
  let profileUserRecord: SyndicationUser | undefined;

  for (const entry of entries) {
    const t = entry?.content?.tweet;
    if (!t || !t.id_str) continue;

    // Capture the subject's profile record from the first tweet authored by
    // them; it carries the bio/url/location fields useful for proof URLs.
    if (
      !profileUserRecord &&
      t.user?.screen_name?.toLowerCase() === user.toLowerCase()
    ) {
      profileUserRecord = t.user;
    }

    const body = tweetBody(t);
    if (!body) continue;

    const isRetweet = Boolean(t.retweeted_status);
    items.push({
      platform: "x",
      id: t.id_str,
      kind: isRetweet ? "post" : "comment",
      context: tweetContext(t, user),
      body,
      createdUtc: parseCreatedAt(t.created_at),
      permalink: tweetPermalink(t, user),
    });

    if (items.length >= max) break;
  }

  items.sort((a, b) => b.createdUtc - a.createdUtc);

  const externalUrl = profileUrlFromUser(profileUserRecord);
  const items2: Item[] = items;

  // Surface the bio + linked URL as a synthetic item so the LLM stage sees
  // self-disclosures (location, "I work at", external links) even when the
  // timeline itself is sparse — same shape as a regular tweet.
  if (profileUserRecord?.description || externalUrl) {
    const bioParts: string[] = [];
    if (profileUserRecord?.description) bioParts.push(profileUserRecord.description);
    if (profileUserRecord?.location)
      bioParts.push(`location: ${profileUserRecord.location}`);
    if (externalUrl) bioParts.push(externalUrl);
    const bio = bioParts.join("\n").trim();
    if (bio) {
      items2.unshift({
        platform: "x",
        id: `${user}-bio`,
        kind: "post",
        context: "profile bio",
        body: bio,
        createdUtc: items[0]?.createdUtc ?? Math.floor(Date.now() / 1000),
        permalink: `https://x.com/${encodeURIComponent(user)}`,
      });
    }
  }

  return {
    platform: "x",
    username: user,
    profileUrl: `https://x.com/${encodeURIComponent(user)}`,
    items: items2,
    firstUtc: items2.length ? items2[items2.length - 1].createdUtc : undefined,
    lastUtc: items2.length ? items2[0].createdUtc : undefined,
  };
}
