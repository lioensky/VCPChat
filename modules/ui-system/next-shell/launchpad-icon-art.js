/* Launchpad-only artwork. Tray and tab SVGs remain independent. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.VCPNextShell = Object.freeze({ ...root.VCPNextShell, ...api });
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
'use strict';
function gradient(c,x,y,x2,y2,colors){const g=c.createLinearGradient(x,y,x2,y2);colors.forEach((v,i)=>g.addColorStop(i/(colors.length-1),v));return g}
function box(c,x,y,w,h,r,fill){c.beginPath();c.roundRect(x,y,w,h,r);c.fillStyle=fill;c.fill()}
function line(c,points,color,width=2){c.beginPath();points.forEach((p,i)=>i?c.lineTo(...p):c.moveTo(...p));c.strokeStyle=color;c.lineWidth=width;c.lineCap='round';c.lineJoin='round';c.stroke()}
function circle(c,x,y,r,fill){c.beginPath();c.arc(x,y,r,0,Math.PI*2);c.fillStyle=fill;c.fill()}
function text(c,value,x,y,size,color){c.fillStyle=color;c.font=`700 ${size}px "Segoe UI",sans-serif`;c.textAlign='center';c.fillText(value,x,y)}
function paint(s,t){
const {c,canvas,data}=s,[type,,,accent]=data;
const size=s.size || 256;
if(!size)return;
if(canvas.width!==size){canvas.width=size;canvas.height=size}
c.setTransform(size/128,0,0,size/128,0,0);c.clearRect(0,0,128,128);
const e=s.energy,b=Math.sin(t*2)*e;
c.save();
c.translate(64,112);c.scale(1,.19);const shadow=c.createRadialGradient(0,0,1,0,0,43);shadow.addColorStop(0,accent+'35');shadow.addColorStop(1,accent+'00');circle(c,0,0,43,shadow);c.restore();
c.save();c.translate(64+s.x*3*e,64+s.y*2*e-b*2);c.scale(1+s.kick*.065,1+s.kick*.065);c.translate(-64,-64);
c.shadowColor='#00000028';c.shadowBlur=7;c.shadowOffsetY=4;
if(type==='notes'){
c.save();c.translate(64,64);c.rotate(-.12-b*.025);box(c,-32,-37,61,78,9,'#7455bf');c.restore();
box(c,35,23,61,79,8,gradient(c,35,23,96,102,['#fff8ee','#d8ccff']));c.shadowBlur=0;
box(c,43,35,23,6,3,'#9e83d6');
for(let i=0;i<4;i++)box(c,43,51+i*10,Math.max(5,36-i*4+Math.sin(t*2-i)*e*4),3,2,'#ad9dc7');
c.save();c.translate(87+Math.sin(t*2)*e*5,69+b*3);c.rotate(.55);box(c,-5,-28,10,48,3,gradient(c,-5,0,5,0,['#ff8199','#ffbc9b']));line(c,[[-4,20],[0,29],[4,20]],'#fff1d5',3);c.restore();
}else if(type==='music'){
box(c,24,26,80,78,23,gradient(c,24,26,104,104,['#ff9daf','#bc397d']));
c.shadowBlur=0;circle(c,63,62,30,'#312138');
for(let r=16;r<29;r+=4){c.beginPath();c.arc(63,62,r,0,7);c.strokeStyle='#ffffff15';c.lineWidth=1;c.stroke()}
c.save();c.translate(63,62);c.rotate(t*e*.6);line(c,[[0,-26],[10,-16]],'#ffffff44',3);circle(c,0,0,10,'#ffb99e');circle(c,0,0,3,'#502640');c.restore();
for(let i=0;i<5;i++)box(c,76+i*5,99-(9+(Math.sin(t*4+i)*.5+.5)*15*e),3,9+(Math.sin(t*4+i)*.5+.5)*15*e,2,'#fff1dd');
}else if(type==='translator'){
c.save();c.translate(47,51-b*2);c.rotate(-.15);box(c,-27,-26,53,53,12,gradient(c,0,-26,0,27,['#b1fff0','#44bfb3']));text(c,'文',0,9,29,'#176c69');c.restore();
c.save();c.translate(81,78+b*2);c.rotate(.13);box(c,-26,-25,52,52,12,gradient(c,0,-25,0,27,['#eaffff','#b6cbff']));text(c,'A',0,10,32,'#556fa4');c.restore();
line(c,[[79,26],[95,32],[99,43]],'#bcf9ed',3);line(c,[[94,40],[99,44],[103,38]],'#bcf9ed',3);
}else if(type==='canvas'){
box(c,19,27,90,73,12,gradient(c,19,27,109,100,['#bddfff','#688ac6']));c.shadowBlur=0;
box(c,24,32,80,62,8,'#253650');
for(let i=0;i<3;i++)circle(c,32+i*7,39,1.8,['#ffad9d','#ffdd9b','#9fe4dc'][i]);
box(c,28,46,15,43,3,'#ffffff10');
for(let i=0;i<4;i++){box(c,31,51+i*8,8,2,1,'#7896bb');box(c,49+(i%2)*6,52+i*9,25-i*3,3,1,i%2?'#bba4ff':'#9ce8dc')}
const x=77+s.x*e*4,y=60+b*2;
line(c,[[x,y],[x+2,y+14],[x+6,y+10],[x+12,y+9],[x,y]],'#ffbb9b',2);
box(c,49,76-b,2,12,1,'#b4a1ff');box(c,49,74-b,13,3,1,'#b4a1ff');
line(c,[[42,105],[80,105],[76,101]],'#a6e8e4',2);
line(c,[[86,20],[48,20],[52,24]],'#b4baff',2);
circle(c,44+(Math.sin(t*2)*.5+.5)*35,105,2.5,'#eafffb');
}else if(type==='memo'){
circle(c,64,65,31,gradient(c,40,35,87,95,['#f7caff','#9451cd','#55379b']));c.shadowBlur=0;
for(let i=0;i<3;i++){c.save();c.translate(64,65);c.rotate(i*1.04+t*.12*e);c.beginPath();c.ellipse(0,0,44,19,0,0,7);c.strokeStyle=['#e9b8ff','#c199ff','#ffc5e4'][i];c.lineWidth=2;c.stroke();circle(c,44*Math.cos(t*.7+i*2),19*Math.sin(t*.7+i*2),4,'#fff0ff');c.restore()}
circle(c,54,55,7,'#ffffff45');
}else if(type==='forum'){
box(c,21,30-b,67,49,15,gradient(c,21,30,88,79,['#ffe1a1','#ef9564']));line(c,[[35,74],[32,86],[47,78]],'#efaa75',6);
box(c,56,61+b,51,36,12,gradient(c,56,61,107,97,['#ffb3a5','#d96c88']));line(c,[[93,92],[98,103],[84,96]],'#dd788a',5);c.shadowBlur=0;
for(let i=0;i<3;i++)circle(c,39+i*15,54+Math.sin(t*4-i)*e*2,3.5,'#986540');
for(let i=0;i<2;i++)box(c,67,72+i*9,27-i*8,3,2,'#ffe7e5');
}else if(type==='dice'){
c.save();c.translate(64,63);c.rotate(-.18+Math.sin(t*3)*e*.1);
box(c,-32,-28,67,71,15,'#ca6656');box(c,-35,-35,67,67,14,gradient(c,-35,-35,32,32,['#fff4dc','#ffc9a4']));c.shadowBlur=0;
[[-18,-18],[15,-18],[-2,-2],[-18,15],[15,15]].forEach(p=>{circle(c,p[0],p[1]+1,5,'#d5866a');circle(c,p[0],p[1]-1,4,'#9b534d')});c.restore();
text(c,'✦',103,32+b*2,17,'#ffd4a0');
}else if(type==='rag'){
c.save();c.translate(64,64);c.rotate(-.1);
box(c,-41,-40,82,82,15,gradient(c,-41,-40,41,42,['#b9f4cf','#488e82']));
c.shadowBlur=0;c.beginPath();c.roundRect(-36,-35,72,72,11);c.clip();
box(c,-36,-35,72,72,0,'#245750');
for(let j=-3;j<=3;j++){
c.beginPath();
for(let y=-40;y<=42;y+=2){const x=Math.sin(y*.075)*14+j*10;y===-40?c.moveTo(x,y):c.lineTo(x,y)}
c.strokeStyle='#a8e8b640';c.lineWidth=1;c.stroke();
}
const river=()=>{c.beginPath();for(let y=-40;y<=42;y+=2){const x=Math.sin(y*.075)*14;y===-40?c.moveTo(x,y):c.lineTo(x,y)}};
river();c.strokeStyle='#70dfcd';c.lineWidth=12;c.stroke();
river();c.strokeStyle='#c7ffea';c.lineWidth=2;c.setLineDash([3,9]);c.lineDashOffset=-t*12;c.stroke();c.setLineDash([]);
line(c,[[-35,-9],[-24,-5],[-10,7]],'#70dfcd',5);
for(let i=0;i<3;i++){const y=-24+i*24;circle(c,Math.sin(y*.075)*14,y,4,'#ecffe3');circle(c,Math.sin(y*.075)*14,y,1.8,'#448d7d')}
c.restore();
line(c,[[93,29],[93,44],[89,40]],'#ddffdd',2);
line(c,[[29,105],[48,105]],'#baffdf',2);
}else if(type==='themes'){
c.save();c.translate(64,64);c.rotate(t*.18*e);
const colors=['#ff9fae','#ffc582','#f7ed99','#9be5bd','#8bc9f5','#b7a0f0'];
colors.forEach((color,i)=>{c.save();c.rotate(i*Math.PI/3);c.globalAlpha=.88;box(c,-15,-44,30,52,15,gradient(c,0,-44,0,8,[color,color+'99']));c.restore()});
c.shadowBlur=0;circle(c,0,0,13,'#fff1ea');circle(c,0,0,6,'#dbc3d1');c.restore();
}else if(type==='loom'){
c.shadowBlur=0;const points=[];
for(let i=0;i<5;i++){const a=i*Math.PI*2/5+t*.22*e;points.push([64+Math.cos(a)*37,64+Math.sin(a)*34])}
points.forEach((p,i)=>{line(c,[[64,64],p],'#8faeff80',2);line(c,[p,points[(i+1)%5]],'#8faeff35',1)});
points.forEach((p,i)=>circle(c,...p,i%2?7:9,gradient(c,p[0]-8,p[1]-8,p[0]+8,p[1]+8,['#cff6ff','#5789da'])));
c.shadowColor='#839dff66';c.shadowBlur=13;box(c,47,47,34,34,11,gradient(c,47,47,81,81,['#d6d9ff','#7970d7']));c.shadowBlur=0;line(c,[[57,64],[62,69],[72,58]],'#fff',3);
}else if(type==='terminal'){
box(c,21,29,87,73,13,gradient(c,21,29,108,102,['#768475','#283a35']));box(c,24,31,81,65,10,'#172723');c.shadowBlur=0;
for(let i=0;i<3;i++)circle(c,34+i*9,40,2,['#ec977d','#ead99a','#a9e895'][i]);
line(c,[[36,56],[44,63],[36,70]],'#bbf5a0',3);box(c,51,68,13,3,1,'#bbf5a0');
for(let i=0;i<3;i++)box(c,36,80+i*4,25+((i*13)%22),1,1,'#94ba9440');
c.globalAlpha=.5+.5*Math.cos(t*4);box(c,71,57,7,15,1,'#c1ffa4');c.globalAlpha=1;
}else if(type==='desktop'){
box(c,57,85,15,20,3,'#7888c4');box(c,42,102,46,5,3,gradient(c,42,102,88,107,['#bac8f6','#7282b1']));
box(c,18,25,92,66,11,gradient(c,18,25,110,91,['#c9d4ff','#6575ac']));
c.save();c.beginPath();c.roundRect(23,30,82,52,7);c.clip();box(c,23,30,82,52,0,gradient(c,23,30,105,82,['#232757','#6179ba']));
for(let i=0;i<3;i++){c.beginPath();c.moveTo(20,68+i*10);c.bezierCurveTo(47,22+i*13+Math.sin(t+i)*e*8,62,95-i*5,111,35+i*19);c.lineTo(111,89);c.lineTo(20,89);c.fillStyle=['#ac8eff','#73c5e0','#a3e6da'][i];c.fill()}
c.restore();c.shadowBlur=0;box(c,33-b,40,29,22,4,'#ffffffb0');box(c,38-b,45,16,3,1,'#7d82b0');box(c,72+b,51,23,24,4,'#263264bb');box(c,77+b,57,13,3,1,'#c4c2ff');circle(c,64,86,1.5,'#e3eaff');
}else if(type==='noteMini'){
c.save();c.translate(64,65);c.rotate(-.12+b*.025);
box(c,-34,-37,68,75,9,gradient(c,-34,-37,34,38,['#fff3af','#efb959']));
c.shadowBlur=0;box(c,-21,-17,35,4,2,'#c38a43');box(c,-21,-5,42,3,2,'#d2a45b');box(c,-21,6,27,3,2,'#d2a45b');
c.beginPath();c.moveTo(12,38);c.lineTo(34,16);c.lineTo(12,16);c.closePath();c.fillStyle='#fff9d2';c.fill();c.restore();
circle(c,64,25+b,5,'#e99685');
}else if(type==='scriptorium'){
box(c,26,27,73,76,10,'#6671a5');box(c,30,24,69,73,9,gradient(c,30,24,99,97,['#ffedd5','#e2c6a2']));
c.shadowBlur=0;line(c,[[42,38],[42,86]],'#b8a087',2);
for(let i=0;i<4;i++)box(c,50,43+i*11,29-i*4,2,1,'#ae937b');
c.save();c.translate(85,57+b);c.rotate(.35);
c.beginPath();c.moveTo(-9,30);c.bezierCurveTo(-15,3,3,-24,13,-30);c.bezierCurveTo(25,-6,10,17,-9,30);c.fillStyle=gradient(c,0,-30,0,30,['#b3e8db','#478a92']);c.fill();
line(c,[[-9,32],[9,-19]],'#e0fff3',1.5);c.restore();
}else if(type==='log'){
box(c,28,23,68,80,10,gradient(c,28,23,96,103,['#dae6ed','#819dad']));c.shadowBlur=0;
box(c,35,33,54,57,5,'#223d4c');
for(let i=0;i<5;i++){circle(c,42,43+i*9,2,i===2?'#ffc99b':'#90d9ca');box(c,49,41+i*9,20+(i%3)*5,2,1,'#b7d5df')}
box(c,35,94,25,3,1,'#e3eff5');box(c,70+b*3,94,17,3,1,'#9fefd5');
}else if(type==='database'){
for(let i=2;i>=0;i--){
const y=36+i*23;
box(c,29,y,70,25,4,gradient(c,29,y,99,y,['#6996c9','#acdce9','#537dad']));
c.beginPath();c.ellipse(64,y,35,11,0,0,7);c.fillStyle=i===0?'#d4f2f5':'#a5d4e2';c.fill();
circle(c,87,y+16,2.5,'#c0ffe0');box(c,39,y+14,16+Math.sin(t*2+i)*e*3,2,1,'#e0faff80');
}
}else if(type==='task'){
box(c,32,24,66,80,10,gradient(c,32,24,98,104,['#d5f4e3','#73b69f']));
box(c,46,19,36,13,5,'#4b887e');c.shadowBlur=0;
for(let i=0;i<3;i++){box(c,42,43+i*18,10,10,3,'#f1fff0');line(c,[[44,48+i*18],[47,51+i*18],[51,45+i*18]],'#46897a',2);box(c,59,46+i*18,25-i*4,3,1,'#4f897b')}
circle(c,96,94,13,'#f0d899');line(c,[[90,94],[95,99],[103,88]],'#947642',2.5);
}else if(type==='toolbox'){
line(c,[[48,37],[48,26],[80,26],[80,37]],'#e7c29a',6);
box(c,24,39,81,62,11,gradient(c,24,39,105,101,['#edbd84','#b66e4e']));c.shadowBlur=0;
box(c,24,40,81,22,9,'#f8d6a3');line(c,[[29,65],[100,65]],'#995c43',2);
box(c,57,56,15,19,4,'#ffedce');
c.save();c.translate(87,73);c.rotate(.3+b*.05);line(c,[[0,17],[0,-10]],'#d7e8e8',7);line(c,[[-6,-18],[-6,-10],[6,-10],[6,-18]],'#d7e8e8',4);c.restore();
}else if(type==='plugin'||type==='widgets'){
const colors=type==='plugin'?['#b5a0f3','#89d9db','#eeb4d2','#f0d099']:['#99c8fa','#cab2f1','#9fe0c3','#ffd2ab'];
for(let i=0;i<4;i++){const x=29+(i%2)*38,y=28+Math.floor(i/2)*39+(i===3?b*2:0);box(c,x,y,33,33,9,gradient(c,x,y,x+33,y+33,[colors[i],'#817caf']));c.shadowBlur=0;if(type==='plugin'){circle(c,x+16,y,5,colors[i]);circle(c,x+33,y+16,5,colors[i])}else{box(c,x+8,y+9,17,3,1,'#ffffffa0');box(c,x+8,y+16,11,3,1,'#ffffff70')}}
}
c.restore();
}

return { paintLaunchpadIcon: paint };
});
