"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createTwitchApi,parseTwitchDuration}=require("./twitch-api");

function response(data,status=200){return{ok:status>=200&&status<300,status,json:async()=>data};}

test("parses Twitch duration strings",()=>{
  assert.equal(parseTwitchDuration("2h3m4s"),7384);
  assert.equal(parseTwitchDuration("17m9s"),1029);
});

test("Helix live check and archive VOD mapping",async()=>{
  const fetchImpl=async(url)=>{
    const u=String(url);
    if(u.startsWith("https://id.twitch.tv/oauth2/token"))return response({access_token:"app-token",expires_in:3600});
    if(u.includes("helix/streams"))return response({data:[{id:"s1",user_id:"42",user_login:"neko",user_name:"Neko",game_id:"1",game_name:"Game",title:"Live now",viewer_count:12,started_at:"2026-08-21T16:00:00Z",language:"en",thumbnail_url:"thumb"}]});
    if(u.includes("helix/videos"))return response({data:[{id:"v1",stream_id:"s0",user_id:"42",user_login:"neko",user_name:"Neko",title:"Past stream",description:"",created_at:"2026-08-20T10:00:00Z",published_at:"2026-08-20T10:00:00Z",url:"https://www.twitch.tv/videos/v1",thumbnail_url:"thumb",viewable:"public",view_count:9,language:"en",type:"archive",duration:"1h2m3s"}]});
    throw new Error(`unexpected URL ${u}`);
  };
  const api=createTwitchApi({clientId:"cid",clientSecret:"secret",fetchImpl});
  const live=await api.isLive({userId:"42"});
  assert.equal(live.live,true);
  assert.equal(live.stream.title,"Live now");
  const videos=await api.getVideos("42");
  assert.equal(videos.length,1);
  assert.equal(videos[0].durationS,3723);
  assert.equal(videos[0].type,"archive");
});
