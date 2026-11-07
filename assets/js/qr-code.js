/* Shared SVG QR rendering for slides and future game cards.
 * Requires qrcode-generator (MIT), loaded before this script.
 * QR modules are rendered locally, not by a remote image API.
 */
(function(root){
'use strict';
function render(target,url,options={}){
  if(!target||typeof root.qrcode!=='function')throw Error('QR encoder unavailable');
  const value=new URL(url,root.location.origin);
  if(!/^https?:$/.test(value.protocol))throw Error('Unsupported QR destination');
  const qr=root.qrcode(0,'M');qr.addData(value.href);qr.make();
  const count=qr.getModuleCount(),quiet=4,size=count+quiet*2,ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox',`0 0 ${size} ${size}`);
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label',options.label||'Scan to open '+value.hostname);
  svg.setAttribute('shape-rendering','crispEdges');
  const bg=document.createElementNS(ns,'rect');bg.setAttribute('width',size);bg.setAttribute('height',size);bg.setAttribute('fill','#fff');svg.append(bg);
  let d='';
  for(let y=0;y<count;y++)for(let x=0;x<count;x++)if(qr.isDark(y,x))d+=`M${x+quiet} ${y+quiet}h1v1h-1z`;
  const modules=document.createElementNS(ns,'path');modules.setAttribute('d',d);modules.setAttribute('fill','#000');svg.append(modules);
  target.replaceChildren(svg);return svg;
}
root.SNHQRCode={render};
})(window);
