import test from 'node:test';
import assert from 'node:assert/strict';
import { groupEventResults, mergeShowSlots } from '../src/event-groups.mjs';

const row = (index, overrides = {}) => ({
  id: `row-${index}`, artist: `DJ ${index}`, event: 'Electric Weekend',
  date: '2026-10-09', dateLabel: 'Fri, Oct 9, 2026',
  city: 'Dallas, TX', venue: 'Festival Grounds', address: '100 Festival Road, Dallas, TX',
  locationQuery: '100 Festival Road, Dallas, TX', locationSource: 'address', locationApproximate: false,
  distanceMiles: 20, ticketUrl: 'https://example.com/festival',
  youtubeUrl: `https://www.youtube.com/watch?v=dj${index}`, ...overrides,
});
const rows = (count, overrides) => Array.from({ length: count }, (_, index) => row(index, overrides));

test('festival results combine the listed music styles without duplicates or inferred genres', () => {
  const input = [row(0, { style: 'House, Techno' }), row(1, { style: ' house ; Trance ' }), row(2, { style: '' }), row(3)];
  const before = structuredClone(input);
  assert.equal(groupEventResults(input)[0].style, 'House, Techno, Trance');
  assert.equal(groupEventResults(rows(4))[0].style, '');
  assert.equal(groupEventResults(input.slice(0, 3))[0].style, 'House, Techno');
  assert.deepEqual(input, before);
});

test('festival categories preserve complete matching labels and do not inherit only the nearest row', () => {
  const input = [row(0, { category: ' Festival ', distanceMiles: 30 }), row(1, { category: 'festival', distanceMiles: 2 }), row(2, { category: ' Daytime / Nighttime ' }), row(3, { category: '' })];
  const before = structuredClone(input);
  const [mixed] = groupEventResults(input);
  assert.deepEqual(mixed.categories, ['Festival', 'Daytime / Nighttime']);
  assert.equal(mixed.category, '');
  const [single] = groupEventResults(rows(4, { category: 'Festival' }));
  assert.equal(single.category, 'Festival');
  assert.deepEqual(single.categories, ['Festival']);
  assert.deepEqual(groupEventResults(rows(4))[0].categories, []);
  assert.deepEqual(input, before);
});

test('three entries remain separate and four become one named event', () => {
  const three = rows(3);
  assert.deepEqual(groupEventResults(three), three);
  assert.equal(groupEventResults(three)[0], three[0]);
  const [event] = groupEventResults(rows(4));
  assert.equal(event.artist, 'Electric Weekend');
  assert.equal(event.event, 'Electric Weekend');
  assert.equal(event.type, 'event');
  assert.equal(event.entryCount, 4);
  assert.equal(event.date, '2026-10-09');
  assert.equal(event.dateEnd, '2026-10-09');
  assert.equal(event.dateLabel, 'Oct 9, 2026');
});

test('hundreds of DJs produce one event without adding an artist roster', () => {
  const result = groupEventResults(rows(500));
  assert.equal(result.length, 1);
  assert.equal(result[0].entryCount, 500);
  assert.equal(result[0].artist, 'Electric Weekend');
  assert.equal(Object.hasOwn(result[0], 'artists'), false);
});

test('the threshold only counts entries in the filtered result', () => {
  const source = rows(20);
  const selected = source.filter((_, index) => index < 3);
  assert.equal(groupEventResults(selected).length, 3);
  assert.equal(groupEventResults(source).length, 1);
});

test('a standalone event announcement does not become a fourth performer or duplicate a small lineup', () => {
  const announcement = row('announcement', { artist: 'Electric Weekend', type: 'event', entryCount: 0 });
  for (let count = 1; count <= 3; count++) {
    const lineup = rows(count);
    const result = groupEventResults([announcement, ...lineup]);
    assert.deepEqual(result, lineup);
    assert.ok(result.every((show, index) => show === lineup[index]));
  }
  assert.deepEqual(groupEventResults([announcement]), [announcement]);
});

