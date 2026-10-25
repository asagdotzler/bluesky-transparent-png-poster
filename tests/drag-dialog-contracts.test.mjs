import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const content = readProjectFile('content.js');
const panel = readProjectFile('panel.js');
const css = readProjectFile('panel.css');

test('drag updates the existing modal position and clamps it within the viewport', () => {
  const fn = content.slice(content.indexOf('  function dragPanelBy('), content.indexOf('  function hideNativeComposer('));
  assert.match(fn, /panelDialog\?\.open/);
  assert.match(fn, /Number\.isFinite\(dx\)/);
  assert.match(fn, /Number\.isFinite\(dy\)/);
  assert.match(fn, /window\.innerWidth - rect\.width - VIEWPORT_MARGIN/);
  assert.match(fn, /window\.innerHeight - rect\.height - VIEWPORT_MARGIN/);
  assert.match(fn, /panelPosition = \{/);
  assert.match(fn, /positionPanel\(\)/);
  assert.match(content, /message\.type === "dragPanelBy"/);
  assert.match(content, /dragPanelBy\(message\.deltaX, message\.deltaY\)/);
  assert.match(content, /panelDialog\.showModal\(\)/, 'dialog remains modal');
  assert.match(content, /function hideNativeComposer\(\)/, 'native composer hiding unchanged');
});

test('only title/status region initiates pointer capture; controls retain their behavior', () => {
  assert.match(panel, /dragHandle: document\.getElementById\("dragHandle"\)/);
  assert.match(panel, /setPointerCapture\(event\.pointerId\)/);
  assert.match(panel, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(panel, /sendToPage\(\{ type: "dragPanelBy", deltaX, deltaY \}\)/);
  assert.match(panel, /elements\.dragHandle\.addEventListener\("pointerdown", beginHeaderDrag\)/);
  assert.match(panel, /elements\.cancelButton\.addEventListener\("click", requestPanelClose\)/);
  assert.match(css, /\.panel-identity \{[\s\S]*?cursor: grab;[\s\S]*?touch-action: none;/);
});

test('experiment adds a light background-inert cue and a decorative grip without new control semantics', () => {
  const html = readProjectFile('panel.html');
  assert.match(content, /#\$\{PANEL_DIALOG_ID\}::backdrop \{[\s\S]*?background: rgba\(0, 0, 0, 0\.8\) !important;/);
  assert.match(css, /\.panel-identity::before \{[\s\S]*?background-image: radial-gradient\(/);
  assert.match(css, /\.panel-identity::before \{[\s\S]*?pointer-events: none;/);
  assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*?\.panel-identity::before/);
  assert.match(html, /<div id="dragHandle" class="panel-identity">/);
  assert.doesNotMatch(html, /id="dragHandle"[^>]*\b(role|tabindex)=/);
});
