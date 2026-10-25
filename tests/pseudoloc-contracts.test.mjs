import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile, runScript } from './helpers.mjs';
import { makePseudoCatalog, tokenNames } from '../tools/pseudolocalize.mjs';

const baseCatalog = () => JSON.parse(readProjectFile('_locales/en/messages.json'));

function browserWithMessages(messages, locale) {
  return { i18n: {
    getMessage(key, substitutions = []) {
      if (key === '@@ui_locale') return locale;
      const entry = messages[key];
      if (!entry) return '';
      const values = (Array.isArray(substitutions) ? substitutions : [substitutions]).map(String);
      return entry.message.replace(/\$([a-zA-Z0-9_]+)\$/g, (match, name) => {
        const slot = entry.placeholders?.[name.toLowerCase()];
        return slot ? slot.content.replace(/\$(\d+)/g, (_, index) => values[Number(index) - 1] ?? '') : match;
      });
    },
    getUILanguage() { return locale; },
  } };
}

function i18nWith(messages, locale = 'en') {
  const document = { documentElement: { lang: '', dir: '' }, querySelectorAll() { return []; } };
  const ctx = runScript(readProjectFile('i18n.js'), { browser: browserWithMessages(messages, locale), document });
  return { i18n: ctx.TpngI18n, document };
}

test('diagnostic catalogs keep every production key and exactly the same placeholder contracts', () => {
  const english = baseCatalog();
  for (const variant of ['ltr', 'rtl']) {
    const pseudo = makePseudoCatalog(english, variant);
    assert.deepEqual(Object.keys(pseudo), Object.keys(english));
    assert.equal(Object.keys(pseudo).length, Object.keys(english).length);
    for (const [key, source] of Object.entries(english)) {
      const target = pseudo[key];
      assert.ok(target.message, `${variant}/${key} must not be empty`);
      assert.equal(target.description, source.description, `${variant}/${key}: preserve translator context`);
      assert.deepEqual(target.placeholders, source.placeholders, `${variant}/${key}: preserve definitions`);
      assert.deepEqual(tokenNames(target.message), tokenNames(source.message), `${variant}/${key}: preserve tokens and order`);
    }
  }
});

test('LTR strings expand with accents; RTL uses strong RTL characters and English navigation cues', () => {
  const english = baseCatalog();
  const ltr = makePseudoCatalog(english, 'ltr');
  const rtl = makePseudoCatalog(english, 'rtl');
  assert.ok(ltr.addPngHint.message.length >= english.addPngHint.message.length * 1.5);
  assert.match(ltr.addPngHint.message, /[àëïôüÿ]/);
  assert.match(rtl.addPngHint.message, /[\u0590-\u05FF]/);
  assert.match(rtl.addPngHint.message, /\(Paste PNGs, drop them anywhere/);
  assert.equal(ltr.textDirection.message, 'ltr');
  assert.equal(rtl.textDirection.message, 'rtl');
  assert.match(ltr.extensionName.message, /^\[PSEUDO-LTR\]/);
  assert.match(rtl.extensionName.message, /^\[PSEUDO-RTL\]/);
  assert.match(rtl.extensionName.message, /\(Bluesky PNG Poster\)$/);
  for (const catalog of [ltr, rtl]) {
    assert.ok(catalog.extensionName.message.length < 75,
      'localized Firefox manifest name must be shorter than 75 characters');
  }
  assert.equal(english.textDirection.message, 'ltr', 'generator must not mutate shipping catalog');
});

test('runtime substitutes values in pseudo messages and applies diagnostic document direction', () => {
  const source = baseCatalog();
  for (const variant of ['ltr', 'rtl']) {
    const pseudo = makePseudoCatalog(source, variant);
    const { i18n, document } = i18nWith(pseudo);
    const signedIn = i18n.t('signedInAs', ['alice.bsky.social']);
    assert.equal(signedIn.split('alice.bsky.social').length - 1, 1);
    assert.ok(signedIn.includes('alice.bsky.social'));
    assert.ok(i18n.t('fileSizeKilobytes', ['125.4']).includes('125.4'));
    i18n.localizeDocument(document);
    assert.equal(document.documentElement.dir, variant);
    // Firefox still reports en; this is a layout diagnostic, not real locale negotiation.
    assert.equal(document.documentElement.lang, 'en');
  }
});

test('plural-category lookup covers Arabic zero/two/few/many and falls back to other', () => {
  const english = baseCatalog();
  const arabic = { ...english };
  for (const key of ['zero', 'one', 'two', 'few', 'many', 'other']) {
    arabic[`imagesAdded_${key}`] = { message: `${key}:$COUNT$`, placeholders: {
      count: { content: '$1' },
    } };
  }
  const { i18n } = i18nWith(arabic, 'ar');
  for (const [count, category] of [[0, 'zero'], [1, 'one'], [2, 'two'], [3, 'few'], [11, 'many'], [100, 'other']]) {
    assert.equal(i18n.plural('imagesAdded', count, [String(count)]), `${category}:${count}`);
  }
  delete arabic.imagesAdded_few;
  const fallback = i18nWith(arabic, 'ar').i18n;
  assert.equal(fallback.plural('imagesAdded', 3, ['3']), 'other:3');
});

test('localized number formatting uses the requested UI locale and placeholder word order is catalog-driven', () => {
  const english = baseCatalog();
  const custom = {
    ...english,
    fileSizeKilobytes: {
      ...english.fileSizeKilobytes,
      message: 'كيلوبايت $VALUE$',
    },
    signedInAs: {
      ...english.signedInAs,
      message: '$HANDLE$ — الحساب',
    },
  };
  const { i18n } = i18nWith(custom, 'ar');
  const formatted = i18n.formatNumber(12345.6, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  assert.equal(formatted, new Intl.NumberFormat('ar', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(12345.6));
  assert.equal(i18n.t('fileSizeKilobytes', ['125.4']), 'كيلوبايت 125.4');
  assert.equal(i18n.t('signedInAs', ['alice.test']), 'alice.test — الحساب');
});