test('an event announcement merges into a large lineup without inflating its DJ count', () => {
  const announcement = row('announcement', {
    artist: 'Electric Weekend', type: 'event', entryCount: 0, date: '2026-10-11',
    ticketUrl: 'https://example.com/weekend-pass',
  });
  const lineup = rows(4);
  const before = structuredClone([announcement, ...lineup]);
  Object.freeze(announcement);
  lineup.forEach(Object.freeze);
  const result = groupEventResults([announcement, ...lineup]);
  assert.equal(result.length, 1);
  assert.equal(result[0].entryCount, 4);
  assert.equal(result[0].artist, 'Electric Weekend');
  assert.equal(result[0].date, '2026-10-09');
  assert.equal(result[0].dateEnd, '2026-10-11');
  assert.deepEqual(result[0].ticketLinks.map(ticket => ticket.url), ['https://example.com/festival', 'https://example.com/weekend-pass']);
  assert.deepEqual([announcement, ...lineup], before);
});

test('multiple event-only rows consolidate dates and tickets without inventing a performer count', () => {
  const input = [
    row('friday', { artist: 'Electric Weekend', type: 'event', entryCount: 0 }),
    row('saturday', { artist: 'Electric Weekend', type: 'event', entryCount: 0, date: '2026-10-10', ticketUrl: 'https://example.com/saturday' }),
  ];
  const [event] = groupEventResults(input);
  assert.equal(groupEventResults(input).length, 1);
  assert.equal(event.entryCount, 0);
  assert.equal(event.type, 'event');
  assert.equal(event.dateLabel, 'Oct 9, 2026 – Oct 10, 2026');
  assert.equal(event.ticketLinks.length, 2);
  const nextWeek = row('next-week', { artist: 'Electric Weekend', type: 'event', entryCount: 0, date: '2026-10-16' });
  assert.equal(groupEventResults([...input, nextWeek]).length, 2);
});

test('standalone announcements at another named event or known site remain separate from a lineup', () => {
  const elsewhere = row('announcement', {
    artist: 'Electric Weekend', type: 'event', entryCount: 0,
    address: '200 Other Road, Dallas, TX', locationQuery: '200 Other Road, Dallas, TX',
  });
  const otherEvent = row('other', { artist: 'Other Festival', event: 'Other Festival', type: 'event', entryCount: 0 });
  const result = groupEventResults([...rows(4), elsewhere, otherEvent]);
  assert.equal(result.length, 3);
  assert.equal(result[0].entryCount, 4);
  assert.equal(result[1], elsewhere);
  assert.equal(result[2], otherEvent);
});

test('contiguous festival days combine into a single date range', () => {
  const input = [row(0), row(1), row(2, { date: '2026-10-10' }), row(3, { date: '2026-10-11' })];
  const [event] = groupEventResults(input);
  assert.equal(event.date, '2026-10-09');
  assert.equal(event.dateEnd, '2026-10-11');
  assert.equal(event.dateLabel, 'Oct 9, 2026 – Oct 11, 2026');
  assert.equal(event.entryCount, 4);
});

test('Friday and Sunday combine despite missing Saturday while next Friday stays separate', () => {
  const festival = [row(0), row(1), row(2, { date: '2026-10-11' }), row(3, { date: '2026-10-11' })];
  const nextFriday = rows(4, { date: '2026-10-16' });
  const result = groupEventResults([...festival, ...nextFriday]);
  assert.equal(result.length, 2);
  assert.equal(result[0].entryCount, 4);
  assert.equal(result[0].date, '2026-10-09');
  assert.equal(result[1].entryCount, 4);
  assert.equal(result[1].date, '2026-10-16');
  assert.equal(result[0].dateEnd, '2026-10-11');
});

test('separate weekends and occurrences a week apart never combine', () => {
  const first = rows(4);
  const second = rows(4, { date: '2026-10-16' });
  const result = groupEventResults([...first, ...second]);
  assert.equal(result.length, 2);
  assert.equal(result[0].date, '2026-10-09');
  assert.equal(result[1].date, '2026-10-16');
  assert.equal(groupEventResults([row(0), row(1), row(2, { date: '2026-10-16' }), row(3, { date: '2026-10-16' })]).length, 4);
});

