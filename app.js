
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const CREATOR_INDEX="dcc-created-rooms-v8";
const ROOM_PREFIX="dcc-room-v8:";
const MEMBER_PREFIX="dcc-device-v8:";
const SESSION_KEY="dcc-session-v8";
const ALPHA="ABCDEFGHJKLMNPQRSTUVWXYZ",DIGITS="23456789",CHARS=ALPHA+DIGITS;
let state=blankState();
let me={role:null,ownerId:null,roomCode:null};
let activeHostKey=null,activePlayerCode=null;
let timerHandle=null,playerNet=null,hostNet=null,playerActions=null,hostActions=null;
let hostUserId=null,approvedAdmins=new Set(),approvedPlayers=new Map(),networkEpoch=0,loginTimeout=null;
let pendingCreated=null;

function blankState(){return {room:null,players:structuredClone(PLAYER_SEED),franchises:[],auction:{playerId:null,bid:0,leader:null,running:false,endsAt:0},feed:[],pitch:null,toss:null,matches:[],stats:{},updatedAt:Date.now(),version:8}}
function migrateState(s){if(!s||!Array.isArray(s.players)||!Array.isArray(s.franchises))return blankState();const existing=new Set(s.players.map(p=>String(p.name||"").toLowerCase()));for(const seed of PLAYER_SEED){if(!existing.has(seed.name.toLowerCase()))s.players.push(structuredClone(seed))}s.version=8;return s}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function money(v){v=Number(v||0);return v>=100?"₹"+(v/100).toFixed(v%100?2:0)+" Cr":"₹"+v+" L"}
function randomString(n){let v="";do{const bytes=new Uint8Array(n);crypto.getRandomValues(bytes);v=Array.from(bytes,x=>CHARS[x%CHARS.length]).join("")}while(!/[A-Z]/.test(v)||!/[0-9]/.test(v));return v}
function loadCreated(){try{return JSON.parse(localStorage.getItem(CREATOR_INDEX)||"[]")}catch{return []}}
function saveCreated(rows){localStorage.setItem(CREATOR_INDEX,JSON.stringify(rows))}
function findCreated(code){return loadCreated().find(x=>x.roomId===code)}
function saveCreatedRoom(row){const rows=loadCreated().filter(x=>x.roomId!==row.roomId);rows.unshift(row);saveCreated(rows)}
function roomSnapshot(code){try{const s=JSON.parse(localStorage.getItem(ROOM_PREFIX+code)||"null");return s?migrateState(s):null}catch{return null}}
function saveLocal(){if(me.role==="host"&&state.room?.code)localStorage.setItem(ROOM_PREFIX+state.room.code,JSON.stringify(state));saveSession()}
function saveSession(){sessionStorage.setItem(SESSION_KEY,JSON.stringify({me,activeHostKey,activePlayerCode}))}
function setMe(data){me=data;saveSession()}
function deviceToken(code){let t=localStorage.getItem(MEMBER_PREFIX+code);if(!t){t=crypto.randomUUID();localStorage.setItem(MEMBER_PREFIX+code,t)}return t}
function ownerBy(id){return state.franchises.find(f=>f.id===id)}
function currentPlayer(){return state.players.find(p=>p.id===state.auction.playerId)}
function availablePlayers(){return state.players.filter(p=>p.active&&p.owner===null)}
function publicState(){const v=structuredClone(state);if(v.room){delete v.room.hostPass;delete v.room.hostKey;delete v.room.playerCode;delete v.room.passHash}v.franchises=v.franchises.map(({memberToken,userId,passHash,...rest})=>rest);return v}
function hostOnly(){if(!["host","admin"].includes(me.role)){alert("Only hosts can use this control.");return false}return true}
function tab(id){const allowed=me.role==="host"||me.role==="admin"||id!=="admin";if(!allowed)return;$$(".panel").forEach(p=>p.classList.toggle("active",p.id===id))}
function enterGame(){$("#landing").classList.remove("active");$("#game").classList.add("active");tab("lobby");render()}
function showLoginView(id){for(const x of ["createBox","createdBox","joinChoiceBox","playerLoginBox","hostLoginBox"]){$("#"+x)?.classList.toggle("hidden",x!==id)}}
function showCreate(){showLoginView("createBox")}
function showJoin(){showLoginView("joinChoiceBox")}
function showPlayerLogin(){showLoginView("playerLoginBox")}
function showHostLogin(){showLoginView("hostLoginBox")}
function backHome(){showLoginView(null)}
function setNet(label,ok=false){const el=$("#netBadge");if(el){el.textContent=label;el.classList.toggle("online",ok)}}
function copyText(text){if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);return Promise.reject(new Error("Clipboard not available"))}
function ownCredentials(){const c=state.room?.code;const stored=findCreated(c);return {roomId:c,hostKey:stored?.hostKey||activeHostKey,playerCode:stored?.playerCode||activePlayerCode}}
function copyPlayerCode(){if(!hostOnly() && !pendingCreated)return;const code=pendingCreated?.playerCode||ownCredentials().playerCode;if(code)copyText(code).catch(()=>alert("Copy the code displayed on the screen."))}
function copyHostDetails(){if(!hostOnly() && !pendingCreated)return;const creds=pendingCreated||ownCredentials();if(creds.roomId&&creds.hostKey)copyText("Room ID: "+creds.roomId+"\nHost Key: "+creds.hostKey).catch(()=>alert("Copy your host login details manually."))}
function renderMyRooms(){
  const box=$("#myRoomsCard"),el=$("#myRooms");if(!box||!el)return;
  const rows=loadCreated();box.classList.toggle("hidden",!rows.length);
  el.innerHTML=rows.map(c=>"<div class='saved-room'><div><b>"+esc(c.roomId)+"</b><span>"+new Date(c.createdAt||Date.now()).toLocaleDateString()+"</span></div><div class='actions'><button onclick=\"openCreatedRoom('"+c.roomId+"')\">Open Room</button><button class='danger' onclick=\"deleteSavedRoom('"+c.roomId+"')\">Delete Room</button></div></div>").join("");
}
function showCreatedCredentials(c){pendingCreated=c;$("#createdRoomId").textContent=c.roomId;$("#createdHostKey").textContent=c.hostKey;$("#createdPlayerCode").textContent=c.playerCode;showLoginView("createdBox")}
function persist(){state.updatedAt=Date.now();if(me.role==="host"){saveLocal();broadcastState()}else if(me.role==="admin"&&hostActions&&hostUserId){hostActions.command.send({type:"admin-state",roomId:state.room?.code,state:publicState()},{target:hostUserId}).catch(console.warn)}render()}

