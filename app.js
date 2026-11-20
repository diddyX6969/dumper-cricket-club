
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const ROOM_INDEX_KEY="dcc-room-index-v6";
const ROOM_STATE_PREFIX="dcc-room-state-v6:";
const MEMBER_TOKEN_PREFIX="dcc-member-v6:";
let state=blankState();
let me=JSON.parse(sessionStorage.getItem("dcc-me-v6")||'{"role":null,"ownerId":null}');
let activeRoomKey=sessionStorage.getItem("dcc-active-key-v6")||null;
let timerHandle=null,netRoom=null,joinAction=null,replyAction=null,commandAction=null,stateAction=null,hostUserId=null,networkSelfId=null;

function blankState(){return {room:null,players:structuredClone(PLAYER_SEED),franchises:[],auction:{playerId:null,bid:0,leader:null,running:false,endsAt:0},feed:[],pitch:null,toss:null,matches:[],stats:{},updatedAt:Date.now(),version:6}}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function money(v){v=Number(v||0);return v>=100?"₹"+(v/100).toFixed(v%100?2:0)+" Cr":"₹"+v+" L"}
async function sha256(v){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(v)));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("")}
function randomCode(n=6){const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";const a=new Uint32Array(n);crypto.getRandomValues(a);return [...a].map(v=>chars[v%chars.length]).join("")}
function newRoomId(){return "DCC-"+randomCode(6)}
function normalizeRoomId(v){return String(v||"").trim().toUpperCase()}
function normalizeKey(v){return String(v||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"")}
function getRoomIndex(){try{return JSON.parse(localStorage.getItem(ROOM_INDEX_KEY)||"[]")}catch{return []}}
function setRoomIndex(rows){localStorage.setItem(ROOM_INDEX_KEY,JSON.stringify(rows))}
function upsertRoomIndex(entry){const rows=getRoomIndex();const i=rows.findIndex(x=>x.code===entry.code);if(i>=0)rows[i]={...rows[i],...entry};else rows.unshift(entry);setRoomIndex(rows)}
function roomStateKey(code){return ROOM_STATE_PREFIX+code}
function saveRoomSnapshot(){if(state.room?.code)localStorage.setItem(roomStateKey(state.room.code),JSON.stringify(state))}
function loadRoomSnapshot(code){try{const v=JSON.parse(localStorage.getItem(roomStateKey(code))||"null");return v&&v.room?migrateState(v):null}catch{return null}}
function migrateState(s){
  if(!s||!Array.isArray(s.players))return blankState();
  const byName=new Map(s.players.map(p=>[String(p.name||"").toLowerCase(),p]));
  for(const seed of PLAYER_SEED){
    const key=seed.name.toLowerCase(),existing=byName.get(key);
    if(existing){
      if(existing.status==null)existing.status=seed.status;
      if(existing.sourceTeam==null)existing.sourceTeam=seed.sourceTeam;
      if(existing.previousSalary==null)existing.previousSalary=seed.previousSalary;
    }else s.players.push(structuredClone(seed));
  }
  s.version=6;return s;
}
function memberToken(roomCode){
  const k=MEMBER_TOKEN_PREFIX+roomCode;
  let t=localStorage.getItem(k);if(!t){t=crypto.randomUUID();localStorage.setItem(k,t)}return t
}
function setMe(v){me=v;sessionStorage.setItem("dcc-me-v6",JSON.stringify(v))}
function saveSession(){sessionStorage.setItem("dcc-me-v6",JSON.stringify(me));if(activeRoomKey)sessionStorage.setItem("dcc-active-key-v6",activeRoomKey);else sessionStorage.removeItem("dcc-active-key-v6")}
function showCreate(){$("#createBox")?.classList.remove("hidden");$("#joinBox")?.classList.add("hidden")}
function showJoin(){$("#joinBox")?.classList.remove("hidden");$("#createBox")?.classList.add("hidden")}
function tab(id){$$(".panel").forEach(x=>x.classList.toggle("active",x.id===id))}
function enterGame(){$("#landing")?.classList.remove("active");$("#game")?.classList.add("active");$("#logoutBtn")?.classList.remove("hidden");render()}
function hostOnly(){if(me.role!=="host"){alert("Only the room creator can use this control.");return false}return true}
function ownerBy(id){return state.franchises.find(f=>f.id===id)}
function currentPlayer(){return state.players.find(p=>p.id===state.auction.playerId)}
function availablePlayers(){return state.players.filter(p=>p.active&&p.owner===null)}
function publicState(){const out=structuredClone(state);if(out.room)delete out.room.keyHash;return out}
function persist(){
  state.updatedAt=Date.now();saveRoomSnapshot();saveSession();
  if(me.role==="host"&&stateAction)stateAction.send(publicState()).catch(()=>{});
  render();
}
function setNet(text,ok=false){const el=$("#netBadge");if(!el)return;el.textContent=text;el.classList.toggle("online",ok)}

function renderMyRooms(){
  const card=$("#myRoomsCard"),el=$("#myRooms");if(!card||!el)return;
  const rooms=getRoomIndex();
  card.classList.toggle("hidden",rooms.length===0);
  el.innerHTML=rooms.map(r=>"<div class='roomCard'><div><b>"+esc(r.code)+"</b><span>"+esc(r.hostName||"Host")+" • Key "+esc(r.key)+"</span></div><div class='actions'><button onclick=\"openCreatedRoom('"+r.code+"')\">Open</button><button class='danger' onclick=\"forgetCreatedRoom('"+r.code+"')\">Forget</button></div></div>").join("");
}
async function openCreatedRoom(code){
  const meta=getRoomIndex().find(x=>x.code===code);const snap=loadRoomSnapshot(code);
  if(!meta||!snap)return alert("This room's saved data is not available on this device.");
  state=snap;activeRoomKey=meta.key;setMe({role:"host",ownerId:"host",roomCode:code});saveSession();enterGame();
  await connectNetwork(code,meta.key,true);if(state.auction.running)runTimer();
}
function forgetCreatedRoom(code){
  const rows=getRoomIndex().filter(x=>x.code!==code);setRoomIndex(rows);localStorage.removeItem(roomStateKey(code));renderMyRooms();
}

async function connectNetwork(roomCode,roomKey,isHost){
  setNet("CONNECTING");
  try{
    const {joinRoom}=await import("https://esm.run/trystero");
    if(netRoom)try{await netRoom.leave()}catch{}
    const networkPassword=await sha256(roomCode+":"+roomKey);
    netRoom=joinRoom({appId:"diddyx6969/dumper-cricket-club-v6",password:networkPassword,identity:"none"},roomCode);
    const self=await netRoom.getSelf();networkSelfId=self.userId;
    joinAction=netRoom.makeAction("dcc-login");
    replyAction=netRoom.makeAction("dcc-reply");
    commandAction=netRoom.makeAction("dcc-command");
    stateAction=netRoom.makeAction("dcc-state");

    joinAction.onMessage((data,ctx)=>{if(me.role==="host")handleJoinRequest(data,ctx.userId)});
    replyAction.onMessage((data,ctx)=>{
      if(me.role==="host")return;
      if(!data?.ok){if(data?.error)alert(data.error);return;}
      hostUserId=ctx.userId;state=migrateState(data.state);saveRoomSnapshot();
      if(data.ownerId)setMe({role:"owner",ownerId:data.ownerId,roomCode});
      else setMe({role:"member",ownerId:null,roomCode});
      saveSession();setNet("CONNECTED",true);enterGame();
    });
    commandAction.onMessage((data,ctx)=>{if(me.role==="host")handleRemoteCommand(data,ctx.userId)});
    stateAction.onMessage((incoming,ctx)=>{
      if(me.role==="host")return;if(hostUserId&&ctx.userId!==hostUserId)return;
      hostUserId=ctx.userId;state=migrateState(incoming);saveRoomSnapshot();render();
    });
    netRoom.onUserLeave(({userId})=>{
      if(me.role!=="host")return;
      const f=state.franchises.find(x=>x.userId===userId);if(f){f.online=false;state.feed.unshift(f.team+" disconnected.");persist()}
    });
    netRoom.onError(err=>{console.warn(err);setNet("NETWORK ISSUE")});
    if(isHost){
      hostUserId=self.userId;state.room.hostUserId=self.userId;setNet("HOST ONLINE",true);persist();
    }else setNet("FINDING ROOM");
    return true;
  }catch(e){console.error(e);setNet("NETWORK ERROR");alert("Could not connect to the room network. Check your internet connection.");return false}
}

async function createRoom(){
  const hostName=($("#hostName")?.value||"").trim()||"Host";
  const purse=Math.max(1,Number($("#startPurse")?.value||120))*100;
  let code;do{code=newRoomId()}while(getRoomIndex().some(x=>x.code===code));
  const key=randomCode(6);
  state=blankState();state.room={code,hostName,startPurse:purse,createdAt:Date.now(),keyHash:await sha256(key)};
  activeRoomKey=key;upsertRoomIndex({code,key,hostName,createdAt:state.room.createdAt});
  setMe({role:"host",ownerId:"host",roomCode:code});saveRoomSnapshot();saveSession();enterGame();
  await connectNetwork(code,key,true);
}

async function joinRoom(){
  const roomCode=normalizeRoomId($("#joinCode")?.value),key=normalizeKey($("#roomKeyInput")?.value);
  if(!/^DCC-[A-Z0-9]{6}$/.test(roomCode))return alert("Enter a valid Room ID, for example DCC-A7K9P2.");
  if(!/^[A-Z0-9]{6}$/.test(key))return alert("Room Key must be exactly 6 letters/numbers.");
  state=blankState();state.room={code:roomCode,hostName:"",startPurse:0,createdAt:0};
  activeRoomKey=key;setMe({role:"guest",ownerId:null,roomCode});saveSession();
  const ok=await connectNetwork(roomCode,key,false);if(!ok)return;
  const keyHash=await sha256(key);
  await joinAction.send({roomCode,keyHash,memberToken:memberToken(roomCode)});
  setTimeout(()=>{if(me.role==="guest")alert("Room not found. Check the Room ID and Room Key, and make sure the creator has the room open.")},8000);
}

async function handleJoinRequest(data,userId){
  if(!state.room||data.roomCode!==state.room.code)return;
  if(!data.keyHash||data.keyHash!==state.room.keyHash)return;
  const existing=state.franchises.find(x=>x.memberToken===data.memberToken);
  if(existing){existing.userId=userId;existing.online=true;persist();replyAction.send({ok:true,ownerId:existing.id,state:publicState()},{target:userId});return}
  replyAction.send({ok:true,ownerId:null,state:publicState()},{target:userId});
}

function registerFranchise(){
  if(me.role!=="member")return;
  const owner=($("#memberOwnerName")?.value||"").trim(),team=($("#memberTeamName")?.value||"").trim();
  if(!owner||!team)return alert("Enter your name and franchise name.");
  if(!commandAction||!hostUserId)return alert("Not connected to the room creator.");
  commandAction.send({type:"register",owner,team,memberToken:memberToken(state.room.code)},{target:hostUserId});
}
function handleRemoteCommand(data,userId){
  if(data.type==="register"){
    const owner=String(data.owner||"").trim(),team=String(data.team||"").trim();
    if(!owner||!team||!data.memberToken)return;
    if(state.franchises.some(x=>x.team.toLowerCase()===team.toLowerCase())){replyAction.send({ok:false,error:"Team name already exists"},{target:userId});return}
    let f=state.franchises.find(x=>x.memberToken===data.memberToken);
    if(!f){f={id:crypto.randomUUID(),memberToken:data.memberToken,owner,team,purse:state.room.startPurse,userId,online:true,joinedAt:Date.now()};state.franchises.push(f)}
    else{f.owner=owner;f.team=team;f.userId=userId;f.online=true}
    state.feed.unshift("🏏 "+f.team+" joined the room.");persist();
    replyAction.send({ok:true,ownerId:f.id,state:publicState()},{target:userId});return;
  }
  const f=state.franchises.find(x=>x.id===data.ownerId&&x.userId===userId);if(!f)return;
  if(data.type==="bid")processBid(f.id);
}
function sendCommand(data){if(!commandAction||!hostUserId)return alert("Not connected to the room creator.");commandAction.send({...data,ownerId:me.ownerId},{target:hostUserId})}

function copyRoom(){navigator.clipboard?.writeText(state.room?.code||"")}
function copyRoomInvite(){
  if(!hostOnly())return;
  const meta=getRoomIndex().find(x=>x.code===state.room.code),key=meta?.key||activeRoomKey||"";
  navigator.clipboard?.writeText("Room ID: "+state.room.code+"\nRoom Key: "+key);
}
async function rotateRoomKey(){
  if(!hostOnly())return;
  if(!confirm("Generate a new Room Key? Connected players will need to join again with the new key."))return;
  const key=randomCode(6);state.room.keyHash=await sha256(key);activeRoomKey=key;
  upsertRoomIndex({code:state.room.code,key,hostName:state.room.hostName,createdAt:state.room.createdAt});
  saveRoomSnapshot();saveSession();await connectNetwork(state.room.code,key,true);render();
}
async function logoutRoom(){
  try{await netRoom?.leave()}catch{} netRoom=null;hostUserId=null;networkSelfId=null;
  state=blankState();activeRoomKey=null;sessionStorage.removeItem("dcc-me-v6");sessionStorage.removeItem("dcc-active-key-v6");setMe({role:null,ownerId:null});
  $("#game")?.classList.remove("active");$("#landing")?.classList.add("active");$("#logoutBtn")?.classList.add("hidden");setNet("OFFLINE");renderMyRooms();
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

function exportLeague(){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:"application/json"}));a.download=(state.room?.code||"dcc")+"-league.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function importLeague(e){if(!hostOnly())return;const file=e.target.files?.[0];if(!file)return;file.text().then(t=>{const d=JSON.parse(t);if(!d.players||!d.franchises||!d.matches)throw 0;state=d;persist()}).catch(()=>alert("Invalid DCC league file."))}
function factoryReset(){if(!hostOnly())return;if(!confirm("Delete this room from this creator device? This cannot be undone unless you exported it."))return;const code=state.room?.code;setRoomIndex(getRoomIndex().filter(x=>x.code!==code));if(code)localStorage.removeItem(roomStateKey(code));sessionStorage.removeItem("dcc-me-v6");sessionStorage.removeItem("dcc-active-key-v6");location.reload()}

