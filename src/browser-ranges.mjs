import {calendarDate} from './shows.mjs';
import {weekendWindow} from './reminders.mjs';

const DAY=86_400_000;
export const browserRangeLabels=Object.freeze({today:'Today',nearby:'Next 7 days',weekend:'This weekend',month:'This month','three-months':'Next 3 months',full:'All upcoming shows'});
const instant=iso=>new Date(`${iso}T12:00:00Z`);
const iso=date=>date.toISOString().slice(0,10);
const addDays=(date,count)=>iso(new Date(instant(date).getTime()+count*DAY));

/** Calendar windows use the accepted location's zone, not elapsed UTC hours. */
export function browserDateWindow(view,now,timeZone,defaultDays=7) {
 if(!Object.hasOwn(browserRangeLabels,view))throw new TypeError('Unsupported browser date range.');
 const today=calendarDate(now,timeZone);
 let start=today,end;
 if(view==='full')return{start,end:null,days:null,label:browserRangeLabels.full};
 if(view==='today')end=today;
 if(view==='nearby')end=addDays(today,defaultDays-1);
 if(view==='weekend') {
  const weekend=weekendWindow(now,timeZone);
  start=weekend.start<today?today:weekend.start;end=weekend.end;
 }
 if(view==='month') {
  const [year,month]=today.split('-').map(Number);
  end=iso(new Date(Date.UTC(year,month,0,12)));
 }
 if(view==='three-months') {
  const [year,month,day]=today.split('-').map(Number);
  const boundary=new Date(Date.UTC(year,month-1+3,1,12));
  const lastDay=new Date(Date.UTC(boundary.getUTCFullYear(),boundary.getUTCMonth()+1,0,12)).getUTCDate();
  boundary.setUTCDate(Math.min(day,lastDay));
  end=addDays(iso(boundary),-1);
 }
 const days=Math.round((instant(end)-instant(start))/DAY)+1;
 return{start,end,days,label:view==='nearby'?`Next ${defaultDays} days`:browserRangeLabels[view]};
}
