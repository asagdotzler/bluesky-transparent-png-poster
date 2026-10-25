import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';
const panel = readProjectFile('panel.js');

test('suspending collapses the native position picker without changing editor state', () => {
  assert.match(panel, /function prepareFocusForSuspension\(\) \{\s*elements\.moveComposerPicker\.open = false;/);
  assert.match(panel, /prepareFocusForSuspension\(\);\s*sendToPage\(\{ type: "suspendPanel" \}\);/);
  assert.doesNotMatch(panel, /lastComposerFocus|moveComposerTrigger/);
});

test('restoring focuses Minimize, never Cancel, the picker, or the post editor', () => {
  const start = panel.indexOf('if (message.type === "resumeFocus")');
  const end = panel.indexOf('if (message.type === "requestCancel")', start);
  assert.ok(start !== -1 && end > start);
  const block = panel.slice(start, end);
  assert.match(block, /elements\.readPageButton\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(block, /cancelButton\.focus|postTextInput\.focus|moveComposerPicker|querySelector/);
  assert.doesNotMatch(panel, /classList\.add\(['"]force-focus/);
});