async function closeNetworks(){networkEpoch++;clearTimeout(loginTimeout);try{await playerNet?.leave()}catch{}try{await hostNet?.leave()}catch{}playerNet=null;hostNet=null;playerActions=null;hostActions=null;hostUserId=null;approvedAdmins.clear();approvedPlayers.clear()}
async function loadTrystero(){return (await import("https://esm.run/trystero")).joinRoom}
function attachActions(room){return {hello:room.makeAction("dcc-hello"),reply:room.makeAction("dcc-reply"),command:room.makeAction("dcc-command"),sync:room.makeAction("dcc-sync")}}
function broadcastState(){if(me.role!=="host")return;const snapshot=publicState();playerActions?.sync.send(snapshot).catch(console.warn);hostActions?.sync.send(snapshot).catch(console.warn)}
function loginPending(expectedRole){clearTimeout(loginTimeout);loginTimeout=setTimeout(()=>{if(me.role===expectedRole){setNet("HOST OFFLINE");alert("No host responded. Check the code and keep the creator's room open. Peer-to-peer connections may also be blocked by the network.")}},15000)}
async function connectPlayerRoomAsHost(code){
  try{await playerNet?.leave()}catch{}playerNet=null;playerActions=null;approvedPlayers.clear();
  const join=await loadTrystero();
  playerNet=join({appId:"diddyx6969/dcc-player-v8",password:code,identity:"none"},"dcc-player-"+code);
  playerActions=attachActions(playerNet);
  playerActions.hello.onMessage((data,ctx)=>{
    if(me.role!=="host"||data?.type!=="player-join"||!data.deviceToken)return;
    const f=state.franchises.find(x=>x.memberToken===data.deviceToken);
    approvedPlayers.set(ctx.userId,data.deviceToken);
    if(f){f.userId=ctx.userId;f.online=true;persist()}
    playerActions.reply.send({ok:true,roomId:state.room.code,ownerId:f?.id||null,state:publicState()},{target:ctx.userId}).catch(console.warn);
  });
  playerActions.command.onMessage((data,ctx)=>{
    if(me.role!=="host"||!approvedPlayers.has(ctx.userId))return;
    handlePlayerCommand(data,ctx.userId);
  });
  playerNet.onUserLeave(({userId})=>{if(me.role!=="host")return;approvedPlayers.delete(userId);const f=state.franchises.find(x=>x.userId===userId);if(f){f.online=false;persist()}});
  playerNet.onError(e=>{console.warn("Player channel",e)});
}
async function connectHostRoomAsCreator(roomId,hostKey){
  const join=await loadTrystero();
  hostNet=join({appId:"diddyx6969/dcc-host-v8",password:roomId+":"+hostKey,identity:"none"},"dcc-host-"+roomId);
  hostActions=attachActions(hostNet);
  hostActions.hello.onMessage((data,ctx)=>{
    if(me.role!=="host"||data?.type!=="host-join"||data.roomId!==state.room?.code)return;
    approvedAdmins.add(ctx.userId);
    hostActions.reply.send({ok:true,state:publicState(),roomId:state.room.code},{target:ctx.userId}).catch(console.warn);
  });
  hostActions.command.onMessage((data,ctx)=>{
    if(me.role!=="host"||!approvedAdmins.has(ctx.userId)||data?.type!=="admin-state"||data.roomId!==state.room?.code)return;
    const candidate=data.state;
    if(!candidate||!Array.isArray(candidate.players)||!Array.isArray(candidate.franchises)||!candidate.auction||candidate.room?.code!==state.room?.code)return;
    const secretTokens=new Map(state.franchises.map(f=>[f.id,{memberToken:f.memberToken,userId:f.userId,online:f.online}]));
    const safe=migrateState(candidate);
    safe.franchises=safe.franchises.map(f=>({...f,...(secretTokens.get(f.id)||{})}));
    safe.room={...state.room,...safe.room,code:state.room.code};
    state=safe;saveLocal();broadcastState();render();if(state.auction.running)runTimer();
  });
  hostNet.onUserLeave(({userId})=>approvedAdmins.delete(userId));
  hostNet.onError(e=>console.warn("Host channel",e));
}
async function connectAsCreator(){
  await closeNetworks();
  if(!activeHostKey||!activePlayerCode)throw Error("Creator login details were not saved");
  setNet("CONNECTING");
  await connectHostRoomAsCreator(state.room.code,activeHostKey);
  await connectPlayerRoomAsHost(activePlayerCode);
  setNet("HOST ONLINE",true);
  if(state.auction.running)runTimer();
}
async function connectPlayer(code){
  await closeNetworks();
  setNet("FINDING ROOM");
  const join=await loadTrystero();
  playerNet=join({appId:"diddyx6969/dcc-player-v8",password:code,identity:"none"},"dcc-player-"+code);
  playerActions=attachActions(playerNet);
  const sendHello=(target)=>playerActions?.hello.send({type:"player-join",deviceToken:deviceToken(code)},{target}).catch(console.warn);
  playerNet.onUserJoin(({userId})=>sendHello(userId),{replay:true});
  playerActions.reply.onMessage((data,ctx)=>{
    if(!["guest","member","owner"].includes(me.role)||!data?.ok||!data.state?.room?.code)return;
    hostUserId=ctx.userId;state=migrateState(data.state);
    setMe({role:data.ownerId?"owner":"member",ownerId:data.ownerId||null,roomCode:state.room.code});
    setNet("CONNECTED",true);clearTimeout(loginTimeout);enterGame();
  });
  playerActions.sync.onMessage((incoming,ctx)=>{
    if(!["owner","member"].includes(me.role)||ctx.userId!==hostUserId||incoming?.room?.code!==state.room?.code)return;
    state=migrateState(incoming);render();
  });
  playerNet.onUserLeave(({userId})=>{if(userId===hostUserId){hostUserId=null;setNet("HOST OFFLINE")}});
  playerNet.onError(e=>console.warn("Player connection",e));
  loginPending("guest");
}
async function connectAsRemoteHost(roomId,hostKey){
  await closeNetworks();setNet("FINDING HOST");
  const join=await loadTrystero();
  hostNet=join({appId:"diddyx6969/dcc-host-v8",password:roomId+":"+hostKey,identity:"none"},"dcc-host-"+roomId);
  hostActions=attachActions(hostNet);
  const sendHello=target=>hostActions?.hello.send({type:"host-join",roomId},{target}).catch(console.warn);
  hostNet.onUserJoin(({userId})=>sendHello(userId),{replay:true});
  hostActions.reply.onMessage((data,ctx)=>{
    if(me.role!=="host-pending"||!data?.ok||data.roomId!==roomId||data.state?.room?.code!==roomId)return;
    hostUserId=ctx.userId;state=migrateState(data.state);setMe({role:"admin",ownerId:"admin",roomCode:roomId});
    setNet("HOST CONNECTED",true);clearTimeout(loginTimeout);enterGame();if(state.auction.running)runTimer();
  });
  hostActions.sync.onMessage((data,ctx)=>{if(me.role!=="admin"||ctx.userId!==hostUserId||data?.room?.code!==roomId)return;state=migrateState(data);render()});
  hostNet.onUserLeave(({userId})=>{if(userId===hostUserId){hostUserId=null;setNet("CREATOR OFFLINE")}});
  hostNet.onError(e=>console.warn("Host connection",e));
  loginPending("host-pending");
}
function handlePlayerCommand(data,userId){
  if(data?.type==="register"){
    const token=approvedPlayers.get(userId);
    if(!token)return;
    let owner=String(data.owner||"").trim().slice(0,80),team=String(data.team||"").trim().slice(0,80);
    if(!owner||!team)return playerActions.reply.send({ok:false,error:"Owner and franchise names are required"},{target:userId});
    let f=state.franchises.find(x=>x.memberToken===token);
    if(!f){
      if(state.franchises.some(x=>x.team.toLowerCase()===team.toLowerCase())){
        playerActions.reply.send({ok:false,error:"That franchise name is already taken"},{target:userId}).catch(console.warn);return;
      }
      f={id:crypto.randomUUID(),owner,team,memberToken:token,userId,online:true,purse:state.room.startPurse,joinedAt:Date.now()};
      state.franchises.push(f);state.feed.unshift("🏏 "+team+" joined the room.");
    }else{f.userId=userId;f.online=true}
    persist();
    playerActions.reply.send({ok:true,roomId:state.room.code,ownerId:f.id,state:publicState()},{target:userId}).catch(console.warn);
    return;
  }
  if(data?.type==="bid"){
    const token=approvedPlayers.get(userId);
    const f=state.franchises.find(x=>x.memberToken===token&&x.userId===userId);
    if(f)processBid(f.id);
  }
}
async function createRoom(){
  const purse=Number($("#startPurse").value);
  if(!Number.isFinite(purse)||purse<=0)return alert("Enter a valid starting purse.");
  const old=loadCreated();
  let roomId,playerCode,hostKey;
  do{roomId="DCC-"+randomString(6)}while(old.some(x=>x.roomId===roomId));
  do{playerCode=randomString(10)}while(old.some(x=>x.playerCode===playerCode));
  hostKey=randomString(6);
  const createdAt=Date.now();
  const rec={roomId,hostKey,playerCode,createdAt};
  state=blankState();state.room={code:roomId,hostName:"Creator",startPurse:Math.round(purse*100),createdAt};
  activeHostKey=hostKey;activePlayerCode=playerCode;
  setMe({role:"host",ownerId:"host",roomCode:roomId});
  saveCreatedRoom(rec);saveLocal();showCreatedCredentials(rec);renderMyRooms();
}
async function enterCreatedRoom(){
  if(!pendingCreated)return alert("Create a room first.");
  enterGame();
  try{await connectAsCreator()}catch(e){console.error(e);setNet("NETWORK ERROR");alert("Could not start room connections. Reload and open the saved room.")}
  pendingCreated=null;
}
async function openCreatedRoom(code){
  const creds=findCreated(code),snap=roomSnapshot(code);
  if(!creds||!snap)return alert("This room is not stored on this browser.");
  activeHostKey=creds.hostKey;activePlayerCode=creds.playerCode;state=snap;
  setMe({role:"host",ownerId:"host",roomCode:code});enterGame();
  try{await connectAsCreator()}catch(e){console.error(e);setNet("NETWORK ERROR")}
}
async function joinAsPlayer(){
  const code=$("#playerJoinCodeInput").value.trim().toUpperCase();
  if(!/^[A-Z0-9]{10}$/.test(code)||!/[A-Z]/.test(code)||!/[0-9]/.test(code))return alert("Enter the 10-character Player Joining Code.");
  activeHostKey=null;activePlayerCode=code;state=blankState();
  setMe({role:"guest",ownerId:null,roomCode:null});
  try{await connectPlayer(code)}catch(e){console.error(e);setNet("NETWORK ERROR");alert("Could not connect. Check your internet connection.")}
}
async function joinAsHost(){
  const roomId=$("#hostRoomIdInput").value.trim().toUpperCase(),key=$("#hostKeyInput").value.trim().toUpperCase();
  if(!/^DCC-[A-Z0-9]{6}$/.test(roomId)||!/^[A-Z0-9]{6}$/.test(key))return alert("Enter your Room ID and 6-character Host Key.");
  const saved=findCreated(roomId);
  if(saved&&saved.hostKey===key)return openCreatedRoom(roomId);
  activeHostKey=key;activePlayerCode=null;state=blankState();
  setMe({role:"host-pending",ownerId:null,roomCode:roomId});
  try{await connectAsRemoteHost(roomId,key)}catch(e){console.error(e);setNet("NETWORK ERROR");alert("Could not connect. Check your internet connection.")}
}
function registerFranchise(){
  if(me.role!=="member"||!playerActions||!hostUserId)return alert("Connect as a player first.");
  const owner=$("#memberOwnerName").value.trim(),team=$("#memberTeamName").value.trim();
  if(!owner||!team)return alert("Enter your name and franchise name.");
  playerActions.command.send({type:"register",owner,team},{target:hostUserId}).catch(console.warn);
}
function sendCommand(data){
  if(me.role!=="owner"||!playerActions||!hostUserId)return alert("Join as a franchise owner first.");
  playerActions.command.send({type:"bid"},{target:hostUserId}).catch(console.warn);
}
async function rotatePlayerCode(){
  if(me.role!=="host")return alert("Only the original room creator can change the Player Code.");
  if(!confirm("Regenerate the Player Joining Code? Existing player connections will disconnect and need the new code."))return;
  const old=loadCreated();let next;
  do{next=randomString(10)}while(old.some(x=>x.playerCode===next));
  activePlayerCode=next;
  saveCreatedRoom({...ownCredentials(),playerCode:next,createdAt:state.room.createdAt});
  try{await connectPlayerRoomAsHost(next);setNet("HOST ONLINE",true)}catch(e){console.error(e);setNet("NETWORK ERROR");return alert("Could not activate the new joining code.")}
  render();renderMyRooms();
}
async function logoutRoom(){
  await closeNetworks();clearInterval(timerHandle);timerHandle=null;state=blankState();me={role:null,ownerId:null,roomCode:null};
  activeHostKey=null;activePlayerCode=null;pendingCreated=null;sessionStorage.removeItem(SESSION_KEY);
  $("#game").classList.remove("active");$("#landing").classList.add("active");showLoginView(null);setNet("OFFLINE");renderMyRooms();render();
}
function renderAuctionSelect(){
  const q=($("#auctionSearch")?.value||"").trim().toLowerCase(),sel=$("#playerSelect");if(!sel)return;
  const old=sel.value;sel.innerHTML=availablePlayers().filter(p=>!q||p.name.toLowerCase().includes(q)||p.iplTeam.toLowerCase().includes(q)||String(p.sourceTeam||"").toLowerCase().includes(q)||String(p.status||"").toLowerCase().includes(q)).map(p=>"<option value='"+p.id+"'>"+esc(p.name)+" • "+p.iplTeam+" • "+money(p.basePrice)+"</option>").join("");
  if([...sel.options].some(o=>o.value===old))sel.value=old;
}
function hostSelectPlayer(id){if(!hostOnly())return;state.auction={playerId:id,bid:0,leader:null,running:false,endsAt:0};persist()}
function startAuction(){if(!hostOnly())return;let p=currentPlayer();if(!p){p=state.players.find(x=>x.id===$("#playerSelect").value)||availablePlayers()[0]}if(!p)return alert("No players available.");state.auction={playerId:p.id,bid:p.basePrice,leader:null,running:true,endsAt:Date.now()+Number($("#timerSec").value||15)*1000};state.feed.unshift("🔔 "+p.name+" opens at "+money(p.basePrice));persist();runTimer()}
function placeBid(){if(me.role!=="owner")return alert("Only franchise owners bid.");sendCommand({type:"bid"})}
function processBid(ownerId){const p=currentPlayer(),f=ownerBy(ownerId);if(!p||!f||!state.auction.running)return;const step=Number($("#bidStep")?.value||10),next=state.auction.leader?state.auction.bid+step:state.auction.bid;if(state.auction.leader===f.id)return;if(f.purse<next){state.feed.unshift("❌ "+f.team+" cannot afford "+money(next));persist();return}state.auction.bid=next;state.auction.leader=f.id;state.auction.endsAt=Date.now()+Number($("#timerSec")?.value||15)*1000;state.feed.unshift("💰 "+f.team+" bids "+money(next)+" for "+p.name);persist()}
function sellPlayer(){if(!hostOnly())return;const p=currentPlayer(),f=ownerBy(state.auction.leader);if(!p||!f)return alert("There is no winning bidder.");if(f.purse<state.auction.bid)return alert("Insufficient purse.");p.owner=f.id;p.soldPrice=state.auction.bid;f.purse-=state.auction.bid;state.feed.unshift("🔨 SOLD — "+p.name+" to "+f.team+" for "+money(p.soldPrice));state.auction={playerId:null,bid:0,leader:null,running:false,endsAt:0};persist()}
function markUnsold(){if(!hostOnly())return;const p=currentPlayer();if(p)state.feed.unshift("UNSOLD — "+p.name);state.auction={playerId:null,bid:0,leader:null,running:false,endsAt:0};persist()}
function cancelAuction(){if(!hostOnly())return;const p=currentPlayer();if(p)state.feed.unshift("Auction cancelled for "+p.name);resetAuctionState()}
function resetAuctionState(){if(!hostOnly())return;state.auction={playerId:null,bid:0,leader:null,running:false,endsAt:0};persist()}
function runTimer(){clearInterval(timerHandle);timerHandle=setInterval(()=>{if(!state.auction.running){clearInterval(timerHandle);return}if(Date.now()>=state.auction.endsAt){state.auction.running=false;state.feed.unshift("⏱️ Time! Room decides SOLD or UNSOLD.");persist();clearInterval(timerHandle)}else renderAuction()},250)}

