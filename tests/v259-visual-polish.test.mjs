import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const css = readProjectFile('panel.css');
const html = readProjectFile('panel.html');
const content = readProjectFile('content.js');

function block(selector) {
  const start = css.indexOf('\n' + selector + ' {');
  assert.ok(start >= 0, 'missing CSS selector ' + selector);
  return css.slice(start, css.indexOf('}', start) + 1);
}

test('v2.8.259 keeps accepted identity, app permissions, and stylesheet revision', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.browser_specific_settings.gecko.id, 'bluesky-transparent-png@asagdotzler.github.io');
  assert.deepEqual(manifest.permissions, ['storage', 'theme']);
  assert.equal(manifest.action.default_icon, 'icons/png-toolbar.svg');
  assert.match(html, /href="panel\.css\?v=1\.0\.0"/);
});

test('Move and Minimize remain native, equally compact and text-scalable', () => {
  const move = block('.composer-position-picker summary');
  const minimize = block('.page-reference-actions #readPageButton');
  for (const rule of [move, minimize]) {
    assert.match(rule, /min-height:\s*28px;/);
    assert.match(rule, /padding:\s*3px 9px;/);
    assert.match(rule, /font-size:\s*11\.5px;/);
    assert.match(rule, /font-weight:\s*500;/);
    assert.doesNotMatch(rule, /(?:^|\n)\s*height:\s*28px;/);
  }
  assert.match(move, /line-height:\s*1\.25;/);
  assert.match(html, /<details id="moveComposerPicker"/);
  assert.match(html, /<button id="readPageButton" type="button"/);
});

test('outer modal is 16px while card and icon shapes remain independent', () => {
  assert.match(content, /border-radius:\s*16px;/);
  assert.match(css, /--nova-radius-large:\s*12px;/);
  assert.match(block('.image-card'), /border-radius:\s*var\(--nova-radius-large\);/);
  assert.match(css, /--nova-radius-circle:\s*9999px;/);
  assert.match(block('.add-image-button'), /border-radius:\s*var\(--nova-radius-circle\);/);
});

test('fields and ordinary action controls have restrained 6px and 12px radii', () => {
  assert.match(css, /--nova-radius-small:\s*6px;/);
  assert.match(css, /--nova-radius-medium:\s*8px;/);
  assert.match(css, /--nova-radius-xlarge:\s*12px;/);
  assert.match(css, /input,\s*textarea\s*\{[\s\S]*?border-radius:\s*var\(--nova-radius-small\);/);
  assert.match(block('button'), /border-radius:\s*var\(--nova-radius-xlarge\);/);
});

test('polish preserves Gecko-native focus and signup spacing decisions', () => {
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button\s*\{\s*outline:\s*auto;\s*outline-offset:\s*3px;/);
  assert.match(css, /\.composer-position-picker summary:focus-visible,\s*\.page-reference-actions \.position-choice:focus-visible,\s*\.image-reorder-controls \.move-image:focus-visible\s*\{\s*outline-offset:\s*0;/);
  assert.match(block('#readPageButton:focus'), /outline:\s*auto;\s*outline-offset:\s*0;/);
  assert.match(block('#signInSection'), /margin-block:\s*18px 20px;/);
  assert.doesNotMatch(block('.image-actions'), /margin-inline-start:/);
});
