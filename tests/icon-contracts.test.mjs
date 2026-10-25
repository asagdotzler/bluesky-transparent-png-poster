import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

test('Firefox action and Add-ons Manager use the scalable C3 symbol', () => {
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal(manifest.action.default_icon, 'icons/png-toolbar.svg');
  assert.equal(manifest.icons['32'], 'icons/png.svg');
  assert.equal(manifest.icons['64'], 'icons/png.svg');
  assert.equal(manifest.icons['96'], 'icons/png.svg');
});

test('main Add-ons icon stays at original C3 size; toolbar receives a modestly magnified crop', () => {
  const addons = readProjectFile('icons/png.svg');
  const toolbar = readProjectFile('icons/png-toolbar.svg');
  assert.match(addons, /viewBox="0 0 24 24"/);
  assert.match(toolbar, /viewBox="1.5 1.5 21 21"/);
  const pathValues = (s) => [...s.matchAll(/<path\s+d="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(pathValues(toolbar), pathValues(addons), 'both assets use identical SVG path geometry');
});

test('toolbar SVG supports Firefox color schemes and does not depend on installed fonts', () => {
  const svg = readProjectFile('icons/png-toolbar.svg');
  assert.match(svg, /<svg\s+xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="1.5 1.5 21 21"/);
  assert.match(svg, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(svg, /@media\s*\(forced-colors:\s*active\)/);
  assert.match(svg, /CanvasText/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /fill="currentColor"/);
  assert.doesNotMatch(svg, /<text\b|font-family|<image\b|<script\b|<use\b|<foreignObject\b/);
});

test('native composer launcher reuses exactly the C3 vector geometry, without altering focus or semantics', () => {
  const content = readProjectFile('content.js');
  const svg = readProjectFile('icons/png.svg');
  const pathValues = [...svg.matchAll(/<path\s+d="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(pathValues.length, 2);
  for (const d of pathValues) {
    assert.ok(content.includes(`d="${d}"`), 'launcher must embed same vector path as Add-ons icon');
  }
  assert.match(content, /<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
  assert.match(content, /launcher\.setAttribute\("aria-label", t\("addTransparentPngLauncher"\)\)/);
  assert.doesNotMatch(content, /#\$\{LAUNCHER_ID\}:(?:focus-visible|focus)\s*\{/);
  assert.match(content, /const multipleComposers = composers\.length > 1;/);
});


test('native launcher C3 glyph is modestly smaller without changing its 40px button', () => {
  const content = readProjectFile('content.js');
  assert.match(content, /#\$\{LAUNCHER_ID\}\s*\{[\s\S]*?width: 40px !important;[\s\S]*?height: 40px !important;/);
  assert.match(content, /#\$\{LAUNCHER_ID\} > svg \{[\s\S]*?width: 22px !important;[\s\S]*?height: 22px !important;/);
});
