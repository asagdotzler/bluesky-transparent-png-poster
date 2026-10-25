import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestI18n, makeClassList, readProjectFile, runScript } from './helpers.mjs';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function textNode(value) {
  return { nodeType: TEXT_NODE, nodeValue: value, childNodes: [] };
}

function elementNode(tagName, children = [], classes = []) {
  return {
    nodeType: ELEMENT_NODE,
    tagName: tagName.toUpperCase(),
    childNodes: children,
    classList: {
      contains(name) { return classes.includes(name); },
    },
    append(child) { this.childNodes.push(child); },
  };
}

function loadContentHarness({ deferFrames = false } = {}) {
  let source = readProjectFile('content.js');
  // Existing composer-behavior tests are intentionally synchronous. Model an
  // already-authenticated bridge in this harness, leaving production origin
  // validation and all other code intact. Separate security tests verify the
  // real asynchronous token handoff and reject unauthenticated messages.
  const bridgeStart = source.indexOf('  function sendToPanel(message) {');
  const bridgeEnd = source.indexOf('\n  let pendingPanelOpen = null;', bridgeStart);
  assert.ok(bridgeStart >= 0 && bridgeEnd > bridgeStart, 'expected authenticated sendToPanel');
  source = source.slice(0, bridgeStart) + `
  function sendToPanel(message) {
    if (panelFrame?.contentWindow) {
      panelFrame.contentWindow.postMessage({ ...message, bridgeSecret: 'test-panel-bridge' }, PANEL_ORIGIN);
    }
  }
` + source.slice(bridgeEnd);
  const marker = '  window.addEventListener("message", handlePanelMessage);';
  const cut = source.indexOf(marker);
  assert.notEqual(cut, -1, 'content harness marker should exist');
  source = source.slice(0, cut) + `
  globalThis.__contentTest = {
    readComposerTextboxText,
    findMediaButton,
    findPublishButton,
    findOwnedComposerCancel,
    findNewOwnedDiscardConfirmation,
    findNewPostControl,
    findComposerSurface,
    findVisibleComposers,
    isStandalonePostComposer,
    hasUnrestrictedComposerInteraction,
    isEligibleStandaloneComposer,
    readBlueskyActiveAccount,
    ensureLauncher,
    showPanel,
    syncComposerText,
    closePanel,
    handlePanelMessage(event) {
      return handlePanelMessage({ ...event, origin: event.origin ?? 'moz-extension://our-id' });
    },
    handleRuntimeMessage,
    ensurePanelFrame,
    runMaintenance,
    runPeriodicMaintenance,
    shouldRunPeriodicMaintenance,
    scheduleMaintenance,
    shouldScheduleComposerMaintenance,
    observeComposerMutations,
    suspendPanel,
    restoreSuspendedPanel,
    revealPreparedPanel,
    finishPanelFocusHandoff,
    updateNavigationWarning,
    warnBeforeDiscardingDraft,
    resolveLanguageButtonLabel,
    readComposerPostLanguages,
    setHarnessState(values) {
      if (Object.prototype.hasOwnProperty.call(values, "hiddenComposerTextbox")) hiddenComposerTextbox = values.hiddenComposerTextbox;
      if (Object.prototype.hasOwnProperty.call(values, "panelLaunchOrigin")) panelLaunchOrigin = values.panelLaunchOrigin;
      if (Object.prototype.hasOwnProperty.call(values, "composerTextSnapshot")) composerTextSnapshot = values.composerTextSnapshot;
      if (Object.prototype.hasOwnProperty.call(values, "originalNativeTextAtLaunch")) originalNativeTextAtLaunch = values.originalNativeTextAtLaunch;
      if (Object.prototype.hasOwnProperty.call(values, "panelFrame")) panelFrame = values.panelFrame;
      if (Object.prototype.hasOwnProperty.call(values, "panelSuspended")) panelSuspended = values.panelSuspended;
      if (Object.prototype.hasOwnProperty.call(values, "panelDialog")) panelDialog = values.panelDialog;
      if (Object.prototype.hasOwnProperty.call(values, "pendingPanelOpen")) pendingPanelOpen = values.pendingPanelOpen;
      if (Object.prototype.hasOwnProperty.call(values, "composerAnchorRect")) composerAnchorRect = values.composerAnchorRect;
      if (Object.prototype.hasOwnProperty.call(values, "panelReturnFocusTarget")) panelReturnFocusTarget = values.panelReturnFocusTarget;
      if (Object.prototype.hasOwnProperty.call(values, "hiddenComposer")) hiddenComposer = values.hiddenComposer;
      if (Object.prototype.hasOwnProperty.call(values, "hadNativeComposer")) hadNativeComposer = values.hadNativeComposer;
      if (Object.prototype.hasOwnProperty.call(values, "launcher")) launcher = values.launcher;
      if (Object.prototype.hasOwnProperty.call(values, "pendingFreshLaunchUntil")) pendingFreshLaunchUntil = values.pendingFreshLaunchUntil;
      if (Object.prototype.hasOwnProperty.call(values, "pngImagesAtRisk")) pngImagesAtRisk = values.pngImagesAtRisk;
    },
    getHarnessState() { return { panelLaunchOrigin, composerTextSnapshot, pngImagesAtRisk, navigationWarningInstalled, originalNativeTextAtLaunch, panelPosition, pendingPanelOpen, panelSuspended }; },
  };
})();`;

  const replacements = [];
  const navigations = [];
  const trace = [];
  const runtimeMessages = [];
  const eventHandlers = new Map();
  const windowListeners = new Map();
  const appendedToBody = [];
  const pendingFrames = [];
  const sessionValues = new Map();
  const sessionStorage = {
    getItem(key) { return sessionValues.get(key) ?? null; },
    setItem(key, value) { sessionValues.set(key, String(value)); },
    removeItem(key) { sessionValues.delete(key); },
  };
  const pendingTimeouts = new Map();
  let nextTimeoutId = 1;
  const inputListeners = new Map();
  const scheduleFrame = (fn) => {
    if (deferFrames) pendingFrames.push(fn);
    else fn();
    return 1;
  };
  const document = {
    addEventListener(type, handler) {
      if (!inputListeners.has(type)) inputListeners.set(type, new Set());
      inputListeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { inputListeners.get(type)?.delete(handler); },
    documentElement: { lang: 'en', removeAttribute() {} },
    getElementById(id) { return appendedToBody.find(e => e.id === id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createDocumentFragment() {
      return { childNodes: [], append(child) { this.childNodes.push(child); } };
    },
    createElement(tag) {
      const element = elementNode(tag);
      element.style = {};
      element.focus = () => { document.activeElement = element; trace.push('focus:' + element.id); };
      element.appendChild = element.append;
      element.setAttribute = (name, value) => { element[name] = value; };
      element.addEventListener = (name, callback) => eventHandlers.set(name, callback);
      if (tag === 'dialog') {
        element.open = false;
        element.showModal = () => { trace.push('showModal'); element.open = true; };
        element.close = () => { trace.push('closeDialog'); element.open = false; };
      }
      return element;
    },
    body: { appendChild(element) { appendedToBody.push(element); } },
    createTextNode: textNode,
  };
  const location = {
    replace(url) { replacements.push(url); },
    assign(url) { navigations.push(url); },
  };
  const window = {
    innerWidth: 1200,
    innerHeight: 900,
    location,
    sessionStorage,
    requestAnimationFrame: scheduleFrame,
    addEventListener(type, listener) { windowListeners.set(type, listener); },
    removeEventListener(type, listener) { if (windowListeners.get(type) === listener) windowListeners.delete(type); },
  };
  window.top = window;

  const context = runScript(source, {
    TpngI18n: makeTestI18n(),
    window,
    document,
    Node: { TEXT_NODE, ELEMENT_NODE },
    InputEvent: class InputEvent {
      constructor(type, init) { this.type = type; Object.assign(this, init); }
    },
    browser: { runtime: {
      getURL() { return 'moz-extension://our-id/panel.html'; },
      async sendMessage(message) {
        trace.push('runtime:' + message.type);
        runtimeMessages.push(message);
        if (message.type === 'getPanelBridgeSecret') {
          return { ok: true, secret: 'test-panel-bridge' };
        }
        return { ok: true };
      },
    } },
    crypto: { randomUUID() { return 'd34980c3-b974-4f0c-ad2f-376c4e6f1ab2'; } },
    getComputedStyle() { return { display: 'block', visibility: 'visible' }; },
    requestAnimationFrame: scheduleFrame,
    setTimeout(fn) { const id = nextTimeoutId++; pendingTimeouts.set(id, fn); return id; },
    clearTimeout(id) { pendingTimeouts.delete(id); },
  }, 'content.js');

  return { api: context.__contentTest, window, replacements, navigations, document, trace, runtimeMessages, eventHandlers,
    appendedToBody, pendingFrames, pendingTimeouts, inputListeners, windowListeners, sessionStorage };
}

function mockConnectedComposer(text = '') {
  const textbox = elementNode('div', text ? [elementNode('p', [textNode(text)])] : []);
  textbox.isConnected = true;
  textbox.replaceChildren = (fragment) => { textbox.childNodes = [...fragment.childNodes]; };
  textbox.dispatchEvent = () => true;
  const root = {
    isConnected: true,
    style: { display: 'none' },
    contains(node) { return node === textbox; },
    querySelector() { return textbox; },
  };
  return { root, textbox };
}


test('content script rejects a navigated iframe even with matching WindowProxy', () => {
  const { api } = loadContentHarness();
  const messages = [];
  const frame = { hidden: false, contentWindow: { postMessage(message) { messages.push(message); } } };
  api.setHarnessState({ panelFrame: frame });
  api.handlePanelMessage({ source: frame.contentWindow, origin: 'https://attacker.example',
    data: { type: 'pngImageDraftRisk', atRisk: true } });
  assert.equal(api.getHarnessState().pngImagesAtRisk, false);
  api.handlePanelMessage({ source: frame.contentWindow, origin: 'moz-extension://our-id',
    data: { type: 'pngImageDraftRisk', atRisk: true } });
  assert.equal(api.getHarnessState().pngImagesAtRisk, true);
});

test('Romanian native media control is identified by its language-independent test ID', () => {
  const { api, document } = loadContentHarness();
  const mediaButton = {
    getAttribute(name) {
      if (name === 'aria-label') return 'Adăugare conținut media la postare';
      if (name === 'data-testid') return 'openMediaBtn';
      return null;
    },
    innerText: '',
  };
  const dialog = {
    querySelector(selector) {
      return selector === '[data-testid="openMediaBtn"]' ? mediaButton : null;
    },
    querySelectorAll() { return [mediaButton]; },
  };
  const textbox = {
    getBoundingClientRect() { return { width: 500, height: 250 }; },
    closest(selector) { return selector === "[role='dialog']" ? dialog : null; },
  };
  document.querySelectorAll = () => [textbox];

  assert.equal(api.findMediaButton(dialog), mediaButton);
  const composers = api.findVisibleComposers();
  assert.equal(composers.length, 1);
  assert.equal(composers[0].textbox, textbox);
  assert.equal(composers[0].root, dialog);
});

test('native media locator retains English-label fallback when test ID is absent', () => {
  const { api } = loadContentHarness();
  const englishButton = {
    getAttribute(name) { return name === 'aria-label' ? 'Add media to post' : null; },
  };
  const root = {
    querySelector() { return null; },
    querySelectorAll() { return [englishButton]; },
  };
  assert.equal(api.findMediaButton(root), englishButton);
});

test('Romanian publish control is identified by its test ID, not its localized label', () => {
  const { api } = loadContentHarness();
  const publishButton = {
    getAttribute(name) { return name === 'aria-label' ? 'Publicați postarea' : null; },
  };
  const englishButton = {
    getAttribute(name) { return name === 'aria-label' ? 'Publish post' : null; },
  };
  const root = {
    querySelector(selector) {
      return selector === '[data-testid="composerPublishBtn"]' ? publishButton : null;
    },
    querySelectorAll() { return [englishButton, publishButton]; },
  };
  assert.equal(api.findPublishButton(root), publishButton);
});

test('publish-button locator retains English-label fallback without a test ID', () => {
  const { api } = loadContentHarness();
  const englishButton = {
    getAttribute(name) { return name === 'aria-label' ? 'Post' : null; },
  };
  const root = {
    querySelector() { return null; },
    querySelectorAll() { return [englishButton]; },
  };
  assert.equal(api.findPublishButton(root), englishButton);
});


// Real Bluesky header labels are localized. A mock DOM tree lets these tests
// verify the identity/ownership constraints without assuming header order.
function nativeHeaderFixture({
  cancelLabel = 'Anulare',
  draftsLabel = 'Schițe',
  publishLabel = 'Publicați postarea',
  actionId = null,
  duplicateCancel = false,
  duplicatePublish = false,
  foreignCancel = false,
  extraHeaderButton = false,
  controlsOrder = ['cancel', 'drafts', 'publish'],
} = {}) {
  const make = (label, testid = null) => ({
    getAttribute(name) {
      if (name === 'aria-label') return label;
      if (name === 'data-testid') return testid;
      return null;
    },
    click() { this.clicks = (this.clicks || 0) + 1; },
  });
  const cancel = make(cancelLabel, actionId);
  const drafts = make(draftsLabel);
  const publish = make(publishLabel, 'composerPublishBtn');
  const actions = { cancel, drafts, publish };
  const headerControls = controlsOrder.map((name) => actions[name]);
  if (extraHeaderButton) headerControls.push(make('Something else'));
  if (duplicateCancel && !foreignCancel) headerControls.push(make(cancelLabel));
  if (duplicatePublish) headerControls.push(make('Other publish', 'composerPublishBtn'));
  const header = {
    parentElement: null,
    contains(control) { return headerControls.includes(control); },
    querySelectorAll() { return headerControls; },
  };
  for (const control of headerControls) control.parentElement = header;
  const outsider = duplicateCancel && foreignCancel ? make(cancelLabel) : null;
  if (outsider) outsider.parentElement = null;
  const root = {
    isConnected: true,
    querySelectorAll() { return outsider ? [...headerControls, outsider] : headerControls; },
  };
  header.parentElement = root;
  return { root, cancel, drafts, publish, header };
}

test('Romanian native Cancel is anchored to the unique publish header, not the first button', () => {
  const { api } = loadContentHarness();
  for (const order of [
    ['cancel', 'drafts', 'publish'],
    ['drafts', 'publish', 'cancel'],
  ]) {
    const { root, cancel, drafts } = nativeHeaderFixture({ controlsOrder: order });
    assert.equal(api.findOwnedComposerCancel(root), cancel);
    assert.notEqual(api.findOwnedComposerCancel(root), drafts);
  }
});

test('native Cancel action ID is used only when unique inside the owned composer', () => {
  const { api } = loadContentHarness();
  const { root, cancel } = nativeHeaderFixture({
    cancelLabel: 'A localized cancel button', actionId: 'composerDiscardButton',
  });
  assert.equal(api.findOwnedComposerCancel(root), cancel);
  root.querySelectorAll = () => [cancel, { getAttribute: (name) =>
    name === 'data-testid' ? 'composerDiscardButton' : null }];
  assert.equal(api.findOwnedComposerCancel(root), null, 'collision must fail closed');
});

test('localized Cancel lookup refuses ambiguous headers, collisions and unknown controls', () => {
  const { api } = loadContentHarness();
  for (const params of [
    { duplicateCancel: true },
    { duplicateCancel: true, foreignCancel: true },
    { duplicatePublish: true },
    { foreignCancel: true, duplicateCancel: true },
    { extraHeaderButton: true },
    { cancelLabel: 'A language we have not identified' },
  ]) {
    const { root } = nativeHeaderFixture(params);
    assert.equal(api.findOwnedComposerCancel(root), null, JSON.stringify(params));
  }
  const { root, cancel } = nativeHeaderFixture();
  cancel.parentElement = null;
  root.querySelectorAll = () => [cancel]; // No verified publish anchor.
  assert.equal(api.findOwnedComposerCancel(root), null);
  assert.equal(api.findOwnedComposerCancel({ isConnected: false, querySelectorAll: () => [] }), null);
});

test('English native Cancel lookup retains its previous unique-label fallback', () => {
  const { api } = loadContentHarness();
  const english = nativeHeaderFixture({ cancelLabel: 'Cancel', draftsLabel: 'Drafts', publishLabel: 'Publish post' });
  assert.equal(api.findOwnedComposerCancel(english.root), english.cancel);
  const duplicate = nativeHeaderFixture({ cancelLabel: 'Cancel', duplicateCancel: true });
  assert.equal(api.findOwnedComposerCancel(duplicate.root), null);
});

test('semantic composer serializer preserves paragraph and hard-break counts without Firefox innerText expansion', () => {
  const { api } = loadContentHarness();
  const textbox = elementNode('div', [
    elementNode('p', [textNode('one'), elementNode('br'), textNode('two')]),
    elementNode('p', []),
    elementNode('p', [textNode('three'), elementNode('br', [], ['ProseMirror-trailingBreak'])]),
  ]);

  assert.equal(api.readComposerTextboxText(textbox), 'one\ntwo\n\nthree');
});

test('syncComposerText writes one ProseMirror paragraph per plain-text line and round-trips exactly', () => {
  const { api } = loadContentHarness();
  const dispatched = [];
  const textbox = elementNode('div');
  textbox.isConnected = true;
  textbox.replaceChildren = (fragment) => { textbox.childNodes = [...fragment.childNodes]; };
  textbox.dispatchEvent = (event) => { dispatched.push(event); return true; };

  api.setHarnessState({ hiddenComposerTextbox: textbox });
  const original = 'first line\n\nthird line';
  assert.equal(api.syncComposerText(original), true);
  assert.equal(textbox.childNodes.length, 3);
  assert.equal(api.readComposerTextboxText(textbox), original);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'input');
  assert.equal(dispatched[0].bubbles, true);
});

test('Cancel holds the native modal shade until Bluesky fadeIn finishes, then restores focus', async () => {
  const { api, trace, pendingTimeouts } = loadContentHarness();
  let endFade;
  const finished = new Promise((resolve) => { endFade = resolve; });
  const nativeComposer = mockConnectedComposer('draft').root;
  nativeComposer.getAnimations = () => [
    { animationName: 'fadeIn', playState: 'running', finished },
  ];
  const panelFrame = { hidden: false, contentWindow: { postMessage(message) { trace.push(message.type); } } };
  const panelDialog = { open: true, close() { trace.push('closeDialog'); this.open = false; } };
  const returnTarget = { isConnected: true, focus() { trace.push('returnFocus'); } };
  api.setHarnessState({
    panelFrame, panelDialog, panelReturnFocusTarget: returnTarget,
    hiddenComposer: nativeComposer, composerTextSnapshot: 'draft',
  });

  const closing = api.closePanel('draft');
  assert.equal(nativeComposer.style.display, '', 'restore native shade before dismissing ours');
  assert.equal(panelDialog.open, true, 'keep native modal and its backdrop while Bluesky fades in');
  assert.equal(pendingTimeouts.size, 1, 'bound native animation wait to a short timeout');
  endFade();
  await closing;
  assert.equal(panelDialog.open, false);
  assert.equal(panelFrame.hidden, true);
  assert.equal(pendingTimeouts.size, 0, 'clear the timeout when fade completes');
  assert.deepEqual(trace, ['resetDraft', 'closeDialog', 'returnFocus']);
});

test('Cancel uses safety timeout if Bluesky fade animation never finishes', async () => {
  const { api, pendingTimeouts } = loadContentHarness();
  const composer = mockConnectedComposer('draft').root;
  composer.getAnimations = () => [
    { animationName: 'fadeIn', playState: 'running', finished: new Promise(() => {}) },
  ];
  const panelFrame = { hidden: false, contentWindow: { postMessage() {} } };
  const panelDialog = { open: true, close() { this.open = false; } };
  api.setHarnessState({ panelFrame, panelDialog, hiddenComposer: composer, composerTextSnapshot: 'draft' });
  const closing = api.closePanel('draft');
  assert.equal(panelDialog.open, true);
  assert.equal(pendingTimeouts.size, 1);
  [...pendingTimeouts.values()][0]();
  await closing;
  assert.equal(panelDialog.open, false, 'bounded fallback always completes Cancel');
  assert.equal(pendingTimeouts.size, 0);
});

test('toolbar-origin empty Cancel keeps the tab and replaces compose intent with ordinary Bluesky', async () => {
  const { api, replacements } = loadContentHarness();
  const panelMessages = [];
  const panelFrame = {
    hidden: false,
    contentWindow: { postMessage(message) { panelMessages.push(message); } },
  };
  api.setHarnessState({
    panelLaunchOrigin: 'toolbar',
    composerTextSnapshot: '   ',
    panelFrame,
    panelReturnFocusTarget: null,
    hiddenComposer: mockConnectedComposer().root,
  });

  api.setHarnessState({ panelDialog: { open: true, close() {} } });
  await api.closePanel();
  assert.deepEqual(replacements, ['https://bsky.app/']);
  assert.equal(panelMessages.at(-1).type, 'resetDraft');
  assert.equal(api.getHarnessState().panelLaunchOrigin, 'native');
});

test('toolbar-origin meaningful text Cancel preserves the tab/composer instead of navigating away', async () => {
  const { api, replacements } = loadContentHarness();
  const focusTarget = { isConnected: true, focusCount: 0, focus() { this.focusCount += 1; } };
  const panelFrame = {
    hidden: false,
    contentWindow: { postMessage() {} },
  };
  api.setHarnessState({
    panelLaunchOrigin: 'toolbar',
    composerTextSnapshot: 'keep this draft',
    panelFrame,
    panelReturnFocusTarget: focusTarget,
    hiddenComposer: mockConnectedComposer().root,
  });

  api.setHarnessState({ panelDialog: { open: true, close() {} } });
  await api.closePanel();
  assert.deepEqual(replacements, []);
  assert.equal(panelFrame.hidden, true);
  assert.equal(focusTarget.focusCount, 1);
  assert.equal(api.getHarnessState().panelLaunchOrigin, 'native');
});


test('native composer language label resolves to Bluesky post-language codes without a translated name table', () => {
  const { api } = loadContentHarness();

  assert.deepEqual([...api.resolveLanguageButtonLabel('English', 'en')], ['en']);
  assert.deepEqual([...api.resolveLanguageButtonLabel('Bulgarian, Breton', 'en')], ['bg', 'br']);

  const frenchNames = new Intl.DisplayNames(['fr'], {
    type: 'language',
    fallback: 'none',
    languageDisplay: 'standard',
  });
  const frenchEnglish = frenchNames.of('en');
  assert.ok(frenchEnglish, 'test runtime should expose a French display name for English');
  assert.deepEqual([...api.resolveLanguageButtonLabel(frenchEnglish, 'fr')], ['en']);

  assert.equal(api.resolveLanguageButtonLabel('Not a language', 'en'), null);
});

test('composer language reader uses the visible Bluesky language selector and fails closed when unresolved', () => {
  const { api } = loadContentHarness();
  const englishButton = { innerText: 'English' };
  const root = { querySelector(selector) { return selector === '[data-testid="selectLangBtn"]' ? englishButton : null; } };

  assert.deepEqual([...api.readComposerPostLanguages(root)], ['en']);

  englishButton.innerText = 'Not a language';
  assert.deepEqual([...api.readComposerPostLanguages(root)], []);
});


test('periodic polling skips whole-page composer scans when idle, but DOM mutations still trigger maintenance', () => {
  const { api, document, pendingFrames } = loadContentHarness({ deferFrames: true });
  let scans = 0;
  document.querySelectorAll = () => { scans++; return []; };
  assert.equal(api.shouldRunPeriodicMaintenance(), false);
  for (let i = 0; i < 5; i++) api.runPeriodicMaintenance();
  assert.equal(scans, 0, 'five idle timer ticks cause no whole-page queries');

  // A Bluesky DOM change invokes the existing observer callback and causes
  // the normal composer scan even while the timer is dormant.
  api.scheduleMaintenance();
  assert.equal(pendingFrames.length, 1);
  pendingFrames.shift()();
  assert.equal(scans > 0, true, 'mutations still run the full maintenance path');
  assert.equal(api.shouldRunPeriodicMaintenance(), false);
});

test('idle observer ignores unrelated feed child-list changes but discovers deeply nested composer additions', () => {
  const { api, document, pendingFrames } = loadContentHarness({ deferFrames: true });
  let scans = 0;
  document.querySelectorAll = () => { scans += 1; return []; };
  const unrelated = {
    nodeType: 1,
    matches: () => false,
    querySelector: () => null,
  };
  const textOnly = { nodeType: 3, nodeValue: 'New feed entry' };
  const feed = [{ addedNodes: [unrelated, textOnly], removedNodes: [], target: document.body }];
  assert.equal(api.shouldScheduleComposerMaintenance(feed), false);
  api.observeComposerMutations(feed);
  assert.equal(pendingFrames.length, 0, 'idle feed update does not queue maintenance');
  assert.equal(scans, 0, 'unrelated feed mutations must not search the full page');

  const editor = { nodeType: 1, matches: () => true, querySelector: () => null };
  const wrapper = { nodeType: 1, matches: () => false, querySelector: () => editor };
  const insertion = [{ addedNodes: [wrapper], removedNodes: [], target: document.body }];
  assert.equal(api.shouldScheduleComposerMaintenance(insertion), true,
    'new composer nested in a portal or wrapper triggers discovery');
  api.observeComposerMutations(insertion);
  api.observeComposerMutations(insertion);
  assert.equal(pendingFrames.length, 1, 'observer queues a single coalesced maintenance frame');
  pendingFrames.shift()();
  assert.equal(scans > 0, true, 'scheduled maintenance performs composer discovery');
  assert.equal(api.shouldScheduleComposerMaintenance([
    { addedNodes: [], removedNodes: [wrapper], target: document.body },
  ]), true, 'removed composer subtree also triggers maintenance');
  assert.equal(api.shouldScheduleComposerMaintenance([
    { addedNodes: [textOnly], removedNodes: [], target: { closest: () => editor } },
  ]), true, 'children added to an already-present editor trigger discovery');
});

test('active composer, suspended draft, and toolbar recovery observe even unrelated changes', () => {
  const { api } = loadContentHarness();
  const unimportant = [{ addedNodes: [{ nodeType: 3 }], removedNodes: [], target: {} }];
  assert.equal(api.shouldScheduleComposerMaintenance(unimportant), false);
  api.setHarnessState({ launcher: { isConnected: true } });
  assert.equal(api.shouldScheduleComposerMaintenance(unimportant), true);
  api.setHarnessState({ launcher: null, panelSuspended: true });
  assert.equal(api.shouldScheduleComposerMaintenance(unimportant), true);
  api.setHarnessState({ panelSuspended: false, pendingFreshLaunchUntil: Date.now() + 60_000 });
  assert.equal(api.shouldScheduleComposerMaintenance(unimportant), true);
  api.setHarnessState({ pendingFreshLaunchUntil: 0, hadNativeComposer: true });
  assert.equal(api.shouldScheduleComposerMaintenance(unimportant), true);
  api.setHarnessState({ hadNativeComposer: false });
  assert.equal(api.shouldScheduleComposerMaintenance(unimportant), false);
});

test('periodic fallback remains active during an owned composer lifecycle and pending toolbar resume', () => {
  const { api, document } = loadContentHarness();
  let scans = 0;
  document.querySelectorAll = () => { scans++; return []; };

  api.setHarnessState({ hadNativeComposer: true });
  assert.equal(api.shouldRunPeriodicMaintenance(), true, 'native composer is being watched for dismissal');
  api.runPeriodicMaintenance();
  assert.equal(scans > 0, true, 'timer still checks the active composer lifecycle');

  api.setHarnessState({ hadNativeComposer: false, launcher: { isConnected: true } });
  assert.equal(api.shouldRunPeriodicMaintenance(), true, 'connected launcher retains restriction-state polling');
  api.setHarnessState({ launcher: null, panelFrame: { hidden: false } });
  assert.equal(api.shouldRunPeriodicMaintenance(), true, 'visible PNG editor retains fallback checks');
  api.setHarnessState({ panelFrame: null, pendingPanelOpen: { requestId: 1 } });
  assert.equal(api.shouldRunPeriodicMaintenance(), true, 'first-launch preparation remains covered');
  api.setHarnessState({ pendingPanelOpen: null, panelSuspended: true });
  assert.equal(api.shouldRunPeriodicMaintenance(), true, 'suspended PNG draft remains covered');
  api.setHarnessState({ panelSuspended: false });
  assert.equal(api.shouldRunPeriodicMaintenance(), false);

  api.setHarnessState({ pendingFreshLaunchUntil: Date.now() + 60_000 });
  assert.equal(api.shouldRunPeriodicMaintenance(), true, 'pending toolbar launch retains periodic recovery');
  api.setHarnessState({ pendingFreshLaunchUntil: 0 });
  assert.equal(api.shouldRunPeriodicMaintenance(), false);
});

test('idle maintenance creates no iframe, while the first eligible launch mounts one and waits for readiness', () => {
  const { api, document, appendedToBody, trace } = loadContentHarness();
  document.getElementById = () => null;
  document.documentElement.appendChild = () => {};
  const media = {
    parentElement: {},
    insertAdjacentElement(_position, button) { root.launcher = button; button.isConnected = true; },
  };
  let eligible = false;
  const root = {
    style: { display: '' },
    isConnected: true,
    contains(node) { return node === textbox || node === root.launcher; },
    getBoundingClientRect() { return { left: 80, top: 60, width: 550, height: 330 }; },
    querySelector(selector) { return selector === '[data-testid="openMediaBtn"]' ? media : null; },
    querySelectorAll(selector) {
      if (selector.includes('openReplyGateButton')) return eligible ? [interactionGateFixture()] : [];
      if (selector.includes('userAvatarImage')) return [{}];
      return [];
    },
  };
  withPlainPostShape(root);
  const textbox = {
    isConnected: true,
    childNodes: [],
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 80, top: 60, width: 550, height: 330 }; },
    closest(selector) { return selector === "[role='dialog']" ? root : null; },
  };
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [textbox] : [];

  // Even a visible but unsupported composer does not initialize extension UI.
  api.runMaintenance();
  api.runMaintenance();
  assert.equal(appendedToBody.length, 0, 'no hidden dialog or iframe during idle maintenance');
  assert.equal(api.showPanel(), false, 'unsupported composer cannot initialize panel');
  assert.equal(appendedToBody.length, 0);

  eligible = true;
  api.runMaintenance();
  assert.equal(root.launcher.disabled, false, 'native launcher still appears and updates');
  assert.equal(appendedToBody.length, 0, 'eligible launcher alone does not load the iframe');

  assert.equal(api.showPanel(), true, 'first approved launch creates the panel on demand');
  assert.equal(appendedToBody.length, 2, 'dialog and Restore control created once');
  const dialog = appendedToBody[0];
  const frame = dialog.childNodes[0];
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.src, 'moz-extension://our-id/panel.html');
  assert.equal(dialog.open, false, 'native composer remains available while iframe loads');
  assert.equal(api.getHarnessState().pendingPanelOpen.preparationSent, false);

  const panelMessages = [];
  frame.contentWindow = { postMessage(message) { panelMessages.push(message); } };
  api.handlePanelMessage({ source: frame.contentWindow, data: { type: 'panelReady' } });
  assert.equal(panelMessages.length, 1, 'iframe ready triggers exactly one preparation request');
  assert.equal(panelMessages[0].type, 'prepareOpen');
  assert.equal(api.getHarnessState().pendingPanelOpen.preparationSent, true);
  assert.equal(dialog.open, false, 'focus remains in native composer pending panelPrepared');

  api.runMaintenance();
  assert.equal(appendedToBody.length, 2, 'repeated maintenance reuses the existing frame');
  assert.equal(panelMessages.length, 1, 'no duplicate prepareOpen after readiness');
  assert.equal(trace.includes('showModal'), false);
});

