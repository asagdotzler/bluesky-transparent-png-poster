import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const source = readProjectFile('content.js');
const styles = source.match(/style\.textContent\s*=\s*`([\s\S]*?)`;/)?.[1];
assert.ok(styles, 'content script should register a launcher/dialog stylesheet');

test('dialog opening has a restrained 120ms entrance animation only when motion is allowed', () => {
  const motion = styles.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n      \}/)?.[1];
  assert.ok(motion, 'visual entrance must be opt-in for no-preference');
  assert.match(motion, /#\$\{PANEL_DIALOG_ID\}\[open\] \{/);
  assert.match(motion, /animation: bsky-tpng-dialog-enter 120ms ease-out both !important;/);
  assert.match(motion, /@keyframes bsky-tpng-dialog-enter/);
  assert.match(motion, /opacity: 0\.22;/);
  assert.match(motion, /transform: scale\(0\.985\);/);
  assert.match(motion, /opacity: 1;/);
  assert.match(motion, /transform: scale\(1\);/);
  const outsideMotion = styles.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n      \}/, '');
  assert.doesNotMatch(outsideMotion, /bsky-tpng-dialog-enter/, 'no animation outside motion-allowed query');
});

test('animation leaves native modal focus and dismissal paths unchanged', () => {
  const reveal = source.slice(source.indexOf('  function revealPreparedPanel('), source.indexOf('  function finishPanelFocusHandoff('));
  assert.match(reveal, /panelDialog\.showModal\(\)/);
  assert.match(reveal, /requestAnimationFrame\(\(\) => \{[\s\S]*?type: "focusInitial"/);
  assert.ok(reveal.indexOf('panelDialog.showModal()') < reveal.indexOf('requestAnimationFrame('));
  assert.doesNotMatch(reveal, /setTimeout|await|transitionend|animationend/, 'entrance must not delay focus or panel readiness');
  assert.match(styles, /#\$\{PANEL_DIALOG_ID\}::backdrop \{[\s\S]*?background: rgba\(0, 0, 0, 0\.8\) !important;/);
  assert.match(source, /function dismissPanelDialog\(\) \{[\s\S]*?panelDialog\.close\(\)/);
});
