<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>Admin · Upload to GitHub</title>
<style>
:root{--bg:#17111f;--card:#261c33;--rose:#b83a63;--plum:#5b3a8c;--text:#fff;--muted:#c9bcd8;
--out:cubic-bezier(.16,1,.3,1);--spring:cubic-bezier(.34,1.56,.64,1)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;padding:16px;background:var(--bg);color:var(--text);font:500 15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:0 auto}
.card{background:var(--card);border-radius:36px 8px 36px 8px;padding:20px;margin-bottom:12px}
h1{margin:0 0 4px;font-size:1.25rem}.sub{margin:0 0 14px;color:var(--muted);font-size:.9rem}
.btn,button{font:inherit;font-weight:700;color:var(--text);border:0;cursor:pointer;text-decoration:none;display:flex;align-items:center;justify-content:center;gap:8px;
min-height:46px;padding:0 14px;width:100%;border-radius:16px 4px 16px 4px;background:var(--plum);transition:transform 450ms var(--spring),opacity 150ms}
.btn:active,button:active{transform:scale(.95);transition:transform 100ms var(--out)}
.btn:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--text);outline-offset:2px}
.rose{background:var(--rose)}button:disabled{opacity:.4}
label.f{display:block;margin:12px 0 4px;color:var(--muted);font-size:.85rem}
input[type=password],input[type=text],select{width:100%;height:44px;background:var(--bg);color:var(--text);border:2px solid var(--plum);border-radius:14px 4px 14px 4px;padding:0 12px;font:inherit}
input[type=file]{display:none}
.drop{display:flex;align-items:center;justify-content:center;min-height:72px;padding:10px;text-align:center;border:2px dashed var(--plum);border-radius:28px 6px 28px 6px;cursor:pointer;color:var(--muted)}
.file{padding:10px 0;border-top:2px solid var(--bg)}
.file b{word-break:break-all}.file small{display:block;color:var(--muted);margin-top:2px}
.file select{margin-top:6px}
.bad{color:var(--text);background:var(--rose);border-radius:10px 3px 10px 3px;padding:4px 8px;margin-top:6px;font-size:.85rem}
.status{min-height:1.3em;margin:10px 0 0;text-align:center;color:var(--muted);font-size:.9rem}
.status.err{color:var(--text);background:var(--rose);border-radius:10px 3px 10px 3px;padding:6px 10px}
.note{color:var(--muted);font-size:.8rem;margin:10px 0 0}
a.link{color:var(--text)}
@media (prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
</style>
</head>
<body>
<main>
<div class="card">
  <h1>Upload to GitHub</h1>
  <p class="sub">Pick your files. Existing ones are replaced, new ones ask where to go. Everything goes up as one commit and Render redeploys.</p>
  <label class="f" for="pw">Admin password</label>
  <input type="password" id="pw" autocomplete="current-password">
  <label class="f">Files</label>
  <label class="drop" id="drop"><span id="dtext">Tap to choose files</span><input type="file" id="files" multiple></label>
  <button class="rose" id="check" style="margin-top:12px" disabled>Check files</button>
  <p class="status" id="status" role="status"></p>
</div>

<div class="card" id="plan" hidden>
  <div id="list"></div>
  <label class="f" for="msg">Commit message</label>
  <input type="text" id="msg" value="Update files">
  <button class="rose" id="push" style="margin-top:12px">Push to GitHub</button>
  <p class="note">Uploading broken server files (like index.js) can take the site down. You would then fix it on GitHub.</p>
</div>

<div class="card" id="done" hidden>
  <h1>Pushed</h1>
  <p class="sub" id="dmsg"></p>
  <a class="btn" id="dlink" target="_blank" rel="noopener">View the commit</a>
</div>
<div id="ld"></div>
</main>

<script src="/loader.js"></script>
<script>
const $=id=>document.getElementById(id),say=(t,e)=>{$('status').textContent=t;$('status').classList.toggle('err',!!e)};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const OKNAME=/^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;
let picked=[],targets=[];
$('pw').value=sessionStorage.getItem('ak')||'';
const key=()=>{sessionStorage.setItem('ak',$('pw').value);return {'x-admin-key':$('pw').value}};

$('files').onchange=()=>{
  picked=[...$('files').files];$('dtext').textContent=picked.length?picked.length+' file(s): '+picked.map(f=>f.name).join(', '):'Tap to choose files';
  $('check').disabled=!picked.length;$('plan').hidden=true;$('done').hidden=true;say('');
};

$('check').onclick=async()=>{
  if(!$('pw').value){say('Enter the admin password.',true);return}
  $('check').disabled=true;say('Checking the repository...');
  try{
    const r=await fetch('/api/admin/plan',{method:'POST',headers:{...key(),'Content-Type':'application/json'},body:JSON.stringify({names:picked.map(f=>f.name)})}),d=await r.json();
    if(!r.ok)throw new Error(d.error||'Could not check.');
    renderPlan(d);say('');
  }catch(e){say(e.message,true)}finally{$('check').disabled=false}
};

function renderPlan(d){
  targets=[];$('list').innerHTML='';
  d.files.forEach((f,i)=>{
    const el=document.createElement('div');el.className='file';
    if(!OKNAME.test(f.name)){el.innerHTML=`<b>${esc(f.name)}</b><div class="bad">Rename this file first: use only letters, numbers, dots, dashes and underscores.</div>`;targets[i]=null}
    else if(f.matches.length===1){el.innerHTML=`<b>${esc(f.name)}</b><small>Replaces ${esc(f.matches[0])}</small>`;targets[i]=()=>f.matches[0]}
    else if(f.matches.length>1){
      el.innerHTML=`<b>${esc(f.name)}</b><small>Found in several places. Which one to replace?</small><select>${f.matches.map(m=>`<option>${esc(m)}</option>`).join('')}</select>`;
      targets[i]=()=>el.querySelector('select').value}
    else{
      const has=d.folders.includes('public');
      el.innerHTML=`<b>${esc(f.name)}</b><small>New file. Where should it go?</small><select>${d.folders.map(p=>`<option value="${esc(p)}"${(has?p==='public':p==='')?' selected':''}>${p?esc(p)+'/':'Repo root (next to index.js)'}</option>`).join('')}</select>`;
      targets[i]=()=>{const p=el.querySelector('select').value;return (p?p+'/':'')+f.name}}
    $('list').append(el);
  });
  $('push').disabled=targets.some(t=>t===null);$('plan').hidden=false;
}

$('push').onclick=async()=>{
  const fd=new FormData();
  picked.forEach(f=>fd.append('files',f,f.name));
  fd.append('paths',JSON.stringify(targets.map(t=>t())));fd.append('message',$('msg').value||'Update files');
  $('plan').hidden=true;say('');
  try{
    const d=await Loader.run($('ld'),{url:'/api/admin/push',body:fd,upload:true,est:12,headers:key()});
    $('dmsg').textContent=d.files.length+' file(s) committed. Render will redeploy in about a minute: '+d.files.join(', ');
    $('dlink').href=d.url;$('done').hidden=false;picked=[];$('files').value='';$('dtext').textContent='Tap to choose files';$('check').disabled=true;
  }catch(e){say(e.message,true);$('plan').hidden=false}
};
</script>
</body>
</html>
