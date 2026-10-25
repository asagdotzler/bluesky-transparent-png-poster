import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile, runScript } from './helpers.mjs';

const selector = 'data-tpng-toolbar-transition';
function runEarlyScript(url, { storage = new Map(), now = 10_000, existingNotice = false,
  blockStorage = false, bodyReady = true, signInVisible = false,
  siteDid = null, nativeComposer = false } = {}) {
  const attributes = new Map();
  const tasks = [];
  const intervals = [];
  const notices = [];
  const root = {
    setAttribute(key, val) { attributes.set(key, val); },
    removeAttribute(key) { attributes.delete(key); },
  };
  const sessionStorage = {
    setItem(key, val) {
      if (blockStorage) throw new Error('sessionStorage blocked');
      storage.set(key, String(val));
    },
    getItem(key) {
      if (blockStorage) throw new Error('sessionStorage blocked');
      return storage.get(key) ?? null;
    },
    removeItem(key) {
      if (blockStorage) throw new Error('sessionStorage blocked');
      storage.delete(key);
    },
  };
  let observerConstructed = false;
  let isSignInScreen = signInVisible;
  let currentSiteDid = siteDid;
  let hasNativeComposer = nativeComposer;
  let readyListener = null;
  const listeners = new Map();
  const page = new URL(url);
  const body = { appendChild(el) { notices.push(el); } };
  const document = {
    documentElement: root,
    body: bodyReady ? body : null,
    querySelector(selector) {
      if (selector === '[role="dialog"] [data-testid="composerPublishBtn"]') {
        return hasNativeComposer ? { id: "nativeComposerPublishBtn" } : null;
      }
      return isSignInScreen ? { id: "signIn" } : null;
    },
    addEventListener(type, listener) {
      if (type === 'DOMContentLoaded') readyListener = listener;
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    getElementById(id) {
      if (id === 'bsky-tpng-launch-error' && existingNotice) return { id };
      return notices.find(x => x.id === id) || null;
    },
    createElement(tag) {
      let ownText = '';
      return { tag, style: {}, children: [], focusCount: 0, focusOptions: null,
        set textContent(value) { ownText = String(value); this.children = []; },
        get textContent() { return ownText + this.children.map(x => x.textContent).join(''); },
        appendChild(child) { this.children.push(child); },
        focus(options) { this.focusCount += 1; this.focusOptions = options; },
        remove() { notices.splice(notices.indexOf(this), 1); },
        setAttribute(key, val) { this[key] = val; } };
    },
  };
  const location = { origin: page.origin, pathname: page.pathname, search: page.search, hash: page.hash };
  runScript(readProjectFile('toolbar-transition.js'), {
    location,
    document, sessionStorage,
    localStorage: { getItem(key) {
      if (key !== 'BSKY_STORAGE' || !currentSiteDid) return null;
      return JSON.stringify({ session: { currentAccount: { did: currentSiteDid } } });
    } },
    Date: { now() { return now; } },
    browser: { i18n: { getMessage(key) {
      return key === 'toolbarLaunchWarningHeading'
        ? 'Transparent PNG Poster — Warning'
        : 'Sign in to Bluesky website and retry.';
    } } },
    MutationObserver: class { constructor() { observerConstructed = true; } },
    setTimeout(fn, ms) { tasks.push({ fn, ms }); return tasks.length; },
    setInterval(fn, ms) {
      const timer = { fn, ms, stopped: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) { timer.stopped = true; },
  }, 'toolbar-transition.js');
  return { attributes, tasks, intervals, notices, root, location, storage, sessionStorage,
    clickNavigation(selector = 'a[href]') {
      listeners.get('click')?.({ target: {
        closest(query) {
          if (query === '#bsky-tpng-launch-error') return null;
          if (query === 'a[href],button,[role="link"],[role="button"],[role="tab"]') {
            return { closest(q) { return selector === 'signIn' && q.includes('signIn') ? {} : null; } };
          }
          return null;
        },
      } });
    },
    setSignInScreen(value) { isSignInScreen = value; },
    setSiteDid(value) { currentSiteDid = value; },
    setNativeComposer(value) { hasNativeComposer = value; },
    readyBody() {
      document.body = body;
      readyListener?.();
    },
    get observerConstructed() { return observerConstructed; } };
}

const key = 'bskyTpngToolbarLaunchNoticeUntil';

test('visual mask is installed only for marked toolbar intent and unmasked after 12s', () => {
  const marked = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch');
  assert.equal(marked.attributes.has(selector), true);
  assert.equal(marked.observerConstructed, false);
  assert.deepEqual(marked.tasks.map(t => t.ms), [12000]);
  assert.deepEqual(marked.intervals.map(t => t.ms), [150]);
  assert.equal(marked.storage.has(key), true);
  marked.tasks[0].fn();
  assert.equal(marked.attributes.has(selector), false, 'stalled handoff must unmask');
  assert.equal(marked.notices.length, 1, 'stalled handoff must show an alert');
  assert.equal(marked.notices[0].role, 'alert');

  for (const url of [
    'https://bsky.app/intent/compose?text=',
    'https://bsky.app/intent/compose?text=hi#unrelated',
    'https://bsky.app/profile/example#not-a-toolbar-launch',
    'https://example.com/intent/compose?text=#tpng-toolbar-launch',
  ]) {
    const other = runEarlyScript(url);
    assert.equal(other.attributes.has(selector), false, url);
    assert.equal(other.tasks.length, 0, url);
    assert.equal(other.notices.length, 0, url);
  }
});

test('a pre-document signed-out redirect to root with the fragment shows a notice with no prior storage', () => {
  // The initial /intent/compose document may never execute: the first content
  // script invocation sees only https://bsky.app/#tpng-toolbar-launch.
  const redirected = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  assert.equal(redirected.attributes.has(selector), false,
    'signed-out login UI must never be opacity-masked');
  assert.equal(redirected.storage.has(key), true);
  assert.deepEqual(redirected.tasks.map(t => t.ms), [500]);
  redirected.tasks[0].fn();
  assert.equal(redirected.notices.length, 1);
  assert.equal(redirected.notices[0].role, 'alert');
  assert.equal(redirected.notices[0].textContent, 'Transparent PNG Poster — WarningSign in to Bluesky website and retry.');
  assert.deepEqual(redirected.notices[0].children.map(x => x.tag), ['h2', 'p']);
  assert.equal(redirected.notices[0].tabIndex, 0);
  assert.deepEqual(redirected.tasks.map(t => t.ms), [500, 100]);
  redirected.tasks[1].fn();
  assert.equal(redirected.notices[0].focusCount, 1);
  assert.equal(redirected.notices[0].focusOptions.preventScroll, true);
});

test('pre-document redirect handles DOM not ready and blocked sessionStorage', () => {
  const redirected = runEarlyScript('https://bsky.app/#tpng-toolbar-launch', {
    blockStorage: true, bodyReady: false,
  });
  assert.deepEqual(redirected.tasks.map(t => t.ms), [500]);
  redirected.tasks[0].fn();
  assert.equal(redirected.notices.length, 0, 'do not append before a body exists');
  redirected.readyBody();
  assert.equal(redirected.notices.length, 1);
  assert.equal(redirected.notices[0].role, 'alert');
});

test('pre-document redirect successful handoff clears pending alert before it appears', () => {
  const redirected = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  redirected.storage.delete(key);
  redirected.tasks[0].fn();
  assert.equal(redirected.notices.length, 0);
});

test('a signed-out same-origin redirect retains an accessible alert without masking the page', () => {
  const sharedStorage = new Map();
  const marked = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch', { storage: sharedStorage });
  const redirected = runEarlyScript('https://bsky.app/', { storage: sharedStorage, now: 11_000 });
  assert.equal(redirected.attributes.has(selector), false);
  assert.deepEqual(redirected.tasks.map(t => t.ms), [500]);
  redirected.tasks[0].fn();
  assert.equal(redirected.notices.length, 1);
  assert.equal(redirected.notices[0].role, 'alert');
  assert.equal(redirected.notices[0].textContent, 'Transparent PNG Poster — WarningSign in to Bluesky website and retry.');
  assert.equal(marked.notices.length, 0, 'no premature error before the initial timeout');
});

test('a successful handoff suppresses late alerts, including after same-origin navigation', () => {
  const sharedStorage = new Map();
  const marked = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch', { storage: sharedStorage });
  const redirected = runEarlyScript('https://bsky.app/', { storage: sharedStorage });
  sharedStorage.delete(key); // cleared by finishPanelFocusHandoff
  redirected.tasks[0].fn();
  marked.tasks[0].fn();
  assert.equal(redirected.notices.length, 0);
  assert.equal(marked.notices.length, 0);
  assert.equal(marked.attributes.has(selector), false);
});

test('stale markers and an existing content-script alert do not cause duplicate notices', () => {
  const expired = runEarlyScript('https://bsky.app/', {
    storage: new Map([[key, '9000']]), now: 10_000,
  });
  assert.equal(expired.tasks.length, 0);
  assert.equal(expired.storage.has(key), false);

  const marked = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch', {
    existingNotice: true,
  });
  marked.tasks[0].fn();
  assert.equal(marked.notices.length, 0);
});


