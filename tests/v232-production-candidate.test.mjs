import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readProjectFile} from './helpers.mjs';
const m=JSON.parse(readProjectFile('manifest.json'));
const hash=p=>createHash('sha256').update(readProjectFile(p)).digest('hex');
test('v234 production candidate has correct version, original extension identity and locale',()=>{
  assert.equal(m.version,'1.0.0');
  assert.equal(m.browser_specific_settings.gecko.id,'bluesky-transparent-png@asagdotzler.github.io');
  assert.equal(m.default_locale,'en');
  assert.match(readProjectFile('panel.html'),/panel\.css\?v=1\.0\.0/);
});
test('v242 source matches Firefox-accepted bytes while v201 publisher and bridge files remain unchanged',()=>{
  assert.equal(hash('background.js'),'19c88d43354eda2e2a04f1a6f6f1f9efad902f0c0fa56687a6cb2b34cec4ea50');
  assert.equal(hash('content.js'),'d1df3bcca2e706946ee1405077d5b4afee4184fa7262a58519c31540b8a56427');
  assert.equal(hash('toolbar-transition.js'),'f997133c038ebcf62cea0bc28057ceb7a39e5a5fa7da3fbc4107450be631a9a5');
});
