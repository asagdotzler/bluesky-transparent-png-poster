import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile, runScript } from './helpers.mjs';

// Execute the actual content-script failure handler in isolation. In Firefox,
// the document-start redirect warning and the later regular content script both
// target the same id; a second textContent write to role=alert restarts NVDA.
function failureHarness(initialNotice = null, { signInVisible = false } = {}) {
  const source = readProjectFile('content.js');
  const start = source.indexOf('  function toolbarLaunchAbandoned() {');
  // The real content script defines these helpers earlier than the isolated
  // failure handler; provide only the cross-script marker check in this harness.
  const abandonedCheck = source.slice(start, source.indexOf('  function hasPendingFreshLaunch()', start));
  const end = source.indexOf('  async function resumePendingFreshLaunch()', start);
  assert.ok(start > 0 && end > start, 'actual failure handler must be found');

  const notices = [];
  if (initialNotice) notices.push(initialNotice);
  const tasks = [];
  const messages = [];
  let unmaskCount = 0;
  let pendingCleared = 0;
  const clearedKeys = [];
  const stored = new Map();
  const listeners = new Map();
  const intervals = [];
  let isSignInScreen = signInVisible;
  const location = { pathname: '/', search: '', hash: '#tpng-toolbar-launch' };
  const doc = {
    body: { appendChild(notice) { notices.push(notice); } },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    querySelector() { return isSignInScreen ? { id: 'signIn' } : null; },
    getElementById(id) { return notices.find(notice => notice.id === id) ?? null; },
    createElement(tag) {
      assert.ok(['div', 'h2', 'p'].includes(tag));
      let ownText = '';
      return {
        tag, id: '', children: [], tabIndex: null, focusCount: 0,
        set textContent(value) { ownText = String(value); this.children = []; },
        get textContent() { return ownText + this.children.map(x => x.textContent).join(''); },
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this[name] = value; },
        remove() { notices.splice(notices.indexOf(this), 1); },
        focus(options) { this.focusCount++; this.focusOptions = options; },
      };
    },
  };
  const scope = runScript('const TOOLBAR_LAUNCH_ABANDONED_KEY = "bskyTpngToolbarLaunchAbandoned";\n' + abandonedCheck + source.slice(source.indexOf('  function onBlueskySignInScreen() {'), end) + '\nglobalThis.showFailure = showFreshLaunchFailure;', {
    document: doc,
    window: { location, sessionStorage: {
      getItem(key) { return stored.get(key) ?? null; },
      setItem(key, value) { stored.set(key, String(value)); },
      removeItem(key) { clearedKeys.push(key); stored.delete(key); },
    } },
    endToolbarTransition() { unmaskCount++; },
    Date: { now() { return 10000; } },
    clearPendingFreshLaunch() { pendingCleared++; },
    setInterval(fn, ms) { const task = { fn, ms, stopped: false }; intervals.push(task); return task; },
    clearInterval(task) { task.stopped = true; },
    t(key) { messages.push(key); return `Localized ${key}`; },
    setTimeout(fn, ms) { tasks.push({ fn, ms }); },
  }, 'content-fresh-launch-failure.js');
  return { notices, tasks, messages, clearedKeys, stored, intervals, location,
    show: scope.showFailure,
    setSignInScreen(value) { isSignInScreen = value; },
    click() {
      listeners.get('click')?.({ target: { closest(query) {
        if (query === '#bsky-tpng-launch-error') return null;
        if (query === 'a[href],button,[role="link"],[role="button"],[role="tab"]') return { closest() { return null; } };
        return null;
      } } });
    },
    get pendingCleared() { return pendingCleared; },
    get unmaskCount() { return unmaskCount; },
  };
}

test('an already announced document-start alert is never rewritten or refocused by later content-script failure', () => {
  const early = {
    id: 'bsky-tpng-launch-error', role: 'alert', tabIndex: 0,
    textContent: 'Early sign-in warning already being read by NVDA',
    focusCount: 1,
  };
  const h = failureHarness(early);
  h.show();
  h.show({ recoveryFailed: true });
  h.show();
  assert.equal(h.notices.length, 1);
  assert.equal(early.textContent, 'Early sign-in warning already being read by NVDA');
  assert.equal(early.focusCount, 1);
  assert.deepEqual(h.messages, [], 'do not even select a replacement message');
  assert.deepEqual(h.tasks, [], 'do not schedule another focus');
  assert.equal(h.unmaskCount, 3, 'native composer still unmasked on every failure');
});

