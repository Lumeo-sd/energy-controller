'use strict';
async function doChange(){
  const btn=document.getElementById('changeBtn');
  const err=document.getElementById('changeError');
  const np=document.getElementById('newPass').value;
  const cp=document.getElementById('confirmPass').value;
  if(!np||np.length<6){err.textContent='Мінімум 6 символів';return;}
  if(np!==cp){err.textContent='Паролі не збігаються';return;}
  btn.disabled=true;btn.textContent='Збереження…';
  try{
    const r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window._csrfToken},body:JSON.stringify({currentPassword:window._tmpPass,newPassword:np})});
    const d=await r.json();
    if(d.success){document.getElementById('changeOverlay').classList.remove('show');window.location.href='/';}
    else{err.textContent=d.message||'Помилка';btn.disabled=false;btn.textContent='Встановити';}
  }catch(e){err.textContent='Помилка з\'єднання';btn.disabled=false;btn.textContent='Встановити';}
}
document.getElementById('loginForm').addEventListener('submit',async function(e){
  e.preventDefault();
  const btn=document.getElementById('loginBtn');
  const err=document.getElementById('loginError');
  err.textContent='';
  btn.disabled=true;btn.textContent='Вхід…';
  try{
    const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      username:document.getElementById('username').value,
      password:document.getElementById('password').value
    })});
    const d=await r.json();
    if(d.success){
      window._csrfToken=d.csrfToken;
      if(d.mustChangePassword){
        window._tmpPass=document.getElementById('password').value;
        btn.disabled=false;btn.textContent='Увійти';
        document.getElementById('changeOverlay').classList.add('show');
      }else{window.location.href='/';}
    }else{err.textContent=d.message||'Помилка входу';btn.disabled=false;btn.textContent='Увійти';}
  }catch(e){err.textContent='Помилка з\'єднання';btn.disabled=false;btn.textContent='Увійти';}
});