test('signed-out SPA redirect keeps paint mask until the failure warning and focuses NVDA', () => {
  const marked = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch');
  assert.equal(marked.notices.length, 0);
  marked.location.pathname = '/'; // Bluesky history.replaceState, no script reload or popstate
  marked.intervals[0].fn();
  assert.equal(marked.intervals[0].stopped, true);
  assert.equal(marked.attributes.has(selector), true, 'redirect alone must not expose an initializing native composer');
  assert.deepEqual(marked.tasks.map(t => t.ms), [12000, 500]);
  marked.tasks[1].fn();
  assert.equal(marked.notices.length, 1);
  assert.equal(marked.attributes.has(selector), false, 'confirmed signed-out error unmasks the native page');
  assert.equal(marked.notices[0].role, 'alert');
  assert.equal(marked.notices[0].tabIndex, 0);
  assert.deepEqual(marked.tasks.map(t => t.ms), [12000, 500, 100]);
  marked.tasks[2].fn();
  assert.equal(marked.notices[0].focusCount, 1, 'the whole message has keyboard focus');
  assert.equal(marked.notices[0].focusOptions.preventScroll, true);
  marked.tasks[0].fn();
  assert.equal(marked.notices.length, 1, 'watchdog must not recreate/steal focus');
});

test('a successful SPA handoff cancels redirect error and does not shift focus', () => {
  const marked = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch');
  marked.location.pathname = '/';
  marked.intervals[0].fn();
  marked.storage.delete(key); // successful PNG frame initial-focus handshake
  marked.tasks[1].fn();
  assert.equal(marked.notices.length, 0);
  marked.tasks[0].fn();
  assert.equal(marked.notices.length, 0);
});

