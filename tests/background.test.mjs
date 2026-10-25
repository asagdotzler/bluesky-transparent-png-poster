import test from 'node:test';
import assert from 'node:assert/strict';
import { deferred, makeTestI18n, readProjectFile, response, runScript } from './helpers.mjs';

function loadBackground({ fetchImpl, storedSession = null, rememberedStorage = new Map(), sendMessageImpl, createImpl, queryImpl } = {}) {
  const storage = new Map();
  const localStorage = rememberedStorage;
  if (storedSession) storage.set('bskySession', storedSession);
  let listener;
  const tabCalls = { create: [], send: [], query: [] };

  const browser = {
    storage: {
      local: {
        // Real Firefox has no storage.local.setAccessLevel method.
        async get(key) { return { [key]: localStorage.get(key) }; },
        async set(values) { for (const [key, value] of Object.entries(values)) localStorage.set(key, value); },
        async remove(key) { localStorage.delete(key); },
      },
      session: {
        async get(key) { return { [key]: storage.get(key) }; },
        async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
        async remove(key) { storage.delete(key); },
      },
    },
    tabs: {
      async query(query) { tabCalls.query.push(query); return queryImpl ? queryImpl(query) : []; },
      async create(options) {
        tabCalls.create.push(options);
        return createImpl ? createImpl(options) : { id: 91, ...options };
      },
      async sendMessage(tabId, message, options) {
        tabCalls.send.push({ tabId, message, options });
        if (sendMessageImpl) return sendMessageImpl(tabId, message, tabCalls.send.length);
        return { ok: true };
      },
    },
    runtime: {
      getURL(path) { return `moz-extension://our-id/${path}`; },
      onMessage: {
        addListener(fn) { listener = fn; },
      },
    },
  };

  const context = runScript(readProjectFile('background.js'), {
    TpngI18n: makeTestI18n(),
    browser,
    fetch: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    AbortSignal,
    // Make launch retry delays deterministic and fast in the harness.
    setTimeout(fn) { fn(); return 1; },
    clearTimeout() {},
  }, 'background.js');

  // Legacy successful-publisher fixtures assume the web account matches the
  // stored extension session. Explicit expectedDid overrides test fail-closed.
  const verifiedListener = (message, sender) => {
    // Existing functional fixtures originate in the popup or panel; supply
    // their real Firefox sender metadata unless testing a specific sender.
    const panelTypes = ['uploadPng', 'checkPostMentions', 'createImagePost'];
    const effectiveSender = sender === undefined &&
      panelTypes.includes(message?.type)
      ? { url: 'moz-extension://our-id/panel.html' }
      : sender === undefined &&
        ['getSession', 'login', 'logout', 'launchFreshComposerPanel'].includes(message?.type)
        ? { url: 'moz-extension://our-id/popup.html' }
        : sender;
    return listener(
      ['createImagePost', 'uploadPng'].includes(message?.type) &&
        !Object.hasOwn(message, 'expectedDid')
        ? { ...message, expectedDid: storage.get('bskySession')?.did || storedSession?.did || 'did:plc:me' }
        : message,
      effectiveSender,
    );
  };
  return { listener: verifiedListener, storage, localStorage, tabCalls, context };
}


test('PNG upload refuses an absent or wrong expected DID before transmitting bytes', async () => {
  const storedSession = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'a', refreshJwt: 'r' };
  let uploads = 0;
  const { listener } = loadBackground({
    storedSession,
    fetchImpl: async () => { uploads += 1; return response(200, { blob: { ref: 'safe' } }); },
  });
  const bytes = new ArrayBuffer(32);
  for (const expectedDid of [undefined, null, '', 'did:plc:someone-else']) {
    const result = await listener({ type: 'uploadPng', bytes, expectedDid });
    assert.equal(result.ok, false);
  }
  assert.equal(uploads, 0, 'no upload should occur for absent or mismatched account');
  const success = await listener({ type: 'uploadPng', bytes, expectedDid: storedSession.did });
  assert.equal(success.ok, true);
  assert.equal(uploads, 1);
});

test('unchecked development remember box keeps only session-memory tokens and does not retain app password', async () => {
  const session = { did: 'did:plc:alice', handle: 'alice.test', accessJwt: 'access', refreshJwt: 'refresh' };
  const { listener, storage, localStorage } = loadBackground({
    fetchImpl: async (url) => { assert.match(url, /createSession$/); return response(200, session); },
  });
  const reply = await listener({ type: 'login', identifier: 'alice.test', password: 'app-secret' });
  assert.equal(reply.ok, true);
  assert.equal(storage.get('bskySession').did, session.did);
  assert.equal(localStorage.size, 0, 'opt-in must be explicit');
  assert.equal(JSON.stringify([...storage, ...localStorage]).includes('app-secret'), false);
});

test('new logins store only required tokens and identity in memory, not profile metadata', async () => {
  const session = {
    did: 'did:plc:minimized', handle: 'minimized.test',
    accessJwt: 'access-secret', refreshJwt: 'refresh-secret',
    email: 'should-not-save@example.org', emailConfirmed: true,
    active: true, status: 'takendown',
  };
  const { listener, storage, localStorage, tabCalls } = loadBackground({
    fetchImpl: async () => response(200, session),
    queryImpl: async () => [{ id: 55 }],
  });
  const reply = await listener({ type: 'login', identifier: session.handle, password: 'app-secret' });
  assert.equal(reply.ok, true, reply.error);
  const stored = storage.get('bskySession');
  assert.deepEqual(Object.keys(stored).sort(), ['accessJwt', 'did', 'handle', 'refreshJwt']);
  assert.equal(stored.accessJwt, 'access-secret');
  assert.equal(stored.refreshJwt, 'refresh-secret');
  assert.equal(localStorage.size, 0, 'ordinary sign-in never writes to disk');
  assert.deepEqual({ ...reply.session }, { did: session.did, handle: session.handle });
  assert.deepEqual({ ...tabCalls.send[0].message.session }, { ...reply.session });
  assert.equal(JSON.stringify([...storage, ...localStorage, ...tabCalls.send]).includes('should-not-save@example.org'), false);
  assert.equal(JSON.stringify([...storage, ...localStorage, ...tabCalls.send]).includes('app-secret'), false);
});

test('old developer persistent credentials are deleted at startup and never restored', async () => {
  const legacy = { did: 'did:plc:old', handle: 'old.test', accessJwt: 'old-access', refreshJwt: 'old-refresh' };
  const disk = new Map([['rememberedBskySession', legacy], ['unrelatedPreference', 'keep']]);
  const instance = loadBackground({ rememberedStorage: disk });
  assert.equal((await instance.listener({ type: 'getSession' })).session, null);
  assert.equal(disk.has('rememberedBskySession'), false);
  assert.equal(disk.get('unrelatedPreference'), 'keep');
  assert.equal(instance.storage.size, 0);
});

