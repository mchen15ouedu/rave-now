import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSearchQuery,matchingArtistNames,artistMatches,looksLikeLocation} from '../src/artist-search.mjs';

test('artist names match accent, case and Unicode width variants and partial collaborators',()=>{
 assert.deepEqual(matchingArtistNames('TIESTO',['Tiësto','Ｔｉｅｓｔｏ','Steve Angello']),['Tiësto']);
 assert.deepEqual(matchingArtistNames('john',['John Summit','John Digweed','Other DJ']),['John Summit','John Digweed']);
 assert.equal(artistMatches('Eric Prydz (w/ Cristoph)','cristoph'),true);
 assert.equal(artistMatches('Steve Angello','  angello  '),true);
 assert.equal(artistMatches('Steve Angello',''),false);
 assert.equal(artistMatches('Tiësto','Other artist'),false);
});

test('one query supports optional explicit artist/location prefixes and rejects bad input',()=>{
 assert.deepEqual(parseSearchQuery('  Dallas,  TX '),{query:'Dallas, TX',kind:'auto'});
 assert.deepEqual(parseSearchQuery('ArTiSt:   New DJ'),{query:'New DJ',kind:'artist'});
 assert.deepEqual(parseSearchQuery('location: Paris, France'),{query:'Paris, France',kind:'location'});
 for (const value of ['',null,'artist:','x'.repeat(161),'DJ\nInjected']) assert.throws(()=>parseSearchQuery(value));
});

test('obvious location inputs cannot be silently registered as new artists',()=>{
 for (const value of ['Dallas, TX','75001','123 Main Street','Los Angeles CA','Paris, France']) assert.equal(looksLikeLocation(value),true,value);
 for (const value of ['New DJ','3LAU','RÜFÜS DU SOL']) {
  assert.equal(looksLikeLocation(value),false,value);
 }
});
