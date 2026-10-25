import test from 'node:test';
import assert from 'node:assert/strict';
import { readProjectFile } from './helpers.mjs';

// Keep the styling-only refinement scoped to the existing two native buttons.
test('reordering arrows share a grouped visual container; remove aligns without positional offset', () => {
  const css = readProjectFile('panel.css');
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start !== -1, `missing CSS selector ${selector}`);
    return css.slice(start, css.indexOf('}', start));
  };
  assert.match(rule('.image-reorder-controls'), /border: 1px solid var\(--nova-border-subtle\);/);
  assert.match(rule('.image-reorder-controls'), /border-radius: var\(--nova-radius-circle\);/);
  assert.match(rule('.secondary.move-image'), /background: transparent;/);
  assert.match(rule('.secondary.move-image:last-child'), /border-inline-start: 1px solid var\(--nova-border-subtle\);/);
  assert.match(rule('.secondary.remove-image'), /min-height: 28px;/);
  assert.doesNotMatch(rule('.secondary.remove-image'), /top:|transform:/);
  assert.match(css, /button:focus-visible,\s*\.composer-position-picker summary:focus-visible,\s*\.add-image-input:focus-visible \+ \.add-image-button\s*\{\s*outline:\s*auto;/);
  assert.match(css, /button:disabled\s*\{[^}]*opacity: 0\.5;/);
});