test('migration preserves an active memory session and clears only old disk authentication', async () => {
  const active = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'a', refreshJwt: 'r' };
  const disk = new Map([['rememberedBskySession', active]]);
  const instance = loadBackground({ rememberedStorage: disk, storedSession: active });
  const result = await instance.listener({ type: 'getSession' });
  assert.equal(result.ok, true);
  assert.equal(result.session.did, active.did);
  assert.equal(Object.hasOwn(result, 'remembered'), false);
  assert.equal(instance.storage.get('bskySession').accessJwt, 'a');
  assert.equal(disk.size, 0);
});

test('login uses session storage only, even if an old caller sends rememberSession', async () => {
  const session = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'a', refreshJwt: 'r', email: 'not-saved@example.org' };
  const disk = new Map();
  const instance = loadBackground({ rememberedStorage: disk, fetchImpl: async () => response(200, session) });
  const login = await instance.listener({ type: 'login', identifier: 'me.test', password: 'pw', rememberSession: true });
  assert.equal(login.ok, true);
  assert.equal(disk.size, 0);
  assert.deepEqual(Object.keys(instance.storage.get('bskySession')).sort(), ['accessJwt', 'did', 'handle', 'refreshJwt']);
  assert.equal((await instance.listener({ type: 'getSession' })).session.did, session.did);
  const afterReload = loadBackground({ rememberedStorage: disk });
  assert.equal((await afterReload.listener({ type: 'getSession' })).session, null);
});

test('refresh rotation remains memory-only, and sign-out clears the active session', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old-access', refreshJwt: 'old-refresh' };
  const next = { ...initial, accessJwt: 'new-access', refreshJwt: 'new-refresh', email: 'private@example.org' };
  const disk = new Map();
  let uploads = 0;
  const instance = loadBackground({ rememberedStorage: disk, storedSession: initial, fetchImpl: async (url) => {
    if (url.endsWith('.uploadBlob')) {
      uploads++;
      return uploads === 1 ? response(400, { error: 'ExpiredToken' }) : response(200, { blob: { ref: 'good' } });
    }
    if (url.endsWith('.refreshSession')) return response(200, next);
    throw new Error('unexpected URL ' + url);
  } });
  assert.equal((await instance.listener({ type: 'uploadPng', bytes: new ArrayBuffer(25) })).ok, true);
  assert.equal(uploads, 2);
  assert.equal(disk.size, 0);
  assert.equal(instance.storage.get('bskySession').refreshJwt, 'new-refresh');
  assert.equal(JSON.stringify([...instance.storage]).includes('private@example.org'), false);
  assert.equal((await instance.listener({ type: 'logout' })).ok, true);
  assert.equal(instance.storage.size, 0);
  assert.equal(disk.size, 0);
});

test('known 401 login failure is translated to plain language', async () => {
  const { listener } = loadBackground({
    fetchImpl: async () => response(401, { message: 'Invalid identifier or password' }),
  });

  const result = await listener({ type: 'login', identifier: 'me.test', password: 'bad' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Check your Bluesky handle and app password, then try again.');
});

test('server sign-in failures offer a retry message rather than an HTTP status', async () => {
  const { listener } = loadBackground({
    fetchImpl: async () => response(503, { message: 'Service unavailable' }),
  });

  const result = await listener({ type: 'login', identifier: 'me.test', password: 'pw' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Bluesky sign-in is temporarily unavailable. Try again later.');
});

test('rate-limited sign-in returns an actionable waiting message', async () => {
  const { listener } = loadBackground({
    fetchImpl: async () => response(429, { error: 'RateLimitExceeded', message: 'Rate Limit Exceeded' }),
  });
  const result = await listener({ type: 'login', identifier: 'me.test', password: 'bad' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Too many sign-in attempts. Wait a while before trying again.');
});

test('network sign-in failures are not mistaken for rejected credentials', async () => {
  const { listener } = loadBackground({
    fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  const result = await listener({ type: 'login', identifier: 'me.test', password: 'pw' });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Couldn't connect to Bluesky. Check your connection and try again.");
});

test('unrecognized sign-in failures retain diagnostic detail', async () => {
  const { listener } = loadBackground({
    fetchImpl: async () => response(403, { message: 'Account suspended' }),
  });
  const result = await listener({ type: 'login', identifier: 'me.test', password: 'pw' });
  assert.equal(result.ok, false);
  assert.equal(result.error, '403: Account suspended');
});

test('failed replacement authentication leaves old stored account intact until a successful login', async () => {
  const oldSession = { did: 'did:plc:bob', handle: 'bob.bsky.social', accessJwt: 'old', refreshJwt: 'old-refresh' };
  const newer = { did: 'did:plc:alice', handle: 'alice.bsky.social', accessJwt: 'new', refreshJwt: 'new-refresh' };
  let valid = false;
  const { listener, storage, tabCalls } = loadBackground({
    storedSession: oldSession,
    fetchImpl: async (url) => {
      assert.match(url, /createSession$/);
      return valid ? response(200, newer) : response(401, { error: 'AuthenticationRequired' });
    },
  });
  assert.equal(storage.get('bskySession'), oldSession);
  const failed = await listener({ type: 'login', identifier: 'alice.bsky.social', password: 'wrong' });
  assert.equal(failed.ok, false);
  assert.equal(storage.get('bskySession'), oldSession, 'failed login never clears or overwrites old credentials');
  assert.equal(tabCalls.send.length, 0, 'failed login does not broadcast a session change');
  valid = true;
  const success = await listener({ type: 'login', identifier: 'alice.bsky.social', password: 'valid' });
  assert.equal(success.ok, true);
  assert.equal(storage.get('bskySession').did, newer.did);
});

test('400 ExpiredToken during upload refreshes session once and retries with new access token', async () => {
  const calls = [];
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old-access', refreshJwt: 'refresh' };
  const refreshed = { ...initial, accessJwt: 'new-access', refreshJwt: 'new-refresh' };

  const { listener, storage } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('.uploadBlob') && calls.filter((call) => call.url.endsWith('.uploadBlob')).length === 1) {
        return response(400, { error: 'ExpiredToken', message: 'Token has expired' });
      }
      if (url.endsWith('.refreshSession')) return response(200, refreshed);
      if (url.endsWith('.uploadBlob')) return response(200, { blob: { ref: 'blob-1' } });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const bytes = new ArrayBuffer(16);
  const result = await listener({ type: 'uploadPng', bytes });
  assert.equal(result.ok, true);
  assert.equal(result.blob.ref, 'blob-1');
  assert.equal(storage.get('bskySession').accessJwt, 'new-access');

  const uploads = calls.filter((call) => call.url.endsWith('.uploadBlob'));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].options.headers.Authorization, 'Bearer old-access');
  assert.equal(uploads[1].options.headers.Authorization, 'Bearer new-access');
});

test('real PDS 400 ExpiredToken during upload refreshes and retries exactly once', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old-access', refreshJwt: 'old-refresh' };
  const refreshed = { ...initial, accessJwt: 'new-access', refreshJwt: 'new-refresh' };
  const requests = [];
  const { listener, storage } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url, options) => {
      requests.push({ url, auth: options.headers.Authorization });
      if (url.endsWith('.refreshSession')) return response(200, refreshed);
      if (url.endsWith('.uploadBlob')) {
        return requests.filter(r => r.url.endsWith('.uploadBlob')).length === 1
          ? response(400, { error: 'ExpiredToken', message: 'Token has expired' })
          : response(200, { blob: { ref: 'success' } });
      }
      throw new Error(`unexpected endpoint ${url}`);
    },
  });
  const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(40) });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.blob.ref, 'success');
  assert.deepEqual(requests.map(r => [r.url.split('.').pop(), r.auth]), [
    ['uploadBlob', 'Bearer old-access'],
    ['refreshSession', 'Bearer old-refresh'],
    ['uploadBlob', 'Bearer new-access'],
  ]);
  assert.equal(storage.get('bskySession').refreshJwt, 'new-refresh');
});

