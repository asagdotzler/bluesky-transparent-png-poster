import test from 'node:test';
import assert from 'node:assert/strict';
import {readProjectFile} from './helpers.mjs';

const content = readProjectFile('content.js');

test('v2.8.242 accepts zero or one avatar but still requires exact unrestricted interactions', () => {
  assert.match(content, /avatars\?\.length === 0 \|\| avatars\?\.length === 1/);
  assert.match(content, /hasUnrestrictedComposerInteraction\(root\)/);
  assert.match(content, /gates\?\.length === 1/);
});

test('v2.8.242 quote and attachment guard rejects additional ComposerPost children', () => {
  assert.match(content, /function hasTextOnlyNativeComposerPost\(root\)/);
  assert.match(content, /return post\.children\?\.length === 1/);
  assert.match(content, /hasTextOnlyNativeComposerPost\(root\)/);
});

test('v2.8.242 waits for native shade on successful Cancel only', () => {
  assert.match(content, /function waitForNativeComposerShade\(root\)/);
  assert.match(content, /animation\.animationName === "fadeIn"/);
  assert.match(content, /setTimeout\(finish, 250\)/);
  assert.match(content, /if \(nativeShadeFade\) await nativeShadeFade/);
});

test('v2.8.242 matches upstream native shade and extension manifest version', () => {
  assert.match(content, /background: rgba\(0, 0, 0, 0\.8\) !important/);
  assert.equal(JSON.parse(readProjectFile('manifest.json')).version, '1.0.0');
});
