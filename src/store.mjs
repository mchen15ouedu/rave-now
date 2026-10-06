import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS users (
        address TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        phone TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        registered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        sid TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        reply TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS receipt_address ON receipts(address);
      CREATE TABLE IF NOT EXISTS reminder_deliveries (
        address TEXT NOT NULL, local_date TEXT NOT NULL, revision TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL, provider_sid TEXT, error_code TEXT,
        PRIMARY KEY(address,local_date)
      );
      CREATE TABLE IF NOT EXISTS demo_notifications (
        sid TEXT PRIMARY KEY, address TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='revision')) {
      this.db.exec("ALTER TABLE users ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
    }
    const columns = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(column=>column.name));
    for (const [name,type] of Object.entries({location_lat:'REAL',location_lng:'REAL',location_label:'TEXT',location_timezone:'TEXT',location_saved_at:'TEXT',location_revision:'TEXT',location_request_revision:'TEXT',reminders_enabled:'INTEGER NOT NULL DEFAULT 0'})) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    }
    this.purge();
  }
  get(address) { return this.db.prepare('SELECT * FROM users WHERE address=?').get(address); }
  register(address) {
    const phone = address.replace(/^whatsapp:/, '');
    const channel = address.startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO users(address,channel,phone,active,registered_at,updated_at,revision,reminders_enabled) VALUES(?,?,?,1,?,?,?,1)
      ON CONFLICT(address) DO UPDATE SET active=1,reminders_enabled=1, updated_at=excluded.updated_at,revision=excluded.revision`).run(address, channel, phone, now, now,randomUUID());
    return this.get(address);
  }
  stop(address) {
    this.db.prepare('UPDATE users SET active=0,reminders_enabled=0,updated_at=?,revision=? WHERE address=?').run(new Date().toISOString(),randomUUID(), address);
    this.db.prepare("UPDATE receipts SET reply='' WHERE address=?").run(address);
  }
  forget(address) {
    this.db.exec('BEGIN');
    try {
      // Keep anonymous delivery IDs temporarily so a delayed retry cannot recreate a deleted registration.
      this.db.prepare("UPDATE receipts SET address='',reply='' WHERE address=?").run(address);
      this.db.prepare('DELETE FROM reminder_deliveries WHERE address=?').run(address);
      this.db.prepare('DELETE FROM demo_notifications WHERE address=?').run(address);
      this.db.prepare('DELETE FROM users WHERE address=?').run(address);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  beginLocationUpdate(address,expectedRevision) {
    const token=randomUUID();
    const result=this.db.prepare('UPDATE users SET location_request_revision=? WHERE address=? AND active=1 AND revision=?').run(token,address,expectedRevision);
    return result.changes?token:null;
  }
  saveLocation(address, origin, timeZone, expectedRevision,expectedRequestRevision) {
    if (!Number.isFinite(origin.lat) || !Number.isFinite(origin.lng) || Math.abs(origin.lat)>90 || Math.abs(origin.lng)>180) throw new Error('Invalid saved coordinates');
    new Intl.DateTimeFormat('en-US',{timeZone}).format();
    const now=new Date().toISOString();
    const where=expectedRequestRevision===undefined?'':' AND location_request_revision=?';
    const result=this.db.prepare(`UPDATE users SET location_lat=?,location_lng=?,location_label=?,location_timezone=?,location_saved_at=?,location_revision=?,reminders_enabled=1,updated_at=? WHERE address=? AND active=1 AND revision=?${where}`).run(origin.lat,origin.lng,String(origin.label).slice(0,200),timeZone,now,randomUUID(),now,address,expectedRevision,...(expectedRequestRevision===undefined?[]:[expectedRequestRevision]));
    return result.changes ? this.get(address) : null;
  }
  listReminderUsers() {
    return this.db.prepare(`SELECT * FROM users WHERE active=1 AND reminders_enabled=1 AND location_lat IS NOT NULL AND location_lng IS NOT NULL AND location_timezone IS NOT NULL`).all();
  }
  hasReminder(address,localDate) { return !!this.db.prepare('SELECT 1 FROM reminder_deliveries WHERE address=? AND local_date=?').get(address,localDate); }
  claimReminder(address,localDate,revision,now,locationRevision) {
    const user=this.get(address);
    if (!user?.active || !user.reminders_enabled || user.revision!==revision || (locationRevision!==undefined && user.location_revision!==locationRevision)) return false;
    return !!this.db.prepare(`INSERT OR IGNORE INTO reminder_deliveries(address,local_date,revision,created_at,status) VALUES(?,?,?,?,'claimed')`).run(address,localDate,revision,new Date(now).toISOString()).changes;
  }
  completeReminder(address,localDate,status,providerSid=null,errorCode=null,expectedRevision) {
    if (!['accepted','failed','unknown','cancelled'].includes(status)) throw new Error('Invalid delivery outcome');
    const where=expectedRevision===undefined?'':' AND revision=?';
    this.db.prepare(`UPDATE reminder_deliveries SET status=?,provider_sid=?,error_code=? WHERE address=? AND local_date=?${where}`).run(status,providerSid??null,errorCode??null,address,localDate,...(expectedRevision===undefined?[]:[expectedRevision]));
  }
  addDemoNotification({address,body,createdAt=new Date()}) {
    if (!this.get(address)?.active) return null;
    const sid=`demo-notification-${randomUUID()}`;
    this.db.prepare('INSERT INTO demo_notifications VALUES(?,?,?,?)').run(sid,address,body,new Date(createdAt).toISOString());
    return sid;
  }
  demoNotifications(address) { return this.db.prepare('SELECT sid,body,created_at FROM demo_notifications WHERE address=? ORDER BY created_at,sid').all(address); }
  cached(sid) {
    this.purge();
    return this.db.prepare('SELECT address,reply FROM receipts WHERE sid=?').get(sid);
  }
  remember(sid, address, reply) {
    this.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?)').run(sid, address, reply ?? '', Date.now()+86_400_000);
  }
  purge() { this.db.prepare('DELETE FROM receipts WHERE expires_at<=?').run(Date.now()); }
  counts() {
    return { registered: this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
      active: this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE active=1').get().count };
  }
  close() { this.db.close(); }
}
