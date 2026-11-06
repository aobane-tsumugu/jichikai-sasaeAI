// 写真の位置を送るだけ。検出、Canvas、画素の変更は使わない。
export const EDITOR_SCRIPT = `document.querySelectorAll('[data-photo-editor]').forEach(function(root){
 const input=root.querySelector('input[name=masks]');let boxes=JSON.parse(input.value),start=null;
 function draw(){root.querySelectorAll('button').forEach(function(b){b.remove()});input.value=JSON.stringify(boxes);
 boxes.forEach(function(b,i){const btn=document.createElement('button');btn.type='button';btn.setAttribute('aria-label','隠す範囲'+(i+1)+'を外す');
 btn.style.cssText='position:absolute;min-width:44px;min-height:44px;padding:0;border:3px solid white;background:rgba(0,0,0,.25);';
 btn.style.left=(b.x*100)+'%';btn.style.top=(b.y*100)+'%';btn.style.width=(b.width*100)+'%';btn.style.height=(b.height*100)+'%';
 btn.onclick=function(){boxes.splice(i,1);draw()};root.appendChild(btn)})}
 function point(e){const r=root.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))}}
 root.addEventListener('pointerdown',function(e){if(e.target.closest('button'))return;start=point(e);root.setPointerCapture(e.pointerId)});
 root.addEventListener('pointerup',function(e){if(!start)return;const end=point(e),r=root.getBoundingClientRect(),w=Math.max(Math.abs(start.x-end.x),64/r.width),h=Math.max(Math.abs(start.y-end.y),64/r.height);
 const x=Math.max(0,Math.min(Math.min(start.x,end.x),1-w)),y=Math.max(0,Math.min(Math.min(start.y,end.y),1-h));
 boxes.push({x:x,y:y,width:Math.min(1,w),height:Math.min(1,h)});start=null;draw()});root.addEventListener('pointercancel',function(){start=null});draw();
});`;
