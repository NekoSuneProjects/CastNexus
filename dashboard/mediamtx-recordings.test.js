"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const {safeRecordingPath,dirSizeSync}=require("./mediamtx-recordings");

test("recording paths are stable and safe",()=>{
  assert.equal(safeRecordingPath({twitchLogin:"Neko_Sune"}),"public/Neko_Sune");
  assert.equal(safeRecordingPath({twitchLogin:"bad/name"}),"public/bad-name");
});

test("recording storage totals nested files",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cn-rec-test-"));
  try{
    fs.mkdirSync(path.join(root,"public","neko"),{recursive:true});
    fs.writeFileSync(path.join(root,"a.mp4"),Buffer.alloc(100));
    fs.writeFileSync(path.join(root,"public","neko","b.mp4"),Buffer.alloc(250));
    assert.equal(dirSizeSync(root),350);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
