import { findNearbyShows, findFutureShows } from './shows.mjs';
import { LocationError } from './locations.mjs';
import { DemoTimeZoneProvider, GoogleTimeZoneProvider, TimeZoneError } from './timezones.mjs';
import { findWeekendShows } from './reminders.mjs';
import { groupEventResults } from './event-groups.mjs';

export function validSender(address) { return /^(whatsapp:)?\+[1-9]\d{7,14}$/.test(address ?? ''); }
const STOP = new Set(['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT']);
const dateLabel = iso => new Intl.DateTimeFormat('en-US', { month:'short',day:'numeric',timeZone:'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const tidy = (value, max=120) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max);
const reminderHourLabel = hour => `${hour%12||12} ${hour>=12?'PM':'AM'}`;

export class Bot {
  constructor({ config, store, source, geocoder, timezones=config.mode==='demo'?new DemoTimeZoneProvider():new GoogleTimeZoneProvider({apiKey:config.googleMapsApiKey}), clock = () => new Date() }) {
    Object.assign(this, { config, store, source, geocoder, timezones, clock });
    this.pages = new Map();
    this.limits = new Map();
  }
  cleanup() {
    const now = Date.now();
    for (const [key, item] of this.pages) if (item.expiresAt <= now) this.pages.delete(key);
    for (const [key, item] of this.limits) if (item.resetAt <= now) this.limits.delete(key);
  }
  page(address, results) {
    const footer = 'Reply MORE for more shows. STOP to opt out.';
    let text = results.heading;
    let index = 0;
    while (index < results.blocks.length) {
      const block = results.blocks[index];
      if (text.length + block.length + footer.length + 6 > 1450) break;
      text += `\n\n${block}`;
      index++;
    }
    const remaining = results.blocks.slice(index);
    if (remaining.length) {
      this.pages.set(address, { ...results, heading:results.nextHeading || 'More nearby shows:', blocks:remaining, expiresAt:Date.now()+600_000 });
      return `${text}\n\n${footer}`;
    }
    this.pages.delete(address);
    return `${text}\n\nSTOP to opt out.`;
  }
  async handle({ from, body='', latitude, longitude, optOutType }, { signal } = {}) {
    this.cleanup();
    if (!validSender(from)) throw new Error('Invalid sender');
    const text = String(body).trim();
    const command = text.toUpperCase();
    const primary = [...this.config.registrationKeywords].find(k=>!['HELP','START'].includes(k)) || 'SHOWS';
    const reminderTime=reminderHourLabel(this.config.reminderHour??22);
    const opt = String(optOutType || '').toUpperCase();
    if (opt === 'STOP' || STOP.has(command)) {
      this.store.stop(from); this.pages.delete(from); this.limits.delete(from);
      return opt === 'STOP' ? null : 'You are unsubscribed. Reply START to register again.';
    }
    if (command === 'DELETE') {
      this.store.forget(from); this.pages.delete(from); this.limits.delete(from);
      return `Your registration and cached replies have been deleted from Show Finder. Reply ${primary} to register again.`;
    }
    if (opt === 'HELP') return null;
    if (command === 'HELP') return `Send ${primary} to register, then send a city and state, ZIP, or address. WhatsApp location pins work too.${this.config.remindersEnabled?` We save your location for daily reminders around ${reminderTime} in its local time zone.`:''} Send a new location to update it. Searches cover the next ${this.config.days} calendar days within ${this.config.radiusMiles} straight-line miles, an approximate two-hour radius. WEEKEND: nearby Friday-Sunday shows at your saved location. FULL: all future events at all locations. MORE: next results. STOP: unsubscribe. DELETE: erase registration and location.`;
    if (command === 'PRIVACY') return 'We store your phone/channel, registration status, latest location coordinates and label, time zone, and daily reminder delivery records. Replies are cached for up to 24 hours for duplicate delivery; additional results stay in memory for 10 minutes. STOP disables reminders. DELETE erases registration, saved location, and reminder records. Messaging providers keep their own records.';
    if (opt === 'START' || this.config.registrationKeywords.has(command) || command === 'START') {
      const registered=this.store.register(from);
      const schedule=this.config.remindersEnabled ? ` Daily weekend reminders will arrive around ${reminderTime} in your saved location's time zone.${registered.location_label?` Your saved location is ${tidy(registered.location_label)}.`:''} Send a location again when you change towns.` : '';
      return opt === 'START' ? null : `You are registered for Show Finder. We saved your ${from.startsWith('whatsapp:')?'WhatsApp':'SMS'} number. Send your city and state, ZIP, or address${from.startsWith('whatsapp:')?', or share a location pin':''}. I will find shows in the next ${this.config.days} days near you.${schedule} Replies use an approximate ${this.config.radiusMiles}-mile radius. Send FULL for all future events at all locations. STOP to opt out; DELETE to erase your registration and location.`;
    }
    const user = this.store.get(from);
    if (!user?.active) return `Reply ${primary} to register${user ? ' again' : ''}, then send a location for nearby shows or FULL for all future events. STOP to opt out.`;
    if (command === 'MORE') {
      const page = this.pages.get(from);
      return page ? this.page(from, page) : 'No more saved results. Send FULL or your city and state, ZIP, or address for a new search.';
    }
    if (!text && latitude == null && longitude == null) return 'Send a city and state, ZIP, address, or a WhatsApp location pin. HELP for instructions.';
    if (text.length > 200) return 'Please send just your city and state, ZIP, or address (up to 200 characters).';
    const limit = this.limits.get(from) || { count:0, resetAt:Date.now()+60_000 };
    if (limit.count >= 5) return 'Please wait a minute before searching again.';
    limit.count++; this.limits.set(from, limit);
    this.pages.delete(from);
    let expectedLocationRevision=user.location_revision,requestRevision;
    const stillRegistered = () => {
      const current=this.store.get(from);
      return current?.active && current.revision===user.revision && current.location_revision===expectedLocationRevision && (!requestRevision || current.location_request_revision===requestRevision);
    };
    let origin, savedNotice='';
    try {
      if (command === 'FULL') {
        const snapshot = await this.source.load({ signal });
        if (!stillRegistered()) return null;
        const found = findFutureShows({ shows:snapshot.shows, now:this.clock(), timeZone:user.location_timezone||this.config.timeZone, signal });
        if (!found.matches.length) return 'No future events are currently listed in the tracker. STOP to opt out.';
        const results = groupEventResults(found.matches);
        const blocks = results.map(show => [
          `${tidy(show.artist,120)}\n${tidy(show.dateLabel,70)} | ${tidy(show.venue,100) || 'Venue not announced.'}`,
          show.locationSource==='city' ? `${tidy(show.city,130)} (city approximation)` : tidy(show.locationQuery,160) || 'Location not announced.',
          show.ticketUrl ? `Tickets: ${show.ticketUrl.slice(0,300)}` : 'Ticket link not listed.',
          show.youtubeUrl ? `Listen: ${show.youtubeUrl.slice(0,240)}` : '',
        ].filter(Boolean).join('\n'));
        return this.page(from, {
          heading:`${results.length} upcoming show${results.length===1?'':'s'}\nAll locations; ${found.windowStart} onward.`,
          nextHeading:'More upcoming shows:', blocks,
        });
      }
      if (command === 'WEEKEND') {
        if (user.location_lat==null || !user.location_timezone) return 'Send your city and state, ZIP, address, or a WhatsApp location pin first. I will save it for weekend shows and local-time reminders.';
        origin={lat:user.location_lat,lng:user.location_lng,label:user.location_label};
      } else {
        requestRevision=this.store.beginLocationUpdate(from,user.revision);
        if (!requestRevision) return null;
        if (latitude != null || longitude != null) {
          const lat = Number(latitude), lng = Number(longitude);
          if (latitude == null || longitude == null || String(latitude).trim()==='' || String(longitude).trim()==='' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180) {
            return 'That location pin is invalid. Please share a new pin or send a city and state.';
          }
          origin = { lat,lng,label:'your shared location',approximate:false };
        } else origin = await this.geocoder.resolve(text, { signal, cache:false });
      }
      if (!stillRegistered()) return null;
      let timeZone=user.location_timezone||this.config.timeZone;
      if (command !== 'WEEKEND') {
        timeZone=await this.timezones.resolve(origin,{signal});
        signal?.throwIfAborted();
        if (!stillRegistered()) return null;
        const saved=this.store.saveLocation(from,origin,timeZone,user.revision,requestRevision);
        if (!saved) return null;
        expectedLocationRevision=saved.location_revision;
        savedNotice=`Saved location: ${tidy(origin.label)}.${this.config.remindersEnabled?` Daily weekend reminders around ${reminderTime} local time (${timeZone}).`:''}\nSend a new location when you are in a different town.\n\n`;
      }
      const snapshot = await this.source.load({ signal });
      if (!stillRegistered()) return null;
      const search={ shows:snapshot.shows,origin,geocoder:this.geocoder,now:this.clock(),timeZone,days:this.config.days,radiusMiles:this.config.radiusMiles,weekendPolicy:this.config.reminderWeekendPolicy,signal };
      const found = await (command==='WEEKEND'?findWeekendShows(search):findNearbyShows(search));
      if (!stillRegistered()) return null;
      const results = groupEventResults(found.matches);
      const heading = `${savedNotice}${results.length ? results.length+' nearby '+(command==='WEEKEND'?'weekend ':'')+'show'+(results.length===1?'':'s') : 'No nearby shows'} for ${tidy(origin.label)}\n${dateLabel(found.windowStart)} - ${dateLabel(found.windowEnd)}; within ${this.config.radiusMiles} straight-line miles (approx. two-hour radius, travel time varies).`;
      const excluded = found.excludedCount ? `\n${found.excludedCount} show${found.excludedCount===1?'':'s'} in this period could not be located.` : '';
      if (!found.matches.length) return `${heading}${excluded}\nTry another location. STOP to opt out.`;
      const blocks = results.map(show => [
        `${tidy(show.artist,120)}\n${tidy(show.dateLabel,70)} | ${tidy(show.venue,100)}`,
        `${show.locationSource==='city' ? `${tidy(show.city,130)} (city approximation)` : tidy(show.locationQuery,160)}\nApprox. ${Math.round(show.distanceMiles)} straight-line mile${Math.round(show.distanceMiles)===1?'':'s'}${show.locationApproximate?' (coarse location)':''}`,
        show.ticketUrl ? `Tickets: ${show.ticketUrl.slice(0,300)}` : 'Ticket link not listed.',
        show.youtubeUrl ? `Listen: ${show.youtubeUrl.slice(0,240)}` : '',
      ].filter(Boolean).join('\n'));
      return this.page(from, { heading:heading+excluded,blocks });
    } catch (error) {
      if (!stillRegistered()) return null;
      if (error instanceof TimeZoneError) return `I could not determine the local time zone. Your saved location was not changed. ${this.config.mode==='demo'?'Try a supported demo city.':'Please send your city and state or try again shortly.'}`;
      if (this.config.mode === 'demo' && error instanceof LocationError && error.code==='NOT_FOUND') return 'The offline demo supports Dallas TX, Fort Worth TX, Austin TX, Las Vegas NV, Los Angeles CA, Chicago IL, and Houston TX. Live mode supports other addresses with a geocoding key.';
      if (error instanceof LocationError && ['NOT_FOUND','AMBIGUOUS'].includes(error.code)) {
        return 'I could not identify that location clearly. Please send a city with state/country, a ZIP, a full address, or a WhatsApp location pin.';
      }
      if (this.config.mode === 'demo' && error instanceof LocationError) return 'The offline demo supports Dallas TX, Fort Worth TX, Austin TX, Las Vegas NV, Los Angeles CA, Chicago IL, and Houston TX. Live mode supports other addresses with a geocoding key.';
      return `${savedNotice}Show search is temporarily unavailable. Please try again shortly. Your registration is saved.`;
    }
  }
}
