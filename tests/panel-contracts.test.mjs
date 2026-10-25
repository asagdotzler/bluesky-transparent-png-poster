import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { makeTestI18n, deferred, makeElement, readProjectFile, runScript, tick } from './helpers.mjs';

function loadPanelHarness({ sendMessageImpl, locale = 'en', bitmapSize = [100, 100], canvasPng = null, pageAccount = { did: 'did:plc:me', handle: 'me.test' }, deferImageNotification = false } = {}) {
  let source = readProjectFile('panel.js');
  // Preserve actual control event bindings, including the native sign-in form,
  // while skipping only global listeners and asynchronous panel initialization.
  const marker = '  window.addEventListener("message", handlePageMessage);';
  const cut = source.indexOf(marker);
  assert.notEqual(cut, -1, 'panel harness marker should exist');
  source = source.slice(0, cut) + `
  globalThis.__panelTest = {
    state,
    elements,
    signIn,
    publish,
    prepareForOpen,
    checkAccountAtEntry,
    switchPngAccount,
    cancelPngAccountSwitch,
    refreshSession,
    createPublishSnapshot,
    queueFiles,
    resetDraft,
    updateControls,
    renderAltCountStatus,
    handleEscapeDismiss,
    requestPanelClose,
    handlePageMessage(event) {
      return handlePageMessage({
        ...event,
        origin: event.origin ?? 'https://bsky.app',
        data: { ...event.data, bridgeSecret: event.data?.bridgeSecret ?? 'test-panel-bridge' },
      });
    },
    setBridgeSecretForTest(secret) { panelBridgeSecret = secret; },
    prepareImage,
    stripPngMetadata,
    renderImages,
    handleMoveImage,
    handleRemoveImage,
    handleAltTextInput,
    setPrepareImage(fn) { prepareImage = fn; },
    getImageAddQueue() { return imageAddQueue; },
    getDraftGeneration() { return draftGeneration; },
  };
})();`;

  const elementIds = [
    'dragHandle', 'moveComposerPicker', 'readPageButton', 'accountStatus', 'accountNotice', 'accountNoticeTitle', 'accountNoticeText', 'accountRecheckFeedback', 'switchPngAccountButton', 'switchBlueskyAccountButton', 'recheckAccountButton', 'signInSection', 'accountSwitchHelp', 'cancelAccountSwitchButton', 'signInForm', 'handleInput', 'passwordInput', 'signInButton',
    'cancelButton', 'postTextInput', 'postTextCount', 'imageList', 'imageCount',
    'addPngHint', 'fileInput', 'postButton', 'activityIndicator', 'statusMessage',
    'imageAnnouncement',
  ];
  const elements = Object.fromEntries(elementIds.map((id) => [id, makeElement(id)]));
  elements.positionChoices = [];
  const draftControls = [makeElement('alt-control'), makeElement('remove-control'), makeElement('move-control')];
  draftControls[2].classList.add('move-image');
  elements.imageList.querySelectorAll = (selector) => selector === '.alt-text, .remove-image, .move-image' ? draftControls : [];
  elements.imageList.querySelector = () => null;

  const body = { children: [], getBoundingClientRect() { return { top: 0 }; } };
  const document = {
    body,
    activeElement: null,
    getElementById(id) { return elements[id]; },
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext() { return { drawImage() {} }; },
          toBlob(callback) { callback(canvasPng ?? new Blob([makePng()])); },
        };
      }
      return makeElement(tag);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    hasFocus() { return true; },
    ariaNotify() {},
  };

  const pageMessages = [];
  const accountRequests = [];
  let context;
  const deferredAnnouncements = new Map();
  let deferredTimerId = 4000;
  const parentFrame = { postMessage(message) {
    pageMessages.push(message);
    if (message.type === 'requestPanelAccountTicket') {
      // Content script registers this ticket through Firefox, then replies
      // directly to its own extension iframe (not the website).
      queueMicrotask(() => context.__panelTest.handlePageMessage({
        source: parentFrame,
        data: { type: 'panelAccountTicket', requestId: message.requestId,
          ticket: 'd34980c3-b974-4f0c-ad2f-376c4e6f1ab2' },
      }));
    }
  } };
  const revoked = [];
  context = runScript(source, {
    TpngI18n: makeTestI18n(locale),
    queueMicrotask,
    document,
    parent: parentFrame,
    browser: {
      runtime: {
        async sendMessage(message) {
          if (message.type === 'getBlueskyActiveAccount') {
            assert.equal(message.ticket, 'd34980c3-b974-4f0c-ad2f-376c4e6f1ab2');
            accountRequests.push(message);
            return { ok: true, account: typeof pageAccount === 'function' ? pageAccount() : pageAccount };
          }
          if (sendMessageImpl) return sendMessageImpl(message);
          return { ok: true };
        },
      },
    },
    window: {
      requestAnimationFrame(fn) { fn(); return 1; },
      cancelAnimationFrame() {},
      setTimeout(fn, delay) {
        if (deferImageNotification && delay === 500) {
          const id = ++deferredTimerId;
          deferredAnnouncements.set(id, fn);
          return id;
        }
        fn();
        return 1;
      },
      clearTimeout(id) { deferredAnnouncements.delete(id); },
    },
    requestAnimationFrame(fn) { fn(); return 1; },
    cancelAnimationFrame() {},
    setTimeout(fn, delay) { if (delay === 3000) setImmediate(fn); else fn(); return 1; },
    clearTimeout() {},
    URL: {
      createObjectURL(file) { return `blob:${file.name || 'image'}`; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    File,
    createImageBitmap: async () => ({ width: bitmapSize[0], height: bitmapSize[1], close() {} }),
  }, 'panel.js');

  context.__panelTest.setBridgeSecretForTest('test-panel-bridge');
  return {
    api: context.__panelTest, elements, document, draftControls,
    pageMessages, accountRequests, revoked, parentFrame,
    pendingAnnouncements() { return deferredAnnouncements.size; },
    releaseAnnouncements() {
      const callbacks = [...deferredAnnouncements.values()];
      deferredAnnouncements.clear();
      callbacks.forEach((callback) => callback());
    },
  };
}

function image(name, alt = 'alt') {
  return {
    file: {
      name,
      size: 100,
      async arrayBuffer() { return new TextEncoder().encode(name).buffer; },
    },
    alt,
    previewUrl: `blob:${name}`,
    optimized: false,
    originalSize: 100,
    width: 640,
    height: 480,
  };
}

test('PNG composer sign-in uses a native form without wrapping the post editor', () => {
  const html = readProjectFile('panel.html');
  const script = readProjectFile('panel.js');
  const match = html.match(/<section id="signInSection">[\s\S]*?<form id="signInForm">([\s\S]*?)<\/form>/);
  assert.ok(match, 'the login row must be enclosed by a native form');
  const form = match[1];
  for (const id of ['handleInput', 'passwordInput']) {
    assert.match(form, new RegExp(`id="${id}"`));
  }
  assert.match(form, /<button id="signInButton"[^>]*type="submit"/);
  assert.doesNotMatch(form, /id="postTextInput"|id="postButton"|id="cancelButton"/);
  assert.match(html.slice(match.index + match[0].length), /<textarea\s+id="postTextInput"/);
  assert.match(script, /elements\.signInForm\.addEventListener\("submit", \(event\) => \{\s*event\.preventDefault\(\);\s*signIn\(\);\s*\}\);/);
  assert.doesNotMatch(script, /signInButton\.addEventListener\("click"/);
  assert.doesNotMatch(script, /passwordInput\.addEventListener\("keydown"/);
});

test('native PNG composer sign-in form uses the existing validation and error path', async () => {
  const messages = [];
  const { elements } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      messages.push(message);
      return { ok: false, error: 'Check your Bluesky handle and app password, then try again.' };
    },
  });
  let prevented = 0;
  const submit = () => elements.signInForm.dispatch('submit', {
    preventDefault() { prevented += 1; },
  });

  await submit();
  assert.equal(elements.statusMessage.textContent, 'Enter your Bluesky handle and app password.');
  assert.equal(messages.length, 0, 'incomplete form must not attempt login');

  elements.handleInput.value = '   me.test  ';
  elements.passwordInput.value = 'secret-app-password';
  await submit();
  await tick();
  assert.equal(prevented, 2, 'form navigation is prevented for every submit');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'login');
  assert.equal(messages[0].identifier, 'me.test');
  assert.equal(messages[0].password, 'secret-app-password');
  assert.equal(elements.statusMessage.textContent, 'Check your Bluesky handle and app password, then try again.');
  assert.equal(elements.passwordInput.value, 'secret-app-password', 'failure allows retry');
  assert.equal(elements.signInButton.disabled, false);
});

test('pending native form submission cannot launch duplicate logins; success preserves focus handoff', async () => {
  const reply = deferred();
  const messages = [];
  const { api, elements } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      messages.push(message);
      return reply.promise;
    },
  });
  elements.handleInput.value = 'me.test';
  elements.passwordInput.value = 'app-secret';

  await elements.signInForm.dispatch('submit');
  assert.equal(messages.length, 1);
  assert.equal(api.state.signingIn, true);
  assert.equal(elements.signInButton.disabled, true);
  assert.equal(elements.passwordInput.disabled, true);
  await elements.signInForm.dispatch('submit');
  assert.equal(messages.length, 1, 'second submit must be ignored while pending');

  reply.resolve({ ok: true, session: { handle: 'me.test', did: 'did:plc:me' } });
  await tick();
  assert.equal(api.state.signingIn, false);
  assert.equal(api.state.session.handle, 'me.test');
  assert.equal(elements.passwordInput.value, '', 'password is cleared after success');
  assert.equal(elements.postTextInput.focusCount, 1, 'focus leaves the hidden sign-in section');
  assert.equal(elements.signInSection.hidden, true);
  assert.equal(elements.signInButton.disabled, false);
});

test('Restore focuses Minimize regardless of previous editing or positioning activity', () => {
  const { api, elements, parentFrame } = loadPanelHarness();
  // Starting on Cancel must not make Cancel the destination on restoration.
  api.handlePageMessage({ source: parentFrame, data: { type: 'focusInitial', requestId: '1' } });
  assert.equal(elements.cancelButton.focusCount, 1);
  elements.moveComposerPicker.open = true;
  const postTextBefore = elements.postTextInput.focusCount;
  api.handlePageMessage({ source: parentFrame, data: { type: 'resumeFocus' } });
  assert.equal(elements.readPageButton.focusCount, 1);
  assert.equal(elements.cancelButton.focusCount, 1);
  assert.equal(elements.postTextInput.focusCount, postTextBefore);
  // A second restore uses the same toggle target, not a remembered choice.
  api.handlePageMessage({ source: parentFrame, data: { type: 'resumeFocus' } });
  assert.equal(elements.readPageButton.focusCount, 2);
});