test('normal in-page native composer is unaffected by redirect detection and alert focus', () => {
  const normal = runEarlyScript('https://bsky.app/intent/compose?text=');
  assert.equal(normal.intervals.length, 0);
  assert.equal(normal.tasks.length, 0);
  assert.equal(normal.notices.length, 0);
});


test('signed-in same-document redirect never reports a failure during native composer startup', () => {
  // Reproduces Firefox observation: Bluesky has a valid website account and
  // routes to / before the native composer and PNG iframe finish opening.
  const r = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch', {
    siteDid: 'did:plc:validaccount',
  });
  r.location.pathname = '/';
  r.intervals[0].fn();
  r.tasks.find(t => t.ms === 500).fn();
  assert.equal(r.notices.length, 0, 'redirect is not evidence of failed signed-in launch');
  r.tasks.find(t => t.ms === 12000).fn();
  assert.equal(r.notices.length, 0, 'watchdog must not invent a failed signed-in launch');
  assert.equal(r.attributes.has(selector), false, 'visual mask still has a watchdog');
});

test('signed-in SPA redirect keeps paint mask until PNG focus handoff', () => {
  const r = runEarlyScript('https://bsky.app/intent/compose?text=#tpng-toolbar-launch', {
    siteDid: 'did:plc:validaccount',
  });
  r.location.pathname = '/';
  r.intervals[0].fn();
  assert.equal(r.attributes.has(selector), true, 'SPA redirect alone must not flash native composer');
  r.setNativeComposer(true);
  r.tasks.find(t => t.ms === 500).fn();
  assert.equal(r.attributes.has(selector), true, 'native composer paint remains masked while preparing PNG');
  assert.equal(r.notices.length, 0);
  // content.js confirms initial focus, hides native editor, then removes mask.
  r.storage.delete(key);
  r.attributes.delete(selector);
  r.tasks.find(t => t.ms === 12000).fn();
  assert.equal(r.attributes.has(selector), false);
  assert.equal(r.notices.length, 0);
});

