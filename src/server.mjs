import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import twilio from 'twilio';
import { loadConfig, projectDir } from './config.mjs';
import { Store } from './store.mjs';
import { Bot, validSender } from './bot.mjs';
import { DemoLocationProvider, GoogleLocationProvider } from './locations.mjs';
import { createShowSource } from './providers.mjs';
import { createReminderSender } from './delivery.mjs';
import { runDailyReminders, findWeekendShows, buildReminder } from './reminders.mjs';

class HttpError extends Error { constructor(status, message) { super(message); this.status=status; } }
function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function xml(reply) {
  const response = new twilio.twiml.MessagingResponse();
  if (reply) response.message(reply);
  return response.toString();
}
async function readBody(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new HttpError(413,'Message too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function demoLocalInstant(date,timeZone,hour) {
  const target=new Date(`${date}T${String(hour).padStart(2,'0')}:00:00Z`);
  let instant=target;
  for (let i=0;i<3;i++) {
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant).map(part=>[part.type,part.value]));
    const wall=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
    instant=new Date(instant.getTime()+target.getTime()-wall);
  }
  return instant;
}

export function createApp({ config=loadConfig(),store=new Store(config.databasePath),source=createShowSource(config),geocoder=config.mode==='demo'?new DemoLocationProvider():new GoogleLocationProvider({apiKey:config.googleMapsApiKey}),timezones,clock=config.mode==='demo'?()=>config.demoDate:()=>new Date(),sender=createReminderSender(config,{store}),reminderClock=()=>new Date(),homepage,browserHandler }={}) {
  const bot = new Bot({config,store,source,geocoder,clock,...(timezones?{timezones}:{})});
  let reminderTimer,reminderTask,reminderController;
  const runReminders=(now=reminderClock(),signal)=>runDailyReminders({store,source,geocoder,sender,config,now,signal});
  function startReminders() {
    if (config.mode!=='live' || !config.remindersEnabled || reminderTimer) return;
    const tick=()=>{
      if (reminderTask) return;
      reminderController=new AbortController();
      const budget=setTimeout(()=>reminderController.abort(),50_000);
      reminderTask=runReminders(reminderClock(),reminderController.signal).then(metrics=>{
        if (metrics.accepted||metrics.failed||metrics.unknown||metrics.errors) console.log('Reminder run:',JSON.stringify(metrics));
      }).catch(()=>console.error('Reminder run interrupted; delivery claims remain recorded.')).finally(()=>{clearTimeout(budget);reminderTask=null;});
    };
    reminderTimer=setInterval(tick,60_000);reminderTimer.unref();tick();
  }
  async function stopReminders() { clearInterval(reminderTimer);reminderTimer=null;reminderController?.abort();await reminderTask; }
  async function previewReminder(address) {
    const user=store.get(address);
    if (!user?.active) throw new HttpError(400,'Send INFO to register this channel first.');
    if (!user.location_timezone || user.location_lat==null) throw new HttpError(400,'Send a location first to save it for reminders.');
    const signal=AbortSignal.timeout(9000);
    const snapshot=await source.load({signal});
    const now=demoLocalInstant(config.demoDate,user.location_timezone,config.reminderHour);
    const found=await findWeekendShows({shows:snapshot.shows,origin:{lat:user.location_lat,lng:user.location_lng,label:user.location_label},geocoder,now,timeZone:user.location_timezone,radiusMiles:config.radiusMiles,weekendPolicy:config.reminderWeekendPolicy,signal});
    const current=store.get(address);
    if (!current?.active || current.revision!==user.revision || current.location_revision!==user.location_revision) throw new HttpError(409,'Registration or location changed. Please try again.');
    if (!found.matches.length && !config.reminderSendEmpty) return {reply:'No upcoming weekend shows near your saved location. The daily reminder would be skipped.',skipped:true};
    const message=buildReminder({user,found,radiusMiles:config.radiusMiles});
    // This endpoint is available only in localhost demo mode, with the local sender.
    const result=await createReminderSender({...config,mode:'demo'},{store}).send({user,message,now});
    return {reply:message.body,notificationSid:result.sid,localTime:`${String(config.reminderHour).padStart(2,'0')}:00`,timeZone:user.location_timezone,preview:true};
  }
  const inFlight = new Map();
  async function handleOnce(sid, input) {
    const deleting = input.body?.trim().toUpperCase() === 'DELETE';
    const cached = store.cached(sid);
    if (cached) {
      if (cached.address && cached.address !== input.from) throw new HttpError(400,'Message identity mismatch');
      return cached.reply || null;
    }
    if (inFlight.has(sid)) {
      const pending=inFlight.get(sid);
      if (pending.address!==input.from) throw new HttpError(400,'Message identity mismatch');
      return pending.promise;
    }
    const work=(async()=>{
      const controller=new AbortController();
      let timer;
      const timeout=new Promise(resolve=>{
        timer=setTimeout(()=>{ controller.abort(); resolve('Show search took too long. Please try again shortly.'); }, 9000);
      });
      try {
        const handling=bot.handle(input,{signal:controller.signal});
        const expectedRevision=store.get(input.from)?.revision;
        const reply=await Promise.race([handling,timeout]);
        if (deleting) store.remember(sid,'','');
        else {
          const current=store.get(input.from);
          if (current?.revision!==expectedRevision) return null;
          if (reply && current) store.remember(sid,input.from,reply);
        }
        return reply;
      } finally { clearTimeout(timer); }
    })();
    inFlight.set(sid,{address:input.from,promise:work});
    try { return await work; } finally { inFlight.delete(sid); }
  }
  const server = http.createServer(async(req,res)=>{
    try {
      if (browserHandler && await browserHandler(req,res)) return;
      const requestUrl=new URL(req.url,'http://localhost');
      if (req.method==='GET' && requestUrl.pathname==='/healthz') return send(res,200,{ok:true,mode:config.mode});
      if (config.mode==='live' && homepage && req.method==='GET' && req.url==='/') return send(res,200,homepage,'text/html; charset=utf-8');
      if (config.mode==='live' && req.method==='POST' && req.url==='/webhooks/twilio') {
        if (!String(req.headers['content-type']||'').toLowerCase().startsWith('application/x-www-form-urlencoded')) throw new HttpError(415,'Expected form-encoded message');
        const form=new URLSearchParams(await readBody(req));
        const params={};
        for (const [key,value] of form) {
          if (Object.hasOwn(params,key)) throw new HttpError(400,'Duplicate form field');
          params[key]=value;
        }
        const signature=req.headers['x-twilio-signature'];
        if (typeof signature!=='string' || !twilio.validateRequest(config.twilioAuthToken,signature,config.publicWebhookUrl,params)) throw new HttpError(403,'Invalid webhook signature');
        if (params.AccountSid!==config.twilioAccountSid) throw new HttpError(403,'Unexpected messaging account');
        if (!validSender(params.From) || !/^(SM|MM)[a-fA-F0-9]{32}$/.test(params.MessageSid||'') || (params.Body||'').length>1600) throw new HttpError(400,'Invalid message');
        const reply=await handleOnce(params.MessageSid,{from:params.From,body:params.Body||'',latitude:params.Latitude,longitude:params.Longitude,optOutType:params.OptOutType});
        return send(res,200,xml(reply),'application/xml; charset=utf-8');
      }
      if (config.mode==='demo') {
        const hostHeader=String(req.headers.host||'');
        const hostName=new URL(`http://${hostHeader}`).hostname;
        if (!['127.0.0.1','localhost','[::1]'].includes(hostName)) throw new HttpError(403,'Local simulator only');
        if (req.headers.origin && req.headers.origin!==`http://${hostHeader}`) throw new HttpError(403,'Cross-site simulator requests are disabled');
        if (req.method==='GET' && requestUrl.pathname==='/api/demo/status') {
          const channel=requestUrl.searchParams.get('channel')||'whatsapp';
          if (!['sms','whatsapp'].includes(channel)) throw new HttpError(400,'Invalid demo channel');
          const user=store.get((channel==='whatsapp'?'whatsapp:':'')+'+15550102026');
          return send(res,200,{mode:'demo',counts:store.counts(),radiusMiles:config.radiusMiles,days:config.days,demoDate:config.demoDate,source:`Fictitious sample events · demo date ${config.demoDate}`,reminderHour:config.reminderHour,location:user?.location_label||null,timeZone:user?.location_timezone||null,remindersEnabled:Boolean(config.remindersEnabled&&user?.active&&user?.reminders_enabled&&user?.location_timezone)});
        }
        if (req.method==='POST' && req.url==='/api/demo/reminder') {
          if (!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw new HttpError(415,'Expected JSON');
          let input;
          try { input=JSON.parse(await readBody(req)); } catch(error) { if(error instanceof HttpError) throw error;throw new HttpError(400,'Invalid JSON'); }
          if (!input||!['sms','whatsapp'].includes(input.channel)) throw new HttpError(400,'Invalid demo channel');
          const address=(input.channel==='whatsapp'?'whatsapp:':'')+'+15550102026';
          return send(res,200,{...await previewReminder(address),counts:store.counts()});
        }
        if (req.method==='POST' && req.url==='/api/demo') {
          if (!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json')) throw new HttpError(415,'Expected JSON');
          let input;
          try { input=JSON.parse(await readBody(req)); } catch(error) { if(error instanceof HttpError) throw error; throw new HttpError(400,'Invalid JSON'); }
          if (!input || !['sms','whatsapp'].includes(input.channel) || typeof input.body!=='string' || input.body.length>1600) throw new HttpError(400,'Invalid demo message');
          const from=(input.channel==='whatsapp'?'whatsapp:':'')+'+15550102026';
          const reply=await handleOnce(`demo-${randomUUID()}`,{from,body:input.body,latitude:input.latitude,longitude:input.longitude});
          return send(res,200,{reply,counts:store.counts()});
        }
        const staticFiles = { '/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'] };
        const file=staticFiles[req.url];
        if(req.method==='GET' && file) {
          const body=await readFile(path.join(projectDir,'public',file[0]),'utf8');
          res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
          return send(res,200,body,file[1]);
        }
      }
      send(res,404,{error:'Not found'});
    } catch(error) {
      // Do not log raw messages, phone numbers, credentials, addresses, or provider error objects.
      const status=error instanceof HttpError?error.status:500;
      if(status===500) console.error('Request failed; inspect configuration and service connectivity.');
      if(!res.headersSent) send(res,status,{error:status===500?'Service temporarily unavailable':error.message});
      else res.end();
    }
  });
  server.requestTimeout=15_000;
  server.headersTimeout=10_000;
  server.keepAliveTimeout=5_000;
  return {server,store,bot,handleOnce,runReminders,startReminders,stopReminders,previewReminder};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const config=loadConfig();
    const app=createApp({config});
    app.server.listen(config.port,config.host,()=>{console.log(`Show Finder ${config.mode} listening on ${config.host}:${app.server.address().port}`);app.startReminders();});
    app.server.on('error',error=>{console.error(`Listener failed: ${error.code||'unknown'}`);app.store.close();process.exitCode=1;});
    const close=async()=>{await app.stopReminders();app.server.close(()=>{app.store.close();process.exit(0);});};
    process.once('SIGINT',close); process.once('SIGTERM',close);
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
