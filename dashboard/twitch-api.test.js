"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createTwitchApi,parseTwitchDuration}=require("./twitch-api");

test("parses Twitch duration strings",()=>{
  assert.equal(parseTwitchDuration("2h3m4s"),7384);
  assert.equal(parseTwitchDuration("17m9s"),1029);
});

test("Helix live check and archive VOD mapping via oauth-broker",async()=>{
  const hostedOauth={
    twitchHelix:async(resource,params,brokerToken)=>{
      assert.equal(brokerToken,"tok");
      if(resource==="streams")return{data:[{id:"s1",user_id:"42",user_login:"neko",user_name:"Neko",game_id:"1",game_name:"Game",title:"Live now",viewer_count:12,started_at:"2026-08-21T16:00:00Z",language:"en",thumbnail_url:"thumb"}]};
      if(resource==="videos")return{data:[{id:"v1",stream_id:"s0",user_id:"42",user_login:"neko",user_name:"Neko",title:"Past stream",description:"",created_at:"2026-08-20T10:00:00Z",published_at:"2026-08-20T10:00:00Z",url:"https://www.twitch.tv/videos/v1",thumbnail_url:"thumb",viewable:"public",view_count:9,language:"en",type:"archive",duration:"1h2m3s"}]};
      throw new Error(`unexpected resource ${resource}`);
    },
  };
  const api=createTwitchApi({hostedOauth});
  const live=await api.isLive({userId:"42",brokerToken:"tok"});
  assert.equal(live.live,true);
  assert.equal(live.stream.title,"Live now");
  const videos=await api.getVideos("42",{brokerToken:"tok"});
  assert.equal(videos.length,1);
  assert.equal(videos[0].durationS,3723);
  assert.equal(videos[0].type,"archive");
});