test('PNG iframe ignores forged or wrong-origin parent commands', () => {
  const { api, elements, parentFrame } = loadPanelHarness();
  const before = elements.readPageButton.focusCount || 0;
  api.handlePageMessage({ source: parentFrame, origin: 'https://evil.example',
    data: { type: 'resumeFocus', bridgeSecret: 'test-panel-bridge' } });
  api.handlePageMessage({ source: parentFrame, origin: 'https://bsky.app',
    data: { type: 'resumeFocus', bridgeSecret: 'wrong-secret' } });
  assert.equal(elements.readPageButton.focusCount || 0, before);
  api.handlePageMessage({ source: parentFrame, origin: 'https://bsky.app',
    data: { type: 'resumeFocus', bridgeSecret: 'test-panel-bridge' } });
  assert.equal(elements.readPageButton.focusCount, before + 1);
});

test('publish freezes the visible draft and locks every draft-mutating control until completion', async () => {
  const firstUpload = deferred();
  const messages = [];
  let uploadCount = 0;
  const { api, elements, draftControls } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'uploadPng') {
        uploadCount += 1;
        if (uploadCount === 1) return firstUpload.promise;
        return { ok: true, blob: { ref: `blob-${uploadCount}` } };
      }
      if (message.type === 'createImagePost') {
        return { ok: true, post: { postUrl: 'https://bsky.app/profile/me/post/1' } };
      }
      return { ok: true };
    },
  });

  api.state.session = { handle: 'me.test', did: 'did:plc:me' }; 
  api.state.postText = 'original text';
  api.state.postLanguages = ['bg', 'br'];
  api.state.images = [image('one.png', ' first alt '), image('two.png', 'second alt')];
  api.updateControls();

  const publishing = api.publish();
  await tick();
  assert.equal(api.state.busy, true);
  assert.equal(elements.cancelButton.disabled, true);
  assert.equal(elements.postTextInput.disabled, true);
  assert.equal(elements.fileInput.disabled, true);
  assert.equal(elements.postButton.disabled, true);
  assert.ok(draftControls.every((control) => control.disabled));

  // Mutate the live draft after publication has started. The network payload
  // must remain the exact snapshot captured at activation time.
  api.state.postText = 'mutated text';
  api.state.postLanguages = ['en'];
  api.state.images[0].alt = 'mutated alt';
  api.state.images.reverse();
  firstUpload.resolve({ ok: true, blob: { ref: 'blob-1' } });
  await publishing;

  const create = messages.find((message) => message.type === 'createImagePost');
  assert.equal(create.text, 'original text');
  assert.deepEqual([...create.languages], ['bg', 'br']);
  assert.deepEqual([...create.images].map((entry) => entry.alt), ['first alt', 'second alt']);
  assert.deepEqual([...create.images].map((entry) => entry.blob.ref), ['blob-1', 'blob-2']);
  assert.deepEqual(messages.filter(message => message.type === 'uploadPng').map(message => message.expectedDid), ['did:plc:me', 'did:plc:me']);
});

test('failed publish unlocks the unchanged draft for retry', async () => {
  const { api, elements } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.type === 'uploadPng') return { ok: false, error: 'Network error' };
      return { ok: true };
    },
  });

  api.state.session = { handle: 'me.test', did: 'did:plc:me' }; 
  api.state.postText = 'keep me';
  api.state.images = [image('one.png', 'keep alt')];
  const originalImage = api.state.images[0];

  await api.publish();
  assert.equal(api.state.busy, false);
  assert.equal(api.state.postText, 'keep me');
  assert.equal(api.state.images.length, 1);
  assert.equal(api.state.images[0], originalImage);
  assert.equal(api.state.images[0].alt, 'keep alt');
  assert.equal(elements.cancelButton.disabled, false);
  assert.equal(elements.postTextInput.disabled, false);
  assert.equal(elements.fileInput.disabled, false);
  assert.equal(elements.statusMessage.textContent, 'Network error');
});

test('native file picker exposes a clear full-count description and returns to ordinary count after removal', () => {
  const { api, elements } = loadPanelHarness();
  api.state.images = [image('one.png'), image('two.png'), image('three.png'), image('four.png')];
  api.updateControls();
  assert.equal(elements.fileInput.disabled, true);
  assert.equal(elements.fileInput.getAttribute('aria-describedby'), 'imageCount');
  assert.equal(elements.imageCount.textContent, '4 of 4 PNGs — maximum reached');

  api.state.images.pop();
  api.updateControls();
  assert.equal(elements.fileInput.disabled, false);
  assert.equal(elements.fileInput.getAttribute('aria-describedby'), null);
  assert.equal(elements.imageCount.textContent, '3/4');
});

test('serialized image batches cannot race past the four-image limit', async () => {
  const { api } = loadPanelHarness();
  api.setPrepareImage(async (file) => image(file.name, ''));

  api.queueFiles([{ name: '1.png' }, { name: '2.png' }, { name: '3.png' }]);
  api.queueFiles([{ name: '4.png' }, { name: '5.png' }, { name: '6.png' }]);
  await api.getImageAddQueue();

  assert.equal(api.state.images.length, 4);
  assert.deepEqual([...api.state.images].map((entry) => entry.file.name), ['1.png', '2.png', '3.png', '4.png']);
  assert.equal(api.state.pendingImageBatches, 0);
});

test('image work from an old draft is discarded after reset', async () => {
  const pending = deferred();
  const { api, revoked } = loadPanelHarness();
  api.setPrepareImage(() => pending.promise);

  api.queueFiles([{ name: 'slow.png' }]);
  const oldQueue = api.getImageAddQueue();
  await tick();
  const oldGeneration = api.getDraftGeneration();
  api.resetDraft();
  assert.ok(api.getDraftGeneration() > oldGeneration);

  pending.resolve(image('slow.png', ''));
  await oldQueue;
  assert.equal(api.state.images.length, 0);
  assert.ok(revoked.includes('blob:slow.png'));
});

test('in-panel sign-in allows only one request at a time and recovers after failure', async () => {
  const login = deferred();
  let calls = 0;
  const { api, elements } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      if (message.type === 'login') {
        calls += 1;
        return login.promise;
      }
      return { ok: true };
    },
  });
  elements.handleInput.value = 'me.test';
  elements.passwordInput.value = 'wrong';

  const first = api.signIn();
  const second = api.signIn();
  assert.equal(calls, 1);
  assert.equal(elements.handleInput.disabled, true);
  assert.equal(elements.passwordInput.disabled, true);
  assert.equal(elements.signInButton.disabled, true);

  login.resolve({ ok: false, error: 'Check your Bluesky handle and app password, then try again.' });
  await Promise.all([first, second]);
  assert.equal(elements.handleInput.disabled, false);
  assert.equal(elements.passwordInput.disabled, false);
  assert.equal(elements.signInButton.disabled, false);
  assert.equal(elements.handleInput.value, 'me.test');
  assert.equal(elements.passwordInput.value, 'wrong');
});

test('post text uses native custom validity for the grapheme-aware limit without truncating input', () => {
  const { api, elements } = loadPanelHarness();

  api.state.postText = 'a'.repeat(300);
  api.updateControls();
  assert.equal(elements.postTextInput.validationMessage, '');
  assert.equal(elements.postTextInput.value.length, 300);
  assert.equal(elements.postButton.disabled, true, 'other draft requirements still govern Post');

  api.state.postText = 'a'.repeat(301);
  api.updateControls();
  assert.equal(elements.postTextInput.validationMessage, 'Post text exceeds the 300 character maximum.');
  assert.equal(elements.postTextInput.value.length, 301, 'text remains editable rather than being truncated');

  api.state.postText = 'a'.repeat(299);
  api.updateControls();
  assert.equal(elements.postTextInput.validationMessage, '', 'returning under the limit clears native invalid state');
});


test('visible post counter exposes a 0-100 progressbar value from the grapheme count', () => {
  const { api, elements } = loadPanelHarness();

  api.state.postText = 'a'.repeat(275);
  api.updateControls();
  assert.equal(elements.postTextCount.textContent, '275/300');
  assert.equal(elements.postTextCount.getAttribute('aria-valuenow'), '91');

  api.state.postText = 'a'.repeat(299);
  api.updateControls();
  assert.equal(elements.postTextCount.getAttribute('aria-valuenow'), '99', 'progress remains below 100 until the limit is reached');

  api.state.postText = 'a'.repeat(300);
  api.updateControls();
  assert.equal(elements.postTextCount.getAttribute('aria-valuenow'), '100');

  api.state.postText = 'a'.repeat(301);
  api.updateControls();
  assert.equal(elements.postTextCount.getAttribute('aria-valuenow'), '100', 'progress clamps at 100 above the limit');
  assert.equal(elements.postTextInput.validationMessage, 'Post text exceeds the 300 character maximum.');
});


test('alt-text status remains catalog-driven and keeps completion semantics', () => {
  const en = loadPanelHarness().api;
  assert.equal(en.renderAltCountStatus({ alt: '' }),
    '0/1,000 · <span class="alt-missing">Alt text required</span>');
  assert.equal(en.renderAltCountStatus({ alt: 'ok' }),
    '2/1,000 · <span class="alt-complete">✓ Alt text complete</span>');
});


test('Escape in focused iframe requests Cancel once and consumes the key', () => {
  const { api, pageMessages } = loadPanelHarness();
  let consumed = 0;
  api.handleEscapeDismiss({
    key: 'Escape', defaultPrevented: false, isComposing: false,
    preventDefault() { consumed += 1; },
  });
  assert.equal(consumed, 1);
  assert.deepEqual(pageMessages.map((message) => message.type), ['closePanel']);
});

test('Escape does not cancel while publishing or while a modifier/composition blocks it', () => {
  const { api, pageMessages } = loadPanelHarness();
  let consumed = 0;
  const event = (overrides = {}) => ({
    key: 'Escape', defaultPrevented: false, isComposing: false,
    preventDefault() { consumed += 1; },
    ...overrides,
  });
  for (const overrides of [
    { key: 'Tab' }, { defaultPrevented: true }, { isComposing: true },
    { ctrlKey: true }, { altKey: true }, { metaKey: true },
  ]) api.handleEscapeDismiss(event(overrides));
  api.state.busy = true;
  api.handleEscapeDismiss(event());
  assert.equal(consumed, 1, 'busy Escape is consumed, not allowed to dismiss the native dialog');
  assert.equal(pageMessages.length, 0, 'busy Escape cannot initiate Cancel');
});


