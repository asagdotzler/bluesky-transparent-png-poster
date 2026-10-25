(() => {
  const { t, plural: tp, formatNumber, isolateBidiText, localizeDocument } = globalThis.TpngI18n;
  localizeDocument();

  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 2_000_000;
  const MAX_IMAGE_DIMENSION = 4000;
  // Source-file safety budget, checked from the PNG header before any full
  // file read or image decoding. Keep separate from Bluesky upload limits:
  // legitimate oversized PNGs within this budget still get optimized.
  const MAX_SOURCE_PNG_BYTES = 128_000_000;
  const MAX_SOURCE_PNG_PIXELS = 64_000_000;
  const MAX_SOURCE_PNG_SIDE = 16_384;
  const MAX_ALT_CHARACTERS = 1000;
  const MAX_POST_GRAPHEMES = 300;
  const MAX_POST_UTF8_BYTES = 3000;
  const COMPOSER_REQUEST_TIMEOUT_MS = 3000;
  // Give native editor focus and list context a short head start before
  // adding independent optimization announcements in Firefox/NVDA.
  const IMAGE_ANNOUNCEMENT_SETTLE_MS = 500;

  const state = {
    images: [],
    session: null,
    busy: false,
    pendingImageBatches: 0,
    postText: "",
    postLanguages: [],
    mentionConsent: null,
    accountCheckStatus: "idle",
    accountPage: null,
    accountRecheckInProgress: false,
    accountRecheckCount: 0,
    signedInThisDraft: false,
    signingIn: false,
    switchingAccount: false,
    cancelPending: false,
  };

  const elements = {
    dragHandle: document.getElementById("dragHandle"),
    moveComposerPicker: document.getElementById("moveComposerPicker"),
    positionChoices: [...document.querySelectorAll(".position-choice")],
    readPageButton: document.getElementById("readPageButton"),
    accountStatus: document.getElementById("accountStatus"),
    accountNotice: document.getElementById("accountNotice"),
    accountNoticeTitle: document.getElementById("accountNoticeTitle"),
    accountNoticeText: document.getElementById("accountNoticeText"),
    accountRecheckFeedback: document.getElementById("accountRecheckFeedback"),
    switchPngAccountButton: document.getElementById("switchPngAccountButton"),
    switchBlueskyAccountButton: document.getElementById("switchBlueskyAccountButton"),
    recheckAccountButton: document.getElementById("recheckAccountButton"),
    signInSection: document.getElementById("signInSection"),
    accountSwitchHelp: document.getElementById("accountSwitchHelp"),
    cancelAccountSwitchButton: document.getElementById("cancelAccountSwitchButton"),
    signInForm: document.getElementById("signInForm"),
    handleInput: document.getElementById("handleInput"),
    passwordInput: document.getElementById("passwordInput"),
    signInButton: document.getElementById("signInButton"),
    cancelButton: document.getElementById("cancelButton"),
    postTextInput: document.getElementById("postTextInput"),
    postTextCount: document.getElementById("postTextCount"),
    imageList: document.getElementById("imageList"),
    imageCount: document.getElementById("imageCount"),
    addPngHint: document.getElementById("addPngHint"),
    fileInput: document.getElementById("fileInput"),
    postButton: document.getElementById("postButton"),
    activityIndicator: document.getElementById("activityIndicator"),
    statusMessage: document.getElementById("statusMessage"),
    imageAnnouncement: document.getElementById("imageAnnouncement"),
  };

  let composerRequestSequence = 0;
  let accountCheckSequence = 0;
  let accountTicketSequence = 0;
  // Temporary v2.8.150 diagnostic: fixed reason codes only; no account data.
  let accountFailureCode = "";
  const pendingAccountTickets = new Map();
  let imageAnnouncementTimer = null;
  let pendingImageAnnouncement = null;
  let imageAnnouncementFrame = null;
  let imageAnnouncementSettleTimer = null;
  let draftGeneration = 0;
  let lastImageRiskReported = false;
  let imageAddQueue = Promise.resolve();

  function reportImageDraftRisk() {
    // Only a boolean crosses into the parent page; never image bytes or alt text.
    const atRisk = state.images.length > 0 || state.pendingImageBatches > 0;
    if (lastImageRiskReported !== atRisk) {
      lastImageRiskReported = atRisk;
      sendToPage({ type: "pngImageDraftRisk", atRisk });
    }
  }
  const pendingComposerRequests = new Map();

  function sendToBackground(message) {
    return browser.runtime.sendMessage(message);
  }

  // The webpage can observe panel -> parent messages, so do not attach
  // our private bridge secret to them. Exact target origin is sufficient here;
  // the content script separately verifies this panel's moz-extension origin.
  function sendToPage(message) {
    parent.postMessage(message, "https://bsky.app");
  }

  let panelBridgeSecret = null;
  async function initializePanelBridge() {
    try {
      const result = await browser.runtime.sendMessage({ type: "getPanelBridgeSecret" });
      if (result?.ok === true && typeof result.secret === "string") {
        panelBridgeSecret = result.secret;
      }
    } catch (_) {
      // Fail closed: an unauthenticated parent cannot manipulate this draft.
    }
    return Boolean(panelBridgeSecret);
  }

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

  function isPostTextValid() {
    return (
      countGraphemes(state.postText) <= MAX_POST_GRAPHEMES &&
      utf8Length(state.postText) <= MAX_POST_UTF8_BYTES
    );
  }

  // Check basic posting readiness: signed in, images processed, Alt text
  // supplied, and valid post text. Matching the website account and any
  // temporary editing locks are checked separately before enabling Post.
  function isDraftReadyToPost() {
    return Boolean(
      state.session &&
      state.pendingImageBatches === 0 &&
      state.images.length > 0 &&
      state.images.every((image) => image.alt.trim()) &&
      isPostTextValid()
    );
  }

  function formatBytes(bytes) {
    if (bytes < 1024 * 1024) {
      return t("fileSizeKilobytes", [
        formatNumber(bytes / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      ]);
    }
    return t("fileSizeMegabytes", [
      formatNumber(bytes / (1024 * 1024), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    ]);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function setStatus(message, kind = "") {
    elements.statusMessage.textContent = message;
    elements.statusMessage.className = `status${kind ? ` ${kind}` : ""}`;

    const working = kind === "working";
    elements.activityIndicator.hidden = !working;
    reportPanelHeight();
  }

  function deliverImageAnnouncement(message) {
    // Prefer anchoring the notification to the native Add PNG file input.
    // Element.ariaNotify() lets Firefox associate the announcement with the
    // actual form control represented in the accessibility tree.
    if (typeof elements.fileInput.ariaNotify === "function") {
      elements.fileInput.ariaNotify(message);
      return;
    }

    if (typeof document.ariaNotify === "function") {
      document.ariaNotify(message);
      return;
    }

    // Older-Firefox fallback: update native <output>. Clear first so adding the
    // same filename again still creates an accessibility-tree change.
    window.clearTimeout(imageAnnouncementTimer);
    elements.imageAnnouncement.value = "";
    imageAnnouncementTimer = window.setTimeout(() => {
      elements.imageAnnouncement.value = message;
      imageAnnouncementTimer = null;
    }, 50);
  }

  function flushPendingImageAnnouncement() {
    imageAnnouncementFrame = null;

    if (!pendingImageAnnouncement || !document.hasFocus()) {
      return;
    }

    const message = pendingImageAnnouncement;
    pendingImageAnnouncement = null;
    deliverImageAnnouncement(message);
  }

  function cancelPendingImageAnnouncement() {
    if (imageAnnouncementSettleTimer !== null) {
      window.clearTimeout(imageAnnouncementSettleTimer);
      imageAnnouncementSettleTimer = null;
    }
    if (imageAnnouncementFrame !== null) {
      window.cancelAnimationFrame(imageAnnouncementFrame);
      imageAnnouncementFrame = null;
    }
    pendingImageAnnouncement = null;
  }

  function scheduleImageAnnouncement(message) {
    cancelPendingImageAnnouncement();
    pendingImageAnnouncement = message;

    // Give Firefox/NVDA time to announce the new Alt text editor before
    // adding optimization details. This reduces interruptions; it doesn't
    // assume that screen-reader speech finishes within the delay.
    imageAnnouncementSettleTimer = window.setTimeout(() => {
      imageAnnouncementSettleTimer = null;
      imageAnnouncementFrame = window.requestAnimationFrame(flushPendingImageAnnouncement);
    }, IMAGE_ANNOUNCEMENT_SETTLE_MS);
  }

  function announceImagesAdded(addedImages) {
    if (!addedImages.length) {
      return;
    }

    const count = addedImages.length;
    const label = count === 1
      ? isolateBidiText(addedImages[0].file.name)
      : formatNumber(count);
    const optimized = addedImages.filter((image) => image.optimized);

    // A single ordinary PNG is already identified by the native Alt text
    // editor when focus moves there. Do not repeat that information through
    // a custom notification. Invalidate any older queued confirmation too.
    if (count === 1 && !optimized.length && !addedImages[0].colorInfoChanged) {
      cancelPendingImageAnnouncement();
      return;
    }

    const details = [];

    // Include optimization in the existing one-time attachment confirmation.
    // A single PNG gets its actual before/after file sizes; a batch gets only
    // the number optimized, avoiding a long list of measurements in NVDA.
    if (optimized.length) {
      details.push(count === 1
        ? t("imageOptimizedSizeSpeech", [formatBytes(optimized[0].originalSize), formatBytes(optimized[0].file.size)])
        : tp("imagesOptimized", optimized.length, [formatNumber(optimized.length)]));
    }
    if (addedImages.some((image) => image.colorInfoChanged)) {
      details.push(t("colorMayChangeAfterResize"));
    }

    // The focused editor already names the image and exposes required state.
    // For one optimized PNG, announce only the new processing information;
    // retain the aggregate confirmation for batches or exceptional warnings.
    // Reuse existing localized phrases, without another live region.
    const message = count === 1 && optimized.length
      ? details.join(" ")
      : details.length
        ? tp("imagesAddedDetails", count, [label, details.join(" ")])
        : tp("imagesAdded", count, [label]);
    scheduleImageAnnouncement(message);
  }

  function updateSessionUi() {
    elements.signInSection.hidden = Boolean(state.session) && !state.switchingAccount;
    elements.accountSwitchHelp.hidden = !state.switchingAccount;
    elements.cancelAccountSwitchButton.hidden = !state.switchingAccount;
    elements.accountStatus.textContent = state.session
      ? t("signedInAs", [isolateBidiText(state.session.handle)])
      : t("notSignedIn");
    elements.accountStatus.classList.toggle(
      "success",
      Boolean(state.session && state.signedInThisDraft)
    );
  }

  function updateAccountNotice() {
    const status = state.accountCheckStatus;
    const visible = Boolean(state.session) && status !== "matched" && status !== "idle";
    elements.accountNotice.hidden = !visible;
    elements.accountNotice.classList.toggle("pending", status === "checking");
    if (!visible) return;

    if (status === "checking") {
      elements.accountNoticeTitle.textContent = t("checkingAccountsTitle");
      elements.accountNoticeText.textContent = t("checkingAccountsDescription");
    } else if (status === "mismatch") {
      elements.accountNoticeTitle.textContent = t("accountsDoNotMatchTitle");
      elements.accountNoticeText.textContent = t("accountsDoNotMatchDescription", [
        isolateBidiText(state.accountPage?.handle ? `@${state.accountPage.handle}` : state.accountPage?.did || ""),
        isolateBidiText(state.session?.handle ? `@${state.session.handle}` : state.session?.did || ""),
      ]);
    } else {
      elements.accountNoticeTitle.textContent = t("cannotVerifyBlueskyAccountTitle");
      elements.accountNoticeText.textContent = t("cannotVerifyBlueskyAccountDescription")
        + (accountFailureCode ? ` Diagnostic: ${accountFailureCode}` : "");
    }
    elements.switchPngAccountButton.hidden = status !== "mismatch";
    elements.switchPngAccountButton.disabled = state.switchingAccount || state.accountRecheckInProgress || state.busy || state.cancelPending || state.signingIn;
    elements.switchBlueskyAccountButton.hidden = status !== "mismatch";
    elements.switchBlueskyAccountButton.disabled = elements.switchPngAccountButton.disabled || state.pendingImageBatches > 0;
    // Keep the buttons in place during a check so focus is not lost.
    elements.recheckAccountButton.hidden = false;
    elements.recheckAccountButton.disabled = state.switchingAccount || state.accountRecheckInProgress || status === "checking" || state.busy || state.cancelPending || state.signingIn;
  }

  function updatePostTextUi() {
    if (elements.postTextInput.value !== state.postText) {
      elements.postTextInput.value = state.postText;
    }

    const graphemeCount = countGraphemes(state.postText);
    const byteCount = utf8Length(state.postText);
    const overCharacterLimit = graphemeCount > MAX_POST_GRAPHEMES;
    const overByteLimit = byteCount > MAX_POST_UTF8_BYTES;

    elements.postTextCount.textContent = t("countOfMaximum", [formatNumber(graphemeCount), formatNumber(MAX_POST_GRAPHEMES)]);
    const progressPercent = Math.min(
      100,
      Math.floor((graphemeCount / MAX_POST_GRAPHEMES) * 100)
    );
    elements.postTextCount.setAttribute("aria-valuenow", String(progressPercent));
    elements.postTextCount.classList.toggle("over-limit", overCharacterLimit || overByteLimit);

    // The native maxlength attribute counts UTF-16 code units, which does not
    // match Bluesky's grapheme-aware 300-character limit. Keep our grapheme
    // validation authoritative, but expose the invalid state through the
    // textarea's native Constraint Validation API so Firefox/AT can represent
    // it as a real invalid form control without a live character counter.
    let validationMessage = "";
    if (overCharacterLimit) {
      validationMessage = t("postTextExceedsCharacterMaximum", [formatNumber(MAX_POST_GRAPHEMES)]);
    } else if (overByteLimit) {
      validationMessage = t("postTextExceedsSizeLimit");
    }
    elements.postTextInput.setCustomValidity(validationMessage);
  }

  function updateControls() {
    updatePostTextUi();

    const draftLocked = state.busy || state.cancelPending;
    elements.cancelButton.disabled = draftLocked || state.signingIn;
    elements.readPageButton.disabled = draftLocked || state.signingIn || state.pendingImageBatches > 0;
    elements.positionChoices.forEach((choice) => {
      choice.disabled = draftLocked || state.signingIn;
    });
    elements.postTextInput.disabled = draftLocked;
    elements.postButton.disabled = draftLocked || state.switchingAccount || state.accountCheckStatus !== "matched" || !isDraftReadyToPost();
    updateAccountNotice();
    elements.postButton.textContent = state.mentionConsent?.text === state.postText
      ? t('postAnyway') : t('post');
    const imageLimitReached = state.images.length >= MAX_IMAGES;
    elements.fileInput.disabled = draftLocked || imageLimitReached;
    // Explain the disabled native picker without adding a live announcement or
    // leaving a second "clickable" label in the screen-reader browse order.
    if (imageLimitReached) {
      elements.fileInput.setAttribute("aria-describedby", "imageCount");
    } else {
      elements.fileInput.removeAttribute("aria-describedby");
    }

    elements.handleInput.disabled = state.signingIn || state.cancelPending;
    elements.passwordInput.disabled = state.signingIn || state.cancelPending;
    elements.signInButton.disabled = state.signingIn || state.cancelPending;
    elements.cancelAccountSwitchButton.disabled = state.signingIn || state.cancelPending || state.busy;

    elements.imageList.querySelectorAll(".alt-text, .remove-image, .move-image").forEach((control) => {
      const isMoveButton = control.classList.contains("move-image");
      const index = Number(control.dataset.imageIndex);
      const atBoundary = isMoveButton && (
        (control.dataset.moveDirection === "up" && index === 0) ||
        (control.dataset.moveDirection === "down" && index === state.images.length - 1)
      );
      control.disabled = draftLocked || (isMoveButton && (state.pendingImageBatches > 0 || atBoundary));
    });

    elements.imageCount.textContent = imageLimitReached
      ? t("pngLimitReached", [formatNumber(state.images.length), formatNumber(MAX_IMAGES)])
      : t("countOfMaximum", [formatNumber(state.images.length), formatNumber(MAX_IMAGES)]);
    elements.addPngHint.hidden = state.images.length > 0;
    reportImageDraftRisk();
  }

  function renderAltCountStatus(image) {
    const count = escapeHtml(t("countOfMaximum", [formatNumber(image.alt.length), formatNumber(MAX_ALT_CHARACTERS)]));
    const separator = escapeHtml(t("altCountStatusSeparator"));
    const complete = Boolean(image.alt.trim());
    const className = complete ? "alt-complete" : "alt-missing";
    const status = escapeHtml(t(complete ? "altTextComplete" : "altTextRequired"));
    return `${count}${separator}<span class="${className}">${status}</span>`;
  }

  // Rebuild attachment cards when images are added or removed, using
  // native list and form controls. Alt text edits update their own status
  // without rebuilding the focused editor.
  function renderImages() {
    elements.imageList.innerHTML = state.images.map((image, index) => {
      const sizeText = image.optimized
        ? t("optimizedFileSize", [formatBytes(image.originalSize), formatBytes(image.file.size)])
        : formatBytes(image.file.size);

      const imagePosition = t("imagePosition", [formatNumber(index + 1), formatNumber(state.images.length)]);
      const imageName = escapeHtml(image.file.name);
      const altId = `alt-text-${index}`;
      const altDetailsId = `alt-details-${index}`;
      const colorNoteId = `image-color-note-${index}`;

      return `
        <li class="image-card">
          <div class="image-header">
            <h2 class="image-name-slot" title="${imageName}"><bdi class="image-name" dir="auto">${imageName}</bdi></h2>
            ${state.images.length > 1 ? `<div class="image-reorder-controls">
              <button class="secondary move-image" type="button"
                data-image-index="${index}" data-move-direction="up"
                aria-label="${escapeHtml(t("moveImageUpAccessibleLabel", [imagePosition, isolateBidiText(image.file.name)]))}"
                ${index === 0 ? "disabled" : ""}><span aria-hidden="true">↑</span></button>
              <button class="secondary move-image" type="button"
                data-image-index="${index}" data-move-direction="down"
                aria-label="${escapeHtml(t("moveImageDownAccessibleLabel", [imagePosition, isolateBidiText(image.file.name)]))}"
                ${index === state.images.length - 1 ? "disabled" : ""}><span aria-hidden="true">↓</span></button>
            </div>` : ""}
            <button
              class="secondary remove-image"
              data-image-index="${index}"
              type="button"
              aria-label="${escapeHtml(t("removeImageAccessibleLabel", [imagePosition, isolateBidiText(image.file.name)]))}"
            ></button>
          </div>
          <div class="image-visual">
            <div class="image-preview">
              <img src="${image.previewUrl}" alt="">
            </div>
          </div>
          <div class="image-meta">
            <label class="sr-only" for="${altId}">${escapeHtml(t("altTextForImage", [imagePosition, isolateBidiText(image.file.name)]))}</label>
            <textarea
              id="${altId}"
              class="alt-text"
              dir="auto"
              data-alt-index="${index}"
              maxlength="${MAX_ALT_CHARACTERS}"
              aria-required="true"
              aria-describedby="${altDetailsId}-sr"
            >${escapeHtml(image.alt)}</textarea>
            <span id="${altDetailsId}-sr" class="sr-only">${escapeHtml(t("characterMaximum", [formatNumber(MAX_ALT_CHARACTERS)]))}</span>
          </div>
          <div class="image-footer">
            <div class="image-status-row">
              <span class="image-size">${sizeText}</span>
              ${image.colorInfoChanged ? `<p id="${colorNoteId}" class="image-color-note"><svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg><span>${escapeHtml(t("colorMayChangeAfterResize"))}</span></p>` : ""}
              <div id="${altDetailsId}" class="alt-details">
                <span class="alt-count" data-alt-count="${index}">
                  ${renderAltCountStatus(image)}
                </span>
              </div>
            </div>
          </div>
        </li>
      `;
    }).join("");

    elements.imageList.querySelectorAll(".alt-text").forEach((textarea) => {
      textarea.addEventListener("input", handleAltTextInput);
    });

    elements.imageList.querySelectorAll(".remove-image").forEach((button) => {
      button.addEventListener("click", handleRemoveImage);
    });
    elements.imageList.querySelectorAll(".move-image").forEach((button) => {
      button.addEventListener("click", handleMoveImage);
    });

    updateControls();
    reportPanelHeight();
  }

  function render() {
    renderImages();
    updateSessionUi();
    updateControls();
  }

  function handleAltTextInput(event) {
    if (state.busy || state.cancelPending) {
      return;
    }

    const index = Number(event.currentTarget.dataset.altIndex);
    const image = state.images[index];
    if (!image) {
      return;
    }

    image.alt = event.currentTarget.value;

    const count = elements.imageList.querySelector(`[data-alt-count="${index}"]`);
    if (count) {
      count.innerHTML = renderAltCountStatus(image);
    }

    updateControls();
  }

  function focusAfterImageRemoval(removedIndex) {
    if (state.images.length === 0) {
      elements.fileInput.focus();
      return;
    }

    const nextIndex = Math.min(removedIndex, state.images.length - 1);
    const nextRemoveButton = elements.imageList.querySelector(
      `.remove-image[data-image-index="${nextIndex}"]`
    );
    nextRemoveButton?.focus();
  }

  function handleRemoveImage(event) {
    if (state.busy || state.cancelPending) {
      return;
    }

    const index = Number(event.currentTarget.dataset.imageIndex);
    const image = state.images[index];
    if (!image) {
      return;
    }

    URL.revokeObjectURL(image.previewUrl);
    state.images.splice(index, 1);
    renderImages();
    focusAfterImageRemoval(index);
  }

  function handleMoveImage(event) {
    if (state.busy || state.cancelPending || state.pendingImageBatches > 0) return;

    const button = event.currentTarget;
    const index = Number(button.dataset.imageIndex);
    const direction = button.dataset.moveDirection;
    if (!Number.isInteger(index) || (direction !== "up" && direction !== "down")) return;

    const destination = index + (direction === "up" ? -1 : 1);
    if (index < 0 || index >= state.images.length || destination < 0 || destination >= state.images.length) return;

    // The image object owns its File, preview URL, and Alt text. Swapping
    // objects preserves all three and also changes the publication order.
    [state.images[index], state.images[destination]] = [state.images[destination], state.images[index]];
    renderImages();

    // Re-rendering replaces the focused button. Restore focus to the moved
    // image at its new index. When the original direction hits a boundary,
    // use the reverse button rather than trying to focus a disabled control.
    const focusDirection = direction === "up" && destination === 0 ? "down"
      : direction === "down" && destination === state.images.length - 1 ? "up" : direction;
    elements.imageList.querySelector(
      `.move-image[data-image-index="${destination}"][data-move-direction="${focusDirection}"]`
    )?.focus();
  }

  // Obtain a one-time account ticket from our own content script. The parent
  // Only an authenticated parent command can answer the request; the
  // privileged background still verifies this one-use account ticket.
  function requestAccountTicket() {
    return new Promise((resolve) => {
      const requestId = ++accountTicketSequence;
      accountFailureCode = "TICKET-NO-REPLY";
      pendingAccountTickets.set(requestId, resolve);
      sendToPage({ type: "requestPanelAccountTicket", requestId });
      setTimeout(() => {
        if (!pendingAccountTickets.has(requestId)) return;
        pendingAccountTickets.delete(requestId);
        accountFailureCode = "TICKET-TIMEOUT";
        resolve(null);
      }, COMPOSER_REQUEST_TIMEOUT_MS);
    });
  }

  async function requestBlueskyActiveAccount() {
    try {
      const ticket = await requestAccountTicket();
      if (!ticket) return null;
      const result = await Promise.race([
        sendToBackground({ type: "getBlueskyActiveAccount", ticket }),
        new Promise((resolve) => setTimeout(() => resolve(null), COMPOSER_REQUEST_TIMEOUT_MS)),
      ]);
      if (result?.ok !== true) {
        accountFailureCode = typeof result?.diagnostic === "string"
          ? result.diagnostic : "BACKGROUND-NO-RESULT";
        return null;
      }
      const account = result.account;
      if (!account || typeof account.did !== "string") {
        accountFailureCode = typeof result?.diagnostic === "string"
          ? result.diagnostic : "SITE-ACCOUNT-EMPTY";
        return null;
      }
      accountFailureCode = "";
      return account;
    } catch (_) {
      accountFailureCode = "BACKGROUND-MESSAGE-ERROR";
      return null;
    }
  }

  // Check before the composer is shown, again after sign-in, and on demand.
  // A manual recheck leaves the existing warning and both buttons in place.
  // Hiding/reinserting Switch PNG account moved it beneath the mouse during
  // repeated checks, making an accidental sign-out possible.
  async function checkAccountAtEntry({ fromRecheckButton = false } = {}) {
    const manual = fromRecheckButton === true;
    if (manual && (state.accountRecheckInProgress || state.busy ||
        state.cancelPending || state.signingIn || !state.session ||
        !["mismatch", "unavailable"].includes(state.accountCheckStatus))) {
      return;
    }

    const sequence = ++accountCheckSequence;
    const expectedDid = state.session?.did;
    state.accountRecheckInProgress = manual;

    if (manual) {
      state.accountRecheckCount += 1;
      elements.accountRecheckFeedback.textContent = t("recheckAccountsInProgress", [
        formatNumber(state.accountRecheckCount),
      ]);
      // Keep the prior mismatch notice and action positions unchanged until
      // verification finishes; accountCheckStatus is already not "matched".
    } else {
      elements.accountRecheckFeedback.textContent = "";
      state.accountPage = null;
      state.accountCheckStatus = expectedDid ? "checking" : "signed-out";
    }

    updateControls();
    if (!expectedDid) return;

    const account = await requestBlueskyActiveAccount();
    if (sequence !== accountCheckSequence || state.session?.did !== expectedDid) return;
    state.accountRecheckInProgress = false;
    state.accountPage = account;
    state.accountCheckStatus = !account || typeof account.did !== "string"
      ? "unavailable"
      : account.did === expectedDid ? "matched" : "mismatch";
    updateControls();
    if (manual) {
      const key = state.accountCheckStatus === "matched"
        ? "recheckAccountsMatched"
        : state.accountCheckStatus === "mismatch"
          ? "recheckAccountsStillDifferent"
          : "recheckAccountsUnavailable";
      elements.accountRecheckFeedback.textContent = t(key, [formatNumber(state.accountRecheckCount)]);
    }
    reportPanelHeight();
    return state.accountCheckStatus;
  }

  function switchPngAccount() {
    if (state.switchingAccount || state.accountRecheckInProgress || state.busy ||
        state.cancelPending || state.signingIn || !state.session) return;
    // This opens a *provisional* sign-in form. No logout: the current
    // credentials remain in background storage until a replacement login
    // actually succeeds. Cancel or invalid credentials leave them untouched.
    state.switchingAccount = true;
    elements.passwordInput.value = "";
    if (state.accountPage?.handle) elements.handleInput.value = state.accountPage.handle;
    updateSessionUi();
    updateControls();
    setStatus("");
    elements.handleInput.focus({ preventScroll: true });
  }

  function cancelPngAccountSwitch() {
    if (!state.switchingAccount || state.signingIn || state.cancelPending || state.busy) return;
    state.switchingAccount = false;
    elements.passwordInput.value = "";
    elements.handleInput.value = "";
    updateSessionUi();
    updateControls();
    setStatus("");
    // Return focus from the hidden form to a surviving native button.
    (elements.switchPngAccountButton.hidden
      ? elements.recheckAccountButton
      : elements.switchPngAccountButton).focus({ preventScroll: true });
  }

  async function verifyPostingAccount(expectedDid) {
    const current = await requestBlueskyActiveAccount();
    if (!current || typeof current.did !== "string") {
      accountCheckSequence += 1;
      state.accountPage = null;
      state.accountCheckStatus = "unavailable";
      updateControls();
      throw new Error(t("blueskyPageAccountUnavailable"));
    }
    if (!expectedDid || current.did !== expectedDid) {
      accountCheckSequence += 1;
      state.accountPage = current;
      state.accountCheckStatus = "mismatch";
      updateControls();
      throw new Error(t("blueskyAccountMismatch", [
        isolateBidiText(current.handle ? `@${current.handle}` : current.did),
        isolateBidiText(state.session?.handle ? `@${state.session.handle}` : expectedDid || "unknown"),
      ]));
    }
    // Keep the displayed state in sync with the last validated identity.
    accountCheckSequence += 1;
    state.accountPage = current;
    state.accountCheckStatus = "matched";
    updateControls();
    return current;
  }

  function requestComposerText() {
    return new Promise((resolve) => {
      const requestId = ++composerRequestSequence;
      pendingComposerRequests.set(requestId, resolve);
      sendToPage({ type: "getComposerText", requestId });

      setTimeout(() => {
        if (!pendingComposerRequests.has(requestId)) {
          return;
        }

        pendingComposerRequests.delete(requestId);
        resolve(null);
      }, COMPOSER_REQUEST_TIMEOUT_MS);
    });
  }

  async function refreshComposerText() {
    const text = await requestComposerText();
    if (text === null) {
      return;
    }

    state.postText = text;
    state.mentionConsent = null;
    updateControls();
  }

  async function refreshSession() {
    const result = await sendToBackground({ type: "getSession" });
    state.session = result?.ok && result.session ? result.session : null;
    if (!state.session) {
      state.signedInThisDraft = false;
    }
    updateSessionUi();
    updateControls();
  }

  // Clear the previous PNG draft without reloading the editor.
  // Invalidate unfinished image work so an old attachment can't appear
  // in a newly opened draft.
  function resetDraft() {
    cancelPendingImageAnnouncement();
    draftGeneration += 1;
    imageAddQueue = Promise.resolve();
    state.pendingImageBatches = 0;
    state.images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
    state.images = [];
    state.postText = "";
    state.mentionConsent = null;
    state.cancelPending = false;
    state.postLanguages = [];
    state.signedInThisDraft = false;
    state.switchingAccount = false;
    elements.passwordInput.value = "";
    accountCheckSequence += 1;
    state.accountCheckStatus = "idle";
    state.accountPage = null;
    state.accountRecheckInProgress = false;
    state.accountRecheckCount = 0;
    elements.accountRecheckFeedback.textContent = "";
    elements.fileInput.value = "";
    elements.moveComposerPicker.open = false;
    render();
    setStatus("");
  }

  function reportPanelHeight() {
    requestAnimationFrame(() => {
      let contentBottom = 0;
      // The iframe scrolls when focus moves to an Alt text editor. Child
      // viewport rectangles shrink as it scrolls; measure from the body origin
      // so the reported content height remains stable while editing.
      const bodyTop = document.body.getBoundingClientRect().top;

      for (const child of document.body.children) {
        if (child.tagName === "SCRIPT") {
          continue;
        }
        contentBottom = Math.max(contentBottom, child.getBoundingClientRect().bottom - bodyTop);
      }

      sendToPage({
        type: "panelHeight",
        height: Math.ceil(contentBottom + 12),
      });
    });
  }

  async function isPngFile(file) {
    if (!file) {
      return false;
    }

    const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

    return pngSignature.every((byte, index) => signature[index] === byte);
  }

  // Read only the fixed 33-byte PNG signature/IHDR record before accepting a
  // source for full-file sanitizing or browser decoding. Do not use canvas or
  // a custom decoder to inspect untrusted image dimensions.
  async function checkPngProcessingBudget(file) {
    const fileName = isolateBidiText(file.name);
    if (file.size > MAX_SOURCE_PNG_BYTES) {
      throw new Error(t("sourcePngTooLarge", [fileName]));
    }

    const header = await file.slice(0, 33).arrayBuffer();
    if (header.byteLength !== 33) {
      throw new Error(t("notReadablePng", [fileName]));
    }
    const view = new DataView(header);
    if (view.getUint32(8, false) !== 13 ||
        view.getUint32(12, false) !== 0x49484452) { // "IHDR"
      throw new Error(t("notReadablePng", [fileName]));
    }
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (!width || !height) {
      throw new Error(t("notReadablePng", [fileName]));
    }
    if (width > MAX_SOURCE_PNG_SIDE || height > MAX_SOURCE_PNG_SIDE ||
        width * height > MAX_SOURCE_PNG_PIXELS) {
      throw new Error(t("sourcePngDimensionsTooLarge", [fileName]));
    }
  }

  // Copy only PNG chunks required for rendering, transparency, color signaling,
  // embedded ICC color profiles, and APNG animation. Original image payload
  // bytes and CRCs are untouched. Free-form text, EXIF, and unfamiliar
  // ancillary chunks are not carried into the bytes uploaded to Bluesky.
  function stripPngMetadata(bytes) {
    const png = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (png.length < 8 || !signature.every((value, index) => png[index] === value)) {
      throw new Error("Invalid PNG signature");
    }

    const retained = new Set([
      "IHDR", "PLTE", "tRNS", "IDAT", "IEND",
      "sRGB", "gAMA", "cHRM", "cICP", "sBIT", "iCCP",
      "acTL", "fcTL", "fdAT", // Preserve APNG frames rather than flatten animation.
    ]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const chunks = [png.subarray(0, 8)];
    let cursor = 8;
    let sawHeader = false;
    let sawImageData = false;
    let sawEnd = false;
    let changed = false;

    while (cursor < png.length) {
      if (sawEnd) {
        changed = true; // Discard bytes appended after IEND, including hidden data.
        break;
      }
      if (png.length - cursor < 12) throw new Error("Truncated PNG chunk");
      const length = view.getUint32(cursor, false);
      if (length > png.length - cursor - 12) throw new Error("Invalid PNG chunk length");
      const typeBytes = png.subarray(cursor + 4, cursor + 8);
      if (!typeBytes.every((c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
        throw new Error("Invalid PNG chunk type");
      }
      const type = String.fromCharCode(...typeBytes);
      const end = cursor + length + 12;
      if (!sawHeader && (type !== "IHDR" || length !== 13)) {
        throw new Error("Missing PNG header");
      }
      if (type === "IHDR") {
        if (sawHeader || length !== 13) throw new Error("Invalid PNG header");
        sawHeader = true;
      }
      if (type === "IDAT") sawImageData = true;
      if (type === "IEND") {
        if (length !== 0 || !sawImageData) throw new Error("Invalid PNG end");
        sawEnd = true;
      }

      if (retained.has(type)) {
        chunks.push(png.subarray(cursor, end));
      } else {
        // PNG's first type character distinguishes critical from ancillary.
        // Never discard an unknown critical chunk and risk changing the image.
        if (typeBytes[0] >= 65 && typeBytes[0] <= 90) {
          throw new Error("Unsupported critical PNG chunk");
        }
        changed = true;
      }
      cursor = end;
    }
    if (!sawEnd) throw new Error("Incomplete PNG");
    if (!changed) return { bytes: png, changed: false };
    const cleaned = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      cleaned.set(chunk, offset);
      offset += chunk.length;
    }
    return { bytes: cleaned, changed: true };
  }

  // Compare color signaling only for images that go through canvas resizing.
  // The sanitizer already validated the PNG structure, so walk the saved PNG
  // chunks without decoding ICC profiles or retaining identifying text.
  function readPngColorChunks(bytes) {
    const png = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const colorTypes = new Set(["iCCP", "cICP", "sRGB", "gAMA", "cHRM", "sBIT"]);
    const chunks = [];
    for (let cursor = 8; cursor < png.length;) {
      const length = view.getUint32(cursor, false);
      const type = String.fromCharCode(...png.subarray(cursor + 4, cursor + 8));
      if (colorTypes.has(type)) {
        // Include the PNG chunk type, payload, and CRC, not private text chunks.
        chunks.push(png.subarray(cursor + 4, cursor + 12 + length));
      }
      cursor += length + 12;
      if (type === "IEND") break;
    }
    return chunks;
  }

  function colorChunksDiffer(original, resized) {
    // Untagged source pixels offer no reliable color-space baseline; do not
    // imply a profile was lost merely because the canvas tagged its output.
    if (!original.length) return false;
    if (original.length !== resized.length) return true;
    return original.some((oldChunk, index) =>
      oldChunk.length !== resized[index].length ||
      oldChunk.some((value, byte) => value !== resized[index][byte])
    );
  }

  async function sanitizedPngFile(file) {
    let sanitized;
    try {
      sanitized = stripPngMetadata(await file.arrayBuffer());
    } catch (_) {
      throw new Error(t("notReadablePng", [isolateBidiText(file.name)]));
    }
    return sanitized.changed
      ? new File([sanitized.bytes], file.name, { type: "image/png" })
      : file;
  }

  async function encodeOptimizedPng(sourceBitmap, originalFile) {
    const longestSide = Math.max(sourceBitmap.width, sourceBitmap.height);
    const dimensionScale = Math.min(1, MAX_IMAGE_DIMENSION / longestSide);
    const byteScale = originalFile.size > MAX_IMAGE_BYTES
      ? Math.sqrt(MAX_IMAGE_BYTES / originalFile.size) * 0.9
      : 1;

    let scale = Math.min(dimensionScale, byteScale);

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const width = Math.max(1, Math.floor(sourceBitmap.width * scale));
      const height = Math.max(1, Math.floor(sourceBitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d", { alpha: true });
      context.drawImage(sourceBitmap, 0, 0, width, height);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob && blob.size <= MAX_IMAGE_BYTES && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION) {
        return {
          file: await sanitizedPngFile(new File([blob], originalFile.name, { type: "image/png" })),
          width,
          height,
        };
      }

      scale *= 0.78;
    }

    throw new Error(t("couldNotOptimizeFile", [isolateBidiText(originalFile.name)]));
  }

  // Remove unnecessary PNG metadata before deciding whether to resize.
  // If the result fits Bluesky's limits, keep the original image data;
  // use canvas only when the byte or dimension limits require it.
  async function prepareImage(file) {
    if (!(await isPngFile(file))) {
      throw new Error(t("pleaseChoosePngFiles"));
    }

    await checkPngProcessingBudget(file);
    const safeFile = await sanitizedPngFile(file);
    let bitmap;
    try {
      bitmap = await createImageBitmap(safeFile);
    } catch (_) {
      throw new Error(t("notReadablePng", [isolateBidiText(file.name)]));
    }

    try {
      const needsOptimization =
        safeFile.size > MAX_IMAGE_BYTES ||
        bitmap.width > MAX_IMAGE_DIMENSION ||
        bitmap.height > MAX_IMAGE_DIMENSION;

      if (!needsOptimization) {
        return {
          file: safeFile,
          alt: "",
          previewUrl: URL.createObjectURL(safeFile),
          optimized: false,
          colorInfoChanged: false,
          originalSize: file.size,
          width: bitmap.width,
          height: bitmap.height,
        };
      }

      setStatus(t("optimizingFile", [isolateBidiText(file.name)]));
      const optimized = await encodeOptimizedPng(bitmap, safeFile);
      const originalColor = readPngColorChunks(await safeFile.arrayBuffer());
      const resizedColor = readPngColorChunks(await optimized.file.arrayBuffer());

      return {
        file: optimized.file,
        alt: "",
        previewUrl: URL.createObjectURL(optimized.file),
        optimized: true,
        colorInfoChanged: colorChunksDiffer(originalColor, resizedColor),
        originalSize: file.size,
        width: optimized.width,
        height: optimized.height,
      };
    } finally {
      bitmap.close?.();
    }
  }

  async function addFiles(fileList, generation) {
    let hadError = false;
    const firstNewImageIndex = state.images.length;
    const addedImages = [];

    for (const file of fileList) {
      if (generation !== draftGeneration || state.busy || state.cancelPending || state.images.length >= MAX_IMAGES) {
        break;
      }

      try {
        const image = await prepareImage(file);

        // The panel may have been cancelled/reopened while image decoding or
        // optimization was in flight. Never let work from an older draft leak
        // into the current one.
        if (generation !== draftGeneration || state.busy || state.cancelPending) {
          URL.revokeObjectURL(image.previewUrl);
          break;
        }

        state.images.push(image);
        addedImages.push(image);
        renderImages();
      } catch (error) {
        if (generation !== draftGeneration) {
          break;
        }
        hadError = true;
        setStatus(error.message, "error");
      }
    }

    if (generation !== draftGeneration) {
      return;
    }

    // After the picker, paste, or drop, the next useful step is writing alt
    // text. For a batch, start with the first newly added image. Focus once,
    // after all successful additions, so later renders cannot discard it.
    if (addedImages.length) {
      const altEditor = elements.imageList.querySelector(
        `.alt-text[data-alt-index="${firstNewImageIndex}"]`
      );
      altEditor?.focus();
    }
    announceImagesAdded(addedImages);
    elements.fileInput.value = "";
    if (!hadError) {
      setStatus("");
    }
  }

  // Process image batches in order so simultaneous paste, file, or drop
  // operations can't exceed the four-image limit. Each batch belongs to
  // the draft generation that started it.
  function queueFiles(fileList) {
    const files = [...fileList];
    if (!files.length || state.busy || state.cancelPending) {
      return;
    }

    const generation = draftGeneration;
    state.pendingImageBatches += 1;
    updateControls();

    imageAddQueue = imageAddQueue
      .then(() => addFiles(files, generation))
      .catch((error) => {
        if (generation === draftGeneration) {
          setStatus(error?.message || t("couldNotAddPng"), "error");
        }
      })
      .finally(() => {
        if (generation !== draftGeneration) {
          return;
        }

        state.pendingImageBatches = Math.max(0, state.pendingImageBatches - 1);
        updateControls();
      });
  }

  async function signIn() {
    if (state.signingIn) {
      return;
    }

    const identifier = elements.handleInput.value.trim();
    const password = elements.passwordInput.value;

    if (!identifier || !password) {
      setStatus(t("enterCredentials"), "error");
      return;
    }

    state.signingIn = true;
    updateControls();
    setStatus(t("signingIn"));

    let result;

    try {
      result = await sendToBackground({
        type: "login",
        identifier,
        password,
      });
    } catch (error) {
      result = { ok: false, error: error?.message || t("signInFailed") };
    } finally {
      state.signingIn = false;
      updateControls();
    }

    if (!result?.ok) {
      setStatus(result?.error || t("signInFailed"), "error");
      return;
    }

    state.session = result.session;
    state.switchingAccount = false;
    state.signedInThisDraft = true;
    elements.passwordInput.value = "";

    // Move focus to a stable composer control before the sign-in section is
    // hidden. This avoids leaving focus on the Sign in button as its ancestor
    // disappears from the accessibility tree.
    await checkAccountAtEntry();
    if (state.accountCheckStatus === "matched") {
      elements.postTextInput.focus({ preventScroll: true });
    } else {
      elements.switchPngAccountButton.hidden === false
        ? elements.switchPngAccountButton.focus({ preventScroll: true })
        : elements.recheckAccountButton.focus({ preventScroll: true });
    }
    render();
    setStatus("");
  }

  function createPublishSnapshot() {
    const images = state.images.map((image) => Object.freeze({
      file: image.file,
      alt: image.alt.trim(),
      width: image.width,
      height: image.height,
    }));

    return Object.freeze({
      text: state.postText,
      languages: Object.freeze([...state.postLanguages]),
      images: Object.freeze(images),
    });
  }

  async function publish() {
    if (state.busy || state.cancelPending || !isDraftReadyToPost()) {
      return;
    }

    // Freeze the exact user-visible draft before the first asynchronous upload.
    // All network work below reads only from this immutable snapshot.
    const draft = createPublishSnapshot();
    state.busy = true;
    updateControls();

    try {
      // An extension session is independent from the Bluesky page. Verify
      // identity before any blob upload, and pin the expected publisher DID.
      const expectedDid = state.session?.did;
      await verifyPostingAccount(expectedDid);

      // Verify mentions before uploading blobs or creating an irreversible post.
      // Any unresolved handles need explicit confirmation for this exact text.
      if (draft.text.includes('@')) {
        setStatus(t('checkingMentions'), 'working');
      }
      const check = await sendToBackground({ type: 'checkPostMentions', text: draft.text });
      if (!check?.ok) {
        throw new Error(check?.error || t('publishingFailed'));
      }
      const unresolved = Array.isArray(check.unresolvedHandles) ? check.unresolvedHandles : [];
      const accepted = state.mentionConsent?.text === draft.text
        ? state.mentionConsent.handles : [];
      if (unresolved.some((handle) => !accepted.includes(handle))) {
        state.mentionConsent = { text: draft.text, handles: [...new Set([...accepted, ...unresolved])] };
        setStatus(t('unresolvedMentionsWarning', [
          state.mentionConsent.handles.map((handle) => '@' + handle).join(', '),
        ]), 'warning');
        return;
      }
      // Retain any prior approval for this text through the final lookup.
      // The identity endpoint may return different results between requests.

      const uploadedImages = [];

      for (let index = 0; index < draft.images.length; index += 1) {
        const image = draft.images[index];
        setStatus(t("uploadingImage", [formatNumber(index + 1), formatNumber(draft.images.length)]), "working");

        const upload = await sendToBackground({
          type: "uploadPng",
          expectedDid,
          bytes: await image.file.arrayBuffer(),
        });

        if (!upload?.ok) {
          throw new Error(upload?.error || t("imageUploadFailed"));
        }

        uploadedImages.push({
          blob: upload.blob,
          alt: image.alt,
          aspectRatio: {
            width: image.width,
            height: image.height,
          },
        });
      }

      // The website account could switch while images are uploading.
      await verifyPostingAccount(expectedDid);
      setStatus(t("publishing"), "working");

      let result;
      try {
        result = await sendToBackground({
          type: "createImagePost",
          expectedDid,
          text: draft.text,
          languages: draft.languages,
          images: uploadedImages,
          approvedUnresolvedHandles: state.mentionConsent?.text === draft.text
            ? state.mentionConsent.handles : [],
        });
      } catch (_) {
        // Firefox message delivery can fail after the background has sent
        // createRecord; missing confirmation is not proof that it failed.
        setStatus(t("publicationOutcomeUncertain"), "warning");
        return;
      }
      if (!result || result.code === "publicationOutcomeUncertain") {
        setStatus(t("publicationOutcomeUncertain"), "warning");
        return;
      }

      if (!result?.ok) {
        // A handle may fail resolution between preflight and createRecord.
        // This structured failure means that no post was created.
        if (result?.code === 'unresolvedMentions' && Array.isArray(result.handles)) {
          const prior = state.mentionConsent?.text === draft.text
            ? state.mentionConsent.handles : [];
          state.mentionConsent = {
            text: draft.text,
            handles: [...new Set([...prior, ...result.handles])],
          };
          setStatus(t('unresolvedMentionsWarning', [
            state.mentionConsent.handles.map((handle) => '@' + handle).join(', '),
          ]), 'warning');
          return;
        }
        throw new Error(result?.error || t("publishingFailed"));
      }

      setStatus(t("posted"), "success");
      await new Promise((resolve) => setTimeout(resolve, 250));
      sendToPage({ type: "postComplete", url: result.post.postUrl });

      await new Promise((resolve) => setTimeout(resolve, 500));
      resetDraft();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  async function prepareForOpen(message) {
    // Every panel open starts a fresh extension-only attachment session.
    // Native post text is imported immediately after clearing prior local state.
    resetDraft();
    state.postText = typeof message.text === "string" ? message.text : "";
    state.postLanguages = Array.isArray(message.languages)
      ? message.languages.filter((language) => typeof language === "string").slice(0, 3)
      : [];
    updateControls();
    await refreshSession();
    await checkAccountAtEntry();
    reportPanelHeight();
    sendToPage({ type: "panelPrepared", requestId: message.requestId });
  }

  // A suspension keeps the iframe, File objects, previews, alt text, and
  // editing selections intact. Collapse the position picker before minimizing.
  function prepareFocusForSuspension() {
    elements.moveComposerPicker.open = false;
  }

  function requestPageReading() {
    if (!state.busy && !state.cancelPending && !state.signingIn && state.pendingImageBatches === 0) {
      prepareFocusForSuspension();
      sendToPage({ type: "suspendPanel" });
    }
  }

  function switchBlueskyAccount() {
    // Return to Bluesky's own account UI without manipulating its session.
    // Minimize retains the existing iframe draft; Restore rechecks the DID.
    if (state.accountCheckStatus !== "mismatch" || state.switchingAccount ||
        state.accountRecheckInProgress) return;
    requestPageReading();
  }

  function handlePageMessage(event) {
    if (event.source !== parent || event.origin !== "https://bsky.app" ||
        !panelBridgeSecret || event.data?.bridgeSecret !== panelBridgeSecret) {
      return;
    }

    const message = event.data || {};

    if (message.type === "panelAccountTicket") {
      const resolve = pendingAccountTickets.get(message.requestId);
      if (resolve) {
        pendingAccountTickets.delete(message.requestId);
        if (typeof message.ticket !== "string") {
          accountFailureCode = typeof message.diagnostic === "string"
            ? message.diagnostic : "TICKET-EMPTY";
        }
        resolve(typeof message.ticket === "string" ? message.ticket : null);
      }
      return;
    }

    if (message.type === "sessionChanged") {
      const priorDid = state.session?.did;
      state.session = message.session || null;
      if (!state.session || state.session.did !== priorDid) {
        state.switchingAccount = false;
      }
      if (!state.session) {
        state.signedInThisDraft = false;
      }
      updateSessionUi();
      void checkAccountAtEntry();
      return;
    }

    if (message.type === "resetDraft") {
      resetDraft();
      return;
    }

    if (message.type === "prepareOpen") {
      prepareForOpen(message);
      return;
    }

    if (message.type === "focusInitial") {
      elements.cancelButton.focus({ preventScroll: true });
      sendToPage({ type: "initialFocusSet", requestId: message.requestId });
      return;
    }

    if (message.type === "resumeFocus") {
      // A second native composer may have been closed while we were
      // minimized. Clear only that now-obsolete Cancel conflict, not other
      // recovery errors or unrelated status messages.
      if (message.cancelConflictResolved &&
          elements.statusMessage.textContent === t("nativeComposerBlockedByAnother")) {
        setStatus("");
      }
      // Minimize and Restore form a reversible keyboard pair: Enter on one
      // moves focus to the other, without returning to a stale edit control.
      elements.readPageButton.focus({ preventScroll: true });
      // Bluesky's active account may have changed while the composer was
      // minimized. Update the notice on restoration, without losing focus.
      if (!state.busy && !state.cancelPending) void checkAccountAtEntry();
      return;
    }

    if (message.type === "requestCancel") {
      requestPanelClose();
      return;
    }

    if (message.type === "suspendCleanupFailed") {
      setStatus(t("couldNotReadBlueskyPage"), "error");
      elements.readPageButton.focus({ preventScroll: true });
      return;
    }

    if (message.type === "cancelRecoveryFailed") {
      state.cancelPending = false;
      updateControls();
      setStatus(t(message.reason === "other-composer-open"
        ? "nativeComposerBlockedByAnother"
        : "nativeComposerRecoveryFailed"), "error");
      elements.cancelButton.focus({ preventScroll: true });
      return;
    }

    if (message.type === "cancelRecoveryFocus") {
      elements.cancelButton.focus({ preventScroll: true });
      return;
    }

    if (message.type === "composerText" && pendingComposerRequests.has(message.requestId)) {
      const resolve = pendingComposerRequests.get(message.requestId);
      pendingComposerRequests.delete(message.requestId);
      resolve(message.text || "");
    }
  }

  function handlePaste(event) {
    const pngFiles = [...event.clipboardData.files].filter((file) => file.type === "image/png");
    if (!pngFiles.length) {
      return;
    }

    event.preventDefault();
    if (!state.busy && !state.cancelPending) {
      queueFiles(pngFiles);
    }
  }

  function handleDragOver(event) {
    if ([...event.dataTransfer.types].includes("Files")) {
      event.preventDefault();
    }
  }

  function handleDrop(event) {
    if (!event.dataTransfer.files.length) {
      return;
    }

    event.preventDefault();
    if (!state.busy && !state.cancelPending) {
      queueFiles(event.dataTransfer.files);
    }
  }


  // Find the first and last controls for our chosen Tab wrapping behavior.
  // This supports our current editor markup, not every Firefox focus rule.
  function getTabbableElements() {
    const selector = [
      'a[href]',
      'summary',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    return [...document.querySelectorAll(selector)].filter((element) => {
      if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
        return false;
      }

      return element.getClientRects().length > 0;
    });
  }

  function requestPanelClose() {
    // Freeze the draft until the parent confirms that its text was restored.
    // An interrupted native-composer recovery must not discard PNG state.
    if (!state.busy && !state.cancelPending && !state.signingIn) {
      state.cancelPending = true;
      updateControls();
      sendToPage({ type: "closePanel", text: state.postText });
    }
  }

  function handleEscapeDismiss(event) {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.repeat
    ) {
      return;
    }

    // The parent page's native dialog doesn't reliably receive Escape while
    // focus is in this cross-origin iframe. Route it through regular Cancel.
    event.preventDefault();
    requestPanelClose();
  }

  // Native showModal() keeps focus out of the Bluesky page, but Firefox
  // still allows Tab to reach its toolbar and sidebar. We intentionally
  // wrap Tab within the PNG composer for our preferred keyboard workflow.
  //
  // This may be less suitable for novice keyboard or screen-reader users,
  // and especially switch users who rely on Tab to reach browser controls.
  // Revisit if this causes accessibility problems or our audience expands.
  function containTabFocus(event) {
    if (
      event.key !== 'Tab' ||
      event.defaultPrevented ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    ) {
      return;
    }

    const tabbable = getTabbableElements();
    if (!tabbable.length) {
      return;
    }

    const first = tabbable[0];
    const last = tabbable[tabbable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  // Only the noninteractive header strip can be dragged. Buttons and
  // editing controls keep their normal pointer behavior.
  let draggingPointerId = null;
  let dragScreenX = 0;
  let dragScreenY = 0;

  function beginHeaderDrag(event) {
    if (event.button !== 0 || state.busy || state.cancelPending || draggingPointerId !== null) {
      return;
    }
    draggingPointerId = event.pointerId;
    dragScreenX = event.screenX;
    dragScreenY = event.screenY;
    elements.dragHandle.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveHeaderDrag(event) {
    if (event.pointerId !== draggingPointerId) {
      return;
    }
    const deltaX = event.screenX - dragScreenX;
    const deltaY = event.screenY - dragScreenY;
    dragScreenX = event.screenX;
    dragScreenY = event.screenY;
    if (deltaX || deltaY) {
      sendToPage({ type: "dragPanelBy", deltaX, deltaY });
    }
    event.preventDefault();
  }

  function endHeaderDrag(event) {
    if (event.pointerId !== draggingPointerId) {
      return;
    }
    draggingPointerId = null;
    if (elements.dragHandle.hasPointerCapture(event.pointerId)) {
      elements.dragHandle.releasePointerCapture(event.pointerId);
    }
  }

  elements.dragHandle.addEventListener("pointerdown", beginHeaderDrag);
  elements.dragHandle.addEventListener("pointermove", moveHeaderDrag);
  elements.dragHandle.addEventListener("pointerup", endHeaderDrag);
  elements.dragHandle.addEventListener("pointercancel", endHeaderDrag);

  elements.cancelButton.addEventListener("click", requestPanelClose);
  elements.readPageButton.addEventListener("click", requestPageReading);
  elements.moveComposerPicker.addEventListener("toggle", reportPanelHeight);
  elements.positionChoices.forEach((choice) => {
    choice.addEventListener("click", () => {
      if (choice.disabled || state.busy || state.cancelPending || state.signingIn) return;
      sendToPage({
        type: "placePanelAt",
        horizontal: choice.dataset.horizontal,
        vertical: choice.dataset.vertical,
      });
    });
  });
  elements.fileInput.addEventListener("change", (event) => queueFiles(event.target.files));
  elements.signInForm.addEventListener("submit", (event) => {
    event.preventDefault();
    signIn();
  });
  elements.postButton.addEventListener("click", publish);
  elements.switchPngAccountButton.addEventListener("click", switchPngAccount);
  elements.switchBlueskyAccountButton.addEventListener("click", switchBlueskyAccount);
  elements.cancelAccountSwitchButton.addEventListener("click", cancelPngAccountSwitch);
  elements.recheckAccountButton.addEventListener("click", async () => {
    const buttonHadFocus = document.activeElement === elements.recheckAccountButton;
    const result = await checkAccountAtEntry({ fromRecheckButton: true });
    // On success the mismatch notice disappears; move keyboard focus to a
    // useful editor control only if it was on the disappearing button.
    if (buttonHadFocus && result === "matched") {
      elements.postTextInput.focus({ preventScroll: true });
    }
  });
  elements.postTextInput.addEventListener("input", (event) => {
    if (state.busy || state.cancelPending) {
      updatePostTextUi();
      return;
    }

    state.postText = event.target.value;
    state.mentionConsent = null;
    setStatus('');
    sendToPage({ type: "setComposerText", text: state.postText });
    updateControls();
  });

  window.addEventListener("message", handlePageMessage);
  window.addEventListener("focus", () => {
    if (pendingImageAnnouncement) {
      // Restart the settling interval if the file picker or window stole focus.
      scheduleImageAnnouncement(pendingImageAnnouncement);
    }
  });
  window.addEventListener("paste", handlePaste);
  window.addEventListener("dragover", handleDragOver);
  window.addEventListener("drop", handleDrop);
  document.addEventListener("keydown", containTabFocus);
  document.addEventListener("keydown", handleEscapeDismiss);
  new ResizeObserver(reportPanelHeight).observe(document.body);

  async function initializePanel() {
    render();
    // Do not advertise panelReady unless the private parent control bridge
    // is authenticated. This prevents spoofed prepareOpen/resetDraft commands.
    if (!await initializePanelBridge()) return;
    await refreshSession();
    reportPanelHeight();
    sendToPage({ type: "panelReady" });
  }

  initializePanel();
})();
