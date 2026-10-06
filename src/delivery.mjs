import twilio from 'twilio';

export class DeliveryError extends Error {
  constructor(code, message, outcome = 'failed') {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    this.outcome = outcome;
  }
}

const e164 = number => /^\+[1-9]\d{7,14}$/.test(number ?? '');

/** Demo stores a local inbox entry. Live WhatsApp reminders always use an approved template. */
export function createReminderSender(config, { store, clientFactory = twilio, clock = () => new Date() } = {}) {
  let client;
  return {
    async send({ user, message, body = message?.body, now = clock() }) {
      if (!user?.active || !user.reminders_enabled || !e164(user.phone) || !['sms', 'whatsapp'].includes(user.channel)) {
        throw new DeliveryError('INVALID_RECIPIENT', 'The reminder recipient is unavailable.');
      }
      if (!body || body.length > 1600) throw new DeliveryError('INVALID_BODY', 'The reminder message is invalid.');
      if (config.mode === 'demo') {
        if (!store?.addDemoNotification) throw new DeliveryError('DEMO_INBOX_UNAVAILABLE', 'The demo inbox is unavailable.');
        const sid = store.addDemoNotification({ address: user.address, body, createdAt: now.toISOString() });
        return { sid: typeof sid === 'string' ? sid : sid?.sid ?? null, status: 'preview', outcome: 'accepted' };
      }
      if (config.mode !== 'live') throw new DeliveryError('INVALID_MODE', 'Invalid messaging mode.');
      if (!/^AC[a-zA-Z0-9]{32}$/.test(config.twilioAccountSid ?? '') || !config.twilioAuthToken) {
        throw new DeliveryError('TWILIO_NOT_CONFIGURED', 'Outbound messaging credentials are not configured.');
      }
      let request;
      if (user.channel === 'sms') {
        if (!e164(config.twilioSmsFrom)) throw new DeliveryError('SMS_SENDER_NOT_CONFIGURED', 'An SMS sender is not configured.');
        request = { to: user.phone, from: config.twilioSmsFrom, body };
      } else {
        if (!/^whatsapp:\+[1-9]\d{7,14}$/.test(config.twilioWhatsAppFrom ?? '')) {
          throw new DeliveryError('WHATSAPP_SENDER_NOT_CONFIGURED', 'A WhatsApp sender is not configured.');
        }
        if (!/^HX[a-zA-Z0-9]{32}$/.test(config.whatsappReminderContentSid ?? '')) {
          throw new DeliveryError('WHATSAPP_TEMPLATE_REQUIRED', 'An approved WhatsApp reminder template is required.');
        }
        const variables = message?.contentVariables;
        if (!variables || Object.keys(variables).length !== 3 || !['1', '2', '3'].every(key => typeof variables[key] === 'string' && variables[key].trim().length && !/[\r\n\t]| {5}/.test(variables[key]))) {
          throw new DeliveryError('INVALID_TEMPLATE_VARIABLES', 'WhatsApp reminder template variables are invalid.');
        }
        request = { to: `whatsapp:${user.phone}`, from: config.twilioWhatsAppFrom, contentSid: config.whatsappReminderContentSid, contentVariables: JSON.stringify(variables) };
      }
      try {
        // Retrying a request after a network timeout could send the same reminder twice.
        client ??= clientFactory(config.twilioAccountSid, config.twilioAuthToken, { autoRetry: false, timeout: 10_000 });
        const result = await client.messages.create(request);
        if (!result?.sid) throw new DeliveryError('DELIVERY_UNKNOWN', 'The messaging provider did not confirm acceptance.', 'unknown');
        const status = result.status || 'accepted';
        const failed = ['failed', 'undelivered', 'canceled'].includes(status);
        return { sid: result.sid, status, outcome: failed ? 'failed' : 'accepted', errorCode: result.errorCode ? String(result.errorCode) : null };
      } catch (error) {
        if (error instanceof DeliveryError) throw error;
        // A provider 4xx is an explicit rejection. Timeouts/5xx have an uncertain
        // outcome, so the scheduler records the attempt without resending it.
        const rejected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
        const code = Number.isInteger(error?.code) ? `TWILIO_${error.code}` : rejected ? 'TWILIO_REJECTED' : 'DELIVERY_UNKNOWN';
        throw new DeliveryError(code, rejected ? 'The messaging provider rejected the reminder.' : 'Reminder acceptance could not be confirmed.', rejected ? 'failed' : 'unknown');
      }
    },
  };
}