test('a long daily series uses fixed seven-day windows instead of chaining forever', () => {
  const input = Array.from({ length: 21 }, (_, index) => row(index, { date: `2026-10-${String(index + 1).padStart(2, '0')}` }));
  const result = groupEventResults(input);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(show => show.entryCount), [7, 7, 7]);
  assert.deepEqual(result.map(show => [show.date, show.dateEnd]), [
    ['2026-10-01', '2026-10-07'], ['2026-10-08', '2026-10-14'], ['2026-10-15', '2026-10-21'],
  ]);
});

test('completed multi-day festivals sort by soonest start date before Saturday while ordinary date ties stay stable', () => {
  const sameDayFirst = row('ordinary-first', { event: '', date: '2026-10-10' });
  const sameDaySecond = row('ordinary-second', { event: '', date: '2026-10-10' });
  const input = [
    row('sunday-first', { date: '2026-10-11' }),
    row('sunday-second', { date: '2026-10-11' }),
    sameDayFirst,
    sameDaySecond,
    row('friday-first'),
    row('friday-second'),
  ];
  const before = structuredClone(input);
  const result = groupEventResults(input);
  assert.deepEqual(result.map(show => show.date), ['2026-10-09', '2026-10-10', '2026-10-10']);
  assert.equal(result[0].artist, 'Electric Weekend');
  assert.equal(result[0].dateEnd, '2026-10-11');
  assert.equal(result[0].entryCount, 4);
  assert.equal(result[1], sameDayFirst);
  assert.equal(result[2], sameDaySecond);
  assert.deepEqual(input, before);
});

test('event names and cities discriminate distinct events at the same venue', () => {
  const result = groupEventResults([
    ...rows(4), ...rows(4, { event: 'Other Festival' }), ...rows(4, { city: 'Austin, TX' }),
  ]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(show => show.artist), ['Electric Weekend', 'Other Festival', 'Electric Weekend']);
  assert.deepEqual(result.map(show => show.city), ['Dallas, TX', 'Dallas, TX', 'Austin, TX']);
});

test('distinct known sites in one city stay separate while stage names at one site combine', () => {
  const result = groupEventResults([
    ...rows(4), ...rows(4, { address: '200 Other Road, Dallas, TX', locationQuery: '200 Other Road, Dallas, TX', venue: 'Other Grounds' }),
    row('ambiguous', { address: '', locationQuery: 'Dallas, TX', locationSource: 'city' }),
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].address, '100 Festival Road, Dallas, TX');
  assert.equal(result[1].address, '200 Other Road, Dallas, TX');
  assert.equal(result[2].artist, 'DJ ambiguous');
  const stages = rows(4).map((show, index) => ({ ...show, venue: `Stage ${index}` }));
  assert.equal(groupEventResults(stages).length, 1);
});

test('event name whitespace and case normalize without losing readable spelling', () => {
  const input = [row(0, { event: '  Electric   Weekend ' }), row(1, { event: 'ELECTRIC WEEKEND' }), row(2, { event: 'Electric\nWeekend' }), row(3, { event: 'electric weekend', city: 'dallas tx' })];
  assert.equal(groupEventResults(input).length, 1);
  assert.equal(groupEventResults(input)[0].artist, 'Electric Weekend');
});

test('missing or generic event names and unknown locations stay separate', () => {
  for (const event of ['', null, undefined, 'TBA', 'To be announced', 'unknown', 'Event', 'Music Festival', 'Festival']) {
    assert.equal(groupEventResults(rows(4, { event })).length, 4, String(event));
  }
  assert.equal(groupEventResults(rows(4, { city: '', address: '', locationQuery: null, venue: 'TBA' })).length, 4);
  assert.equal(groupEventResults(rows(4, { date: '2026-02-30' })).length, 4);
});