test('extension panel is mounted in a named top-level native modal dialog', () => {
  const { api, appendedToBody, eventHandlers } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const dialog = appendedToBody[0];

  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog['aria-label'], 'Transparent PNG tools');
  assert.equal(dialog.childNodes[0], frame);
  assert.equal(frame.tagName, 'IFRAME');
  assert.equal(frame.hidden, true);
  assert.equal(dialog.open, false);
  assert.equal(frame.src, 'moz-extension://our-id/panel.html');
  assert.equal(typeof eventHandlers.get('cancel'), 'function');
  assert.equal(api.ensurePanelFrame(), frame, 'reuse the prepared extension iframe');
  assert.equal(appendedToBody.length, 2);
  assert.equal(appendedToBody[1].id, 'bsky-tpng-return');
  assert.equal(appendedToBody[1].hidden, true);
});

test('native modal opens before focus request; Cancel restores native composer and focus after closing', async () => {
  const { api, document, trace, appendedToBody, sessionStorage } = loadContentHarness();
  sessionStorage.setItem('bskyTpngToolbarLaunchNoticeUntil', '9999999999999');
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage(message) { trace.push(message.type); } };
  const nativeMedia = {};
  const composerRoot = {
    style: { display: '' },
    isConnected: true,
    getBoundingClientRect() { return { width: 540, height: 300, left: 80, top: 80 }; },
    querySelector(selector) { return selector === '[data-testid="openMediaBtn"]' ? nativeMedia : null; },
    querySelectorAll(selector) {
      if (selector.includes('openReplyGateButton')) return [interactionGateFixture()];
      if (selector.includes('userAvatarImage')) return [{}];
      return [];
    },
  };
  withPlainPostShape(composerRoot);
  const textbox = {
    isConnected: true,
    childNodes: [elementNode('p', [textNode('native draft')])],
    replaceChildren(fragment) { this.childNodes = [...fragment.childNodes]; },
    dispatchEvent() {},
    getBoundingClientRect() { return { width: 540, height: 300 }; },
    closest(selector) { return selector === "[role='dialog']" ? composerRoot : null; },
  };
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [textbox] : [];
  const returnTarget = { isConnected: true, focus() { trace.push('returnFocus'); } };
  api.setHarnessState({
    panelReturnFocusTarget: returnTarget,
    panelLaunchOrigin: 'native',
    pendingPanelOpen: { requestId: 7 },
    composerAnchorRect: { left: 80, top: 80, width: 540, height: 300 },
  });

  api.revealPreparedPanel(7);
  assert.equal(frame.hidden, false);
  assert.equal(appendedToBody[0].open, true);
  assert.ok(trace.indexOf('showModal') < trace.indexOf('focusInitial'));
  assert.equal(composerRoot.style.display, '', 'native composer remains visible during focus transfer');

  api.finishPanelFocusHandoff(7);
  assert.equal(sessionStorage.getItem('bskyTpngToolbarLaunchNoticeUntil'), null,
    'successful focus ack removes toolbar fallback even if native launch was used');
  assert.equal(composerRoot.style.display, 'none', 'native composer is hidden only after focus ack');
  await api.closePanel();
  assert.equal(appendedToBody[0].open, false);
  assert.equal(frame.hidden, true);
  assert.equal(composerRoot.style.display, '');
  assert.ok(trace.indexOf('closeDialog') < trace.indexOf('returnFocus'));
  assert.equal(api.getHarnessState().pendingPanelOpen, null);
});

