const chat=document.querySelector('#chat');
const form=document.querySelector('#composer');
const input=document.querySelector('#message');
const channel=document.querySelector('#channel');
let pending=false;
const histories={ whatsapp:[],sms:[] };
function bubble(text,outgoing=false,remember=true){
  const element=document.createElement('div');
  element.className=`bubble ${outgoing?'outgoing':'incoming'}`;
  element.textContent=text;
  chat.append(element);chat.scrollTop=chat.scrollHeight;
  if(remember)histories[channel.value].push({text,outgoing});
}
function counts(value){document.querySelector('#registered').textContent=value.registered;document.querySelector('#active').textContent=value.active;}
function busy(value){pending=value;document.querySelectorAll('button,select').forEach(el=>el.disabled=value);input.disabled=value;}
async function refreshStatus(){
  const response=await fetch(`/api/demo/status?channel=${channel.value}`);
  if(!response.ok)throw new Error('Could not load the saved location.');
  const data=await response.json();counts(data.counts);
  document.querySelector('#radius').textContent=data.radiusMiles;document.querySelector('#days').textContent=data.days;
  const reminderTime=`${data.reminderHour%12||12} ${data.reminderHour>=12?'PM':'AM'}`;
  document.querySelector('#saved-location').textContent=data.location?`${data.location} · ${data.timeZone}\n${data.remindersEnabled?`Daily reminders at ${reminderTime} local time`:'Reminders paused'}`:'Send a city to set your reminder.';
  document.querySelector('#preview-reminder').textContent=`Preview ${reminderTime} reminder`;
}
async function sendMessage(body){
  if(pending || !body.trim())return;
  bubble(body,true);input.value='';busy(true);
  try{
    const response=await fetch('/api/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:channel.value,body})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'The demo could not process this message.');
    bubble(data.reply||'The messaging provider handled this keyword.');counts(data.counts);await refreshStatus();
  }catch(error){bubble(error.message||'The demo is unavailable. Try again.');}
  finally{busy(false);input.focus();}
}
form.addEventListener('submit',event=>{event.preventDefault();sendMessage(input.value);});
document.querySelectorAll('[data-message]').forEach(button=>button.addEventListener('click',()=>sendMessage(button.dataset.message)));
channel.addEventListener('change',()=>{
  chat.replaceChildren();document.querySelector('#channel-label').textContent=channel.value==='whatsapp'?'WhatsApp simulator':'SMS simulator';
  bubble('Send INFO to register this channel, then send a location.',false,false);
  histories[channel.value].forEach(item=>bubble(item.text,item.outgoing,false));
  refreshStatus().catch(error=>bubble(error.message));
});
document.querySelector('#preview-reminder').addEventListener('click',async()=>{
  if(pending)return;busy(true);
  try{
    const response=await fetch('/api/demo/reminder',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:channel.value})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not preview the reminder.');
    bubble(`Reminder preview${data.localTime?` at ${data.localTime}`:''}${data.timeZone?` · ${data.timeZone}`:''}\n\n${data.reply}`);counts(data.counts);
  }catch(error){bubble(error.message);}finally{busy(false);input.focus();}
});
refreshStatus().catch(()=>bubble('Could not connect to the local demo.'));
