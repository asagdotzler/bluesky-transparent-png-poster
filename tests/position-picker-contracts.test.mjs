import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readProjectFile } from './helpers.mjs';

const html = readProjectFile('panel.html');
const panel = readProjectFile('panel.js');
const css = readProjectFile('panel.css');
const content = readProjectFile('content.js');
const messages = JSON.parse(readProjectFile('_locales/en/messages.json'));

const horizontals = ['left', 'center', 'right'];
const verticals = ['top', 'middle', 'bottom'];

function presetFunction(viewport) {
  const start = content.indexOf('  function computePresetPosition(');
  const end = content.indexOf('  function placePanelAt(', start);
  assert.ok(start > -1 && end > start);
  return vm.runInNewContext(`${content.slice(start, end)}\ncomputePresetPosition;`, {
    window: { innerWidth: viewport.width, innerHeight: viewport.height },
    VIEWPORT_MARGIN: 12,
  });
}

test('split disclosure offers nine native position buttons, not a custom ARIA grid or keyboard movement mode', () => {
  assert.match(html, /<details id="moveComposerPicker"/);
  assert.match(html, /<summary aria-label="Move composer" data-i18n-aria-label="moveComposer"/);
  const choices = [...html.matchAll(/<button\b[^>]+class="position-choice"[^>]*>/g)].map(([tag]) => tag);
  assert.equal(choices.length, 9);
  const expected = new Set(verticals.flatMap((v) => horizontals.map((h) => `${h}/${v}`)));
  const found = new Set(choices.map((tag) => {
    const h = tag.match(/data-horizontal="([^"]+)"/)?.[1];
    const v = tag.match(/data-vertical="([^"]+)"/)?.[1];
    assert.match(tag, /type="button"/);
    assert.match(tag, /data-i18n-aria-label="[^"]+"/);
    assert.ok(messages[tag.match(/data-i18n-aria-label="([^"]+)"/)?.[1]]);
    return `${h}/${v}`;
  }));
  assert.deepEqual(found, expected);
  assert.doesNotMatch(html, /role="grid"|role="gridcell"/);
  assert.match(panel, /'summary',/); // Include the disclosure in existing Tab containment.
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button \{\s*outline: auto;/);
  assert.match(panel, /elements\.moveComposerPicker\.addEventListener\("toggle", reportPanelHeight\)/);
});

test('placement uses current viewport and content-driven size, with zero movement when the window fills an axis', () => {
  const pos = presetFunction({ width: 1000, height: 700 });
  const dims = { width: 450, height: 300 };
  const expectedX = { left: 12, center: 275, right: 538 };
  const expectedY = { top: 12, middle: 200, bottom: 388 };
  for (const vertical of verticals) for (const horizontal of horizontals) {
    const actual = pos({ horizontal, vertical }, dims.width, dims.height);
    assert.deepEqual({ ...actual }, { left: expectedX[horizontal], top: expectedY[vertical] });
  }
  const tight = presetFunction({ width: 474, height: 324 });
  for (const v of verticals) for (const h of horizontals) {
    const result = tight({ horizontal: h, vertical: v }, 450, 300);
    assert.deepEqual({ ...result }, { left: 12, top: 12 });
  }
  // No preset coordinate should assume a fixed panel height or initial anchor.
  assert.match(content, /computePresetPosition\(panelPreset, width, desiredHeight\)/);
  assert.match(content, /const availableHeight = Math.max\(1, window.innerHeight - VIEWPORT_MARGIN \* 2\)/); // Tiny viewport fits.
  assert.match(content, /Math.min\(PANEL_MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN \* 2\)/);
});

test('pointer movement cancels preset anchoring and manual presets are gated on live modal state and valid values', () => {
  const place = content.slice(content.indexOf('  function placePanelAt('), content.indexOf('  function positionPanel('));
  const drag = content.slice(content.indexOf('  function dragPanelBy('), content.indexOf('  function hideNativeComposer('));
  assert.match(place, /panelDialog\?\.open/);
  assert.match(place, /panelSuspended/);
  assert.match(place, /\["left", "center", "right"\]\.includes\(horizontal\)/);
  assert.match(place, /\["top", "middle", "bottom"\]\.includes\(vertical\)/);
  assert.match(place, /panelPreset = \{ horizontal, vertical \}/);
  assert.match(drag, /panelPreset = null/);
  assert.match(content, /if \(message\.type === "placePanelAt"\) \{\s*placePanelAt\(message\.horizontal, message\.vertical\);/);
  assert.match(content, /if \(choosePosition \|\| !panelPosition\) \{\s*panelPreset = null;/);
  assert.match(panel, /sendToPage\(\{\s*type: "placePanelAt",\s*horizontal: choice\.dataset\.horizontal,\s*vertical: choice\.dataset\.vertical,/);
  assert.match(panel, /choice\.disabled = draftLocked \|\| state\.signingIn/);
});

test('picker is localizable and only affects the compose panel, not popup or native drag handle', () => {
  assert.equal(messages.moveComposer.message, 'Move composer');
  assert.equal(messages.composerPositions.message, 'Composer positions');
  assert.match(panel, /elements\.moveComposerPicker\.open = false;/);
  assert.match(panel, /elements\.dragHandle\.addEventListener\("pointerdown", beginHeaderDrag\)/);
  assert.doesNotMatch(readProjectFile('popup.html'), /moveComposerPicker/);
  assert.match(content, /function restoreSuspendedPanel\(\)/);
});