test('signed-in full-document redirect does not cover native composer with a warning', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch', {
    siteDid: 'did:web:example.com',
  });
  r.tasks[0].fn();
  assert.equal(r.notices.length, 0);
  assert.equal(r.storage.has(key), true, 'handoff recovery marker stays available');
});

test('signed-in root document with toolbar fragment masks native composer until takeover', () => {
  // Bluesky can redirect before document_start, skipping the intent document.
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch', {
    siteDid: 'did:plc:validaccount',
  });
  assert.equal(r.attributes.has(selector), true, 'first root document must not flash native composer');
  assert.deepEqual(r.tasks.map(t => t.ms), [12000, 500]);
  r.setNativeComposer(true);
  r.tasks.find(t => t.ms === 500).fn();
  assert.equal(r.attributes.has(selector), true);
  assert.equal(r.notices.length, 0);
  r.storage.delete(key); // content script completed handoff
  r.attributes.delete(selector); // content script endToolbarTransition
  r.tasks.find(t => t.ms === 12000).fn();
  assert.equal(r.notices.length, 0);
});

test('signed-in root redirect mask has 12-second fail-safe if content handoff stalls', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch', {
    siteDid: 'did:plc:validaccount',
  });
  r.tasks.find(t => t.ms === 500).fn();
  assert.equal(r.attributes.has(selector), true);
  r.tasks.find(t => t.ms === 12000).fn();
  assert.equal(r.attributes.has(selector), false);
  assert.equal(r.notices.length, 0, 'site account alone still does not prove launch failed');
});

test('a native Bluesky composer suppresses early failure even without readable site storage', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch', {
    nativeComposer: true,
  });
  r.tasks[0].fn();
  assert.equal(r.notices.length, 0, 'native composer is positive evidence of continuing handoff');
});

test('warning disappears if a native composer arrives after the signed-out fallback', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.tasks[0].fn();
  assert.equal(r.notices.length, 1);
  const notice = r.notices[0];
  r.setNativeComposer(true);
  r.intervals[0].fn();
  assert.equal(r.notices.length, 0, 'no warning over the native composer');
  assert.equal(r.storage.has('bskyTpngToolbarLaunchAbandoned'), false,
    'positive composer detection must not cancel a viable toolbar launch');
  r.tasks.find(t => t.ms === 100).fn();
  assert.equal(notice.focusCount, 0, 'removed warning must never reclaim NVDA focus');
});

test('a signed-out page with no composer retains prompt toolbar warning', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.tasks[0].fn();
  assert.equal(r.notices.length, 1);
  assert.equal(r.notices[0].role, 'alert');
});

test('visual mask preserves native composer DOM geometry, visibility and focus semantics', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  const early = manifest.content_scripts[0];
  assert.equal(early.run_at, 'document_start');
  assert.deepEqual(early.matches, ['https://bsky.app/*']);
  assert.deepEqual(early.css, ['toolbar-transition.css']);
  assert.deepEqual(early.js, ['toolbar-transition.js']);
  assert.deepEqual(manifest.content_scripts[1].js, ['i18n.js', 'content.js']);
  const css = readProjectFile('toolbar-transition.css');
  assert.match(css, /html\[data-tpng-toolbar-transition\] \[role="dialog"\]:has\(\[data-testid="composerPublishBtn"\]\)/);
  assert.match(css, /opacity:\s*0\s*!important/);
  const maskRule = css.match(/html\[data-tpng-toolbar-transition\][^{]+\{([^}]*)\}/)?.[1];
  assert.ok(maskRule, 'native composer mask rule must exist');
  assert.doesNotMatch(maskRule, /display:|visibility:|pointer-events:|inert|aria-hidden|transform:/);
  const content = readProjectFile('content.js');
  const handoff = content.slice(content.indexOf('  function finishPanelFocusHandoff('), content.indexOf('  function findComposerSurface('));
  assert.match(handoff, /hideNativeComposer\(\);\s*endToolbarTransition\(\);/);
  assert.match(content, /function showFreshLaunchFailure\([\s\S]*?endToolbarTransition\(\);/);
  assert.match(content, /if \(launchOrigin === "toolbar"\) endToolbarTransition\(\);/);
  const invalidPreparation = content.slice(content.indexOf('  function revealPreparedPanel('), content.indexOf('  function finishPanelFocusHandoff('));
  assert.match(invalidPreparation, /pendingPanelOpen = null;\s*panelReturnFocusTarget = null;\s*endToolbarTransition\(\);/);
});

