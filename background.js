const { t } = globalThis.TpngI18n;

// Sign-in and publishing currently use bsky.social. This is a fixed
// service choice, not general PDS discovery. Revisit before claiming
// support for other AT Protocol personal data servers.
const BLUESKY_PDS_URL = "https://bsky.social";
const BLUESKY_COMPOSE_URL = "https://bsky.app/intent/compose?text=#tpng-toolbar-launch";
const LAUNCH_MESSAGE_TIMEOUT_MS = 12000;
const LAUNCH_MESSAGE_RETRY_MS = 150;
const SESSION_STORAGE_KEY = "bskySession";
// Removal migration runs on background startup. Never restore old disk tokens.
// Await this before serving any privileged request, so a transient storage
// failure fails closed instead of silently retaining developer credentials.
const legacySessionCleanup = browser.storage.local.remove("rememberedBskySession");
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 2_000_000;
const MAX_POST_GRAPHEMES = 300;
const MAX_POST_UTF8_BYTES = 3000;
// Keep our composer Alt text policy enforced at the privileged publication boundary.
const MAX_ALT_CHARACTERS = 1000;
// One-use account-verification tickets, issued only by bsky.app content scripts.
// Never trust an embedded extension iframe to supply its own browser tab ID.
const ACCOUNT_TICKET_LIFETIME_MS = 15000;
const pendingAccountTickets = new Map();
// Authenticates one-way content-script -> extension-panel control commands.
// Firefox runtime messaging keeps this token out of the webpage. Never send it
// in panel -> parent postMessage traffic (which the webpage can observe).
const PANEL_BRIDGE_STORAGE_KEY = "privatePanelBridgeSecret";
let panelBridgeSecretPromise = null;
async function getPanelBridgeSecret() {
  if (!panelBridgeSecretPromise) {
    panelBridgeSecretPromise = (async () => {
      const stored = await browser.storage.session.get(PANEL_BRIDGE_STORAGE_KEY);
      const existing = stored[PANEL_BRIDGE_STORAGE_KEY];
      if (typeof existing === "string" && /^[0-9a-f-]{36}$/i.test(existing)) {
        return existing;
      }
      const fresh = globalThis.crypto?.randomUUID?.();
      if (!fresh) throw new Error("No secure random source for the panel bridge");
      await browser.storage.session.set({ [PANEL_BRIDGE_STORAGE_KEY]: fresh });
      return fresh;
    })().catch((error) => {
      panelBridgeSecretPromise = null;
      throw error;
    });
  }
  return panelBridgeSecretPromise;
}
const ACCOUNT_TICKET_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


function countGraphemes(text) {
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].length;
  }
  return [...text].length;
}

function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const bodyText = await response.text();

  let data = null;
  try {
    data = JSON.parse(bodyText);
  } catch (_) {}

  if (!response.ok) {
    const detail = data?.message || data?.error || bodyText || `HTTP ${response.status}`;
    const error = new Error(`${response.status}: ${detail}`);
    error.status = response.status;
    error.atprotoError = data?.error || null;
    throw error;
  }

  return data;
}

// Retain only the four fields required for authentication in memory.
// The PDS session response may include profile/email data we don't need;
// no session tokens are written to persistent extension storage.
function forStoredSession(session) {
  // The session response can also contain profile data (including email).
  return {
    did: session.did,
    handle: session.handle,
    accessJwt: session.accessJwt,
    refreshJwt: session.refreshJwt,
  };
}

async function getStoredSession() {
  const stored = await browser.storage.session.get(SESSION_STORAGE_KEY);
  return stored[SESSION_STORAGE_KEY] || null;
}

async function storeSession(session) {
  await browser.storage.session.set({ [SESSION_STORAGE_KEY]: forStoredSession(session) });
}

async function clearSession() {
  await browser.storage.session.remove(SESSION_STORAGE_KEY);
}

