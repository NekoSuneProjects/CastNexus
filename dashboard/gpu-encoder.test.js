"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const gpu=require("./gpu-encoder");

test("parses FFmpeg hardware encoder list",()=>{
  const found=gpu.advertisedEncoders(" V..... h264_nvenc NVIDIA NVENC H.264\n V..... h264_qsv H.264 QSV\n V..... libx264 x264");
  assert.equal(found.has("h264_nvenc"),true);
  assert.equal(found.has("h264_qsv"),true);
  assert.equal(found.has("libx264"),true);
});

test("auto detection chooses an advertised encoder only after a successful probe",()=>{
  const old=process.env.CASTNEXUS_VIDEO_ENCODER;
  process.env.CASTNEXUS_VIDEO_ENCODER="auto";
  try{
    const result=gpu.detectEncoder({force:true,advertisedText:" V..... h264_qsv Intel QSV\n V..... libx264 x264",probe:p=>({ok:p.id==="qsv"})});
    assert.equal(result.id,"qsv");
    assert.equal(result.hardware,true);
  }finally{if(old===undefined)delete process.env.CASTNEXUS_VIDEO_ENCODER;else process.env.CASTNEXUS_VIDEO_ENCODER=old;}
});

test("CPU fallback args remain available",()=>{
  const args=gpu.videoEncoderArgs(gpu.CPU_PROFILE,{fps:30,bitrate:"4M",maxrate:"5M",bufsize:"8M"});
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("zerolatency"));
});
