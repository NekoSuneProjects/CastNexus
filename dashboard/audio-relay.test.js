"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {SAMPLE_RATE,BYTES_PER_SEC,PRIME_BYTES,TARGET_SOURCE_BUFFER,MAX_SOURCE_BUFFER,trimPcmQueue,isMainThread}=require("./audio-relay");

test("desktop audio carrier uses the compositor PCM format",()=>{
  assert.equal(SAMPLE_RATE,48000);
  assert.equal(BYTES_PER_SEC,48000*2*2);
});

test("desktop audio relay runs outside Electron's video event loop",()=>{
  assert.equal(isMainThread,true);
  const source=require("node:fs").readFileSync(require.resolve("./audio-relay"),"utf8");
  assert.match(source,/new Worker\(__filename/);
  assert.match(source,/this\.chunks=\[\];\s*this\.chunkBytes=0;\s*this\.primed=false/);
});

test("desktop audio queue stays low latency and discards stale PCM",()=>{
  assert.ok(PRIME_BYTES<=BYTES_PER_SEC*.075);
  assert.ok(TARGET_SOURCE_BUFFER<=BYTES_PER_SEC*.10);
  assert.ok(MAX_SOURCE_BUFFER<=BYTES_PER_SEC*.25);
  const chunks=[Buffer.alloc(BYTES_PER_SEC*.2),Buffer.alloc(BYTES_PER_SEC*.2)];
  const bytes=trimPcmQueue(chunks,BYTES_PER_SEC*.4,TARGET_SOURCE_BUFFER);
  assert.equal(bytes,TARGET_SOURCE_BUFFER);
  assert.equal(chunks.reduce((sum,chunk)=>sum+chunk.length,0),TARGET_SOURCE_BUFFER);
});
