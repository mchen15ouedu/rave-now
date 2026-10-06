import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { projectDir } from './config.mjs';
import { LocationError } from './locations.mjs';
import { haversineMiles } from './shows.mjs';

const normalize=value=>String(value).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
const contains=(text,phrase)=>Boolean(phrase && (` ${text} `).includes(` ${phrase} `));
const countryAliases={US:['us','usa','united states','united states of america'],GB:['uk','gb','united kingdom','great britain'],CA:['canada'],AU:['australia'],FR:['france']};

/** Offline GeoNames town / US ZIP lookup. No user coordinates go to a third party.
 * Street text is resolved to its town or ZIP center and explicitly approximate.
 */
export class CityLocationProvider {
  constructor({filename=path.join(projectDir,'data/city-directory.json.gz'),directory}={}) {
    this.filename=filename;this.directory=directory;this.loading=null;
  }
  async load(signal) {
    signal?.throwIfAborted();
    if (!this.loading) this.loading=(async()=>{
      const data=this.directory||JSON.parse(gunzipSync(await readFile(this.filename)).toString('utf8'));
      this.data=data;this.names=new Map();this.regions=new Map();this.countryNames=new Map();
      for (const [code,label] of Object.entries(data.countries)) {
        this.countryNames.set(normalize(label),code);
        for (const alias of countryAliases[code]||[]) this.countryNames.set(alias,code);
      }
      for (const [code,label] of Object.entries(data.admins)) this.regions.set(normalize(label),code);
      for (const row of data.cities) {
        const names=new Set([normalize(row[0]),normalize(row[1])]);
        if (row[0]==='New York City' && row[2]==='US') {names.add('new york');names.add('nyc');}
        for (const name of names) {
          if (!name) continue;
          if (!this.names.has(name)) this.names.set(name,[]);
          this.names.get(name).push(row);
        }
      }
      this.usStates=new Map(Object.entries(data.admins).filter(([code])=>code.startsWith('US.')).flatMap(([code,label])=>[[normalize(code.slice(3)),code],[normalize(label),code]]));
    })().catch(()=>{this.loading=null;throw new LocationError('UNAVAILABLE','City lookup is temporarily unavailable. Please try again.');});
    await this.loading;signal?.throwIfAborted();
  }
  point(row) {
    return {lat:row[4],lng:row[5],label:[row[0],this.data.admins[`${row[2]}.${row[3]}`],this.data.countries[row[2]]].filter(Boolean).join(', '),approximate:true,timeZone:row[7]};
  }
  postal(query) {
    // A five-digit street number is not a ZIP. Match only the postal suffix.
    const match=query.match(/(?:^|\s)(\d{5})(?:\s\d{4})?(?:\s(?:us|usa|united states|united states of america))?$/);
    const value=match && this.data.usPostal[match[1]];
    if (!value) return null;
    let closest, distance=Infinity;
    for (const row of this.data.cities) {
      if (row[2]!=='US' || row[3]!==value[1]) continue;
      const next=haversineMiles({lat:value[2],lng:value[3]},{lat:row[4],lng:row[5]});
      if (next<distance) {closest=row;distance=next;}
    }
    return {lat:value[2],lng:value[3],label:`${value[0]}, ${value[1]} ${match[1]}`,approximate:true,timeZone:closest?.[7]};
  }
  async resolveCity(query,options={}) {return this.resolve(query,{...options,cityOnly:true});}
  async resolve(query,{signal,cityOnly=false}={}) {
    if (typeof query!=='string'||!query.trim()||query.length>300) throw new LocationError('NOT_FOUND','Enter a city and state, country, or US ZIP code.');
    await this.load(signal);
    const text=normalize(query);
    const postal=this.postal(text);
    if (postal && (!cityOnly || /^\d{5}$/.test(text))) return postal;
    const tokens=text.split(' '),found=new Map();
    for (let start=0;start<tokens.length;start++) {
      for (let size=Math.min(7,tokens.length-start);size>=1;size--) {
        const phrase=tokens.slice(start,start+size).join(' '),rows=this.names.get(phrase);
        if (!rows) continue;
        const rest=[...tokens.slice(0,start),...tokens.slice(start+size)].join(' ');
        let country;
        for (const [name,code] of this.countryNames) if (contains(rest,name) && (!country||name.length>country.name.length)) country={name,code};
        let state;
        for (const [name,code] of this.usStates) if (contains(rest,name) && (!state||name.length>state.name.length)) state={name,code};
        for (const row of rows) {
          if (country && row[2]!==country.code) continue;
          if (state && (!country||country.code==='US') && `${row[2]}.${row[3]}`!==state.code) continue;
          const regionName=normalize(this.data.admins[`${row[2]}.${row[3]}`]||'');
          const countryName=normalize(this.data.countries[row[2]]||'');
          const aliases=[regionName,normalize(row[3]),countryName,...(countryAliases[row[2]]||[]),...(row[2]==='US'?[]:[normalize(row[2])])].filter(Boolean).sort((a,b)=>b.length-a.length);
          let remainder=` ${rest} `;
          for (const alias of aliases) remainder=remainder.split(` ${alias} `).join(' ');
          if (cityOnly && remainder.trim()) continue;
          const score=phrase.length+(contains(rest,regionName)?100:0)+(country?100:0)+(state?100:0);
          if (!found.has(row)||found.get(row)<score) found.set(row,score);
        }
      }
    }
    const ranked=[...found].sort((a,b)=>b[1]-a[1]||b[0][6]-a[0][6]);
    if (!ranked.length) throw new LocationError('NOT_FOUND','That city was not found. Try a city with its state or country, or a US ZIP code.');
    const [best,score]=ranked[0];
    const alternatives=ranked.slice(1).filter(([row,next])=>next===score && haversineMiles({lat:best[4],lng:best[5]},{lat:row[4],lng:row[5]})>25);
    // A well-known dominant city can be used alone; similarly sized names need a region.
    if (alternatives.length && best[6]<Math.max(1,alternatives[0][0][6])*10) throw new LocationError('AMBIGUOUS','Several places have that name. Include the state or country, or use a US ZIP code.');
    signal?.throwIfAborted();return this.point(best);
  }
}