test('Escape cancel of native dialog runs the same draft-preserving close path', async () => {
  const { api, eventHandlers, trace, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage(message) { trace.push(message.type); } };
  const dialog = appendedToBody[0];
  dialog.open = true;
  frame.hidden = false;
  const focusTarget = { isConnected: true, focus() { trace.push('returnFocus'); } };
  api.setHarnessState({ panelLaunchOrigin: 'native', composerTextSnapshot: 'draft', panelReturnFocusTarget: focusTarget, hiddenComposer: mockConnectedComposer('draft').root });
  let prevented = false;
  eventHandlers.get('cancel')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.open, true, 'parent cancel waits for iframe state/Cancel decision');
  assert.deepEqual(trace, ['requestCancel']);
  api.handlePanelMessage({ source: frame.contentWindow, data: { type: 'closePanel' } });
  assert.equal(dialog.open, false);
  assert.equal(frame.hidden, true);
  assert.deepEqual(trace, ['requestCancel', 'resetDraft', 'closeDialog', 'returnFocus']);
  // Native dialog cancel may race with an iframe Escape-to-Cancel message.
  eventHandlers.get('cancel')({ preventDefault() {} });
  api.handlePanelMessage({ source: frame.contentWindow, data: { type: 'closePanel' } });
  assert.deepEqual(trace, ['requestCancel', 'resetDraft', 'closeDialog', 'returnFocus'], 'duplicate close requests are ignored');
});