async function broadcastSessionChangedToBlueskyTabs(session) {
  const tabs = await browser.tabs.query({ url: "https://bsky.app/*" });

  await Promise.all(
    tabs.map((tab) => (
      typeof tab.id === "number"
        ? browser.tabs.sendMessage(
            tab.id,
            { type: "sessionChanged", session: session || null },
          ).catch(() => null)
        : Promise.resolve()
    )),
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchFreshComposerPanel() {
  const tab = await browser.tabs.create({ url: BLUESKY_COMPOSE_URL, active: true });
  if (typeof tab?.id !== "number") {
    throw new Error(t("firefoxDidNotReturnNewTab"));
  }

  const deadline = Date.now() + LAUNCH_MESSAGE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const result = await browser.tabs.sendMessage(tab.id, {
        type: "openFreshComposerPanel",
      });

      if (result) {
        return result;
      }
    } catch (_) {
      // The content script is not ready yet. Retry while the new tab loads.
    }

    await delay(LAUNCH_MESSAGE_RETRY_MS);
  }

  return {
    ok: false,
    error: t("newBlueskyTabNotReady"),
  };
}

// One outstanding refresh per extension background script. Refresh JWTs rotate,
// so concurrent expired uploads must share a single refresh request.
let refreshInFlight = null;

function isExpiredAccessToken(error) {
  // The PDS normally returns HTTP 400 with error: ExpiredToken.
  // Keep 401 as a fallback for older servers without a structured code.
  return error?.atprotoError === "ExpiredToken" || error?.status === 401;
}

function isRejectedRefreshToken(error) {
  // A network failure, rate limit, or 5xx is NOT a reason to sign out.
  return error?.atprotoError === "ExpiredToken" ||
    error?.atprotoError === "InvalidToken" || error?.status === 401;
}