test('400 ExpiredToken on createRecord retries only after refresh and creates one post', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old-access', refreshJwt: 'refresh' };
  const calls = [];
  const images = [{ blob: { ref: 'png' }, alt: 'PNG alt', aspectRatio: { width: 5, height: 5 } }];
  const { listener } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url, options) => {
      const operation = url.split('.').pop();
      calls.push({ operation, auth: options.headers.Authorization, body: options.body });
      if (operation === 'refreshSession') return response(200, { ...initial, accessJwt: 'new-access' });
      if (operation === 'createRecord') {
        return calls.filter(c => c.operation === 'createRecord').length === 1
          ? response(400, { error: 'ExpiredToken', message: 'Token has expired' })
          : response(200, { uri: 'at://did:plc:me/app.bsky.feed.post/onlypost', cid: 'cid' });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const result = await listener({ type: 'createImagePost', text: 'post text', images, languages: [] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.post.uri, 'at://did:plc:me/app.bsky.feed.post/onlypost');
  const creates = calls.filter(c => c.operation === 'createRecord');
  assert.equal(creates.length, 2, 'one rejected request, one accepted request');
  assert.equal(creates[0].body, creates[1].body, 'retry preserves the exact post record');
  assert.deepEqual(creates.map(c => c.auth), ['Bearer old-access', 'Bearer new-access']);
  assert.equal(calls.filter(c => c.operation === 'refreshSession').length, 1);
});

for (const invalid of ['ExpiredToken', 'InvalidToken']) {
  test(`refresh token ${invalid} rejection signs out and asks for sign-in without posting`, async () => {
    const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old-access', refreshJwt: 'revoked' };
    const calls = [];
    const { listener, storage, tabCalls } = loadBackground({
      storedSession: initial,
      queryImpl: async () => [{ id: 9 }],
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith('.refreshSession')) return response(400, { error: invalid, message: 'Token has been revoked' });
        if (url.endsWith('.uploadBlob')) return response(400, { error: 'ExpiredToken', message: 'Token has expired' });
        throw new Error(`unexpected ${url}`);
      },
    });
    const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(24) });
    assert.equal(result.ok, false);
    assert.match(result.error, /Sign in again/);
    assert.equal(storage.has('bskySession'), false);
    assert.equal(calls.filter(url => url.endsWith('.uploadBlob')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('.refreshSession')).length, 1);
    assert.equal((await listener({ type: 'getSession' })).session, null);
    assert.equal(JSON.stringify(tabCalls.send), JSON.stringify([{ tabId: 9, message: { type: 'sessionChanged', session: null } }]));
  });
}

test('transient refresh network failure retains session for later retry', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old', refreshJwt: 'refresh' };
  const urls = [];
  const { listener, storage } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('.refreshSession')) throw new TypeError('Network offline');
      return response(400, { error: 'ExpiredToken' });
    },
  });
  const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(24) });
  assert.equal(result.ok, false);
  assert.match(result.error, /Network offline/);
  assert.equal(storage.get('bskySession').refreshJwt, initial.refreshJwt);
  assert.deepEqual(urls.map(u => u.split('.').pop()), ['uploadBlob', 'refreshSession']);
});

test('unrelated 400 InvalidRequest does not refresh or change session', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'access', refreshJwt: 'refresh' };
  const urls = [];
  const { listener, storage } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url) => {
      urls.push(url);
      return response(400, { error: 'InvalidRequest', message: 'Bad record' });
    },
  });
  const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(24) });
  assert.equal(result.ok, false);
  assert.match(result.error, /Bad record/);
  assert.equal(storage.get('bskySession').accessJwt, 'access');
  assert.equal(urls.length, 1);
});

test('an expired-token response on the retry is not refreshed repeatedly', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old', refreshJwt: 'refresh' };
  const urls = [];
  const { listener } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('.refreshSession')) return response(200, { ...initial, accessJwt: 'new' });
      return response(400, { error: 'ExpiredToken', message: 'Token has expired' });
    },
  });
  const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(24) });
  assert.equal(result.ok, false);
  assert.equal(urls.filter(u => u.endsWith('.refreshSession')).length, 1);
  assert.equal(urls.filter(u => u.endsWith('.uploadBlob')).length, 2);
});

test('simultaneous expired uploads share one refresh and both use its new token', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old', refreshJwt: 'refresh' };
  const refreshGate = deferred();
  const seen = [];
  const { listener, storage } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url, options) => {
      const operation = url.split('.').pop();
      seen.push([operation, options.headers.Authorization]);
      if (operation === 'refreshSession') return refreshGate.promise;
      if (operation === 'uploadBlob') {
        return options.headers.Authorization === 'Bearer old'
          ? response(400, { error: 'ExpiredToken' })
          : response(200, { blob: { ref: 'new-blob' } });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const first = listener({ type: 'uploadPng', bytes: new ArrayBuffer(24) });
  const second = listener({ type: 'uploadPng', bytes: new ArrayBuffer(24) });
  // Both have reached refresh before allowing the refresh response through.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.filter(([op]) => op === 'refreshSession').length, 1);
  refreshGate.resolve(response(200, { ...initial, accessJwt: 'new', refreshJwt: 'new-refresh' }));
  const results = await Promise.all([first, second]);
  assert.ok(results.every(r => r.ok && r.blob.ref === 'new-blob'));
  assert.equal(seen.filter(([op]) => op === 'refreshSession').length, 1);
  assert.equal(storage.get('bskySession').refreshJwt, 'new-refresh');
});

