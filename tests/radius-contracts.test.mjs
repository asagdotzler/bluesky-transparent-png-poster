import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(root, 'panel.css'), 'utf8');
const content = readFileSync(join(root, 'content.js'), 'utf8');
const popup = readFileSync(join(root, 'popup.html'), 'utf8');

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`, 'm'));
  assert.ok(match, `Missing rule for ${selector}`);
  return match[1];
}

test('composer surfaces use accepted 16/12/8/6px radius system', () => {
  assert.match(css, /--nova-radius-medium:\s*8px;/);
  assert.match(css, /--nova-radius-large:\s*12px;/);
  assert.match(cssBlock('.image-card'), /border-radius:\s*var\(--nova-radius-large\);/);
  assert.match(cssBlock('.image-preview'), /border-radius:\s*var\(--nova-radius-medium\);/);
  assert.match(css, /--nova-radius-small:\s*6px;/);
  assert.match(css, /input,\s*textarea\s*\{[\s\S]*?border-radius:\s*var\(--nova-radius-small\);/);
  assert.match(content, /panelDialog\.style\.cssText\s*=\s*`[\s\S]*?border-radius:\s*16px;/);
});

test('ordinary buttons use restrained radius while circular controls remain round', () => {
  assert.match(css, /--nova-radius-xlarge:\s*12px;/);
  assert.match(css, /--nova-radius-circle:\s*9999px;/);
  assert.match(cssBlock('button'), /border-radius:\s*var\(--nova-radius-xlarge\);/);
  assert.match(cssBlock('.add-image-button'), /border-radius:\s*var\(--nova-radius-circle\);/);
  assert.match(content, /#\$\{LAUNCHER_ID\} \{[\s\S]*?border-radius:\s*24px !important;/);
});

test('Firefox toolbar popup radii remain unchanged', () => {
  assert.deepEqual([...popup.matchAll(/border-radius:\s*(\d+)px/g)].map(m => Number(m[1])), [2, 12, 24]);
});