test('both launch error paths share centered responsive visual warning without changing role=alert', () => {
  const css = readProjectFile('toolbar-transition.css');
  const early = readProjectFile('toolbar-transition.js');
  const content = readProjectFile('content.js');
  const sharedRule = css.match(/#bsky-tpng-launch-error\s*\{([^}]*)\}/)?.[1];
  assert.ok(sharedRule, 'shared error style must exist');
  assert.match(sharedRule, /position:\s*fixed/);
  assert.match(sharedRule, /top:\s*50%/);
  assert.match(sharedRule, /left:\s*50%/);
  assert.match(sharedRule, /transform:\s*translate\(-50%,\s*-50%\)/);
  assert.match(sharedRule, /max-height:\s*calc\(100dvh\s*-\s*32px\)/);
  assert.match(sharedRule, /overflow-y:\s*auto/);
  assert.doesNotMatch(sharedRule, /border-left-width/);
  assert.match(sharedRule, /border:\s*2px solid/);
  assert.match(css, /#bsky-tpng-launch-error h2\s*\{/);
  assert.match(css, /#bsky-tpng-launch-error p\s*\{/);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(css, /#bsky-tpng-launch-error:focus\s*\{[\s\S]*?outline:/);
  for (const script of [early, content]) {
    assert.doesNotMatch(script, /notice\.style\.cssText/);
    assert.match(script, /notice\.setAttribute\("role",\s*"alert"\)/);
    assert.match(script, /notice\.id = "bsky-tpng-launch-error"/);
    assert.match(script, /notice\.tabIndex = 0/);
    assert.match(script, /document\.createElement\("h2"\)/);
    assert.match(script, /document\.createElement\("p"\)/);
    assert.match(script, /toolbarLaunchWarningHeading/);
    assert.match(script, /notice\.focus\(\{ preventScroll: true \}\)/);
  }
});


test('entering Bluesky sign-in tears down an existing alert on the same URL without moving focus', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.tasks[0].fn();
  assert.equal(r.notices.length, 1);
  const notice = r.notices[0];
  r.tasks[1].fn();
  assert.equal(notice.focusCount, 1);
  assert.equal(r.intervals.length, 1);
  assert.equal(r.intervals[0].ms, 350);
  // Bluesky's auth UI can replace the landing view without changing location.
  r.setSignInScreen(true);
  r.intervals[0].fn();
  assert.equal(r.notices.length, 0);
  assert.equal(r.storage.has(key), false);
  assert.equal(r.intervals[0].stopped, true);
  assert.equal(notice.focusCount, 1, 'teardown must not refocus an old warning');
});

test('sign-in screen present before a delayed warning prevents its creation', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.setSignInScreen(true);
  r.tasks[0].fn();
  assert.equal(r.notices.length, 0);
  assert.equal(r.storage.has(key), false);
});

test('ordinary signed-out landing does not dismiss its warning', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.tasks[0].fn();
  r.intervals[0].fn();
  assert.equal(r.notices.length, 1);
  assert.equal(r.storage.has(key), true);
});

const abandoned = 'bskyTpngToolbarLaunchAbandoned';
const pending = 'bskyTpngPendingFreshLaunchUntil';

