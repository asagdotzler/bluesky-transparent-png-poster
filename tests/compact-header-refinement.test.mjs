import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const css = readProjectFile('panel.css');
const html = readProjectFile('panel.html');
const block = (selector) => {
  const prefix = `${selector} {`;
  const start = css.indexOf(prefix);
  assert.ok(start >= 0, `missing ${selector}`);
  return css.slice(start + prefix.length, css.indexOf('}', start));
};

test('compact header typography has matching neutral controls but distinct main actions', () => {
  const move = block('.composer-position-picker summary');
  const minimize = block('.page-reference-actions #readPageButton');
  for (const rule of [move, minimize]) {
    assert.match(rule, /color: var\(--nova-text-muted\);/);
    assert.match(rule, /font-size: 11\.5px;/);
    assert.match(rule, /font-weight: 500;/);
    assert.match(rule, /min-height: 28px;/);
  }
  assert.match(block('.text-action'), /color: var\(--nova-accent-foreground\);/);
  assert.match(block('.composer-position-picker summary'), /line-height: 1\.25;/);
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button \{\s*outline: auto;/);
  assert.match(block('#readPageButton:focus'), /outline: auto;/);
});

test('compact header reduces whitespace without changing native composition or picker behavior', () => {
  assert.match(block('.panel-header'), /margin-bottom: 6px;/);
  assert.match(block('.page-reference-actions'), /margin-block: 0;/);
  assert.match(block('.compose-section'), /margin: 10px 0 16px;/);
  assert.match(html, /<details id="moveComposerPicker"/);
  assert.match(html, /<summary aria-label="Move composer"/);
  assert.match(html, /<button id="readPageButton" type="button"/);
  assert.match(css, /\.composer-window-tools:has\(\.composer-position-picker\[open\]\)/);
  assert.equal(JSON.parse(readProjectFile('manifest.json')).version, '1.0.0');
  assert.match(html, /panel\.css\?v=1\.0\.0/);
});