test('createImagePost preserves native composer languages plus image order and alt text', async () => {
  const requests = [];
  const session = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'access', refreshJwt: 'refresh' };
  const { listener } = loadBackground({
    storedSession: session,
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('.createRecord')) {
        return response(200, { uri: 'at://did:plc:me/app.bsky.feed.post/abc123', cid: 'cid' });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const images = [
    { blob: { ref: 'a' }, alt: '  first  ', aspectRatio: { width: 100, height: 50 } },
    { blob: { ref: 'b' }, alt: 'second', aspectRatio: { width: 80, height: 120 } },
  ];

  const result = await listener({ type: 'createImagePost', text: 'hello', languages: ['bg', 'br'], images });
  assert.equal(result.ok, true);
  assert.equal(result.post.postUrl, 'https://bsky.app/profile/me.test/post/abc123');

  const body = JSON.parse(requests.at(-1).options.body);
  assert.deepEqual(body.record.langs, ['bg', 'br']);
  assert.deepEqual(body.record.embed.images.map((image) => image.alt), ['first', 'second']);
  assert.deepEqual(body.record.embed.images.map((image) => image.image.ref), ['a', 'b']);
  assert.deepEqual(
    body.record.embed.images.map((image) => ({ width: image.aspectRatio.width, height: image.aspectRatio.height })),
    [{ width: 100, height: 50 }, { width: 80, height: 120 }],
  );

  requests.length = 0;
  await listener({ type: 'createImagePost', text: '', languages: ['en'], images: [images[0]] });
  const imageOnly = JSON.parse(requests.at(-1).options.body);
  assert.equal('langs' in imageOnly.record, false);

  requests.length = 0;
  await listener({ type: 'createImagePost', text: 'unresolved', languages: [], images: [images[0]] });
  const unresolved = JSON.parse(requests.at(-1).options.body);
  assert.equal('langs' in unresolved.record, false, 'unresolved language metadata is omitted rather than guessed');
});


// Capture the actual createRecord payload rather than testing the parser in
// isolation: facets must survive the established image-post publishing path.
function linkPostHarness() {
  const requests = [];
  const images = [{ blob: { ref: 'png' }, alt: 'Accessible PNG', aspectRatio: { width: 64, height: 32 } }];
  const { listener } = loadBackground({
    storedSession: { did: 'did:plc:me', handle: 'me.test', accessJwt: 'access', refreshJwt: 'refresh' },
    fetchImpl: async (url, options = {}) => {
      assert.ok(url.endsWith('.createRecord'), `unexpected network call: ${url}`);
      requests.push(JSON.parse(options.body));
      return response(200, { uri: 'at://did:plc:me/app.bsky.feed.post/abc123', cid: 'cid' });
    },
  });
  return {
    async post(text) {
      const result = await listener({ type: 'createImagePost', text, languages: ['en'], images });
      assert.equal(result.ok, true, result.error);
      return requests.at(-1).record;
    },
  };
}

test('link facets preserve the exact post text and attach correct HTTPS/HTTP link spans', async () => {
  const { post } = linkPostHarness();
  const text = 'Read https://example.com/a?x=1&y=2, then http://docs.example.org/manual.';
  const record = await post(text);
  assert.equal(record.text, text);
  assert.equal(record.embed.$type, 'app.bsky.embed.images');
  assert.equal(record.facets.length, 2);
  const expected = [
    ['https://example.com/a?x=1&y=2', 'https://example.com/a?x=1&y=2'],
    ['http://docs.example.org/manual', 'http://docs.example.org/manual'],
  ];
  for (const [index, facet] of record.facets.entries()) {
    const { byteStart, byteEnd } = facet.index;
    const match = Buffer.from(text, 'utf8').subarray(byteStart, byteEnd).toString('utf8');
    assert.equal(match, expected[index][0]);
    assert.deepEqual(facet.features, [{ $type: 'app.bsky.richtext.facet#link', uri: expected[index][1] }]);
  }
});

test('facet indices count UTF-8 bytes through emoji, accents, line breaks, and balanced parentheses', async () => {
  const { post } = linkPostHarness();
  const prefix = '👨‍👩‍👧‍👦 Bonjour 🌿\n';
  const url = 'https://example.com/wiki/Some_(article)';
  const text = `${prefix}(${url}).`;
  const record = await post(text);
  assert.equal(record.facets.length, 1);
  assert.equal(record.facets[0].index.byteStart, Buffer.byteLength(prefix + '(', 'utf8'));
  assert.equal(record.facets[0].index.byteEnd, Buffer.byteLength(prefix + '(' + url, 'utf8'));
  assert.equal(record.facets[0].features[0].uri, url);
});

test('link URLs are URI-normalized but the original Unicode post text and byte ranges remain intact', async () => {
  const { post } = linkPostHarness();
  const text = 'See https://münchen.example/straße!';
  const record = await post(text);
  assert.equal(record.text, text);
  assert.equal(record.facets[0].features[0].uri, 'https://xn--mnchen-3ya.example/stra%C3%9Fe');
  const { byteStart, byteEnd } = record.facets[0].index;
  assert.equal(Buffer.from(text).subarray(byteStart, byteEnd).toString(), 'https://münchen.example/straße');
});

test('invalid URLs and incomplete mentions remain plain text without speculative facets', async () => {
  const { post } = linkPostHarness();
  for (const text of [
    '',
    'Text @nodot and a lone #',
    'See example.com or ftp://example.com',
    'Bad https://not-a-domain and broken https://example.com:bad',
    'prefixhttps://example.com should not become a link',
  ]) {
    const record = await post(text);
    assert.equal(record.text, text);
    assert.equal('facets' in record, false, `unexpected facets for ${text}`);
  }
});

test('hashtag facets preserve original text and Unicode UTF-8 byte boundaries', async () => {
  const { post } = linkPostHarness();
  const tags = ['PNGTest', 'cafe\u0301', '東京', 'مرحبا'];
  const text = `🌿 Hi 👩🏽‍💻\n#${tags[0]}, #${tags[1]} #${tags[2]} #${tags[3]}.`;
  const record = await post(text);
  assert.equal(record.text, text);
  assert.equal(record.facets.length, tags.length);
  assert.equal(record.embed.images[0].alt, 'Accessible PNG');
  for (const [i, facet] of record.facets.entries()) {
    assert.deepEqual(facet.features, [{ $type: 'app.bsky.richtext.facet#tag', tag: tags[i] }]);
    const { byteStart, byteEnd } = facet.index;
    assert.equal(Buffer.from(text).subarray(byteStart, byteEnd).toString(), `#${tags[i]}`);
  }
});

test('number-only hashtags stay plain text across ASCII and Unicode numeric scripts', async () => {
  const { post } = linkPostHarness();
  for (const text of [
    'Score #1 today',
    '#123 #0 #007',
    'Unicode #٣٥ #१२३ #１２３ #𝟙𝟚',
    'Other numbers #² #Ⅳ #⑦',
  ]) {
    const record = await post(text);
    assert.equal(record.text, text);
    assert.equal('facets' in record, false, `numeric-only hashtags must not link: ${text}`);
    assert.equal(record.embed.images[0].alt, 'Accessible PNG');
  }
});

test('mixed hashtags remain clickable after skipped numeric tags with correct Unicode UTF-8 offsets', async () => {
  const { post } = linkPostHarness();
  const text = '🌿 Score #1 and #１２３: #1st #R2D2 #٣أ #A３ #3_4 https://example.com/#99';
  const record = await post(text);
  assert.equal(record.text, text);
  const tagFacets = record.facets.filter(facet => facet.features[0].$type === 'app.bsky.richtext.facet#tag');
  assert.deepEqual(tagFacets.map(facet => facet.features[0].tag), ['1st', 'R2D2', '٣أ', 'A３', '3_4']);
  for (const facet of tagFacets) {
    const { byteStart, byteEnd } = facet.index;
    assert.equal(Buffer.from(text).subarray(byteStart, byteEnd).toString('utf8'),
      '#' + facet.features[0].tag);
  }
  const links = record.facets.filter(facet => facet.features[0].$type === 'app.bsky.richtext.facet#link');
  assert.deepEqual(links.map(facet => facet.features[0].uri), ['https://example.com/#99']);
  assert.ok(record.facets.every((facet, i) => i === 0 ||
    record.facets[i - 1].index.byteEnd <= facet.index.byteStart), 'facets remain sorted and disjoint');
});

test('link and hashtag facets share one sorted, nonoverlapping array; URL fragments are not tags', async () => {
  const { post } = linkPostHarness();
  const text = '#First 🌿 https://example.com/#fragment, then #Second and https://bsky.app/path.';
  const record = await post(text);
  assert.equal(record.facets.length, 4);
  assert.deepEqual(record.facets.map(f => f.features[0].$type), [
    'app.bsky.richtext.facet#tag', 'app.bsky.richtext.facet#link',
    'app.bsky.richtext.facet#tag', 'app.bsky.richtext.facet#link',
  ]);
  assert.deepEqual(record.facets.filter(f => f.features[0].tag).map(f => f.features[0].tag), ['First', 'Second']);
  assert.deepEqual(record.facets.filter(f => f.features[0].uri).map(f => f.features[0].uri),
    ['https://example.com/#fragment', 'https://bsky.app/path']);
  for (const [i, f] of record.facets.entries()) {
    const segment = Buffer.from(text).subarray(f.index.byteStart, f.index.byteEnd).toString('utf8');
    assert.ok(segment.startsWith('#') || segment.startsWith('https://'));
    if (i) assert.ok(record.facets[i - 1].index.byteEnd <= f.index.byteStart, 'facets must not overlap');
  }
});

test('hashtag detection respects word boundaries and leaves unsupported sequences unannotated', async () => {
  const { post } = linkPostHarness();
  const record = await post('before#joined ##double #Solo x_#attached @user#attached #');
  assert.deepEqual(record.facets.map(f => f.features[0].tag), ['Solo']);
  const imageOnly = await post('');
  assert.equal('facets' in imageOnly, false);
});

test('oversize hashtag tokens are ignored rather than truncated; 64 graphemes remain valid', async () => {
  const { post } = linkPostHarness();
  const sixtyFour = 'a'.repeat(64);
  const sixtyFive = 'b'.repeat(65);
  const sixtyFourCombined = 'e\u0301'.repeat(64);
  const record = await post(`#${sixtyFive} #${sixtyFour} #${sixtyFourCombined}`);
  assert.deepEqual(record.facets.map(f => f.features[0].tag), [sixtyFour, sixtyFourCombined]);
  const all = Buffer.from(record.text);
  for (const facet of record.facets) {
    assert.equal(all.subarray(facet.index.byteStart, facet.index.byteEnd).toString(), '#'+facet.features[0].tag);
  }
});

test('trailing unmatched delimiters are excluded without stripping paired parentheses', async () => {
  const { post } = linkPostHarness();
  const record = await post('See (https://example.com/a(b)), [https://example.org/path].');
  assert.deepEqual(record.facets.map(f => f.features[0].uri),
    ['https://example.com/a(b)', 'https://example.org/path']);
  for (const facet of record.facets) {
    const slice = Buffer.from(record.text).subarray(facet.index.byteStart, facet.index.byteEnd).toString();
    assert.equal(slice, facet.features[0].uri);
  }
});


// Inspect real createRecord payloads after resolving mention handles. All mock
// lookups remain local to the Node harness; no account/network access is used.
function mentionPostHarness(resolve = {}) {
  const calls = [];
  const records = [];
  const images = [{ blob: { ref: 'png' }, alt: 'PNG alt', aspectRatio: { width: 20, height: 30 } }];
  const { listener } = loadBackground({
    storedSession: { did: 'did:plc:me', handle: 'me.test', accessJwt: 'access', refreshJwt: 'refresh' },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('.resolveHandle')) {
        assert.equal(options.method, undefined, 'resolution is unauthenticated GET');
        assert.equal(options.headers, undefined, 'never send token with resolution');
        const handle = parsed.searchParams.get('handle');
        calls.push(handle);
        const result = resolve[handle];
        if (result === 'offline') throw new TypeError('Network error');
        if (typeof result === 'number') return response(result, { error: 'HandleNotFound' });
        return response(200, result ? { did: result } : { did: null });
      }
      assert.ok(parsed.pathname.endsWith('.createRecord'), `unexpected request ${url}`);
      records.push(JSON.parse(options.body).record);
      return response(200, { uri: 'at://did:plc:me/app.bsky.feed.post/abc123', cid: 'cid' });
    },
  });
  return {
    calls,
    records,
    listener, images,
    async post(text, approvedUnresolvedHandles = []) {
      const result = await listener({
        type: 'createImagePost', text, images, languages: ['en'], approvedUnresolvedHandles,
      });
      assert.equal(result.ok, true, result.error);
      return records.at(-1);
    },
  };
}