test('clicking an unrelated post link dismisses the warning and cancels toolbar recovery', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.storage.set(pending, '250000');
  r.tasks[0].fn();
  const notice = r.notices[0];
  r.clickNavigation();
  assert.equal(r.notices.length, 1, 'delay permits native sign-in transition');
  r.tasks.at(-1).fn(); // 600ms grace period completed without sign-in.
  assert.equal(r.notices.length, 0);
  assert.equal(r.storage.has(key), false);
  assert.equal(r.storage.has(pending), false);
  assert.equal(r.storage.get(abandoned), '1');
  r.tasks[1].fn(); // Old initial focus task must not restore focus.
  assert.equal(notice.focusCount, 0);
  r.intervals[0].fn();
  assert.equal(r.intervals[0].stopped, true);
});

test('clicking a feed tab dismisses the warning even without a URL change', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.tasks[0].fn();
  r.clickNavigation('[role="tab"]');
  r.tasks.at(-1).fn();
  assert.equal(r.notices.length, 0);
  r.tasks[0].fn();
  assert.equal(r.notices.length, 0, 'late timeout cannot recreate warning');
});

test('Bluesky SPA route change dismisses the warning without a second announcement', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.tasks[0].fn();
  r.location.pathname = '/profile/someone/post/123';
  r.location.hash = '';
  r.intervals[0].fn();
  assert.equal(r.notices.length, 0);
  assert.equal(r.intervals[0].stopped, true);
  assert.equal(r.storage.has(pending), false);
});

test('sign-in activation preserves pending recovery rather than abandoning it', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.storage.set(pending, '250000');
  r.tasks[0].fn();
  r.clickNavigation('signIn');
  assert.equal(r.notices.length, 1, 'wait for actual Bluesky sign-in screen');
  assert.equal(r.storage.has(pending), true);
  r.setSignInScreen(true);
  r.intervals[0].fn();
  assert.equal(r.notices.length, 0);
  assert.equal(r.storage.has(pending), true);
  assert.equal(r.storage.has(abandoned), false);
});

test('a dismissed warning cannot be recreated on a same-tab page load carrying the marker', () => {
  const shared = new Map();
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch', { storage: shared });
  r.tasks[0].fn();
  r.clickNavigation();
  r.tasks.at(-1).fn();
  const later = runEarlyScript('https://bsky.app/#tpng-toolbar-launch', { storage: shared });
  assert.equal(later.tasks.length, 0);
  assert.equal(later.notices.length, 0);
});

test('unlabeled footer sign-in button retains recovery if sign-in view appears during grace', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.storage.set(pending, '250000');
  r.tasks[0].fn();
  r.clickNavigation(); // A generic button; no English label or signIn test id.
  r.setSignInScreen(true);
  r.tasks.at(-1).fn();
  assert.equal(r.notices.length, 0);
  assert.equal(r.storage.has(pending), true);
  assert.equal(r.storage.has(abandoned), false);
});

test('same-tab document navigation to a post suppresses a stored failure marker', () => {
  const shared = new Map();
  runEarlyScript('https://bsky.app/#tpng-toolbar-launch', { storage: shared });
  const postPage = runEarlyScript('https://bsky.app/profile/someone/post/123', { storage: shared });
  assert.equal(postPage.tasks.length, 0);
  assert.equal(postPage.notices.length, 0);
  assert.equal(shared.has(key), false);
  assert.equal(shared.get(abandoned), '1');
});

test('full-document sign-in retains pending recovery but not the obsolete notice', () => {
  const shared = new Map([[pending, '250000']]);
  runEarlyScript('https://bsky.app/#tpng-toolbar-launch', { storage: shared });
  const login = runEarlyScript('https://bsky.app/login', { storage: shared });
  assert.equal(login.tasks.length, 0);
  assert.equal(login.notices.length, 0);
  assert.equal(shared.has(key), false);
  assert.equal(shared.has(abandoned), false);
  assert.equal(shared.has(pending), true);
});

test('a route change before delayed warning insertion cannot place it over a post', () => {
  const r = runEarlyScript('https://bsky.app/#tpng-toolbar-launch');
  r.location.pathname = '/profile/example/post/123';
  r.tasks[0].fn();
  assert.equal(r.notices.length, 0);
  assert.equal(r.storage.get(abandoned), '1');
});
