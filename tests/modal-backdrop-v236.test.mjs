import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const source = readProjectFile('content.js');

test('stronger shade uses only the native modal backdrop', () => {
  assert.match(source, /#\$\{PANEL_DIALOG_ID\}::backdrop \{[\s\S]*?background: rgba\(0, 0, 0, 0\.8\) !important;/);
  assert.doesNotMatch(source, /createElement\(["'](?:div|section)["']\)[\s\S]{0,150}?(?:shade|backdrop|overlay)/i);
});

test('Minimize and Restore retain native dialog close/showModal with the draft and return button', () => {
  const minimize = source.slice(source.indexOf('  async function suspendPanel('), source.indexOf('  function restoreSuspendedPanel('));
  const restore = source.slice(source.indexOf('  function restoreSuspendedPanel('), source.indexOf('  function preparePendingPanelOpen('));
  assert.match(minimize, /panelDialog\.close\(\)/);
  assert.match(minimize, /panelSuspended = true;/);
  assert.match(minimize, /panelReturnButton\.hidden = false;/);
  assert.match(minimize, /if \(\!panelDialog\.open\) panelDialog\.showModal\(\)/);
  assert.match(restore, /panelReturnButton\.hidden = true;/);
  assert.match(restore, /panelDialog\.showModal\(\)/);
  assert.doesNotMatch(minimize + restore, /\.inert\s*=|setAttribute\(["']inert["']/);
});
