(() => {
  const { t } = globalThis.TpngI18n;

  if (window.top !== window) {
    return;
  }

  const LAUNCHER_ID = "bsky-tpng-launch";
  const PANEL_DIALOG_ID = "bsky-tpng-dialog";
  const PANEL_RETURN_ID = "bsky-tpng-return";
  const PANEL_MIN_HEIGHT = 300;
  const PANEL_MAX_HEIGHT = 900;
  const PANEL_MAX_WIDTH = 680;
  const VIEWPORT_MARGIN = 12;
  const PANEL_ORIGIN = browser.runtime.getURL("panel.html").replace(/\/panel\.html$/, "");
  const COMPOSER_GONE_DELAY_MS = 750;
  const MAINTENANCE_INTERVAL_MS = 1500;
  const NATIVE_COMPOSER_OPEN_TIMEOUT_MS = 8000;
  const PENDING_FRESH_LAUNCH_TTL_MS = 5 * 60 * 1000;
  const PENDING_FRESH_LAUNCH_STORAGE_KEY = "bskyTpngPendingFreshLaunchUntil";
  const TOOLBAR_LAUNCH_ABANDONED_KEY = "bskyTpngToolbarLaunchAbandoned";
  const BLUESKY_HOME_URL = "https://bsky.app/";

  let launcher = null;
  let panelDialog = null;
  let panelFrame = null;
  let panelReturnButton = null;
  let panelSuspended = false;
  let stopPendingReturnFocusHandoff = null;
  let suspendCleanupInFlight = false;
  let cancelRecoveryInFlight = false;
  let panelFrameReady = false;
  // A privileged one-way capability; never send it to the Bluesky page.
  // Obtain it only if an actual PNG panel needs a control message.
  let panelBridgeSecretPromise = null;
  function getPanelBridgeSecret() {
    if (!panelBridgeSecretPromise) {
      panelBridgeSecretPromise = browser.runtime.sendMessage({
        type: "getPanelBridgeSecret",
      }).then((result) => result?.ok === true && typeof result.secret === "string"
        ? result.secret : null).catch(() => {
        panelBridgeSecretPromise = null; // A later attempt may recover.
        return null;
      });
    }
    return panelBridgeSecretPromise;
  }

  function sendToPanel(message) {
    const targetFrame = panelFrame;
    if (!targetFrame) return;
    void getPanelBridgeSecret().then((secret) => {
      if (secret && panelFrame === targetFrame && targetFrame.contentWindow) {
        targetFrame.contentWindow.postMessage({ ...message, bridgeSecret: secret }, PANEL_ORIGIN);
      }
    });
  }
  let pendingPanelOpen = null;
  let panelOpenSequence = 0;
  let panelReturnFocusTarget = null;
  let panelLaunchOrigin = "native";
  let hiddenComposer = null;
  let hiddenComposerTextbox = null;
  let hiddenComposerDisplay = "";
  let composerTextSnapshot = "";
  let pngImagesAtRisk = false;
  let navigationWarningInstalled = false;

  // Protect a live PNG draft from accidental full-document navigation. SPA
  // navigation within Bluesky does not unload the document and is unaffected.
  // This is not persistence: if the user confirms leaving, the draft is lost.
  function warnBeforeDiscardingDraft(event) {
    event.preventDefault();
    event.returnValue = ""; // Legacy Firefox support; browsers own the text.
  }

  function updateNavigationWarning() {
    const activeDraft = Boolean(panelFrame && !panelFrame.hidden &&
      (composerTextSnapshot.trim() || pngImagesAtRisk));
    if (activeDraft === navigationWarningInstalled) return;
    navigationWarningInstalled = activeDraft;
    if (activeDraft) {
      window.addEventListener("beforeunload", warnBeforeDiscardingDraft);
    } else {
      window.removeEventListener("beforeunload", warnBeforeDiscardingDraft);
    }
  }
  // Frozen native text captured before entering our editor. Unlike the live
  // draft snapshot, this is not updated when the PNG draft changes.
  let originalNativeTextAtLaunch = null;
  let composerLanguagesSnapshot = [];
  let panelDesiredHeight = 500;
  let panelPosition = null;
  let panelPreset = null;
  let composerAnchorRect = null;
  let hadNativeComposer = false;
  let composerGoneTimer = null;
  let maintenanceScheduled = false;
  let pendingFreshLaunchUntil = readPendingFreshLaunchUntil();
  let freshLaunchResumeInFlight = false;

  function isVisible(element) {
    if (!element) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return Boolean(
      rect.width &&
      rect.height &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  }

  function getButtonLabel(button) {
    return (
      button.getAttribute("aria-label") ||
      button.getAttribute("title") ||
      button.innerText ||
      ""
    ).trim();
  }

  function findMediaButton(root) {
    if (!root) {
      return null;
    }

    // Bluesky localizes the accessible name but retains this native media ID.
    const nativeMediaButton = root.querySelector('[data-testid="openMediaBtn"]');
    if (nativeMediaButton) {
      return nativeMediaButton;
    }

    const buttons = [...root.querySelectorAll("button,[role='button']")];

    return (
      buttons.find((button) => getButtonLabel(button) === "Add media to post") ||
      buttons.find((button) => /^add media\b/i.test(getButtonLabel(button))) ||
      null
    );
  }

  function findPublishButton(root) {
    if (!root) {
      return null;
    }

    // Bluesky localizes the publish label but retains this composer control ID.
    const nativePublishButton = root.querySelector('[data-testid="composerPublishBtn"]');
    if (nativePublishButton) {
      return nativePublishButton;
    }

    return (
      [...root.querySelectorAll("button,[role='button']")].find((button) => {
        const label = getButtonLabel(button);
        return label === "Publish post" || label === "Post";
      }) || null
    );
  }

  // Bluesky has no public composer API. Look for a likely editor using its
  // current controls and layout; this alone doesn't establish that the
  // composer is safe for our standalone-post workflow.
  function findComposerRoot(textbox) {
    if (!textbox) {
      return null;
    }

    const dialog = textbox.closest("[role='dialog']");
    if (dialog && findMediaButton(dialog)) {
      return dialog;
    }

    let node = textbox;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (
        rect.width > 350 &&
        rect.height > 180 &&
        findMediaButton(node) &&
        findPublishButton(node)
      ) {
        return node;
      }
    }

    return dialog || textbox.parentElement?.parentElement || textbox.parentElement;
  }

  // Only a positively identified standalone Bluesky composer may launch a
  // standalone PNG post. Live Firefox inspection confirms one reply gate and
  // either zero or one [data-testid="userAvatarImage"] on standalone posts;
  // the previously unverified zero-avatar case was captured on an actual
  // account with the exact unrestricted globe. The observed reply composer
  // has no reply gate and two avatar images. Two or more avatars, no gate,
  // or duplicate gates remain ineligible. The separate exact globe check in
  // hasUnrestrictedComposerInteraction continues to reject restricted or
  // unknown interaction settings before opening or publishing.
  function isStandalonePostComposer(root) {
    if (!root) return false;
    const gates = root.querySelectorAll?.('[data-testid="openReplyGateButton"]');
    const avatars = root.querySelectorAll?.('[data-testid="userAvatarImage"]');
    return gates?.length === 1 && (avatars?.length === 0 || avatars?.length === 1);
  }

  // A standalone composer can have interaction restrictions that we cannot
  // carry into our post record. Bluesky currently renders a globe for
  // "Anyone can interact" and a people icon for limited interaction. The
  // translated label and hashed CSS classes are intentionally NOT used.
  // This exact observed icon signature is conservative, not an official API:
  // unexpected icon/markup changes disable the PNG launcher, never silently
  // discard a user's selected restrictions.
  const UNRESTRICTED_INTERACTION_GLOBE_PATH =
    'M4.4 9.493C4.14 10.28 4 11.124 4 12a8 8 0 1 0 10.899-7.459l-.953 3.81a1 1 0 0 1-.726.727l-3.444.866-.772 1.533a1 1 0 0 1-1.493.35L4.4 9.493Zm.883-1.84L7.756 9.51l.44-.874a1 1 0 0 1 .649-.52l3.306-.832.807-3.227a7.993 7.993 0 0 0-7.676 3.597ZM2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10S2 17.523 2 12Zm8.43.162a1 1 0 0 1 .77-.29l1.89.121a1 1 0 0 1 .494.168l2.869 1.928a1 1 0 0 1 .336 1.277l-.973 1.946a1 1 0 0 1-.894.553h-2.92a1 1 0 0 1-.831-.445L9.225 14.5a1 1 0 0 1 .126-1.262l1.08-1.076Zm.915 1.913.177-.177 1.171.074 1.914 1.286-.303.607h-1.766l-1.194-1.79Z';

  // Both paths were observed on real unrestricted Bluesky composers. The
  // newer path differs only in the rounded arc radii (7.99 vs 7.993).
  // Continue failing closed for all other paths, including restriction icons.
  const UNRESTRICTED_INTERACTION_GLOBE_PATHS = new Set([
    UNRESTRICTED_INTERACTION_GLOBE_PATH,
    UNRESTRICTED_INTERACTION_GLOBE_PATH.replace('a7.993 7.993 0 0 0-', 'a7.99 7.99 0 0 0-'),
  ]);

  function hasUnrestrictedComposerInteraction(root) {
    const gates = root?.querySelectorAll?.('[data-testid="openReplyGateButton"]');
    if (!gates || gates.length !== 1) return false;
    const icons = gates[0].querySelectorAll?.('svg');
    if (!icons || icons.length !== 2) return false;
    const primary = icons[0];
    const paths = primary.querySelectorAll?.('path');
    return primary.getAttribute?.('width') === '16' &&
      primary.getAttribute?.('viewBox') === '0 0 24 24' &&
      paths?.length === 1 &&
      UNRESTRICTED_INTERACTION_GLOBE_PATHS.has(paths[0].getAttribute?.('d'));
  }

  // Bluesky's web ComposerPost renders a text editor row, followed by an
  // additional sibling when the post has a quote, image, GIF, video, or link
  // attachment. A quote preview may have zero avatar images while loading,
  // or one image that looks like the composer's avatar after it loads.
  // Neither state is an ordinary text-only post that this extension can own.
  // Derive the editor's direct ComposerPost row, not avatar totals elsewhere
  // inside the outer composer. Unknown layout fails closed.
  function hasTextOnlyNativeComposerPost(root) {
    const editor = root?.querySelector?.('[contenteditable="true"]');
    if (!editor) return false;

    for (let post = editor.parentElement; post && post !== root; post = post.parentElement) {
      const row = post.firstElementChild;
      if (!row?.contains?.(editor)) continue;
      if (!row.querySelector?.('[data-testid="userAvatarImage"],[data-testid="userAvatarFallback"]')) {
        continue;
      }
      // ComposerPost's first direct child is the row containing the editor
      // and its own avatar. Any additional direct child is unsupported.
      return post.children?.length === 1;
    }
    return false;
  }

  function isEligibleStandaloneComposer(root) {
    return isStandalonePostComposer(root) && hasUnrestrictedComposerInteraction(root) &&
      hasTextOnlyNativeComposerPost(root);
  }

  function findVisibleComposers() {
    const candidates = [
      ...document.querySelectorAll(
        '[contenteditable="true"][role="textbox"],[contenteditable="true"]',
      ),
    ].filter(isVisible);

    const composers = [];
    for (const textbox of candidates) {
      const root = findComposerRoot(textbox);
      if (root && findMediaButton(root)) {
        composers.push({ textbox, root });
      }
    }

    return composers;
  }

  function findVisibleComposer() {
    const composers = findVisibleComposers();
    return composers.length === 1 ? composers[0] : null;
  }

  function findNewPostControl() {
    // Bluesky's desktop New post control is the final, single-button child of
    // the primary navigation landmark. Recognize that landmark by its stable
    // route links, not by the button's translated accessible name or styling.
    // A single match is required before we programmatically click it or use
    // it for the one-time Minimize focus handoff.
    const structuralMatches = [];
    for (const nav of document.querySelectorAll('[role="navigation"]')) {
      if (!isVisible(nav) ||
          !nav.querySelector('a[href="/notifications"]') ||
          !nav.querySelector('a[href="/settings"]')) continue;
      const wrapper = nav.lastElementChild;
      if (wrapper?.tagName !== "DIV" || wrapper.children.length !== 1) continue;
      const control = wrapper.firstElementChild;
      if (control?.tagName === "BUTTON" && isVisible(control)) {
        structuralMatches.push(control);
      }
    }
    if (structuralMatches.length) {
      return structuralMatches.length === 1 ? structuralMatches[0] : null;
    }

    // Older/other layouts can still use the existing English fallback.
    // Never choose arbitrarily when two controls have the same label.
    const fallback = [...document.querySelectorAll("button,a,[role='button']")]
      .filter((control) => isVisible(control) &&
        /^(?:new post|compose new post)$/i.test(getButtonLabel(control)));
    return fallback.length === 1 ? fallback[0] : null;
  }


  // Bluesky currently keeps the active website account in BSKY_STORAGE.
  // This is internal website data, not a supported API. Read only the DID
  // and handle, never its tokens. If we can't verify the account, block
  // posting rather than guess.
  function readBlueskyActiveAccount() {
    try {
      const raw = window.localStorage?.getItem("BSKY_STORAGE");
      if (!raw) return null;
      const current = JSON.parse(raw)?.session?.currentAccount;
      if (typeof current?.did !== "string" ||
          !/^did:(?:plc|web):[a-zA-Z0-9.:%_-]+$/.test(current.did)) return null;
      return {
        did: current.did,
        handle: typeof current.handle === "string" ? current.handle : "",
      };
    } catch (_) {
      return null;
    }
  }

  function getBlueskyAppLanguageCandidates() {
    const candidates = [];
    const add = (value) => {
      if (typeof value !== "string") {
        return;
      }
      const normalized = value.trim().replace(/_/g, "-");
      if (normalized && !candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    };

    add(document.documentElement?.lang);
    add(globalThis.navigator?.language);

    // Bluesky stores the app-language preference beside unrelated session data.
    // Read only this narrow field as a fallback and never retain, transmit, or
    // expose the surrounding storage object.
    try {
      const raw = window.localStorage?.getItem("BSKY_STORAGE");
      if (raw) {
        const appLanguage = JSON.parse(raw)?.languagePrefs?.appLanguage;
        add(appLanguage);
      }
    } catch (_) {}

    add("en");
    return candidates;
  }

  function languageNameMap(appLanguage) {
    if (typeof Intl?.DisplayNames !== "function") {
      return null;
    }

    let displayNames;
    try {
      displayNames = new Intl.DisplayNames([appLanguage], {
        type: "language",
        fallback: "none",
        languageDisplay: "standard",
      });
    } catch (_) {
      return null;
    }

    const names = new Map();
    for (let first = 97; first <= 122; first += 1) {
      for (let second = 97; second <= 122; second += 1) {
        const candidate = String.fromCharCode(first, second);
        let canonical;
        let name;

        try {
          canonical = Intl.getCanonicalLocales(candidate)[0]?.split("-")[0];
          name = canonical ? displayNames.of(canonical) : undefined;
        } catch (_) {
          continue;
        }

        if (!canonical || canonical.length !== 2 || !name) {
          continue;
        }

        if (!names.has(name)) {
          names.set(name, new Set());
        }
        names.get(name).add(canonical);
      }
    }

    return names;
  }

  function resolveLanguageButtonLabel(label, appLanguage) {
    if (!label || typeof label !== "string") {
      return null;
    }

    const names = languageNameMap(appLanguage);
    if (!names) {
      return null;
    }

    const separator = ", ";
    const separatorIndexes = [];
    let index = label.indexOf(separator);
    while (index !== -1) {
      separatorIndexes.push(index);
      index = label.indexOf(separator, index + separator.length);
    }

    const partitions = [[label]];
    for (const firstIndex of separatorIndexes) {
      partitions.push([
        label.slice(0, firstIndex),
        label.slice(firstIndex + separator.length),
      ]);
    }
    for (let first = 0; first < separatorIndexes.length; first += 1) {
      for (let second = first + 1; second < separatorIndexes.length; second += 1) {
        const firstIndex = separatorIndexes[first];
        const secondIndex = separatorIndexes[second];
        partitions.push([
          label.slice(0, firstIndex),
          label.slice(firstIndex + separator.length, secondIndex),
          label.slice(secondIndex + separator.length),
        ]);
      }
    }

    const resolved = [];
    for (const parts of partitions) {
      if (parts.length < 1 || parts.length > 3) {
        continue;
      }

      const codes = [];
      let valid = true;
      for (const part of parts) {
        const matches = names.get(part);
        if (!matches || matches.size !== 1) {
          valid = false;
          break;
        }
        codes.push([...matches][0]);
      }

      if (valid) {
        const key = codes.join(",");
        if (!resolved.some((item) => item.key === key)) {
          resolved.push({ key, codes });
        }
      }
    }

    return resolved.length === 1 ? resolved[0].codes : null;
  }

  function readComposerPostLanguages(root) {
    const button =
      root?.querySelector?.('[data-testid="selectLangBtn"]') ||
      document.querySelector?.('[data-testid="selectLangBtn"]');

    if (!button) {
      return [];
    }

    const label = (button.innerText || button.textContent || "").trim();
    if (!label) {
      return [];
    }

    for (const appLanguage of getBlueskyAppLanguageCandidates()) {
      const resolved = resolveLanguageButtonLabel(label, appLanguage);
      if (resolved) {
        return resolved;
      }
    }

    return [];
  }

  function waitFor(getValue, timeoutMs, { observeAttributes = false } = {}) {
    const immediate = getValue();
    if (immediate) {
      return Promise.resolve(immediate);
    }

    return new Promise((resolve) => {
      let settled = false;

      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(value);
      };

      const observer = new MutationObserver(() => {
        const value = getValue();
        if (value) {
          finish(value);
        }
      });

      const timeout = setTimeout(() => finish(null), timeoutMs);
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: observeAttributes,
      });
    });
  }

  function readPendingFreshLaunchUntil() {
    try {
      const value = Number(window.sessionStorage?.getItem(PENDING_FRESH_LAUNCH_STORAGE_KEY));
      if (Number.isFinite(value) && value > Date.now()) {
        return value;
      }
      window.sessionStorage?.removeItem(PENDING_FRESH_LAUNCH_STORAGE_KEY);
    } catch (_) {
      // sessionStorage is only reload resilience. In-memory recovery still works.
    }
    return 0;
  }

  function markPendingFreshLaunch() {
    pendingFreshLaunchUntil = Date.now() + PENDING_FRESH_LAUNCH_TTL_MS;
    try {
      window.sessionStorage?.setItem(
        PENDING_FRESH_LAUNCH_STORAGE_KEY,
        String(pendingFreshLaunchUntil),
      );
    } catch (_) {
      // The live content script can still resume the SPA login flow.
    }
  }

  function clearPendingFreshLaunch() {
    pendingFreshLaunchUntil = 0;
    try {
      window.sessionStorage?.removeItem(PENDING_FRESH_LAUNCH_STORAGE_KEY);
    } catch (_) {}
  }

  function toolbarLaunchAbandoned() {
    try {
      return window.sessionStorage?.getItem(TOOLBAR_LAUNCH_ABANDONED_KEY) === "1";
    } catch (_) { return false; }
  }

  function hasPendingFreshLaunch() {
    if (toolbarLaunchAbandoned()) {
      clearPendingFreshLaunch();
      return false;
    }
    if (!pendingFreshLaunchUntil) {
      return false;
    }

    if (pendingFreshLaunchUntil <= Date.now()) {
      clearPendingFreshLaunch();
      document.getElementById("bsky-tpng-launch-error")?.remove();
      return false;
    }

    return true;
  }

  function readComposerInlineText(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    if (node.tagName === "BR") {
      // ProseMirror inserts this layout-only break to make an otherwise empty
      // paragraph editable. It is not part of the post text.
      return node.classList.contains("ProseMirror-trailingBreak") ? "" : "\n";
    }

    return [...node.childNodes].map(readComposerInlineText).join("");
  }

  function readComposerTextboxText(textbox) {
    if (!textbox) {
      return "";
    }

    const children = [...textbox.childNodes];
    if (!children.length) {
      return "";
    }

    // TipTap/ProseMirror stores each paragraph as a top-level block. Browser
    // innerText reflects visual block spacing and therefore inserts extra
    // newlines between those blocks in Firefox. Serialize the editor's
    // semantic structure instead: one newline between top-level blocks and
    // one newline for each explicit hard break inside a block.
    return children.map(readComposerInlineText).join("\n");
  }

  function readComposerText() {
    const composer = findVisibleComposer();

    if (composer) {
      composerTextSnapshot = readComposerTextboxText(composer.textbox);
      return composerTextSnapshot;
    }

    return hiddenComposer?.isConnected ? composerTextSnapshot : "";
  }

  function getComposerTextboxForSync() {
    if (!hiddenComposer && hiddenComposerTextbox?.isConnected) {
      return hiddenComposerTextbox;
    }
    // Never take over an unrelated editor after Bluesky navigation removes the
    // original composer. The original root must still own the target.
    if (hiddenComposer) {
      if (!hiddenComposer.isConnected) {
        return null;
      }
      if (hiddenComposerTextbox?.isConnected && hiddenComposer.contains?.(hiddenComposerTextbox) !== false) {
        return hiddenComposerTextbox;
      }
      hiddenComposerTextbox =
        hiddenComposer.querySelector('[contenteditable="true"][role="textbox"]') ||
        hiddenComposer.querySelector('[contenteditable="true"]');
      return hiddenComposerTextbox;
    }

    return findVisibleComposer()?.textbox || null;
  }

  function writeComposerTextbox(textbox, nextText) {
    if (!textbox || textbox.isConnected === false) {
      return false;
    }
    if (readComposerTextboxText(textbox) === nextText) {
      return true;
    }

    // TipTap/ProseMirror uses paragraph blocks for pasted plain text.
    const fragment = document.createDocumentFragment();
    for (const line of nextText.split(/\r\n?|\n/)) {
      const paragraph = document.createElement("p");
      if (line) {
        paragraph.append(document.createTextNode(line));
      }
      fragment.append(paragraph);
    }
    textbox.replaceChildren(fragment);
    textbox.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertReplacementText",
    }));
    return readComposerTextboxText(textbox) === nextText;
  }

  function syncComposerText(text) {
    // Keep the latest editor text even if Bluesky navigates away and removes
    // the original native composer before the extension user presses Cancel.
    const nextText = typeof text === "string" ? text : "";
    composerTextSnapshot = nextText;
    updateNavigationWarning();
    return writeComposerTextbox(getComposerTextboxForSync(), nextText);
  }

  function ensureLauncherStyles() {
    if (document.getElementById(`${LAUNCHER_ID}-style`)) {
      return;
    }

    const style = document.createElement("style");
    style.id = `${LAUNCHER_ID}-style`;
    style.textContent = `
      #${LAUNCHER_ID} {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 40px !important;
        height: 40px !important;
        min-width: 40px !important;
        box-sizing: border-box !important;
        padding: 8px !important;
        margin: 0 2px !important;
        border: 0 !important;
        border-radius: 24px !important;
        background: transparent !important;
        color: #1185fe !important;
        line-height: 1 !important;
        cursor: pointer !important;
        flex: 0 0 auto !important;
      }

      #${LAUNCHER_ID} > svg {
        display: block !important;
        width: 22px !important;
        height: 22px !important;
        overflow: visible !important;
      }

      #${LAUNCHER_ID}:hover {
        background: color-mix(in srgb, currentColor 17%, transparent) !important;
      }

      #${LAUNCHER_ID}:active {
        background: color-mix(in srgb, currentColor 30%, transparent) !important;
      }

      #${LAUNCHER_ID}:disabled {
        color: GrayText !important;
        cursor: default !important;
      }

      #${LAUNCHER_ID}:disabled:hover,
      #${LAUNCHER_ID}:disabled:active {
        background: transparent !important;
      }

      #${PANEL_DIALOG_ID}::backdrop {
        /* Bluesky web composer uses #000c (80% black):
           https://github.com/bluesky-social/social-app/blob/main/src/view/shell/Composer.web.tsx
           Native ::backdrop is absent while the PNG composer is minimized. */
        background: rgba(0, 0, 0, 0.8) !important;
      }

      /* Restore takes programmatic focus after Minimize. A pointer-initiated
         transition can leave it focused without matching :focus-visible;
         keep Firefox's native outline for either input modality. */
      #${PANEL_RETURN_ID}:focus {
        outline: auto !important;
        outline-offset: 0 !important;
      }

      /* Animate only the visual entrance. showModal(), keyboard focus, and
         screen-reader handoff are immediate, as before. */
      @media (prefers-reduced-motion: no-preference) {
        #${PANEL_DIALOG_ID}[open] {
          animation: bsky-tpng-dialog-enter 120ms ease-out both !important;
          transform-origin: center center;
        }

        @keyframes bsky-tpng-dialog-enter {
          from {
            opacity: 0.22;
            transform: scale(0.985);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
      }
    `;

    document.documentElement.appendChild(style);
  }

  function ensureLauncher() {
    const composers = findVisibleComposers();

    if (!composers.length) {
      launcher?.remove();
      launcher = null;
      return null;
    }

    const multipleComposers = composers.length > 1;

    // Bluesky can replace the native media toolbar when thread segments are
    // added or removed. If our existing launcher survives, keep it in place
    // and only update native disabled state. If Bluesky disconnected it, fall
    // through and recreate it in the current toolbar rather than letting the
    // unsupported-thread state make the action disappear.
    if (multipleComposers && launcher?.isConnected) {
      launcher.disabled = true;
      return launcher;
    }

    let composer = composers[0];
    if (multipleComposers && document.activeElement) {
      composer =
        composers.find(({ textbox, root }) =>
          textbox === document.activeElement || root.contains(document.activeElement),
        ) || composer;
    }

    const unsupportedContext = !isEligibleStandaloneComposer(composer.root);
    // A minimized PNG editor still owns its draft. Do not present another
    // native composer as a second, working entry point until it is restored
    // and finished or cancelled through the existing Return button.
    const disabled = multipleComposers || unsupportedContext || panelSuspended;
    if (!multipleComposers && launcher?.isConnected && composer.root.contains(launcher)) {
      launcher.disabled = disabled;
      return launcher;
    }

    launcher?.remove();
    launcher = null;

    const mediaButton = findMediaButton(composer.root);
    const toolbar = mediaButton?.parentElement;
    if (!mediaButton || !toolbar) {
      launcher = null;
      return null;
    }

    ensureLauncherStyles();

    launcher = document.createElement("button");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M8 3 H5 A2 2 0 0 0 3 5 V8 M16 3 H19 A2 2 0 0 1 21 5 V8 M3 16 V19 A2 2 0 0 0 5 21 H8 M16 21 H19 A2 2 0 0 0 21 19 V16"
        />
        <path fill="currentColor" d="M3.039 7.71H5.785Q7.009 7.71 7.665 8.328Q8.32 8.945 8.32 10.088Q8.32 11.235 7.665 11.853Q7.009 12.471 5.785 12.471H4.693V15H3.039ZM4.693 9.072V11.108H5.609Q6.09 11.108 6.352 10.842Q6.614 10.576 6.614 10.088Q6.614 9.6 6.352 9.336Q6.09 9.072 5.609 9.072ZM8.739 7.71H10.586L12.92 12.71V7.71H14.488V15H12.64L10.307 10V15H8.739ZM21.12 14.458Q20.501 14.8 19.835 14.971Q19.169 15.142 18.46 15.142Q16.857 15.142 15.921 14.124Q14.984 13.105 14.984 11.362Q14.984 9.6 15.938 8.589Q16.892 7.578 18.55 7.578Q19.191 7.578 19.777 7.715Q20.364 7.852 20.884 8.12V9.629Q20.346 9.282 19.816 9.111Q19.285 8.94 18.752 8.94Q17.764 8.94 17.229 9.568Q16.694 10.195 16.694 11.362Q16.694 12.52 17.21 13.149Q17.725 13.779 18.675 13.779Q18.933 13.779 19.154 13.743Q19.375 13.706 19.552 13.628V12.212H18.542V10.952H21.12Z"/>
      </svg>
    `;
    launcher.disabled = disabled;
    launcher.setAttribute("aria-label", t("addTransparentPngLauncher"));
    launcher.setAttribute("title", t("addTransparentPngLauncher"));
    launcher.addEventListener("click", handleLauncherClick);

    mediaButton.insertAdjacentElement("afterend", launcher);
    return launcher;
  }

  function ensurePanelFrame() {
    if (panelFrame) {
      return panelFrame;
    }

    // The dialog lives in Bluesky's top-level document, not inside the iframe.
    // showModal() makes the underlying Bluesky UI inert for both keyboard and
    // screen-reader navigation. The iframe remains an independent extension
    // document, with its existing controls, messages, and native file picker.
    panelDialog = document.createElement("dialog");
    panelDialog.id = PANEL_DIALOG_ID;
    panelDialog.setAttribute("aria-label", t("transparentPngTools"));
    panelDialog.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      margin: 0;
      padding: 0;
      max-width: none;
      max-height: none;
      width: min(${PANEL_MAX_WIDTH}px, calc(100vw - ${VIEWPORT_MARGIN * 2}px));
      height: 500px;
      right: ${VIEWPORT_MARGIN}px;
      bottom: ${VIEWPORT_MARGIN}px;
      border: 1px solid color-mix(in srgb, CanvasText 24%, transparent);
      border-radius: 16px;
      box-shadow: 0 0.375px 1.5px rgba(0, 0, 0, 0.02), 0 3px 12px rgba(0, 0, 0, 0.08);
      background: Canvas;
      overflow: hidden;
    `;
    panelDialog.addEventListener("cancel", (event) => {
      // When Firefox handles Escape at the parent dialog, ask the iframe to
      // follow its own Cancel path (and honor publishing's disabled Cancel).
      event.preventDefault();
      if (panelDialog.open && !panelFrame?.hidden) {
        sendToPanel({ type: "requestCancel" });
      }
    });

    panelFrame = document.createElement("iframe");
    panelFrame.src = browser.runtime.getURL("panel.html");
    panelFrame.title = t("transparentPngTools");
    panelFrame.hidden = true;
    panelFrame.style.cssText = `
      width: 100%;
      height: 100%;
      border: 0;
      vertical-align: top;
      background: Canvas;
    `;

    panelDialog.appendChild(panelFrame);
    document.body.appendChild(panelDialog);

    // Keep this control outside the modal so it is available when showModal()
    // ends. Prepend in DOM order so it can be found easily with screen-reader
    // virtual navigation. Focus is explicitly moved here on suspension.
    panelReturnButton = document.createElement("button");
    panelReturnButton.id = PANEL_RETURN_ID;
    panelReturnButton.type = "button";
    panelReturnButton.textContent = t("returnToPngComposer");
    panelReturnButton.hidden = true;
    panelReturnButton.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      inset-block-end: 16px;
      inset-inline-end: 16px;
      padding: 9px 14px;
      max-width: calc(100vw - 32px);
      border: 1px solid CanvasText;
      border-radius: 999px;
      background: Canvas;
      color: CanvasText;
      box-shadow: 0 2px 12px rgba(0,0,0,.18);
      font: 600 14px system-ui, sans-serif;
      cursor: pointer;
    `;
    panelReturnButton.addEventListener("click", restoreSuspendedPanel);
    if (typeof document.body.prepend === "function") {
      document.body.prepend(panelReturnButton);
    } else {
      document.body.appendChild(panelReturnButton);
    }
    return panelFrame;
  }

  function dismissPanelDialog() {
    stopPendingReturnFocusHandoff?.();
    panelSuspended = false;
    if (panelReturnButton) {
      panelReturnButton.hidden = true;
    }
    if (panelDialog?.open) {
      panelDialog.close();
    }
    if (panelFrame) {
      panelFrame.hidden = true;
    }
    pngImagesAtRisk = false;
    updateNavigationWarning();
    panelPosition = null;
  }

  // The native Bluesky composer restores focus asynchronously when it closes.
  // After the Return button first receives focus, observe only this particular
  // Bluesky-to-Return handoff. This is not a modal focus trap: once the handoff
  // is over, the user can navigate Bluesky normally.
  function focusReturnButtonAfterSuspend() {
    const button = panelReturnButton;
    if (!button) return;

    stopPendingReturnFocusHandoff?.();
    let finished = false;
    let userInteracted = false;
    let expiry;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(expiry);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", onUserInput, true);
      document.removeEventListener("pointerdown", onUserInput, true);
      if (stopPendingReturnFocusHandoff === cleanup) {
        stopPendingReturnFocusHandoff = null;
      }
    };
    const onUserInput = () => {
      userInteracted = true;
      cleanup();
    };
    const onFocus = (event) => {
      if (finished || userInteracted || !panelSuspended || button.hidden) {
        cleanup();
        return;
      }
      // Do not intercept a different destination, including one chosen by the
      // user. Recognize only Bluesky's own Compose new post focus handoff.
      if (event.target === button || event.target !== findNewPostControl()) return;
      // Wait until Bluesky finishes its native focus event before requesting
      // Return focus. Re-check state: user action, restore, or another focus
      // target must take precedence. There is never a repeating retry.
      Promise.resolve().then(() => {
        if (!finished && !userInteracted && panelSuspended && !button.hidden &&
            document.activeElement === event.target) {
          button.focus({ preventScroll: true });
        }
        cleanup();
      });
    };

    stopPendingReturnFocusHandoff = cleanup;
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", onUserInput, true);
    document.addEventListener("pointerdown", onUserInput, true);
    // The expiry only removes the temporary listener; it never moves focus.
    // Prevent an unexpected later Bluesky or user action from being intercepted.
    expiry = setTimeout(cleanup, 250);
    button.focus({ preventScroll: true });
  }

  // Suspend without destroying the PNG iframe. If the original native composer
  // still exists, close it through Bluesky's own Cancel/Discard lifecycle so
  // its modal scroll lock is released. Preserve the original text snapshot for
  // Cancel recovery even after the native composer is dismissed.
  async function suspendPanel() {
    if (!panelDialog?.open || !panelFrame || panelFrame.hidden ||
        pendingPanelOpen || panelSuspended || suspendCleanupInFlight || cancelRecoveryInFlight) {
      return false;
    }

    const ownedRoot = hiddenComposer?.isConnected ? hiddenComposer : null;
    // Never dismiss another visible draft. Failure leaves our modal intact.
    if (ownedRoot && (findVisibleComposers().some(({ root }) => root !== ownedRoot) ||
        !findOwnedComposerCancel(ownedRoot))) {
      sendToPanel({ type: "suspendCleanupFailed" });
      return false;
    }

    suspendCleanupInFlight = true;
    panelDialog.close();
    try {
      if (ownedRoot) {
        // Reveal only the owned native composer, preserving its reference and
        // original frozen text for our guarded Cancel recovery.
        ownedRoot.style.display = hiddenComposerDisplay;
        const dismissed = await dismissOwnedNativeComposerAfterPost(ownedRoot);
        if (!dismissed) {
          throw new Error("Native composer dismissal was not confirmed");
        }
        // Do not resume page interaction until Bluesky actually removes or
        // hides the composer that owned its modal scroll lock.
        const gone = await waitFor(
          () => !ownedRoot.isConnected || !isVisible(ownedRoot),
          1500,
        );
        if (!gone) {
          throw new Error("Native composer remained visible");
        }
        hiddenComposer = null;
        hiddenComposerTextbox = null;
        hiddenComposerDisplay = "";
      }

      panelSuspended = true;
      panelReturnButton.hidden = false;
      focusReturnButtonAfterSuspend();
      return true;
    } catch (_) {
      // If Bluesky changes its controls or a confirmation fails, retain the
      // PNG draft and the native-modal focus barrier. Do not fake scrolling by
      // changing Bluesky's body overflow or delete any of its DOM nodes.
      if (ownedRoot?.isConnected) ownedRoot.style.display = "none";
      if (!panelDialog.open) panelDialog.showModal();
      sendToPanel({ type: "suspendCleanupFailed" });
      return false;
    } finally {
      suspendCleanupInFlight = false;
    }
  }

  function restoreSuspendedPanel() {
    if (!panelSuspended || !panelFrame || panelFrame.hidden) {
      return false;
    }
    stopPendingReturnFocusHandoff?.();
    panelSuspended = false;
    panelReturnButton.hidden = true;
    panelDialog.showModal();
    positionPanel();
    requestAnimationFrame(() => {
      sendToPanel({
        type: "resumeFocus",
        // Only the specific "other composer" Cancel error can be cleared.
        // Check the live native page after minimize, not a cached draft state.
        cancelConflictResolved: findVisibleComposers().length === 0,
      });
    });
    return true;
  }

  function preparePendingPanelOpen() {
    if (!panelFrameReady || !pendingPanelOpen || pendingPanelOpen.preparationSent) {
      return;
    }

    pendingPanelOpen.preparationSent = true;
    sendToPanel({
      type: "prepareOpen",
      requestId: pendingPanelOpen.requestId,
      text: composerTextSnapshot,
      languages: composerLanguagesSnapshot,
    });
  }

  function endToolbarTransition() {
    // The early-injected CSS only masks native composer paint, never the
    // native element or focus. Unmask on successful takeover or any failure.
    document.documentElement?.removeAttribute?.("data-tpng-toolbar-transition");
  }

  function revealPreparedPanel(requestId) {
    if (!pendingPanelOpen || pendingPanelOpen.requestId !== requestId || !panelFrame) {
      return;
    }

    // The native editor stays active while the iframe prepares. A user may
    // change interaction permissions in that interval; recheck before the
    // modal handoff instead of relying on the earlier launcher click.
    const composer = findVisibleComposer();
    if (!panelReturnFocusTarget?.isConnected ||
        !isEligibleStandaloneComposer(composer?.root)) {
      pendingPanelOpen = null;
      panelReturnFocusTarget = null;
      endToolbarTransition();
      return;
    }

    // Keep the native composer visible until focus has safely moved into the
    // extension frame. Hiding the element that still owns focus gives Firefox
    // and screen readers a brief "nowhere" state during the handoff.
    panelFrame.hidden = false;
    updateNavigationWarning();
    panelPosition = null;
    positionPanel({ choosePosition: true });
    if (!panelDialog.open) {
      panelDialog.showModal();
    }

    requestAnimationFrame(() => {
      sendToPanel({ type: "focusInitial", requestId });
    });
  }

  function finishPanelFocusHandoff(requestId) {
    if (!pendingPanelOpen || pendingPanelOpen.requestId !== requestId) {
      return;
    }

    hideNativeComposer();
    endToolbarTransition();
    // A completed focus handoff cancels the toolbar-only failure fallback,
    // including if Bluesky navigated within the newly opened tab.
    try {
      window.sessionStorage?.removeItem("bskyTpngToolbarLaunchNoticeUntil");
    } catch (_) {}
    document.getElementById("bsky-tpng-launch-error")?.remove();
    pendingPanelOpen = null;
  }

  function findComposerSurface(textbox, root) {
    let node = textbox;

    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      if (
        rect.width > 350 &&
        rect.height > 180 &&
        findMediaButton(node) &&
        findPublishButton(node)
      ) {
        return node;
      }

      if (node === root) {
        break;
      }
    }

    return root;
  }

  function rememberComposerPosition(composer) {
    if (!composer?.root) {
      composerAnchorRect = null;
      return;
    }

    const rootRect = composer.root.getBoundingClientRect();
    const surfaceRect = findComposerSurface(composer.textbox, composer.root)?.getBoundingClientRect();

    if (!rootRect.width || !rootRect.height) {
      composerAnchorRect = null;
      return;
    }

    composerAnchorRect = {
      left: rootRect.left,
      top: surfaceRect?.height ? surfaceRect.top : rootRect.top,
      width: rootRect.width,
      height: rootRect.height,
    };
  }

  function getPanelSize() {
    const availableWidth = Math.max(1, window.innerWidth - VIEWPORT_MARGIN * 2);
    const availableHeight = Math.max(1, window.innerHeight - VIEWPORT_MARGIN * 2);
    const width = Math.min(PANEL_MAX_WIDTH, availableWidth);
    const desiredHeight = Math.min(
      Math.max(PANEL_MIN_HEIGHT, panelDesiredHeight), PANEL_MAX_HEIGHT, availableHeight,
    );

    return { width, desiredHeight };
  }

  function chooseInitialPanelPosition(width) {
    const anchor = composerAnchorRect;
    if (!anchor) {
      return null;
    }

    const composerCenterX = anchor.left + anchor.width / 2;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, composerCenterX - width / 2),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    const top = Math.max(VIEWPORT_MARGIN, anchor.top);

    return { left, top };
  }

  function computePresetPosition(preset, width, height) {
    const horizontalFraction = { left: 0, center: 0.5, right: 1 }[preset.horizontal];
    const verticalFraction = { top: 0, middle: 0.5, bottom: 1 }[preset.vertical];
    const freeX = Math.max(0, window.innerWidth - width - VIEWPORT_MARGIN * 2);
    const freeY = Math.max(0, window.innerHeight - height - VIEWPORT_MARGIN * 2);
    return {
      left: VIEWPORT_MARGIN + freeX * horizontalFraction,
      top: VIEWPORT_MARGIN + freeY * verticalFraction,
    };
  }

  function placePanelAt(horizontal, vertical) {
    if (!panelDialog?.open || !panelFrame || panelFrame.hidden || panelSuspended) return;
    if (!["left", "center", "right"].includes(horizontal) ||
        !["top", "middle", "bottom"].includes(vertical)) return;
    panelPreset = { horizontal, vertical };
    positionPanel();
  }

  function positionPanel({ choosePosition = false } = {}) {
    if (!panelFrame || panelFrame.hidden) {
      return;
    }

    const { width, desiredHeight } = getPanelSize();

    if (choosePosition || !panelPosition) {
      panelPreset = null;
      panelPosition = chooseInitialPanelPosition(width);
    }

    // A preset is a fraction of the available *free space*, not a fixed pixel
    // offset. Recalculate on content-height changes, zoom, and viewport resize.
    // When the panel fills an axis, distinct choices naturally converge.
    if (panelPreset) {
      panelPosition = computePresetPosition(panelPreset, width, desiredHeight);
    }

    if (!panelPosition) {
      return;
    }

    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, panelPosition.left),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    const top = Math.min(
      Math.max(VIEWPORT_MARGIN, panelPosition.top),
      Math.max(VIEWPORT_MARGIN, window.innerHeight - PANEL_MIN_HEIGHT - VIEWPORT_MARGIN),
    );
    const availableHeight = Math.max(
      Math.min(PANEL_MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2),
      window.innerHeight - top - VIEWPORT_MARGIN,
    );
    const height = Math.min(desiredHeight, availableHeight);

    panelPosition = { left, top };
    panelDialog.style.width = `${width}px`;
    panelDialog.style.height = `${height}px`;
    panelDialog.style.left = `${left}px`;
    panelDialog.style.top = `${top}px`;
    panelDialog.style.right = "auto";
    panelDialog.style.bottom = "auto";
  }

  // Move the existing PNG dialog when the user drags its header.
  // Keep it within the viewport without changing the underlying
  // Bluesky composer.
  function dragPanelBy(deltaX, deltaY) {
    if (!panelDialog?.open || !panelFrame || panelFrame.hidden) {
      return;
    }

    const dx = Number(deltaX);
    const dy = Number(deltaY);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return;
    }

    const rect = panelDialog.getBoundingClientRect();
    const left = panelPosition?.left ?? rect.left;
    const top = panelPosition?.top ?? rect.top;
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN);

    panelPreset = null; // Free dragging overrides any previously chosen preset.
    panelPosition = {
      left: Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, left + dx)),
      top: Math.min(maxTop, Math.max(VIEWPORT_MARGIN, top + dy)),
    };
    positionPanel();
  }

  function hideNativeComposer() {
    if (hiddenComposer?.isConnected) {
      return;
    }

    const composer = findVisibleComposer();
    if (!composer) {
      return;
    }

    composerTextSnapshot = readComposerTextboxText(composer.textbox);
    hiddenComposer = composer.root;
    hiddenComposerTextbox = composer.textbox;
    hiddenComposerDisplay = hiddenComposer.style.display;
    hiddenComposer.style.display = "none";
  }

  function showNativeComposer() {
    if (!hiddenComposer) {
      return;
    }

    if (hiddenComposer.isConnected) {
      hiddenComposer.style.display = hiddenComposerDisplay;
    }

    hiddenComposer = null;
    hiddenComposerTextbox = null;
    hiddenComposerDisplay = "";
    scheduleMaintenance();
  }

  // The native Bluesky composer animates its full-window #000c shade with
  // a 150ms fadeIn (src/alf/atoms.ts and src/view/shell/Composer.web.tsx).
  // Restoring it from display:none restarts that animation. On successful
  // Cancel, keep our native-dialog backdrop visible until the underlying
  // shade has finished appearing, avoiding a one-frame bright-page flash.
  // Never delay Minimize, publish success, navigation, or failure recovery.
  function waitForNativeComposerShade(root) {
    if (typeof root?.getAnimations !== "function") return null;
    const fade = root.getAnimations().find((animation) =>
      animation.animationName === "fadeIn" && animation.playState !== "finished"
    );
    if (!fade) return null; // Bluesky reduced-motion preference or changed styling.

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      // Never hold Cancel indefinitely if Bluesky cancels or changes its fade.
      const timeout = setTimeout(finish, 250);
      fade.finished.then(finish, finish);
    });
  }

  // After our own post is published, use Bluesky's native Cancel/Discard
  // controls to close only the composer from which the PNG editor was opened.
  // Never assume a localized/unknown control is safe to click.
  function findOwnedComposerCancel(root) {
    if (!root?.isConnected) return null;
    const controls = [...(root.querySelectorAll?.("button,[role='button']") || [])];

    // Older Bluesky builds expose this action-specific test ID. Use it only
    // when unique within our *owned* composer, never elsewhere on the page.
    const nativeIds = controls.filter((control) =>
      control.getAttribute?.("data-testid") === "composerDiscardButton");
    if (nativeIds.length) return nativeIds.length === 1 ? nativeIds[0] : null;

    // Retain the working English behavior without inferring an action from
    // header button order. The observed Romanian action has no native test ID.
    const english = controls.filter((control) => getButtonLabel(control) === "Cancel");
    if (english.length) return english.length === 1 ? english[0] : null;

    const romanian = controls.filter((control) => getButtonLabel(control) === "Anulare");
    if (romanian.length !== 1) return null;

    // Require an unambiguous composer header anchored to Bluesky's stable
    // publish ID. A translated label found elsewhere (or a header containing
    // extra/unidentified actions) is insufficient to click anything.
    const publishes = controls.filter((control) =>
      control.getAttribute?.("data-testid") === "composerPublishBtn");
    if (publishes.length !== 1) return null;
    const cancel = romanian[0];
    const publish = publishes[0];
    for (let header = publish.parentElement; header && header !== root;
         header = header.parentElement) {
      if (!header.contains?.(cancel)) continue;
      const headerControls = [...header.querySelectorAll("button,[role='button']")];
      return headerControls.length === 3 &&
        headerControls.includes(cancel) && headerControls.includes(publish)
        ? cancel : null;
    }
    return null;
  }

  function findNewOwnedDiscardConfirmation(priorDialogs) {
    const candidates = [
      ...document.querySelectorAll('[role="alertdialog"],[role="dialog"]'),
    ].filter((dialog) => !priorDialogs.has(dialog) && isVisible(dialog));
    const matches = [];
    // Only the English and Romanian action triads have been observed in
    // Firefox. The complete three-action signature must match ONE language;
    // no position-based or partial-label inference for destructive actions.
    const signatures = [
      { save: "Save draft", keep: "Keep editing", discard: "Discard" },
      { save: "Salvare schiță", keep: "Continuați editarea", discard: "Renunțare" },
    ];
    for (const dialog of candidates) {
      const buttons = [...dialog.querySelectorAll("button,[role='button']")];
      if (buttons.length !== 3) continue;
      const labels = buttons.map(getButtonLabel);
      for (const { save, keep, discard } of signatures) {
        if (labels.filter((label) => label === save).length !== 1 ||
            labels.filter((label) => label === keep).length !== 1 ||
            labels.filter((label) => label === discard).length !== 1) {
          continue;
        }
        matches.push(buttons[labels.indexOf(discard)]);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  async function dismissOwnedNativeComposerAfterPost(root) {
    if (!root?.isConnected) return false;
    if (findVisibleComposers().some((composer) => composer.root !== root)) {
      return false; // An unrelated native draft has priority.
    }
    const cancel = findOwnedComposerCancel(root);
    if (!cancel) return false;

    try {
      const priorDialogs = new Set([
        ...document.querySelectorAll('[role="alertdialog"],[role="dialog"]')
      ].filter(isVisible));
      cancel.click();
      // Bluesky may close immediately, or show its own unsaved-draft prompt.
      const next = await waitFor(() => {
        if (!root.isConnected) return { closed: true };
        const discard = findNewOwnedDiscardConfirmation(priorDialogs);
        return discard ? { discard } : null;
      }, 900);
      if (next?.closed) return true;
      if (!next?.discard || !root.isConnected) return false;
      if (findVisibleComposers().some((composer) => composer.root !== root)) {
        return false;
      }
      next.discard.click();
      return true;
    } catch (_) {
      // Native UI changed or rejected the operation; leave it to the user.
      return false;
    }
  }

  function showPanel({ launchOrigin = "native" } = {}) {
    if (panelSuspended) {
      return restoreSuspendedPanel();
    }
    const currentLauncher = ensureLauncher();
    const composer = findVisibleComposer();

    // The launcher is also reachable via the Firefox toolbar. Re-check the
    // current native composer before preparing any draft, even if a click or
    // pending launch was queued while Bluesky changed composer context.
    if (!currentLauncher || currentLauncher.disabled || !composer ||
        !isEligibleStandaloneComposer(composer.root)) {
      if (launchOrigin === "toolbar") endToolbarTransition();
      return false;
    }

    ensurePanelFrame();
    panelLaunchOrigin = launchOrigin;
    panelReturnFocusTarget = currentLauncher;
    rememberComposerPosition(composer);
    composerTextSnapshot = readComposerTextboxText(composer.textbox);
    pngImagesAtRisk = false;
    originalNativeTextAtLaunch = composerTextSnapshot;
    composerLanguagesSnapshot = readComposerPostLanguages(composer.root);
    panelPosition = null;

    pendingPanelOpen = {
      requestId: ++panelOpenSequence,
      preparationSent: false,
    };
    preparePendingPanelOpen();
    return true;
  }

  function onBlueskySignInScreen() {
    return /^\/login(?:\/|$)/.test(window.location?.pathname || "") || Boolean(
      document.querySelector?.('[data-testid="signIn"], input[autocomplete="username"], input[autocomplete="current-password"], input[type="password"]')
    );
  }

  function dismissLaunchWarningOnSignIn() {
    if (!onBlueskySignInScreen()) return false;
    document.getElementById("bsky-tpng-launch-error")?.remove();
    try { window.sessionStorage?.removeItem("bskyTpngToolbarLaunchNoticeUntil"); } catch (_) {}
    // Retain the separate five-minute pending-launch intent. It may resume
    // after site sign-in, but the error message must not cover sign-in UI.
    return true;
  }

  function showFreshLaunchFailure({ recoveryFailed = false } = {}) {
    endToolbarTransition();
    if (toolbarLaunchAbandoned()) return;
    if (dismissLaunchWarningOnSignIn()) return;
    // toolbar-transition.js can already have shown and focused this alert.
    // Changing its live-region text mid-announcement interrupts NVDA; repeated
    // content-script retries must neither rewrite it nor move focus again.
    if (document.getElementById("bsky-tpng-launch-error")) return;

    const notice = document.createElement("div");
    notice.id = "bsky-tpng-launch-error";
    notice.setAttribute("role", "alert");
    notice.tabIndex = 0;
    const heading = document.createElement("h2");
    heading.textContent = t("toolbarLaunchWarningHeading");
    const message = document.createElement("p");
    message.textContent = recoveryFailed
      ? t("freshLaunchRecoveryFailedNotice")
      : t("freshLaunchFailedNotice");
    notice.appendChild(heading);
    notice.appendChild(message);
    document.body.appendChild(notice);
    const shownRoute = window.location.pathname + (window.location.search || "") + (window.location.hash || "");
    const abandon = () => {
      try {
        window.sessionStorage?.setItem(TOOLBAR_LAUNCH_ABANDONED_KEY, "1");
        window.sessionStorage?.removeItem("bskyTpngToolbarLaunchNoticeUntil");
      } catch (_) {}
      clearPendingFreshLaunch();
      notice.remove();
    };
    const onClick = (event) => {
      if (event.target?.closest?.("#bsky-tpng-launch-error")) return;
      const target = event.target?.closest?.('a[href],button,[role="link"],[role="button"],[role="tab"]');
      if (!target || target.closest?.('[data-testid="signIn"],a[href*="/login"]')) return;
      setTimeout(() => {
        if (document.getElementById(notice.id) !== notice) return;
        if (dismissLaunchWarningOnSignIn()) return;
        abandon();
      }, 600);
    };
    document.addEventListener("click", onClick, true);
    const watch = setInterval(() => {
      if (document.getElementById(notice.id) !== notice) {
        clearInterval(watch);
        document.removeEventListener("click", onClick, true);
      } else if (dismissLaunchWarningOnSignIn()) {
        // Sign-in retains the pending post, unlike unrelated navigation.
      } else if (window.location.pathname + (window.location.search || "") + (window.location.hash || "") !== shownRoute) {
        abandon();
      }
    }, 350);
    setTimeout(() => {
      if (document.getElementById("bsky-tpng-launch-error") === notice) {
        notice.focus({ preventScroll: true });
      }
    }, 100);
  }

  // A visible text editor can precede its reply gate, avatar, or native
  // media toolbar during Bluesky hydration. The toolbar resume must wait for
  // the same positively verified composer that showPanel() requires; never
  // consume the pending sign-in intent merely because an editor appeared.
  function findReadyFreshLaunchComposer() {
    const composer = findVisibleComposer();
    return composer && isEligibleStandaloneComposer(composer.root) ? composer : null;
  }

  async function resumePendingFreshLaunch() {
    if (dismissLaunchWarningOnSignIn()) return;
    if (!hasPendingFreshLaunch() || freshLaunchResumeInFlight) return;

    if (panelFrame && !panelFrame.hidden) {
      clearPendingFreshLaunch();
      document.getElementById("bsky-tpng-launch-error")?.remove();
      return;
    }

    // The site may have left its sign-in view before it has established a
    // current account. Wait for it rather than clicking New post too early.
    // The account-match check before publishing remains independently enforced.
    if (!readBlueskyActiveAccount()) return;

    const existingComposer = findVisibleComposer();
    const newPostControl = existingComposer ? null : findNewPostControl();
    if (!existingComposer && !newPostControl) {
      // Page navigation is still rendering. Keep the five-minute pending
      // intent; the normal DOM maintenance path will retry when ready.
      return;
    }

    freshLaunchResumeInFlight = true;
    try {
      if (newPostControl) newPostControl.click();

      const composer = await waitFor(
        findReadyFreshLaunchComposer,
        NATIVE_COMPOSER_OPEN_TIMEOUT_MS,
        { observeAttributes: true }, // Bluesky may hydrate reply-gate/icon attributes in place.
      );
      // The user may have navigated away or a different attempt may have
      // completed while we waited. Do not resurrect a cancelled launch.
      if (!hasPendingFreshLaunch() || onBlueskySignInScreen()) return;

      if (!composer) {
        clearPendingFreshLaunch();
        showFreshLaunchFailure({ recoveryFailed: true });
        return;
      }

      if (!showPanel({ launchOrigin: "toolbar" })) {
        clearPendingFreshLaunch();
        showFreshLaunchFailure({ recoveryFailed: true });
        return;
      }
      clearPendingFreshLaunch();
      document.getElementById("bsky-tpng-launch-error")?.remove();
    } finally {
      freshLaunchResumeInFlight = false;
    }
  }

  async function openFreshComposerPanel() {
    clearPendingFreshLaunch();
    let composer = findVisibleComposer();

    if (!composer) {
      composer = await waitFor(
        findVisibleComposer,
        NATIVE_COMPOSER_OPEN_TIMEOUT_MS,
      );
    }

    // The compose-intent route is the primary launcher. If Bluesky routes it
    // back to the normal app shell, retain the old UI-click path as a fallback.
    if (!composer) {
      const newPostControl = findNewPostControl();
      if (newPostControl) {
        newPostControl.click();
        composer = await waitFor(
          findVisibleComposer,
          NATIVE_COMPOSER_OPEN_TIMEOUT_MS,
        );
      }
    }

    if (!composer) {
      if (toolbarLaunchAbandoned()) return { ok: false, error: t("blueskyDidNotOpenComposer") };
      markPendingFreshLaunch();
      showFreshLaunchFailure();
      return {
        ok: false,
        error: t("blueskyDidNotOpenComposer"),
      };
    }

    clearPendingFreshLaunch();
    document.getElementById("bsky-tpng-launch-error")?.remove();

    return showPanel({ launchOrigin: "toolbar" })
      ? { ok: true }
      : { ok: false, error: t("panelCouldNotOpen") };
  }

  // Evaluation-only, privacy-safe Cancel diagnostics. Read this DOM attribute
  // after a failed Cancel; never include draft contents, URLs or credentials.
  function noteCancelRecoveryStage(stage) {
    try {
      if (!panelDialog) return;
      const visibleComposers = findVisibleComposers().length;
      const visibleDialogs = [...document.querySelectorAll(
        '[role="dialog"],[role="alertdialog"]'
      )].filter(isVisible).length;
      panelDialog.setAttribute("data-tpng-cancel-diagnostic", JSON.stringify({
        stage,
        originalRootConnected: Boolean(hiddenComposer?.isConnected),
        originalEditorConnected: Boolean(hiddenComposerTextbox?.isConnected),
        visibleComposers,
        visibleDialogs,
        newPostControlFound: Boolean(findNewPostControl()),
        pngModalOpen: Boolean(panelDialog.open)
      }));
    } catch (_) {
      // Diagnostics must never interfere with Cancel or draft preservation.
    }
  }

  // When Bluesky removes the original root during SPA navigation, its own
  // New post action may restore the original draft. Treat that exact frozen
  // launch text as an owned recovery target, not as an unrelated draft.
  // Require no visible editor before we click New post and a unique editor
  // afterward. Any other nonempty text remains protected.
  async function recoverNativeComposer(text) {
    if (findVisibleComposers().length !== 0) {
      noteCancelRecoveryStage("blocked-by-visible-composer");
      return { blockedByVisibleComposer: true };
    }
    const newPostControl = findNewPostControl();
    if (!newPostControl) {
      noteCancelRecoveryStage("no-new-post-control");
      return null;
    }

    // The native page is inert under showModal(). Temporarily close the dialog
    // without unloading its iframe so Bluesky can open a normal composer.
    panelDialog.close();
    let recovered = false;
    try {
      newPostControl.click();
      const composer = await waitFor(() => {
        const composers = findVisibleComposers();
        return composers.length === 1 ? composers[0] : null;
      }, NATIVE_COMPOSER_OPEN_TIMEOUT_MS);
      if (!composer) {
        noteCancelRecoveryStage("new-composer-not-found-after-click");
        return null;
      }
      const recoveredText = readComposerTextboxText(composer.textbox);
      const emptyEditor = recoveredText === "";
      const originalDraftRestored =
        typeof originalNativeTextAtLaunch === "string" &&
        originalNativeTextAtLaunch !== "" &&
        recoveredText === originalNativeTextAtLaunch;
      if (!emptyEditor && !originalDraftRestored) {
        noteCancelRecoveryStage("new-composer-not-owned");
        return null;
      }
      if (!writeComposerTextbox(composer.textbox, text)) {
        noteCancelRecoveryStage("new-composer-text-sync-failed");
        return null;
      }
      recovered = true;
      noteCancelRecoveryStage(originalDraftRestored
        ? "recovered-matching-original-text"
        : "recovered-to-new-composer");
      return composer;
    } catch (_) {
      noteCancelRecoveryStage("new-composer-recovery-exception");
      return null;
    } finally {
      // On failure, reestablish modal focus containment and keep every PNG,
      // alt text entry, and draft edit alive for another attempt or posting.
      if (!recovered && !panelDialog.open && cancelRecoveryInFlight) {
        panelDialog.showModal();
        sendToPanel({ type: "cancelRecoveryFocus" });
      }
    }
  }

  // Cancel isn't complete until we've safely returned the latest text to
  // the original Bluesky editor or a verified replacement. If recovery
  // fails, keep the PNG draft available rather than losing the user's work.
  async function closePanel(text) {
    if (cancelRecoveryInFlight || !panelDialog?.open || !panelFrame || panelFrame.hidden) {
      return;
    }
    cancelRecoveryInFlight = true;
    noteCancelRecoveryStage("cancel-started");
    if (typeof text === "string") {
      composerTextSnapshot = text;
    }
    const currentText = composerTextSnapshot;

    try {
      const originalStillConnected = Boolean(hiddenComposer?.isConnected);
      if (originalStillConnected) {
        // A final sync uses the exact text from the iframe's Cancel request.
        if (!syncComposerText(currentText)) {
          noteCancelRecoveryStage("original-composer-text-sync-failed");
          sendToPanel({ type: "cancelRecoveryFailed" });
          return;
        }
      } else {
        const recovered = await recoverNativeComposer(currentText);
        if (!recovered || recovered.blockedByVisibleComposer) {
          sendToPanel({
            type: "cancelRecoveryFailed",
            ...(recovered?.blockedByVisibleComposer ? { reason: "other-composer-open" } : {}),
          });
          return;
        }
      }

      if (originalStillConnected) {
        noteCancelRecoveryStage("restored-to-original-composer");
      }
      const shouldReturnFreshToolbarTabHome =
        panelLaunchOrigin === "toolbar" && currentText.trim() === "" && originalStillConnected;
      panelLaunchOrigin = "native";
      pendingPanelOpen = null;
      sendToPanel({ type: "resetDraft" });

      if (shouldReturnFreshToolbarTabHome) {
        dismissPanelDialog();
        window.location.replace(BLUESKY_HOME_URL);
        return;
      }

      // Keep our shade until Bluesky's restored native backdrop is opaque.
      // Remember the native root because showNativeComposer clears ownership.
      const restoredComposer = hiddenComposer?.isConnected ? hiddenComposer : null;
      showNativeComposer();
      const nativeShadeFade = originalStillConnected
        ? waitForNativeComposerShade(restoredComposer) : null;
      if (nativeShadeFade) await nativeShadeFade;
      dismissPanelDialog();
      const returnTarget = panelReturnFocusTarget?.isConnected
        ? panelReturnFocusTarget
        : ensureLauncher();
      (returnTarget || findVisibleComposer()?.textbox)?.focus({ preventScroll: true });
      panelReturnFocusTarget = null;
    } finally {
      cancelRecoveryInFlight = false;
    }
  }

  function handleLauncherClick(event) {
    event.preventDefault();
    event.stopPropagation();

    // A stale/synthetic click must not discard or overwrite a minimized draft.
    if (panelSuspended) return;

    if (panelFrame && !panelFrame.hidden) {
      void closePanel(composerTextSnapshot);
      return;
    }

    showPanel();
  }

  function hasVisibleDialog() {
    return [...document.querySelectorAll("[role='dialog']")].some(isVisible);
  }

  function resetExtensionDraft() {
    composerTextSnapshot = "";
    pngImagesAtRisk = false;
    composerLanguagesSnapshot = [];
    updateNavigationWarning();
    sendToPanel({ type: "resetDraft" });
  }

  // Bluesky can temporarily remove or replace its composer while rendering.
  // Give it time to reappear before clearing the draft. Never reset a PNG
  // draft that's open or minimized.
  function watchComposerLifecycle() {
    if (panelSuspended || (panelFrame && !panelFrame.hidden)) {
      return;
    }

    if (findVisibleComposer()) {
      hadNativeComposer = true;
      if (composerGoneTimer) {
        clearTimeout(composerGoneTimer);
        composerGoneTimer = null;
      }
      return;
    }

    if (!hadNativeComposer || composerGoneTimer) {
      return;
    }

    composerGoneTimer = setTimeout(function checkComposerGone() {
      composerGoneTimer = null;

      if (panelFrame && !panelFrame.hidden) {
        return;
      }

      if (findVisibleComposer()) {
        hadNativeComposer = true;
        return;
      }

      if (hasVisibleDialog()) {
        composerGoneTimer = setTimeout(checkComposerGone, 500);
        return;
      }

      hadNativeComposer = false;
      resetExtensionDraft();
    }, COMPOSER_GONE_DELAY_MS);
  }

  function runMaintenance() {
    maintenanceScheduled = false;
    if (document.getElementById("bsky-tpng-launch-error")) {
      dismissLaunchWarningOnSignIn();
    }
    // Ordinary Bluesky browsing needs only the launcher/lifecycle checks.
    // showPanel() creates the extension iframe on first use and waits for its
    // panelReady handshake before transferring modal focus.
    ensureLauncher();
    watchComposerLifecycle();
    resumePendingFreshLaunch();
  }

  // Keep the interval as a safety fallback while a composer or draft is in
  // play. When Bluesky is just showing its feed, the DOM observer handles
  // newly inserted composers without a whole-page scan every 1.5 seconds.
  function shouldRunPeriodicMaintenance() {
    return Boolean(launcher?.isConnected || hadNativeComposer ||
      pendingPanelOpen || panelSuspended ||
      (panelFrame && !panelFrame.hidden) || hasPendingFreshLaunch() ||
      document.getElementById("bsky-tpng-launch-error"));
  }

  function runPeriodicMaintenance() {
    if (shouldRunPeriodicMaintenance()) {
      runMaintenance();
    }
  }

  // When idle, feed updates do not need to trigger a whole-page composer
  // scan. Keep observing document.body: Bluesky can insert the native composer
  // outside its feed container. A newly inserted editor or media control (even
  // nested inside an added wrapper) still schedules immediate maintenance.
  // Active composers, modal/draft state, and pending toolbar recovery retain
  // the full, unfiltered child-list observer behavior.
  const COMPOSER_MUTATION_SELECTOR =
    '[contenteditable="true"],[data-testid="openMediaBtn"],[data-testid="composerPublishBtn"]';

  function shouldScheduleComposerMaintenance(records) {
    if (shouldRunPeriodicMaintenance()) return true;

    for (const record of records) {
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.(COMPOSER_MUTATION_SELECTOR) ||
            node.querySelector?.(COMPOSER_MUTATION_SELECTOR)) {
          return true;
        }
      }
      // A previously inserted editor can receive its children in separate
      // mutations. This covers changes inside it without watching all attrs.
      if (record.target?.closest?.(COMPOSER_MUTATION_SELECTOR)) return true;
    }
    return false;
  }

  function scheduleMaintenance() {
    if (maintenanceScheduled) {
      return;
    }

    maintenanceScheduled = true;
    requestAnimationFrame(runMaintenance);
  }

  function observeComposerMutations(records) {
    if (shouldScheduleComposerMaintenance(records)) scheduleMaintenance();
  }

  function handlePanelMessage(event) {
    // WindowProxy identity survives iframe navigation; require origin too.
    if (!panelFrame || event.source !== panelFrame.contentWindow ||
        event.origin !== PANEL_ORIGIN) {
      return;
    }

    const message = event.data || {};

    if (message.type === "requestPanelAccountTicket") {
      // This request is only a trigger, not a trustworthy account result.
      // The random ticket is registered from the privileged content script,
      // then delivered only to the known extension iframe, never to the page.
      const frame = panelFrame;
      void (async () => {
        let ticket = null;
        let diagnostic = "NO-RANDOM-UUID";
        try {
          const candidate = globalThis.crypto?.randomUUID?.();
          if (candidate) {
            // Sample the same website session at the original, working
            // panel-request boundary (v2.8.147). Send only DID and handle
            // through privileged Firefox messaging, never window.postMessage.
            const account = readBlueskyActiveAccount();
            const result = await browser.runtime.sendMessage({
              type: "registerPanelAccountTicket", ticket: candidate, account,
            });
            if (result?.ok === true) ticket = candidate;
            else diagnostic = typeof result?.diagnostic === "string"
              ? result.diagnostic : "REGISTER-REJECTED";
          }
        } catch (_) { diagnostic = "REGISTER-MESSAGE-ERROR"; }
        if (panelFrame === frame && frame?.contentWindow) {
          sendToPanel({
            type: "panelAccountTicket", requestId: message.requestId, ticket,
            diagnostic: ticket ? undefined : diagnostic,
          });
        }
      })();
      return;
    }

    if (message.type === "panelReady") {
      panelFrameReady = true;
      preparePendingPanelOpen();
      return;
    }

    if (message.type === "panelPrepared") {
      revealPreparedPanel(message.requestId);
      return;
    }

    if (message.type === "initialFocusSet") {
      finishPanelFocusHandoff(message.requestId);
      return;
    }

    if (message.type === "suspendPanel") {
      void suspendPanel();
      return;
    }

    if (message.type === "dragPanelBy") {
      dragPanelBy(message.deltaX, message.deltaY);
      return;
    }

    if (message.type === "placePanelAt") {
      placePanelAt(message.horizontal, message.vertical);
      return;
    }

    if (message.type === "panelHeight") {
      const height = Number(message.height);
      if (Number.isFinite(height) && height > 0) {
        panelDesiredHeight = Math.ceil(height);
        positionPanel();
      }
      return;
    }

    if (message.type === "getComposerText") {
      sendToPanel({
        type: "composerText",
        requestId: message.requestId,
        text: readComposerText(),
      });
      return;
    }

    if (message.type === "setComposerText") {
      syncComposerText(message.text);
      return;
    }

    if (message.type === "pngImageDraftRisk") {
      pngImagesAtRisk = message.atRisk === true;
      updateNavigationWarning();
      return;
    }

    if (message.type === "closePanel") {
      // Native cancel and iframe Escape may both request close on one keypress.
      if (panelDialog?.open && panelFrame && !panelFrame.hidden) {
        void closePanel(message.text);
      }
      return;
    }

    if (message.type === "postComplete" && message.url) {
      panelLaunchOrigin = "native";
      // Successful posting must never navigate away from another native draft.
      // If a different composer is open, leave it untouched and avoid exposing
      // our original hidden composer over it. That original composer may have
      // survived Bluesky navigation, so release our stale reference either way.
      const otherComposerOpen = findVisibleComposers().some(
        ({ root }) => root !== hiddenComposer,
      );
      if (otherComposerOpen) {
        hiddenComposer = null;
        hiddenComposerTextbox = null;
        hiddenComposerDisplay = "";
        dismissPanelDialog();
        return;
      }
      const ownedComposer = hiddenComposer?.isConnected ? hiddenComposer : null;
      showNativeComposer();
      dismissPanelDialog();
      // The post has already succeeded; never navigate and never risk closing
      // an unrelated draft. Unknown Bluesky controls remain user-dismissable.
      if (ownedComposer) return dismissOwnedNativeComposerAfterPost(ownedComposer);
    }
  }

  function handleRuntimeMessage(message) {
    if (message?.type === "sessionChanged") {
      sendToPanel({ type: "sessionChanged", session: message.session || null });
      return { ok: true };
    }

    if (message?.type === "openPanel") {
      return { ok: showPanel() };
    }

    if (message?.type === "openFreshComposerPanel") {
      return openFreshComposerPanel();
    }

    return undefined;
  }

  window.addEventListener("message", handlePanelMessage);
  window.addEventListener("resize", positionPanel);
  window.addEventListener("scroll", positionPanel, true);
  browser.runtime.onMessage.addListener(handleRuntimeMessage);

  new MutationObserver(observeComposerMutations).observe(document.body, {
    childList: true,
    subtree: true,
  });

  runMaintenance();
  setInterval(runPeriodicMaintenance, MAINTENANCE_INTERVAL_MS);
})();
