import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const panel = readProjectFile('panel.js');
const content = readProjectFile('content.js');
const html = readProjectFile('panel.html');
const messages = JSON.parse(readProjectFile('_locales/en/messages.json'));

test('suspend control is native, localized, and disabled during publishing and sign-in', () => {
  assert.match(html, /<button id="readPageButton" type="button"[^>]*data-i18n="minimizeComposerShort"/);
  assert.equal(messages.readBlueskyPage.message, 'Minimize composer');
  assert.match(html, /id="readPageButton"[^>]*data-i18n-aria-label="readBlueskyPage"/);
  assert.match(html, /id="readPageButton"[^>]*data-i18n-title="minimizeComposerHelp"/);
  assert.equal(messages.minimizeComposerHelp.message, 'Minimize to read and interact with Bluesky');
  assert.equal(messages.returnToPngComposer.message, 'Return to PNG composer');
  assert.match(panel, /elements\.readPageButton\.disabled = draftLocked \|\| state\.signingIn \|\| state\.pendingImageBatches > 0/);
  assert.match(panel, /!state\.busy && !state\.cancelPending && !state\.signingIn && state\.pendingImageBatches === 0/);
  assert.match(panel, /sendToPage\(\{ type: "suspendPanel" \}\)/);
});

test('suspend uses Bluesky native dismissal before allowing page reading', () => {
  const suspendBody = content.slice(content.indexOf('  async function suspendPanel()'), content.indexOf('  function restoreSuspendedPanel()'));
  assert.match(suspendBody, /panelDialog\.close\(\)/);
  assert.match(suspendBody, /dismissOwnedNativeComposerAfterPost\(ownedRoot\)/);
  assert.match(suspendBody, /panelSuspended = true/);
  assert.match(suspendBody, /sendToPanel\(\{ type: "suspendCleanupFailed" \}\)/);
  assert.doesNotMatch(suspendBody, /resetDraft|showNativeComposer|panelFrame\.hidden = true/);
  assert.match(content, /if \(panelSuspended \|\| \(panelFrame && !panelFrame\.hidden\)\)/);
  assert.match(content, /focusReturnButtonAfterSuspend\(\)/);
  assert.match(content, /button\.focus\(\{ preventScroll: true \}\)/);
  assert.match(content, /type: "resumeFocus",[\s\S]*?cancelConflictResolved: findVisibleComposers\(\)\.length === 0/);
  assert.equal(messages.couldNotReadBlueskyPage.message.includes('draft is still here'), true);
});

test('restoration always returns focus to Minimize for a reversible keyboard toggle', () => {
  const start = panel.indexOf('if (message.type === "resumeFocus")');
  const end = panel.indexOf('if (message.type === "requestCancel")', start);
  assert.ok(start !== -1 && end > start);
  assert.match(panel.slice(start, end), /elements\.readPageButton\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(panel, /lastComposerFocus/);
  assert.match(content, /panelDialog\.showModal\(\)/);
});

test('Minimize preserves native modality and the backdrop has 80 percent black', () => {
  assert.match(content, /background: rgba\(0, 0, 0, 0\.8\) !important;/);
  assert.match(content, /panelReturnButton\.hidden = true/);
  assert.match(content, /panelReturnButton\.addEventListener\("click", restoreSuspendedPanel\)/);
});