function render(){
  $("#roomBadge").textContent=state.room?.code||"NO ROOM";
  $("#logoutBtn")?.classList.toggle("hidden",!["host","owner","member","guest"].includes(me.role));
  const isHost=me.role==="host";
  $("#adminTab")?.classList.toggle("hidden",!isHost);
  $("#auctionHostControls")?.classList.toggle("hidden",!isHost);
  $("#ownerBidBtn")?.classList.toggle("hidden",me.role!=="owner");
  $("#memberSetupCard")?.classList.toggle("hidden",me.role!=="member");
  if(!state.room){renderMyRooms();return}
  $("#roomTitle").textContent=state.room.code;
  const meta=getRoomIndex().find(x=>x.code===state.room.code);
  const key=isHost?(meta?.key||activeRoomKey):null;
  $("#roomInfo").innerHTML="Creator: <b>"+esc(state.room.hostName||"Host")+"</b><br>Starting purse: <b>"+money(state.room.startPurse)+"</b>"+(isHost&&key?"<br>Room Key: <b>"+esc(key)+"</b>":"");
  $("#franchiseList").innerHTML=state.franchises.map(f=>"<div class='teamCard'><div class='row-between'><h4>"+esc(f.team)+"</h4><span class='dot "+(f.online?"on":"")+"'></span></div><div>"+esc(f.owner)+"</div><div class='money'>"+money(f.purse)+"</div></div>").join("")||"<span class='muted'>Waiting for franchise owners.</span>";
  const sold=state.players.filter(p=>p.owner).length;
  $("#leaguePulse").innerHTML="<div><b>"+state.franchises.length+"</b><span>Teams</span></div><div><b>"+sold+"</b><span>Players sold</span></div><div><b>"+state.matches.length+"</b><span>Matches</span></div><div><b>"+state.players.filter(p=>p.active).length+"</b><span>Player pool</span></div><div><b>"+availablePlayers().length+"</b><span>Available</span></div>";
  $("#soldCounter").textContent=sold+" sold • "+availablePlayers().length+" available";
  if(isHost){
    const rid=$("#adminRoomId"),rkey=$("#adminRoomKey");if(rid)rid.textContent=state.room.code;if(rkey)rkey.textContent=key||"—";
  }
  renderAuctionSelect();renderAuction();renderSquads();renderTeamSelects();if(isHost)renderAdmin();renderStandings();if(state.matches.length)renderMatch(state.matches.at(-1));
}function renderAuction(){const p=currentPlayer();$("#aName").textContent=p?.name||"Choose a player";$("#aMeta").textContent=p?((p.status==="released"?"FREE AGENT • Released by "+p.sourceTeam:p.iplTeam+" • Retained")+" • "+p.role+" • Base "+money(p.basePrice)):"";$("#aBid").textContent=state.auction.bid?money(state.auction.bid):"—";$("#aLeader").textContent=state.auction.leader?(ownerBy(state.auction.leader)?.team||"Unknown")+" leads":"No bids";$("#aTimer").textContent=state.auction.running?Math.max(0,Math.ceil((state.auction.endsAt-Date.now())/1000)):"—";$("#auctionFeed").innerHTML=state.feed.slice(0,100).map(x=>"<div>"+esc(x)+"</div>").join("")||"<span class='muted'>Auction has not started.</span>"}
function renderSquads(){$("#squadGrid").innerHTML=state.franchises.map(f=>{const sq=state.players.filter(p=>p.owner===f.id&&p.active);return "<div class='teamCard'><h4>"+esc(f.team)+"</h4><div class='money'>"+money(f.purse)+" left</div><p>"+sq.length+" players</p><ol>"+sq.map(p=>"<li>"+esc(p.name)+" <span class='muted'>"+money(p.soldPrice)+" • "+p.role+"</span></li>").join("")+"</ol></div>"}).join("")||"<span class='muted'>No squads yet.</span>"}
function renderTeamSelects(){const opts=state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");for(const id of ["teamA","teamB"]){const el=$("#"+id);if(!el)continue;const old=el.value;el.innerHTML=opts;if([...el.options].some(o=>o.value===old))el.value=old}$("#pitchBox").textContent=state.pitch?state.pitch.name+" — "+state.pitch.desc:"No pitch generated.";$("#tossBox").textContent=state.toss?(ownerBy(state.toss.winner)?.team+" won the toss and chose to "+state.toss.choice):"Toss not conducted."}
function renderAdmin(){const psel=$("#editPlayer"),oldp=psel.value;psel.innerHTML=state.players.filter(p=>p.active).map(p=>"<option value='"+p.id+"'>"+esc(p.name)+"</option>").join("");if([...psel.options].some(o=>o.value===oldp))psel.value=oldp;const teams="<option value=''>Unassigned</option>"+state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");$("#assignTeam").innerHTML=teams;const tsel=$("#adminTeam"),oldt=tsel.value;tsel.innerHTML=state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");if([...tsel.options].some(o=>o.value===oldt))tsel.value=oldt;loadPlayerEditor();loadTeamEditor()}
function renderMatch(m){const a=ownerBy(m.a),b=ownerBy(m.b);if(!a||!b)return;$("#scoreboard").innerHTML="<div class='scoreline'><span>"+esc(a.team)+"</span><b>"+m.i1.runs+"/"+m.i1.wickets+"</b><small>"+(m.i1.balls/6).toFixed(1)+" ov</small></div><div class='scoreline'><span>"+esc(b.team)+"</span><b>"+m.i2.runs+"/"+m.i2.wickets+"</b><small>"+(m.i2.balls/6).toFixed(1)+" ov</small></div><p class='muted'>"+esc(m.pitch)+"</p>";$("#matchResult").textContent=m.tied?"TIED":(ownerBy(m.winner)?.team||"")+" WON";$("#commentary").innerHTML=m.i1.events.concat(m.i2.events).slice(-100).map(x=>"<div>"+esc(x)+"</div>").join("");$("#advice").innerHTML="<div class='notice'><b>Brutal review:</b> "+esc(roastFor(m))+"</div><div class='notice'><b>Improvement:</b> "+esc(adviceFor(m))+"</div>"}
function renderStandings(){const rows=standings();$("#pointsBody").innerHTML=rows.map((r,i)=>"<tr><td>"+(i+1)+"</td><td>"+esc(r.team)+"</td><td>"+r.P+"</td><td>"+r.W+"</td><td>"+r.L+"</td><td>"+r.T+"</td><td>"+r.NR+"</td><td><b>"+r.pts+"</b></td><td>"+r.nrr.toFixed(3)+"</td></tr>").join("");const sr=Object.entries(state.stats).map(([id,s])=>({p:state.players.find(x=>x.id===id),...s})).filter(x=>x.p);$("#batLeaders").innerHTML=[...sr].sort((a,b)=>b.runs-a.runs).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+x.runs+" runs</b></p>").join("")||"No matches yet.";$("#bowlLeaders").innerHTML=[...sr].sort((a,b)=>b.wickets-a.wickets).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+x.wickets+" wickets</b></p>").join("")||"No matches yet.";$("#mvpLeaders").innerHTML=[...sr].sort((a,b)=>(b.runs+b.wickets*25)-(a.runs+a.wickets*25)).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+(x.runs+x.wickets*25)+" pts</b></p>").join("")||"No matches yet.";$("#bestTeam").innerHTML=rows[0]?"<h2>"+esc(rows[0].team)+"</h2><p>"+rows[0].pts+" points • NRR "+rows[0].nrr.toFixed(3)+"</p>":"No matches yet."}

window.addEventListener("beforeunload",()=>{try{netRoom?.leave()}catch{}});
renderMyRooms();render();

(async()=>{
  const roomCode=me.roomCode;
  if(!roomCode)return;
  if(me.role==="host"){
    const meta=getRoomIndex().find(x=>x.code===roomCode),snap=loadRoomSnapshot(roomCode);
    if(!meta||!snap){setMe({role:null,ownerId:null});return}
    state=snap;activeRoomKey=meta.key;saveSession();enterGame();
    await connectNetwork(roomCode,meta.key,true);if(state.auction.running)runTimer();
    return;
  }
  if(["owner","member","guest"].includes(me.role)&&activeRoomKey){
    state=loadRoomSnapshot(roomCode)||blankState();
    if(!state.room)state.room={code:roomCode,hostName:"",startPurse:0,createdAt:0};
    enterGame();
    const ok=await connectNetwork(roomCode,activeRoomKey,false);if(!ok)return;
    await joinAction.send({roomCode,keyHash:await sha256(activeRoomKey),memberToken:memberToken(roomCode)});
  }
})();
