async function doChange(){
const btn=document.getElementById('changeBtn');
const err=document.getElementById('changeError');
const np=document.getElementById('newPass').value;
const cp=document.getElementById('confirmPass').value;
if(!np||np.length<6){err.textContent='Minimum 6 characters';return;}
if(np!==cp){err.textContent='Passwords do not match';return;}
btn.disabled=true;btn.textContent='Saving...';
try{
const r=await fetch('/api/change-password',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':window._csrfToken},body:JSON.stringify({currentPassword:window._tmpPass,newPassword:np})});
const d=await r.json();
if(d.success){document.getElementById('changeOverlay').classList.remove('show');window.location.href='/';}
else{err.textContent=d.message||'Error';btn.disabled=false;btn.textContent='Set Password';}
}catch(e){err.textContent='Connection error';btn.disabled=false;btn.textContent='Set Password';}
}
document.getElementById('loginForm').addEventListener('submit', async function(e){
e.preventDefault();
const btn=document.getElementById('loginBtn');
const err=document.getElementById('loginError');
err.textContent='';
btn.disabled=true;btn.textContent='Signing in...';
try{
const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
username:document.getElementById('username').value,
password:document.getElementById('password').value
})});
const d=await r.json();
if(d.success){
window._csrfToken=d.csrfToken;
if(d.mustChangePassword){window._tmpPass=document.getElementById('password').value;btn.disabled=false;btn.textContent='Sign In';document.getElementById('changeOverlay').classList.add('show');}
else{window.location.href='/';}
}
else{err.textContent=d.message||'Login error';btn.disabled=false;btn.textContent='Sign In';}
}catch(e){err.textContent='Connection error';btn.disabled=false;btn.textContent='Sign In';}
});