test('resolved mentions annotate unchanged text with DID and UTF-8 byte spans', async () => {
  const did = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
  const { post, calls } = mentionPostHarness({ 'atproto.com': did });
  const text = '👩🏽‍💻 Café — hello @atproto.com, then #PNG and https://example.com/#part.';
  const record = await post(text);
  assert.equal(record.text, text);
  assert.deepEqual(calls, ['atproto.com']);
  assert.deepEqual(record.facets.map(f => f.features[0].$type), [
    'app.bsky.richtext.facet#mention',
    'app.bsky.richtext.facet#tag',
    'app.bsky.richtext.facet#link',
  ]);
  const mention = record.facets[0];
  assert.deepEqual(mention.features, [{ $type: 'app.bsky.richtext.facet#mention', did }]);
  assert.equal(mention.index.byteStart, Buffer.byteLength('👩🏽‍💻 Café — hello ', 'utf8'));
  const sliced = Buffer.from(text).subarray(mention.index.byteStart, mention.index.byteEnd).toString();
  assert.equal(sliced, '@atproto.com');
  assert.deepEqual(record.embed.images[0].image.ref, 'png');
});

test('multiple mentions are sorted with other facets and repeated handles are resolved once', async () => {
  const alice = 'did:plc:aliceabcdefghijklmnopqrs';
  const bob = 'did:plc:bobabcdefghijklmnopqrstuv';
  const { post, calls } = mentionPostHarness({ 'alice.bsky.social': alice, 'bob.example.com': bob });
  const text = '@Alice.Bsky.Social + @bob.example.com (#Topic) @alice.bsky.social https://example.com/@bob.example.com';
  const record = await post(text);
  assert.deepEqual(calls.sort(), ['alice.bsky.social', 'bob.example.com']);
  assert.deepEqual(record.facets.map(f => f.features[0].$type), [
    'app.bsky.richtext.facet#mention', 'app.bsky.richtext.facet#mention',
    'app.bsky.richtext.facet#tag', 'app.bsky.richtext.facet#mention',
    'app.bsky.richtext.facet#link',
  ]);
  assert.deepEqual(record.facets.filter(f=>f.features[0].did).map(f=>f.features[0].did), [alice,bob,alice]);
  for (let i=1; i<record.facets.length; i++) {
    assert.ok(record.facets[i-1].index.byteEnd <= record.facets[i].index.byteStart);
  }
});

