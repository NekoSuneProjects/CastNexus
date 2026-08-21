"use strict";

const assert = require("node:assert/strict");
const {
  createCoverArtResolver,
  safeHttpsUrl,
  upgradeItunesArtwork,
  pickItunesResult,
  coverFromCaaPayload,
} = require("./cover-art");

assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
assert.equal(safeHttpsUrl("http://example.com/a.jpg"), null);
assert.equal(upgradeItunesArtwork("https://is1-ssl.mzstatic.com/image/thumb/Music/a.jpg/100x100bb.jpg"), "https://is1-ssl.mzstatic.com/image/thumb/Music/a.jpg/600x600bb.jpg");

const wanted = { title:"Example Song", artist:"Example Artist", album:"Example Album" };
const match = pickItunesResult(wanted, [
  { kind:"song", trackName:"Wrong", artistName:"Else", artworkUrl100:"https://example.com/wrong.jpg" },
  { kind:"song", trackName:"Example Song", artistName:"Example Artist", collectionName:"Example Album", artworkUrl100:"https://example.com/right.jpg" },
]);
assert.equal(match.trackName, "Example Song");

assert.equal(
  coverFromCaaPayload({ images:[{ front:true, thumbnails:{ "500":"https://coverartarchive.org/release/a/front-500.jpg" } }] }),
  "https://coverartarchive.org/release/a/front-500.jpg"
);

let calls = 0;
const resolver = createCoverArtResolver({
  providers:["itunes"],
  fetchImpl: async () => {
    calls++;
    return {
      ok:true,
      async json(){
        return { results:[{
          kind:"song",
          trackName:"Example Song",
          artistName:"Example Artist",
          collectionName:"Example Album",
          artworkUrl100:"https://is1-ssl.mzstatic.com/image/thumb/Music/example/100x100bb.jpg",
          trackViewUrl:"https://music.apple.com/us/song/example/1",
        }] };
      },
    };
  },
});

(async () => {
  const first = await resolver.lookup(wanted);
  const second = await resolver.lookup(wanted);
  assert.equal(first.provider, "itunes");
  assert.match(first.url, /600x600bb/);
  assert.equal(calls, 1, "resolved cover should be cached in memory");
  assert.deepEqual(second, first);
  console.log("cover art fallback tests passed");
})().catch(err => { console.error(err); process.exitCode = 1; });