test('parent native-dialog cancel requests honor the same busy state as the Cancel button', () => {
  const { api, parentFrame, pageMessages } = loadPanelHarness();
  api.state.busy = true;
  api.handlePageMessage({ source: parentFrame, data: { type: 'requestCancel' } });
  assert.equal(pageMessages.length, 0);
  api.state.busy = false;
  api.handlePageMessage({ source: {}, data: { type: 'requestCancel' } });
  assert.equal(pageMessages.length, 0, 'untrusted request ignored');
  api.handlePageMessage({ source: parentFrame, data: { type: 'requestCancel' } });
  assert.deepEqual(pageMessages.map((message) => message.type), ['closePanel']);
});


test('Escape listener is wired to panel keydown events, without replacing the Tab focus trap', () => {
  const source = readProjectFile('panel.js');
  assert.match(source, /document\.addEventListener\("keydown", containTabFocus\)/);
  assert.match(source, /document\.addEventListener\("keydown", handleEscapeDismiss\)/);
});


test('publish success copy no longer promises navigation to the posted message', () => {
  const messages = JSON.parse(readProjectFile('_locales/en/messages.json'));
  const panel = readProjectFile('panel.js');
  assert.equal(messages.posted.message, 'Posted.');
  assert.equal(messages.postedOpeningNewPost, undefined);
  assert.match(panel, /setStatus\(t\("posted"\), "success"\)/);
});

test('unresolved mention warning precedes all uploads; Post anyway requires an explicit second click', async () => {
  const messages = [];
  const { api, elements, pageMessages } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: ['absent.bsky.social'] };
      if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'uploaded' } };
      if (message.type === 'createImagePost') return { ok: true, post: { postUrl: 'https://bsky.app/profile/me/post/1' } };
      throw new Error(`unrecognized message ${message.type}`);
    },
  });
  api.state.session = { handle: 'me.test', did: 'did:plc:me' }; 
  api.state.postText = 'Hi @absent.bsky.social';
  api.state.images = [image('one.png', 'alt')];
  api.state.accountCheckStatus = 'matched';
  api.updateControls();
  assert.equal(elements.postButton.textContent, 'Post');

  await api.publish();
  assert.equal(messages.filter(m => m.type === 'uploadPng').length, 0);
  assert.equal(messages.filter(m => m.type === 'createImagePost').length, 0);
  assert.match(elements.statusMessage.textContent, /@absent\.bsky\.social/);
  assert.equal(elements.statusMessage.className, 'status warning');
  assert.equal(elements.postButton.textContent, 'Post anyway');
  assert.equal(elements.postButton.disabled, false);
  assert.equal(api.state.busy, false);

  await api.publish();
  assert.deepEqual([...messages.filter(m => m.type === 'createImagePost')[0].approvedUnresolvedHandles], ['absent.bsky.social']);
  assert.equal(messages.filter(m => m.type === 'createImagePost').length, 1);
  assert.equal(pageMessages.filter(m => m.type === 'postComplete').length, 1);
  assert.equal(elements.postButton.textContent, 'Post');
});

test('editing the text revokes Post anyway consent and requires fresh confirmation', async () => {
  const messages = [];
  const { api, elements } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: ['absent.bsky.social'] };
      throw new Error('must not upload or publish without new approval');
    },
  });
  api.state.session = { handle: 'me.test', did: 'did:plc:me' }; 
  api.state.postText = 'Hi @absent.bsky.social';
  api.state.images = [image('one.png', 'alt')];
  await api.publish();
  assert.equal(elements.postButton.textContent, 'Post anyway');
  await elements.postTextInput.dispatch('input', { target: { value: '🌿 Hi @absent.bsky.social' } });
  assert.equal(elements.postButton.textContent, 'Post');
  assert.equal(api.state.mentionConsent, null);
  assert.equal(elements.statusMessage.textContent, '');
  await api.publish();
  assert.equal(messages.filter(m => m.type === 'checkPostMentions').length, 2);
  assert.equal(elements.postButton.textContent, 'Post anyway');
});

test('late mention lookup failure pauses before publication and uses fresh approval on retry', async () => {
  const messages = [];
  let lateFailure = true;
  const { api, elements } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
      if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'blob' } };
      if (message.type === 'createImagePost') {
        if (lateFailure) {
          lateFailure = false;
          return { ok: false, code: 'unresolvedMentions', handles: ['late.bsky.social'] };
        }
        return { ok: true, post: { postUrl: 'https://bsky.app/profile/me/post/1' } };
      }
      return { ok: true };
    },
  });
  api.state.session = { handle: 'me.test', did: 'did:plc:me' }; 
  api.state.postText = '@late.bsky.social';
  api.state.images = [image('one.png', 'alt')];
  await api.publish();
  assert.equal(elements.postButton.textContent, 'Post anyway');
  assert.match(elements.statusMessage.textContent, /@late\.bsky\.social/);
  assert.equal(api.state.busy, false);
  await api.publish();
  assert.equal(messages.filter(m => m.type === 'createImagePost').length, 2);
  assert.deepEqual([...messages.filter(m => m.type === 'createImagePost')[1].approvedUnresolvedHandles], ['late.bsky.social']);
});

test('clean preflight keeps the normal Post control and publishes exactly once', async () => {
  const messages = [];
  const { api, elements } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
      if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'blob' } };
      if (message.type === 'createImagePost') return { ok: true, post: { postUrl: 'https://bsky.app/profile/me/post/1' } };
      return { ok: true };
    },
  });
  api.state.session = { handle: 'me.test', did: 'did:plc:me' }; 
  api.state.postText = 'Hello @real.bsky.social';
  api.state.images = [image('one.png', 'alt')];
  await api.publish();
  assert.equal(messages.filter(m => m.type === 'createImagePost').length, 1);
  assert.equal(elements.postButton.textContent, 'Post');
  assert.equal(elements.statusMessage.textContent, '');
});


// Real, CRC-correct PNG fixtures; production sanitizer bytes pass through the
// actual panel preparation path rather than a source-text assertion.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(name, data = Buffer.alloc(0)) {
  const type = Buffer.from(name, 'ascii');
  const payload = Buffer.from(data);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, payload])));
  return Buffer.concat([size, type, payload, crc]);
}

function makePng({ customChunks = [], tail = Buffer.alloc(0) } = {}) {
  const header = Buffer.from('89504e470d0a1a0a', 'hex');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // 8-bit RGBA, with one fully transparent pixel
  ihdr[9] = 6;
  const image = deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 0]));
  return Buffer.concat([
    header, makeChunk('IHDR', ihdr),
    ...customChunks,
    makeChunk('IDAT', image), makeChunk('IEND'), tail,
  ]);
}

function chunkNames(bytes) {
  const output = [];
  for (let i = 8; i < bytes.length;) {
    const len = bytes.readUInt32BE(i);
    output.push(bytes.toString('ascii', i + 4, i + 8));
    i += len + 12;
    if (output.at(-1) === 'IEND') break;
  }
  return output;
}

function chunkPayloads(bytes, type) {
  const payloads = [];
  for (let i = 8; i < bytes.length;) {
    const len = bytes.readUInt32BE(i);
    if (bytes.toString('ascii', i + 4, i + 8) === type) {
      payloads.push(bytes.subarray(i + 8, i + 8 + len));
    }
    i += len + 12;
    if (i > bytes.length) break;
  }
  return payloads;
}

test('metadata-bearing RGBA PNG keeps its ICC profile while stripping text/EXIF metadata without altering image-data or transparency bytes', async () => {
  const metadata = [
    makeChunk('tEXt', Buffer.from('Author\0Sensitive Name')),
    makeChunk('iTXt', Buffer.from('parameters\0\0\0\0\0Generation prompt')),
    makeChunk('zTXt', Buffer.from('comment\0\0secret')),
    makeChunk('eXIf', Buffer.from('GPS and camera identifiers')),
    makeChunk('iCCP', Buffer.from('private profile name\0\0secret')),
    makeChunk('pHYs', Buffer.alloc(9)),
    makeChunk('sRGB', Buffer.from([0])),
    makeChunk('gAMA', Buffer.from([0, 0, 177, 143])),
    makeChunk('abCd', Buffer.from('private ancillary data')),
  ];
  const inputBytes = makePng({ customChunks: metadata });
  const { api } = loadPanelHarness();
  const source = new File([inputBytes], 'private.png', { type: 'image/png' });
  const result = await api.prepareImage(source);
  const uploadedBytes = Buffer.from(await result.file.arrayBuffer());
  assert.equal(result.optimized, false, 'metadata-only cleaning must not invoke lossy canvas resizing');
  assert.equal(result.originalSize, inputBytes.length);
  assert.ok(result.file.size < source.size);
  assert.deepEqual(chunkNames(uploadedBytes), ['IHDR', 'iCCP', 'sRGB', 'gAMA', 'IDAT', 'IEND']);
  assert.deepEqual(chunkPayloads(uploadedBytes, 'IDAT'), chunkPayloads(inputBytes, 'IDAT'));
  assert.ok(!uploadedBytes.includes(Buffer.from('Sensitive Name')));
  assert.ok(!uploadedBytes.includes(Buffer.from('Generation prompt')));
  assert.ok(!uploadedBytes.includes(Buffer.from('GPS')));
  assert.ok(uploadedBytes.includes(Buffer.from('private profile name')));
});

test('metadata stripping can avoid resizing a PNG whose original exceeds upload limit', async () => {
  const input = makePng({ customChunks: [makeChunk('tEXt', Buffer.alloc(2_010_000, 65))] });
  const { api } = loadPanelHarness();
  const result = await api.prepareImage(new File([input], 'big-metadata.png', { type: 'image/png' }));
  assert.ok(result.originalSize > 2_000_000);
  assert.ok(result.file.size < 2_000_000);
  assert.equal(result.optimized, false);
  assert.deepEqual(chunkNames(Buffer.from(await result.file.arrayBuffer())), ['IHDR', 'IDAT', 'IEND']);
});

test('PNG with no removable metadata retains its exact original file and image data', async () => {
  const source = new File([makePng()], 'already-clean.png', { type: 'image/png' });
  const { api } = loadPanelHarness();
  const result = await api.prepareImage(source);
  assert.equal(result.file, source);
  assert.equal(result.optimized, false);
});