function addCustomPlayer(){if(!hostOnly())return;const name=$("#newPlayerName").value.trim(),basePrice=Number($("#newPlayerPrice").value);if(!name||basePrice<1)return alert("Enter a player name and valid price.");state.players.push({id:crypto.randomUUID(),name,iplTeam:"CUSTOM",role:$("#newPlayerRole").value,basePrice,bat:clamp($("#newBat").value),bowl:clamp($("#newBowl").value),field:clamp($("#newField").value),owner:null,soldPrice:null,active:true});$("#newPlayerName").value="";persist()}
function clamp(v){return Math.max(1,Math.min(99,Number(v||50)))}
function loadPlayerEditor(){const p=state.players.find(x=>x.id===$("#editPlayer").value);if(!p)return;$("#editPrice").value=p.basePrice;$("#editBat").value=p.bat;$("#editBowl").value=p.bowl;$("#editField").value=p.field;$("#assignTeam").value=p.owner||""}
function savePlayerEdit(){if(!hostOnly())return;const p=state.players.find(x=>x.id===$("#editPlayer").value);if(!p)return;p.basePrice=Math.max(1,Number($("#editPrice").value));p.bat=clamp($("#editBat").value);p.bowl=clamp($("#editBowl").value);p.field=clamp($("#editField").value);p.owner=$("#assignTeam").value||null;if(!p.owner)p.soldPrice=null;persist()}
function removePlayer(){if(!hostOnly())return;const p=state.players.find(x=>x.id===$("#editPlayer").value);if(!p)return;p.active=false;persist()}
function loadTeamEditor(){const f=ownerBy($("#adminTeam").value);if(!f)return;$("#adminTeamName").value=f.team;$("#adminOwnerName").value=f.owner;$("#adminPurse").value=f.purse}
function saveTeamEdit(){if(!hostOnly())return;const f=ownerBy($("#adminTeam").value);if(!f)return;f.team=$("#adminTeamName").value.trim()||f.team;f.owner=$("#adminOwnerName").value.trim()||f.owner;f.purse=Math.max(0,Number($("#adminPurse").value||0));persist()}
function removeTeam(){if(!hostOnly())return;const f=ownerBy($("#adminTeam").value);if(!f)return;if(!confirm("Remove "+f.team+" and release its players?"))return;state.players.forEach(p=>{if(p.owner===f.id){p.owner=null;p.soldPrice=null}});state.franchises=state.franchises.filter(x=>x.id!==f.id);persist()}