async function recoverExpiredSession(expiredSession) {
  if (refreshInFlight) {
    const refreshed = await refreshInFlight;
    if (refreshed.did !== expiredSession.did) {
      throw new Error(t("sessionExpiredSignInAgain"));
    }
    return refreshed;
  }

  const pending = (async () => {
    const current = await getStoredSession();
    if (!current || current.did !== expiredSession.did) {
      throw new Error(t("sessionExpiredSignInAgain"));
    }
    if (current.accessJwt !== expiredSession.accessJwt) return current;

    let refreshed;
    try {
      refreshed = await requestJson(
        `${BLUESKY_PDS_URL}/xrpc/com.atproto.server.refreshSession`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${current.refreshJwt}` },
        },
      );
    } catch (error) {
      if (!isRejectedRefreshToken(error)) throw error;

      // Never invalidate a different login (or newer rotated refresh token).
      const latest = await getStoredSession();
      if (latest?.did === current.did && latest.refreshJwt === current.refreshJwt) {
        await clearSession();
        try {
          await broadcastSessionChangedToBlueskyTabs(null);
        } catch (_) {
          // Sign-out still succeeded if a tab was closed during broadcast.
        }
      }
      throw new Error(t("sessionExpiredSignInAgain"));
    }

    if (!refreshed?.accessJwt || !refreshed?.refreshJwt || refreshed.did !== current.did) {
      throw new Error(t("invalidRefreshedSession"));
    }
    const latest = await getStoredSession();
    if (!latest || latest.did !== current.did) {
      throw new Error(t("sessionExpiredSignInAgain"));
    }
    if (latest.refreshJwt !== current.refreshJwt) return latest;
    await storeSession(refreshed);
    return refreshed;
  })();

  refreshInFlight = pending;
  try {
    return await pending;
  } finally {
    if (refreshInFlight === pending) refreshInFlight = null;
  }
}

async function withAuthenticatedSession(operation) {
  const session = await getStoredSession();
  if (!session) throw new Error(t("notSignedInError"));

  try {
    return await operation(session);
  } catch (error) {
    if (!isExpiredAccessToken(error) || !session.refreshJwt) throw error;

    const refreshed = await recoverExpiredSession(session);
    // One retry, never a loop. Failed authentication rejects before creating
    // the post, so this does not retry an ambiguously successful response.
    return operation(refreshed);
  }
}

async function login(identifier, password) {
  if (!identifier || !password) {
    throw new Error(t("enterCredentials"));
  }

  let session;

  try {
    session = await requestJson(
      `${BLUESKY_PDS_URL}/xrpc/com.atproto.server.createSession`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ identifier, password }),
      },
    );
  } catch (error) {
    // Preserve useful server diagnostics for unknown failures, but don't put
    // HTTP codes or protocol phrases in front of users for common cases.
    if (error?.status === 401) {
      throw new Error(t("invalidCredentials"));
    }
    if (error?.status === 429) {
      throw new Error(t("signInRateLimited"));
    }
    if (error?.status >= 500 && error.status < 600) {
      throw new Error(t("signInUnavailable"));
    }
    if (error?.name === "TypeError") {
      // Firefox fetch rejects with TypeError on network failures.
      throw new Error(t("signInConnectionFailed"));
    }
    throw error;
  }

  await storeSession(session);
  return { did: session.did, handle: session.handle };
}

async function uploadPng(bytes, expectedDid) {
  if (!(bytes instanceof ArrayBuffer)) {
    throw new Error(t("invalidPngUploadPayload"));
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(t("pngLargerThanBlueskyLimit"));
  }
  if (typeof expectedDid !== "string" || !expectedDid.startsWith("did:")) {
    throw new Error(t("blueskyPageAccountUnavailable"));
  }

  // Check on every attempt, including after access-token refresh. A popup
  // sign-in can replace the extension session while the PNG composer uploads.
  // Never transfer an image using a different account's bearer token.
  return withAuthenticatedSession(async (session) => {
    if (session.did !== expectedDid) {
      throw new Error(t("blueskyAccountChangedWhilePosting"));
    }
    const response = await fetch(
      `${BLUESKY_PDS_URL}/xrpc/com.atproto.repo.uploadBlob`,
      {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          Authorization: `Bearer ${session.accessJwt}`,
        },
        body: bytes,
      },
    );

    const bodyText = await response.text();
    let data = null;
    try {
      data = JSON.parse(bodyText);
    } catch (_) {}

    if (!response.ok) {
      const detail = data?.message || data?.error || bodyText || t("imageUploadFailed");
      const error = new Error(`${response.status}: ${detail}`);
      error.status = response.status;
      error.atprotoError = data?.error || null;
      throw error;
    }

    return data.blob;
  });
}

function validatePostText(text) {
  if (typeof text !== "string") {
    throw new Error(t("invalidPostText"));
  }

  if (countGraphemes(text) > MAX_POST_GRAPHEMES || utf8Length(text) > MAX_POST_UTF8_BYTES) {
    throw new Error(t("postTextLongerThanAllowed"));
  }
}

function normalizePostLanguages(languages) {
  if (languages === undefined || languages === null) {
    return [];
  }

  if (!Array.isArray(languages) || languages.length > 3) {
    throw new Error(t("invalidPostLanguages"));
  }

  const normalized = [];
  for (const language of languages) {
    if (typeof language !== "string" || !language.trim()) {
      throw new Error(t("invalidPostLanguages"));
    }

    let canonical;
    try {
      canonical = Intl.getCanonicalLocales(language.trim())[0];
    } catch (_) {
      throw new Error(t("invalidPostLanguages"));
    }

    if (!canonical || normalized.includes(canonical)) {
      if (!canonical) {
        throw new Error(t("invalidPostLanguages"));
      }
      continue;
    }
    normalized.push(canonical);
  }

  return normalized;
}

function validateImageEmbed(image) {
  if (!image?.blob || typeof image.alt !== "string") {
    throw new Error(t("invalidImageAttachment"));
  }

  if (!image.alt.trim()) {
    throw new Error(t("everyImageNeedsAltText"));
  }

  if (image.alt.length > MAX_ALT_CHARACTERS) {
    throw new Error(t("altTextLongerThanAllowed"));
  }

  const width = Number(image.aspectRatio?.width);
  const height = Number(image.aspectRatio?.height);

  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(t("invalidImageDimensions"));
  }
}

// Link facets annotate the existing text: offsets are UTF-8 byte positions,
// not JavaScript UTF-16 indices. Keep detection local and conservative;
// unrecognized URLs remain ordinary post text.
function detectLinkFacets(text) {
  const facets = [];
  const matches = text.matchAll(/https?:\/\/[^\s<>"'`]+/giu);

  for (const match of matches) {
    const start = match.index;
    // Don't annotate a protocol-looking substring embedded in a word/handle.
    if (start > 0 && /[\p{L}\p{N}_@]/u.test(text[start - 1])) continue;

    let candidate = match[0];
    // Trim sentence punctuation and closing delimiters that lack an opening
    // counterpart within the URL; retain balanced parentheses in URL paths.
    while (candidate) {
      const last = candidate.at(-1);
      if (/[.,;:!?。！？、]/u.test(last)) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      const pair = { ")": "(", "]": "[", "}": "{" }[last];
      if (pair && [...candidate].filter((char) => char === last).length >
        [...candidate].filter((char) => char === pair).length) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      break;
    }

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch (_) {
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname.includes('.') ||
      parsed.username || parsed.password) continue;

    facets.push({
      index: {
        byteStart: utf8Length(text.slice(0, start)),
        byteEnd: utf8Length(text.slice(0, start + candidate.length)),
      },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: parsed.href }],
    });
  }

  return facets;
}

