import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const html = readProjectFile('panel.html');
const js = readProjectFile('panel.js');
const css = readProjectFile('panel.css');

test('draggable composer identity is a native h1 with the previous visual dimensions', () => {
  assert.match(html, /<div id="dragHandle" class="panel-identity">\s*<h1 class="panel-title" data-i18n="panelTitle">Add transparent PNGs<\/h1>/);
  assert.match(js, /<h2 class="image-name-slot" title="\$\{imageName\}"><bdi class="image-name" dir="auto">\$\{imageName\}<\/bdi><\/h2>/);
  const titleRules = css.match(/\.panel-title \{([^}]+)\}/)?.[1];
  assert.ok(titleRules);
  assert.match(titleRules, /margin:\s*0;/);
  assert.match(titleRules, /font-size:\s*16px;/);
  assert.match(titleRules, /font-weight:\s*700;/);
  assert.match(titleRules, /line-height:\s*1\.2;/);
});

test('native alt-text label and description accompany ARIA required without premature native invalid state', () => {
  assert.match(js, /<label class="sr-only" for="\$\{altId\}">\$\{escapeHtml\(t\("altTextForImage"/);
  assert.match(js, /<textarea\s+id="\$\{altId\}"[\s\S]*?maxlength="\$\{MAX_ALT_CHARACTERS\}"\s+aria-required="true"\s+aria-describedby="\$\{altDetailsId\}-sr/);
  assert.doesNotMatch(js, /aria-labelledby="\$\{altLabelId\}"|alt-label-\$\{index\}/);
  assert.doesNotMatch(js, /maxlength="\$\{MAX_ALT_CHARACTERS\}"\s+required(?:\s|>)/);
  assert.match(js, /aria-required="true"/);
  // Application validation remains necessary: whitespace alone is not valid alt text.
  assert.match(js, /state\.images\.every\(\(image\) => image\.alt\.trim\(\)\)/);
  assert.doesNotMatch(html.match(/<form id="signInForm">[\s\S]*?<\/form>/)?.[0] ?? '', /id="imageList"/);
});

test('cancel derives its accessible name from the localized visible button text', () => {
  assert.match(html, /<button id="cancelButton" class="text-action" type="button" data-i18n="cancel">Cancel<\/button>/);
  assert.doesNotMatch(html, /id="cancelButton"[^>]*(?:aria-label|data-i18n-aria-label)/);
});

test('native status/output retain implicit polite live semantics; custom status stays explicitly live', () => {
  assert.match(html, /<p id="accountNoticeText" role="status" aria-atomic="true"><\/p>/);
  assert.match(html, /<output id="accountRecheckFeedback" class="account-recheck-feedback" aria-atomic="true"><\/output>/);
  assert.match(html, /<output id="imageAnnouncement" class="sr-only"><\/output>/);
  assert.match(html, /<div id="statusMessage" class="status" aria-live="polite"><\/div>/);
  assert.doesNotMatch(html, /(?:accountNoticeText|accountRecheckFeedback)[^>]*aria-live/);
});

test('purely decorative activity indicator is never placed in the accessibility tree', () => {
  assert.match(html, /<div id="activityIndicator" class="activity" hidden aria-hidden="true">/);
  assert.match(js, /elements\.activityIndicator\.hidden = !working;/);
  assert.doesNotMatch(js, /activityIndicator\.setAttribute\("aria-hidden"/);
});