test('suspension closes native modality but preserves the same live iframe, and restore returns modal focus', async () => {
  const { api, appendedToBody, trace } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const dialog = appendedToBody[0];
  const restore = appendedToBody[1];
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message.type); } };
  frame.hidden = false;
  dialog.showModal();
  assert.equal(await api.suspendPanel(), true);
  assert.equal(dialog.open, false, 'Bluesky becomes non-inert');
  assert.equal(api.getHarnessState().panelSuspended, true);
  assert.equal(frame.hidden, false, 'iframe and image File objects remain loaded');
  assert.equal(restore.hidden, false);
  assert.equal(restore.textContent, 'Return to PNG composer');
  assert.ok(trace.includes('focus:bsky-tpng-return'), 'keyboard enters return affordance');
  assert.equal(await api.suspendPanel(), false, 'cannot double-suspend');
  assert.equal(api.restoreSuspendedPanel(), true);
  assert.equal(dialog.open, true);
  assert.equal(api.getHarnessState().panelSuspended, false);
  assert.equal(restore.hidden, true);
  assert.equal(frame.hidden, false);
  assert.ok(messages.includes('resumeFocus'));
  assert.equal(api.restoreSuspendedPanel(), false, 'cannot double-restore');
  assert.ok(!messages.includes('resetDraft'), 'suspending never resets a draft');
});

function makeDesktopNavCompose(label = 'Compuneți o nouă postare', options = {}) {
  const control = {
    tagName: options.tagName ?? 'BUTTON',
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    getBoundingClientRect() { return { width: 90, height: 40 }; },
    click() { options.onClick?.(); },
  };
  const wrapper = {
    tagName: 'DIV',
    children: options.extraChild ? [control, {}] : [control],
    firstElementChild: control,
  };
  const nav = {
    lastElementChild: wrapper,
    getBoundingClientRect() {
      return { width: options.hidden ? 0 : 250, height: 600 };
    },
    querySelector(selector) {
      if (selector === 'a[href="/notifications"]') return options.noNotifications ? null : {};
      if (selector === 'a[href="/settings"]') return options.noSettings ? null : {};
      return null;
    },
  };
  return { nav, control, wrapper };
}

test('desktop New post lookup is language-independent and constrained to Bluesky main navigation', () => {
  for (const label of ['Compuneți o nouă postare', 'Compose new post', '投稿を作成', '']) {
    const { api, document } = loadContentHarness();
    const { nav, control } = makeDesktopNavCompose(label);
    document.querySelectorAll = (selector) => {
      if (selector === '[role="navigation"]') return [nav];
      if (selector === "button,a,[role='button']") return [
        { getAttribute: () => 'New post', getBoundingClientRect: () => ({ width: 20, height: 20 }) },
      ];
      return [];
    };
    assert.equal(api.findNewPostControl(), control, `landmark wins over translated labels: ${label}`);
  }
});

test('New post lookup declines unknown, ambiguous, or incomplete nav structures', () => {
  for (const options of [{ noNotifications: true }, { noSettings: true },
    { hidden: true }, { extraChild: true }, { tagName: 'A' }]) {
    const { api, document } = loadContentHarness();
    const { nav } = makeDesktopNavCompose('Compuneți o nouă postare', options);
    document.querySelectorAll = (selector) => selector === '[role="navigation"]' ? [nav] : [];
    assert.equal(api.findNewPostControl(), null, JSON.stringify(options));
  }
  const { api, document } = loadContentHarness();
  const a = makeDesktopNavCompose('Compuneți o nouă postare');
  const b = makeDesktopNavCompose('Compose new post');
  document.querySelectorAll = (selector) => selector === '[role="navigation"]' ? [a.nav, b.nav] : [];
  assert.equal(api.findNewPostControl(), null, 'two plausible New post controls must fail closed');
});

test('New post retains exactly-one English accessible-label fallback outside desktop navigation', () => {
  const { api, document } = loadContentHarness();
  const english = makeDesktopNavCompose('New post').control;
  const other = makeDesktopNavCompose('Compose new post').control;
  document.querySelectorAll = (selector) => selector === "button,a,[role='button']" ? [english] : [];
  assert.equal(api.findNewPostControl(), english);
  document.querySelectorAll = (selector) => selector === "button,a,[role='button']" ? [english, other] : [];
  assert.equal(api.findNewPostControl(), null);
});

function makeNativeComposeButton() {
  return {
    tagName: 'BUTTON',
    getAttribute(name) { return name === 'aria-label' ? 'Compose new post' : null; },
    getBoundingClientRect() { return { width: 36, height: 36 }; },
  };
}

function dispatchDocumentEvent(inputListeners, type, target) {
  for (const callback of [...(inputListeners.get(type) || [])]) callback({ type, target });
}

function setupReturnFocusRace() {
  const harness = loadContentHarness({ deferFrames: true });
  const { api, document, appendedToBody } = harness;
  api.ensurePanelFrame();
  const dialog = appendedToBody[0];
  const returnButton = appendedToBody[1];
  dialog.childNodes[0].hidden = false;
  dialog.showModal();
  const { nav, control: nativeCompose } = makeDesktopNavCompose();
  document.querySelectorAll = (selector) => selector === '[role="navigation"]' ? [nav] : [];
  return { ...harness, dialog, returnButton, nativeCompose };
}

test('minimize recovers after late Bluesky focusin and removes its temporary listener', async () => {
  const { api, document, dialog, returnButton, nativeCompose, trace, inputListeners, pendingTimeouts } =
    setupReturnFocusRace();
  assert.equal(await api.suspendPanel(), true);
  assert.equal(document.activeElement, returnButton, 'initial focus on Return');
  assert.equal(inputListeners.get('focusin').size, 1);
  document.activeElement = nativeCompose;
  dispatchDocumentEvent(inputListeners, 'focusin', nativeCompose);
  await Promise.resolve();
  assert.equal(document.activeElement, returnButton, 'Bluesky focus return triggers one handoff');
  assert.equal(trace.filter((entry) => entry === 'focus:bsky-tpng-return').length, 2);
  assert.equal(inputListeners.get('focusin').size, 0, 'listener is removed');
  assert.equal(inputListeners.get('keydown').size, 0);
  assert.equal(inputListeners.get('pointerdown').size, 0);
  assert.equal(pendingTimeouts.size, 0, 'expiry timer cleared');
  assert.equal(dialog.open, false);
  document.activeElement = nativeCompose;
  dispatchDocumentEvent(inputListeners, 'focusin', nativeCompose);
  assert.equal(document.activeElement, nativeCompose, 'no ongoing focus trap');
});

test('minimize never reclaims focus after an intentional keyboard or pointer action', async () => {
  for (const type of ['keydown', 'pointerdown']) {
    const { api, document, nativeCompose, returnButton, trace, inputListeners } =
      setupReturnFocusRace();
    assert.equal(await api.suspendPanel(), true);
    dispatchDocumentEvent(inputListeners, type, nativeCompose);
    document.activeElement = nativeCompose;
    dispatchDocumentEvent(inputListeners, 'focusin', nativeCompose);
    await Promise.resolve();
    assert.equal(document.activeElement, nativeCompose, `${type} leaves page focus alone`);
    assert.equal(inputListeners.get('focusin').size, 0);
    assert.equal(trace.filter((entry) => entry === 'focus:bsky-tpng-return').length, 1);
    assert.equal(returnButton.hidden, false);
  }
});

test('minimize ignores unrelated focus targets and abandons a pending handoff on restore', async () => {
  const { api, document, nativeCompose, returnButton, trace, inputListeners } =
    setupReturnFocusRace();
  assert.equal(await api.suspendPanel(), true);
  const other = { tagName: 'BUTTON' };
  document.activeElement = other;
  dispatchDocumentEvent(inputListeners, 'focusin', other);
  await Promise.resolve();
  assert.equal(document.activeElement, other);
  document.activeElement = nativeCompose;
  dispatchDocumentEvent(inputListeners, 'focusin', nativeCompose);
  assert.equal(api.restoreSuspendedPanel(), true);
  await Promise.resolve();
  assert.equal(document.activeElement, nativeCompose, 'restoration cancels deferred focus');
  assert.equal(returnButton.hidden, true);
  assert.equal(inputListeners.get('focusin').size, 0);
  assert.equal(trace.filter((entry) => entry === 'focus:bsky-tpng-return').length, 1);
});

test('handoff watcher expires without moving focus', async () => {
  const { api, document, nativeCompose, trace, inputListeners, pendingTimeouts } =
    setupReturnFocusRace();
  assert.equal(await api.suspendPanel(), true);
  assert.equal(pendingTimeouts.size, 1);
  [...pendingTimeouts.values()][0]();
  assert.equal(inputListeners.get('focusin').size, 0);
  document.activeElement = nativeCompose;
  dispatchDocumentEvent(inputListeners, 'focusin', nativeCompose);
  await Promise.resolve();
  assert.equal(document.activeElement, nativeCompose);
  assert.equal(trace.filter((entry) => entry === 'focus:bsky-tpng-return').length, 1);
});

test('normal Cancel after restore still destroys the modal draft state', async () => {
  const { api, appendedToBody, trace } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage(message) { trace.push(message.type); } };
  const dialog = appendedToBody[0];
  frame.hidden = false;
  dialog.showModal();
  await api.suspendPanel();
  api.restoreSuspendedPanel();
  api.setHarnessState({ panelLaunchOrigin: 'native', hiddenComposer: mockConnectedComposer().root });
  await api.closePanel();
  assert.equal(dialog.open, false);
  assert.equal(frame.hidden, true);
  assert.equal(appendedToBody[1].hidden, true);
  assert.equal(api.getHarnessState().panelSuspended, false);
  assert.ok(trace.includes('resetDraft'));
});

test('Cancel after Bluesky SPA navigation opens a fresh composer and restores latest iframe text', async () => {
  const { api, document, appendedToBody, trace } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message.type); } };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();

  const newComposer = mockConnectedComposer();
  let opened = false;
  let clicks = 0;
  const root = {
    isConnected: true,
    style: { display: '' },
    querySelector(selector) { return selector === '[data-testid="openMediaBtn"]' ? { parentElement: null } : null; },
  };
  const textbox = newComposer.textbox;
  textbox.getBoundingClientRect = () => ({ width: 550, height: 300 });
  textbox.closest = (selector) => selector === "[role='dialog']" ? root : null;
  textbox.focus = () => trace.push('newComposerFocus');
  const control = {
    getAttribute(name) { return name === 'aria-label' ? 'New post' : null; },
    getBoundingClientRect() { return { width: 40, height: 40 }; },
    click() { opened = true; clicks += 1; },
  };
  document.querySelectorAll = (selector) => {
    if (selector.includes('contenteditable')) return opened ? [textbox] : [];
    if (selector === 'button,a,[role=\'button\']') return [control];
    return [];
  };

  api.setHarnessState({
    panelFrame: frame,
    hiddenComposer: { isConnected: false },
    composerTextSnapshot: 'original native draft',
    originalNativeTextAtLaunch: 'original native draft',
    panelLaunchOrigin: 'native',
  });
  await api.closePanel('edited after navigation\n\nlast line');
  assert.equal(clicks, 1, 'a new composer is opened exactly once');
  assert.equal(api.readComposerTextboxText(textbox), 'edited after navigation\n\nlast line');
  assert.equal(frame.hidden, true, 'extension closes only after copying text');
  assert.equal(dialog.open, false, 'successful recovery does not reopen the modal');
  assert.ok(messages.includes('resetDraft'));
  assert.ok(!messages.includes('cancelRecoveryFailed'));
  assert.ok(trace.includes('newComposerFocus'));
  const diagnostic = JSON.parse(dialog['data-tpng-cancel-diagnostic']);
  assert.equal(diagnostic.stage, 'recovered-to-new-composer');
  assert.equal(diagnostic.pngModalOpen, false);
  assert.equal(diagnostic.originalRootConnected, false);
  assert.equal(typeof diagnostic.visibleComposers, 'number');
  assert.ok(!JSON.stringify(diagnostic).includes('edited after navigation'),
    'diagnostics must never include draft text');
});