const PITCHES=[
{name:"Flat Batting Paradise",bat:13,pace:-7,spin:-5,desc:"True bounce, quick outfield, bowlers under pressure."},
{name:"Green Seamer",bat:-11,pace:16,spin:-7,desc:"Fresh grass, movement and a difficult new-ball phase."},
{name:"Dry Turner",bat:-7,pace:-3,spin:17,desc:"Grip and turn; spin becomes a major weapon."},
{name:"Slow & Low",bat:-6,pace:-8,spin:9,desc:"Timing is hard; cutters and smart batting matter."},
{name:"Balanced",bat:1,pace:2,spin:2,desc:"Fair conditions with rewards for quality cricket."}
];
function generatePitch(){if(!hostOnly())return;state.pitch=structuredClone(PITCHES[Math.floor(Math.random()*PITCHES.length)]);persist()}
function conductToss(){if(!hostOnly())return;const a=ownerBy($("#teamA").value),b=ownerBy($("#teamB").value);if(!a||!b||a.id===b.id)return alert("Choose two different teams.");const winner=Math.random()<.5?a:b;state.toss={winner:winner.id,choice:Math.random()<.52?"bat":"bowl"};persist()}
function formatChanged(){$("#customOversLabel").classList.toggle("hidden",$("#format").value!=="custom")}
function fillXI(){for(const [sel,box] of [["#teamA","#xiA"],["#teamB","#xiB"]]){const id=$(sel)?.value;if(!id||!$(box)||$(box).value.trim())continue;$(box).value=state.players.filter(p=>p.owner===id&&p.active).slice(0,11).map(p=>p.name).join("\n")}}
function getXI(teamId,text){const squad=state.players.filter(p=>p.owner===teamId&&p.active),names=text.split(/\n|,/).map(x=>x.trim()).filter(Boolean);if(!names.length)return squad.slice(0,11);return names.map(n=>squad.find(p=>p.name.toLowerCase()===n.toLowerCase())).filter(Boolean).slice(0,11)}
function oversForFormat(){return {ipl:20,t20:20,odi:50,test:90,t10:10,custom:Math.max(1,Number($("#customOvers").value||20))}[$("#format").value]||20}
function pick(arr){return arr[Math.floor(Math.random()*arr.length)]}
function simulateInnings(team,opp,xi,oppXI,overs,target,bias){
  let runs=0,wickets=0,balls=0,striker=0,non=1;const batStats={},bowlStats={},events=[];
  xi.forEach(p=>batStats[p.id]={name:p.name,runs:0,balls:0,fours:0,sixes:0});
  oppXI.forEach(p=>bowlStats[p.id]={name:p.name,wickets:0,runs:0,balls:0});
  let bowlers=[...oppXI].sort((a,b)=>(b.bowl||40)-(a.bowl||40)).slice(0,Math.min(6,oppXI.length));if(!bowlers.length)bowlers=oppXI;
  while(balls<overs*6&&wickets<Math.min(10,xi.length-1)&&(!target||runs<target)){
    const bat=xi[striker],bowler=bowlers[Math.floor(balls/6)%bowlers.length];if(!bat||!bowler)break;
    const pitch=state.pitch||PITCHES[4], batting=(bat.bat||60)+pitch.bat+Number(bias||0), bowling=(bowler.bowl||55)+(bowler.role==="Bowler"||bowler.role==="All-rounder"?(pitch.pace+pitch.spin)/2:0);
    const wicketP=Math.max(.012,Math.min(.13,.041+(bowling-batting)*.00078)),x=Math.random();let r=0;
    if(x<wicketP){wickets++;bowlStats[bowler.id].wickets++;events.push("WICKET • "+bowler.name+" gets "+bat.name+" — "+runs+"/"+wickets);striker=Math.max(striker,non)+1;if(striker>=xi.length)break}
    else{
      const attack=Math.max(.08,Math.min(.92,(batting-bowling+92)/185)),z=Math.random();
      r=z<.30?0:z<.57?1:z<.70?2:z<.725?3:z<.725+attack*.18?4:z<.725+attack*.27?6:0;
      runs+=r;batStats[bat.id].runs+=r;bowlStats[bowler.id].runs+=r;if(r===4){batStats[bat.id].fours++;events.push("FOUR • "+bat.name+" finds the rope")}if(r===6){batStats[bat.id].sixes++;events.push("SIX • "+bat.name+" sends it into the crowd")}if(r%2)[striker,non]=[non,striker];
    }
    batStats[bat.id].balls++;bowlStats[bowler.id].balls++;balls++;if(balls%6===0)[striker,non]=[non,striker];
  }
  return {runs,wickets,balls,batStats,bowlStats,events};
}
function simulateMatch(){
  if(!hostOnly())return;
  const a=ownerBy($("#teamA").value),b=ownerBy($("#teamB").value);if(!a||!b||a.id===b.id)return alert("Choose two different teams.");
  if(!state.pitch)generatePitch();if(!state.toss)conductToss();
  const xiA=getXI(a.id,$("#xiA").value),xiB=getXI(b.id,$("#xiB").value);if(xiA.length<2||xiB.length<2)return alert("Both teams need auctioned players. Use 11 for a proper match.");
  const overs=oversForFormat(),tw=ownerBy(state.toss.winner),first=state.toss.choice==="bat"?tw:(tw.id===a.id?b:a),second=first.id===a.id?b:a,firstXI=first.id===a.id?xiA:xiB,secondXI=second.id===a.id?xiA:xiB;
  const b1=first.id===a.id?Number($("#biasA").value||0):Number($("#biasB").value||0),b2=second.id===a.id?Number($("#biasA").value||0):Number($("#biasB").value||0);
  const i1=simulateInnings(first,second,firstXI,secondXI,overs,null,b1),i2=simulateInnings(second,first,secondXI,firstXI,overs,i1.runs+1,b2);
  const tied=i1.runs===i2.runs,winner=tied?null:(i2.runs>i1.runs?second.id:first.id);
  const m={id:crypto.randomUUID(),a:first.id,b:second.id,overs,format:$("#format").value,pitch:state.pitch.name,toss:structuredClone(state.toss),i1,i2,winner,tied,at:Date.now()};
  state.matches.push(m);updateStats(m);state.toss=null;persist();renderMatch(m);
}
function updateStats(m){for(const inn of [m.i1,m.i2]){Object.entries(inn.batStats).forEach(([id,s])=>{state.stats[id]??={runs:0,balls:0,wickets:0,runsConceded:0,matches:0};state.stats[id].runs+=s.runs;state.stats[id].balls+=s.balls;state.stats[id].matches++});Object.entries(inn.bowlStats).forEach(([id,s])=>{state.stats[id]??={runs:0,balls:0,wickets:0,runsConceded:0,matches:0};state.stats[id].wickets+=s.wickets;state.stats[id].runsConceded+=s.runs})}}
function roastFor(m){const loser=m.winner?ownerBy(m.winner===m.a?m.b:m.a):null;if(!loser)return "Both managements found a way to leave with equal amounts of stress.";return loser.team+": "+pick(["that auction plan aged like milk under stadium lights.","the XI looked picked by spinning a wheel and hoping for divine intervention.","management spent crores and apparently forgot to buy a plan.","the opposition brought cricket; you brought a group project with no leader.","that tactical masterclass belongs in a museum labelled ‘what not to do’.","the strategy meeting clearly ended after somebody said ‘trust the vibes’."])}
function adviceFor(m){const loser=m.winner?ownerBy(m.winner===m.a?m.b:m.a):null;if(!loser)return "Build clearer roles for powerplay, middle overs and the death before the next match.";const squad=state.players.filter(p=>p.owner===loser.id&&p.active),bowl=squad.filter(p=>["Bowler","All-rounder"].includes(p.role)).length,bat=squad.filter(p=>["Batter","Wicketkeeper","All-rounder"].includes(p.role)).length;if(bowl<5)return "Improvement for "+loser.team+": recruit more genuine wicket-taking options and stop forcing part-timers into key overs.";if(bat<7)return "Improvement for "+loser.team+": add batting depth and protect the lower order.";return "Improvement for "+loser.team+": optimize the batting order, use bowling matchups better and keep your best players in high-impact roles."}
function standings(){return state.franchises.map(f=>{let P=0,W=0,L=0,T=0,NR=0,rf=0,ra=0,bf=0,ba=0;state.matches.forEach(m=>{if(m.a!==f.id&&m.b!==f.id)return;P++;const own=m.a===f.id?m.i1:m.i2,opp=m.a===f.id?m.i2:m.i1;rf+=own.runs;ra+=opp.runs;bf+=own.wickets>=10?m.overs*6:own.balls;ba+=opp.wickets>=10?m.overs*6:opp.balls;if(m.tied)T++;else if(m.winner===f.id)W++;else if(m.winner)L++;else NR++});return {...f,P,W,L,T,NR,pts:W*2+T+NR,nrr:bf&&ba?rf/(bf/6)-ra/(ba/6):0}}).sort((a,b)=>b.pts-a.pts||b.nrr-a.nrr)}