test('a named event falls back to a known address or venue when city is absent', () => {
  assert.equal(groupEventResults(rows(4, { city: '' })).length, 1);
  assert.equal(groupEventResults(rows(4, { city: '', address: '', locationQuery: null })).length, 1);
  assert.equal(groupEventResults([
    ...rows(2, { city: '', address: 'Other Road', locationQuery: 'Other Road' }),
    ...rows(2, { city: '', address: '100 Festival Road', locationQuery: '100 Festival Road' }),
  ]).length, 4);
});

test('event location metadata all comes from the nearest matching entry', () => {
  const input = [row(0), row(1, { distanceMiles: 8, address: '', locationQuery: 'Dallas, TX', locationSource: 'city', locationApproximate: true }), row(2), row(3)];
  const [event] = groupEventResults(input);
  assert.equal(event.distanceMiles, 8);
  assert.equal(event.address, '');
  assert.equal(event.locationQuery, 'Dallas, TX');
  assert.equal(event.locationSource, 'city');
  assert.equal(event.locationApproximate, true);
});

test('distinct day tickets survive while tracking variants deduplicate and unsafe links are rejected', () => {
  const input = [
    row(0, { ticketUrl: 'javascript:alert(1)' }),
    row(1, { ticketUrl: 'https://user:secret@example.com/tickets' }),
    row(2, { ticketUrl: 'https://tickets.example/event?day=friday&utm_source=ig' }),
    row(3, { ticketUrl: 'https://tickets.example/event?utm_source=email&day=friday' }),
    row(4, { date: '2026-10-10', ticketUrl: 'https://tickets.example/event?day=saturday' }),
  ];
  const [event] = groupEventResults(input);
  assert.equal(event.ticketUrl, 'https://tickets.example/event?day=friday&utm_source=ig');
  assert.equal(event.ticketLinks.length, 2);
  assert.match(event.ticketLinks[0].label, /Oct 9, 2026/);
  assert.match(event.ticketLinks[1].label, /Oct 10, 2026/);
  assert.equal(event.ticketLinks[1].url, 'https://tickets.example/event?day=saturday');
  assert.equal(event.youtubeUrl, 'https://www.youtube.com/results?search_query=Electric%20Weekend');
  assert.equal(groupEventResults(rows(4, { ticketUrl: 'data:text/html,bad' }))[0].ticketUrl, null);
});

test('output is stable at the first occurrence and source records are not mutated', () => {
  const unchanged = row('solo', { event: '' });
  const source = [row(0, { distanceMiles: 30 }), unchanged, row(1, { distanceMiles: 10 }), row(2), row(3), row('later', { event: 'Other Event' })];
  const before = structuredClone(source);
  source.forEach(Object.freeze);
  Object.freeze(source);
  const result = groupEventResults(source);
  assert.deepEqual(source, before);
  assert.equal(result.length, 3);
  assert.equal(result[0].artist, 'Electric Weekend');
  assert.equal(result[1], unchanged);
  assert.equal(result[2], source.at(-1));
  assert.notEqual(result[0], source[0]);
});

test('empty results and invalid arguments have predictable behavior', () => {
  assert.deepEqual(groupEventResults([]), []);
  assert.throws(() => groupEventResults(null), /matches must be an array/);
});


test('browser slots combine a small same-time lineup and retain stable heading, metadata, styles and categories', () => {
  const input = [
    row(0, {artist:'Alpha',event:'Alpha',venue:"It'll Do Club",startTime:'20:00',style:'House; Techno',category:'Club',distanceMiles:30}),
    row(1, {artist:'Beta',event:'Friday Night',venue:'IT’LL DO CLUB',city:'dallas tx',startTime:'20:00:00',style:' house, Trance ',category:'Daytime / Nighttime',distanceMiles:4}),
  ];
  const before=structuredClone(input);
  const [group]=mergeShowSlots(input);
  assert.equal(group.type,'show-group');assert.equal(group.id,'row-0');
  assert.equal(group.artist,'Alpha, Beta');assert.equal(group.event,'Friday Night');
  assert.equal(group.style,'House, Techno, Trance');assert.equal(group.category,'');
  assert.deepEqual(group.categories,['Club','Daytime / Nighttime']);assert.equal(group.entryCount,2);
  assert.equal(group.distanceMiles,4);assert.equal(group.venue,'IT’LL DO CLUB');
  assert.equal(group.dateLabel,input[0].dateLabel);assert.equal(group.startTime,'20:00:00');
  assert.deepEqual(input,before);
  assert.equal(groupEventResults(input).length,2,'Messaging and festival counting remain separate');
});

