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

test("the relay listens before FFmpeg taps connect, on Docker as well as Desktop",async()=>{
  const net=require("node:net");
  const {PcmAudioRelay}=require("./audio-relay");
  const relay=new PcmAudioRelay({inputPort:39412,outputPort:39413,logger:{warn(){}}});
  try{
    assert.equal(await relay.start(),true,"start() resolves once both loopback listeners are up");
    const writer=await new Promise((resolve,reject)=>{const s=net.connect(39412,"127.0.0.1",()=>resolve(s));s.on("error",reject);});
    const consumer=await new Promise((resolve,reject)=>{const s=net.connect(39413,"127.0.0.1",()=>resolve(s));s.on("error",reject);});
    // A quarter second of silence in, paced audio out at 48k/stereo/16-bit.
    writer.write(Buffer.alloc(BYTES_PER_SEC/4));
    const received=await new Promise(resolve=>{
      let total=0;
      consumer.on("data",chunk=>{total+=chunk.length;});
      setTimeout(()=>resolve(total),400);
    });
    // Paced, not dumped: roughly realtime, never the whole queue at once.
    assert.ok(received>BYTES_PER_SEC*0.15,`expected roughly realtime output, got ${received} bytes`);
    assert.ok(received<BYTES_PER_SEC*0.75,`expected paced output, got ${received} bytes`);
    writer.destroy();
    consumer.destroy();
  }finally{
    relay.stop();
  }
});