test('palette transparency and APNG animation chunks are retained byte-for-byte', () => {
  const { api } = loadPanelHarness();
  const source = makePng({ customChunks: [
    makeChunk('PLTE', Buffer.from([255, 0, 0])),
    makeChunk('tRNS', Buffer.from([0])),
    makeChunk('acTL', Buffer.alloc(8)),
    makeChunk('fcTL', Buffer.alloc(26)),
    makeChunk('fdAT', Buffer.from([0, 0, 0, 1, 12, 34])),
    makeChunk('iTXt', Buffer.from('private prompt')),
  ] });
  const result = api.stripPngMetadata(source);
  const output = Buffer.from(result.bytes);
  for (const name of ['PLTE', 'tRNS', 'acTL', 'fcTL', 'fdAT']) {
    assert.deepEqual(chunkPayloads(output, name), chunkPayloads(source, name), `${name} preserved`);
  }
  assert.ok(!chunkNames(output).includes('iTXt'));
});

test('trailing data after IEND is stripped and an unrecognized critical PNG chunk is rejected', async () => {
  const { api } = loadPanelHarness();
  const trailing = makePng({ tail: Buffer.from('PRIVATE-TRAILING-DATA') });
  const cleaned = Buffer.from(api.stripPngMetadata(trailing).bytes);
  assert.deepEqual(cleaned, makePng());
  const dangerous = makePng({ customChunks: [makeChunk('ABCD', Buffer.from('unknown-critical'))] });
  assert.throws(() => api.stripPngMetadata(dangerous), /Unsupported critical PNG chunk/);
  const badLength = Buffer.from(makePng());
  badLength.writeUInt32BE(0xfffffff0, 8);
  await assert.rejects(
    () => api.prepareImage(new File([badLength], 'malformed.png', { type: 'image/png' })),
    /could not be read|couldn't be read|read|PNG/i,
  );
});

test('oversized dimensions still use the canvas optimization with a sanitized PNG result', async () => {
  const original = makePng({ customChunks: [makeChunk('tEXt', Buffer.from('private'))] });
  const { api } = loadPanelHarness({ bitmapSize: [5001, 100], canvasPng: new Blob([makePng()]) });
  const result = await api.prepareImage(new File([original], 'wide.png', { type: 'image/png' }));
  assert.equal(result.optimized, true);
  assert.ok(result.width <= 4000);
  assert.deepEqual(chunkNames(Buffer.from(await result.file.arrayBuffer())), ['IHDR', 'IDAT', 'IEND']);
});

test('resizing with changed ICC profile adds a quiet per-image note in the full-width image footer', async () => {
  const profiled = makePng({ customChunks: [
    makeChunk('iCCP', Buffer.concat([Buffer.from('Display P3\0\0'), deflateSync(Buffer.from('ICC fixture'))])),
    makeChunk('tEXt', Buffer.from('Private prompt')),
  ] });
  const { api, elements } = loadPanelHarness({ bitmapSize: [5001, 100], canvasPng: new Blob([makePng()]) });
  const result = await api.prepareImage(new File([profiled], 'profiled.png', { type: 'image/png' }));
  assert.equal(result.optimized, true);
  assert.equal(result.colorInfoChanged, true);
  api.state.images = [result];
  api.renderImages();
  assert.match(elements.imageList.innerHTML, /Colors may have changed\./);
  assert.match(elements.imageList.innerHTML, /<p id="image-color-note-0" class="image-color-note"><svg aria-hidden="true" focusable="false" width="14" height="14"/);
  assert.match(elements.imageList.innerHTML, /aria-describedby="alt-details-0-sr"/);
  assert.doesNotMatch(elements.imageList.innerHTML, /role="alert"|aria-live/);
  const html = elements.imageList.innerHTML;
  assert.ok(html.indexOf('class="image-meta"') < html.indexOf('class="image-footer"'),
    'the status footer follows the image editor in reading order');
  assert.ok(html.indexOf('<span class="image-size">') < html.indexOf('id="image-color-note-0"'),
    'optimization summary precedes its color warning in DOM reading order');
  assert.ok(html.indexOf('id="image-color-note-0"') < html.indexOf('id="alt-details-0"'),
    'the color warning precedes the unrelated alt-text status in DOM reading order');
  assert.match(html, /<span class="image-size">/);
  assert.match(html, /<div id="alt-details-0" class="alt-details">/);
});

test('color-changed and ordinary attachments keep correct accessible footer sequences', () => {
  const { api, elements } = loadPanelHarness();
  api.state.images = [
    { ...image('optimized-color.png', ''), optimized: true, colorInfoChanged: true, originalSize: 10000 },
    { ...image('ordinary.png', ''), optimized: false, colorInfoChanged: false },
  ];
  api.renderImages();
  const cards = elements.imageList.innerHTML.split('<li class="image-card">').slice(1);
  assert.equal(cards.length, 2);
  const optimized = cards[0];
  const positions = [
    optimized.indexOf('class="image-size"'),
    optimized.indexOf('id="image-color-note-0"'),
    optimized.indexOf('id="alt-details-0"'),
  ];
  assert.ok(positions.every((position) => position >= 0));
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2],
    'Browse Mode should encounter optimized size, color explanation, then alt status');
  const ordinary = cards[1];
  assert.doesNotMatch(ordinary, /image-color-note/);
  assert.ok(ordinary.indexOf('class="image-size"') < ordinary.indexOf('id="alt-details-1"'),
    'ordinary image still reports size before alt status');
});

