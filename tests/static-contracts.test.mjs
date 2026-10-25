import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

test('native Add PNG control remains a real file input with an associated label and no scripted click bridge', () => {
  const html = readProjectFile('panel.html');
  const js = readProjectFile('panel.js');
  assert.match(html, /<input[\s\S]*?id="fileInput"[\s\S]*?type="file"[\s\S]*?>/);
  assert.match(html, /id="fileInput"[\s\S]*?aria-label="Add PNG"[\s\S]*?data-i18n-aria-label="addPng"/);
  assert.match(html, /<label[^>]*for="fileInput"[^>]*aria-hidden="true"[^>]*>[\s\S]*?Add PNG[\s\S]*?<\/label>/);
  assert.doesNotMatch(html, /id="fileInput"[^>]*\shidden(?:\s|>)/);
  assert.doesNotMatch(js, /fileInput\.click\s*\(/);
  // The single real native file input, not the icon-like label, owns disabled
  // semantics and receives the maximum explanation only when full.
  assert.match(js, /elements\.fileInput\.disabled = draftLocked \|\| imageLimitReached;/);
  assert.match(js, /elements\.fileInput\.setAttribute\("aria-describedby", "imageCount"\)/);
  assert.match(js, /elements\.fileInput\.removeAttribute\("aria-describedby"\)/);
});

test('transparent-PNG invariant remains direct image/png upload plus app.bsky.embed.images', () => {
  const background = readProjectFile('background.js');
  assert.match(background, /com\.atproto\.repo\.uploadBlob/);
  assert.match(background, /"Content-Type": "image\/png"/);
  assert.match(background, /\$type: "app\.bsky\.embed\.images"/);
});

test('runtime manifest remains scoped to the established permissions and Bluesky hosts', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  assert.deepEqual(manifest.permissions, ['storage', 'theme']);
  assert.deepEqual(manifest.host_permissions, ['https://bsky.app/*', 'https://bsky.social/*']);
});


test('signed-out surfaces use a native Bluesky app-password help link with no scripted navigation', () => {
  const panelHtml = readProjectFile('panel.html');
  const popupHtml = readProjectFile('popup.html');
  const panelJs = readProjectFile('panel.js');
  const panelCss = readProjectFile('panel.css');
  const popupJs = readProjectFile('popup.js');
  const expected = /<a[^>]*href="https:\/\/bsky\.app\/settings\/app-passwords"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*>Create an app password<\/a>/;

  assert.match(panelHtml, expected);
  assert.match(popupHtml, expected);
  assert.doesNotMatch(panelJs, /settings\/app-passwords/);
  assert.doesNotMatch(popupJs, /settings\/app-passwords/);
});


