"use strict";
// DCC cross-device login and room coordinator. Redis credentials exist ONLY in the server environment.
const http = require("node:http");
const crypto = require("node:crypto");
const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL;
const PORT = Number(process.env.PORT || 18080);
const ORIGIN = process.env.FRONTEND_ORIGIN || "https://diddyx6969.github.io";
const PREFIX = "dcc:v10:";
const TTL = 60 * 60 * 24 * 30;
const LIMIT = 20;
if (!REDIS_URL) throw new Error("REDIS_URL must be configured privately on the backend");

const db = createClient({ url: REDIS_URL, socket: { reconnectStrategy: retries => Math.min(1000 + retries * 250, 10000) } });
db.on("error", e => console.error("Redis connection error:", e.code || e.name));

const roomKey = id => PREFIX + "room:" + id;
const stateKey = id => PREFIX + "state:" + id;
const verKey = id => PREFIX + "version:" + id;
const joinKey = code => PREFIX + "join:" + code;
const membersKey = id => PREFIX + "members:" + id;
const commandsKey = id => PREFIX + "commands:" + id;
const sessionKey = token => PREFIX + "session:" + sha(token);
const sha = str => crypto.createHash("sha256").update(String(str)).digest("hex");
const code = len => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let v;
  do { v = Array.from({length:len},()=>alphabet[crypto.randomInt(alphabet.length)]).join(""); }
  while (!/[A-Z]/.test(v) || !/[0-9]/.test(v));
  return v;
};
const locks = new Map();
async function inRoom(id, fn) {
  const previous = locks.get(id) || Promise.resolve();
  let release;
  const signal = new Promise(resolve => release = resolve);
  const chain = previous.then(() => signal);
  locks.set(id, chain);
  await previous;
  try { return await fn(); } finally { release(); if (locks.get(id) === chain) locks.delete(id); }
}
class APIError extends Error {
  constructor(status, message, extra={}) { super(message); this.status=status; this.extra=extra; }
}
function error(status,message,extra) { throw new APIError(status,message,extra); }
function clean(text,n=80) { return String(text||"").trim().slice(0,n); }
function validateRoomId(value) { return /^DCC-[A-Z0-9]{6}$/.test(String(value||"")); }
function cors(req,res) {
  const origin=req.headers.origin;
  if(origin && origin!==ORIGIN && origin!=="http://localhost:5173" && origin!=="http://127.0.0.1:5173") {
    error(403,"Origin not allowed");
  }
  res.setHeader("Access-Control-Allow-Origin",origin||ORIGIN);
  res.setHeader("Vary","Origin");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type,Authorization");
  res.setHeader("Cache-Control","no-store");
}
async function body(req) {
  let input="";for await(const chunk of req) {
    input+=chunk;
    if(input.length>2_500_000)error(413,"Request is too large");
  }
  try{return input?JSON.parse(input):{}}catch{error(400,"Invalid JSON request")}
}
function send(res,status,value) {
  res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});
  res.end(JSON.stringify(value));
}
async function roomData(id) {
  const room=await db.hGetAll(roomKey(id));
  if(!room?.roomId || room.status!=="open")error(404,"Room does not exist or was deleted");
  return room;
}
async function getState(id) {
  const data=await db.get(stateKey(id));
  if(!data)error(503,"Room data is not yet initialized");
  return JSON.parse(data);
}
async function members(id) {
  const entries=await db.hGetAll(membersKey(id));
  return Object.values(entries).map(v=>JSON.parse(v));
}
async function version(id) {return Number((await db.get(verKey(id)))||1);}
async function session(req) {
  const header=req.headers.authorization||"";
  const token=header.startsWith("Bearer ")?header.slice(7):"";
  if(!token || !/^[a-zA-Z0-9_-]{20,120}$/.test(token))error(401,"Please log in again");
  const json=await db.get(sessionKey(token));
  if(!json)error(401,"Login session expired");
  const value=JSON.parse(json);
  await roomData(value.roomId);
  return value;
}
async function issueSession(roomId,role,deviceId=null) {
  const token=crypto.randomBytes(36).toString("base64url");
  await db.set(sessionKey(token),JSON.stringify({roomId,role,deviceId,createdAt:Date.now()}),{EX:TTL});
  return token;
}
function visibleState(state,role,memberList) {
  const s=JSON.parse(JSON.stringify(state));
  delete s.__server;
  if(s.room) {
    delete s.room.hostKey;delete s.room.playerCode;delete s.room.passHash;
    delete s.room.creatorSecret;delete s.room.hostPass;
  }
  s.franchises=(s.franchises||[]).map(({memberToken,userId,passHash,...f})=>f);
  if(role==="host"||role==="admin") {
    s.members=memberList.map(({deviceId,...m})=>m);
  }else{
    delete s.members;
  }
  return s;
}
async function payloadFor(roomId,role,deviceId=null) {
  const [state,memberList,v]=await Promise.all([getState(roomId),members(roomId),version(roomId)]);
  const member=memberList.find(x=>x.deviceId===deviceId);
  return {roomId,role,version:v,ownerId:member?.ownerId||null,needsFranchise:!member?.ownerId,state:visibleState(state,role,memberList),joinedCount:memberList.length};
}
async function createRoom(input) {
  const purse=Number(input.startPurse);
  if(!Number.isFinite(purse)||purse<=0||purse>1_000_000)error(400,"Enter a valid team purse");
  const starter=input.state;
  if(!starter||!Array.isArray(starter.players)||!Array.isArray(starter.franchises))error(400,"Room setup data is missing");
  for(let i=0;i<100;i++){
    const id="DCC-"+code(6), hostKey=code(6), playerCode=code(10);
    const creatorSecret=crypto.randomBytes(32).toString("base64url");
    const now=Date.now();
    const state={...starter,room:{code:id,hostName:"Creator",startPurse:Math.round(purse*100),createdAt:now},franchises:[],members:[],updatedAt:now};
    const reserved=await db.eval(
      "if redis.call('EXISTS',KEYS[1])==1 or redis.call('EXISTS',KEYS[2])==1 then return 0 end "+
      "redis.call('HSET',KEYS[1],'roomId',ARGV[1],'hostHash',ARGV[2],'creatorHash',ARGV[3],"+
      "'playerCode',ARGV[4],'status','open','createdAt',ARGV[5]) "+
      "redis.call('SET',KEYS[2],ARGV[1]) redis.call('SET',KEYS[3],ARGV[6]) redis.call('SET',KEYS[4],'1') return 1",
      {keys:[roomKey(id),joinKey(playerCode),stateKey(id),verKey(id)],arguments:[id,sha("host|"+id+"|"+hostKey),sha("creator|"+creatorSecret),playerCode,String(now),JSON.stringify(state)]}
    );
    if(Number(reserved)!==1)continue;
    const token=await issueSession(id,"host");
    return {roomId:id,hostKey,playerCode,creatorSecret,sessionToken:token,...(await payloadFor(id,"host"))};
  }
  error(503,"Could not reserve unique room codes");
}
async function hostLogin(input) {
  const id=clean(input.roomId,20).toUpperCase(),key=clean(input.hostKey,20).toUpperCase();
  if(!validateRoomId(id)||!/^[A-Z0-9]{6}$/.test(key))error(401,"Invalid Room ID or Host Key");
  const room=await roomData(id);
  if(sha("host|"+id+"|"+key)!==room.hostHash)error(401,"Invalid Room ID or Host Key");
  const creator=typeof input.creatorSecret==="string" && sha("creator|"+input.creatorSecret)===room.creatorHash;
  const role=creator?"host":"admin";
  const sessionToken=await issueSession(id,role);
  return {sessionToken,...(await payloadFor(id,role))};
}
async function playerLogin(input){
  const joinCode=clean(input.playerCode,30).toUpperCase();
  const deviceId=clean(input.deviceId,100);
  if(!/^[A-Z0-9]{10}$/.test(joinCode)||!crypto.randomUUID || !/^[0-9a-f-]{36}$/i.test(deviceId))error(400,"Enter a valid Player Code");
  const id=await db.get(joinKey(joinCode));
  if(!id)error(401,"Invalid Player Joining Code");
  const room=await roomData(id);
  if(room.playerCode!==joinCode)error(401,"Invalid Player Joining Code");
  return inRoom(id,async()=>{
    let memberRaw=await db.hGet(membersKey(id),deviceId);
    if(!memberRaw) {
      const count=await db.hLen(membersKey(id));
      if(count>=LIMIT)error(409,"This room is full (20 players)");
      const record={deviceId,owner:"Pending setup",team:"Not assigned",ownerId:null,joinedAt:Date.now(),lastSeen:Date.now()};
      await db.hSet(membersKey(id),deviceId,JSON.stringify(record));
    }else {
      const record=JSON.parse(memberRaw);record.lastSeen=Date.now();
      await db.hSet(membersKey(id),deviceId,JSON.stringify(record));
    }
    const sessionToken=await issueSession(id,"player",deviceId);
    return {sessionToken,...(await payloadFor(id,"player",deviceId))};
  });
}
async function register(input,auth){
  if(auth.role!=="player"||!auth.deviceId)error(403,"Player login required");
  const owner=clean(input.owner),team=clean(input.team),id=auth.roomId;
  if(!owner||!team)error(400,"Owner and team name are required");
  return inRoom(id,async()=>{
    const json=await db.hGet(membersKey(id),auth.deviceId);
    if(!json)error(403,"Player is not registered in this room");
    const member=JSON.parse(json);
    const state=await getState(id);
    let franchise=state.franchises.find(f=>f.memberToken===auth.deviceId);
    if(state.franchises.some(f=>f.team.toLowerCase()===team.toLowerCase()&&f.id!==franchise?.id))error(409,"That franchise name is already taken");
    if(!franchise){
      if(state.franchises.length>=LIMIT)error(409,"This room already has 20 teams");
      franchise={id:crypto.randomUUID(),owner,team,purse:state.room.startPurse,memberToken:auth.deviceId,joinedAt:Date.now(),online:true};
      state.franchises.push(franchise);
    }else{franchise.owner=owner;franchise.team=team;}
    Object.assign(member,{owner,team,ownerId:franchise.id,lastSeen:Date.now()});
    await db.hSet(membersKey(id),auth.deviceId,JSON.stringify(member));
    await db.set(stateKey(id),JSON.stringify(state));
    await db.incr(verKey(id));
    return payloadFor(id,"player",auth.deviceId);
  });
}
async function stateSave(input,auth) {
  if(!["host","admin"].includes(auth.role))error(403,"Host privileges required");
  const id=auth.roomId, incoming=input.state;
  if(!incoming||incoming.room?.code!==id||!Array.isArray(incoming.players)||!Array.isArray(incoming.franchises)||incoming.franchises.length>LIMIT)error(400,"Invalid room state");
  return inRoom(id,async()=>{
    const v=await version(id);
    if(Number(input.version)!==v) {
      throw new APIError(409,"Room data changed: refresh before editing",{...(await payloadFor(id,auth.role))});
    }
    const current=await getState(id);
    // Preserve memberships registered on the server even if the host missed a concurrent join.
    const existingPlayerFranchises=current.franchises.filter(f=>f.memberToken);
    const mapped=new Map(incoming.franchises.map(f=>[f.id,f]));
    for(const f of existingPlayerFranchises) {
      if(!mapped.has(f.id))incoming.franchises.push(f);
      else mapped.set(f.id,{...mapped.get(f.id),memberToken:f.memberToken});
    }
    for(const [i,f] of incoming.franchises.entries()) {
      const member=existingPlayerFranchises.find(x=>x.id===f.id);
      if(member)incoming.franchises[i].memberToken=member.memberToken;
      else delete incoming.franchises[i].memberToken;
    }
    if(incoming.franchises.length>LIMIT)error(409,"Maximum 20 teams in this room");
    incoming.room=current.room;
    delete incoming.members; // room members live in a separate Redis hash
    incoming.updatedAt=Date.now();
    await db.set(stateKey(id),JSON.stringify(incoming));
    const newVersion=await db.incr(verKey(id));
    return {ok:true,version:Number(newVersion)};
  });
}
async function bid(auth){
  if(auth.role!=="player")error(403,"Player login required");
  const id=auth.roomId;
  const member=await db.hGet(membersKey(id),auth.deviceId);
  if(!member)error(403,"You have not joined this room");
  const player=JSON.parse(member);
  if(!player.ownerId)error(403,"Create a franchise first");
  const throttle=await db.set(PREFIX+"bid-throttle:"+id+":"+auth.deviceId,"1",{NX:true,EX:1});
  if(!throttle)error(429,"Please wait before bidding again");
  await db.rPush(commandsKey(id),JSON.stringify({type:"bid",ownerId:player.ownerId,at:Date.now()}));
  return {ok:true};
}
async function getCommands(auth) {
  if(!["host","admin"].includes(auth.role))error(403,"Host login required");
  const id=auth.roomId;
  return inRoom(id,async()=>{
    const items=await db.lRange(commandsKey(id),0,99);
    if(items.length)await db.lTrim(commandsKey(id),items.length,-1);
    return {commands:items.map(x=>JSON.parse(x))};
  });
}
async function deleteRoom(auth,input){
  if(auth.role!=="host")error(403,"Only the original creator can delete a room");
  const id=auth.roomId,room=await roomData(id);
  if(sha("host|"+id+"|"+clean(input.hostKey,20).toUpperCase())!==room.hostHash)error(403,"Incorrect Host Key");
  return inRoom(id,async()=>{
    await db.multi()
      .del(roomKey(id))
      .del(joinKey(room.playerCode))
      .del(stateKey(id))
      .del(verKey(id))
      .del(membersKey(id))
      .del(commandsKey(id))
      .exec();
    return {ok:true};
  });
}
async function rotateCode(auth){
  if(auth.role!=="host")error(403,"Only the creator can rotate the Player Code");
  const id=auth.roomId;
  return inRoom(id,async()=>{
    const room=await roomData(id);
    for(let i=0;i<60;i++){
      const newCode=code(10);
      const result=await db.eval(
        "if redis.call('EXISTS',KEYS[2])==1 then return 0 end "+
        "redis.call('SET',KEYS[2],ARGV[1]) redis.call('DEL',KEYS[3]) redis.call('HSET',KEYS[1],'playerCode',ARGV[1]) return 1",
        {keys:[roomKey(id),joinKey(newCode),joinKey(room.playerCode)],arguments:[newCode]}
      );
      if(Number(result)===1)return {playerCode:newCode};
    }
    error(503,"Could not rotate Player Joining Code");
  });
}
async function route(req,res){
  cors(req,res);
  if(req.method==="OPTIONS")return send(res,200,{ok:true});
  const url=new URL(req.url,"http://localhost");
  if(req.method==="GET"&&url.pathname==="/health"){
    const pong=await db.ping();return send(res,200,{ok:pong==="PONG",storage:"redis"});
  }
  const input=["POST","DELETE"].includes(req.method)?await body(req):{};
  if(req.method==="POST"&&url.pathname==="/api/rooms/create")return send(res,200,await createRoom(input));
  if(req.method==="POST"&&url.pathname==="/api/rooms/login/host")return send(res,200,await hostLogin(input));
  if(req.method==="POST"&&url.pathname==="/api/rooms/login/player")return send(res,200,await playerLogin(input));
  const auth=await session(req);
  if(req.method==="GET"&&url.pathname==="/api/room/state")return send(res,200,await payloadFor(auth.roomId,auth.role,auth.deviceId));
  if(req.method==="POST"&&url.pathname==="/api/room/state")return send(res,200,await stateSave(input,auth));
  if(req.method==="POST"&&url.pathname==="/api/room/register")return send(res,200,await register(input,auth));
  if(req.method==="POST"&&url.pathname==="/api/room/bid")return send(res,200,await bid(auth));
  if(req.method==="GET"&&url.pathname==="/api/room/commands")return send(res,200,await getCommands(auth));
  if(req.method==="POST"&&url.pathname==="/api/room/rotate")return send(res,200,await rotateCode(auth));
  if(req.method==="DELETE"&&url.pathname==="/api/room")return send(res,200,await deleteRoom(auth,input));
  error(404,"Unknown DCC endpoint");
}
async function start(){
  await db.connect();
  const pong=await db.ping();
  if(pong!=="PONG")throw new Error("Redis health check failed");
  const server=http.createServer((req,res)=>{
    route(req,res).catch(e=>{
      const status=e.status||500;
      if(status===500)console.error("API error:",e.stack||e);
      if(!res.headersSent)send(res,status,{error:status===500?"Server error":e.message,...(e.extra||{})});
      else res.destroy();
    });
  });
  server.listen(PORT,"127.0.0.1",()=>console.log("DCC API ready on localhost:"+PORT));
}
start().catch(e=>{console.error("Startup failed:",e.message);process.exit(1)});