test('four attachments render as native list items with navigable filename headings', () => {
  const panelHtml = readProjectFile('panel.html');
  assert.match(panelHtml, /<ol id="imageList" class="images"><\/ol>/);
  assert.doesNotMatch(panelHtml, /id="imageList"[^>]*role=/);

  const { api, elements } = loadPanelHarness();
  api.state.images = [
    image('one.png', 'First alt'),
    image('two.png', ''),
    image('three.png', 'Third alt'),
    image('four.png', ''),
  ];
  api.renderImages();
  const markup = elements.imageList.innerHTML;
  assert.equal((markup.match(/<li class="image-card">/g) || []).length, 4);
  assert.equal((markup.match(/<\/li>/g) || []).length, 4);
  assert.equal((markup.match(/<h2 class="image-name-slot"/g) || []).length, 4);
  assert.equal((markup.match(/<\/h2>/g) || []).length, 4);
  assert.equal((markup.match(/<bdi class="image-name" dir="auto">/g) || []).length, 4);
  assert.doesNotMatch(markup, /role="(?:list|listitem|heading)"|tabindex=/);
  assert.equal((markup.match(/class="secondary remove-image"/g) || []).length, 4);
  assert.equal((markup.match(/class="alt-text"/g) || []).length, 4);
  assert.equal((markup.match(/<label class="sr-only" for="alt-text-/g) || []).length, 4);
  for (let index = 0; index < 4; index++) {
    assert.match(markup, new RegExp(`id="alt-text-${index}"[\\s\\S]*?aria-required="true"[\\s\\S]*?aria-describedby="alt-details-${index}-sr"`));
  }
  assert.ok(markup.indexOf('<h2 class="image-name-slot"') < markup.indexOf('class="secondary remove-image"'));
  assert.ok(markup.indexOf('class="image-meta"') < markup.indexOf('class="image-footer"'));

  api.state.images = [];
  api.renderImages();
  assert.equal(elements.imageList.innerHTML, '');
});

test('ordinary PNG uses one full-width status row without color warning or icon', () => {
  const { api, elements } = loadPanelHarness();
  api.state.images = [{ ...image('ordinary.png', ''), optimized: false, colorInfoChanged: false }];
  api.renderImages();
  const html = elements.imageList.innerHTML;
  assert.match(html, /class="image-footer"/);
  assert.match(html, /class="image-status-row"/);
  assert.match(html, /class="image-size"/);
  assert.match(html, /id="alt-details-0" class="alt-details"/);
  assert.doesNotMatch(html, /class="image-color-note"|viewBox="0 0 24 24"/);
});

test('new image focus settles before the independent attachment notification, without changing its text', async () => {
  const { api, elements, document, pendingAnnouncements, releaseAnnouncements } = loadPanelHarness({ deferImageNotification: true });
  const events = [];
  elements.imageList.querySelector = () => ({ focus() { events.push('alt focus'); } });
  document.ariaNotify = (message) => events.push(message);
  api.setPrepareImage(async (file) => ({
    ...image(file.name, ''),
    file: { name: file.name, size: Math.round(1.37 * 1024 * 1024) },
    originalSize: Math.round(37.16 * 1024 * 1024),
    optimized: true,
    colorInfoChanged: true,
  }));
  api.queueFiles([{ name: 'transparent-lamb-GIANT.png' }]);
  await api.getImageAddQueue();
  assert.deepEqual(events, ['alt focus'], 'only native focus speech occurs immediately');
  assert.equal(pendingAnnouncements(), 1);
  releaseAnnouncements();
  assert.deepEqual(events, [
    'alt focus',
    'Optimized from 37.16 MB to 1.37 MB. Colors may have changed.',
  ], 'full optimized confirmation is delivered once after the settling window');
});

test('new batch replaces a pending notification and reset cancels any stale confirmation', async () => {
  const { api, document, pendingAnnouncements, releaseAnnouncements } = loadPanelHarness({ deferImageNotification: true });
  const speech = [];
  document.ariaNotify = (message) => speech.push(message);
  api.setPrepareImage(async (file) => ({
    ...image(file.name, ''),
    optimized: true,
    originalSize: 2 * 1024 * 1024,
    file: { name: file.name, size: 1 * 1024 * 1024 },
  }));
  api.queueFiles([{ name: 'one.png' }]);
  await api.getImageAddQueue();
  api.queueFiles([{ name: 'two.png' }]);
  await api.getImageAddQueue();
  assert.equal(pendingAnnouncements(), 1, 'only latest message remains queued');
  releaseAnnouncements();
  assert.equal(speech.length, 1);
  assert.match(speech[0], /Optimized from 2\.00 MB to 1\.00 MB/);
  api.queueFiles([{ name: 'abandoned.png' }]);
  await api.getImageAddQueue();
  assert.equal(pendingAnnouncements(), 1);
  api.resetDraft();
  assert.equal(pendingAnnouncements(), 0);
  releaseAnnouncements();
  assert.equal(speech.length, 1, 'no obsolete announcement after Cancel/reset');
});

test('image-added announcement includes color warning, with no extra announcement for ordinary images', async () => {
  const { api, document } = loadPanelHarness();
  const spoken = [];
  document.ariaNotify = (message) => spoken.push(message);
  api.setPrepareImage(async (file) => ({ ...image(file.name, ''), colorInfoChanged: file.colorInfoChanged }));
  api.queueFiles([{ name: 'tagged.png', colorInfoChanged: true }]);
  await api.getImageAddQueue();
  assert.equal(spoken.length, 1, 'warning is part of a single native image-added announcement');
  assert.match(spoken[0], /tagged\.png/);
  assert.equal(spoken[0], 'Added \u2068tagged.png\u2069. Colors may have changed. Alt text required.');
  assert.ok(spoken[0].indexOf('Colors may have changed') < spoken[0].indexOf('Alt text required'),
    'the color information precedes the alt-text instruction');
  api.queueFiles([{ name: 'ordinary.png', colorInfoChanged: false }]);
  await api.getImageAddQueue();
  assert.equal(spoken.length, 1, 'native focus names an ordinary PNG without redundant custom speech');
});

test('single ordinary PNG focuses its editor without queuing or delivering a notification', async () => {
  const { api, document, elements, pendingAnnouncements, releaseAnnouncements } = loadPanelHarness({ deferImageNotification: true });
  const speech = [];
  const focus = [];
  elements.imageList.querySelector = () => ({ focus() { focus.push('Alt text'); } });
  document.ariaNotify = (message) => speech.push(message);
  api.setPrepareImage(async (file) => image(file.name, ''));
  api.queueFiles([{ name: 'plain.png' }]);
  await api.getImageAddQueue();
  assert.deepEqual(focus, ['Alt text']);
  assert.equal(pendingAnnouncements(), 0, 'no 500ms timer for native focus-only confirmation');
  releaseAnnouncements();
  assert.deepEqual(speech, []);
  assert.match(elements.imageList.innerHTML, /Alt text/);
});

test('ordinary PNG cancels an obsolete pending optimization announcement', async () => {
  const { api, document, pendingAnnouncements, releaseAnnouncements } = loadPanelHarness({ deferImageNotification: true });
  const spoken = [];
  document.ariaNotify = (message) => spoken.push(message);
  api.setPrepareImage(async (file) => ({
    ...image(file.name, ''),
    optimized: file.name === 'large.png',
    file: { name: file.name, size: 1024 * 1024 },
    originalSize: file.name === 'large.png' ? 3 * 1024 * 1024 : 1024 * 1024,
  }));
  api.queueFiles([{ name: 'large.png' }]);
  await api.getImageAddQueue();
  assert.equal(pendingAnnouncements(), 1);
  api.queueFiles([{ name: 'plain.png' }]);
  await api.getImageAddQueue();
  assert.equal(pendingAnnouncements(), 0, 'obsolete optimization message is cancelled');
  releaseAnnouncements();
  assert.deepEqual(spoken, []);
});

test('multiple images use the same color-before-alt announcement order', async () => {
  const { api, document } = loadPanelHarness();
  const spoken = [];
  document.ariaNotify = (message) => spoken.push(message);
  api.setPrepareImage(async (file) => ({ ...image(file.name, ''), colorInfoChanged: file.colorInfoChanged }));
  api.queueFiles([
    { name: 'profiled.png', colorInfoChanged: true },
    { name: 'plain.png', colorInfoChanged: false },
  ]);
  await api.getImageAddQueue();
  assert.deepEqual(spoken, [
    'Added 2 PNGs. Colors may have changed. Alt text required for each.',
  ]);
});


test('one optimized PNG announces only file-size reduction and color warning after native editor focus', async () => {
  const { api, document, elements } = loadPanelHarness();
  const spoken = [];
  document.ariaNotify = (message) => spoken.push(message);
  api.setPrepareImage(async (file) => ({
    ...image(file.name, ''),
    file: { name: file.name, size: Math.round(1.37 * 1024 * 1024) },
    originalSize: Math.round(37.16 * 1024 * 1024),
    optimized: true,
    colorInfoChanged: true,
  }));
  api.queueFiles([{ name: 'transparent-lamb-GIANT.png' }]);
  await api.getImageAddQueue();
  assert.deepEqual(spoken, [
    'Optimized from 37.16 MB to 1.37 MB. Colors may have changed.',
  ]);
  assert.match(elements.imageList.innerHTML, /Colors may have changed\./);
  assert.match(elements.imageList.innerHTML, /aria-describedby="alt-details-0-sr"/);
});

test('optimization without changed color metadata still receives one concise size announcement', async () => {
  const { api, document } = loadPanelHarness();
  const spoken = [];
  document.ariaNotify = (message) => spoken.push(message);
  api.setPrepareImage(async (file) => ({
    ...image(file.name, ''),
    file: { name: file.name, size: 600 * 1024 },
    originalSize: 3 * 1024 * 1024,
    optimized: true,
    colorInfoChanged: false,
  }));
  api.queueFiles([{ name: 'wide.png' }]);
  await api.getImageAddQueue();
  assert.deepEqual(spoken, [
    'Optimized from 3.00 MB to 600.0 KB.',
  ]);
});

test('mixed batches announce count optimized without speaking each measurement', async () => {
  const { api, document } = loadPanelHarness();
  const spoken = [];
  document.ariaNotify = (message) => spoken.push(message);
  api.setPrepareImage(async (file) => ({
    ...image(file.name, ''),
    optimized: file.optimized,
    colorInfoChanged: file.colorInfoChanged,
    originalSize: file.optimized ? 5 * 1024 * 1024 : 100,
    file: { name: file.name, size: file.optimized ? 1 * 1024 * 1024 : 100 },
  }));
  api.queueFiles([
    { name: 'resized.png', optimized: true, colorInfoChanged: true },
    { name: 'ordinary.png', optimized: false, colorInfoChanged: false },
  ]);
  await api.getImageAddQueue();
  assert.deepEqual(spoken, [
    'Added 2 PNGs. 1 image resized and optimized. Colors may have changed. Alt text required for each.',
  ]);
});

test('color warning remains in Browse Mode but no longer duplicates the editor focus description', () => {
  const { api, elements } = loadPanelHarness();
  api.state.images = [
    { ...image('tagged.png', ''), colorInfoChanged: true },
    { ...image('ordinary.png', ''), colorInfoChanged: false },
  ];
  api.renderImages();
  const html = elements.imageList.innerHTML;
  assert.match(html, /aria-describedby="alt-details-0-sr"/);
  assert.match(html, /<p id="image-color-note-0" class="image-color-note"><svg aria-hidden="true" focusable="false" width="14" height="14"/);
  assert.match(html, /aria-describedby="alt-details-1-sr"/);
  assert.doesNotMatch(html, /image-color-note-1/);
  assert.doesNotMatch(html, /role="alert"|aria-live/);
});

test('no color-change note for unresized profiled PNG or a resized PNG retaining identical ICC metadata', async () => {
  const profile = makeChunk('iCCP', Buffer.concat([
    Buffer.from('Display P3\0\0'), deflateSync(Buffer.from('ICC fixture')),
  ]));
  const source = makePng({ customChunks: [profile] });
  const unresized = loadPanelHarness();
  const originalResult = await unresized.api.prepareImage(new File([source], 'original.png', { type: 'image/png' }));
  assert.equal(originalResult.colorInfoChanged, false);
  unresized.api.state.images = [originalResult];
  unresized.api.renderImages();
  assert.doesNotMatch(unresized.elements.imageList.innerHTML, /image-color-note/);

  const unchanged = loadPanelHarness({ bitmapSize: [5001, 100], canvasPng: new Blob([makePng({ customChunks: [profile] })]) });
  const resizedResult = await unchanged.api.prepareImage(new File([source], 'resized.png', { type: 'image/png' }));
  assert.equal(resizedResult.optimized, true);
  assert.equal(resizedResult.colorInfoChanged, false);
  unchanged.api.state.images = [resizedResult];
  unchanged.api.renderImages();
  assert.doesNotMatch(unchanged.elements.imageList.innerHTML, /image-color-note/);
});

test('untagged PNG resizes without an ungrounded profile-loss warning; gamma change is flagged', async () => {
  const untagged = loadPanelHarness({ bitmapSize: [5001, 100] });
  const untaggedResult = await untagged.api.prepareImage(new File([makePng()], 'untagged.png', { type: 'image/png' }));
  assert.equal(untaggedResult.colorInfoChanged, false);

  const source = makePng({ customChunks: [makeChunk('gAMA', Buffer.from([0, 0, 177, 143]))] });
  const gamma = loadPanelHarness({ bitmapSize: [5001, 100], canvasPng: new Blob([makePng()]) });
  const gammaResult = await gamma.api.prepareImage(new File([source], 'gamma.png', { type: 'image/png' }));
  assert.equal(gammaResult.colorInfoChanged, true);
});

test('publishing actually uploads the sanitized PNG bytes, not the original file', async () => {
  const messages = [];
  const { api } = loadPanelHarness({ sendMessageImpl: async (message) => {
    messages.push(message);
    if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
    if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'safe' } };
    if (message.type === 'createImagePost') return { ok: true, post: { postUrl: 'https://bsky.app/profile/me/post/1' } };
    return { ok: true };
  } });
  const imageSource = new File([makePng({ customChunks: [makeChunk('tEXt', Buffer.from('private author'))] })], 'exif.png', { type: 'image/png' });
  const image = await api.prepareImage(imageSource);
  image.alt = 'Transparent icon';
  api.state.session = { handle: 'me.test', did: 'did:plc:me' }; 
  api.state.images = [image];
  api.state.postText = 'png metadata test';
  await api.publish();
  const upload = messages.find(message => message.type === 'uploadPng');
  assert.ok(upload, 'upload must have occurred');
  const uploaded = Buffer.from(upload.bytes);
  assert.deepEqual(chunkNames(uploaded), ['IHDR', 'IDAT', 'IEND']);
  assert.ok(!uploaded.includes(Buffer.from('private author')));
  assert.equal(messages.filter(message => message.type === 'createImagePost').length, 1);
});

test('publishing preserves an embedded ICC color profile while still stripping text metadata', async () => {
  const messages = [];
  const { api } = loadPanelHarness({ sendMessageImpl: async (message) => {
    messages.push(message);
    if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
    if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'safe' } };
    if (message.type === 'createImagePost') return { ok: true, post: { postUrl: 'https://bsky.app/profile/me/post/1' } };
    return { ok: true };
  } });
  const imageSource = new File([makePng({ customChunks: [
    makeChunk('iCCP', Buffer.from('Display P3\0\0compressed-profile-bytes')),
    makeChunk('tEXt', Buffer.from('private author')),
  ] })], 'profiled.png', { type: 'image/png' });
  const image = await api.prepareImage(imageSource);
  image.alt = 'Transparent icon';
  api.state.session = { handle: 'me.test', did: 'did:plc:me' };
  api.state.images = [image];
  api.state.postText = 'png color fidelity test';
  await api.publish();
  const upload = messages.find(message => message.type === 'uploadPng');
  assert.ok(upload, 'upload must have occurred');
  const uploaded = Buffer.from(upload.bytes);
  assert.ok(chunkNames(uploaded).includes('iCCP'));
  assert.ok(uploaded.includes(Buffer.from('Display P3')));
  assert.ok(!uploaded.includes(Buffer.from('private author')));
});