test('explicit slot clocks, offsets, date-only rows and malformed clocks cannot smear together', () => {
  const input=[
    row('unknown-one',{startTime:null,timeSpecified:false}),
    row('late',{startTime:'23:00:00',timeSpecified:true}),
    row('early-one',{startTime:'20:00:00',timeZoneOffset:'+00:00',timeSpecified:true}),
    row('early-two',{startTime:'20:00',timeZoneOffset:'+00:00',timeSpecified:true}),
    row('other-zone',{startTime:'20:00:00',timeZoneOffset:'+01:00',timeSpecified:true}),
    row('no-zone',{startTime:'20:00:00',timeZoneOffset:null,timeSpecified:true}),
    row('unknown-two',{startTime:null,timeSpecified:false}),
    row('bad',{startTime:null,timeSpecified:true}),
    row('invalid',{startTime:'25:00:00',timeSpecified:true}),
  ];
  const output=mergeShowSlots(input);
  assert.equal(output.length,7);
  assert.equal(output[0].artist,'DJ early-one, DJ early-two');
  const dayOnly=output.find(show=>show.type==='show-group'&&!show.startTime);
  assert.equal(dayOnly.artist,'DJ unknown-one, DJ unknown-two');
  assert.equal(output.filter(show=>show.type==='show-group').length,2);
  assert.ok(output.includes(input[7]));assert.ok(output.includes(input[8]));
  assert.ok(output.findIndex(show=>show.artist==='DJ late')<output.indexOf(dayOnly));
});

test('slot output sorts soonest dates first, then explicit clocks, then unknown clocks with stable ties', () => {
  const input=[
    row('unknown',{venue:'Unknown Time Hall'}),
    row('late',{venue:'Late Hall',startTime:'23:00:00'}),
    row('tomorrow',{venue:'Tomorrow Hall',date:'2026-10-10',startTime:'08:00:00'}),
    row('early-a',{venue:'Early Hall A',startTime:'20:00:00'}),
    row('early-b',{venue:'Early Hall B',startTime:'20:00:00'}),
  ];
  assert.deepEqual(mergeShowSlots(input).map(show=>show.id),['row-early-a','row-early-b','row-late','row-unknown','row-tomorrow']);
});

test('slot sites require a physical venue or street plus city, and never combine conflicting known sites', () => {
  for(const changes of [
    {venue:'Other Grounds'},
    {address:'200 Other Road, Dallas, TX'},
    {city:'Austin, TX'},
    {date:'2026-10-10'},
  ])assert.equal(mergeShowSlots([row(0),row(1,changes)]).length,2,JSON.stringify(changes));
  for(const changes of [
    {venue:'TBA',address:'',locationSource:'city'},
    {venue:'Dallas, TX',address:'Dallas, TX',locationSource:'city'},
    {venue:'TBA',address:'Dallas, TX 75201',locationSource:'address'},
    {venue:'TBA',address:'32.77 -96.79',locationSource:'address'},
  ])assert.equal(mergeShowSlots(rows(2,{...changes,lat:32.77,lng:-96.79})).length,2,JSON.stringify(changes));
  assert.equal(mergeShowSlots(rows(2,{venue:'TBA',address:'100 Festival Road, Dallas, TX'})).length,1);
  assert.equal(mergeShowSlots(rows(2,{address:'',locationSource:'city',locationApproximate:true})).length,1,'A named venue and city identify a site even when coordinates are approximate');
});

