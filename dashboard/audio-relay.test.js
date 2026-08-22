"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {SAMPLE_RATE,BYTES_PER_SEC}=require("./audio-relay");

test("desktop audio carrier uses the compositor PCM format",()=>{
  assert.equal(SAMPLE_RATE,48000);
  assert.equal(BYTES_PER_SEC,48000*2*2);
});