test('account mismatch blocks the first Post attempt before mention lookup and PNG upload', async () => {
  const messages = [];
  const { api, elements, pageMessages, accountRequests } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async (message) => { messages.push(message); throw Error('must not access the network'); },
  });
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  api.state.images = [image('one.png', 'alt')];
  await api.publish();
  assert.deepEqual(messages, []);
  assert.equal(elements.statusMessage.className, 'status error');
  assert.match(elements.statusMessage.textContent, /alice\.bsky\.social/);
  assert.match(elements.statusMessage.textContent, /bob\.bsky\.social/);
  assert.equal(accountRequests.length, 1);
  assert.equal(api.state.busy, false);
  assert.equal(elements.postButton.disabled, true);
  assert.equal(api.state.images.length, 1, 'editable draft survives');
});

test('unknown Bluesky account fails closed without uploading, while same DID with changed handle passes', async () => {
  const messages = [];
  const { api, elements } = loadPanelHarness({
    pageAccount: null,
    sendMessageImpl: async (message) => { messages.push(message); throw Error('must not access network'); },
  });
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  api.state.images = [image('one.png')];
  await api.publish();
  assert.equal(messages.length, 0);
  assert.match(elements.statusMessage.textContent, /Cannot verify the account/);
});

test('account switched during image uploads prevents createImagePost', async () => {
  const messages = [];
  let reads = 0;
  const { api, elements } = loadPanelHarness({
    pageAccount: () => (++reads === 1
      ? { did: 'did:plc:me', handle: 'me.test' }
      : { did: 'did:plc:alice', handle: 'alice.bsky.social' }),
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
      if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'blob' } };
      throw Error('createImagePost must never be reached');
    },
  });
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  api.state.images = [image('one.png')];
  await api.publish();
  assert.equal(reads, 2);
  assert.equal(messages.filter(m => m.type === 'uploadPng').length, 1);
  assert.equal(messages.filter(m => m.type === 'createImagePost').length, 0);
  assert.match(elements.statusMessage.textContent, /Account mismatch/);
  assert.equal(api.state.images.length, 1);
});

test('same page DID across two checks allows publishing and pins expected DID', async () => {
  const messages = [];
  const { api, pageMessages, accountRequests } = loadPanelHarness({
    pageAccount: { did: 'did:plc:me', handle: 'renamed.example' },
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
      if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'blob' } };
      return { ok: true, post: { postUrl: 'https://bsky.app/profile/renamed/post/1' } };
    },
  });
  api.state.session = { did: 'did:plc:me', handle: 'old-handle.test' };
  api.state.images = [image('one.png')];
  await api.publish();
  assert.equal(messages.find(m => m.type === 'createImagePost').expectedDid, 'did:plc:me');
  assert.equal(messages.find(m => m.type === 'uploadPng').expectedDid, 'did:plc:me');
  assert.equal(accountRequests.length, 2);
  assert.equal(pageMessages.filter(m => m.type === 'postComplete').length, 1);
});


test('opening PNG composer checks the account before exposing editing, warns at top and disables Post', async () => {
  const messages = [];
  const { api, elements, pageMessages, accountRequests } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async (message) => {
      messages.push(message);
      if (message.type === 'getSession') return { ok: true, session: { did: 'did:plc:bob', handle: 'bob.bsky.social' } };
      throw Error('no publication or unexpected request');
    },
  });
  await api.prepareForOpen({ text: 'Saved post text', languages: ['en'], requestId: 'opening-1' });
  assert.equal(accountRequests.length, 1);
  assert.equal(pageMessages.at(-1).type, 'panelPrepared', 'open must wait for account verification');
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(elements.accountNotice.hidden, false);
  assert.match(elements.accountNoticeTitle.textContent, /don't match|don’t match/i);
  assert.match(elements.accountNoticeText.textContent, /alice\.bsky\.social/);
  assert.match(elements.accountNoticeText.textContent, /bob\.bsky\.social/);
  assert.equal(elements.postButton.disabled, true);
  assert.equal(elements.switchPngAccountButton.hidden, false);
  assert.equal(api.state.postText, 'Saved post text');
  assert.equal(messages.length, 1);
});

test('Switch PNG account is provisional; Cancel preserves session, draft and keyboard focus', async () => {
  const messages = [];
  const { api, elements } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async (message) => {
      messages.push(message);
      throw Error('switch and cancel must not contact background');
    },
  });
  const oldSession = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  api.state.session = oldSession;
  api.state.images = [image('private.png', 'A carefully written description')];
  const kept = api.state.images[0];
  api.state.postText = 'My carefully crafted post';
  await api.checkAccountAtEntry();
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  await elements.switchPngAccountButton.dispatch('click');
  assert.deepEqual(messages, [], 'switch entry never logs out');
  assert.equal(api.state.session, oldSession);
  assert.equal(api.state.switchingAccount, true);
  assert.match(elements.accountStatus.textContent, /Signed in as .*bob\.bsky\.social/);
  assert.equal(elements.signInSection.hidden, false);
  assert.equal(elements.cancelAccountSwitchButton.hidden, false);
  assert.equal(elements.postButton.disabled, true);
  assert.equal(elements.accountNotice.hidden, false);
  assert.equal(elements.handleInput.value, 'alice.bsky.social');
  assert.equal(elements.handleInput.focusCount, 1);
  assert.equal(api.state.postText, 'My carefully crafted post');
  assert.equal(api.state.images[0], kept);
  elements.passwordInput.value = 'unsubmitted-secret';

  await elements.cancelAccountSwitchButton.dispatch('click');
  assert.deepEqual(messages, [], 'cancel account switch never logs out');
  assert.equal(api.state.session, oldSession);
  assert.equal(api.state.switchingAccount, false);
  assert.equal(elements.signInSection.hidden, true);
  assert.equal(elements.passwordInput.value, '', 'cancel clears unsubmitted password');
  assert.equal(elements.cancelAccountSwitchButton.hidden, true);
  assert.equal(elements.switchPngAccountButton.focusCount, 1);
  assert.equal(elements.postButton.disabled, true, 'mismatch remains blocked');
  assert.equal(api.state.postText, 'My carefully crafted post');
  assert.equal(api.state.images[0], kept);
  assert.equal(api.state.images[0].alt, 'A carefully written description');
});

test('failed replacement sign-in retains original account; success atomically replaces it', async () => {
  const calls = [];
  const pending = deferred();
  let fail = true;
  const oldSession = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  const { api, elements } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async (message) => {
      calls.push(message.type);
      if (message.type !== 'login') throw Error('unexpected background operation');
      return fail ? { ok: false, error: 'Invalid app password' } : pending.promise;
    },
  });
  api.state.session = oldSession;
  api.state.images = [image('retained.png', 'Alt')];
  api.state.postText = 'Retained draft';
  await api.checkAccountAtEntry();
  await elements.switchPngAccountButton.dispatch('click');
  elements.handleInput.value = 'alice.bsky.social';
  elements.passwordInput.value = 'incorrect';
  await elements.signInForm.dispatch('submit');
  await tick();
  assert.equal(api.state.session, oldSession);
  assert.equal(api.state.switchingAccount, true);
  assert.equal(elements.signInSection.hidden, false);
  assert.equal(elements.statusMessage.textContent, 'Invalid app password');
  assert.equal(elements.postButton.disabled, true);

  fail = false;
  elements.passwordInput.value = 'correct';
  await elements.signInForm.dispatch('submit');
  assert.equal(api.state.session, oldSession, 'original is retained until login returns success');
  assert.equal(api.state.signingIn, true);
  assert.equal(elements.cancelAccountSwitchButton.disabled, true);
  api.cancelPngAccountSwitch();
  api.requestPanelClose();
  assert.equal(api.state.switchingAccount, true, 'cannot discard a login in flight');
  assert.equal(api.state.cancelPending, false);
  pending.resolve({ ok: true, session: { did: 'did:plc:alice', handle: 'alice.bsky.social' } });
  await tick();
  await tick();
  assert.deepEqual(calls, ['login', 'login'], 'no logout or surprise background calls');
  assert.equal(api.state.session.did, 'did:plc:alice');
  assert.equal(api.state.switchingAccount, false);
  assert.equal(elements.signInSection.hidden, true);
  assert.equal(elements.accountNotice.hidden, true);
  assert.equal(elements.postButton.disabled, false);
  assert.equal(api.state.postText, 'Retained draft');
  assert.equal(api.state.images[0].alt, 'Alt');
});

test('canceling the entire PNG composer during provisional switch keeps existing login', async () => {
  const messages = [];
  const { api, elements, pageMessages } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async (message) => { messages.push(message); throw Error('no background logout'); },
  });
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  await api.checkAccountAtEntry();
  await elements.switchPngAccountButton.dispatch('click');
  api.requestPanelClose();
  assert.equal(api.state.cancelPending, true);
  assert.equal(api.state.session.did, 'did:plc:bob');
  assert.equal(pageMessages.at(-1).type, 'closePanel');
  assert.deepEqual(messages, []);
  api.resetDraft();
  assert.equal(api.state.session.did, 'did:plc:bob');
  assert.equal(api.state.switchingAccount, false);
});

test('after successful sign-in, account verification enables Post only when DIDs match', async () => {
  const account = { did: 'did:plc:alice', handle: 'alice.bsky.social' };
  const { api, elements } = loadPanelHarness({
    pageAccount: account,
    sendMessageImpl: async (message) => {
      if (message.type === 'login') return { ok: true, session: { did: 'did:plc:alice', handle: 'alice.bsky.social' } };
      throw Error('unexpected request');
    },
  });
  api.state.images = [image('first.png', 'alt')];
  api.state.postText = 'Please preserve this';
  elements.handleInput.value = 'alice.bsky.social';
  elements.passwordInput.value = 'app-password';
  await api.signIn();
  assert.equal(api.state.accountCheckStatus, 'matched');
  assert.equal(elements.accountNotice.hidden, true);
  assert.equal(elements.postButton.disabled, false);
  assert.equal(elements.postTextInput.focusCount, 1);
  assert.equal(api.state.postText, 'Please preserve this');
  assert.equal(api.state.images.length, 1);
});