test('content-created alert populates once before focus; repeated retries never restart its announcement', () => {
  const h = failureHarness();
  h.show();
  assert.equal(h.notices.length, 1);
  const notice = h.notices[0];
  assert.equal(notice.role, 'alert');
  assert.equal(notice.tabIndex, 0);
  assert.deepEqual(notice.children.map(c => c.tag), ['h2', 'p']);
  assert.equal(notice.children[0].textContent, 'Localized toolbarLaunchWarningHeading');
  assert.equal(notice.textContent, 'Localized toolbarLaunchWarningHeadingLocalized freshLaunchFailedNotice');
  assert.deepEqual(h.messages, ['toolbarLaunchWarningHeading', 'freshLaunchFailedNotice']);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].ms, 100);
  h.tasks[0].fn();
  assert.equal(notice.focusCount, 1);
  assert.equal(notice.focusOptions.preventScroll, true);

  h.show({ recoveryFailed: true });
  h.show();
  assert.equal(h.notices.length, 1);
  assert.equal(notice.textContent, 'Localized toolbarLaunchWarningHeadingLocalized freshLaunchFailedNotice');
  assert.equal(notice.focusCount, 1);
  assert.equal(h.tasks.length, 1);
  assert.deepEqual(h.messages, ['toolbarLaunchWarningHeading', 'freshLaunchFailedNotice']);
});

test('a first, definitive recovery failure still supplies its correct message', () => {
  const h = failureHarness();
  h.show({ recoveryFailed: true });
  assert.equal(h.notices[0].textContent, 'Localized toolbarLaunchWarningHeadingLocalized freshLaunchRecoveryFailedNotice');
  assert.deepEqual(h.messages, ['toolbarLaunchWarningHeading', 'freshLaunchRecoveryFailedNotice']);
});


test('Bluesky sign-in screen removes a preexisting warning and prevents an immediate replacement', () => {
  const warning = { id: 'bsky-tpng-launch-error', textContent: 'Existing message', remove() { this.removed = true; } };
  const h = failureHarness(warning, { signInVisible: true });
  h.show();
  assert.equal(warning.removed, true);
  assert.deepEqual(h.messages, []);
  assert.equal(h.tasks.length, 0);
  assert.deepEqual(h.clearedKeys, ['bskyTpngToolbarLaunchNoticeUntil']);
  assert.equal(h.unmaskCount, 1);
});

test('Bluesky sign-in screen never gets a fresh error even if normal launch times out', () => {
  const h = failureHarness(null, { signInVisible: true });
  h.show({ recoveryFailed: true });
  assert.equal(h.notices.length, 0);
  assert.deepEqual(h.messages, []);
});


test('content-created warning dismisses on feed interaction and blocks delayed replacement', () => {
  const h = failureHarness();
  h.show();
  assert.equal(h.notices.length, 1);
  h.click();
  assert.equal(h.tasks.at(-1).ms, 600);
  h.tasks.at(-1).fn();
  assert.equal(h.notices.length, 0);
  assert.equal(h.pendingCleared, 1);
  assert.equal(h.stored.get('bskyTpngToolbarLaunchAbandoned'), '1');
  h.show({ recoveryFailed: true });
  assert.equal(h.notices.length, 0);
  assert.equal(h.messages.length, 2, 'failed retry does not create a second live-region announcement');
});

test('content-created warning dismisses after SPA route change even without click', () => {
  const h = failureHarness();
  h.show();
  h.location.pathname = '/profile/example';
  h.intervals[0].fn();
  assert.equal(h.notices.length, 0);
  assert.equal(h.pendingCleared, 1);
});

test('content-created warning retains login recovery on generic sign-in activation', () => {
  const h = failureHarness();
  h.show();
  h.click();
  h.setSignInScreen(true);
  h.tasks.at(-1).fn();
  assert.equal(h.notices.length, 0);
  assert.equal(h.pendingCleared, 0);
  assert.equal(h.stored.has('bskyTpngToolbarLaunchAbandoned'), false);
});