test('ambiguous partial locations remain separate regardless of input order', () => {
  const first=row('a',{address:'100 Festival Road, Dallas, TX'});
  const second=row('b',{address:'200 Other Road, Dallas, TX'});
  const missing=row('missing',{address:'',locationSource:'city'});
  for(const input of [[first,second,missing],[missing,second,first]])assert.equal(mergeShowSlots(input).length,3);
  const sameAddress=row('other-venue',{venue:'Other Grounds'});
  const missingVenue=row('missing-venue',{venue:'TBA'});
  assert.equal(mergeShowSlots([first,sameAddress,missingVenue]).length,3);
  const [merged]=mergeShowSlots([first,missing]);
  assert.equal(merged.entryCount,2,'A uniquely established site can fill missing location identity without inventing a second venue');
});

test('comma rosters deduplicate independently listed names while genuine comma names remain intact', () => {
  const input=[
    row(0,{artist:'Jack Marlow'}),
    row(1,{artist:'Jack Marlow, Ravver'}),
    row(2,{artist:' ravver '}),
    row(3,{artist:'JACK  MARLOW'}),
  ];
  const [group]=mergeShowSlots(input);
  assert.equal(group.artist,'Jack Marlow, Ravver');assert.deepEqual(group.artists,['Jack Marlow','Ravver']);
  assert.equal(group.entryCount,4,'Duplicate source records still count as original entries');
  const [literal]=mergeShowSlots([row(0,{artist:'DJ, Friends',youtubeUrl:null}),row(1,{artist:'Other Artist',youtubeUrl:null})]);
  assert.deepEqual(literal.artists,['DJ, Friends','Other Artist']);
  assert.equal(literal.youtubeLinks[0].url,'https://www.youtube.com/results?search_query=DJ%2C%20Friends');
});

test('merged slots preserve all safe tickets and performer videos, with a search only for missing artists', () => {
  const input=[
    row(0,{artist:'Alpha',ticketUrl:'https://tickets.example/event?day=friday&utm_source=ig',youtubeUrl:'https://www.youtube.com/watch?v=shared'}),
    row(1,{artist:'Beta',ticketUrl:'https://tickets.example/event?utm_source=email&day=friday',youtubeUrl:'https://www.youtube.com/watch?v=shared'}),
    row(2,{artist:'Gamma',ticketUrl:'javascript:alert(1)',youtubeUrl:'https://user:secret@www.youtube.com/watch?v=bad',ticketLinks:[{url:'https://tickets.example/event?day=saturday',label:'Second ticket'},{url:'data:text/html,bad',label:'Unsafe'}]}),
    row(3,{artist:'ALPHA',ticketUrl:null,youtubeUrl:null}),
  ];
  const before=structuredClone(input),[group]=mergeShowSlots(input);
  assert.deepEqual(group.ticketLinks.map(link=>link.url),['https://tickets.example/event?day=friday&utm_source=ig','https://tickets.example/event?day=saturday']);
  assert.deepEqual(group.youtubeLinks,[
    {url:'https://www.youtube.com/watch?v=shared',label:'YouTube · Alpha'},
    {url:'https://www.youtube.com/watch?v=shared',label:'YouTube · Beta'},
    {url:'https://www.youtube.com/results?search_query=Gamma',label:'YouTube search · Gamma'},
  ]);
  assert.deepEqual(input,before);
});

test('existing merged slots retain original counts and safe link lists when another performer joins', () => {
  const prior=mergeShowSlots([row(0,{artist:'Alpha',category:'Club'}),row(1,{artist:'Beta',category:'Concert'})])[0];
  const [combined]=mergeShowSlots([prior,row(2,{artist:'Gamma',category:'Club'})]);
  assert.equal(combined.id,prior.id);assert.equal(combined.artist,'Alpha, Beta, Gamma');assert.equal(combined.entryCount,3);
  assert.deepEqual(combined.categories,['Club','Concert']);
  assert.deepEqual(combined.youtubeLinks.map(link=>link.label),['YouTube · Alpha','YouTube · Beta','YouTube · Gamma']);
});

