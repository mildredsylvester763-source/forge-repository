const app = document.getElementById('forgeApp');
const sidebar = document.getElementById('sidebar');
const toast = document.getElementById('toast');
let toastTimer;
function notify(message){toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2400)}
document.getElementById('mobileMenu').addEventListener('click',()=>sidebar.classList.toggle('open'));
document.getElementById('collapseNav').addEventListener('click',()=>{app.classList.toggle('collapsed');notify(app.classList.contains('collapsed')?'Collapsed navigation state':'Expanded navigation state')});
document.querySelectorAll('.expandable').forEach(item=>item.addEventListener('click',e=>{e.preventDefault();document.getElementById('projectNested').classList.toggle('hidden');notify('Nested project navigation state toggled')}));
document.querySelectorAll('.nav-item').forEach(item=>item.addEventListener('click',()=>{document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));item.classList.add('active');if(innerWidth<780)sidebar.classList.remove('open')}));
document.querySelectorAll('[data-toast]').forEach(item=>item.addEventListener('click',()=>notify(item.dataset.toast)));
document.getElementById('viewMode').addEventListener('click',()=>{document.body.classList.toggle('atlas-mode');notify('Responsive atlas reference state selected')});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();notify('Command surface focused')}if(e.key==='Escape')sidebar.classList.remove('open')});

const voiceButton=document.getElementById('voiceButton');
if(voiceButton){voiceButton.addEventListener('click',()=>{voiceButton.classList.toggle('recording');notify(voiceButton.classList.contains('recording')?'Voice input ready · visual recording state':'Voice input paused · visual state');});}