test('Check again accepts an updated website account and unlocks Post without changing draft', async () => {
  let page = { did: 'did:plc:alice', handle: 'alice.bsky.social' };
  const { api, elements } = loadPanelHarness({ pageAccount: () => page });
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  api.state.images = [image('draft.png', 'alt')];
  api.state.postText = 'Keep this';
  await api.checkAccountAtEntry();
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(elements.postButton.disabled, true);
  page = { did: 'did:plc:bob', handle: 'renamed.bsky.social' };
  await elements.recheckAccountButton.dispatch('click');
  await tick();
  assert.equal(api.state.accountCheckStatus, 'matched');
  assert.equal(elements.accountNotice.hidden, true);
  assert.equal(elements.postButton.disabled, false);
  assert.equal(api.state.postText, 'Keep this');
  assert.equal(api.state.images.length, 1);
});

test('missing website account shows an early actionable notice rather than allowing publication', async () => {
  const { api, elements } = loadPanelHarness({ pageAccount: null });
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  api.state.images = [image('draft.png', 'alt')];
  await api.checkAccountAtEntry();
  assert.equal(api.state.accountCheckStatus, 'unavailable');
  assert.equal(elements.accountNotice.hidden, false);
  assert.match(elements.accountNoticeTitle.textContent, /Could not verify/);
  assert.equal(elements.switchPngAccountButton.hidden, true);
  assert.equal(elements.recheckAccountButton.hidden, false);
  assert.equal(elements.postButton.disabled, true);
});

test('superseded account verification cannot unlock Post for a newer extension login', async () => {
  const pending = deferred();
  let reads = 0;
  const { api, elements, parentFrame } = loadPanelHarness({ pageAccount: () => {
    reads += 1;
    return reads === 1 ? null : { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  } });
  api.state.session = { did: 'did:plc:alice', handle: 'alice.bsky.social' };
  // Two successive checks: the last result must govern even if a prior
  // account reply arrives after the extension session changes.
  const first = api.checkAccountAtEntry();
  api.handlePageMessage({ source: parentFrame, data: { type: 'sessionChanged', session: { did: 'did:plc:bob', handle: 'bob.bsky.social' } } });
  await first;
  await tick();
  assert.equal(api.state.accountCheckStatus, 'matched');
  assert.equal(elements.postButton.disabled, true, 'no images yet, regardless of account check');
});

test('Restore rechecks the website account and disables Post if it changed while minimized', async () => {
  let page = { did: 'did:plc:me', handle: 'me.test' };
  const { api, elements, parentFrame } = loadPanelHarness({ pageAccount: () => page });
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  api.state.images = [image('work.png', 'Alt stays')];
  api.state.postText = 'Work stays';
  await api.checkAccountAtEntry();
  assert.equal(elements.postButton.disabled, false);
  page = { did: 'did:plc:other', handle: 'other.bsky.social' };
  api.handlePageMessage({ source: parentFrame, data: { type: 'resumeFocus' } });
  assert.equal(elements.readPageButton.focusCount, 1, 'Restore still focuses Minimize');
  assert.equal(elements.postButton.disabled, true, 'Post disabled immediately during recheck');
  await tick();
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(elements.accountNotice.hidden, false);
  assert.equal(elements.postButton.disabled, true);
  assert.equal(api.state.images[0].alt, 'Alt stays');
  assert.equal(api.state.postText, 'Work stays');
});

test('signing into the wrong extension account immediately shows the mismatch and focuses recovery', async () => {
  const { api, elements } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async message => message.type === 'login'
      ? { ok: true, session: { did: 'did:plc:bob', handle: 'bob.bsky.social' } }
      : { ok: true },
  });
  elements.handleInput.value = 'bob.bsky.social';
  elements.passwordInput.value = 'app-password';
  await api.signIn();
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(elements.accountNotice.hidden, false);
  assert.equal(elements.postButton.disabled, true);
  assert.equal(elements.postTextInput.focusCount, 0);
  assert.equal(elements.switchPngAccountButton.focusCount, 1);
});

test('publish-time identity change also updates top warning, not only bottom error', async () => {
  let page = { did: 'did:plc:me', handle: 'me.test' };
  const messages = [];
  const { api, elements } = loadPanelHarness({
    pageAccount: () => page,
    sendMessageImpl: async message => { messages.push(message); throw Error('should never upload'); },
  });
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  api.state.images = [image('draft.png', 'alt')];
  await api.checkAccountAtEntry();
  assert.equal(api.state.accountCheckStatus, 'matched');
  page = { did: 'did:plc:other', handle: 'other.bsky.social' };
  await api.publish();
  assert.equal(messages.length, 0);
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(elements.accountNotice.hidden, false);
  assert.equal(elements.postButton.disabled, true);
  assert.equal(api.state.images.length, 1);
});


test('manual Check again confirms an unchanged mismatch and preserves the existing draft', async () => {
  const backgroundMessages = [];
  const { api, elements, pageMessages, accountRequests } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async message => { backgroundMessages.push(message); return { ok: true }; },
  });
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  api.state.images = [image('draft.png', 'Description')];
  api.state.postText = 'My draft';
  await api.checkAccountAtEntry();
  assert.equal(elements.accountRecheckFeedback.textContent, '', 'initial check is not presented as a recheck');
  const request = elements.recheckAccountButton.dispatch('click');
  assert.equal(elements.recheckAccountButton.hidden, false, 'focused button remains in the layout during lookup');
  assert.equal(elements.switchPngAccountButton.hidden, false, 'neighboring sign-out button never moves into the recheck position');
  assert.equal(elements.switchPngAccountButton.disabled, true, 'cannot sign out while checking');
  assert.equal(elements.accountNoticeTitle.textContent, 'Accounts don’t match', 'warning remains stable while rechecking');
  assert.equal(elements.recheckAccountButton.disabled, true, 'cannot start concurrent checks');
  assert.match(elements.accountRecheckFeedback.textContent, /Checking accounts \(check 1\)/);
  await request;
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.match(elements.accountRecheckFeedback.textContent, /Check 1 complete: accounts still do not match/);
  assert.equal(elements.accountNotice.hidden, false);
  assert.equal(elements.recheckAccountButton.disabled, false);
  assert.equal(elements.postButton.disabled, true);
  assert.equal(api.state.postText, 'My draft');
  assert.equal(api.state.images[0].alt, 'Description');
  await elements.recheckAccountButton.dispatch('click');
  assert.match(elements.accountRecheckFeedback.textContent, /Check 2 complete: accounts still do not match/);
  assert.equal(accountRequests.length, 3);
  assert.deepEqual(backgroundMessages, [], 'Check again never logs the extension out');
});

test('manual Check again confirms a match, makes Post available and transfers keyboard focus', async () => {
  let page = { did: 'did:plc:alice', handle: 'alice.bsky.social' };
  const { api, elements, document } = loadPanelHarness({ pageAccount: () => page });
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  api.state.images = [image('draft.png', 'A transparent image')];
  await api.checkAccountAtEntry();
  document.activeElement = elements.recheckAccountButton;
  page = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  await elements.recheckAccountButton.dispatch('click');
  assert.equal(api.state.accountCheckStatus, 'matched');
  assert.equal(elements.accountNotice.hidden, true);
  assert.equal(elements.postButton.disabled, false);
  assert.match(elements.accountRecheckFeedback.textContent, /Check 1 complete: accounts match/);
  assert.equal(elements.postTextInput.focusCount, 1, 'focus leaves the dismissed account notice');
});

test('manual Check again gives explicit feedback when the website account cannot be verified', async () => {
  const { api, elements } = loadPanelHarness({ pageAccount: null });
  api.state.session = { did: 'did:plc:me', handle: 'me.bsky.social' };
  await api.checkAccountAtEntry();
  await elements.recheckAccountButton.dispatch('click');
  assert.match(elements.accountRecheckFeedback.textContent, /Check 1 complete: could not verify/);
  assert.equal(elements.accountNotice.hidden, false);
  assert.equal(elements.postButton.disabled, true);
});

test('recheck feedback uses a native output and clears on a new draft', async () => {
  const html = readProjectFile('panel.html');
  assert.match(html, /<output id="accountRecheckFeedback" class="account-recheck-feedback" aria-atomic="true"><\/output>/);
  const { api, elements } = loadPanelHarness({ pageAccount: null });
  api.state.session = { did: 'did:plc:me', handle: 'me.bsky.social' };
  await api.checkAccountAtEntry();
  await elements.recheckAccountButton.dispatch('click');
  assert.notEqual(elements.accountRecheckFeedback.textContent, '');
  api.resetDraft();
  assert.equal(elements.accountRecheckFeedback.textContent, '');
});

test('repeated account checks keep account-switch control stationary and never send logout', async () => {
  const backgroundMessages = [];
  const { api, elements, pageMessages, accountRequests } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
    sendMessageImpl: async message => { backgroundMessages.push(message); return { ok: true }; },
  });
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  await api.checkAccountAtEntry();
  const first = api.checkAccountAtEntry({ fromRecheckButton: true });
  assert.equal(api.state.accountCheckStatus, 'mismatch', 'visible warning remains unchanged during manual recheck');
  assert.equal(elements.switchPngAccountButton.hidden, false);
  assert.equal(elements.switchPngAccountButton.disabled, true, 'switch disabled, not moved');
  assert.equal(elements.recheckAccountButton.hidden, false);
  assert.equal(elements.recheckAccountButton.disabled, true);
  const second = api.checkAccountAtEntry({ fromRecheckButton: true });
  await api.switchPngAccount();
  await Promise.all([first, second]);
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(api.state.accountRecheckCount, 1, 'duplicate request cannot start a second lookup');
  assert.equal(elements.switchPngAccountButton.hidden, false);
  assert.equal(elements.switchPngAccountButton.disabled, false);
  assert.match(elements.accountRecheckFeedback.textContent, /Check 1 complete/);
  assert.equal(accountRequests.length, 2);
  assert.deepEqual(backgroundMessages, [], 'neither repeated recheck nor attempted switch caused logout');
});

test('account check numbering resets with a new draft', async () => {
  const { api, elements } = loadPanelHarness({
    pageAccount: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
  });
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  await api.checkAccountAtEntry();
  await api.checkAccountAtEntry({ fromRecheckButton: true });
  await api.checkAccountAtEntry({ fromRecheckButton: true });
  assert.equal(api.state.accountRecheckCount, 2);
  api.resetDraft();
  assert.equal(api.state.accountRecheckCount, 0);
  api.state.session = { did: 'did:plc:bob', handle: 'bob.bsky.social' };
  await api.checkAccountAtEntry();
  await api.checkAccountAtEntry({ fromRecheckButton: true });
  assert.match(elements.accountRecheckFeedback.textContent, /Check 1 complete/);
});


