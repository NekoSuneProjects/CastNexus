"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto"),session=require("express-session");
class EncryptedFileSessionStore extends session.Store{
  constructor({dir,secret}){super();this.dir=dir;this.key=crypto.createHash("sha256").update(String(secret)).digest();fs.mkdirSync(dir,{recursive:true});try{fs.chmodSync(dir,0o700);}catch{}}
  _path(sid){return path.join(this.dir,`${crypto.createHash("sha256").update(String(sid)).digest("hex")}.session`);}
  _encode(value){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",this.key,iv),body=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString("base64url");}
  _decode(value){const data=Buffer.from(String(value),"base64url");if(data.length<29)throw new Error("invalid session data");const decipher=crypto.createDecipheriv("aes-256-gcm",this.key,data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString("utf8"));}
  get(sid,callback){try{const file=this._path(sid);if(!fs.existsSync(file))return callback(null,null);const value=this._decode(fs.readFileSync(file,"utf8")),expires=value?.cookie?.expires?new Date(value.cookie.expires).getTime():null;if(expires&&expires<=Date.now()){fs.rmSync(file,{force:true});return callback(null,null);}callback(null,value);}catch(err){try{fs.rmSync(this._path(sid),{force:true});}catch{}callback(err);}}
  set(sid,value,callback=()=>{}){try{const file=this._path(sid),tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,this._encode(value),{encoding:"utf8",mode:0o600});fs.renameSync(tmp,file);callback(null);}catch(err){callback(err);}}
  destroy(sid,callback=()=>{}){try{fs.rmSync(this._path(sid),{force:true});callback(null);}catch(err){callback(err);}}
  touch(sid,value,callback=()=>{}){this.set(sid,value,callback);}
}
function brokerTokenExpiresAt(token){try{const parts=String(token||"").split(".");if(parts.length!==3)return null;const payload=JSON.parse(Buffer.from(parts[1],"base64url").toString("utf8"));return Number.isFinite(Number(payload.exp))?Number(payload.exp)*1000:null;}catch{return null;}}
function accountSessionIsValid(account,now=Date.now()){if(!account)return false;if(!account.oauthBrokerToken)return true;const expiresAt=brokerTokenExpiresAt(account.oauthBrokerToken);return expiresAt!==null&&expiresAt>now;}
module.exports={EncryptedFileSessionStore,brokerTokenExpiresAt,accountSessionIsValid};
