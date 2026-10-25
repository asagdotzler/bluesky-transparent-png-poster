import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const html = readProjectFile('panel.html');
const css = readProjectFile('panel.css');
const panel = readProjectFile('panel.js');
const messages = JSON.parse(readProjectFile('_locales/en/messages.json'));

test('compact header utility row presents native Move then Minimize without a split control', () => {
  const group = html.match(/<div class="composer-window-tools">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(group);
  assert.match(group[1], /<details id="moveComposerPicker"/);
  assert.match(group[1], /<summary aria-label="Move composer" data-i18n-aria-label="moveComposer"/);
  assert.match(group[1], /<span data-i18n="moveComposerShort">Move<\/span>/);
  assert.match(group[1], /<button id="readPageButton"[^>]*data-i18n="minimizeComposerShort"/);
  assert.ok(group[1].indexOf('id="moveComposerPicker"') < group[1].indexOf('id="readPageButton"'));
  assert.match(group[1], /data-i18n-title="minimizeComposerHelp"/);
  assert.match(group[1], /<svg[^>]*aria-hidden="true"/);
  assert.doesNotMatch(group[1], /role="toolbar"|role="menu"|role="menuitem"/);
  assert.equal(messages.moveComposerShort.message, 'Move');
  assert.equal(messages.minimizeComposerShort.message, 'Minimize');
  assert.match(panel, /elements\.readPageButton\.addEventListener\("click", requestPageReading\)/);
  assert.match(panel, /elements\.moveComposerPicker\.addEventListener\("toggle", reportPanelHeight\)/);
});

test('compact utilities centered beneath drag surface; opened picker reserves room for native buttons', () => {
  assert.match(css, /\.page-reference-actions\s*\{[^}]*justify-content: center;/);
  assert.match(css, /\.composer-window-tools\s*\{[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.composer-window-tools:has\(\.composer-position-picker\[open\]\)/);
  assert.match(css, /\.composer-position-grid\s*\{[^}]*position: absolute;[^}]*top: calc\(100% \+ var\(--position-gap\)\);/);
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button\s*\{\s*outline:\s*auto;/);
  assert.match(css, /#readPageButton:focus\s*\{[^}]*outline: auto;/);
  assert.match(css, /\.page-reference-actions #readPageButton/);
  assert.doesNotMatch(css, /split-composer-controls|split-end rounding/);
});
