import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile, runScript } from './helpers.mjs';

function englishCatalog() {
  return JSON.parse(readProjectFile('_locales/en/messages.json'));
}

function makeBrowserI18n(catalog, locale = 'en') {
  function substitute(entry, substitutions = []) {
    const values = (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
    return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (match, placeholderName) => {
      const placeholder = entry.placeholders?.[placeholderName.toLowerCase()];
      if (!placeholder) return match;
      return placeholder.content.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] ?? '');
    });
  }

  return {
    getMessage(key, substitutions) {
      if (key === '@@ui_locale') return locale;
      const entry = catalog[key];
      return entry ? substitute(entry, substitutions) : '';
    },
    getUILanguage() { return locale; },
  };
}

test('manifest and extension surfaces are wired to Firefox native localization', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  const panel = readProjectFile('panel.html');
  const popup = readProjectFile('popup.html');

  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, '__MSG_extensionName__');
  assert.equal(manifest.description, '__MSG_extensionDescription__');
  assert.equal(manifest.action.default_title, '__MSG_actionTitle__');
  assert.deepEqual(manifest.background.scripts.slice(0, 2), ['i18n.js', 'background.js']);
  assert.deepEqual(manifest.content_scripts[0].js, ['toolbar-transition.js']);
  assert.deepEqual(manifest.content_scripts[1].js, ['i18n.js', 'content.js']);
  assert.ok(manifest.web_accessible_resources[0].resources.includes('i18n.js'));
  assert.match(panel, /<script src="i18n\.js"><\/script>[\s\S]*?<script src="panel\.js"><\/script>/);
  assert.match(popup, /<script src="i18n\.js"><\/script>[\s\S]*?<script src="popup\.js"><\/script>/);
});

test('every referenced extension message key exists in the English catalog', () => {
  const catalog = englishCatalog();
  const sources = [
    'manifest.json', 'panel.html', 'popup.html', 'panel.js', 'popup.js',
    'content.js', 'background.js',
  ].map(readProjectFile).join('\n');

  const keys = new Set();
  for (const match of sources.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) keys.add(match[1]);
  for (const match of sources.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) keys.add(match[1]);
  for (const match of sources.matchAll(/\bt\("([A-Za-z0-9_]+)"/g)) keys.add(match[1]);
  for (const match of sources.matchAll(/\btp\("([A-Za-z0-9_]+)"/g)) {
    assert.ok(catalog[`${match[1]}_other`], `missing plural fallback ${match[1]}_other`);
    continue;
  }

  for (const key of keys) {
    assert.ok(catalog[key], `missing localization key ${key}`);
  }
});

test('localization helper supports placeholders, plural categories, locale numbers, bidi isolation, and document direction', () => {
  const catalog = englishCatalog();
  const browser = { i18n: makeBrowserI18n(catalog) };
  const documentElement = { lang: '', dir: '' };
  const document = { documentElement, querySelectorAll() { return []; } };
  const context = runScript(readProjectFile('i18n.js'), { browser, document }, 'i18n.js');
  const i18n = context.TpngI18n;

  assert.equal(i18n.t('signedInAs', ['alice.test']), 'Signed in as alice.test');
  assert.equal(i18n.plural('imagesAdded', 2, ['2']), 'Added 2 PNGs. Alt text required for each.');
  assert.equal(i18n.plural('imagesAddedColor', 1, ['diagram.png', 'Colors may differ.']), 'Added diagram.png. Colors may differ. Alt text required.');
  assert.equal(i18n.plural('imagesAddedColor', 2, ['2', 'Colors may differ.']), 'Added 2 PNGs. Colors may differ. Alt text required for each.');
  assert.equal(i18n.t('colorMayChangeAfterResize'), 'Colors may have changed.');
  assert.equal(i18n.t('imageOptimizedSizeSpeech', ['37.16 MB', '1.37 MB']), 'Optimized from 37.16 MB to 1.37 MB.');
  assert.equal(i18n.plural('imagesAddedDetails', 1, ['lamb.png', 'Optimized from 37.16 MB to 1.37 MB. Colors may have changed.']), 'Added lamb.png. Optimized from 37.16 MB to 1.37 MB. Colors may have changed. Alt text required.');
  assert.equal(i18n.plural('imagesAddedDetails', 2, ['2', '1 image resized and optimized.']), 'Added 2 PNGs. 1 image resized and optimized. Alt text required for each.');
  assert.equal(i18n.plural('imagesOptimized', 2, ['2']), '2 images resized and optimized.');
  assert.equal(i18n.formatNumber(125.4, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), '125.4');
  assert.equal(i18n.isolateBidiText('abc'), '\u2068abc\u2069');
  i18n.localizeDocument(document);
  assert.equal(documentElement.lang, 'en');
  assert.equal(documentElement.dir, 'ltr');
});

test('post creation uses captured language metadata without restoring a hard-coded English default', () => {
  const background = readProjectFile('background.js');
  const content = readProjectFile('content.js');
  assert.doesNotMatch(background, /DEFAULT_POST_LANGUAGE/);
  assert.doesNotMatch(background, /langs:\s*\[\s*["']en["']/);
  assert.match(background, /normalizedLanguages\.length \? \{ langs: normalizedLanguages \} : \{\}/);
  assert.match(content, /data-testid=\"selectLangBtn\"/);
  assert.match(content, /new Intl\.DisplayNames/);
});