test('PNG composer login no longer sends developer remember preference', async () => {
  const seen = [];
  const { elements, api } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      seen.push(message);
      if (message.type === 'login') return { ok: true, session: { did: 'did:plc:me', handle: 'me.test' } };
      return { ok: true };
    },
  });
  elements.handleInput.value = 'me.test';
  elements.passwordInput.value = 'pw';
  await elements.signInForm.dispatch('submit');
  await tick();
  const login = seen.find(x => x.type === 'login');
  assert.ok(login);
  assert.equal(Object.hasOwn(login, 'rememberSession'), false);
  assert.equal(api.state.session.did, 'did:plc:me');
  assert.doesNotMatch(readProjectFile('panel.html'), /rememberSessionInput|rememberTestSignIn/);
  assert.doesNotMatch(readProjectFile('panel.js'), /rememberSessionInput/);
});

test('page cannot forge the active website account via parent window postMessage', async () => {
  const { api, parentFrame, accountRequests } = loadPanelHarness({
    pageAccount: { did: 'did:plc:other', handle: 'other.test' },
  });
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  await api.checkAccountAtEntry();
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'blueskyActiveAccount', requestId: 1,
    account: { did: 'did:plc:me', handle: 'me.test' },
  } });
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(accountRequests.length, 1, 'identity check goes to the extension background');
});

test('spoofed account ticket cannot invent a matched account', async () => {
  const { api, parentFrame, accountRequests } = loadPanelHarness({
    pageAccount: { did: 'did:plc:other', handle: 'other.test' },
  });
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  await api.checkAccountAtEntry();
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'panelAccountTicket', requestId: 1,
    ticket: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  } });
  assert.equal(api.state.accountCheckStatus, 'mismatch');
  assert.equal(accountRequests.length, 1);
});


test('temporary account diagnostic shows a fixed failure code, never the account identity', async () => {
  const { api, elements } = loadPanelHarness({ pageAccount: null });
  api.state.session = { did: 'did:plc:secretaccount', handle: 'private.test' };
  await api.checkAccountAtEntry();
  assert.equal(api.state.accountCheckStatus, 'unavailable');
  assert.match(elements.accountNoticeText.textContent, /Diagnostic: SITE-ACCOUNT-EMPTY/);
  assert.doesNotMatch(elements.accountNoticeText.textContent, /secretaccount|private\.test/);
  assert.equal(elements.postButton.disabled, true);
});


test('Cancel blocked by another native composer has actionable warning without resetting draft', () => {
  const { api, elements, parentFrame } = loadPanelHarness();
  api.state.cancelPending = true;
  const postText = 'My unfinished PNG draft';
  api.state.postText = postText;
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'cancelRecoveryFailed', reason: 'other-composer-open',
  } });
  assert.equal(elements.statusMessage.textContent,
    'Another Bluesky composer is open. Minimize this PNG composer, save or close the other composer, then return and try Cancel again. Your PNG draft is preserved.');
  assert.equal(elements.statusMessage.className, 'status error');
  assert.equal(elements.cancelButton.focusCount, 1);
  assert.equal(api.state.postText, postText);
  assert.equal(api.state.cancelPending, false);
});

test('Other Cancel recovery failures retain their existing generic warning', () => {
  const { api, elements, parentFrame } = loadPanelHarness();
  api.state.cancelPending = true;
  api.handlePageMessage({ source: parentFrame, data: { type: 'cancelRecoveryFailed' } });
  assert.equal(elements.statusMessage.textContent,
    "Couldn't restore your text to Bluesky. Your PNG draft is still here; you can try Cancel again or publish from this window.");
  assert.equal(elements.statusMessage.className, 'status error');
  assert.equal(elements.cancelButton.focusCount, 1);
  assert.equal(api.state.cancelPending, false);
});


test('restoring after closing other native composer clears only the stale Cancel conflict', () => {
  const { api, elements, parentFrame } = loadPanelHarness();
  api.state.cancelPending = true;
  api.state.postText = 'Preserved PNG draft';
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'cancelRecoveryFailed', reason: 'other-composer-open',
  } });
  assert.match(elements.statusMessage.textContent, /Another Bluesky composer is open/);
  const focusBefore = elements.readPageButton.focusCount;
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'resumeFocus', cancelConflictResolved: false,
  } });
  assert.match(elements.statusMessage.textContent, /Another Bluesky composer is open/,
    'do not hide the conflict if the other composer is still visible');
  assert.equal(elements.readPageButton.focusCount, focusBefore + 1);
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'resumeFocus', cancelConflictResolved: true,
  } });
  assert.equal(elements.statusMessage.textContent, '');
  assert.equal(elements.statusMessage.className, 'status');
  assert.equal(elements.readPageButton.focusCount, focusBefore + 2);
  assert.equal(api.state.postText, 'Preserved PNG draft');
  assert.equal(api.state.cancelPending, false);
});

test('resolved conflict on restore does not erase unrelated recovery errors or current status', () => {
  const { api, elements, parentFrame } = loadPanelHarness();
  api.handlePageMessage({ source: parentFrame, data: { type: 'cancelRecoveryFailed' } });
  const generic = elements.statusMessage.textContent;
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'resumeFocus', cancelConflictResolved: true,
  } });
  assert.equal(elements.statusMessage.textContent, generic);
  assert.equal(elements.statusMessage.className, 'status error');
  // A later status update must not be cleared merely because a conflict was
  // reported earlier in the same PNG draft.
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'cancelRecoveryFailed', reason: 'other-composer-open',
  } });
  elements.statusMessage.textContent = 'A different newer status';
  api.handlePageMessage({ source: parentFrame, data: {
    type: 'resumeFocus', cancelConflictResolved: true,
  } });
  assert.equal(elements.statusMessage.textContent, 'A different newer status');
});


test('adding one or multiple PNGs focuses the first newly added alt editor, not the last Add PNG input', async () => {
  const { api, elements, document } = loadPanelHarness();
  const focusTargets = [];
  const speech = [];
  document.ariaNotify = (message) => {
    speech.push(message);
    assert.deepEqual(focusTargets, [0, 1], 'batch notification follows focus; ordinary single image was native-only');
  };
  elements.imageList.querySelector = (selector) => {
    const index = Number(selector.match(/^\.alt-text\[data-alt-index="(\d+)"\]$/)?.[1]);
    if (!Number.isInteger(index) || index >= api.state.images.length) return null;
    return { focus() { focusTargets.push(index); } };
  };
  api.setPrepareImage(async (file) => image(file.name, ''));

  api.queueFiles([{ name: 'first.png' }]);
  await api.getImageAddQueue();
  assert.deepEqual(focusTargets, [0]);
  assert.equal(elements.fileInput.focusCount, 0);

  api.queueFiles([{ name: 'second.png' }, { name: 'third.png' }]);
  await api.getImageAddQueue();
  assert.deepEqual(focusTargets, [0, 1], 'focus is set once per batch, to the first new attachment');
  assert.equal(speech.length, 1, 'ordinary singleton needs no notification; the batch still gets one');
  assert.match(speech[0], /Added 2 PNGs/);
  assert.equal(elements.fileInput.focusCount, 0);
  assert.match(elements.imageList.innerHTML, /data-alt-index="2"/);
});

test('failed or obsolete image batches never redirect focus to an alt editor', async () => {
  const { api, elements } = loadPanelHarness();
  const focusTargets = [];
  elements.imageList.querySelector = () => ({ focus() { focusTargets.push('alt'); } });
  api.setPrepareImage(async () => { throw new Error('Invalid PNG'); });
  api.queueFiles([{ name: 'bad.png' }]);
  await api.getImageAddQueue();
  assert.deepEqual(focusTargets, []);
  assert.equal(elements.statusMessage.textContent, 'Invalid PNG');

  const processing = deferred();
  api.setPrepareImage(async () => processing.promise);
  api.queueFiles([{ name: 'old-draft.png' }]);
  api.resetDraft();
  processing.resolve(image('old-draft.png', ''));
  await api.getImageAddQueue();
  assert.deepEqual(focusTargets, []);
  assert.equal(api.state.images.length, 0);
});


test('uncertain createRecord outcome warns without closing or resetting the PNG draft', async () => {
  const sent = [];
  const { api, elements, pageMessages } = loadPanelHarness({
    sendMessageImpl: async (message) => {
      sent.push(message);
      if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
      if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'blob' } };
      if (message.type === 'createImagePost') return { ok: false, code: 'publicationOutcomeUncertain' };
      return { ok: true };
    },
  });
  const draftImage = image('draft.png', 'Transparent icon');
  api.state.session = { did: 'did:plc:me', handle: 'me.test' };
  api.state.postText = 'Keep this draft';
  api.state.images = [draftImage];
  await api.publish();
  assert.equal(sent.filter(x => x.type === 'createImagePost').length, 1);
  assert.equal(elements.statusMessage.className, 'status warning');
  assert.match(elements.statusMessage.textContent, /may have published/i);
  assert.match(elements.statusMessage.textContent, /check your Bluesky profile/i);
  assert.equal(api.state.postText, 'Keep this draft');
  assert.equal(api.state.images[0], draftImage);
  assert.equal(api.state.busy, false);
  assert.equal(elements.postButton.disabled, false);
  assert.equal(pageMessages.filter(x => x.type === 'postComplete').length, 0);
});

for (const outcome of ['no reply', 'message rejection']) {
  test(`lost panel-to-background confirmation (${outcome}) warns without discarding`, async () => {
    const { api, elements, pageMessages } = loadPanelHarness({
      sendMessageImpl: async (message) => {
        if (message.type === 'checkPostMentions') return { ok: true, unresolvedHandles: [] };
        if (message.type === 'uploadPng') return { ok: true, blob: { ref: 'blob' } };
        if (message.type === 'createImagePost') {
          if (outcome === 'no reply') return null;
          throw new Error('Messaging port closed');
        }
        return { ok: true };
      },
    });
    const original = image('draft.png', 'Alt');
    api.state.session = { did: 'did:plc:me', handle: 'me.test' };
    api.state.images = [original];
    await api.publish();
    assert.equal(elements.statusMessage.className, 'status warning');
    assert.match(elements.statusMessage.textContent, /may have published/i);
    assert.equal(api.state.images[0], original);
    assert.equal(pageMessages.filter(x => x.type === 'postComplete').length, 0);
  });
}