test('Romanian New post control recovers latest text after Minimize and Bluesky navigation', async () => {
  const { api, document, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message.type); } };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();
  const newComposer = mockConnectedComposer('');
  const textbox = newComposer.textbox;
  textbox.getBoundingClientRect = () => ({ width: 500, height: 250 });
  textbox.closest = (selector) => selector === "[role='dialog']" ? newComposer.root : null;
  textbox.focus = () => {};
  newComposer.root.querySelector = (selector) =>
    selector === '[data-testid="openMediaBtn"]' ? { parentElement: null } : null;
  let opened = false;
  let clicks = 0;
  const { nav } = makeDesktopNavCompose('Compuneți o nouă postare', {
    onClick() { opened = true; clicks += 1; },
  });
  document.querySelectorAll = (selector) => {
    if (selector.includes('contenteditable')) return opened ? [textbox] : [];
    if (selector === '[role="navigation"]') return [nav];
    return [];
  };
  api.setHarnessState({
    hiddenComposer: { isConnected: false },
    composerTextSnapshot: 'edited Romanian draft',
    originalNativeTextAtLaunch: 'original native draft',
  });
  await api.closePanel('edited Romanian draft\nsecond line');
  assert.equal(clicks, 1);
  assert.equal(api.readComposerTextboxText(textbox), 'edited Romanian draft\nsecond line');
  assert.equal(frame.hidden, true);
  assert.equal(dialog.open, false);
  assert.ok(messages.includes('resetDraft'));
  assert.ok(!messages.includes('cancelRecoveryFailed'));
});

test('native launch snapshot remains frozen while the PNG editor text changes', () => {
  const { api } = loadContentHarness();
  api.setHarnessState({
    hiddenComposer: { isConnected: false },
    composerTextSnapshot: 'initial text',
    originalNativeTextAtLaunch: 'initial text',
  });
  assert.equal(api.syncComposerText('edited in extension'), false,
    'the native editor is unavailable after navigation');
  assert.equal(api.getHarnessState().composerTextSnapshot, 'edited in extension');
  assert.equal(api.getHarnessState().originalNativeTextAtLaunch, 'initial text');
});

test('Cancel safely updates a newly opened Bluesky composer that restored the original native draft', async () => {
  const { api, document, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message.type); } };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();

  const restoredOriginalText = 'native draft\nsecond line';
  const newComposer = mockConnectedComposer(restoredOriginalText);
  const textbox = newComposer.textbox;
  textbox.focus = () => {};
  textbox.getBoundingClientRect = () => ({ width: 550, height: 300 });
  textbox.closest = (selector) => selector === "[role='dialog']" ? newComposer.root : null;
  newComposer.root.querySelector = (selector) =>
    selector === '[data-testid="openMediaBtn"]' ? { parentElement: null } : null;
  let opened = false;
  const newPostButton = {
    getAttribute(name) { return name === 'aria-label' ? 'New post' : null; },
    getBoundingClientRect() { return { width: 40, height: 40 }; },
    click() { opened = true; },
  };
  document.querySelectorAll = (selector) => {
    if (selector.includes('contenteditable')) return opened ? [textbox] : [];
    if (selector === "button,a,[role='button']") return [newPostButton];
    return [];
  };
  api.setHarnessState({
    hiddenComposer: { isConnected: false },
    composerTextSnapshot: 'edited PNG draft',
    originalNativeTextAtLaunch: restoredOriginalText,
  });
  await api.closePanel('edited PNG draft\nmost recent edit');
  assert.equal(api.readComposerTextboxText(textbox), 'edited PNG draft\nmost recent edit');
  assert.equal(dialog.open, false);
  assert.equal(frame.hidden, true);
  assert.ok(messages.includes('resetDraft'));
  assert.ok(!messages.includes('cancelRecoveryFailed'));
  assert.equal(JSON.parse(dialog['data-tpng-cancel-diagnostic']).stage, 'recovered-matching-original-text');
});

test('Cancel refuses to overwrite a newly opened draft that differs from the original', async () => {
  const { api, document, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message.type); } };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();

  const unrelatedText = 'a different Bluesky draft';
  const newComposer = mockConnectedComposer(unrelatedText);
  const textbox = newComposer.textbox;
  textbox.focus = () => {};
  textbox.getBoundingClientRect = () => ({ width: 550, height: 300 });
  textbox.closest = (selector) => selector === "[role='dialog']" ? newComposer.root : null;
  newComposer.root.querySelector = (selector) =>
    selector === '[data-testid="openMediaBtn"]' ? { parentElement: null } : null;
  let opened = false;
  const newPostButton = {
    getAttribute(name) { return name === 'aria-label' ? 'New post' : null; },
    getBoundingClientRect() { return { width: 40, height: 40 }; },
    click() { opened = true; },
  };
  document.querySelectorAll = (selector) => {
    if (selector.includes('contenteditable')) return opened ? [textbox] : [];
    if (selector === "button,a,[role='button']") return [newPostButton];
    return [];
  };
  api.setHarnessState({
    hiddenComposer: { isConnected: false },
    composerTextSnapshot: 'latest PNG draft',
    originalNativeTextAtLaunch: 'original native draft',
  });
  await api.closePanel('latest PNG draft');
  assert.equal(api.readComposerTextboxText(textbox), unrelatedText);
  assert.equal(dialog.open, true, 'our composer and attachment draft remain available');
  assert.equal(frame.hidden, false);
  assert.ok(!messages.includes('resetDraft'));
  assert.ok(messages.includes('cancelRecoveryFailed'));
  assert.equal(JSON.parse(dialog['data-tpng-cancel-diagnostic']).stage, 'new-composer-not-owned');
});

test('Cancel recovery failure retains PNG draft and returns focus to the extension', async () => {
  const { api, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message.type); } };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();
  api.setHarnessState({ hiddenComposer: { isConnected: false }, composerTextSnapshot: 'old' });

  await api.closePanel('latest unsaved edit');
  assert.equal(dialog.open, true);
  assert.equal(frame.hidden, false);
  assert.equal(api.getHarnessState().composerTextSnapshot, 'latest unsaved edit');
  assert.ok(messages.includes('cancelRecoveryFailed'));
  assert.ok(!messages.includes('resetDraft'));
  const diagnostic = JSON.parse(dialog['data-tpng-cancel-diagnostic']);
  assert.equal(diagnostic.stage, 'no-new-post-control');
  assert.equal(diagnostic.pngModalOpen, true);
  assert.equal(diagnostic.newPostControlFound, false);
  assert.ok(!JSON.stringify(diagnostic).includes('latest unsaved edit'),
    'diagnostics must exclude draft contents');
});

test('Cancel refuses to overwrite an unrelated native composer', async () => {
  const { api, document, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message); } };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();
  const otherTextbox = mockConnectedComposer('unrelated native draft').textbox;
  otherTextbox.getBoundingClientRect = () => ({ width: 550, height: 300 });
  otherTextbox.closest = () => ({
    querySelector(selector) { return selector === '[data-testid="openMediaBtn"]' ? {} : null; },
  });
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [otherTextbox] : [];
  api.setHarnessState({ hiddenComposer: { isConnected: false }, composerTextSnapshot: 'our PNG draft' });

  await api.closePanel('our updated PNG draft');
  assert.equal(api.readComposerTextboxText(otherTextbox), 'unrelated native draft');
  assert.equal(dialog.open, true);
  assert.equal(frame.hidden, false);
  assert.equal(messages.filter(message => message.type === 'cancelRecoveryFailed').length, 1);
  assert.equal(messages.find(message => message.type === 'cancelRecoveryFailed').reason, 'other-composer-open');
  assert.ok(!messages.some(message => message.type === 'resetDraft'));
  const diagnostic = JSON.parse(dialog['data-tpng-cancel-diagnostic']);
  assert.equal(diagnostic.stage, 'blocked-by-visible-composer');
  assert.equal(diagnostic.visibleComposers, 1);
  assert.ok(!JSON.stringify(diagnostic).includes('our updated PNG draft'),
    'diagnostics must exclude draft contents');
});


test('successful post uses native Cancel to close its original composer without navigating', async () => {
  const { api, appendedToBody, navigations } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage() {} };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();
  const original = mockConnectedComposer('previous native draft');
  let cancelled = 0;
  const cancel = { getAttribute(name) { return name === 'aria-label' ? 'Cancel' : null; },
    click() { cancelled++; original.root.isConnected = false; } };
  original.root.querySelectorAll = () => [cancel];
  api.setHarnessState({ hiddenComposer: original.root, hiddenComposerTextbox: original.textbox });

  await api.handlePanelMessage({ source: frame.contentWindow, data: {
    type: 'postComplete', url: 'https://bsky.app/profile/example/post/123',
  } });

  assert.equal(dialog.open, false);
  assert.equal(frame.hidden, true);
  assert.equal(cancelled, 1, 'Bluesky native Cancel was invoked exactly once');
  assert.equal(original.root.isConnected, false, 'Bluesky closed its own composer');
  assert.deepEqual(navigations, [], 'successful post does not navigate the tab');
});

test('Romanian Cancel can close an owned native composer after a successful post without navigation', async () => {
  const { api, appendedToBody, navigations } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage() {} };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();
  const { root, cancel, drafts, publish } = nativeHeaderFixture();
  root.style = { display: 'none' };
  let cancels = 0;
  cancel.click = () => { cancels += 1; root.isConnected = false; };
  api.setHarnessState({ hiddenComposer: root });

  await api.handlePanelMessage({ source: frame.contentWindow, data: {
    type: 'postComplete', url: 'https://bsky.app/profile/example/post/123',
  } });
  assert.equal(cancels, 1);
  assert.equal(root.isConnected, false);
  assert.equal(drafts.clicks || 0, 0, 'Drafts was not clicked');
  assert.equal(publish.clicks || 0, 0, 'Bluesky native Publish was not clicked');
  assert.equal(dialog.open, false);
  assert.deepEqual(navigations, []);
});

test('Romanian published post cleans up the owned native draft via its complete confirmation triad', async () => {
  const { api, document, appendedToBody, navigations } = loadContentHarness();
  document.documentElement.lang = 'ro';
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage() {} };
  frame.hidden = false;
  const panel = appendedToBody[0];
  panel.showModal();
  const { root, cancel, drafts, publish } = nativeHeaderFixture();
  root.style = { display: 'none' };
  let promptOpen = false;
  let discarded = 0;
  cancel.click = () => { promptOpen = true; };
  const make = (label, click = () => {}) => ({
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    click,
  });
  const discard = make('Renunțare', () => { discarded += 1; root.isConnected = false; });
  const save = make('Salvare schiță');
  const keep = make('Continuați editarea');
  const prompt = {
    getBoundingClientRect() { return { width: 350, height: 180 }; },
    querySelectorAll() { return [discard, save, keep]; },
  };
  document.querySelectorAll = (selector) =>
    selector === '[role="alertdialog"],[role="dialog"]' && promptOpen ? [prompt] : [];
  api.setHarnessState({ hiddenComposer: root });
  await api.handlePanelMessage({ source: frame.contentWindow, data: {
    type: 'postComplete', url: 'https://bsky.app/profile/example/post/123',
  } });
  assert.equal(discarded, 1);
  assert.equal(root.isConnected, false);
  assert.equal(drafts.clicks || 0, 0);
  assert.equal(publish.clicks || 0, 0);
  assert.equal(save.clicks || 0, 0);
  assert.equal(keep.clicks || 0, 0);
  assert.equal(panel.open, false);
  assert.deepEqual(navigations, []);
});

