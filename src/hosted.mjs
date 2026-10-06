import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createApp } from './server.mjs';
import { createBrowserHandler } from './browser.mjs';

export function createHostedApp({env=process.env,browser={},...options}={}) {
  // Browser discovery is independent of the messaging activation switch.
  // The unsigned message simulator is never exposed on the hosted endpoint.
  let config;
  if (env.HOSTED_SERVICE_ENABLED==='true') {
    try {config=loadConfig({...env,APP_MODE:'live',HOST:'0.0.0.0',PORT:env.PORT||7860});}
    catch {/* A public endpoint never discloses configuration or secrets. */}
  }
  const browserApp=createBrowserHandler({...browser,env,messagingReady:Boolean(config)});
  if (config) return {...createApp({...options,config,browserHandler:browserApp.handle}),config,ready:true,browserApp};
  const requestedPort=Number(env.PORT??7860);
  const port=Number.isInteger(requestedPort)&&requestedPort>=0&&requestedPort<=65535?requestedPort:7860;
  const server=http.createServer(async(req,res)=>{
    try {
      if (await browserApp.handle(req,res)) return;
      res.writeHead(503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.end(JSON.stringify({error:'Messaging setup is pending'}));
    } catch {
      if (!res.headersSent) res.writeHead(503,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify({error:'Service temporarily unavailable'}));
    }
  });
  server.requestTimeout=20_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
  return {server,browserApp,config:{host:'0.0.0.0',port},ready:false,startReminders(){},async stopReminders(){}};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const app=createHostedApp();
    app.server.listen(app.config.port,app.config.host,()=>{
      console.log(`Daily Show Finder browser is online; messaging ${app.ready?'configured':'setup pending'}`);
      app.startReminders();
    });
    app.server.on('error',()=>{console.error('Hosted listener failed.');app.store?.close();process.exitCode=1;});
    const close=async()=>{await app.stopReminders();app.server.close(()=>{app.store?.close();process.exit(0);});};
    process.once('SIGINT',close);process.once('SIGTERM',close);
  } catch {console.error('Hosted startup failed; check configuration and database connectivity.');process.exitCode=1;}
}
