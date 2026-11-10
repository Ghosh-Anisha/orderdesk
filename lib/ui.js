export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const inr = p => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: p % 100 ? 2 : 0 });
export const when = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', weekday: 'short', timeZone: 'UTC' });

// Lucide icons (ISC), inline so there is nothing to load
const ICONS = {
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
  phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  print: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
};
export const icon = n => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

const CSS = `
:root{--bg:#F1F4EF;--paper:#fff;--ink:#1E2230;--soft:#596070;--line:#DCE1D8;--field:#B9C1B4;
--berry:#8A2646;--berry-d:#6E1D38;--berry-l:#F6E6EB;--pista:#DCEBD0;--pista-d:#2F5A21;--saffron:#F6C453;--saffron-bg:#FFF3D1;--saffron-d:#6E4E00;--red:#A8231B;--red-bg:#FBE4E1;
--r:12px;--ease:cubic-bezier(.2,.8,.2,1)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 'Figtree',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2,h3,.display{font-family:'Bricolage Grotesque','Figtree',sans-serif;letter-spacing:-.02em;line-height:1.1;margin:0;text-wrap:balance}
h1{font-size:clamp(1.75rem,1.4rem + 1.5vw,2.25rem)}h2{font-size:1.3rem;margin-bottom:.75rem}
a{color:var(--berry);text-underline-offset:.18em}p{margin:0 0 1rem}
.i{width:1.15em;height:1.15em;flex:none;vertical-align:-.2em}
.wrap{max-width:920px;margin:0 auto;padding:0 16px 96px}

/* header */
header.top{background:var(--paper);border-bottom:1px solid var(--line);margin-bottom:28px}
header.top .wrap{display:flex;align-items:center;gap:8px 24px;padding-top:0;padding-bottom:0;flex-wrap:wrap;min-height:64px}
.brand{font:700 1.2rem/1.2 'Bricolage Grotesque',sans-serif;color:var(--ink);text-decoration:none;margin-right:auto;padding:10px 0;overflow-wrap:anywhere}
nav{display:flex;gap:4px;margin:0 -10px}
nav a{display:flex;align-items:center;min-height:48px;padding:0 10px;color:var(--soft);text-decoration:none;font-weight:600;border-bottom:3px solid transparent}
nav a:hover{color:var(--ink)}nav a[aria-current]{color:var(--berry);border-bottom-color:var(--berry)}
@media(max-width:560px){header.top .wrap{padding-top:4px}nav{width:calc(100% + 20px)}nav a.out{margin-left:auto}}

/* page furniture */
.head{display:flex;justify-content:space-between;align-items:center;gap:12px 16px;flex-wrap:wrap;margin-bottom:20px}
.head p{margin:.35rem 0 0}
.sec{background:var(--paper);border:1px solid var(--line);border-radius:var(--r);padding:20px;margin-bottom:20px}
.sec>h2:first-child{margin-top:0}
.sec.hot{border-color:#EBCB78;background:var(--saffron-bg)}
.row{display:flex;gap:8px 16px;align-items:center;flex-wrap:wrap;justify-content:space-between;padding:12px 0;border-top:1px solid var(--line)}
.sec>h2+.row,.sec>p+.row,.row:first-child{border-top:0}
.row .end{display:flex;align-items:center;gap:10px;margin-left:auto}
.muted{color:var(--soft);font-size:.92rem}
.back{display:inline-flex;align-items:center;gap:6px;min-height:44px;font-weight:600;text-decoration:none}

/* buttons: one primary, one quiet, all at least 44px */
.btn,button{font:600 1rem/1.2 'Figtree',sans-serif;border:2px solid var(--berry);border-radius:10px;padding:10px 18px;background:var(--berry);color:#fff;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;transition:background-color .15s,border-color .15s}
.btn:hover,button:hover{background:var(--berry-d);border-color:var(--berry-d)}
.btn.ghost,button.ghost{background:var(--paper);color:var(--berry)}
.btn.ghost:hover,button.ghost:hover{background:var(--berry-l)}
.btn.small,button.small{padding:8px 14px;font-size:.95rem}
.btn.wide,button.wide{width:100%}
.btns{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
button:focus-visible,.btn:focus-visible{outline-offset:3px}

/* forms */
label{display:block;font-weight:600;margin:16px 0 6px}
.hint{font-weight:400;color:var(--soft)}
input,select,textarea{font:inherit;width:100%;padding:10px 12px;border:1.5px solid var(--field);border-radius:10px;background:#fff;color:var(--ink);min-height:48px}
input:hover,select:hover{border-color:#8F998A}
input:focus-visible,select:focus-visible{outline:3px solid var(--ink);outline-offset:0;border-color:var(--ink)}
input[type=file]{padding:10px}
input[readonly]{background:var(--bg)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.saved{animation:saved 1.1s var(--ease)}.save-err{display:block;color:var(--red);font-size:.9rem;font-weight:600;margin-top:4px}
@keyframes saved{0%,40%{background:var(--pista);border-color:var(--pista-d)}}

/* tables */
table{width:100%;border-collapse:collapse}
th{text-align:left;font-weight:600;color:var(--soft);font-size:.88rem;padding:8px;border-bottom:2px solid var(--line)}
td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
td input,td select{border-color:transparent;background:transparent;padding:8px;min-height:44px}
td input:hover,td select:hover{border-color:var(--field);background:#fff}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}

/* status: always words, colour only supports them */
.chip{display:inline-flex;align-items:center;white-space:nowrap;border-radius:99px;padding:3px 11px;font-size:.84rem;font-weight:700;line-height:1.3}
.chip.paid{background:var(--pista);color:var(--pista-d)}.chip.unpaid{background:var(--red-bg);color:var(--red)}.chip.part-paid,.chip.waiting{background:var(--saffron-bg);color:var(--saffron-d)}

.err,.okmsg{border-radius:10px;padding:12px 16px;margin-bottom:16px;font-weight:600}
.err{background:var(--red-bg);color:var(--red)}.okmsg{background:var(--pista);color:var(--pista-d)}
.empty{text-align:center;padding:36px 16px}.empty p{margin:.5rem auto 1.25rem;color:var(--soft);max-width:36ch}.empty .btns{justify-content:center}
.copy{display:flex;gap:8px;align-items:center}.copy input{flex:1;min-width:0}
.logo{height:56px;max-width:160px;object-fit:contain;display:block}
.qr{display:block;width:220px;height:220px;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:var(--r)}
.steps{padding-left:1.3rem}.steps li{margin-bottom:8px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;overflow-wrap:anywhere}
[data-copy].done{background:var(--pista-d);border-color:var(--pista-d);color:#fff}
[data-copy].done .i{animation:pop .35s var(--ease)}
@keyframes pop{from{transform:scale(.4)}}

/* customer pay page: the one loud screen. The amount due is the hero. */
body.paybody{background:var(--paper)}
.pay{min-height:100vh;min-height:100dvh}
.pay-hero{background:var(--berry);color:#fff;padding:20px 16px 72px;container-type:inline-size}
.pay-hero.done{background:var(--pista-d)}.pay-hero.off{background:var(--ink)}
.pay .in{max-width:480px;margin:0 auto}
.pay-biz{display:flex;align-items:center;gap:12px;font:700 1.1rem/1.2 'Bricolage Grotesque',sans-serif;min-height:48px}
.pay-biz img{height:48px;width:48px;border-radius:10px;background:#fff;object-fit:contain;padding:4px}
.pay-for{margin:36px 0 0;font-size:1.05rem;color:#F6E0E7}.pay-hero.done .pay-for{color:#E2EFD8}.pay-hero.off .pay-for{color:#D5D8E0}
.amt{font:800 min(7.5rem,calc(100cqi / (var(--len) * .6)))/1 'Bricolage Grotesque',sans-serif;letter-spacing:-.045em;margin:8px 0 14px;white-space:nowrap;font-variant-numeric:lining-nums}
.amt .cur{font-size:.5em;vertical-align:.62em;margin-right:.06em;color:var(--saffron);letter-spacing:0}
.pay-hero.done .amt .cur{color:var(--pista)}
.amt.words{font-size:clamp(2.4rem,11cqi,4rem);white-space:normal;letter-spacing:-.03em;line-height:1.05}
.pay-note{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.14);border-radius:99px;padding:7px 14px;font-weight:600;margin:0}
.pay-note+.pay-note{margin-top:8px}
.upi-app{margin-top:28px;width:100%;min-height:56px;font-size:1.1rem;background:var(--saffron);border-color:var(--saffron);color:var(--ink)}
.upi-app:hover{background:#FFD36E;border-color:#FFD36E}
.pay-hero :focus-visible{outline-color:#fff}
@media(hover:hover) and (pointer:fine){.upi-app{display:none}}
.stamp{display:inline-grid;place-items:center;width:64px;height:64px;border-radius:50%;background:var(--pista);color:var(--pista-d);margin-top:32px}
.stamp .i{width:34px;height:34px;stroke-width:3}
.stamp.go{animation:stamp .6s var(--ease) both}.stamp.go .i{animation:pop .5s .25s var(--ease) both}
@keyframes stamp{from{transform:scale(1.8) rotate(-12deg);opacity:0}}
.pay-sheet{background:var(--paper);border-radius:22px 22px 0 0;margin-top:-36px;position:relative;padding:28px 16px 72px}
.pay-sheet h2{font-size:1.25rem;margin:0 0 12px}
.pay-part{padding:28px 0;border-top:1px solid var(--line)}.pay-part:first-child{padding-top:0;border-top:0}.pay-part:last-child{padding-bottom:0}
.lines{list-style:none;margin:0;padding:0}
.lines li{display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px dashed var(--line)}
.lines li span:last-child{white-space:nowrap;font-variant-numeric:tabular-nums}
.lines li.tot{border-bottom:0;font-weight:700;padding-top:12px}
.lines li.got{border-bottom:0;padding-top:0;color:var(--pista-d);font-weight:600}
.pay-qr{display:flex;flex-direction:column;align-items:center;gap:10px;margin:4px 0 20px;text-align:center}
.pay-qr .qr{width:240px;height:240px;padding:8px}
.kv{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:var(--bg);border-radius:var(--r);margin-top:10px}
.kv .k{display:block;font-size:.85rem;color:var(--soft);font-weight:600}
.kv .v{display:block;font-size:1.15rem;font-weight:700;overflow-wrap:anywhere}
.kv button{flex:none}
@media(min-width:960px){
 .pay{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
 .pay-hero{padding:48px 56px}
 .pay-hero .in{position:sticky;top:max(48px,calc(50vh - 260px));max-width:560px}
 .amt{font-size:min(10rem,calc(100cqi / (var(--len) * .6)))}
 .pay-for{margin-top:48px}
 .pay-sheet{margin:0;border-radius:0;padding:72px 56px;display:flex;align-items:center}
 .pay-sheet .in{width:100%}
}
.receipt{max-width:560px;margin:0 auto;padding:40px 16px 96px}
.receipt .head{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:20px;align-items:flex-end}
@media print{.receipt{padding:0}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media(max-width:620px){.grid2{grid-template-columns:1fr}.hide-sm{display:none}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media print{header.top,.noprint{display:none!important}body{background:#fff}}
`;
const SCRIPT = `
const live=document.getElementById('live'),say=t=>{live.textContent='';setTimeout(()=>live.textContent=t,30)};
document.addEventListener('click',e=>{if(!e.target.closest('[data-additem]'))return;const t=document.querySelector('#items tbody'),r=t.rows[0].cloneNode(true);r.querySelectorAll('input').forEach(i=>i.value='');r.cells[1].firstElementChild.value=1;t.appendChild(r);r.querySelector('input').focus()});
document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;
const t=b.dataset.copy;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).catch(()=>{const i=document.createElement('input');i.value=t;document.body.appendChild(i);i.select();document.execCommand('copy');i.remove()});
const l=b.querySelector('.l');b.dataset.label??=l.textContent;b.dataset.icon??=b.querySelector('.i').outerHTML;
b.querySelector('.i').outerHTML='${icon('check').replace(/'/g, "\\'")}';l.textContent='Copied';b.classList.add('done');say('Copied '+t);
clearTimeout(b._t);b._t=setTimeout(()=>{b.classList.remove('done');b.querySelector('.i').outerHTML=b.dataset.icon;l.textContent=b.dataset.label},1800)});
document.addEventListener('change',async e=>{const f=e.target.closest('[data-save]');if(!f)return;
const box=f.parentElement,old=box.querySelector('.save-err');if(old)old.remove();f.removeAttribute('aria-invalid');
let r,d={};try{r=await fetch(f.dataset.save,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({field:f.name,value:f.value})});d=await r.json().catch(()=>({}))}catch{r={ok:false};d.error='Could not reach the app. Check your internet, then change it again.'}
if(r.ok){f.classList.remove('saved');void f.offsetWidth;f.classList.add('saved');say('Saved')}
else{const m=document.createElement('span');m.className='save-err';m.id=f.name+'-err-'+Math.random().toString(36).slice(2,7);m.setAttribute('role','alert');m.textContent=d.error||'Not saved. Try again.';box.appendChild(m);f.setAttribute('aria-invalid','true');f.setAttribute('aria-describedby',m.id)}});
document.addEventListener('change',e=>{const f=e.target.closest('input[data-img]');if(!f||!f.files[0])return;
const img=new Image();img.onload=()=>{const m=+f.dataset.img,s=Math.min(1,m/Math.max(img.width,img.height)),c=document.createElement('canvas');
c.width=Math.round(img.width*s);c.height=Math.round(img.height*s);const x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);
const url=c.toDataURL('image/png'),id=f.dataset.target;document.getElementById(id).value=url;
let p=document.getElementById(id+'_p');if(!p){p=document.createElement('img');p.id=id+'_p';p.alt='';p.className=f.dataset.cls;f.after(p)}p.src=url};
img.src=URL.createObjectURL(f.files[0])});
`;

