import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderSender } from '../src/delivery.mjs';

const config = { mode: 'live', twilioAccountSid: `AC${'a'.repeat(32)}`, twilioAuthToken: 'test-token', twilioSmsFrom: '+15550000000', twilioWhatsAppFrom: 'whatsapp:+15550000001', whatsappReminderContentSid: `HX${'b'.repeat(32)}` };
const user = { address: '+15550102026', phone: '+15550102026', channel: 'sms', active: 1, reminders_enabled: 1 };
const message = { body: 'Weekend shows. In a different town? Send your location again. STOP to opt out.', contentVariables: { '1': 'Dallas, TX', '2': 'Oct 9 - Oct 11', '3': 'Friday artist at Example Venue' } };

test('SMS sender uses a body, returns provider acceptance, and disables retries', async () => {
  let request, options, factories = 0;
  const sender = createReminderSender(config, { clientFactory: (accountSid, token, clientOptions) => {
    factories++; assert.equal(accountSid, config.twilioAccountSid); assert.equal(token, 'test-token'); options = clientOptions;
    return { messages: { create: async payload => { request = payload; return { sid: 'SM-test', status: 'queued' }; } } };
  } });
  const result = await sender.send({ user, message });
  assert.deepEqual(request, { to: user.phone, from: config.twilioSmsFrom, body: message.body });
  assert.deepEqual(result, { sid: 'SM-test', status: 'queued', outcome: 'accepted', errorCode: null });
  assert.equal(options.autoRetry, false);
  assert.equal(options.timeout, 10000);
  await sender.send({ user, message });
  assert.equal(factories, 1);
});

test('proactive WhatsApp always sends approved ContentSid variables with no free-form fallback', async () => {
  let request;
  const sender = createReminderSender(config, { clientFactory: () => ({ messages: { create: async payload => { request = payload; return { sid: 'MM-test', status: 'accepted' }; } } }) });
  const recipient = { ...user, channel: 'whatsapp', address: `whatsapp:${user.phone}` };
  assert.equal((await sender.send({ user: recipient, message })).outcome, 'accepted');
  assert.deepEqual(request, { to: `whatsapp:${user.phone}`, from: config.twilioWhatsAppFrom, contentSid: config.whatsappReminderContentSid, contentVariables: JSON.stringify(message.contentVariables) });
  assert.equal('body' in request, false);
  const unconfigured = createReminderSender({ ...config, whatsappReminderContentSid: '' }, { clientFactory: () => { throw new Error('must not reach provider'); } });
  await assert.rejects(unconfigured.send({ user: recipient, message }), { code: 'WHATSAPP_TEMPLATE_REQUIRED', outcome: 'failed' });
  await assert.rejects(sender.send({ user: recipient, message: { ...message, contentVariables: { ...message.contentVariables, '3': 'bad\nvariable' } } }), { code: 'INVALID_TEMPLATE_VARIABLES' });
});

test('invalid configuration and opt-outs fail locally without API calls', async () => {
  let calls = 0;
  const clientFactory = () => { calls++; return { messages: { create: async () => ({ sid: 'bad' }) } }; };
  await assert.rejects(createReminderSender(config, { clientFactory }).send({ user: { ...user, active: 0 }, message }), { code: 'INVALID_RECIPIENT' });
  await assert.rejects(createReminderSender(config, { clientFactory }).send({ user: { ...user, reminders_enabled: 0 }, message }), { code: 'INVALID_RECIPIENT' });
  await assert.rejects(createReminderSender({ ...config, twilioSmsFrom: '' }, { clientFactory }).send({ user, message }), { code: 'SMS_SENDER_NOT_CONFIGURED' });
  await assert.rejects(createReminderSender({ ...config, twilioAuthToken: '' }, { clientFactory }).send({ user, message }), { code: 'TWILIO_NOT_CONFIGURED' });
  await assert.rejects(createReminderSender(config, { clientFactory }).send({ user, message: { ...message, body: 'x'.repeat(1601) } }), { code: 'INVALID_BODY' });
  assert.equal(calls, 0);
});

test('explicit provider rejections and uncertain network outcomes stay distinct and sanitized', async () => {
  for (const [error, outcome, code] of [
    [{ status: 400, code: 21610, message: 'private phone +15550102026' }, 'failed', 'TWILIO_21610'],
    [{ status: 429, code: 20429 }, 'failed', 'TWILIO_20429'],
    [{ status: 503, code: 20500 }, 'unknown', 'TWILIO_20500'],
    [{ code: 'ETIMEDOUT', message: 'private token' }, 'unknown', 'DELIVERY_UNKNOWN'],
  ]) {
    const sender = createReminderSender(config, { clientFactory: () => ({ messages: { create: async () => { throw error; } } }) });
    await assert.rejects(sender.send({ user, message }), caught => {
      assert.equal(caught.outcome, outcome); assert.equal(caught.code, code);
      assert.doesNotMatch(caught.message, /15550102026|private token/); return true;
    });
  }
});

test('missing SID is uncertain; failed accepted responses preserve the provider reference', async () => {
  const unknown = createReminderSender(config, { clientFactory: () => ({ messages: { create: async () => ({ status: 'queued' }) } }) });
  await assert.rejects(unknown.send({ user, message }), { code: 'DELIVERY_UNKNOWN', outcome: 'unknown' });
  const rejected = createReminderSender(config, { clientFactory: () => ({ messages: { create: async () => ({ sid: 'SM-failed', status: 'failed', errorCode: 30007 }) } }) });
  assert.deepEqual(await rejected.send({ user, message }), { sid: 'SM-failed', status: 'failed', outcome: 'failed', errorCode: '30007' });
});

test('demo sender saves a local preview without creating a Twilio client', async () => {
  const saved = [];
  const sender = createReminderSender({ mode: 'demo' }, { store: { addDemoNotification: request => { saved.push(request); return 'demo-1'; } }, clientFactory: () => { throw new Error('must not call Twilio'); } });
  const result = await sender.send({ user, message, now: new Date('2026-10-06T03:00:00Z') });
  assert.deepEqual(saved, [{ address: user.address, body: message.body, createdAt: '2026-10-06T03:00:00.000Z' }]);
  assert.equal(result.status, 'preview');
  assert.equal(result.outcome, 'accepted');
});