test('app-password help links use Firefox-chrome-like theme colors and preserve LinkText in forced colors', () => {
  const panelCss = readProjectFile('panel.css');
  const popupHtml = readProjectFile('popup.html');

  for (const source of [panelCss, popupHtml]) {
    assert.match(source, /--nova-link:\s*light-dark\(#0060df, #c4a7ff\);/);
    assert.match(source, /color:\s*var\(--nova-link\);/);
    assert.match(source, /@media\s*\(forced-colors:\s*active\)[\s\S]*?color:\s*LinkText;/);
  }
});


test('PNG mode is limited to exactly one eligible visible native composer', () => {
  const content = readProjectFile('content.js');
  assert.match(content, /function findVisibleComposers\(\)/);
  assert.match(content, /return composers\.length === 1 \? composers\[0\] : null;/);
});

test('multi-post keeps or recreates the native PNG launcher disabled while the programmatic guard remains active', () => {
  const content = readProjectFile('content.js');
  assert.match(content, /const multipleComposers = composers\.length > 1;/);
  assert.match(content, /if \(multipleComposers && launcher\?\.isConnected\) \{[\s\S]*?launcher\.disabled = true;[\s\S]*?return launcher;/);
  assert.doesNotMatch(content, /return launcher\?\.isConnected \? launcher : null;/);
  assert.match(content, /launcher = document\.createElement\("button"\);[\s\S]*?launcher\.disabled = disabled;[\s\S]*?insertAdjacentElement\("afterend", launcher\)/);
  assert.match(content, /const disabled = multipleComposers \|\| unsupportedContext \|\| panelSuspended;/);
  assert.match(content, /launcher\.disabled = disabled;/);
  assert.match(content, /#\$\{LAUNCHER_ID\}:disabled \{[\s\S]*?color: GrayText !important;[\s\S]*?cursor: default !important;/);
});

test('native composer PNG launcher uses a presentational currentColor SVG while preserving button semantics', () => {
  const content = readProjectFile('content.js');
  assert.match(content, /launcher = document\.createElement\("button"\);[\s\S]*?launcher\.type = "button";/);
  assert.match(content, /width: 40px !important;[\s\S]*?height: 40px !important;[\s\S]*?padding: 8px !important;/);
  assert.match(content, /#\$\{LAUNCHER_ID\} > svg \{[\s\S]*?width: 22px !important;[\s\S]*?height: 22px !important;/);
  assert.match(content, /<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">[\s\S]*?<path[\s\S]*?stroke="currentColor"[\s\S]*?<path fill="currentColor" d="M/);
  assert.doesNotMatch(content, /launcher\.innerHTML\s*=\s*`[\s\S]*?<text/);
  assert.match(content, /launcher\.setAttribute\("aria-label", t\("addTransparentPngLauncher"\)\);/);
  assert.doesNotMatch(content, /launcher\.textContent = "PNG"/);
});

test('post text exposes a quiet 300-character description without a live spoken counter', () => {
  const html = readProjectFile('panel.html');
  assert.match(html, /<textarea[\s\S]*?id="postTextInput"[\s\S]*?aria-describedby="postTextLimitDescription"[\s\S]*?>/);
  assert.match(html, /<span id="postTextLimitDescription" class="sr-only"[^>]*data-i18n="postCharacterMaximum"[^>]*>300 character maximum\.<\/span>/);
  assert.doesNotMatch(html, /postTextLimitDescription[^>]*(aria-live|role="status")/);
});


test('visible post counter carries progressbar semantics for NVDA progress feedback', () => {
  const html = readProjectFile('panel.html');
  assert.match(html, /id="postTextCount"[\s\S]*?role="progressbar"[\s\S]*?aria-label="Post length"[\s\S]*?aria-valuemin="0"[\s\S]*?aria-valuemax="100"[\s\S]*?aria-valuenow="0"/);
  assert.doesNotMatch(html, /<progress\b/);
  assert.doesNotMatch(html, /<meter\b/);
  assert.doesNotMatch(html, /postTextCount[^>]*aria-live/);
  assert.doesNotMatch(html, /postTextCount[^>]*aria-hidden="true"/);
});

test('fresh-launch fallback recognizes both Bluesky new-post labels observed in live UI', () => {
  const content = readProjectFile('content.js');
  assert.match(content, /new post\|compose new post/);
});

test('signed-out toolbar launch keeps a short-lived same-tab resume intent and resumes after Bluesky login', () => {
  const content = readProjectFile('content.js');
  assert.match(content, /const PENDING_FRESH_LAUNCH_TTL_MS = 5 \* 60 \* 1000;/);
  assert.match(content, /const PENDING_FRESH_LAUNCH_STORAGE_KEY = "bskyTpngPendingFreshLaunchUntil";/);
  assert.match(content, /function markPendingFreshLaunch\(\)[\s\S]*?sessionStorage\?\.setItem/);
  assert.match(content, /if \(!composer\) \{[\s\S]*?markPendingFreshLaunch\(\);[\s\S]*?showFreshLaunchFailure\(\);/);
  assert.match(content, /async function resumePendingFreshLaunch\(\)[\s\S]*?const newPostControl = findNewPostControl\(\);[\s\S]*?newPostControl\.click\(\);[\s\S]*?await waitFor\([\s\S]*?findVisibleComposer/);
  assert.match(content, /clearPendingFreshLaunch\(\);[\s\S]*?showPanel\(\{ launchOrigin: "toolbar" \}\)/);
  assert.match(content, /function runMaintenance\(\)[\s\S]*?resumePendingFreshLaunch\(\);/);
  assert.match(content, /t\("freshLaunchFailedNotice"\)/);
  assert.match(content, /if \(document\.getElementById\("bsky-tpng-launch-error"\)\) return;/);
});

test('user-entered and dynamic image text use bidi-aware native HTML semantics', () => {
  const panelHtml = readProjectFile('panel.html');
  const popupHtml = readProjectFile('popup.html');
  const panelJs = readProjectFile('panel.js');
  const panelCss = readProjectFile('panel.css');

  assert.match(panelHtml, /id="postTextInput"[\s\S]*?dir="auto"/);
  assert.match(panelHtml, /id="passwordInput"[^>]*dir="ltr"/);
  assert.match(popupHtml, /id="passwordInput"[^>]*dir="ltr"/);
  assert.match(panelJs, /class="alt-text"[\s\S]*?dir="auto"/);
  assert.match(panelJs, /<h2 class="image-name-slot"[^>]*><bdi class="image-name" dir="auto">/);
  assert.match(panelCss, /\.image-name-slot\s*\{[\s\S]*?text-align:\s*start;/);
  assert.match(panelJs, /t\("altTextForImage", \[imagePosition, isolateBidiText\(image\.file\.name\)\]\)/);
  const i18nJs = readProjectFile('i18n.js');
  assert.match(i18nJs, /function isolateBidiText\(value\)[\s\S]*?\\u2068[\s\S]*?\\u2069/);
  assert.match(panelJs, /t\("removeImageAccessibleLabel", \[imagePosition, isolateBidiText\(image\.file\.name\)\]\)/);
  assert.match(panelJs, /count === 1\s*\? isolateBidiText\(addedImages\[0\]\.file\.name\)/);
});

test('Bluesky handles remain explicit LTR technical identifiers in both sign-in surfaces', () => {
  for (const filename of ['panel.html', 'popup.html']) {
    const html = readProjectFile(filename);
    assert.match(html, /<input[^>]*id="handleInput"[^>]*dir="ltr"[^>]*>/);
    assert.doesNotMatch(html, /<input[^>]*id="handleInput"[^>]*dir="auto"[^>]*>/);
  }
});

test('bidi-preparation uses logical CSS for inline start/end spacing and alignment', () => {
  const css = readProjectFile('panel.css');
  assert.match(css, /#cancelButton \{[\s\S]*?padding-inline-start: 0;/);
  assert.match(css, /\.alt-details \{[\s\S]*?text-align: end;/);
  assert.doesNotMatch(css, /\.image-actions \{[^}]*margin-inline-start:/);
  assert.doesNotMatch(css, /#cancelButton \{[\s\S]*?padding-left:/);
  assert.doesNotMatch(css, /\.alt-details \{[\s\S]*?text-align: right;/);
  assert.doesNotMatch(css, /\.image-actions \{[\s\S]*?margin-left:/);
});



test('normal English copy is restored after text-expansion diagnostics', () => {
  const panelHtml = readProjectFile('panel.html');
  const popupHtml = readProjectFile('popup.html');

  assert.match(panelHtml, />Add transparent PNGs<\/h1>/);
  assert.match(panelHtml, />Post<\/button>/);
  assert.match(popupHtml, />Transparent PNG Poster<\/h1>/);
  assert.match(popupHtml, />Bluesky app password<\/label>/);
  assert.doesNotMatch(panelHtml, /Add transparent PNG images to this Bluesky post/);
  assert.doesNotMatch(popupHtml, /BlueskyAnwendungspasswortAuthentifizierung/);
});

test('text-expansion layout allows translated controls and helper text to wrap without horizontal spill', () => {
  const panelCss = readProjectFile('panel.css');
  const popupHtml = readProjectFile('popup.html');

  assert.match(panelCss, /button \{[\s\S]*?height:\s*auto;[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(panelCss, /\.composer-actions \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 2fr\) minmax\(0, 1fr\);/);
  assert.match(panelCss, /@media\s*\(max-width:\s*560px\)[\s\S]*?grid-template-areas:[\s\S]*?"identity identity"[\s\S]*?"cancel post";/);
  assert.match(panelCss, /\.add-png-hint \{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(popupHtml, /button \{[\s\S]*?height:\s*auto;[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(popupHtml, /\.field-label \{[\s\S]*?overflow-wrap:\s*anywhere;/);
});

test('Add-PNG action row keeps controls vertically centered while helper text remains wrappable', () => {
  const panelCss = readProjectFile('panel.css');
  assert.match(panelCss, /\.image-actions \{[\s\S]*?align-items:\s*center;/);
  assert.match(panelCss, /\.add-png-hint \{[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
});


test('native PNG launcher does not override Bluesky keyboard-focus styling', () => {
  const source = readProjectFile('content.js');
  assert.doesNotMatch(source, /#\$\{LAUNCHER_ID\}:(?:focus-visible|focus)\s*\{/);
  // The existing native launcher remains a real button; only its focus
  // override was removed in this experiment. The Restore outline is separate.
  assert.match(source, /launcher = document.createElement\("button"\);/);
  assert.match(source, /launcher\.disabled = disabled;/);
  assert.match(source, /#\$\{PANEL_RETURN_ID\}:focus\s*\{/);
});

test('popup buttons and app-password link use the Gecko-native keyboard-visible focus outline', () => {
  const html = readProjectFile('popup.html');
  assert.match(html, /\.password-note a:focus-visible \{\s*outline: auto;\s*outline-offset: 0;/);
  assert.match(html, /button:focus-visible \{\s*outline: auto;\s*outline-offset: 3px;/);
  assert.doesNotMatch(html, /:focus-visible \{[^}]*outline: 2px solid var\(--nova-accent\)/);
});

test('panel buttons, help link and file-input proxy share the native ring; text editors retain their distinct focus styling', () => {
  const css = readProjectFile('panel.css');
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button \{\s*outline: auto;\s*outline-offset: 3px;/);
  assert.match(css, /\.login-help a:focus-visible \{\s*outline: auto;\s*outline-offset: 0;/);
  assert.match(css, /\.composer-position-picker summary:focus-visible,\s*\.page-reference-actions \.position-choice:focus-visible,\s*\.image-reorder-controls \.move-image:focus-visible \{\s*outline-offset: 0;/);
  assert.match(css, /input:focus,\s*textarea:focus \{[\s\S]*?box-shadow: 0 0 0 2px color-mix\(/);
  assert.match(css, /\.add-image-input \{[\s\S]*?clip-path: inset\(50%\)/);
  assert.doesNotMatch(css, /:focus-visible \{[^}]*outline: 2px solid var\(--nova-accent\)/);
});

test('Restore button always uses Firefox-native focus outline after pointer or keyboard Minimize', () => {
  const source = readProjectFile('content.js');
  const rule = source.match(/#\$\{PANEL_RETURN_ID\}:focus\s*\{([^}]*)\}/);
  assert.ok(rule, 'Restore uses :focus because programmatic focus may not be :focus-visible');
  assert.match(rule[1], /outline:\s*auto !important;/);
  assert.match(rule[1], /outline-offset:\s*0 !important;/);
  assert.doesNotMatch(source, /#\$\{PANEL_RETURN_ID\}:focus-visible\s*\{/);
  // The launcher deliberately has no custom focus selector in this experiment.
  assert.doesNotMatch(source, /#\$\{LAUNCHER_ID\}:(?:focus-visible|focus)\s*\{/);
});


test('Minimize button uses Firefox-native :focus outline after pointer or keyboard Restore', () => {
  const css = readProjectFile('panel.css');
  const rule = css.match(/#readPageButton:focus\s*\{([^}]*)\}/);
  assert.ok(rule, 'Minimize uses :focus because Restore programmatically focuses it');
  assert.match(rule[1], /outline:\s*auto;/);
  assert.match(rule[1], /outline-offset:\s*0;/);
  assert.doesNotMatch(css, /#readPageButton:focus-visible\s*\{/);
  // Other controls still use Firefox-native :focus-visible modality semantics.
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button\s*\{\s*outline:\s*auto;/);
  assert.match(css, /\.composer-position-picker summary:focus-visible,\s*\.page-reference-actions \.position-choice:focus-visible,\s*\.image-reorder-controls \.move-image:focus-visible\s*\{\s*outline-offset:\s*0;/);
});