export function page(title, body, { user, nav, flash, bare, theme } = {}) {
  const tabs = [['/', 'Today', 'today'], ['/orders', 'Orders', 'orders'], ['/settings', 'Settings', 'settings']];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${theme ? `<meta name="theme-color" content="${theme}">` : ''}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Figtree:wght@400;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body${bare ? ` class="${bare}"` : ''}>
${user ? `<header class="top"><div class="wrap"><a class="brand" href="/">${esc(user.biz_name)}</a>
<nav aria-label="Main">${tabs.map(([h, l, k]) => `<a href="${h}"${nav === k ? ' aria-current="page"' : ''}>${l}</a>`).join('')}<a class="out" href="/logout">Log out</a></nav></div></header>` : ''}
${bare ? body : `<main class="wrap">${flash?.err ? `<div class="err" role="alert">${esc(flash.err)}</div>` : ''}${flash?.ok ? `<div class="okmsg" role="status">${esc(flash.ok)}</div>` : ''}${body}</main>`}
<div id="live" class="sr" aria-live="polite"></div><script>${SCRIPT}</script></body></html>`;
}

export const chip = pay => `<span class="chip ${pay}">${{ paid: 'Paid', unpaid: 'Unpaid', 'part-paid': 'Part paid' }[pay]}</span>`;
export const copyBtn = (value, label = 'Copy', cls = 'small') => `<button type="button" class="${cls}" data-copy="${esc(value)}">${icon('copy')}<span class="l">${label}</span></button>`;
