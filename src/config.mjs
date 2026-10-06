import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function number(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
function boolean(env,name,fallback) {
  const value=String(env[name]??fallback).toLowerCase();
  if (!['true','false'].includes(value)) throw new Error(`${name} must be true or false`);
  return value==='true';
}

export function loadConfig(env = process.env) {
  const mode = env.APP_MODE || 'demo';
  if (!['demo', 'live'].includes(mode)) throw new Error('APP_MODE must be demo or live');
  const host = env.HOST || (mode === 'demo' ? '127.0.0.1' : '0.0.0.0');
  if (mode === 'demo' && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('The unsigned simulator can only run on localhost');
  }
  const timeZone = env.TIME_ZONE || 'America/Chicago';
  new Intl.DateTimeFormat('en-US', { timeZone }).format();
  const config = {
    mode, host, port: number(env, 'PORT', 8787, 0, 65535), timeZone,
    radiusMiles: number(env, 'RADIUS_MILES', 80, 1, 500),
    days: number(env, 'WINDOW_DAYS', 7, 1, 31),
    snapshotFile: path.resolve(projectDir, env.SNAPSHOT_FILE || 'data/tracker-snapshot.tsv'),
    databasePath: path.resolve(projectDir, env.DATABASE_PATH || 'work/show-finder.sqlite'),
    spreadsheetId: env.SPREADSHEET_ID || '',
    sheetId: String(env.SHEET_ID??'').trim() ? number(env, 'SHEET_ID', undefined, 0, 2147483647) : undefined,
    sheetName: env.SHEET_NAME || 'Upcoming Shows',
    googleMapsApiKey: env.GOOGLE_MAPS_API_KEY || '',
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || '',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || '',
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL || '',
    remindersEnabled: boolean(env,'REMINDERS_ENABLED',true),
    reminderHour: number(env,'REMINDER_HOUR',22,0,23),
    reminderGraceMinutes: number(env,'REMINDER_GRACE_MINUTES',10,1,60),
    reminderSendEmpty: boolean(env,'REMINDER_SEND_EMPTY',false),
    reminderWeekendPolicy: env.REMINDER_WEEKEND_POLICY || 'current',
    twilioSmsFrom: env.TWILIO_SMS_FROM || '',
    twilioWhatsAppFrom: env.TWILIO_WHATSAPP_FROM || '',
    whatsappReminderContentSid: env.WHATSAPP_REMINDER_CONTENT_SID || '',
    registrationKeywords: new Set((env.REGISTRATION_KEYWORDS || 'INFO,SHOWS,START,JOIN').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)),
    demoDate: env.DEMO_DATE || '2026-10-05',
  };
  if (![config.days,config.port,config.reminderHour,config.reminderGraceMinutes].every(Number.isInteger)) throw new Error('Days, port, reminder hour and grace minutes must be integers');
  if (!['current','next'].includes(config.reminderWeekendPolicy)) throw new Error('REMINDER_WEEKEND_POLICY must be current or next');
  if (!config.registrationKeywords.size) throw new Error('At least one registration keyword is required');
  const reserved=new Set(['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT','HELP','DELETE','PRIVACY','MORE','FULL','WEEKEND']);
  if ([...config.registrationKeywords].some(keyword=>reserved.has(keyword))) throw new Error('Registration keywords must not conflict with help, opt-out, or privacy commands');
  if (mode === 'live') {
    for (const [field, name] of [['twilioAuthToken','TWILIO_AUTH_TOKEN'], ['twilioAccountSid','TWILIO_ACCOUNT_SID'], ['googleMapsApiKey','GOOGLE_MAPS_API_KEY'], ['publicWebhookUrl','PUBLIC_WEBHOOK_URL']]) {
      if (!config[field]) throw new Error(`${name} is required in live mode`);
    }
    if (!/^[A-Za-z0-9_-]+$/.test(config.spreadsheetId)) throw new Error('SPREADSHEET_ID is required in live mode');
    if (config.sheetId!==undefined && !Number.isInteger(config.sheetId)) throw new Error('SHEET_ID must be an integer');
    const url = new URL(config.publicWebhookUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/webhooks/twilio' || url.search || url.hash || url.username || url.password) {
      throw new Error('PUBLIC_WEBHOOK_URL must be the exact HTTPS /webhooks/twilio URL without query parameters');
    }
    if (config.remindersEnabled) {
      if (!/^\+[1-9]\d{7,14}$/.test(config.twilioSmsFrom)) throw new Error('TWILIO_SMS_FROM is required for live reminders (E.164 number)');
      if (!/^whatsapp:\+[1-9]\d{7,14}$/.test(config.twilioWhatsAppFrom)) throw new Error('TWILIO_WHATSAPP_FROM is required for live reminders');
      if (!/^HX[a-fA-F0-9]{32}$/.test(config.whatsappReminderContentSid)) throw new Error('WHATSAPP_REMINDER_CONTENT_SID must identify an approved reminder template');
    }
  }
  return config;
}
