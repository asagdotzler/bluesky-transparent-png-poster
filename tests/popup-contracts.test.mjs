import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestI18n, makeElement, readProjectFile, runScript, tick } from './helpers.mjs';

function loadPopup(storage, runtimeImpl) {
  const ids = [
    'accountStatus', 'signInForm', 'handleInput', 'passwordInput', 'signInButton',
    'openButton', 'signOutButton', 'statusMessage',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));
  const writes = [];

  const browser = {
    storage: {
      session: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(values) {
          writes.push(values);
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        },
        async remove(key) { storage.delete(key); },
      },
    },
    runtime: {
      async sendMessage(message) {
        if (runtimeImpl) return runtimeImpl(message);
        if (message.type === 'getSession') return { ok: true, session: null };
        return { ok: true };
      },
    },
  };

  runScript(readProjectFile('popup.js'), {
    TpngI18n: makeTestI18n(),
    browser,
    document: { getElementById(id) { return elements[id]; } },
    window: { close() {} },
  }, 'popup.js');

  return { elements, writes };
}

test('toolbar popup preserves only the handle in session storage and restores it after popup recreation', async () => {
  const storage = new Map();
  const first = loadPopup(storage, async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') return { ok: false, error: 'Check your Bluesky handle and app password, then try again.' };
    return { ok: true };
  });
  await tick();

  first.elements.handleInput.value = 'me.test';
  await first.elements.handleInput.dispatch('input');
  first.elements.passwordInput.value = 'secret-app-password';
  await first.elements.signInForm.dispatch('submit');
  await tick();

  assert.equal(storage.get('popupLoginIdentifier'), 'me.test');
  assert.equal([...storage.values()].includes('secret-app-password'), false);
  assert.ok(first.writes.every((write) => !Object.values(write).includes('secret-app-password')));

  const second = loadPopup(storage);
  await tick();
  assert.equal(second.elements.handleInput.value, 'me.test');
  assert.equal(second.elements.passwordInput.value, '');
  assert.equal(second.elements.passwordInput.focusCount, 1);
});

test('toolbar popup sign-in unlocks cleanly if browser.runtime.sendMessage rejects and can retry', async () => {
  const storage = new Map();
  let rejectLogin = true;
  let loginCalls = 0;
  const popup = loadPopup(storage, async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') {
      loginCalls += 1;
      if (rejectLogin) throw new Error('Extension messaging unavailable.');
      return {
        ok: true,
        session: { did: 'did:plc:me', handle: 'me.test' },
      };
    }
    return { ok: true };
  });
  await tick();

  popup.elements.handleInput.value = 'me.test';
  popup.elements.passwordInput.value = 'secret-app-password';
  await popup.elements.signInForm.dispatch('submit');
  await tick();

  assert.equal(loginCalls, 1);
  assert.equal(popup.elements.signInButton.disabled, false);
  assert.equal(popup.elements.handleInput.value, 'me.test');
  assert.equal(popup.elements.passwordInput.value, 'secret-app-password');
  assert.equal(popup.elements.statusMessage.textContent, 'Extension messaging unavailable.');
  assert.match(popup.elements.statusMessage.className, /error/);

  rejectLogin = false;
  await popup.elements.signInForm.dispatch('submit');
  await tick();

  assert.equal(loginCalls, 2);
  assert.equal(popup.elements.passwordInput.value, '');
  assert.equal(popup.elements.openButton.focusCount, 1);
  assert.equal(popup.elements.signInForm.hidden, true);
});
test('toolbar popup uses a native submit button and guarded form submission without an Enter keydown workaround', async () => {
  const html = readProjectFile('popup.html');
  const js = readProjectFile('popup.js');
  assert.match(html, /<form id="signInForm"[^>]*>[\s\S]*?<input id="passwordInput"[^>]*type="password"[^>]*>[\s\S]*?<button id="signInButton"[^>]*type="submit"[^>]*>[\s\S]*?<\/form>/);
  assert.doesNotMatch(js, /passwordInput\.addEventListener\("keydown"/);
  assert.match(js, /signInForm\.addEventListener\("submit"/);

  let loginCalls = 0;
  const popup = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') {
      loginCalls += 1;
      return { ok: false, error: 'Check your Bluesky handle and app password, then try again.' };
    }
    return { ok: true };
  });
  await tick();
  popup.elements.handleInput.value = 'me.test';
  popup.elements.passwordInput.value = 'secret-app-password';
  await popup.elements.signInForm.dispatch('submit');
  await tick();
  assert.equal(loginCalls, 1);
  assert.equal(popup.elements.statusMessage.textContent, 'Check your Bluesky handle and app password, then try again.');
});


test('toolbar popup announces missing credentials through the native Sign in control when supported', async () => {
  let loginCalls = 0;
  const popup = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') loginCalls += 1;
    return { ok: true };
  });
  await tick();

  const notifications = [];
  popup.elements.signInButton.ariaNotify = (message) => notifications.push(message);
  await popup.elements.signInForm.dispatch('submit');
  await tick();

  assert.equal(popup.elements.statusMessage.textContent, makeTestI18n().t('enterCredentials'));
  assert.match(popup.elements.statusMessage.className, /error/);
  assert.deepEqual(notifications, [makeTestI18n().t('enterCredentials')]);
  assert.equal(loginCalls, 0);
  assert.equal(popup.elements.signInButton.disabled, false);
  assert.equal(popup.elements.signInButton.focusCount, 0);
});

