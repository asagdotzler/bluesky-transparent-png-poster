// Offline-only diagnostic catalog transformation. Not loaded by the extension.
import { readFileSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const substitutionToken = /\$[A-Za-z][A-Za-z0-9_]*\$/g;
const accentMap = Object.freeze({
  a: 'à', e: 'ë', i: 'ï', o: 'ô', u: 'ü', y: 'ÿ',
  A: 'À', E: 'Ë', I: 'Ï', O: 'Ô', U: 'Ü', Y: 'Ÿ',
});
const hebrewLetters = 'אבגדהוזחטיכלמנסעפצקרשת';
const latin = 'abcdefghijklmnopqrstuvwxyz';

function transformLiteral(input, variant) {
  if (variant === 'ltr') {
    return input.replace(/[A-Za-z]+/g, (word) => {
      const accented = [...word].map((char) => accentMap[char] || char).join('');
      const extra = Math.max(2, Math.ceil(word.length * 0.55));
      return accented + 'ë'.repeat(extra);
    });
  }
  if (variant === 'rtl') {
    return input.replace(/[A-Za-z]+/g, (word) =>
      [...word.toLowerCase()].map((char) => hebrewLetters[latin.indexOf(char) % hebrewLetters.length]).join('')
    );
  }
  throw new Error(`unknown diagnostic variant: ${variant}`);
}

function replaceOutsideTokens(input, fn) {
  let cursor = 0;
  let result = '';
  for (const match of input.matchAll(substitutionToken)) {
    result += fn(input.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return result + fn(input.slice(cursor));
}

export function tokenNames(message) {
  return [...message.matchAll(substitutionToken)].map((match) => match[0]);
}

export function makePseudoCatalog(english, variant) {
  if (!['ltr', 'rtl'].includes(variant)) throw new Error(`invalid pseudo variant: ${variant}`);
  const output = {};
  for (const [key, entry] of Object.entries(english)) {
    if (key === 'textDirection') {
      output[key] = { ...entry, message: variant };
      continue;
    }
    const original = entry.message;
    const pseudo = replaceOutsideTokens(original, (span) => transformLiteral(span, variant));
    // Firefox limits the localized manifest name to fewer than 75 characters.
    // Keep the RTL diagnostic name readable without exceeding that constraint.
    const humanReadable = variant === 'rtl' && key === 'extensionName'
      ? 'Bluesky PNG Poster'
      : original.replace(substitutionToken, '‹value›');
    const message = variant === 'ltr'
      ? `⟦${pseudo}⟧`
      : `⟦${pseudo}⟧ (${humanReadable})`;
    output[key] = { ...entry, message };
  }
  for (const key of ['extensionName', 'actionTitle']) {
    output[key].message = `[PSEUDO-${variant.toUpperCase()}] ${output[key].message}`;
  }
  return output;
}

const installedFiles = [
  'manifest.json', 'background.js', 'content.js', 'i18n.js', 'panel.html',
  'panel.css', 'panel.js', 'popup.html', 'popup.js', 'theme.js',
];

export function buildDiagnostic(root, target, variant) {
  const english = JSON.parse(readFileSync(join(root, '_locales/en/messages.json'), 'utf8'));
  const catalog = makePseudoCatalog(english, variant);
  mkdirSync(target, { recursive: true });
  for (const file of installedFiles) {
    cpSync(join(root, file), join(target, file));
  }
  mkdirSync(join(target, '_locales/en'), { recursive: true });
  writeFileSync(join(target, '_locales/en/messages.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  const notes = `# DIAGNOSTIC BUILD — NOT FOR RELEASE\n\nVariant: ${variant.toUpperCase()}\nSource: v2.8.89 validated runtime; v2.8.90 catalog-test packaging.\n\nThis replaces the en catalog *only in this disposable build*. Firefox still\nreports the locale as en. The RTL variant sets document direction using the\nexisting textDirection localization key, but cannot test real Hebrew locale\nnumber shaping or native Firefox locale negotiation. These are intentionally\nsynthetic pseudo-strings and not translations; English glosses aid testing.\n\nDo not distribute as a regular release or treat pseudo text as production copy.\nUse one variant at a time; both use the existing extension ID.\n\nCheck signed-out popup/panel, signed-in panel, helper/error text, alt-text\nfields, long filenames, counter and media controls; report clipping, escaping,\nmisplaced controls, unintended direction in handle/password fields, and\nreversed punctuation. Publishing is not required.\n`;
  writeFileSync(join(target, 'DIAGNOSTIC_NOTES.md'), notes);
  return catalog;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const variant = process.argv[2];
  const target = process.argv[3];
  if (!variant || !target) {
    console.error('Usage: node tools/pseudolocalize.mjs <ltr|rtl> <output-directory>');
    process.exit(2);
  }
  buildDiagnostic(projectRoot, resolve(target), variant);
  console.log(`Built ${variant} diagnostic in ${resolve(target)}`);
}
