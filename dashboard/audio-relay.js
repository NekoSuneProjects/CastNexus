"use strict";

const net = require("node:net");
const {Worker,isMainThread,parentPort,workerData}=require("node:worker_threads");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;
const BYTES_PER_SEC = SAMPLE_RATE * FRAME_BYTES;
const TICK_MS = 25;
const MAX_SOURCE_BUFFER = Math.round(BYTES_PER_SEC * 0.25);
const TARGET_SOURCE_BUFFER = Math.round(BYTES_PER_SEC * 0.10);
const PRIME_BYTES = Math.round(BYTES_PER_SEC * 0.075);
const MAX_CONSUMER_BACKLOG = BYTES_PER_SEC;

function trimPcmQueue(chunks,chunkBytes,maxBytes){
  let excess=Math.max(0,chunkBytes-maxBytes);
  excess-=excess%FRAME_BYTES;
  while(excess>0&&chunks.length){
    const head=chunks[0],take=Math.min(head.length,excess);
    if(take===head.length)chunks.shift();
    else chunks[0]=head.subarray(take);
    chunkBytes-=take;
    excess-=take;
  }
  return chunkBytes;
}

// Port of the proven NekoStreamAPP desktop audio carrier. FFmpeg uses audio
// as a timing master, so a stalled producer must become silence rather than
// a gap; otherwise video delivery also stalls even while capture stays fluid.
class PcmAudioRelay {
  constructor({ inputPort, outputPort, logger }) {
    this.inputPort=inputPort;
    this.outputPort=outputPort;
    this.logger=logger||console;
    this.writer=null;
    this.consumer=null;
    this.chunks=[];
    this.chunkBytes=0;
    this.primed=false;
    this.clockStart=0;
    this.bytesSent=0;
    this.pacer=null;
    this.inputServer=null;
    this.outputServer=null;
    this.worker=null;
    this.readyPromise=null;
    this._resolveReady=null;
  }

  // Resolves once both loopback listeners accept connections. FFmpeg taps that
  // connect before that just exit and get respawned, which is survivable but
  // noisy - and on Docker it delayed first audio by seconds.
  ready(){return this.readyPromise||Promise.resolve(!isMainThread);}

  start(){
    if(isMainThread){
      if(this.worker)return this.readyPromise;
      this.readyPromise=new Promise(resolve=>{this._resolveReady=resolve;});
      const settle=value=>{const resolve=this._resolveReady;this._resolveReady=null;resolve?.(value);};
      this.worker=new Worker(__filename,{workerData:{castNexusPcmRelay:true,inputPort:this.inputPort,outputPort:this.outputPort}});
      this.worker.on("message",message=>{if(message?.ready)settle(true);});
      this.worker.on("error",error=>{this.logger.warn?.(`[audio-relay:${this.inputPort}] worker error: ${error.message}`);settle(false);});
      this.worker.on("exit",()=>settle(false));
      return this.readyPromise;
    }
    if(this.pacer)return;
    this.inputServer=net.createServer(socket=>{
      if(this.writer){try{this.writer.destroy();}catch{}}
      this.writer=socket;
      // A new writer means a new song (or a restarted decoder). Never let
      // pending samples from the previous connection play into the new track.
      this.chunks=[];
      this.chunkBytes=0;
      this.primed=false;
      socket.on("data",chunk=>{
        if(socket!==this.writer)return;
        this.chunks.push(chunk);
        this.chunkBytes+=chunk.length;
        if(this.chunkBytes>MAX_SOURCE_BUFFER)this.chunkBytes=trimPcmQueue(this.chunks,this.chunkBytes,MAX_SOURCE_BUFFER);
      });
      const clear=()=>{if(this.writer===socket)this.writer=null;};
      socket.on("close",clear);
      socket.on("error",clear);
    });
    let pendingListeners=2;
    const announceReady=()=>{if(--pendingListeners===0)parentPort?.postMessage({ready:true});};
    this.inputServer.on("error",error=>this.logger.warn?.(`[audio-relay:${this.inputPort}] input error: ${error.message}`));
    this.inputServer.listen(this.inputPort,"127.0.0.1",announceReady);

    this.outputServer=net.createServer(socket=>{
      if(this.consumer){try{this.consumer.destroy();}catch{}}
      this.consumer=socket;
      this.clockStart=Date.now();
      this.bytesSent=0;
      this.primed=false;
      socket.on("error",()=>{});
      socket.on("close",()=>{if(this.consumer===socket)this.consumer=null;});
    });
    this.outputServer.on("error",error=>this.logger.warn?.(`[audio-relay:${this.outputPort}] output error: ${error.message}`));
    this.outputServer.listen(this.outputPort,"127.0.0.1",announceReady);
    this.pacer=setInterval(()=>this._tick(),TICK_MS);
  }

  _tick(){
    const consumer=this.consumer;
    if(!consumer?.writable)return;
    let need=Math.floor(BYTES_PER_SEC*(Date.now()-this.clockStart)/1000)-this.bytesSent;
    need-=need%FRAME_BYTES;
    if(need<=0)return;
    if((consumer.writableLength||0)>MAX_CONSUMER_BACKLOG){this.bytesSent+=need;return;}
    if(!this.primed&&this.chunkBytes>=PRIME_BYTES)this.primed=true;
    if(this.primed&&this.chunkBytes>TARGET_SOURCE_BUFFER+need){
      this.chunkBytes=trimPcmQueue(this.chunks,this.chunkBytes,TARGET_SOURCE_BUFFER+need);
    }
    const output=Buffer.allocUnsafe(need);
    let filled=0;
    if(this.primed){
      while(filled<need&&this.chunks.length){
        const head=this.chunks[0],take=Math.min(head.length,need-filled);
        head.copy(output,filled,0,take);
        filled+=take;
        if(take===head.length){this.chunks.shift();this.chunkBytes-=head.length;}
        else{this.chunks[0]=head.subarray(take);this.chunkBytes-=take;}
      }
      if(this.chunkBytes===0)this.primed=false;
    }
    if(filled<need)output.fill(0,filled);
    consumer.write(output);
    this.bytesSent+=need;
  }

  stop(){
    if(this.worker){
      const worker=this.worker;
      this.worker=null;
      this.readyPromise=null;
      this._resolveReady?.(false);
      this._resolveReady=null;
      worker.postMessage("stop");
      worker.terminate().catch(()=>{});
      return;
    }
    if(this.pacer){clearInterval(this.pacer);this.pacer=null;}
    for(const socket of [this.writer,this.consumer]){try{socket?.destroy();}catch{}}
    this.writer=this.consumer=null;
    this.chunks=[];
    this.chunkBytes=0;
    try{this.inputServer?.close();}catch{}
    try{this.outputServer?.close();}catch{}
    this.inputServer=this.outputServer=null;
  }
}

if(!isMainThread&&workerData?.castNexusPcmRelay){
  const relay=new PcmAudioRelay({inputPort:workerData.inputPort,outputPort:workerData.outputPort});
  relay.start();
  parentPort.on("message",message=>{if(message==="stop"){relay.stop();process.exit(0);}});
}

module.exports={PcmAudioRelay,SAMPLE_RATE,BYTES_PER_SEC,PRIME_BYTES,TARGET_SOURCE_BUFFER,MAX_SOURCE_BUFFER,trimPcmQueue,isMainThread};