test('festival grouping still counts original performers before slot merging and keeps multi-day cards intact', () => {
  const three=rows(3);
  assert.equal(groupEventResults(three).length,3);
  assert.equal(mergeShowSlots(groupEventResults(three))[0].type,'show-group');
  const [festival]=mergeShowSlots(groupEventResults(rows(4)));
  assert.equal(festival.type,'event');assert.equal(festival.artist,'Electric Weekend');assert.equal(festival.entryCount,4);
  assert.equal(Object.hasOwn(festival,'artists'),false);
  const weekend=groupEventResults([row(0),row(1),row(2,{date:'2026-10-10'}),row(3,{date:'2026-10-10'})])[0];
  const solo=row('solo',{event:'',artist:'Solo Artist'});
  const result=mergeShowSlots([weekend,solo]);
  assert.equal(result.length,2);assert.equal(result[0],weekend);assert.equal(result[1],solo);
});

test('same-day event cards consolidate by headline without inventing a performer roster', () => {
  const festival=groupEventResults(rows(4))[0];
  const duplicate=row('duplicate',{artist:'Electric Weekend',event:'Electric Weekend',type:'event',entryCount:0,dateEnd:'2026-10-09',youtubeUrl:'https://www.youtube.com/results?search_query=Electric%20Weekend'});
  const [merged]=mergeShowSlots([festival,duplicate]);
  assert.equal(merged.type,'show-group');assert.equal(merged.artist,'Electric Weekend');assert.equal(merged.entryCount,4);
  assert.deepEqual(merged.artists,['Electric Weekend']);
  assert.equal(merged.youtubeLinks[0].url,festival.youtubeUrl);
  assert.equal(merged.youtubeLinks[0].label,'YouTube search · Electric Weekend');
});

test('festival clocks survive only when every original entry agrees, including explicit offset', () => {
  const uniform=rows(4,{startTime:'20:00:00',timeSpecified:true,timeZoneOffset:'+00:00'});
  const [same]=groupEventResults(uniform);
  assert.equal(same.startTime,'20:00:00');assert.equal(same.timeZoneOffset,'+00:00');
  for(const change of [{startTime:'23:00:00'},{startTime:null,timeSpecified:false},{timeZoneOffset:'+01:00'},{timeZoneOffset:null},{startTime:null,timeSpecified:true}]){
    const [different]=groupEventResults([...uniform.slice(0,3),row(3,{...uniform[3],...change})]);
    assert.equal(different.startTime,null);assert.equal(different.timeZoneOffset,null);
    assert.equal(different.timeSpecified,true);
    assert.equal(mergeShowSlots([different,row('unknown',{event:'',startTime:null,timeSpecified:false})]).length,2);
  }
});

test('slot merging leaves invalid records and frozen inputs untouched', () => {
  const source=[row(0),row(1),row('invalid',{date:'2026-02-30'})],before=structuredClone(source);
  source.forEach(Object.freeze);Object.freeze(source);
  assert.equal(mergeShowSlots(source).length,2);assert.deepEqual(source,before);
  assert.deepEqual(mergeShowSlots([]),[]);assert.throws(()=>mergeShowSlots(null),/matches must be an array/);
});


test('identical street addresses work with missing City without guessing from a venue or coordinates', () => {
  assert.equal(mergeShowSlots(rows(2,{city:''})).length,1);
  assert.equal(mergeShowSlots([row(0,{city:''}),row(1)]).length,1,'The exact same street has one independently supplied city');
  assert.equal(mergeShowSlots([row(0,{city:''}),row(1),row(2,{city:'Austin, TX'})]).length,3,'Conflicting supplied cities must not absorb the cityless row');
  assert.equal(mergeShowSlots(rows(2,{city:'',address:'',venue:'Festival Grounds'})).length,2);
  assert.equal(mergeShowSlots(rows(2,{city:'',address:'Dallas, TX 75201',venue:'TBA'})).length,2);
  assert.equal(mergeShowSlots(rows(2,{city:'',venue:'TBA',address:'100 Festival Road, Dallas, TX'})).length,1);
});
