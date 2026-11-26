// Sơ đồ quan hệ kiểu "biểu đồ tri thức" như graph.html của graphify (vis-network 9.1.6, nền sáng, panel trái).
// Node = icon màu theo loại, phạm vi càng rộng càng to (vụ án > thiết bị > người > SĐT/email/IMEI/biển số), cạnh cong mảnh màu theo loại liên kết. Bấm node/cạnh: phần liên quan sáng + phát sáng
// nhấp nháy, phần còn lại mờ đi; panel trái hiện bằng chứng (file, vị trí, câu gốc).
// Cùng một chuỗi HTML dùng cho iframe trong app và cho file tải về (lib nhúng thẳng -> mở offline được).
import type { Graph, GraphNode } from './api'

const COLOR: Record<string, string> = {
  case: '#d97706', device: '#0d9488', person: '#2563eb', sim: '#64748b', email: '#db2777', plate: '#ca8a04', imei: '#16a34a',
}
const TYPE_LABEL: Record<string, string> = {
  case: 'Vụ án', device: 'Thiết bị thu giữ', person: 'Người (có tên trong danh bạ)', sim: 'Số điện thoại', email: 'Email', plate: 'Biển số xe', imei: 'IMEI',
}
// màu theo loại liên kết; cạnh lấy màu của loại mạnh nhất (đứng đầu rels)
const REL_COLOR: Record<string, string> = {
  'Thu giữ': '#d97706', 'Lưu trong danh bạ': '#2563eb', 'Thông tin máy': '#16a34a', 'Email': '#db2777', 'Tin nhắn': '#7c3aed',
  'Cuộc gọi': '#0d9488', 'Giao dịch': '#ea580c', 'Ghi hình': '#ca8a04', 'Nhắc tới': '#64748b',
}

// Icon thiết bị lấy nguyên từ lucide-react 1.71 (ISC), cùng bộ icon với tab Thiết bị
const DEV_ICON: Record<string, string> = {
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  laptop: '<path d="M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z"/><path d="M20.054 15.987H3.946"/>',
  hdd: '<path d="M10 16h.01"/><path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M21.946 12.013H2.054"/><path d="M6 16h.01"/>',
  camera: '<path d="M16.75 12h3.632a1 1 0 0 1 .894 1.447l-2.034 4.069a1 1 0 0 1-1.708.134l-2.124-2.97"/><path d="M17.106 9.053a1 1 0 0 1 .447 1.341l-3.106 6.211a1 1 0 0 1-1.342.447L3.61 12.3a2.92 2.92 0 0 1-1.3-3.91L3.69 5.6a2.92 2.92 0 0 1 3.92-1.3z"/><path d="M2 19h3.76a2 2 0 0 0 1.8-1.1L9 15"/><path d="M2 21v-4"/><path d="M7 9h.01"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  case: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
  person: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  sim: '<path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/>',
  email: '<path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"/><rect x="2" y="4" width="20" height="16" rx="2"/>',
  plate: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  imei: '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  other: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
}
const icon = (k: string, c: string, solid: boolean, ring: boolean) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="-7 -7 38 38"><circle cx="12" cy="12" r="18" fill="${solid ? c : '#fff'}" stroke="${ring ? '#dc2626' : c}" stroke-width="${ring ? 3.4 : 2.2}"/><g transform="translate(2.4 2.4) scale(.8)" fill="none" stroke="${solid ? '#fff' : c}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${DEV_ICON[k] ?? DEV_ICON.other}</g></svg>`)
// Kích thước theo phạm vi: vụ án > thiết bị > người > SĐT/email/IMEI/biển số; trong cùng loại, nhắc tới nhiều file thì to hơn chút
const BASE: Record<string, number> = { case: 42, device: 30, person: 22, sim: 16, email: 16, imei: 16, plate: 16 }

const grp = (n: GraphNode) => (n.type === 'phone' ? (n.name ? 'person' : 'sim') : n.type)

function visNode(n: GraphNode) {
  const g = grp(n)
  const c = COLOR[g]
  const own = n.type === 'phone' && n.name ? n.label : n.type === 'device' ? `${n.files ?? 0} tài liệu` : ''
  const shared = (n.cases ?? 0) > 1  // thực thể xuất hiện ở nhiều vụ án: viền đỏ, to hơn
  const sub = shared ? [own, `chung ${n.cases} vụ án`].filter(Boolean).join(' · ') : own
  const title = n.type === 'phone' && n.name ? n.name : n.label
  return {
    id: n.id, grp: g, full: title, sub, t: TYPE_LABEL[g], label: sub ? `${title}\n${sub}` : title,
    shape: 'image', image: icon(n.type === 'device' ? n.dtype ?? 'other' : g, c, g === 'case' || g === 'device', shared),
    size: BASE[g] + (g === 'case' || g === 'device' ? 0 : Math.min(6, (n.files ?? 1) - 1)) + (shared ? 6 : 0),
    font: { size: g === 'case' ? 16 : g === 'device' ? 13 : 11 },
    color: { background: c, border: c, highlight: { background: c, border: '#0a1f44' }, hover: { background: c, border: '#0a1f44' } },
  }
}

