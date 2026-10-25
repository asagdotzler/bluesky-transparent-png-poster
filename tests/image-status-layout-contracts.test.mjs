import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

test('attachment status spans both columns at ordinary widths and high zoom', () => {
  const css = readProjectFile('panel.css');
  const card = css.match(/\.image-card\s*\{([^}]+)\}/)?.[1];
  assert.ok(card, 'base image card grid must exist');
  assert.match(card, /"header header"\s*"preview meta"\s*"footer footer"/);
  const compact = css.match(/@media\s*\(max-width:\s*500px\)\s*\{[\s\S]*?\.image-card\s*\{([^}]+)\}/)?.[1];
  assert.ok(compact, 'narrow-layout card grid must exist');
  assert.match(compact, /"header header"\s*"preview meta"\s*"footer footer"/);
  assert.match(css, /\.image-footer\s*\{[^}]*grid-area:\s*footer;/);
  assert.match(css, /\.image-status-row\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(css, /\.image-color-note\s*\{[^}]*order:\s*2;[^}]*flex:\s*0 0 100%;[^}]*display:\s*flex;/);
  assert.match(css, /\.alt-details\s*\{[^}]*order:\s*1;/);
  assert.match(css, /\.image-status-row\s*\{[^}]*justify-content:\s*space-between;/);
  assert.match(css, /\.image-color-note svg\s*\{[^}]*width:\s*14px;/);
});

test('color warning remains in document without duplicating the native alt-text focus description', () => {
  const src = readProjectFile('panel.js');
  assert.match(src, /aria-describedby="\$\{altDetailsId\}-sr"/);
  assert.doesNotMatch(src, /aria-describedby="\$\{altDetailsId\}-sr\$\{image\.colorInfoChanged/);
  assert.match(src, /class="image-color-note"><svg aria-hidden="true" focusable="false" width="14" height="14"/);
  assert.match(src, /<span>\$\{escapeHtml\(t\("colorMayChangeAfterResize"\)\)\}<\/span>/);
  assert.doesNotMatch(src, /class="image-color-note"[^>]*role="alert"/);
});


test('PNG iframe loads stylesheet for this manifest version, not cached previous CSS', () => {
  const html = readProjectFile('panel.html');
  const manifest = JSON.parse(readProjectFile('manifest.json'));
  assert.match(html, /<link rel="stylesheet" href="panel\.css\?v=([0-9.]+)">/);
  const version = html.match(/panel\.css\?v=([0-9.]+)/)?.[1];
  assert.equal(version, manifest.version);
});

test('decorative note SVG has intrinsic sizing if CSS loads out of sync', () => {
  const src = readProjectFile('panel.js');
  assert.match(src, /class="image-color-note"><svg aria-hidden="true" focusable="false" width="14" height="14"/);
});