function exportLeague(){
  if(!hostOnly())return;
  const a=document.createElement("a");
  const safe=publicState();
  a.href=URL.createObjectURL(new Blob([JSON.stringify(safe,null,2)],{type:"application/json"}));
  a.download=(state.room?.code||"dcc")+"-league.json";
  a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function importLeague(event){
  if(!hostOnly())return;
  const file=event.target.files?.[0];if(!file)return;
  file.text().then(t=>{
    const data=JSON.parse(t);
    if(!Array.isArray(data.players)||!Array.isArray(data.franchises)||!Array.isArray(data.matches)||data.room?.code!==state.room?.code)throw Error("Room mismatch");
    const auth=new Map(state.franchises.map(f=>[f.id,{memberToken:f.memberToken,userId:f.userId,online:f.online}]));
    data.franchises=data.franchises.map(f=>({...f,...(auth.get(f.id)||{})}));
    data.room={...state.room,...data.room,code:state.room.code};
    state=migrateState(data);persist();
  }).catch(()=>alert("That league file is invalid or belongs to another room."));
}
async function factoryReset(){
  if(me.role!=="host")return alert("Only the room creator may delete a room.");
  if(!confirm("Delete this room and all its saved league data from this browser? This cannot be undone."))return;
  const code=state.room?.code;
  saveCreated(loadCreated().filter(x=>x.roomId!==code));
  if(code)localStorage.removeItem(ROOM_PREFIX+code);
  await logoutRoom();
}
async function deleteSavedRoom(code){
  const room=findCreated(code);
  if(!room)return;
  if(!confirm("Delete room "+code+" from this browser? Its creator credentials and league snapshot will be permanently removed here."))return;
  saveCreated(loadCreated().filter(r=>r.roomId!==code));
  localStorage.removeItem(ROOM_PREFIX+code);
  if(state.room?.code===code&&me.role==="host")await logoutRoom();
  renderMyRooms();
}

function render(){
  const host=me.role==="host"||me.role==="admin";
  $("#roomBadge").textContent=state.room?.code||"NO ROOM";
  $("#logoutBtn")?.classList.toggle("hidden",!["host","admin","owner","member"].includes(me.role));
  $("#adminTab")?.classList.toggle("hidden",!host);
  $("#auctionHostControls")?.classList.toggle("hidden",!host);
  $("#matchHostControls")?.classList.toggle("hidden",!host);
  $("#hostLobbyControls")?.classList.toggle("hidden",!host);
  $("#ownerBidBtn")?.classList.toggle("hidden",me.role!=="owner");
  $("#memberSetup")?.classList.toggle("hidden",me.role!=="member");
  if(!state.room){renderMyRooms();return}
  $("#roomTitle").textContent=state.room.code;
  const credentials=host?ownCredentials():null;
  $("#roomInfo").innerHTML="Room creator: <b>"+esc(state.room.hostName||"Creator")+"</b><br>Starting purse: <b>"+money(state.room.startPurse)+"</b>";
  const roleLabel=me.role==="host"?"Creator / Host":me.role==="admin"?"Host":me.role==="owner"?"Player · "+esc(ownerBy(me.ownerId)?.team||"Franchise owner"):"Player · create your franchise";
  $("#roleBanner").innerHTML="<b>"+roleLabel+"</b>"+(host?" · You manage the auction and league.":" · You may view results and bid for your team, not manage the room.");
  $("#franchiseList").innerHTML=state.franchises.map(f=>"<div class='teamCard'><div class='row-between'><h4>"+esc(f.team)+"</h4><span class='dot "+(f.online?"on":"")+"'></span></div><div>"+esc(f.owner)+"</div><div class='money'>"+money(f.purse)+"</div></div>").join("")||"<span class='muted'>Waiting for franchise owners.</span>";
  const sold=state.players.filter(p=>p.owner).length;
  $("#leaguePulse").innerHTML="<div><b>"+state.franchises.length+"</b><span>Teams</span></div><div><b>"+sold+"</b><span>Players sold</span></div><div><b>"+state.matches.length+"</b><span>Matches</span></div><div><b>"+state.players.filter(p=>p.active).length+"</b><span>Player pool</span></div><div><b>"+availablePlayers().length+"</b><span>Available</span></div>";
  $("#soldCounter").textContent=sold+" sold • "+availablePlayers().length+" available";
  if(host){
    $("#adminRoomId").textContent=state.room.code;
    $("#adminHostKey").textContent=credentials?.hostKey||activeHostKey||"—";
    $("#adminPlayerCode").textContent=credentials?.playerCode||(me.role==="admin"?"Available from creator":"—");
  }
  renderAuctionSelect();renderAuction();renderSquads();renderTeamSelects();
  if(host)renderAdmin();
  renderStandings();
  if(state.matches.length)renderMatch(state.matches.at(-1));
}
function renderAuction(){const p=currentPlayer();$("#aName").textContent=p?.name||"Choose a player";$("#aMeta").textContent=p?((p.status==="released"?"FREE AGENT • Released by "+p.sourceTeam:p.iplTeam+" • Retained")+" • "+p.role+" • Base "+money(p.basePrice)):"";$("#aBid").textContent=state.auction.bid?money(state.auction.bid):"—";$("#aLeader").textContent=state.auction.leader?(ownerBy(state.auction.leader)?.team||"Unknown")+" leads":"No bids";$("#aTimer").textContent=state.auction.running?Math.max(0,Math.ceil((state.auction.endsAt-Date.now())/1000)):"—";$("#auctionFeed").innerHTML=state.feed.slice(0,100).map(x=>"<div>"+esc(x)+"</div>").join("")||"<span class='muted'>Auction has not started.</span>"}
function renderSquads(){$("#squadGrid").innerHTML=state.franchises.map(f=>{const sq=state.players.filter(p=>p.owner===f.id&&p.active);return "<div class='teamCard'><h4>"+esc(f.team)+"</h4><div class='money'>"+money(f.purse)+" left</div><p>"+sq.length+" players</p><ol>"+sq.map(p=>"<li>"+esc(p.name)+" <span class='muted'>"+money(p.soldPrice)+" • "+p.role+"</span></li>").join("")+"</ol></div>"}).join("")||"<span class='muted'>No squads yet.</span>"}
function renderTeamSelects(){const opts=state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");for(const id of ["teamA","teamB"]){const el=$("#"+id);if(!el)continue;const old=el.value;el.innerHTML=opts;if([...el.options].some(o=>o.value===old))el.value=old}$("#pitchBox").textContent=state.pitch?state.pitch.name+" — "+state.pitch.desc:"No pitch generated.";$("#tossBox").textContent=state.toss?(ownerBy(state.toss.winner)?.team+" won the toss and chose to "+state.toss.choice):"Toss not conducted."}
function renderAdmin(){const psel=$("#editPlayer"),oldp=psel.value;psel.innerHTML=state.players.filter(p=>p.active).map(p=>"<option value='"+p.id+"'>"+esc(p.name)+"</option>").join("");if([...psel.options].some(o=>o.value===oldp))psel.value=oldp;const teams="<option value=''>Unassigned</option>"+state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");$("#assignTeam").innerHTML=teams;const tsel=$("#adminTeam"),oldt=tsel.value;tsel.innerHTML=state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");if([...tsel.options].some(o=>o.value===oldt))tsel.value=oldt;loadPlayerEditor();loadTeamEditor()}
function renderMatch(m){const a=ownerBy(m.a),b=ownerBy(m.b);if(!a||!b)return;$("#scoreboard").innerHTML="<div class='scoreline'><span>"+esc(a.team)+"</span><b>"+m.i1.runs+"/"+m.i1.wickets+"</b><small>"+(m.i1.balls/6).toFixed(1)+" ov</small></div><div class='scoreline'><span>"+esc(b.team)+"</span><b>"+m.i2.runs+"/"+m.i2.wickets+"</b><small>"+(m.i2.balls/6).toFixed(1)+" ov</small></div><p class='muted'>"+esc(m.pitch)+"</p>";$("#matchResult").textContent=m.tied?"TIED":(ownerBy(m.winner)?.team||"")+" WON";$("#commentary").innerHTML=m.i1.events.concat(m.i2.events).slice(-100).map(x=>"<div>"+esc(x)+"</div>").join("");$("#advice").innerHTML="<div class='notice'><b>Brutal review:</b> "+esc(roastFor(m))+"</div><div class='notice'><b>Improvement:</b> "+esc(adviceFor(m))+"</div>"}
function renderStandings(){const rows=standings();$("#pointsBody").innerHTML=rows.map((r,i)=>"<tr><td>"+(i+1)+"</td><td>"+esc(r.team)+"</td><td>"+r.P+"</td><td>"+r.W+"</td><td>"+r.L+"</td><td>"+r.T+"</td><td>"+r.NR+"</td><td><b>"+r.pts+"</b></td><td>"+r.nrr.toFixed(3)+"</td></tr>").join("");const sr=Object.entries(state.stats).map(([id,s])=>({p:state.players.find(x=>x.id===id),...s})).filter(x=>x.p);$("#batLeaders").innerHTML=[...sr].sort((a,b)=>b.runs-a.runs).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+x.runs+" runs</b></p>").join("")||"No matches yet.";$("#bowlLeaders").innerHTML=[...sr].sort((a,b)=>b.wickets-a.wickets).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+x.wickets+" wickets</b></p>").join("")||"No matches yet.";$("#mvpLeaders").innerHTML=[...sr].sort((a,b)=>(b.runs+b.wickets*25)-(a.runs+a.wickets*25)).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+(x.runs+x.wickets*25)+" pts</b></p>").join("")||"No matches yet.";$("#bestTeam").innerHTML=rows[0]?"<h2>"+esc(rows[0].team)+"</h2><p>"+rows[0].pts+" points • NRR "+rows[0].nrr.toFixed(3)+"</p>":"No matches yet."}