function visEdge(e: Graph['edges'][number], i: number) {
  const c = REL_COLOR[e.rels[0][0]] ?? '#64748b'
  return {
    id: i, from: e.from, to: e.to, rels: e.rels, ev: e.ev, n: e.n, width: Math.min(2 + 0.5 * e.n, 6),
    title: e.rels.map(([r, n]) => (n > 1 ? `${r} ×${n}` : r)).join(' · '),  // vis-network 9: chuỗi title hiện dạng text
    color: { color: c, opacity: 1, highlight: c, hover: c },
  }
}

/** lib: { src } -> <script src>, { inline } -> nhúng nguyên mã vis-network vào file. */
export function graphHtml(caseName: string, g: Graph, origin: string, lib: { src: string } | { inline: string }) {
  const deg: Record<string, number> = {}
  for (const e of g.edges) { deg[e.from] = (deg[e.from] ?? 0) + 1; deg[e.to] = (deg[e.to] ?? 0) + 1 }
  const nodes = g.nodes.map(n => ({ ...visNode(n), hub: (deg[n.id] ?? 0) >= 2 }))  // hub: nối từ 2 đối tượng trở lên
  const counts: Record<string, number> = {}
  for (const n of nodes) counts[n.grp] = (counts[n.grp] ?? 0) + 1
  const rels: Record<string, number> = {}
  for (const e of g.edges) for (const [r, n] of e.rels) rels[r] = (rels[r] ?? 0) + n
  const data = { nodes, edges: g.edges.map(visEdge), counts, rels, labels: TYPE_LABEL, colors: COLOR, relColors: REL_COLOR, title: caseName, origin }
  const json = JSON.stringify(data).replace(/</g, '\\u003c')  // tên file/nội dung là dữ liệu chứng cứ: không cho đóng thẻ <script>
  const script = 'src' in lib ? `<script src="${lib.src}"></script>` : `<script>${lib.inline}</script>`
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sơ đồ quan hệ</title>${script}
<style>
*{box-sizing:border-box}body{margin:0;display:flex;height:100vh;background:#e6f5f6;color:#1f2937;font:14px system-ui,sans-serif}
aside{width:320px;flex-shrink:0;padding:16px;overflow:auto;border-right:1px solid #e5e7eb;background:#f8fafc}
h1{font-size:16px;margin:0 0 4px}h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:18px 0 8px}
input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid #d1d5db;background:#fff;color:#1f2937}
.lg{display:flex;align-items:center;gap:8px;margin:4px 0}.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}.bar{width:18px;height:3px;flex-shrink:0;border-radius:2px}
.muted{color:#6b7280;font-size:12px}.big{font-size:15px;font-weight:600;margin:0 0 2px}
.chip{display:inline-block;border-radius:999px;padding:2px 8px;margin:2px 4px 2px 0;font-size:12px;color:#1f2937;font-weight:600;border:1px solid}
.ev{border:1px solid #e5e7eb;border-radius:8px;padding:8px;margin:6px 0;background:#fff}
.ev q{display:block;margin-top:4px;color:#1f2937;font-family:ui-monospace,monospace;font-size:12px;word-break:break-word;quotes:none}
a,button.lk{color:#0f7a83;background:none;border:0;padding:3px 0;cursor:pointer;font:inherit;text-align:left;display:block;text-decoration:none}
a:hover,button.lk:hover{text-decoration:underline}#g{flex:1;min-width:0}
div.vis-tooltip{background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-radius:6px;font:12px system-ui,sans-serif;padding:4px 8px}
@media(max-width:640px){body{flex-direction:column}aside{width:auto;max-height:45vh;border-right:0;border-bottom:1px solid #e5e7eb}}
</style></head><body>
<aside><h1 id="title"></h1><p class="muted" id="sum"></p>
<label class="muted" for="q">Tìm (tên, SĐT, email, biển số…)</label><input id="q" type="search" placeholder="vd: Lan hoặc 0987…">
<h2>Chi tiết</h2><div id="info"><p class="muted">Bấm vào một chấm để làm sáng các liên kết của nó, hoặc bấm vào một đường nối để xem vì sao hai bên liên quan (file, dòng, nội dung gốc). Bấm vào chỗ trống để bỏ chọn.</p></div>
<h2>Đối tượng</h2><div id="legend"></div><h2>Loại liên kết</h2><div id="rlegend"></div></aside>
<div id="g" role="img" aria-label="Sơ đồ quan hệ"></div>
<script>
const D=${json};
const el=(t,txt,cls)=>{const e=document.createElement(t);if(txt!=null)e.textContent=txt;if(cls)e.className=cls;return e};
const chip=(r,n)=>{const c=el('span',n>1?r+' ×'+n:r,'chip');const k=D.relColors[r]||'#64748b';c.style.background=hexA(k,.14);c.style.borderColor=k;return c};
const hexA=(h,a)=>h+Math.round(Math.max(0,Math.min(1,a))*255).toString(16).padStart(2,'0');
document.getElementById('title').textContent='Vụ án: '+D.title;
document.getElementById('sum').textContent=D.nodes.length+' đối tượng · '+D.edges.length+' liên kết';
for(const [k,n] of Object.entries(D.counts)){const r=el('div',null,'lg'),d=el('span',null,'dot');d.style.background=D.colors[k];r.append(d,el('span',D.labels[k]+' ('+n+')'));document.getElementById('legend').append(r)}
for(const [k,n] of Object.entries(D.rels)){const r=el('div',null,'lg'),d=el('span',null,'bar');d.style.background=D.relColors[k]||'#64748b';r.append(d,el('span',k+' ('+n+')'));document.getElementById('rlegend').append(r)}
const byId=Object.fromEntries(D.nodes.map(n=>[n.id,n])),edgeById=Object.fromEntries(D.edges.map(e=>[e.id,e]));
const nodesDS=new vis.DataSet(D.nodes),edgesDS=new vis.DataSet(D.edges);
const net=new vis.Network(document.getElementById('g'),{nodes:nodesDS,edges:edgesDS},{
 physics:{solver:'forceAtlas2Based',forceAtlas2Based:{gravitationalConstant:-70,springLength:120,avoidOverlap:.3},stabilization:{iterations:400}},
 interaction:{hover:true,keyboard:true,tooltipDelay:120},
 nodes:{shape:'dot',borderWidth:1.5,font:{color:'#475569',size:11,strokeWidth:3,strokeColor:'#e6f5f6'}},
 edges:{smooth:{type:'continuous',roundness:.45},selectionWidth:0,hoverWidth:.6}});
net.once('stabilizationIterationsDone',()=>net.setOptions({physics:false}));

// Kiểu đồ thị tri thức (Obsidian): chấm nối từ 2 đối tượng có quầng mờ đứng yên + gợn sóng tỏa ra chậm rồi tan dần,
// lệch nhịp giữa các chấm. Chọn chấm/cạnh: phần liên quan sáng hơn, chấm được chọn có 2 gợn nối tiếp; phần còn lại mờ.
// Giảm chuyển động (prefers-reduced-motion): chỉ quầng thở nhẹ, không có gợn tỏa ra.
const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLOW=D.nodes.length<=1500;  // shortcut: vẽ quầng mỗi khung hình; đồ thị > 1500 chấm thì chỉ hiệu ứng phần được chọn
const RIPPLE=3200;  // ms: một gợn từ mép chấm tỏa ra tới khi tan hẳn
D.nodes.forEach((n,i)=>{n.phase=(i*.618)%1});
let pulse=[],lit=null;
function light(ids,edgeIds,focusIds){
 const on=new Set(ids),eon=new Set(edgeIds),f=new Set(focusIds);
 lit=on.size?on:null;
 nodesDS.update(D.nodes.map(n=>on.size&&!on.has(n.id)
  ?{id:n.id,color:'rgba(203,213,225,.6)',opacity:.25,font:{color:'rgba(100,116,139,.3)'},shadow:false}
  :{id:n.id,color:n.color,opacity:1,font:{color:on.has(n.id)?'#0f172a':'#475569'},
    shadow:on.has(n.id)?{enabled:true,color:n.color.background,size:f.has(n.id)?30:14,x:0,y:0}:false}));
 edgesDS.update(D.edges.map(e=>eon.size&&!eon.has(e.id)
  ?{id:e.id,color:{color:e.color.color,opacity:.15},width:e.width,shadow:false}
  :{id:e.id,color:{...e.color,opacity:1},width:eon.has(e.id)?e.width+1.5:e.width,
    shadow:eon.has(e.id)?{enabled:true,color:e.color.color,size:12,x:0,y:0}:false}));
 pulse=focusIds;
}
function halo(ctx,p,s,c,a){const r=s*1.9,g=ctx.createRadialGradient(p.x,p.y,s*.8,p.x,p.y,r);
 g.addColorStop(0,hexA(c,a));g.addColorStop(1,hexA(c,0));ctx.fillStyle=g;ctx.beginPath();ctx.arc(p.x,p.y,r,0,2*Math.PI);ctx.fill()}
// ph 0..1: bán kính 1,05x -> 2,55x kích thước chấm, độ đậm giảm theo (1-ph)^2 nên tan mềm ở mép ngoài
function ripple(ctx,p,s,c,ph,a,w){ctx.lineWidth=w;ctx.strokeStyle=hexA(c,a*(1-ph)*(1-ph));
 ctx.beginPath();ctx.arc(p.x,p.y,s*(1.05+1.5*ph),0,2*Math.PI);ctx.stroke()}
net.on('beforeDrawing',ctx=>{if(!GLOW&&!lit)return;const t=performance.now(),pos=net.getPositions();
 for(const n of D.nodes){if(!n.hub||(lit?!lit.has(n.id):!GLOW))continue;const p=pos[n.id];if(!p)continue;
  const c=n.color.background,ph=(t/RIPPLE+n.phase)%1;
  if(reduce){halo(ctx,p,n.size,c,(lit?.3:.18)+.06*Math.sin(2*Math.PI*ph));continue}
  halo(ctx,p,n.size,c,lit?.28:.16);
  ripple(ctx,p,n.size,c,ph,lit?.55:.35,1.5)}});
net.on('afterDrawing',ctx=>{if(!pulse.length)return;const t=performance.now();
 for(const id of pulse){const n=byId[id],p=net.getPosition(id);if(!n||!p)continue;const c=n.color.background;
  if(reduce){ctx.lineWidth=2;ctx.strokeStyle=hexA(c,.7);ctx.beginPath();ctx.arc(p.x,p.y,n.size+3,0,2*Math.PI);ctx.stroke();continue}
  for(const off of [0,.5])ripple(ctx,p,n.size+3,c,(t/(RIPPLE*.7)+off)%1,.8,2)}});
(function loop(){if(GLOW||pulse.length)net.redraw();requestAnimationFrame(loop)})();  // rAF tự dừng khi tab ẩn

const info=document.getElementById('info'),hint=[...info.childNodes];
const nm=id=>{const n=byId[id];return n.full+(n.sub&&n.grp!=='device'?' ('+n.sub+')':'')};
function showNode(id){const n=byId[id];
 info.replaceChildren(el('p',n.full,'big'),el('p',n.t+(n.sub?' · '+n.sub:''),'muted'));
 const es=net.getConnectedEdges(id).map(i=>edgeById[i]);info.append(el('h2','Liên kết ('+es.length+')'));
 for(const e of es.sort((a,b)=>b.n-a.n)){const o=e.from===id?e.to:e.from,b=el('button',null,'lk');
  b.append(el('span',nm(o)+' — '));for(const [r,k] of e.rels)b.append(chip(r,k));b.onclick=()=>selEdge(e.id);info.append(b)}}
function showEdge(id){const e=edgeById[id];
 info.replaceChildren(el('p',nm(e.from),'big'),el('p','↕ liên quan với','muted'),el('p',nm(e.to),'big'));
 const r=el('div');for(const [k,n] of e.rels)r.append(chip(k,n));info.append(r);
 if(!e.ev.length){info.append(el('p','Thiết bị được thu giữ trong vụ án này.','muted'));return}
 info.append(el('h2','Bằng chứng ('+e.n+(e.n>e.ev.length?', hiện '+e.ev.length:'')+')'));
 for(const v of e.ev){const d=el('div',null,'ev'),a=el('a',v.file+(v.loc?' · '+v.loc:'')+' ↗');a.href=D.origin+'/file/'+v.id;a.target='_blank';a.rel='noreferrer';
  d.append(a,el('q',v.text));info.append(d)}}
function selNode(id){if(!byId[id])return;light([id,...net.getConnectedNodes(id)],net.getConnectedEdges(id),[id]);showNode(id)}
function selEdge(id){const e=edgeById[id];if(!e)return;light([e.from,e.to],[e.id],[e.from,e.to]);showEdge(id)}
function clear(){light([],[],[]);info.replaceChildren(...hint)}
net.on('click',p=>{if(p.nodes.length)selNode(p.nodes[0]);else if(p.edges.length)selEdge(p.edges[0]);else clear()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')clear()});
document.getElementById('q').addEventListener('keydown',e=>{if(e.key!=='Enter')return;const q=e.target.value.trim().toLowerCase();
 const n=q&&D.nodes.find(x=>(x.full+' '+x.sub).toLowerCase().includes(q));if(n){net.focus(n.id,{scale:1.4,animation:true});selNode(n.id)}});
</script></body></html>`
}