test('native Save draft / Keep editing / Discard confirmation closes the original composer', async () => {
  const { api, document, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage() {} };
  frame.hidden = false;
  appendedToBody[0].showModal();
  const original = mockConnectedComposer('posted text');
  let cancelClicks = 0;
  let discardClicks = 0;
  let promptOpen = false;
  const cancel = { getAttribute(name) { return name === 'aria-label' ? 'Cancel' : null; },
    click() { cancelClicks++; promptOpen = true; } };
  const button = (label, onClick = () => {}) => ({
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    click: onClick,
  });
  const save = button('Save draft');
  const keep = button('Keep editing');
  const discard = button('Discard', () => { discardClicks++; original.root.isConnected = false; });
  const oldComposerDialog = { getBoundingClientRect() { return { width: 400, height: 300 }; } };
  const prompt = {
    innerText: 'Save your work?', // Deliberately NOT “Discard post?”
    getBoundingClientRect() { return { width: 300, height: 200 }; },
    querySelectorAll() { return [save, keep, discard]; },
  };
  original.root.querySelectorAll = () => [cancel];
  document.querySelectorAll = (selector) => {
    if (selector === '[role="alertdialog"],[role="dialog"]') {
      return promptOpen ? [oldComposerDialog, prompt] : [oldComposerDialog];
    }
    return [];
  };
  api.setHarnessState({ hiddenComposer: original.root, hiddenComposerTextbox: original.textbox });
  await api.handlePanelMessage({ source: frame.contentWindow, data: {
    type: 'postComplete', url: 'https://bsky.app/profile/example/post/123',
  } });
  assert.equal(cancelClicks, 1);
  assert.equal(discardClicks, 1, 'only the newly created discard confirmation is selected');
  assert.equal(original.root.isConnected, false);
});

test('verified Romanian native confirmation is recognized regardless of action order', () => {
  const { api, document } = loadContentHarness();
  const button = (label) => ({ getAttribute(name) {
    return name === 'aria-label' ? label : null;
  }, click() { this.clicks = (this.clicks || 0) + 1; } });
  const save = button('Salvare schiță');
  const keep = button('Continuați editarea');
  const discard = button('Renunțare');
  const prompt = {
    getBoundingClientRect() { return { width: 320, height: 180 }; },
    querySelectorAll() { return actions; },
  };
  let actions;
  document.querySelectorAll = (selector) =>
    selector === '[role="alertdialog"],[role="dialog"]' ? [prompt] : [];
  for (const order of [[save, keep, discard], [discard, keep, save], [keep, discard, save]]) {
    actions = order;
    assert.equal(api.findNewOwnedDiscardConfirmation(new Set()), discard);
    assert.equal(api.findNewOwnedDiscardConfirmation(new Set([prompt])), null,
      'existing dialogs must not be targeted');
  }
});

test('native confirmation refuses partial, mixed-language, duplicated, or competing actions', () => {
  const { api, document } = loadContentHarness();
  const button = (label) => ({ getAttribute(name) {
    return name === 'aria-label' ? label : null;
  } });
  const prompt = (labels) => ({
    getBoundingClientRect() { return { width: 320, height: 180 }; },
    querySelectorAll() { return labels.map(button); },
  });
  let dialogs = [];
  document.querySelectorAll = (selector) =>
    selector === '[role="alertdialog"],[role="dialog"]' ? dialogs : [];
  const invalid = [
    ['Salvare schiță', 'Keep editing', 'Renunțare'],
    ['Salvare schiță', 'Continuați editarea', 'Discard'],
    ['Salvare schiță', 'Renunțare', 'Renunțare'],
    ['Salvare schiță', 'Continuați editarea', 'Renunțare', 'Other action'],
    ['Salvare schiță', 'Continuați editarea', 'Unknown action'],
  ];
  for (const labels of invalid) {
    dialogs = [prompt(labels)];
    assert.equal(api.findNewOwnedDiscardConfirmation(new Set()), null, labels.join(','));
  }
  dialogs = [prompt(['Salvare schiță', 'Continuați editarea', 'Renunțare']),
             prompt(['Save draft', 'Keep editing', 'Discard'])];
  assert.equal(api.findNewOwnedDiscardConfirmation(new Set()), null,
    'two matching dialogs must be ambiguous even if languages differ');
});

test('Romanian Minimize confirms only the owned native draft is discarded', async () => {
  const { api, document, appendedToBody } = loadContentHarness();
  document.documentElement.lang = 'ro';
  const frame = api.ensurePanelFrame();
  const panelMessages = [];
  frame.contentWindow = { postMessage(message) { panelMessages.push(message.type); } };
  const panel = appendedToBody[0];
  const returnButton = appendedToBody[1];
  frame.hidden = false;
  panel.showModal();
  const { root, cancel, drafts, publish } = nativeHeaderFixture();
  root.style = { display: 'none' };
  root.getBoundingClientRect = () => ({ width: 600, height: 440 });
  let confirmationOpen = false;
  let discardClicks = 0;
  cancel.click = () => { confirmationOpen = true; };
  const action = (label, click = () => {}) => ({
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    click,
  });
  const save = action('Salvare schiță');
  const keep = action('Continuați editarea');
  const discard = action('Renunțare', () => {
    discardClicks++;
    root.isConnected = false;
    confirmationOpen = false;
  });
  const confirmation = {
    getBoundingClientRect() { return { width: 300, height: 180 }; },
    // The Romanian DOM evidence did not establish a dependable action order.
    querySelectorAll() { return [keep, discard, save]; },
  };
  document.querySelectorAll = (selector) =>
    selector === '[role="alertdialog"],[role="dialog"]' && confirmationOpen
      ? [confirmation] : [];
  api.setHarnessState({
    hiddenComposer: root,
    composerTextSnapshot: 'draft in our PNG editor',
    originalNativeTextAtLaunch: 'original draft',
  });
  assert.equal(await api.suspendPanel(), true);
  assert.equal(discardClicks, 1);
  assert.equal(root.isConnected, false);
  assert.equal(drafts.clicks || 0, 0);
  assert.equal(publish.clicks || 0, 0);
  assert.equal(save.clicks || 0, 0);
  assert.equal(keep.clicks || 0, 0);
  assert.equal(api.getHarnessState().composerTextSnapshot, 'draft in our PNG editor');
  assert.equal(panel.open, false);
  assert.equal(returnButton.hidden, false);
  assert.ok(!panelMessages.includes('suspendCleanupFailed'));
});

test('ambiguous native discard dialogs are left for the user to resolve', async () => {
  for (const promptCount of [0, 2]) {
    const { api, document, appendedToBody } = loadContentHarness();
    const frame = api.ensurePanelFrame();
    frame.contentWindow = { postMessage() {} };
    frame.hidden = false;
    appendedToBody[0].showModal();
    const original = mockConnectedComposer('already published text');
    let promptOpen = false;
    let discarded = 0;
    const cancel = { getAttribute(name) { return name === 'aria-label' ? 'Cancel' : null; },
      click() { promptOpen = true; } };
    original.root.querySelectorAll = () => [cancel];
    const button = (label) => ({
      getAttribute(name) { return name === 'aria-label' ? label : null; },
      click() { if (label === 'Discard') discarded++; },
    });
    const prompt = () => ({
      getBoundingClientRect() { return { width: 300, height: 200 }; },
      querySelectorAll() { return promptCount === 0
        ? [button('Discard')]
        : [button('Save draft'), button('Keep editing'), button('Discard')]; },
    });
    const prompts = promptCount === 0 ? [prompt()] : [prompt(), prompt()];
    document.querySelectorAll = (selector) => selector === '[role="alertdialog"],[role="dialog"]'
      ? (promptOpen ? prompts : []) : [];
    api.setHarnessState({ hiddenComposer: original.root, hiddenComposerTextbox: original.textbox });
    await api.handlePanelMessage({ source: frame.contentWindow, data: {
      type: 'postComplete', url: 'https://bsky.app/profile/example/post/123',
    } });
    assert.equal(discarded, 0, 'unverified discard control was not used');
    assert.equal(original.root.isConnected, true, 'original native composer remains for manual cleanup');
  }
});

test('missing native Cancel control leaves original composer visible for manual cleanup', async () => {
  const { api, appendedToBody, navigations } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage() {} };
  frame.hidden = false;
  appendedToBody[0].showModal();
  const original = mockConnectedComposer('posted text');
  original.root.querySelectorAll = () => [];
  api.setHarnessState({ hiddenComposer: original.root, hiddenComposerTextbox: original.textbox });
  await api.handlePanelMessage({ source: frame.contentWindow, data: {
    type: 'postComplete', url: 'https://bsky.app/profile/example/post/123',
  } });
  assert.equal(original.root.style.display, '', 'no unverified control is clicked');
  assert.equal(original.root.isConnected, true);
  assert.equal(frame.hidden, true);
  assert.deepEqual(navigations, []);
});

test('publishing A while an unrelated native reply B is open never exposes A over B or navigates', () => {
  const { api, document, appendedToBody, navigations } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage() {} };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  dialog.showModal();
  const original = mockConnectedComposer('original composer text');
  const reply = mockConnectedComposer('unsaved reply B');
  reply.textbox.getBoundingClientRect = () => ({ width: 500, height: 250 });
  reply.textbox.closest = () => reply.root;
  reply.root.querySelector = (selector) => selector === '[data-testid="openMediaBtn"]' ? {} : null;
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [reply.textbox] : [];
  api.setHarnessState({ hiddenComposer: original.root, hiddenComposerTextbox: original.textbox });

  api.handlePanelMessage({ source: frame.contentWindow, data: {
    type: 'postComplete', url: 'https://bsky.app/profile/example/post/123',
  } });

  assert.equal(api.readComposerTextboxText(reply.textbox), 'unsaved reply B');
  assert.equal(reply.root.isConnected, true);
  assert.equal(original.root.style.display, 'none', 'original hidden composer is not revealed over B');
  assert.equal(dialog.open, false);
  assert.equal(frame.hidden, true);
  assert.deepEqual(navigations, [], 'reply B is not destroyed by an automatic page navigation');
});

test('Read Bluesky page dismisses only the owned native composer before exposing page and preserves frozen draft', async () => {
  const { api, document, appendedToBody, trace } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const panelMessages = [];
  frame.contentWindow = { postMessage(message) { panelMessages.push(message.type); } };
  const dialog = appendedToBody[0];
  const returnButton = appendedToBody[1];
  frame.hidden = false;
  dialog.showModal();

  let confirmationOpen = false;
  let discarded = 0;
  const button = (label, click = () => {}) => ({
    getAttribute(name) { return name === 'aria-label' ? label : null; },
    innerText: label,
    click,
  });
  const root = {
    isConnected: true,
    style: { display: 'none' },
    getBoundingClientRect() { return { width: 600, height: 440 }; },
    querySelectorAll() { return [cancel]; },
  };
  const cancel = button('Cancel', () => { confirmationOpen = true; });
  const discard = button('Discard', () => { discarded += 1; root.isConnected = false; confirmationOpen = false; });
  const confirm = {
    getBoundingClientRect() { return { width: 400, height: 200 }; },
    querySelectorAll() { return [button('Save draft'), button('Keep editing'), discard]; },
  };
  document.querySelectorAll = (selector) =>
    selector.includes('role="dialog"') || selector.includes('role="alertdialog"')
      ? confirmationOpen ? [confirm] : []
      : [];
  api.setHarnessState({ hiddenComposer: root, composerTextSnapshot: 'edit saved', originalNativeTextAtLaunch: 'original draft' });

  assert.equal(await api.suspendPanel(), true);
  assert.equal(discarded, 1, 'only the original native composer draft is discarded');
  assert.equal(dialog.open, false);
  assert.equal(returnButton.hidden, false);
  assert.equal(api.getHarnessState().panelSuspended, true);
  assert.equal(api.getHarnessState().composerTextSnapshot, 'edit saved');
  assert.equal(api.getHarnessState().originalNativeTextAtLaunch, 'original draft');
  assert.equal(frame.hidden, false, 'File attachments remain in the loaded iframe');
  assert.ok(!panelMessages.includes('resetDraft'));
  assert.ok(!panelMessages.includes('suspendCleanupFailed'));
  assert.ok(trace.includes('focus:bsky-tpng-return'));
});

test('Read Bluesky page refuses to dismiss an unknown composer, retaining the modal and the draft', async () => {
  const { api, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message.type); } };
  const dialog = appendedToBody[0];
  frame.hidden = false;
  dialog.showModal();
  const root = {
    isConnected: true,
    style: { display: 'none' },
    querySelectorAll() { return []; },
  };
  api.setHarnessState({ hiddenComposer: root, composerTextSnapshot: 'retain my text' });
  assert.equal(await api.suspendPanel(), false);
  assert.equal(dialog.open, true);
  assert.equal(api.getHarnessState().panelSuspended, false);
  assert.equal(api.getHarnessState().composerTextSnapshot, 'retain my text');
  assert.equal(appendedToBody[1].hidden, true);
  assert.ok(messages.includes('suspendCleanupFailed'));
});


