"use strict";

const net = require("node:net");

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE;
const BYTES_PER_SEC = SAMPLE_RATE * FRAME_BYTES;
const TICK_MS = 25;
const MAX_SOURCE_BUFFER = BYTES_PER_SEC * 2;
const PRIME_BYTES = Math.round(BYTES_PER_SEC * 0.25);
const MAX_CONSUMER_BACKLOG = BYTES_PER_SEC;

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
  }

  start(){
    if(this.pacer)return;
    this.inputServer=net.createServer(socket=>{
      if(this.writer){try{this.writer.destroy();}catch{}}
      this.writer=socket;
      socket.on("data",chunk=>{
        if(socket!==this.writer)return;
        this.chunks.push(chunk);
        this.chunkBytes+=chunk.length;
        while(this.chunkBytes>MAX_SOURCE_BUFFER&&this.chunks.length>1){
          const old=this.chunks.shift();
          this.chunkBytes-=old.length;
        }
      });
      const clear=()=>{if(this.writer===socket)this.writer=null;};
      socket.on("close",clear);
      socket.on("error",clear);
    });
    this.inputServer.on("error",error=>this.logger.warn?.(`[audio-relay:${this.inputPort}] input error: ${error.message}`));
    this.inputServer.listen(this.inputPort,"127.0.0.1");

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
    this.outputServer.listen(this.outputPort,"127.0.0.1");
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

module.exports={PcmAudioRelay,SAMPLE_RATE,BYTES_PER_SEC};
