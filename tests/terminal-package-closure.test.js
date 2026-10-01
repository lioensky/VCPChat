
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {minimatch}=require('minimatch');const root=path.resolve(__dirname,'..');const pkg=require('../package.json');
test('packaged terminal includes its executor, GUI, admin helper and native dependencies',()=>{
 const prefix='VCPDistributedServer/Plugin/PowerShellExecutor/';
 const required=['PowerShellExecutor.js','nativeHelperPath.js','plugin-manifest.json','AdminConfirm.py',...fs.readdirSync(path.join(root,prefix,'gui'),{recursive:true}).map(file=>'gui/'+String(file).replaceAll('\\','/'))];
 for(const file of required){const relative=prefix+file;if(fs.statSync(path.join(root,relative)).isFile())assert.ok(pkg.build.files.some(pattern=>minimatch(relative,pattern)),relative);}
 for(const dependency of ['node-pty','tmp','chokidar','xterm','xterm-addon-fit'])assert.ok(pkg.dependencies[dependency],dependency);
 assert.ok(pkg.build.asarUnpack.includes('node_modules/node-pty/**/*'));
 assert.ok(pkg.build.asarUnpack.some(pattern=>minimatch(prefix+'AdminConfirm.py',pattern)),'Python script must be physically unpacked for external execution');
 assert.equal(pkg.build.files.some(pattern=>minimatch(prefix+'config.env',pattern)),false,'local configuration stays outside the package');
});
