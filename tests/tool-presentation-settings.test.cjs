const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const SettingsManager=require('../modules/utils/appSettingsManager');
test('main-process validator retains tool modes on disk and across a new manager',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vcp-tool-settings-'));
 const file=path.join(dir,'settings.json');
 try {
  const manager=new SettingsManager(file);
  fs.writeFileSync(file,JSON.stringify(manager.defaultSettings));
  await manager.updateSettings({appearanceProfile:{...manager.defaultSettings.appearanceProfile,toolPresentation:'grouped',toolExpansion:'none'}});
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(saved.appearanceProfile.toolPresentation,'grouped');assert.equal(saved.appearanceProfile.toolExpansion,'none');
  const restarted=new SettingsManager(file);
  const read=await restarted.readSettings();assert.equal(read.appearanceProfile.toolPresentation,'grouped');assert.equal(read.appearanceProfile.toolExpansion,'none');
  for (const mode of ['inline','process']) {
   await restarted.updateSettings({appearanceProfile:{...read.appearanceProfile,toolPresentation:mode}});
   assert.equal((await new SettingsManager(file).readSettings()).appearanceProfile.toolPresentation,mode);
  }
 } finally {assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('vcp-tool-settings-'));fs.rmSync(dir,{recursive:true,force:true});}
});