window.addEventListener("beforeunload",()=>{try{playerNet?.leave();hostNet?.leave()}catch{}});
renderMyRooms();render();
(async()=>{
  let saved;
  try{saved=JSON.parse(sessionStorage.getItem(SESSION_KEY)||"null")}catch{return}
  if(!saved?.me?.role)return;
  activeHostKey=saved.activeHostKey||null;
  activePlayerCode=saved.activePlayerCode||null;
  const mode=saved.me.role;
  const code=saved.me.roomCode;
  if(mode==="host"){
    const creds=findCreated(code),snap=roomSnapshot(code);
    if(!creds||!snap)return;
    state=snap;activeHostKey=creds.hostKey;activePlayerCode=creds.playerCode;
    setMe({role:"host",ownerId:"host",roomCode:code});
    enterGame();
    try{await connectAsCreator()}catch(e){console.warn("Creator reconnect",e);setNet("NETWORK ERROR")}
  }else if(["guest","owner","member"].includes(mode)&&activePlayerCode){
    setMe({role:"guest",ownerId:null,roomCode:null});
    try{await connectPlayer(activePlayerCode)}catch(e){console.warn("Player reconnect",e);setNet("NETWORK ERROR")}
  }else if(["admin","host-pending"].includes(mode)&&activeHostKey&&code){
    setMe({role:"host-pending",ownerId:null,roomCode:code});
    try{await connectAsRemoteHost(code,activeHostKey)}catch(e){console.warn("Host reconnect",e);setNet("NETWORK ERROR")}
  }
})();