// Hashtag facets share the same original UTF-8 post text as link facets.
// Avoid partial word matches and overlaps with URLs (including URL fragments).
// Deliberately conservative: Unicode letters, numbers, combining marks and
// underscore; unsupported hashtag forms are left as ordinary text.
function detectHashtagFacets(text, linkFacets) {
  const facets = [];
  const matches = text.matchAll(/#([\p{L}\p{N}\p{M}_]+)/gu);

  for (const match of matches) {
    const start = match.index;
    if (start > 0 && /[\p{L}\p{N}\p{M}_#]/u.test(text[start - 1])) continue;

    const tag = match[1];
    // Match Bluesky's rich-text behavior: a tag containing only numbers
    // (including Unicode numeric characters) stays ordinary post text.
    if (/^\p{N}+$/u.test(tag)) continue;
    // AT Protocol limits tags to 64 graphemes and 640 UTF-8 bytes.
    // Skip oversize tokens instead of linking a misleading partial tag.
    if (countGraphemes(tag) > 64 || utf8Length(tag) > 640) continue;

    const byteStart = utf8Length(text.slice(0, start));
    const byteEnd = utf8Length(text.slice(0, start + match[0].length));
    if (linkFacets.some((facet) =>
      byteStart < facet.index.byteEnd && byteEnd > facet.index.byteStart)) continue;

    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }

  return facets;
}

// Mention facets require resolving visible handles to stable account DIDs.
// Restrict this first implementation to ordinary ASCII DNS-style handles;
// avoid email-address false positives, partial matches, and URL overlaps.
// Invalid or unresolvable handles remain literal text, never guessed DIDs.
function findMentionCandidates(text, occupiedFacets) {
  const candidates = [];
  const matches = text.matchAll(/@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g);
  for (const match of matches) {
    const start = match.index;
    if (start > 0 && /[\p{L}\p{N}\p{M}_@.\/-]/u.test(text[start - 1])) continue;
    const handle = match[1];
    const end = start + match[0].length;
    // Never facet a prefix of a longer malformed identifier.
    if (end < text.length && /[\p{L}\p{N}\p{M}_@-]/u.test(text[end])) continue;
    if (handle.length > 253 || !handle.split('.').every(label =>
      label.length >= 1 && label.length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) continue;
    // A DNS-like final label must start with a letter, not be all-numeric.
    if (!/^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$/.test(handle.split('.').at(-1))) continue;

    const byteStart = utf8Length(text.slice(0, start));
    const byteEnd = utf8Length(text.slice(0, end));
    if (occupiedFacets.some(facet =>
      byteStart < facet.index.byteEnd && byteEnd > facet.index.byteStart)) continue;
    candidates.push({ handle: handle.toLowerCase(), byteStart, byteEnd });
  }
  return candidates;
}

async function detectMentionFacets(text, occupiedFacets) {
  const candidates = findMentionCandidates(text, occupiedFacets);
  // Reuse a result for repeated mentions of the same handle within one post.
  const resolutions = new Map();
  const lookup = (handle) => {
    if (!resolutions.has(handle)) {
      resolutions.set(handle, (async () => {
        try {
          const endpoint = new URL(`${BLUESKY_PDS_URL}/xrpc/com.atproto.identity.resolveHandle`);
          endpoint.searchParams.set('handle', handle);
          const data = await requestJson(endpoint.toString(), {
            signal: AbortSignal.timeout(4000),
          });
          return typeof data?.did === 'string' &&
            /^did:(?:plc|web):[A-Za-z0-9._:%-]+$/.test(data.did) ? data.did : null;
        } catch (_) {
          // HandleNotFound, connection errors and lookup timeouts are nonfatal.
          return null;
        }
      })());
    }
    return resolutions.get(handle);
  };

  const results = await Promise.all(candidates.map(async ({ handle, byteStart, byteEnd }) => ({
    handle, did: await lookup(handle), byteStart, byteEnd,
  })));
  return {
    facets: results.filter(({ did }) => did).map(({ did, byteStart, byteEnd }) => ({
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
    })),
    unresolvedHandles: [...new Set(results.filter(({ did }) => !did).map(({ handle }) => handle))],
  };
}

function mentionFacetsForText(text) {
  const links = detectLinkFacets(text);
  const occupied = [...links, ...detectHashtagFacets(text, links)];
  return { occupied };
}

async function checkPostMentions(text) {
  validatePostText(text);
  const { occupied } = mentionFacetsForText(text);
  const { unresolvedHandles } = await detectMentionFacets(text, occupied);
  return { unresolvedHandles };
}

async function createImagePost(text, images, languages, approvedUnresolvedHandles = [], expectedDid) {
  if (typeof expectedDid !== "string" || !expectedDid.startsWith("did:")) {
    throw new Error(t("blueskyPageAccountUnavailable"));
  }
  validatePostText(text);
  const normalizedLanguages = normalizePostLanguages(languages);
  const { occupied: existingFacets } = mentionFacetsForText(text);

  if (!Array.isArray(images) || images.length < 1 || images.length > MAX_IMAGES) {
    throw new Error(t("postMustContainOneToFourImages"));
  }

  images.forEach(validateImageEmbed);

  const createdAt = new Date().toISOString();
  // The panel checked the intended account earlier, but the extension
  // session could have changed during image uploads. Confirm the publisher
  // again using the session that actually creates the post.
  return withAuthenticatedSession(async (session) => {
    if (session.did !== expectedDid) {
      throw new Error(t("blueskyAccountChangedWhilePosting"));
    }
    const { facets: mentionFacets, unresolvedHandles } = await detectMentionFacets(text, existingFacets);
    const approved = new Set(
      Array.isArray(approvedUnresolvedHandles)
        ? approvedUnresolvedHandles.filter((handle) => typeof handle === 'string')
            .map((handle) => handle.toLowerCase())
        : [],
    );
    const unapproved = unresolvedHandles.filter((handle) => !approved.has(handle));
    if (unapproved.length) {
      const error = new Error(t('unresolvedMentionsWarning', [unapproved.map((h) => '@' + h).join(', ')]));
      error.code = 'unresolvedMentions';
      error.handles = unapproved;
      throw error;
    }
    const facets = [...existingFacets, ...mentionFacets]
      .sort((a, b) => a.index.byteStart - b.index.byteStart);
    const record = {
      $type: "app.bsky.feed.post",
      text,
      createdAt,
      ...(facets.length ? { facets } : {}),
      ...(text.trim() && normalizedLanguages.length ? { langs: normalizedLanguages } : {}),
      embed: {
        $type: "app.bsky.embed.images",
        images: images.map((image) => ({
          alt: image.alt.trim(),
          image: image.blob,
          aspectRatio: image.aspectRatio,
        })),
      },
    };

    // Construct the request before starting the irreversible network operation.
    const requestBody = JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    });
    let result;
    let recordKey;
    try {
      result = await requestJson(
        `${BLUESKY_PDS_URL}/xrpc/com.atproto.repo.createRecord`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.accessJwt}`,
          },
          body: requestBody,
        },
      );
      // A successful HTTP response without a usable record reference does
      // not prove failure: the record may already exist on Bluesky.
      const uriPrefix = `at://${session.did}/app.bsky.feed.post/`;
      if (typeof result?.uri !== "string" || !result.uri.startsWith(uriPrefix) ||
          typeof result.cid !== "string" || !result.cid) {
        throw new Error("Invalid createRecord response");
      }
      recordKey = result.uri.slice(uriPrefix.length);
      if (!recordKey || recordKey.includes("/")) {
        throw new Error("Invalid createRecord record key");
      }
    } catch (error) {
      // A rejected 4xx response (other than timeout) is an explicit failure;
      // ExpiredToken can still follow the established single-refresh path.
      // Network interruption, 408, 5xx, or malformed successful responses
      // leave the outcome uncertain. Never automatically submit again.
      const status = error?.status;
      if (!Number.isInteger(status) || status === 408 || status >= 500) {
        const uncertain = new Error(t("publicationOutcomeUncertain"));
        uncertain.code = "publicationOutcomeUncertain";
        throw uncertain;
      }
      throw error;
    }
    const postUrl = `https://bsky.app/profile/${encodeURIComponent(session.handle)}/post/${encodeURIComponent(recordKey)}`;

    return {
      uri: result.uri,
      cid: result.cid,
      postUrl,
      handle: session.handle,
    };
  });
}

browser.runtime.onMessage.addListener(async (message, sender) => {
  // Sender identity is supplied by Firefox, never by the message body.
  // Extension pages have stable moz-extension URLs even when an embedded
  // panel iframe has no sender.tab metadata. Website content scripts may
  // obtain only the private panel bridge secret and register account tickets;
  // they cannot invoke publishing or authentication operations.
  const fromPopup = sender?.url === browser.runtime.getURL("popup.html");
  const fromPanel = sender?.url === browser.runtime.getURL("panel.html");
  const fromUserInterface = fromPopup || fromPanel;
  const denied = () => ({ ok: false, error: "Unexpected extension message sender" });
  try {
    // Migration must finish before any session read, login, or upload.
    await legacySessionCleanup;
    switch (message?.type) {
      case "getPanelBridgeSecret": {
        const fromTopLevelBlueskyContent = /^https:\/\/bsky\.app\//.test(sender?.url || "") &&
          Number.isInteger(sender?.tab?.id) &&
          (sender.frameId == null || sender.frameId === 0);
        if (!fromPanel && !fromTopLevelBlueskyContent) return denied();
        // Session storage survives a transient event-page restart, so an
        // already-open panel retains its authenticated bridge.
        return { ok: true, secret: await getPanelBridgeSecret() };
      }

      case "registerPanelAccountTicket": {
        // sender.tab is provided for content scripts, but may be missing for
        // extension iframe messages. Only a top-level bsky.app content script
        // may bind a cryptographically generated ticket to a tab.
        if (!/^https:\/\/bsky\.app\//.test(sender?.url || "") ||
            !Number.isInteger(sender?.tab?.id) ||
            (sender.frameId != null && sender.frameId !== 0) ||
            !ACCOUNT_TICKET_RE.test(message.ticket || "")) {
          return { ok: false, diagnostic: "REGISTER-SENDER-REJECTED" };
        }
        const now = Date.now();
        for (const [ticket, record] of pendingAccountTickets) {
          if (record.expiresAt <= now) pendingAccountTickets.delete(ticket);
        }
        // Bound memory even if many Bluesky tabs are repeatedly opened.
        if (pendingAccountTickets.size >= 128) return { ok: false, diagnostic: "TICKET-CAPACITY" };
        // The trusted top-level content script samples the website session
        // when its actual PNG panel requests verification. Do not re-read it
        // later in a background-triggered content-script callback: that path
        // returned an empty account in live Firefox despite page storage.
        // Validate and copy only DID + handle, never credentials or storage.
        const candidate = message.account;
        const account = typeof candidate?.did === "string" &&
          /^did:(?:plc|web):[a-zA-Z0-9.:%_-]+$/.test(candidate.did)
          ? { did: candidate.did, handle: typeof candidate.handle === "string" ? candidate.handle : "" }
          : null;
        pendingAccountTickets.set(message.ticket, {
          tabId: sender.tab.id,
          account,
          expiresAt: now + ACCOUNT_TICKET_LIFETIME_MS,
        });
        return { ok: true };
      }

      case "getBlueskyActiveAccount": {
        // A panel cannot be relied upon to have sender.tab in Firefox.
        // Instead, consume a one-use ticket registered by a trusted content
        // script in the tab. Website scripts cannot call these runtime APIs.
        if (sender?.url !== browser.runtime.getURL("panel.html") ||
            !ACCOUNT_TICKET_RE.test(message.ticket || "")) {
          return { ok: false, account: null, diagnostic: "PANEL-SENDER-REJECTED" };
        }
        const record = pendingAccountTickets.get(message.ticket);
        pendingAccountTickets.delete(message.ticket); // Never replay.
        if (!record || record.expiresAt <= Date.now()) {
          return { ok: false, account: null, diagnostic: "TICKET-NOT-FOUND" };
        }
        // The identity was captured and validated by our top-level content
        // script at ticket registration, and never passed through the page.
        // Keep an absent/invalid website account fail-closed.
        if (!record.account) {
          return { ok: true, account: null, diagnostic: "SITE-ACCOUNT-EMPTY" };
        }
        return { ok: true, account: record.account };
      }

      case "getSession": {
        if (!fromUserInterface) return denied();
        const session = await getStoredSession();
        return {
          ok: true,
          session: session ? { did: session.did, handle: session.handle } : null,
        };
      }

      case "login": {
        if (!fromUserInterface) return denied();
        const session = await login(message.identifier, message.password);
        await broadcastSessionChangedToBlueskyTabs(session);
        return { ok: true, session };
      }

      case "logout":
        if (!fromUserInterface) return denied();
        await clearSession();
        await broadcastSessionChangedToBlueskyTabs(null);
        return { ok: true };

      case "launchFreshComposerPanel":
        if (!fromPopup) return denied();
        return await launchFreshComposerPanel();

      case "uploadPng":
        if (!fromPanel) return denied();
        return { ok: true, blob: await uploadPng(message.bytes, message.expectedDid) };

      case "checkPostMentions":
        if (!fromPanel) return denied();
        return { ok: true, ...await checkPostMentions(message.text) };

      case "createImagePost":
        if (!fromPanel) return denied();
        return {
          ok: true,
          post: await createImagePost(
            message.text, message.images, message.languages, message.approvedUnresolvedHandles,
            message.expectedDid,
          ),
        };

      default:
        return undefined;
    }
  } catch (error) {
    return {
      ok: false,
      error: error.message || String(error),
      ...(message?.type === "getBlueskyActiveAccount" ? { diagnostic: "BACKGROUND-EXCEPTION" } : {}),
      ...(error.code === 'unresolvedMentions' ? { code: error.code, handles: error.handles } : {}),
      ...(error.code === 'publicationOutcomeUncertain' ? { code: error.code } : {}),
    };
  }
});