test('unresolvable and invalid handles stay text while other mention facets remain valid', async () => {
  const did = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
  const { post, calls } = mentionPostHarness({
    'valid.bsky.social': did,
    'gone.bsky.social': 400,
    'offline.bsky.social': 'offline',
    'invalid.bsky.social': 'not-a-did',
  });
  const text = '✦ @valid.bsky.social @gone.bsky.social @offline.bsky.social @invalid.bsky.social';
  const record = await post(text, ['gone.bsky.social', 'offline.bsky.social', 'invalid.bsky.social']);
  assert.equal(record.text, text);
  assert.equal(record.facets.length, 1);
  assert.equal(record.facets[0].features[0].did, did);
  assert.equal(calls.length, 4);
  assert.equal(Buffer.from(text).subarray(record.facets[0].index.byteStart,record.facets[0].index.byteEnd).toString(), '@valid.bsky.social');
});

test('email addresses, incomplete or malformed handles, embedded identifiers and URL mentions are ignored', async () => {
  const { post, calls } = mentionPostHarness({ 'valid.bsky.social': 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' });
  const text = 'me@valid.bsky.social @nodot foo@bar.com @bad-.bsky.social @valid.bsky.social_ https://example.com/@valid.bsky.social';
  const record = await post(text);
  assert.equal('facets' in record, true); // the HTTPS URL only
  assert.deepEqual(record.facets.map(f=>f.features[0].$type), ['app.bsky.richtext.facet#link']);
  assert.deepEqual(calls, []);
});

test('ordinary unmentioned posts and image-only posts make no handle lookup', async () => {
  const { post, calls } = mentionPostHarness();
  const one = await post('🌿 #PNG https://example.com');
  const two = await post('');
  assert.deepEqual(calls, []);
  assert.deepEqual(one.facets.map(f=>f.features[0].$type), [
    'app.bsky.richtext.facet#tag', 'app.bsky.richtext.facet#link',
  ]);
  assert.equal('facets' in two, false);
});

test('createImagePost rejects malformed post-language metadata', async () => {
  const session = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'access', refreshJwt: 'refresh' };
  const { listener } = loadBackground({ storedSession: session });
  const images = [
    { blob: { ref: 'a' }, alt: 'alt', aspectRatio: { width: 100, height: 50 } },
  ];

  const tooMany = await listener({
    type: 'createImagePost',
    text: 'hello',
    languages: ['en', 'ja', 'fr', 'de'],
    images,
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error, 'The post language selection is invalid.');

  const malformed = await listener({
    type: 'createImagePost',
    text: 'hello',
    languages: ['not_a_language'],
    images,
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, 'The post language selection is invalid.');
});

test('fresh launcher always creates a new compose-intent tab and talks only to that tab', async () => {
  let attempts = 0;
  const { listener, tabCalls } = loadBackground({
    sendMessageImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('content script not ready');
      return { ok: true };
    },
  });

  const result = await listener({ type: 'launchFreshComposerPanel' });
  assert.equal(result.ok, true);
  assert.equal(tabCalls.create.length, 1);
  assert.equal(tabCalls.create[0].url, 'https://bsky.app/intent/compose?text=#tpng-toolbar-launch');
  assert.equal(tabCalls.create[0].active, true);
  assert.equal(tabCalls.query.length, 0);
  assert.ok(tabCalls.send.length >= 2);
  assert.ok(tabCalls.send.every((call) => call.tabId === 91));
  assert.ok(tabCalls.send.every((call) => call.message.type === 'openFreshComposerPanel'));
});

test('preflight reports unique unresolved handles and never publishes a record', async () => {
  const { listener, calls, records } = mentionPostHarness({
    'good.bsky.social': 'did:plc:abcdefghijklmnoabcdefghij',
    'bad.bsky.social': 400,
  });
  const result = await listener({
    type: 'checkPostMentions',
    text: '🌿 @good.bsky.social @BAD.Bsky.social @bad.bsky.social https://example.com/@bad.bsky.social',
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.unresolvedHandles], ['bad.bsky.social']);
  assert.deepEqual([...calls].sort(), ['bad.bsky.social', 'good.bsky.social']);
  assert.equal(records.length, 0);
});

test('unapproved mention lookup failure refuses createRecord with structured handle details', async () => {
  const { listener, images, records } = mentionPostHarness({
    'ok.bsky.social': 'did:plc:abcdefghijklmnopqrstuvwxy',
    'missing.bsky.social': 'offline',
  });
  const result = await listener({
    type: 'createImagePost', text: '@ok.bsky.social @missing.bsky.social',
    images, languages: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unresolvedMentions');
  assert.deepEqual([...result.handles], ['missing.bsky.social']);
  assert.match(result.error, /@missing\.bsky\.social/);
  assert.equal(records.length, 0, 'no post exists for a missing approval');
});

test('approved misses may publish as text, but new unapproved misses still block', async () => {
  const { listener, images, records } = mentionPostHarness({
    'a.bsky.social': 404,
    'b.bsky.social': 503,
    'good.bsky.social': 'did:plc:abcdefghijklmnopqrstuvwxyz',
  });
  const attempted = await listener({ type: 'createImagePost',
    text: '@a.bsky.social @b.bsky.social @good.bsky.social #Hi', images,
    approvedUnresolvedHandles: ['a.bsky.social'],
  });
  assert.equal(attempted.ok, false);
  assert.deepEqual([...attempted.handles], ['b.bsky.social']);
  assert.equal(records.length, 0);

  const ok = await listener({ type: 'createImagePost',
    text: '@a.bsky.social @b.bsky.social @good.bsky.social #Hi', images,
    approvedUnresolvedHandles: ['a.bsky.social', 'b.bsky.social'],
  });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].facets.map(f => f.features[0].$type), [
    'app.bsky.richtext.facet#mention', 'app.bsky.richtext.facet#tag',
  ]);
  assert.equal(Buffer.from(records[0].text).subarray(records[0].facets[0].index.byteStart,
    records[0].facets[0].index.byteEnd).toString(), '@good.bsky.social');
});


test('rejected refresh token clears stored session and prompts new sign-in', async () => {
  const calls = [];
  const { listener, storage } = loadBackground({
    storedSession: { did: 'did:plc:me', handle: 'me.test', accessJwt: 'expired', refreshJwt: 'revoked' },
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('.uploadBlob')) return response(400, { error: 'ExpiredToken', message: 'Token has expired' });
      if (url.endsWith('.refreshSession')) return response(400, { error: 'InvalidToken', message: 'Invalid token' });
      throw new Error('unexpected URL ' + url);
    },
  });
  const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(16) });
  assert.equal(result.ok, false);
  assert.match(result.error, /Sign in again/i);
  assert.equal(storage.has('bskySession'), false);
  assert.equal(calls.filter((x) => x.endsWith('.uploadBlob')).length, 1);
});