test('beforeunload protection is installed only for an active draft, including suspended image-only drafts', () => {
  const { api, windowListeners } = loadContentHarness();
  const frame = { hidden: false };
  api.setHarnessState({ panelFrame: frame, composerTextSnapshot: '', pngImagesAtRisk: false });
  api.updateNavigationWarning();
  assert.equal(windowListeners.has('beforeunload'), false, 'empty composer does not block navigation');

  api.setHarnessState({ composerTextSnapshot: 'Draft text' });
  api.updateNavigationWarning();
  assert.equal(windowListeners.has('beforeunload'), true);
  assert.equal(api.getHarnessState().navigationWarningInstalled, true);
  const event = { defaultPrevented: false, returnValue: null,
    preventDefault() { this.defaultPrevented = true; } };
  windowListeners.get('beforeunload')(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.returnValue, '');

  api.setHarnessState({ composerTextSnapshot: '', pngImagesAtRisk: true, panelSuspended: true });
  api.updateNavigationWarning();
  assert.equal(windowListeners.has('beforeunload'), true, 'suspended images remain protected');

  frame.hidden = true;
  api.updateNavigationWarning();
  assert.equal(windowListeners.has('beforeunload'), false, 'successful close removes listener');
  assert.equal(api.getHarnessState().navigationWarningInstalled, false);
});

test('draft-image risk message adds and removes full-navigation warning', () => {
  const { api, windowListeners } = loadContentHarness();
  const frame = { hidden: false, contentWindow: {} };
  api.setHarnessState({ panelFrame: frame, composerTextSnapshot: '' });
  api.handlePanelMessage({ source: frame.contentWindow, data: { type: 'pngImageDraftRisk', atRisk: true } });
  assert.equal(windowListeners.has('beforeunload'), true);
  api.handlePanelMessage({ source: frame.contentWindow, data: { type: 'pngImageDraftRisk', atRisk: false } });
  assert.equal(windowListeners.has('beforeunload'), false);
});

// SVG signatures captured from Firefox with the Bluesky interaction control
// in unrestricted and limited modes. These are fixtures, not Bluesky APIs.
const OBSERVED_GLOBE_PATH = 'M4.4 9.493C4.14 10.28 4 11.124 4 12a8 8 0 1 0 10.899-7.459l-.953 3.81a1 1 0 0 1-.726.727l-3.444.866-.772 1.533a1 1 0 0 1-1.493.35L4.4 9.493Zm.883-1.84L7.756 9.51l.44-.874a1 1 0 0 1 .649-.52l3.306-.832.807-3.227a7.993 7.993 0 0 0-7.676 3.597ZM2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10S2 17.523 2 12Zm8.43.162a1 1 0 0 1 .77-.29l1.89.121a1 1 0 0 1 .494.168l2.869 1.928a1 1 0 0 1 .336 1.277l-.973 1.946a1 1 0 0 1-.894.553h-2.92a1 1 0 0 1-.831-.445L9.225 14.5a1 1 0 0 1 .126-1.262l1.08-1.076Zm.915 1.913.177-.177 1.171.074 1.914 1.286-.303.607h-1.766l-1.194-1.79Z';
const OBSERVED_ROUNDED_GLOBE_PATH = OBSERVED_GLOBE_PATH.replace('a7.993 7.993 0 0 0-', 'a7.99 7.99 0 0 0-');
const OBSERVED_LIMITED_PATH = 'M8 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z';

function interactionGateFixture(mode = 'anyone') {
  const primaryPath = mode === 'anyone' ? OBSERVED_GLOBE_PATH
    : mode === 'anyone-rounded' ? OBSERVED_ROUNDED_GLOBE_PATH
    : mode === 'anyone-mutated' ? OBSERVED_ROUNDED_GLOBE_PATH.replace('l-.953 3.81', 'l-.954 3.81')
    : mode === 'limited' ? OBSERVED_LIMITED_PATH : 'unknown updated icon';
  const primary = {
    getAttribute(name) { return name === 'width' ? '16' : name === 'viewBox' ? '0 0 24 24' : null; },
    querySelectorAll(selector) {
      return selector === 'path' ? [{ getAttribute: (name) => name === 'd' ? primaryPath : null }] : [];
    },
  };
  const arrow = { getAttribute(name) { return name === 'width' ? '8' : null; } };
  return {
    ariaLabel: mode === 'anyone' ? 'Anyone can interact' : 'Interaction limited',
    querySelectorAll(selector) { return selector === 'svg' ? [primary, arrow] : []; },
    primary,
  };
}

// A minimal DOM-shaped ComposerPost: first child is the editor/avatar row.
// Bluesky renders each quote/attachment as another direct child, including
// while a quote preview is still loading.
function withPlainPostShape(root, {attachment = false} = {}) {
  const editor = { parentElement: null };
  const row = {
    parentElement: null,
    contains(node) { return node === editor; },
    querySelector(selector) {
      return selector.includes('userAvatarImage') || selector.includes('userAvatarFallback')
        ? {} : null;
    },
  };
  const post = {
    firstElementChild: row,
    children: attachment ? [row, {}] : [row],
    parentElement: root,
  };
  editor.parentElement = row;
  row.parentElement = post;
  const original = root.querySelector?.bind(root);
  root.querySelector = selector => selector === '[contenteditable="true"]'
    ? editor : original?.(selector) ?? null;
  return {root, post, editor};
}

test('only an unambiguous standalone Bluesky composer is eligible for the PNG launcher', () => {
  const { api } = loadContentHarness();
  const root = (gateCount, avatarCount) => ({
    querySelectorAll(selector) {
      const count = selector.includes('openReplyGateButton') ? gateCount : avatarCount;
      return Array.from({ length: count }, () => ({}));
    },
  });
  assert.equal(api.isStandalonePostComposer(root(1, 1)), true, 'observed standalone with image avatar');
  assert.equal(api.isStandalonePostComposer(root(1, 0)), true, 'observed standalone with no userAvatarImage');
  assert.equal(api.isStandalonePostComposer(root(0, 2)), false, 'observed reply signature');
  assert.equal(api.isStandalonePostComposer(root(0, 1)), false, 'unknown editor lacking gate');
  assert.equal(api.isStandalonePostComposer(root(0, 0)), false, 'missing gate still blocks default-avatar context');
  assert.equal(api.isStandalonePostComposer(root(1, 2)), false, 'a gate does not override reply-like avatars');
  assert.equal(api.isStandalonePostComposer(root(2, 1)), false, 'duplicate gate is ambiguous');
  assert.equal(api.isStandalonePostComposer(root(2, 0)), false, 'duplicate gate blocks default-avatar context');
  assert.equal(api.isStandalonePostComposer(null), false);
  assert.equal(api.isStandalonePostComposer({}), false, 'unknown DOM fails safely');
});

test('only the observed language-independent unrestricted globe allows PNG posting', () => {
  const { api } = loadContentHarness();
  const gate = interactionGateFixture();
  const root = {
    querySelectorAll(selector) {
      if (selector.includes('openReplyGateButton')) return [gate];
      if (selector.includes('userAvatarImage')) return [{}];
      return [];
    },
  };
  withPlainPostShape(root);
  assert.equal(api.isEligibleStandaloneComposer(root), true);
  assert.equal(api.hasUnrestrictedComposerInteraction(root), true);
  root.querySelectorAll = (selector) => selector.includes('openReplyGateButton') ? [gate] : [];
  assert.equal(api.isEligibleStandaloneComposer(root), true, 'observed zero-avatar unrestricted standalone allowed');
  root.querySelectorAll = (selector) => selector.includes('openReplyGateButton') ? [gate] : [{}];
  gate.ariaLabel = 'Oricine poate interacționa';
  assert.equal(api.isEligibleStandaloneComposer(root), true, 'independent of translated accessible name');
  root.querySelectorAll = (selector) => selector.includes('openReplyGateButton')
    ? [interactionGateFixture('limited')] : [{}];
  assert.equal(api.isStandalonePostComposer(root), true, 'still a standalone post');
  assert.equal(api.isEligibleStandaloneComposer(root), false, 'restrictive settings block posting');
  for (const state of ['unknown', 'missing']) {
    const candidate = state === 'missing' ? null : interactionGateFixture('unknown');
    root.querySelectorAll = (selector) => selector.includes('openReplyGateButton')
      ? [candidate || { querySelectorAll() { return []; } }] : [{}];
    assert.equal(api.isEligibleStandaloneComposer(root), false, `${state} icons fail closed`);
  }
  const malformed = interactionGateFixture();
  malformed.primary.getAttribute = (name) => name === 'width' ? '24' : '0 0 24 24';
  root.querySelectorAll = (selector) => selector.includes('openReplyGateButton') ? [malformed] : [{}];
  assert.equal(api.isEligibleStandaloneComposer(root), false, 'changed icon markup fails closed');
  root.querySelectorAll = (selector) => selector.includes('openReplyGateButton')
    ? [interactionGateFixture(), interactionGateFixture()] : [{}];
  assert.equal(api.isEligibleStandaloneComposer(root), false, 'duplicate buttons are ambiguous');
  assert.equal(api.isEligibleStandaloneComposer(null), false);
});

test('launcher is natively disabled for replies, re-enabled for standalone, and rechecks changing context', () => {
  const { api, document } = loadContentHarness();
  document.getElementById = () => null;
  document.documentElement.appendChild = () => {};
  let gateCount = 0;
  let avatarCount = 2;
  let interaction = 'anyone';
  const root = {
    contains(node) { return node === textbox || node === root.launcher; },
    querySelector(selector) {
      return selector === '[data-testid="openMediaBtn"]' ? media : null;
    },
    querySelectorAll(selector) {
      const count = selector.includes('openReplyGateButton') ? gateCount : avatarCount;
      return Array.from({ length: count }, () =>
        selector.includes('openReplyGateButton') ? interactionGateFixture(interaction) : {});
    },
  };
  withPlainPostShape(root);
  const media = {
    parentElement: {},
    insertAdjacentElement(position, button) {
      assert.equal(position, 'afterend');
      root.launcher = button;
      button.isConnected = true;
    },
  };
  const textbox = {
    getBoundingClientRect() { return { width: 560, height: 300 }; },
    closest(selector) { return selector === "[role='dialog']" ? root : null; },
  };
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [textbox] : [];

  const button = api.ensureLauncher();
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  assert.equal(button.disabled, true, 'observed reply is disabled, not hidden');
  assert.equal(api.showPanel(), false, 'the programmatic entry point refuses replies');
  gateCount = 1;
  avatarCount = 1;
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, false, 'unrestricted standalone context is enabled');
  avatarCount = 0;
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, false, 'observed zero-avatar unrestricted standalone enables launcher');
  avatarCount = 2;
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, true, 'reply-like multiple avatars disable launcher despite gate');
  avatarCount = 1;
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, false, 'restoring verified standalone signature re-enables launcher');
  interaction = 'limited';
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, true, 'limited interaction disables existing launcher');
  button.disabled = false; // Stale click or programmatic entry while UI changes.
  assert.equal(api.showPanel(), false, 'activation refuses changed interaction setting');
  assert.equal(button.disabled, true);
  interaction = 'anyone';
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, false, 'changing back to unrestricted re-enables native button');
  interaction = 'unknown';
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, true, 'unknown icon also disables native button');
  interaction = 'anyone';
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, false);
  gateCount = 1;
  interaction = 'anyone-rounded';
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, false, 'new account rounded globe enables launcher');
  interaction = 'anyone-mutated';
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, true, 'unrecognized globe mutations stay disabled');
  gateCount = 0;
  avatarCount = 1;
  assert.equal(api.ensureLauncher(), button);
  assert.equal(button.disabled, true, 'stale launcher is disabled when evidence disappears');
  button.disabled = false; // Simulate stale/manual enabled state before activation.
  assert.equal(api.showPanel(), false, 'opening re-evaluates the current composer context');
  assert.equal(button.disabled, true);
});

