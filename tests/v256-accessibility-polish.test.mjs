import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const css = readProjectFile('panel.css');
const html = readProjectFile('panel.html');
const popup = readProjectFile('popup.html');

function rule(selector) {
  const offset = css.indexOf(selector + ' {');
  assert.ok(offset >= 0, 'missing ' + selector + ' rule');
  return css.slice(offset, css.indexOf('}', offset));
}

test('v2.8.259 preserves extension identity and original SVG icon', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.browser_specific_settings.gecko.id, 'bluesky-transparent-png@asagdotzler.github.io');
  assert.equal(manifest.action.default_icon, 'icons/png-toolbar.svg');
  assert.match(html, /href="panel\.css\?v=1\.0\.0"/);
});

test('light success token meets the selected AA contrast margin in both UIs', () => {
  for (const source of [css, popup]) {
    assert.match(source, /--nova-success:\s*light-dark\(#007a59, #90e3c6\);/);
    assert.doesNotMatch(source, /--nova-success:\s*light-dark\(#008865,/);
  }
});

test('popup uses Gecko-native focus and forced-colors system button boundaries', () => {
  assert.match(popup, /button:focus-visible\s*\{\s*outline:\s*auto;\s*outline-offset:\s*3px;/);
  const forced = popup.slice(popup.lastIndexOf('    @media (forced-colors: active) {'));
  assert.match(forced, /background:\s*ButtonFace;[\s\S]*?border:\s*2px solid ButtonText;/);
  assert.doesNotMatch(forced, /button:focus-visible\s*\{/);
});

test('composer uses native focus ring with compact-control exceptions', () => {
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button\s*\{\s*outline:\s*auto;\s*outline-offset:\s*3px;/);
  assert.match(css, /\.composer-position-picker summary:focus-visible,\s*\.page-reference-actions \.position-choice:focus-visible,\s*\.image-reorder-controls \.move-image:focus-visible\s*\{\s*outline-offset:\s*0;/);
  assert.match(rule('#readPageButton:focus'), /outline:\s*auto;\s*outline-offset:\s*0;/);
  assert.doesNotMatch(css, /#readPageButton:focus-visible\s*\{/);
});

test('Move matches Minimize text metrics without fixed control height', () => {
  const move = rule('.composer-position-picker summary');
  const minimize = rule('.page-reference-actions #readPageButton');
  assert.match(move, /line-height:\s*1\.25;/);
  assert.match(move, /min-height:\s*28px;/);
  assert.match(minimize, /min-height:\s*28px;/);
  assert.doesNotMatch(move, /\n\s*height:\s*28px;/);
});

test('signed-out login spacing is scoped to its native section', () => {
  assert.match(css, /#signInSection\s*\{\s*margin-block:\s*18px 20px;/);
  assert.match(html, /<section id="signInSection">/);
  assert.match(html, /<form id="signInForm">/);
});

test('Post text label stays a native 13px normal-weight label', () => {
  assert.match(html, /<label[^>]*for="postTextInput"/);
  const label = rule('.compose-title');
  assert.match(label, /font-size:\s*13px;/);
  assert.doesNotMatch(label, /font-weight:/);
});

test('Add PNG retains native input and un-clipped three-pixel focus clearance', () => {
  assert.match(html, /<input[^>]*id="fileInput"[\s\S]*?type="file"/);
  const actions = rule('.image-actions');
  assert.match(actions, /align-items:\s*center;/);
  assert.doesNotMatch(actions, /margin-inline-start:\s*-8px;/);
  assert.match(css, /\.add-image-input:focus-visible \+ \.add-image-button\s*\{\s*outline:\s*auto;\s*outline-offset:\s*3px;/);
});
