import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readProjectFile} from './helpers.mjs';
const m=JSON.parse(readProjectFile('manifest.json'));
const content=readProjectFile('content.js');
const css=readProjectFile('panel.css');
const panel=readProjectFile('panel.html');
const sha=(name)=>createHash('sha256').update(readProjectFile(name)).digest('hex');

test('v234 retains accepted extension identity and loads the CSS with the new cache key',()=>{
  assert.equal(m.version,'1.0.0');
  assert.equal(m.browser_specific_settings.gecko.id,'bluesky-transparent-png@asagdotzler.github.io');
  assert.equal(m.default_locale,'en');
  assert.match(panel,/href="panel\.css\?v=1\.0\.0"/);
});
test('v234 uses iframe-scoped native CSS boundary containment, with no event interception',()=>{
  assert.match(css,/html,\s*body\s*\{\s*overscroll-behavior-y:\s*contain;/);
  assert.doesNotMatch(css,/overscroll-behavior-y:\s*none/);
  assert.match(css,/body\s*\{\s*margin:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  assert.doesNotMatch(readProjectFile('toolbar-transition.css'),/overscroll-behavior/);
  assert.doesNotMatch(content,/overscroll-behavior/);
});
test('v242 content matches accepted build and publisher/bridge remain byte-identical to v201',()=>{
  assert.equal(sha('background.js'),'19c88d43354eda2e2a04f1a6f6f1f9efad902f0c0fa56687a6cb2b34cec4ea50');
  assert.equal(sha('content.js'),'d1df3bcca2e706946ee1405077d5b4afee4184fa7262a58519c31540b8a56427');
  assert.equal(sha('toolbar-transition.js'),'f997133c038ebcf62cea0bc28057ceb7a39e5a5fa7da3fbc4107450be631a9a5');
  assert.doesNotMatch(readProjectFile('background.js'),/ENABLE_STABLE_WRITE_EXPERIMENT|ENABLE_READ_ONLY_RECOVERY_EXPERIMENT/);
  assert.doesNotMatch(readProjectFile('panel.js'),/ENABLE_COMPOSER_STABLE_WRITE_EXPERIMENT/);
});
test('v234 existing production Minimize closes modal and waits for native composer dismissal',()=>{
  const start=content.indexOf('  async function suspendPanel() {');
  const end=content.indexOf('  function restoreSuspendedPanel()',start);
  assert.ok(start>=0&&end>start);
  const block=content.slice(start,end);
  assert.match(block,/panelDialog\.close\(\)/);
  assert.match(block,/await dismissOwnedNativeComposerAfterPost\(ownedRoot\)/);
  assert.match(block,/const gone = await waitFor\(/);
  assert.match(block,/if \(!gone\)/);
  assert.match(block,/panelSuspended = true;/);
  assert.match(block,/panelReturnButton\.hidden = false;/);
  assert.match(block,/if \(!panelDialog\.open\) panelDialog\.showModal\(\)/);
  assert.match(content.slice(end,content.indexOf('  function preparePendingPanelOpen()',end)),/panelDialog\.showModal\(\)/);
});
