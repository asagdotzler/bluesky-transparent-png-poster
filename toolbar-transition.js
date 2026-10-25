(() => {
  // A toolbar-created Bluesky tab may navigate through signed-out pages before
  // the regular content script receives the launch message. Keep only a short,
  // tab-scoped notice marker across same-origin document navigations; it is
  // cleared by the content script after a successful PNG-composer handoff.
  if (location.origin !== "https://bsky.app") return;

  // Bluesky can redirect a signed-out compose intent to / while preserving
  // only the URL fragment. That redirect can happen before document_start,
  // so sessionStorage may never have received the earlier intent marker.
  const launchFragment = location.hash === "#tpng-toolbar-launch";
  const marked = location.pathname === "/intent/compose" && launchFragment;
  const recoveryKey = "bskyTpngToolbarLaunchNoticeUntil";
  const abandonedKey = "bskyTpngToolbarLaunchAbandoned";
  const pendingKey = "bskyTpngPendingFreshLaunchUntil";
  // A dismissed failure belongs to this toolbar attempt, not later browsing.
  try {
    if (sessionStorage.getItem(abandonedKey) === "1") return;
  } catch (_) {}
  const timeoutMs = 12000;
  const redirectGraceMs = 500;
  let noticeUntil = 0;
  try {
    if (launchFragment) {
      noticeUntil = Date.now() + 60000;
      sessionStorage.setItem(recoveryKey, String(noticeUntil));
    } else {
      noticeUntil = Number(sessionStorage.getItem(recoveryKey)) || 0;
      if (!Number.isFinite(noticeUntil) || noticeUntil <= Date.now()) {
        sessionStorage.removeItem(recoveryKey);
        noticeUntil = 0;
      }
    }
  } catch (_) {
    // Web storage can be unavailable; the original document can still show
    // the failure notice using this in-memory timestamp.
    if (launchFragment) noticeUntil = Date.now() + 60000;
  }

  if (!marked && !noticeUntil) return;
  if (!marked && location.pathname !== "/" && location.pathname !== "/intent/compose") {
    // A persisted notice marker is not permission to display an error over
    // later unrelated page loads. /login is distinct: keep login recovery.
    if (/^\/login(?:\/|$)/.test(location.pathname)) {
      try { sessionStorage.removeItem(recoveryKey); } catch (_) {}
    } else {
      abandonToolbarLaunch();
    }
    return;
  }

  function launchStillPending() {
    if (Date.now() >= noticeUntil) return false;
    try {
      // Once the regular content script completes the handoff, it clears the
      // tab marker. Do not create a late failure notice after successful focus.
      return Number(sessionStorage.getItem(recoveryKey)) === noticeUntil;
    } catch (_) {
      // The URL fragment is still sufficient when site sessionStorage fails.
      return launchFragment;
    }
  }

  // Bluesky's sign-in flow may be an in-page screen without a URL change.
  // Look for site-owned login controls, not localized button text. Only the
  // toolbar-failure page runs this check; normal browsing is unaffected.
  function onBlueskySignInScreen() {
    return /^\/login(?:\/|$)/.test(location.pathname) || Boolean(
      document.querySelector?.('[data-testid="signIn"], input[autocomplete="username"], input[autocomplete="current-password"], input[type="password"]')
    );
  }

  function dismissNoticeOnSignIn() {
    if (!onBlueskySignInScreen()) return false;
    try { sessionStorage.removeItem(recoveryKey); } catch (_) {}
    document.getElementById("bsky-tpng-launch-error")?.remove();
    document.documentElement?.removeAttribute("data-tpng-toolbar-transition");
    return true;
  }

  // A redirect away from /intent/compose is not itself a failed launch:
  // Bluesky may be hydrating the signed-in page while opening its native
  // composer. Only the regular content script can decide that handoff failed.
  // Read the same narrow active-account field used by content.js; never read
  // or forward account tokens. This is a visual-warning guard, not auth proof.
  function websiteHasActiveAccount() {
    try {
      const raw = localStorage.getItem("BSKY_STORAGE");
      const did = raw && JSON.parse(raw)?.session?.currentAccount?.did;
      return typeof did === "string" && /^did:(?:plc|web):[a-zA-Z0-9.:%_-]+$/.test(did);
    } catch (_) { return false; }
  }

  function nativeComposerPresent() {
    return Boolean(document.querySelector?.('[role="dialog"] [data-testid="composerPublishBtn"]'));
  }

  function activeLaunchStillPossible() {
    return websiteHasActiveAccount() || nativeComposerPresent();
  }

  function dismissPrematureWarning() {
    if (!activeLaunchStillPossible()) return false;
    document.getElementById("bsky-tpng-launch-error")?.remove();
    return true;
  }

  function abandonToolbarLaunch() {
    try {
      sessionStorage.setItem(abandonedKey, "1");
      sessionStorage.removeItem(recoveryKey);
      sessionStorage.removeItem(pendingKey);
    } catch (_) {}
    document.getElementById("bsky-tpng-launch-error")?.remove();
    document.documentElement?.removeAttribute("data-tpng-toolbar-transition");
  }

  function pageRoute() {
    return location.pathname + (location.search || "") + (location.hash || "");
  }

  // Only a visible failed toolbar launch gets listeners. Ordinary Bluesky
  // navigation is untouched, and sign-in retains its separate recovery path.
  function watchWarningNavigation(notice) {
    const shownRoute = pageRoute();
    const onClick = (event) => {
      if (event.target?.closest?.("#bsky-tpng-launch-error")) return;
      const target = event.target?.closest?.('a[href],button,[role="link"],[role="button"],[role="tab"]');
      if (!target) return;
      // Site sign-in can be an SPA transition on the same URL. Preserve the
      // pending launch; the existing sign-in detector dismisses its warning.
      if (target.closest?.('[data-testid="signIn"],a[href*="/login"]')) return;
      // Footer sign-in can be a button with no stable URL or test ID. Let
      // Bluesky render its sign-in surface before treating the click as
      // unrelated navigation, preserving the pending login recovery.
      setTimeout(() => {
        if (document.getElementById(notice.id) !== notice) return;
        if (dismissNoticeOnSignIn() || dismissPrematureWarning()) return;
        abandonToolbarLaunch();
      }, 600);
    };
    document.addEventListener("click", onClick, true);
    const watch = setInterval(() => {
      if (document.getElementById(notice.id) !== notice) {
        clearInterval(watch);
        document.removeEventListener("click", onClick, true);
        return;
      }
      if (dismissNoticeOnSignIn() || dismissPrematureWarning() || pageRoute() !== shownRoute) {
        if (!onBlueskySignInScreen() && !activeLaunchStillPossible()) abandonToolbarLaunch();
        clearInterval(watch);
        document.removeEventListener("click", onClick, true);
      }
    }, 350);
  }

  function showInterruptedLaunchNotice() {
    // A full-document or SPA navigation may have happened before the 500 ms
    // notice timer. Never surface the previous toolbar failure on a post/feed.
    if (location.pathname !== "/" && location.pathname !== "/intent/compose") {
      if (dismissNoticeOnSignIn()) return;
      abandonToolbarLaunch();
      return;
    }
    if (dismissNoticeOnSignIn()) return;
    if (activeLaunchStillPossible()) return;
    if (!launchStillPending()) return;
    // A confirmed failed launch no longer needs the native-composer paint
    // mask. Do not unmask merely because Bluesky changed its SPA route:
    // signed-in composer initialization can still be in progress.
    document.documentElement?.removeAttribute("data-tpng-toolbar-transition");
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", showInterruptedLaunchNotice, { once: true });
      return;
    }
    if (document.getElementById("bsky-tpng-launch-error")) return;

    const notice = document.createElement("div");
    notice.id = "bsky-tpng-launch-error";
    notice.setAttribute("role", "alert");
    notice.tabIndex = 0; // Initial focus plus a normal Tab/Shift+Tab return path.

    // A real heading lets NVDA browse-mode users locate the warning again with H.
    // Populate the detached alert before appending it, so NVDA does not receive
    // multiple live-region changes while beginning its initial announcement.
    const heading = document.createElement("h2");
    heading.textContent = browser.i18n.getMessage("toolbarLaunchWarningHeading");
    const message = document.createElement("p");
    message.textContent = browser.i18n.getMessage("toolbarLaunchInterruptedNotice");
    notice.appendChild(heading);
    notice.appendChild(message);
    document.body.appendChild(notice);
    watchWarningNavigation(notice);
    // Bluesky can keep announcing its page during hydration. Focus the actual
    // failure message once, after insertion, instead of relying only on a
    // live-region event that Firefox/NVDA may interrupt or truncate.
    setTimeout(() => {
      if (document.getElementById("bsky-tpng-launch-error") === notice) {
        notice.focus({ preventScroll: true });
      }
    }, 100);
  }

  const attribute = "data-tpng-toolbar-transition";
  const mark = () => {
    if (!document.documentElement) return false;
    document.documentElement.setAttribute(attribute, "");
    return true;
  };

  // The first document observed may already be the root route, not the
  // compose-intent route. Preserve the visual mask for that marked redirect
  // too; otherwise the native editor can flash during an otherwise successful
  // signed-in toolbar launch. This CSS changes paint only, not semantics.
  const markedRootRedirect = launchFragment && location.pathname === "/"
    && activeLaunchStillPossible();
  if (marked || markedRootRedirect) {
    if (!mark()) {
      const observer = new MutationObserver(() => {
        if (mark()) observer.disconnect();
      });
      observer.observe(document, { childList: true });
      setTimeout(() => observer.disconnect(), 1000);
    }
  }

  if (!marked) {
    if (markedRootRedirect) {
      // The regular content script removes this on handoff or failure. A
      // watchdog is required if it never completes; signed-out errors unmask
      // sooner when the warning appears.
      setTimeout(() => document.documentElement?.removeAttribute(attribute), timeoutMs);
    }
    setTimeout(showInterruptedLaunchNotice, redirectGraceMs);
    return;
  }

  // Bluesky can redirect /intent/compose to /#tpng-toolbar-launch with
  // history.replaceState(), without loading a second document. A document_start
  // script will not rerun, and popstate/hashchange do not cover replaceState.
  // Watch only the marked toolbar launch and stop at redirect or timeout.
  const redirectWatch = setInterval(() => {
    if (!launchStillPending()) {
      clearInterval(redirectWatch);
      return;
    }
    if (location.pathname !== "/intent/compose") {
      clearInterval(redirectWatch);
      // A route transition isn't a failure: Bluesky may still be opening its
      // signed-in native composer. Keep the mask until handoff, a real error,
      // sign-in/navigation teardown, or the watchdog.
      setTimeout(() => {
        // A very short route transition might still complete successfully.
        if (location.pathname !== "/intent/compose") showInterruptedLaunchNotice();
      }, redirectGraceMs);
    }
  }, 150);

  // Visually unmask on a stalled handoff. Also provide a visible/NVDA error
  // if the normal content script never got a chance to report the failure.
  setTimeout(() => {
    clearInterval(redirectWatch);
    document.documentElement?.removeAttribute(attribute);
    showInterruptedLaunchNotice();
  }, timeoutMs);
})();