test('transient refresh failure preserves stored credentials for a later retry', async () => {
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'expired', refreshJwt: 'valid' };
  const { listener, storage } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url) => {
      if (url.endsWith('.uploadBlob')) return response(400, { error: 'ExpiredToken' });
      if (url.endsWith('.refreshSession')) return response(503, { error: 'ServiceUnavailable' });
      throw new Error('unexpected URL ' + url);
    },
  });
  const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(16) });
  assert.equal(result.ok, false);
  assert.equal(storage.get('bskySession').refreshJwt, 'valid');
});

test('expired token on createRecord refreshes and makes only one successful post', async () => {
  const calls = [];
  const initial = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'old', refreshJwt: 'refresh' };
  const { listener } = loadBackground({
    storedSession: initial,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('.refreshSession')) return response(200, { ...initial, accessJwt: 'new' });
      if (url.endsWith('.createRecord')) {
        if (options.headers.Authorization === 'Bearer old') return response(400, { error: 'ExpiredToken' });
        return response(200, { uri: 'at://did:plc:me/app.bsky.feed.post/abc123', cid: 'cid' });
      }
      throw new Error('unexpected URL ' + url);
    },
  });
  const result = await listener({ type: 'createImagePost', text: 'hi', images: [
    { blob: { ref: 'blob' }, alt: 'PNG', aspectRatio: { width: 2, height: 2 } },
  ] });
  assert.equal(result.ok, true, result.error);
  const writes = calls.filter((x) => x.url.endsWith('.createRecord'));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].options.headers.Authorization, 'Bearer new');
});

test('second ExpiredToken response after a refresh does not loop', async () => {
  let refreshes = 0;
  let uploads = 0;
  const { listener } = loadBackground({
    storedSession: { did: 'did:plc:me', accessJwt: 'old', refreshJwt: 'refresh' },
    fetchImpl: async (url) => {
      if (url.endsWith('.uploadBlob')) { uploads++; return response(400, { error: 'ExpiredToken' }); }
      if (url.endsWith('.refreshSession')) { refreshes++; return response(200, { did: 'did:plc:me', accessJwt: 'new', refreshJwt: 'new-refresh' }); }
      throw new Error('unexpected URL ' + url);
    },
  });
  const result = await listener({ type: 'uploadPng', bytes: new ArrayBuffer(16) });
  assert.equal(result.ok, false);
  assert.equal(refreshes, 1);
  assert.equal(uploads, 2);
});

test('background refuses absent or different expected DID without creating any record', async () => {
  const requests = [];
  const { listener } = loadBackground({
    storedSession: { did: 'did:plc:bob', handle: 'bob.test', accessJwt: 'token', refreshJwt: 'refresh' },
    fetchImpl: async (url) => { requests.push(url); throw new Error('must not fetch'); },
  });
  const payload = {
    type: 'createImagePost', text: 'hello', images: [
      { blob: { ref: 'blob' }, alt: 'alt', aspectRatio: { width: 2, height: 2 } },
    ], languages: [],
  };
  const missing = await listener({ ...payload, expectedDid: null });
  const mismatch = await listener({ ...payload, expectedDid: 'did:plc:alice' });
  assert.equal(missing.ok, false);
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /signed-in account changed/);
  assert.deepEqual(requests, []);
});

const trustedPanelSender = { url: 'moz-extension://our-id/panel.html' };
const trustedContentSender = {
  url: 'https://bsky.app/profile/me',
  tab: { id: 44 },
  frameId: 0,
};
const testTicket = 'd34980c3-b974-4f0c-ad2f-376c4e6f1ab2';

test('content script registers a validated account snapshot and iframe verifies without sender.tab metadata', async () => {
  const instance = loadBackground({ sendMessageImpl: async () => {
    throw new Error('background must not request a second content-script read');
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(await instance.listener(
    { type: 'registerPanelAccountTicket', ticket: testTicket,
      account: { did: 'did:plc:me', handle: 'me.test', accessJwt: 'SECRET', email: 'PRIVATE' } }, trustedContentSender
  ))), { ok: true });
  const reply = await instance.listener({ type: 'getBlueskyActiveAccount', ticket: testTicket }, trustedPanelSender);
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), { ok: true, account: { did: 'did:plc:me', handle: 'me.test' } });
  assert.equal(instance.tabCalls.send.length, 0, 'no second page read via tabs.sendMessage');
  assert.equal(JSON.stringify(reply).includes('SECRET'), false);
  const replay = await instance.listener({ type: 'getBlueskyActiveAccount', ticket: testTicket }, trustedPanelSender);
  assert.equal(replay.ok, false, 'tickets cannot be reused');
});

test('registration requires authenticated Bluesky content script; page and fake tab IDs cannot register', async () => {
  const instance = loadBackground();
  for (const sender of [undefined, { ...trustedContentSender, tab: null },
    { ...trustedContentSender, url: 'https://elsewhere.example/' },
    { ...trustedContentSender, frameId: 3 },
    trustedPanelSender]) {
    assert.equal((await instance.listener({ type: 'registerPanelAccountTicket', ticket: testTicket }, sender)).ok, false);
  }
  assert.equal((await instance.listener({ type: 'registerPanelAccountTicket', ticket: 'predictable' }, trustedContentSender)).ok, false);
  assert.equal((await instance.listener({ type: 'getBlueskyActiveAccount', ticket: testTicket }, trustedPanelSender)).ok, false);
  assert.equal(instance.tabCalls.send.length, 0);
});

test('account verification fails closed on absent/invalid account and forged iframe sender', async () => {
  const instance = loadBackground();
  assert.equal((await instance.listener({ type: 'registerPanelAccountTicket', ticket: testTicket,
    account: { did: 'not-a-did', accessJwt: 'NO_EXPOSURE' } }, trustedContentSender)).ok, true);
  for (const sender of [{ url: 'https://bsky.app/' }, undefined]) {
    assert.equal((await instance.listener({ type: 'getBlueskyActiveAccount', ticket: testTicket }, sender)).ok, false);
  }
  const reply = await instance.listener({ type: 'getBlueskyActiveAccount', ticket: testTicket, tabId: 1000 }, trustedPanelSender);
  assert.equal(reply.ok, true);
  assert.equal(reply.account, null);
  assert.equal(reply.diagnostic, 'SITE-ACCOUNT-EMPTY');
  assert.equal(instance.tabCalls.send.length, 0);
});