test('toolbar popup notifies on rejected credentials, including repeated failures, not progress', async () => {
  let loginCalls = 0;
  const popup = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') {
      loginCalls += 1;
      return { ok: false, error: 'Invalid identifier or password.' };
    }
    return { ok: true };
  });
  await tick();
  const notifications = [];
  popup.elements.signInButton.ariaNotify = (message) => notifications.push(message);
  popup.elements.handleInput.value = 'me.test';
  popup.elements.passwordInput.value = 'bad-password';

  await popup.elements.signInForm.dispatch('submit');
  await tick();
  await popup.elements.signInForm.dispatch('submit');
  await tick();

  assert.equal(loginCalls, 2);
  assert.equal(popup.elements.statusMessage.textContent, 'Invalid identifier or password.');
  assert.deepEqual(notifications, ['Invalid identifier or password.', 'Invalid identifier or password.']);
  assert.equal(popup.elements.signInButton.disabled, false);
  assert.equal(popup.elements.signInButton.focusCount, 0);
});


test('toolbar login excludes obsolete remembered-session flags and UI', async () => {
  const seen = [];
  const popup = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') {
      seen.push(message);
      return { ok: false, error: 'bad login' };
    }
    return { ok: true };
  });
  await tick();
  popup.elements.handleInput.value = 'new.test';
  popup.elements.passwordInput.value = 'pw';
  await popup.elements.signInForm.dispatch('submit');
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(Object.hasOwn(seen[0], 'rememberSession'), false);
  assert.doesNotMatch(readProjectFile('popup.html'), /rememberSessionInput|rememberTestSignIn|rememberedStatus/);
  assert.doesNotMatch(readProjectFile('popup.js'), /rememberSessionInput|rememberedStatus/);
});

test('experimental successful login makes account identity the focus-time description of New post', async () => {
  const popup = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') return { ok: true, session: { did: 'did:plc:me', handle: 'me.test' } };
    return { ok: true };
  });
  await tick();
  const onFocus = [];
  const button = popup.elements.openButton;
  button.focus = () => {
    button.focusCount += 1;
    onFocus.push({
      description: button.getAttribute('aria-describedby'),
      account: popup.elements.accountStatus.textContent,
      formWasVisible: !popup.elements.signInForm.hidden,
      buttonWasVisible: !button.hidden,
    });
  };
  popup.elements.handleInput.value = 'me.test';
  popup.elements.passwordInput.value = 'pw';
  await popup.elements.signInForm.dispatch('submit');
  await tick();
  const expected = makeTestI18n().t('signedInAs', ['\u2068me.test\u2069']);
  assert.deepEqual(onFocus, [{
    description: 'accountStatus', account: expected,
    formWasVisible: true, buttonWasVisible: true,
  }]);
  assert.equal(popup.elements.accountStatus.textContent, expected);
  assert.equal(popup.elements.signInForm.hidden, true);
  assert.equal(popup.elements.openButton.getAttribute('aria-describedby'), 'accountStatus');
  assert.equal(popup.elements.statusMessage.textContent, '');
});

test('experimental account description is not present on restored-session startup or failed login', async () => {
  const restored = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: { did: 'did:plc:me', handle: 'me.test' } };
    return { ok: true };
  });
  await tick();
  assert.equal(restored.elements.openButton.getAttribute('aria-describedby'), null);
  const failed = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: null };
    if (message.type === 'login') return { ok: false, error: 'Bad password' };
    return { ok: true };
  });
  await tick();
  failed.elements.handleInput.value = 'me.test';
  failed.elements.passwordInput.value = 'bad';
  await failed.elements.signInForm.dispatch('submit');
  await tick();
  assert.equal(failed.elements.openButton.getAttribute('aria-describedby'), null);
  assert.equal(failed.elements.statusMessage.textContent, 'Bad password');
});

test('successful sign out clears the temporary New post account description', async () => {
  let loggedIn = false;
  const popup = loadPopup(new Map(), async (message) => {
    if (message.type === 'getSession') return { ok: true, session: loggedIn ? { did: 'did:plc:me', handle: 'me.test' } : null };
    if (message.type === 'login') { loggedIn = true; return { ok: true, session: { did: 'did:plc:me', handle: 'me.test' } }; }
    if (message.type === 'logout') { loggedIn = false; return { ok: true }; }
    return { ok: true };
  });
  await tick();
  popup.elements.handleInput.value = 'me.test';
  popup.elements.passwordInput.value = 'pw';
  await popup.elements.signInForm.dispatch('submit');
  await tick();
  assert.equal(popup.elements.openButton.getAttribute('aria-describedby'), 'accountStatus');
  await popup.elements.signOutButton.dispatch('click');
  await tick();
  assert.equal(popup.elements.openButton.getAttribute('aria-describedby'), null);
  assert.equal(popup.elements.handleInput.focusCount, 1);
});
