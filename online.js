"use strict";
// DCC online edition: GitHub Pages frontend + HTTPS room API + Redis server-side authority.
// No database passwords or server credentials are included in this file.
const DCC_API = "https://electricity-kissing-owner-skirts.trycloudflare.com";
const ONLINE_SESSION_KEY = "dcc-online-session-v1";
const ONLINE_DEVICE_PREFIX = "dcc-online-device-v1:";
const ONLINE_POLL_INTERVAL = 1600;
let onlineToken=null, onlineRoomId=null, onlineVersion=0, onlineTimer=null;
let onlineSaving=false, onlinePolling=false, onlineSaveChain=Promise.resolve(), onlineCreatorSecret=null;

async function onlineRequest(path, data, method) {
  const options={method:method||(data===undefined?"GET":"POST"),mode:"cors",cache:"no-store",headers:{"Accept":"application/json"}};
  if(onlineToken)options.headers.Authorization="Bearer "+onlineToken;
  if(data!==undefined){options.headers["Content-Type"]="application/json";options.body=JSON.stringify(data)}
  const abort=new AbortController();
  const timeout=setTimeout(()=>abort.abort(),15000);
  options.signal=abort.signal;
  try{
    const res=await fetch(DCC_API+path,options);
    let value;
    try{value=await res.json()}catch{value={error:"Room service did not return valid data"}}
    if(!res.ok){const e=new Error(value.error||"Room service is unavailable");e.status=res.status;e.data=value;throw e}
    return value;
  }finally{clearTimeout(timeout)}
}
function onlineError(e){
  const message=e?.name==="AbortError"?"Room server timed out. Try again.":e?.message||"Could not connect to the room server";
  console.error("DCC online:",message);
  setNet("SERVER UNAVAILABLE");
  return message;
}
function onlineDevice(code){
  const k=ONLINE_DEVICE_PREFIX+code;
  let v=localStorage.getItem(k);
  if(!v){v=crypto.randomUUID();localStorage.setItem(k,v)}
  return v;
}
function onlineSaveSession(){
  if(onlineToken&&onlineRoomId){
    sessionStorage.setItem(ONLINE_SESSION_KEY,JSON.stringify({token:onlineToken,roomId:onlineRoomId,role:me.role,playerCode:activePlayerCode,creatorSecret:onlineCreatorSecret}));
  }
}
function onlineSetSession(data,role,credentials={}){
  onlineToken=data.sessionToken;
  onlineRoomId=data.roomId;
  onlineVersion=Number(data.version||1);
  if(credentials.hostKey!==undefined)activeHostKey=credentials.hostKey;
  if(credentials.playerCode!==undefined)activePlayerCode=credentials.playerCode;
  if(credentials.creatorSecret!==undefined)onlineCreatorSecret=credentials.creatorSecret;
  setMe({role,roomCode:data.roomId,ownerId:role==="owner"?data.ownerId:role==="host"?"host":role==="admin"?"admin":null});
  onlineSaveSession();
  state=migrateState(data.state);
}
function onlineStop(){if(onlineTimer){clearInterval(onlineTimer);onlineTimer=null}}
function onlineRun(){
  onlineStop();
  onlineTimer=setInterval(()=>onlineTick().catch(e=>console.warn("DCC sync",e)),ONLINE_POLL_INTERVAL);
  onlineTick().catch(e=>console.warn("DCC first sync",e));
}
async function onlineTick(){
  if(!onlineToken||onlinePolling||onlineSaving||!onlineRoomId)return;
  onlinePolling=true;
  try{
    const data=await onlineRequest("/api/room/state");
    if(data.roomId!==onlineRoomId)return;
    const host=me.role==="host"||me.role==="admin";
    if(Number(data.version)>onlineVersion){
      onlineVersion=Number(data.version);
      state=migrateState(data.state);
      if(me.role==="member"&&data.ownerId){
        setMe({role:"owner",ownerId:data.ownerId,roomCode:onlineRoomId});
        onlineSaveSession();
      }
      render();
    }else if(host){
      // Attendance is stored outside the game state, so it can change without a league update.
      state.members=data.state.members||[];
      render();
    }
    setNet("ONLINE · SYNCED",true);
    if(host){
      const reply=await onlineRequest("/api/room/commands");
      for(const event of reply.commands||[]) {
        if(event.type==="bid"&&event.ownerId){
          processBid(event.ownerId);
        }
      }
    }
  }catch(e){
    if(e.status===401||e.status===404){
      onlineStop();setNet("ROOM UNAVAILABLE");
      if(e.status===404){
        await onlineSignOut();
      }
    }else setNet("RECONNECTING");
  }finally{onlinePolling=false}
}
const onlineOriginalRender=render;
render=function(){onlineOriginalRender();if(window.DCC_ONLINE&&state.room){
  const host=me.role==="host"||me.role==="admin";
  $("#hostPlayerMonitor")?.classList.toggle("hidden",!host);
  $("#deleteRoomButton")?.classList.toggle("hidden",me.role!=="host");
  $("#competitionHostSetup")?.classList.toggle("hidden",!host);
}};
persist=function(){
  if(!state.room||!onlineToken)return render();
  if(!["host","admin"].includes(me.role))return render();
  const copy=structuredClone(state);
  render();
  onlineSaving=true;
  onlineSaveChain=onlineSaveChain.then(async()=>{
    if(!onlineToken||onlineRoomId!==copy.room.code)return;
    try{
      const result=await onlineRequest("/api/room/state",{version:onlineVersion,state:copy});
      onlineVersion=Number(result.version);
      setNet("ONLINE · SYNCED",true);
    }catch(e){
      if(e.status===409 && e.data?.state){
        state=migrateState(e.data.state);
        onlineVersion=Number(e.data.version);
        render();
      }else onlineError(e);
    }
  }).finally(()=>{onlineSaving=false});
};
createRoom=async function(){
  const purse=Number($("#startPurse").value);
  if(!Number.isFinite(purse)||purse<=0)return alert("Enter a valid starting purse.");
  setNet("CREATING ROOM");
  try{
    const result=await onlineRequest("/api/rooms/create",{startPurse:purse,state:blankState()});
    onlineSetSession(result,"host",{hostKey:result.hostKey,playerCode:result.playerCode,creatorSecret:result.creatorSecret});
    const rec={roomId:result.roomId,hostKey:result.hostKey,playerCode:result.playerCode,creatorSecret:result.creatorSecret,createdAt:Date.now()};
    saveCreatedRoom(rec);
    pendingCreated=rec;
    showCreatedCredentials(rec);
    renderMyRooms();
    setNet("ROOM CREATED",true);
  }catch(e){alert(onlineError(e))}
};
enterCreatedRoom=async function(){
  if(!onlineToken)return alert("Create a room first");
  pendingCreated=null;
  enterGame();setNet("ONLINE · HOST",true);onlineRun();
};
openCreatedRoom=async function(code){
  const rec=findCreated(code);
  if(!rec)return alert("This room was not created on this browser.");
  setNet("HOST LOGIN");
  try{
    const result=await onlineRequest("/api/rooms/login/host",{roomId:rec.roomId,hostKey:rec.hostKey,creatorSecret:rec.creatorSecret});
    const role=result.role==="host"?"host":"admin";
    onlineSetSession(result,role,{hostKey:rec.hostKey,playerCode:rec.playerCode,creatorSecret:rec.creatorSecret});
    enterGame();onlineRun();
  }catch(e){alert(onlineError(e))}
};
joinAsHost=async function(){
  const roomId=$("#hostRoomIdInput").value.trim().toUpperCase();
  const hostKey=$("#hostKeyInput").value.trim().toUpperCase();
  if(!/^DCC-[A-Z0-9]{6}$/.test(roomId)||!/^[A-Z0-9]{6}$/.test(hostKey))return alert("Enter your Room ID and 6-character Host Key.");
  const creatorSecret=findCreated(roomId)?.creatorSecret;
  setNet("VERIFYING HOST");
  try{
    const result=await onlineRequest("/api/rooms/login/host",{roomId,hostKey,creatorSecret});
    const role=result.role==="host"?"host":"admin";
    onlineSetSession(result,role,{hostKey,playerCode:findCreated(roomId)?.playerCode||null,creatorSecret:creatorSecret||null});
    enterGame();onlineRun();
  }catch(e){alert(onlineError(e))}
};
joinAsPlayer=async function(){
  const playerCode=$("#playerJoinCodeInput").value.trim().toUpperCase();
  if(!/^[A-Z0-9]{10}$/.test(playerCode)||!/[A-Z]/.test(playerCode)||!/[0-9]/.test(playerCode))return alert("Enter the 10-character Player Joining Code.");
  setNet("VERIFYING PLAYER");
  try{
    const result=await onlineRequest("/api/rooms/login/player",{playerCode,deviceId:onlineDevice(playerCode)});
    onlineSetSession(result,result.ownerId?"owner":"member",{hostKey:null,playerCode,creatorSecret:null});
    enterGame();onlineRun();
  }catch(e){alert(onlineError(e))}
};
registerFranchise=async function(){
  if(me.role!=="member")return alert("Join Room as a player first.");
  const owner=$("#memberOwnerName").value.trim(),team=$("#memberTeamName").value.trim();
  if(!owner||!team)return alert("Enter your name and franchise name.");
  try{
    const result=await onlineRequest("/api/room/register",{owner,team});
    state=migrateState(result.state);
    onlineVersion=Number(result.version);
    setMe({role:"owner",ownerId:result.ownerId,roomCode:onlineRoomId});
    onlineSaveSession();
    render();setNet("ONLINE · PLAYER",true);
  }catch(e){alert(onlineError(e))}
};
sendCommand=async function(){
  if(me.role!=="owner"||!onlineToken)return alert("Create your franchise before bidding.");
  try{await onlineRequest("/api/room/bid",{})}
  catch(e){if(e.status===429)return;alert(onlineError(e))}
};
rotatePlayerCode=async function(){
  if(me.role!=="host")return alert("Only the original room creator can change the joining code.");
  if(!confirm("Replace this room's player joining code? Existing players keep their sessions."))return;
  try{
    const result=await onlineRequest("/api/room/rotate",{});
    activePlayerCode=result.playerCode;
    const rec=findCreated(onlineRoomId);
    if(rec)saveCreatedRoom({...rec,playerCode:result.playerCode});
    render();renderMyRooms();onlineSaveSession();
  }catch(e){alert(onlineError(e))}
};
async function deleteSavedRoom(roomId) {
  const rec=findCreated(roomId);
  if(!rec?.creatorSecret)return alert("Only the original creator can delete this room.");
  const typed=prompt("Enter the six-character Host Key to permanently delete "+roomId+":");
  if(typed===null)return false;
  if(typed.trim().toUpperCase()!==rec.hostKey)return alert("Incorrect Host Key. The room was not deleted.");
  if(!confirm("Delete room "+roomId+" for every connected player? This cannot be undone."))return false;
  try {
    // Re-authenticate as the original creator even if this page is currently logged out.
    const result=await onlineRequest("/api/rooms/login/host",{roomId,hostKey:rec.hostKey,creatorSecret:rec.creatorSecret});
    if(result.role!=="host")return alert("Only the original creator can delete this room.");
    const token=onlineToken,oldId=onlineRoomId;
    onlineToken=result.sessionToken;onlineRoomId=roomId;
    try{await onlineRequest("/api/room",{hostKey:rec.hostKey},"DELETE")}
    catch(e){onlineToken=token;onlineRoomId=oldId;throw e}
    saveCreated(loadCreated().filter(r=>r.roomId!==roomId));
    localStorage.removeItem(ROOM_PREFIX+roomId);
    localStorage.removeItem(ONLINE_DEVICE_PREFIX+rec.playerCode);
    if(state.room?.code===roomId)await onlineSignOut();
    else{onlineToken=token;onlineRoomId=oldId;renderMyRooms()}
    return true;
  }catch(e){alert(onlineError(e));return false}
}
async function deleteCurrentRoom(){
  if(me.role!=="host"||!onlineRoomId)return alert("Only the original creator can delete the room.");
  return deleteSavedRoom(onlineRoomId);
}
async function factoryReset(){return deleteCurrentRoom()}
async function onlineSignOut(){
  onlineStop();onlineToken=null;onlineRoomId=null;onlineVersion=0;onlineCreatorSecret=null;
  sessionStorage.removeItem(ONLINE_SESSION_KEY);
  clearInterval(timerHandle);timerHandle=null;
  state=blankState();me={role:null,ownerId:null,roomCode:null};activeHostKey=null;activePlayerCode=null;pendingCreated=null;
  sessionStorage.removeItem(SESSION_KEY);
  $("#game").classList.remove("active");$("#landing").classList.add("active");
  showLoginView(null);setNet("OFFLINE");renderMyRooms();render();
}
logoutRoom=onlineSignOut;
(async function restoreOnlineSession(){
  try{
    const saved=JSON.parse(sessionStorage.getItem(ONLINE_SESSION_KEY)||"null");
    if(!saved?.token||!saved.roomId)return;
    onlineToken=saved.token;onlineRoomId=saved.roomId;
    activePlayerCode=saved.playerCode||null;
    onlineCreatorSecret=saved.creatorSecret||null;
    const data=await onlineRequest("/api/room/state");
    if(data.roomId!==saved.roomId)return;
    onlineSetSession({...data,sessionToken:saved.token},saved.role==="owner"&&data.ownerId?"owner":saved.role,{playerCode:saved.playerCode||null,creatorSecret:saved.creatorSecret||null});
    enterGame();onlineRun();
  }catch(e){console.warn("Online session restore failed:",e.message);sessionStorage.removeItem(ONLINE_SESSION_KEY)}
})();
