import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTestI18n, readProjectFile, runScript } from './helpers.mjs';

const en = JSON.parse(readProjectFile('_locales/en/messages.json'));

function browserWith(catalog) {
  return {
    i18n: {
      getMessage(key, substitutions = []) {
        if (key === '@@ui_locale') return 'en';
        const entry = catalog[key];
        if (!entry) return '';
        const values = (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
        return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, name) => {
          const slot = entry.placeholders?.[name.toLowerCase()];
          return slot ? slot.content.replace(/\$(\d+)/g, (_, n) => values[Number(n) - 1] ?? '') : match;
        });
      },
      getUILanguage() { return 'en'; },
    },
  };
}

function localizedLinkTest(catalog) {
  const anchor = { tagName: 'A', href: 'https://bsky.app/settings/app-passwords', tabindex: 0, textContent: 'Create an app password' };
  const element = {
    getAttribute(name) { return name === 'data-i18n-link' ? 'appPasswordHelp' : null; },
    querySelector(selector) { return selector === 'a' ? anchor : null; },
    replaceChildren(...children) { this.children = children; },
  };
  const doc = {
    documentElement: {lang:'',dir:''},
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    querySelectorAll(selector) {
      if (selector === '[data-i18n-link]') return [element];
      return [];
    },
  };
  element.ownerDocument = doc;
  const ctx = runScript(readProjectFile('i18n.js'), { browser: browserWith(catalog), document: doc });
  ctx.TpngI18n.localizeDocument(doc);
  return { element, anchor };
}

test('password help uses a single localized message with an HTML anchor placeholder in both surfaces', () => {
  for (const name of ['popup.html', 'panel.html']) {
    const html = readProjectFile(name);
    assert.match(html, /<p[^>]*data-i18n-link="appPasswordHelp"[^>]*>/);
    assert.match(html, /<a href="https:\/\/bsky\.app\/settings\/app-passwords"[^>]*data-i18n="createAppPassword"/);
    assert.doesNotMatch(html, /<span data-i18n="appPasswordHelp"/);
  }
  assert.deepEqual(Object.keys(en.appPasswordHelp.placeholders), ['link']);
  assert.equal((en.appPasswordHelp.message.match(/\$LINK\$/g) || []).length, 1);
});

test('localized help can reorder the real link without replacing it with HTML markup', () => {
  const {element,anchor} = localizedLinkTest({
    ...en,
    appPasswordHelp: {...en.appPasswordHelp, message: '$LINK$: please use it instead of an account password.'},
  });
  assert.equal(element.children.length, 3);
  assert.equal(element.children[0].textContent, '');
  assert.equal(element.children[1], anchor, 'link retains original node, URL and native semantics');
  assert.equal(element.children[2].textContent, ': please use it instead of an account password.');
});

test('English help preserves its wording while incorporating the link', () => {
  const english = localizedLinkTest(en);
  assert.equal(english.element.children[0].textContent, 'Use a Bluesky app password, not your account password. ');
  assert.equal(english.element.children[2].textContent, '.');
});

test('missing or malformed linked message does not remove the existing link', () => {
  for (const message of [undefined, 'No link placeholder', '$LINK$ and $LINK$ twice']) {
    const catalog = { ...en };
    if (message === undefined) delete catalog.appPasswordHelp;
    else catalog.appPasswordHelp = { ...en.appPasswordHelp, message };
    const { element } = localizedLinkTest(catalog);
    assert.equal(element.children, undefined);
  }
});

test('localized alt status separator is controlled by the catalog in both render/update paths', () => {
  const separator = makeTestI18n('en').t('altCountStatusSeparator');
  assert.equal(separator, ' · ');
  assert.equal(en.altCountStatusSeparator.message, separator);
  const panelSource = readProjectFile('panel.js');
  assert.match(panelSource, /function renderAltCountStatus\(image\)/);
  assert.match(panelSource, /t\("altCountStatusSeparator"\)/);
  assert.equal((panelSource.match(/renderAltCountStatus\(image\)/g) || []).length, 3,
    'shared helper is declared and used for initial rendering and input updates');
  assert.doesNotMatch(panelSource, /\} ·\s*<span/);
});
