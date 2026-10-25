import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

const html = readProjectFile('panel.html');
const js = readProjectFile('panel.js');
const css = readProjectFile('panel.css');

test('attachment list uses native ol/li with headings, not ARIA role replacements', () => {
  assert.match(html, /<ol id="imageList" class="images"><\/ol>/);
  assert.match(js, /<li class="image-card">/);
  assert.match(js, /<h2 class="image-name-slot" title="\$\{imageName\}"><bdi class="image-name" dir="auto">\$\{imageName\}<\/bdi><\/h2>/);
  assert.match(js, /<\/li>/);
  assert.doesNotMatch(js, /role="(?:list|listitem|heading)"/);
  assert.doesNotMatch(js, /document\.createElement\("(?:li|h2)"\)/);
});

test('list and heading reset only UA styling while preserving the card layout', () => {
  const list = css.match(/\.images \{([^}]+)\}/)?.[1];
  assert.ok(list);
  assert.match(list, /display:\s*grid;/);
  assert.match(list, /gap:\s*10px;/);
  assert.match(list, /margin:\s*0;/);
  assert.match(list, /padding:\s*0;/);
  assert.match(list, /list-style:\s*none;/);
  const name = css.match(/\.image-name-slot \{([^}]+)\}/)?.[1];
  assert.match(name ?? '', /margin:\s*0;/);
  assert.match(name ?? '', /font-size:\s*12px;/);
  assert.match(name ?? '', /text-align:\s*start;/);
  assert.match(css, /\.image-card \{\s*display:\s*grid;/);
  assert.doesNotMatch(css, /\.image-card\s*\{[^}]*display:\s*contents;/);
});
