import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calendarDate, parseShowDate } from '../src/shows.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dayMilliseconds = 86_400_000;
const headers = ['Artist', 'Event', 'Location', 'City', 'Address', 'Ticket Link', 'Show Time', 'YouTube (Most Popular Song)', 'Style'];
const description = 'Fictional sample events for demonstrating Rave Now. These are not real shows or ticket offers.';
const addDays = (date, offset) => new Date(new Date(`${date}T12:00:00Z`).getTime() + offset * dayMilliseconds).toISOString().slice(0, 10);
const dateLabel = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Fixed anchors make fixtures repeatable; no argument refreshes the sample to today. */
export function buildSampleData(anchorDate = calendarDate(new Date(), process.env.TIME_ZONE || 'America/Chicago')) {
  if (typeof anchorDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || parseShowDate(anchorDate) !== anchorDate) {
    throw new TypeError('The sample anchor must be a valid YYYY-MM-DD calendar date.');
  }
  const weekday = new Date(`${anchorDate}T12:00:00Z`).getUTCDay();
  const fridayOffset = weekday === 0 ? -2 : 5 - weekday;
  const rows = [headers.slice()];
  const add = ({ artist = '', event = '', venue, city, address = '', offset, time = '9:00 PM', tickets = true, listen = true }) => {
    const title = artist || event;
    rows.push([
      artist, event, venue, city, address,
      tickets ? `https://example.com/sample-tickets/${slug(title)}` : '',
      `${dateLabel(addDays(anchorDate, offset))} - ${time}`,
      artist && listen ? `https://www.youtube.com/results?search_query=${encodeURIComponent(artist)}` : '',
      artist === 'Sample Circuit' ? 'Techno' : artist === 'Sample Pulse' ? 'Trance' : 'House',
    ]);
  };

  add({ artist: 'Sample Archive', venue: 'Sample Yesterday Hall', city: 'Dallas, TX', offset: -1 });
  add({ artist: 'Sample Dawn', venue: 'Sample Daylight Room', city: 'Dallas, TX', address: 'Dallas, TX', offset: 0 });
  add({ artist: 'Sample Skyline', venue: 'Sample City Room', city: 'New York, NY', offset: 0 });
  add({ artist: 'Sample Circuit', venue: 'Sample Warehouse', city: 'Dallas, TX', address: 'Dallas, TX', offset: fridayOffset });
  add({ artist: 'Sample Vector', venue: 'Sample Riverside Room', city: 'Fort Worth, TX', offset: fridayOffset + 1 });
  add({ artist: 'Sample Drift', venue: 'Sample Distant Room', city: 'Austin, TX', offset: fridayOffset + 1 });

  add({ artist: 'Sample Mirage', venue: 'Sample Desert Club', city: 'Las Vegas, NV', address: 'Las Vegas, NV', offset: fridayOffset - 1 });
  add({ artist: 'Sample Prism', venue: 'Sample Desert Club', city: 'Las Vegas, NV', address: 'Las Vegas, NV', offset: fridayOffset });
  add({ artist: 'Sample Orbit', venue: 'Sample Desert Club', city: 'Las Vegas, NV', address: 'Las Vegas, NV', offset: fridayOffset + 1 });
  add({ artist: 'Sample Aurora', venue: 'TBA', city: 'Los Angeles', offset: Math.max(0, fridayOffset + 1) });

  add({ artist: 'Sample Metro', venue: 'Sample Midtown Room', city: 'New York, NY', address: '123 Sample Avenue, New York, NY 10036', offset: fridayOffset, time: '11:00 PM' });
  add({ artist: 'Sample Tidal', venue: 'Sample Brooklyn Room', city: 'Brooklyn, NY', offset: fridayOffset, listen: false });
  add({ artist: 'Sample Pulse', venue: 'Sample Midtown Room', city: 'New York, NY', address: '123 Sample Avenue, New York, NY 10036', offset: fridayOffset + 1, time: '11:00 PM' });
  add({ artist: 'Sample Pulse', venue: 'Sample Later Room', city: 'New York, NY', offset: 15 });
  add({ artist: 'Sample Pulse', venue: 'Sample Riverside Room', city: 'Fort Worth, TX', offset: 18 });
  add({ artist: 'Sample Pulse', venue: 'Sample Winter Room', city: 'New York, NY', offset: 45 });
  add({ artist: 'Sample Horizon', venue: 'Sample Future Room', city: 'New York, NY', offset: 140 });

  add({ event: 'Sample City Lights Announcement', venue: 'Sample Open Air Stage', city: 'Fort Worth, TX', offset: fridayOffset + 2 });
  for (const artist of ['Sample Amber', 'Sample Cobalt', 'Sample Velvet', 'Sample Delta']) {
    add({ artist, event: 'Sample Daybreak Festival', venue: 'Sample Festival Grounds', city: 'Dallas, TX', address: 'TBA', offset: fridayOffset + 2 });
  }
  add({ artist: 'Sample Compass', venue: 'TBA', city: 'TBA', offset: Math.max(0, fridayOffset + 1), tickets: false, listen: false });

  return {
    rows,
    metadata: { sample: true, updatedAt: anchorDate, anchorDate, rows: rows.length - 1, description },
    catalog: {
      sample: true, description,
      artists: [...new Set(rows.slice(1).map(row => row[0]).filter(Boolean))].sort(),
      promoters: ['Sample Lantern Promotions', 'Sample Paper Moon Events'],
    },
  };
}

function tsvCell(value) {
  const text = String(value);
  return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function writeSampleData(anchorDate, outputDirectory = path.join(projectDirectory, 'data')) {
  const bundle = buildSampleData(anchorDate);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'tracker-snapshot.tsv'), `${bundle.rows.map(row => row.map(tsvCell).join('\t')).join('\n')}\n`, 'utf8');
  await writeFile(path.join(outputDirectory, 'tracker-snapshot.tsv.meta.json'), `${JSON.stringify(bundle.metadata, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outputDirectory, 'name-catalog.json'), `${JSON.stringify(bundle.catalog, null, 2)}\n`, 'utf8');
  return bundle.metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new TypeError('Usage: node scripts/generate-sample-data.mjs [YYYY-MM-DD]');
    const metadata = await writeSampleData(process.argv[2]);
    console.log(`Generated ${metadata.rows} fictional sample events anchored to ${metadata.anchorDate}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