test('minimized PNG draft disables the native launcher on existing and newly opened composers', () => {
  const { api, document, eventHandlers } = loadContentHarness();
  document.getElementById = () => null;
  document.documentElement.appendChild = () => {};
  const makeComposer = () => {
    const root = {
      contains(node) { return node === textbox || node === root.launcher; },
      querySelector(selector) { return selector === '[data-testid="openMediaBtn"]' ? media : null; },
      querySelectorAll(selector) {
        if (selector.includes('openReplyGateButton')) return [interactionGateFixture()];
        if (selector.includes('userAvatarImage')) return [{}];
        return [];
      },
    };
    withPlainPostShape(root);
    const media = {
      parentElement: {},
      insertAdjacentElement(_where, button) {
        root.launcher = button;
        button.isConnected = true;
        button.remove = () => { button.isConnected = false; };
      },
    };
    const textbox = {
      getBoundingClientRect() { return { width: 560, height: 300 }; },
      closest(selector) { return selector === "[role='dialog']" ? root : null; },
    };
    return { root, textbox };
  };
  const first = makeComposer();
  const second = makeComposer();
  let active = first;
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [active.textbox] : [];

  const firstButton = api.ensureLauncher();
  assert.equal(firstButton.disabled, false, 'first standalone composer is usable before minimizing');
  api.setHarnessState({ panelSuspended: true, composerTextSnapshot: 'Protected PNG draft' });
  assert.equal(api.ensureLauncher(), firstButton);
  assert.equal(firstButton.disabled, true, 'minimizing disables its launcher');

  // A stale click should not run Cancel (the minimized modal is closed),
  // overwrite the draft, or start a second PNG composer.
  let stopped = 0;
  eventHandlers.get('click')({ preventDefault() { stopped++; }, stopPropagation() { stopped++; } });
  assert.equal(stopped, 2);
  assert.equal(api.getHarnessState().panelSuspended, true);
  assert.equal(api.getHarnessState().composerTextSnapshot, 'Protected PNG draft');
  assert.equal(api.getHarnessState().pendingPanelOpen, null);

  active = second;
  const nextButton = api.ensureLauncher();
  assert.notEqual(nextButton, firstButton, 'new native composer gets its own launcher');
  assert.equal(firstButton.isConnected, false, 'launcher from prior composer is removed');
  assert.equal(nextButton.disabled, true, 'new native composer cannot create a second PNG draft');
  assert.equal(api.getHarnessState().composerTextSnapshot, 'Protected PNG draft');

  api.setHarnessState({ panelSuspended: false });
  assert.equal(api.ensureLauncher(), nextButton);
  assert.equal(nextButton.disabled, false, 'launcher is usable again after minimizing ends');
});

test('prepared PNG panel refuses a newly restricted composer before modal focus transfer', () => {
  const { api, document, trace } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  frame.contentWindow = { postMessage(message) { trace.push(message.type); } };
  let interaction = 'anyone';
  const media = {};
  const root = {
    querySelector(selector) { return selector === '[data-testid="openMediaBtn"]' ? media : null; },
    querySelectorAll(selector) {
      if (selector.includes('openReplyGateButton')) return [interactionGateFixture(interaction)];
      if (selector.includes('userAvatarImage')) return [{}];
      return [];
    },
  };
  withPlainPostShape(root);
  const textbox = {
    getBoundingClientRect() { return { width: 540, height: 300 }; },
    closest(selector) { return selector === "[role='dialog']" ? root : null; },
  };
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [textbox] : [];
  api.setHarnessState({
    panelReturnFocusTarget: { isConnected: true },
    pendingPanelOpen: { requestId: 19 },
  });
  interaction = 'limited';
  api.revealPreparedPanel(19);
  assert.equal(frame.hidden, true, 'iframe stays hidden');
  assert.equal(trace.includes('focusInitial'), false, 'no focus handoff into blocked panel');
  assert.equal(api.getHarnessState().pendingPanelOpen, null, 'pending request cancelled');
});


test('page account lookup reads only active DID and handle; never exposes stored credentials', () => {
  const { api, window } = loadContentHarness();
  const stored = {
    session: { currentAccount: {
      did: 'did:plc:alice', handle: 'alice.bsky.social', accessJwt: 'PAGE_SECRET', refreshJwt: 'REFRESH_SECRET',
    } },
    languagePrefs: { appLanguage: 'ro' },
  };
  const keys = [];
  window.localStorage = { getItem(key) { keys.push(key); return JSON.stringify(stored); } };
  assert.deepEqual(JSON.parse(JSON.stringify(api.readBlueskyActiveAccount())), {
    did: 'did:plc:alice', handle: 'alice.bsky.social',
  });
  assert.deepEqual(keys, ['BSKY_STORAGE']);
  const events = [];
  const frame = { contentWindow: { postMessage(message) { events.push(message); } } };
  api.setHarnessState({ panelFrame: frame });
  // A forged page/window identity query cannot trigger an account reply.
  api.handlePanelMessage({ source: frame.contentWindow, data: { type: 'getBlueskyActiveAccount', requestId: 11 } });
  assert.equal(events.length, 0);
  assert.equal(api.handleRuntimeMessage({ type: 'readBlueskyActiveAccount' }), undefined,
    'no longer expose a website-account lookup on the background-triggered runtime channel');
});

test('missing, malformed, signed-out, and unknown DID web sessions never authorize posting', () => {
  const { api, window } = loadContentHarness();
  for (const raw of [null, '{bad', '{}', JSON.stringify({ session: { currentAccount: null } }),
    JSON.stringify({ session: { currentAccount: { did: 'not-a-did' } } })]) {
    window.localStorage = { getItem() { return raw; } };
    assert.equal(api.readBlueskyActiveAccount(), null);
  }
  window.localStorage = { getItem() { throw new Error('private storage unavailable'); } };
  assert.equal(api.readBlueskyActiveAccount(), null);
});


test('standalone with zero or one avatar requires confirmed Anyone interaction', () => {
  const { api } = loadContentHarness();
  const root = (mode, count = 1, avatarCount = 1) => withPlainPostShape({
    querySelectorAll(selector) {
      if (selector.includes('openReplyGateButton')) {
        return Array.from({length: count}, () => interactionGateFixture(mode));
      }
      if (selector.includes('userAvatarImage')) return Array.from({length: avatarCount}, () => ({}));
      return [];
    },
  }).root;
  assert.equal(api.isEligibleStandaloneComposer(root('anyone')), true);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone-rounded')), true);
  assert.equal(api.isEligibleStandaloneComposer(root('limited')), false);
  assert.equal(api.isEligibleStandaloneComposer(root('unknown')), false);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone', 0)), false);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone', 2)), false);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone-rounded', 1, 0)), true);
  assert.equal(api.isEligibleStandaloneComposer(root('limited', 1, 0)), false);
  assert.equal(api.isEligibleStandaloneComposer(root('unknown', 1, 0)), false);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone', 0, 0)), false);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone', 2, 0)), false);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone', 1, 2)), false);
});

test('both live observed globe path variants pass, but unrelated mutations remain blocked', () => {
  const { api } = loadContentHarness();
  assert.equal(OBSERVED_GLOBE_PATH.length, 572);
  assert.equal(OBSERVED_ROUNDED_GLOBE_PATH.length, 570, 'matching 570-char SVG path copied from Firefox');
  const root = (mode) => withPlainPostShape({
    querySelectorAll(selector) {
      if (selector.includes('openReplyGateButton')) return [interactionGateFixture(mode)];
      if (selector.includes('userAvatarImage')) return [{}];
      return [];
    },
  }).root;
  assert.equal(api.isEligibleStandaloneComposer(root('anyone')), true);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone-rounded')), true);
  assert.equal(api.isEligibleStandaloneComposer(root('anyone-mutated')), false);
  assert.equal(api.isEligibleStandaloneComposer(root('limited')), false);
  assert.equal(api.isEligibleStandaloneComposer(root('unknown')), false);
});

test('top-level content script registers a one-use ticket and sends it only to the extension iframe', async () => {
  const { api, trace, runtimeMessages, window } = loadContentHarness();
  window.localStorage = { getItem(key) {
    assert.equal(key, 'BSKY_STORAGE');
    return JSON.stringify({ session: { currentAccount: {
      did: 'did:plc:alice', handle: 'alice.bsky.social',
      accessJwt: 'DO_NOT_SEND_THIS', refreshJwt: 'OR_THIS', email: 'PRIVATE',
    } } });
  } };
  const frame = api.ensurePanelFrame();
  const replies = [];
  frame.contentWindow = { postMessage(message, origin) { replies.push({ message, origin }); } };
  api.handlePanelMessage({ source: frame.contentWindow, data: {
    type: 'requestPanelAccountTicket', requestId: 9,
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(trace.filter(x => x.startsWith('runtime:')), ['runtime:registerPanelAccountTicket']);
  assert.equal(runtimeMessages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages[0])), {
    type: 'registerPanelAccountTicket',
    ticket: 'd34980c3-b974-4f0c-ad2f-376c4e6f1ab2',
    account: { did: 'did:plc:alice', handle: 'alice.bsky.social' },
  }, 'sample the website account at the panel request and forward only DID and handle');
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message.type, 'panelAccountTicket');
  assert.equal(replies[0].message.requestId, 9);
  assert.equal(replies[0].message.ticket, 'd34980c3-b974-4f0c-ad2f-376c4e6f1ab2');
  assert.equal(replies[0].message.account, undefined,
    'account identity never travels through window.postMessage');
  assert.equal(replies[0].origin, 'moz-extension://our-id');
});


test('restore reports live native composer conflict so stale Cancel warning can be removed safely', () => {
  const { api, document, appendedToBody } = loadContentHarness();
  const frame = api.ensurePanelFrame();
  const messages = [];
  frame.contentWindow = { postMessage(message) { messages.push(message); } };
  frame.hidden = false;
  const dialog = appendedToBody[0];
  const otherTextbox = mockConnectedComposer('unrelated native draft').textbox;
  otherTextbox.getBoundingClientRect = () => ({ width: 500, height: 250 });
  otherTextbox.closest = () => ({
    querySelector(selector) { return selector === '[data-testid="openMediaBtn"]' ? {} : null; },
  });
  document.querySelectorAll = (selector) => selector.includes('contenteditable') ? [otherTextbox] : [];
  api.setHarnessState({ panelSuspended: true });
  assert.equal(api.restoreSuspendedPanel(), true);
  assert.equal(messages.at(-1).type, 'resumeFocus');
  assert.equal(messages.at(-1).cancelConflictResolved, false,
    'an unrelated visible native composer must keep the warning');
  assert.equal(api.readComposerTextboxText(otherTextbox), 'unrelated native draft');

  document.querySelectorAll = () => []; // User closes that composer while minimized.
  dialog.close();
  api.setHarnessState({ panelSuspended: true });
  assert.equal(api.restoreSuspendedPanel(), true);
  assert.equal(messages.at(-1).type, 'resumeFocus');
  assert.equal(messages.at(-1).cancelConflictResolved, true,
    'the old warning is now obsolete');
});

test('quote and native-attachment sections fail closed before and after embed loading', () => {
  const {api} = loadContentHarness();
  for (const avatarCount of [0, 1]) {
    const gate = interactionGateFixture();
    const root = {
      querySelectorAll(selector) {
        if (selector.includes('openReplyGateButton')) return [gate];
        if (selector.includes('userAvatarImage')) return Array.from({length: avatarCount}, () => ({}));
        return [];
      },
    };
    const {post} = withPlainPostShape(root);
    assert.equal(api.isEligibleStandaloneComposer(root), true, 'plain post eligible');
    post.children.push({}); // unresolved LazyQuoteEmbed placeholder already in DOM
    assert.equal(api.isEligibleStandaloneComposer(root), false, 'quote preview loading blocks access');
    assert.equal(api.isEligibleStandaloneComposer(root), false, 'hydrated quote with same avatar count blocks access');
    post.children.pop();
    assert.equal(api.isEligibleStandaloneComposer(root), true, 'removing quote restores eligibility');
  }
  const unknown = {
    querySelectorAll(selector) { return selector.includes('openReplyGateButton')
      ? [interactionGateFixture()] : []; },
    querySelector() { return null; },
  };
  assert.equal(api.isEligibleStandaloneComposer(unknown), false, 'unrecognized editor structure fails closed');
});
