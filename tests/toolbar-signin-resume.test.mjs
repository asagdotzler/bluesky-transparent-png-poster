import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, readProjectFile, runScript, tick } from './helpers.mjs';

// Execute the actual content-script recovery functions with simulated Bluesky
// hydration. The native composer becomes visible before its restriction gate
// and avatar finish rendering; it must not be consumed or reported as failed.
const source = readProjectFile('content.js');
const start = source.indexOf('  function findReadyFreshLaunchComposer() {');
const end = source.indexOf('\n  async function openFreshComposerPanel() {', start);
assert.ok(start > 0 && end > start);
const recovery = source.slice(start, end);

function makeRecovery({ account = true, visibleComposer = false, eligible = false,
  newPostControl = false, showPanelResult = true, signIn = false } = {}) {
  let pending = true;
  let panelVisible = false;
  let accountReady = account;
  let composerVisible = visibleComposer;
  let composerEligible = eligible;
  let newPostAvailable = newPostControl;
  let isSigningIn = signIn;
  let successes = 0;
  let attempts = 0;
  let clicks = 0;
  let cleared = 0;
  let failures = 0;
  let waitCalls = 0;
  let noticeRemoved = 0;
  const waiting = deferred();
  let predicate;
  const composer = { root: { name: 'composer' } };
  const sandbox = runScript(`let freshLaunchResumeInFlight = false;\n${recovery}\nglobalThis.resume = resumePendingFreshLaunch;`, {
    dismissLaunchWarningOnSignIn: () => isSigningIn,
    onBlueskySignInScreen: () => isSigningIn,
    hasPendingFreshLaunch: () => pending,
    clearPendingFreshLaunch() { cleared++; pending = false; },
    panelFrame: null,
    document: { getElementById() { return { remove() { noticeRemoved++; } }; } },
    readBlueskyActiveAccount: () => accountReady ? { did: 'did:plc:example' } : null,
    findVisibleComposer: () => composerVisible ? composer : null,
    isEligibleStandaloneComposer: () => composerEligible,
    findNewPostControl: () => newPostAvailable ? { click() { clicks++; } } : null,
    waitFor(fn) { predicate = fn; waitCalls++; return waiting.promise; },
    NATIVE_COMPOSER_OPEN_TIMEOUT_MS: 8000,
    showPanel() { attempts++; if (showPanelResult) successes++; return showPanelResult; },
    showFreshLaunchFailure() { failures++; },
  }, 'toolbar-signin-resume.js');
  return {
    resume: sandbox.resume,
    advance({ account: a, visibleComposer: c, eligible: e, newPostControl: n, signIn: s } = {}) {
      if (a !== undefined) accountReady = a;
      if (c !== undefined) composerVisible = c;
      if (e !== undefined) composerEligible = e;
      if (n !== undefined) newPostAvailable = n;
      if (s !== undefined) isSigningIn = s;
    },
    finishWait() { waiting.resolve(predicate?.()); },
    abandon() { pending = false; },
    get ready() { return predicate?.(); },
    get state() { return { pending, panelVisible, successes, attempts, clicks, cleared, failures,
      waitCalls, noticeRemoved }; },
  };
}

test('post-login native composer hydration cannot cause a premature recovery warning', async () => {
  const h = makeRecovery({ visibleComposer: true, eligible: false });
  const run = h.resume();
  assert.equal(h.ready, null, 'visible editor alone must not count as a ready composer');
  assert.equal(h.state.pending, true, 'recovery remains available');
  assert.equal(h.state.cleared, 0);
  assert.equal(h.state.failures, 0);
  h.advance({ eligible: true });
  assert.ok(h.ready, 'fully eligible composer becomes usable');
  h.finishWait();
  await run;
  assert.equal(h.state.attempts, 1);
  assert.equal(h.state.clicks, 0, 'do not click New post if composer already exists');
  assert.equal(h.state.cleared, 1);
  assert.equal(h.state.failures, 0);
});

test('signed-in account is required before automatic recovery attempts', async () => {
  const h = makeRecovery({ account: false, visibleComposer: true, eligible: true });
  await h.resume();
  assert.equal(h.state.pending, true);
  assert.equal(h.state.waitCalls, 0);
  h.advance({ account: true });
  const run = h.resume();
  h.finishWait();
  await run;
  assert.equal(h.state.attempts, 1);
  assert.equal(h.state.failures, 0);
});

test('post-login fallback clicks New post once and waits for an eligible composer', async () => {
  const h = makeRecovery({ newPostControl: true });
  const first = h.resume();
  const second = h.resume();
  await second;
  assert.equal(h.state.clicks, 1, 'no duplicate New post clicks during in-flight recovery');
  assert.equal(h.state.attempts, 0);
  h.advance({ visibleComposer: true, eligible: true });
  h.finishWait();
  await first;
  assert.equal(h.state.cleared, 1);
  assert.equal(h.state.attempts, 1);
  assert.equal(h.state.failures, 0);
});

test('uncertain or restricted composer does not bypass eligibility checks', async () => {
  const h = makeRecovery({ visibleComposer: true, eligible: false });
  const run = h.resume();
  h.finishWait();
  await run;
  assert.equal(h.state.attempts, 0);
  assert.equal(h.state.failures, 1);
  assert.equal(h.state.cleared, 1);
});

test('cancelled pending recovery cannot open PNG composer after asynchronous readiness', async () => {
  const h = makeRecovery({ visibleComposer: true });
  const run = h.resume();
  h.advance({ eligible: true });
  h.abandon();
  h.finishWait();
  await run;
  assert.equal(h.state.attempts, 0);
  assert.equal(h.state.failures, 0);
});

test('eligible composer with failed handoff reports one failure, without retry loops', async () => {
  const h = makeRecovery({ visibleComposer: true, eligible: true, showPanelResult: false });
  const run = h.resume();
  h.finishWait();
  await run;
  assert.equal(h.state.attempts, 1);
  assert.equal(h.state.failures, 1);
  assert.equal(h.state.cleared, 1);
});