test('diagnostic codes distinguish registration, missing ticket, and missing page identity', async () => {
  const instance = loadBackground();
  const denied = await instance.listener({ type: 'registerPanelAccountTicket', ticket: testTicket }, trustedPanelSender);
  assert.equal(denied.diagnostic, 'REGISTER-SENDER-REJECTED');
  const missing = await instance.listener({ type: 'getBlueskyActiveAccount', ticket: testTicket }, trustedPanelSender);
  assert.equal(missing.diagnostic, 'TICKET-NOT-FOUND');
  const registered = await instance.listener({ type: 'registerPanelAccountTicket', ticket: testTicket, account: null }, trustedContentSender);
  assert.equal(registered.ok, true);
  const noAccount = await instance.listener({ type: 'getBlueskyActiveAccount', ticket: testTicket }, trustedPanelSender);
  assert.equal(noAccount.diagnostic, 'SITE-ACCOUNT-EMPTY');
  assert.equal(noAccount.account, null);
});



test('only Firefox-recognized extension UI senders may perform privileged operations', async () => {
  let networkRequests = 0;
  const sampleSession = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'a', refreshJwt: 'r' };
  const instance = loadBackground({ storedSession: sampleSession, fetchImpl: async () => {
    networkRequests += 1;
    throw new Error('denied requests must not reach the network');
  } });
  const siteContentSender = { url: 'https://bsky.app/profile/me', tab: { id: 44 }, frameId: 0 };
  const fakeExtensionSender = { url: 'moz-extension://other-id/panel.html' };
  const unknown = { url: 'https://elsewhere.example/' };
  const operations = [
    { type: 'getSession' },
    { type: 'login', identifier: 'me', password: 'nope' },
    { type: 'logout' },
    { type: 'launchFreshComposerPanel' },
    { type: 'uploadPng', bytes: new ArrayBuffer(1) },
    { type: 'checkPostMentions', text: '@me.test' },
    { type: 'createImagePost', text: 'hello', images: [], expectedDid: 'did:plc:me' },
  ];
  for (const op of operations) {
    for (const sender of [null, siteContentSender, fakeExtensionSender, unknown]) {
      const reply = await instance.listener(op, sender);
      assert.equal(reply.ok, false, `${op.type}: should reject ${sender?.url || 'missing sender'}`);
      assert.match(reply.error, /sender/i);
    }
  }
  assert.equal(networkRequests, 0);
  assert.equal(instance.tabCalls.create.length, 0);
  assert.equal(instance.storage.get('bskySession')?.did, 'did:plc:me');
});

test('popup and panel have distinct grants for login, composer launch, and publication', async () => {
  const instance = loadBackground({ storedSession: { did: 'did:plc:me', handle: 'me.test', accessJwt: 'a', refreshJwt: 'r' } });
  const popup = { url: 'moz-extension://our-id/popup.html' };
  const panel = { url: 'moz-extension://our-id/panel.html' };  // tab metadata intentionally absent
  assert.equal((await instance.listener({ type: 'getSession' }, popup)).ok, true);
  assert.equal((await instance.listener({ type: 'getSession' }, panel)).ok, true);
  assert.equal((await instance.listener({ type: 'launchFreshComposerPanel' }, panel)).ok, false);
  assert.equal(instance.tabCalls.create.length, 0);
  for (const operation of [
    { type: 'uploadPng', bytes: new ArrayBuffer(1) },
    { type: 'checkPostMentions', text: 'hello' },
    { type: 'createImagePost', text: 'hello', images: [], expectedDid: 'did:plc:me' },
  ]) {
    const result = await instance.listener(operation, popup);
    assert.equal(result.ok, false, `${operation.type} should reject the popup`);
    assert.match(result.error, /sender/i);
  }
  assert.equal((await instance.listener({ type: 'checkPostMentions', text: 'hello' }, panel)).ok, true);
  assert.equal((await instance.listener({ type: 'launchFreshComposerPanel' }, popup)).ok, true);
  assert.equal(instance.tabCalls.create.length, 1);
});


// v2.8.201: do not guess that a server accepted or rejected an irreversible write.
const postingSession201 = { did: 'did:plc:me', handle: 'me.test', accessJwt: 'token', refreshJwt: 'refresh' };
const image201 = { blob: { ref: 'blob' }, alt: 'Accessible image', aspectRatio: { width: 100, height: 50 } };

for (const [label, responseImpl] of [
  ['network response lost', async () => { throw new TypeError('NetworkError while fetching'); }],
  ['HTTP 408 timeout', async () => response(408, { error: 'RequestTimeout' })],
  ['HTTP 503 server failure', async () => response(503, { error: 'InternalServerError' })],
  ['HTTP 200 with missing record data', async () => response(200, {})],
  ['HTTP 200 with wrong account record URI', async () => response(200, { uri: 'at://did:plc:other/app.bsky.feed.post/post1', cid: 'cid' })],
]) {
  test(`uncertain createRecord outcome: ${label} is reported without an automatic retry`, async () => {
    const calls = [];
    const { listener } = loadBackground({ storedSession: postingSession201, fetchImpl: async (url) => {
      calls.push(url);
      assert.match(url, /\.createRecord$/);
      return responseImpl();
    } });
    const result = await listener({ type: 'createImagePost', text: 'Hello', images: [image201] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'publicationOutcomeUncertain');
    assert.match(result.error, /may have published/i);
    assert.match(result.error, /check your Bluesky profile/i);
    assert.equal(calls.length, 1, 'no automatic second createRecord');
  });
}

test('explicit non-timeout 4xx createRecord rejection remains a definite error', async () => {
  let writes = 0;
  const { listener } = loadBackground({ storedSession: postingSession201, fetchImpl: async (url) => {
    writes++;
    assert.match(url, /\.createRecord$/);
    return response(400, { error: 'InvalidRequest', message: 'invalid record' });
  } });
  const result = await listener({ type: 'createImagePost', text: 'Hello', images: [image201] });
  assert.equal(result.ok, false);
  assert.equal(result.code, undefined);
  assert.match(result.error, /invalid record/);
  assert.equal(writes, 1);
});

test('background enforces the composer 1000-code-unit Alt text limit before any network request', async () => {
  const requests = [];
  const { listener } = loadBackground({ storedSession: postingSession201, fetchImpl: async (url) => {
    requests.push(url);
    return response(200, { uri: 'at://did:plc:me/app.bsky.feed.post/post1', cid: 'cid' });
  } });
  const over = await listener({ type: 'createImagePost', text: 'Hello', images: [{ ...image201, alt: 'a'.repeat(1001) }] });
  assert.equal(over.ok, false);
  assert.match(over.error, /1,000 characters or fewer/);
  assert.equal(requests.length, 0);
  const whitespace = await listener({ type: 'createImagePost', text: 'Hello', images: [{ ...image201, alt: '   ' }] });
  assert.equal(whitespace.ok, false);
  assert.equal(requests.length, 0);
  const exact = await listener({ type: 'createImagePost', text: 'Hello', images: [{ ...image201, alt: 'a'.repeat(1000) }] });
  assert.equal(exact.ok, true, exact.error);
  assert.equal(requests.length, 1);
});
