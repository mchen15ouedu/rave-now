import { cleanArtistName } from './artist-catalog.mjs';

export class SearchInputError extends Error {}

export function artistKey(value) {
  return typeof value==='string'?value.normalize('NFKD').replace(/\p{M}/gu,'').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US'):'';
}

export function parseSearchQuery(value) {
  if (typeof value !== 'string' || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) throw new SearchInputError('Enter a city, ZIP code or artist name.');
  let query=value.normalize('NFKC').trim().replace(/\s+/gu,' '),kind='auto';
  const prefix=query.match(/^(artist|location):\s*/i);
  if (prefix) {kind=prefix[1].toLowerCase();query=query.slice(prefix[0].length).trim();}
  if (!query) throw new SearchInputError('Enter a city, ZIP code or artist name.');
  if (kind==='artist') {
    try {query=cleanArtistName(query);} catch {throw new SearchInputError('Enter an artist name of up to 120 characters.');}
  }
  return {query,kind};
}

export function matchingArtistNames(query,names) {
  const key=artistKey(query);
  if (!key) return [];
  const unique=new Map();
  for (const name of names) {
    if (typeof name!=='string') continue;
    const nameKey=artistKey(name);
    if (nameKey && nameKey.includes(key) && !unique.has(nameKey)) unique.set(nameKey,name);
  }
  return [...unique.values()];
}

export function artistMatches(name,query) {
  const key=artistKey(query);
  return Boolean(key && typeof name==='string' && artistKey(name).includes(key));
}

export function looksLikeLocation(query) {
  return /,|^\d+(?:\s|$)|\b(?:street|avenue|road|boulevard|drive|highway|lane|zipcode|zip code)\b/i.test(query)
    || /\s(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$/i.test(query);
}
