export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const inr = p => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: p % 100 ? 2 : 0 });
export const when = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' });

const CSS = `
:root{--bg:#F3F5F1;--paper:#fff;--ink:#1E2230;--soft:#5E6573;--line:#DDE2DA;--berry:#8A2646;--berry-d:#6E1D38;--pista:#DCEBD0;--pista-d:#2F5A21;--saffron:#F6C453;--saffron-bg:#FFF3D1;--red:#B3261E;--red-bg:#FBE4E1}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 'Figtree',system-ui,sans-serif}
h1,h2,h3,.big{font-family:'Bricolage Grotesque','Figtree',sans-serif;letter-spacing:-.02em;line-height:1.1;margin:0}
h1{font-size:2rem}h2{font-size:1.35rem;margin-bottom:.6rem}a{color:var(--berry)}
.wrap{max-width:880px;margin:0 auto;padding:0 16px 80px}
header.top{background:var(--paper);border-bottom:1px solid var(--line);margin-bottom:24px}
header.top .wrap{display:flex;align-items:center;gap:20px;padding:12px 16px;flex-wrap:wrap}
.brand{font:700 1.25rem 'Bricolage Grotesque',sans-serif;color:var(--ink);text-decoration:none;margin-right:auto}
nav a{color:var(--soft);text-decoration:none;font-weight:600;padding:6px 2px;margin-right:14px}nav a.on{color:var(--berry);border-bottom:3px solid var(--berry)}
.sec{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:18px}
.sec.hot{border-color:var(--saffron);background:var(--saffron-bg)}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.muted{color:var(--soft);font-size:.92rem}
.btn,button{font:600 1rem 'Figtree',sans-serif;border:0;border-radius:10px;padding:12px 18px;background:var(--berry);color:#fff;cursor:pointer;text-decoration:none;display:inline-block;min-height:44px}
.btn:hover,button:hover{background:var(--berry-d)}
.btn.ghost,button.ghost{background:transparent;color:var(--berry);border:2px solid var(--berry);padding:10px 16px}
.btn.small,button.small{padding:7px 12px;min-height:36px;font-size:.92rem}
button.danger{background:var(--red)}
:focus-visible{outline:3px solid var(--saffron);outline-offset:2px}
label{display:block;font-weight:600;margin:14px 0 4px}
input,select,textarea{font:inherit;width:100%;padding:11px 12px;border:1.5px solid #C4CBC0;border-radius:10px;background:#fff;color:var(--ink);min-height:44px}
input[type=file]{padding:9px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:600;color:var(--soft);font-size:.9rem;padding:8px 6px;border-bottom:2px solid var(--line)}
td{padding:6px;border-bottom:1px solid var(--line);vertical-align:middle}td input,td select{border-color:transparent;background:transparent;padding:8px 6px;min-height:40px}td input:hover,td select:hover,td input:focus,td select:focus{border-color:#C4CBC0;background:#fff}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.chip{display:inline-block;border-radius:99px;padding:2px 12px;font-size:.85rem;font-weight:700}
.chip.paid{background:var(--pista);color:var(--pista-d)}.chip.unpaid{background:var(--red-bg);color:var(--red)}.chip.part-paid{background:var(--saffron-bg);color:#7A5600}
.err{background:var(--red-bg);color:var(--red);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-weight:600}
.okmsg{background:var(--pista);color:var(--pista-d);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-weight:600}
.empty{text-align:center;padding:26px 10px}.empty p{margin:.3rem 0 1rem;color:var(--soft)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:620px){.grid2{grid-template-columns:1fr}h1{font-size:1.6rem}.hide-sm{display:none}}
.copy{display:flex;gap:8px;align-items:center}.copy input{flex:1}
.pay-card{max-width:440px;margin:0 auto;padding:24px 16px 60px}
.pay-card .big{font-size:3.4rem;color:var(--berry);margin:.2rem 0}
.qr{display:block;width:230px;height:230px;object-fit:contain;margin:12px auto;background:#fff;border:1px solid var(--line);border-radius:12px}
.logo{height:56px;max-width:160px;object-fit:contain}
.steps li{margin-bottom:8px}code,.mono{font-family:ui-monospace,monospace;font-size:.88rem;word-break:break-all}
@media print{header.top,.noprint{display:none!important}body{background:#fff}}
`;
const SCRIPT = `
document.addEventListener('click',e=>{if(!e.target.closest('[data-additem]'))return;const t=document.querySelector('#items tbody'),r=t.rows[0].cloneNode(true);r.querySelectorAll('input').forEach(i=>i.value='');r.cells[1].firstElementChild.value=1;t.appendChild(r)});
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;
const t=b.dataset.copy;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).catch(()=>{const i=document.createElement('input');i.value=t;document.body.appendChild(i);i.select();document.execCommand('copy');i.remove()});
const o=b.textContent;b.textContent='Copied';setTimeout(()=>b.textContent=o,1200)});
document.addEventListener('change',async e=>{const f=e.target.closest('[data-save]');if(!f)return;
const r=await fetch(f.dataset.save,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({field:f.name,value:f.value})});
const d=await r.json().catch(()=>({}));f.style.background=r.ok?'#DCEBD0':'#FBE4E1';if(!r.ok)alert(d.error||'Could not save');
setTimeout(()=>{f.style.background=''},900);if(r.ok&&d.reload)location.reload()});
document.addEventListener('change',e=>{const f=e.target.closest('input[data-img]');if(!f||!f.files[0])return;
const img=new Image();img.onload=()=>{const m=+f.dataset.img,s=Math.min(1,m/Math.max(img.width,img.height)),c=document.createElement('canvas');
c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);
document.getElementById(f.dataset.target).value=c.toDataURL('image/png');document.getElementById(f.dataset.target+'_p').src=c.toDataURL('image/png');document.getElementById(f.dataset.target+'_p').hidden=false};
img.src=URL.createObjectURL(f.files[0])});
`;

export function page(title, body, { user, nav, flash } = {}) {
  const tabs = [['/', 'Today', 'today'], ['/orders', 'Orders', 'orders'], ['/settings', 'Settings', 'settings']];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
${user ? `<header class="top"><div class="wrap"><a class="brand" href="/">${esc(user.biz_name)}</a>
<nav>${tabs.map(([h, l, k]) => `<a href="${h}" class="${nav === k ? 'on' : ''}">${l}</a>`).join('')}<a href="/logout" style="margin:0">Log out</a></nav></div></header>` : ''}
<div class="wrap">${flash?.err ? `<div class="err" role="alert">${esc(flash.err)}</div>` : ''}${flash?.ok ? `<div class="okmsg">${esc(flash.ok)}</div>` : ''}${body}</div>
<script>${SCRIPT}</script></body></html>`;
}

export const chip = pay => `<span class="chip ${pay}">${{ paid: 'Paid', unpaid: 'Unpaid', 'part-paid': 'Part paid' }[pay]}</span>`;
