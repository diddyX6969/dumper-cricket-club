"use strict";
// DCC presentation mode: a reliable same-browser demonstration, not a server-backed multiplayer service.
const DEMO_DELETED_PREFIX="dcc-room-deleted-v1:";
const demoOriginalRender=render;
const demoOriginalPersist=persist;
persist=function(){if(state.room?.code&&localStorage.getItem(DEMO_DELETED_PREFIX+state.room.code))return;demoOriginalPersist()};
const demoOriginalMatch=simulateMatch;
const demoMemberPrefix="dcc-demo-member-v2:";
const demoFormats={
  ipl:["IPL T20 League","ipl",20], "t20-series":["T20 Series","t20",20],
  "odi-series":["ODI Series","odi",50], "t20-world-cup":["T20 World Cup","t20",20],
  "odi-world-cup":["ODI World Cup","odi",50], "test-series":["Test Series","test",90],
  wtc:["World Test Championship","test",90], ashes:["The Ashes","test",90],
  "champions-trophy":["Champions Trophy","odi",50], "asia-cup-t20":["Asia Cup T20","t20",20],
  "asia-cup-odi":["Asia Cup ODI","odi",50], "t10-league":["T10 League","t10",10],
  custom:["Custom Competition","custom",20]
};
const demoRead=(roomId)=>{if(localStorage.getItem(DEMO_DELETED_PREFIX+roomId))return null;const s=roomSnapshot(roomId);return s?.room?.code===roomId?s:null};
function demoToken(code){const k=demoMemberPrefix+code;let t=sessionStorage.getItem(k);if(!t){t=crypto.randomUUID();sessionStorage.setItem(k,t)}return t}
function demoRole(role,ownerId,roomCode){me={role,ownerId:ownerId||null,roomCode};saveSession()}
function demoCommit(){if(!state.room)return;state.updatedAt=Date.now();localStorage.setItem(ROOM_PREFIX+state.room.code,JSON.stringify(state));render()}
function demoWho(){return (state.competitions||[]).find(c=>c.id===state.activeCompetitionId)||null}
connectAsCreator=async function(){setNet("DEMO · LOCAL",true);render()};
joinAsPlayer=async function(){
  const code=$("#playerJoinCodeInput").value.trim().toUpperCase();
  if(!/^[A-Z0-9]{10}$/.test(code)||!/[A-Z]/.test(code)||!/[0-9]/.test(code))return alert("Enter your 10-character Player Joining Code.");
  const room=loadCreated().find(r=>r.playerCode===code);
  const fresh=room&&demoRead(room.roomId);
  if(!fresh)return alert("Room not found on this browser. For the presentation, create the room first and open a second tab to Join Room.");
  activeHostKey=null;activePlayerCode=code;state=migrateState(fresh);
  const f=state.franchises.find(x=>x.memberToken===demoToken(code));
  demoRole(f?"owner":"member",f?.id,room.roomId);
  enterGame();setNet("DEMO · LOCAL",true);
};
joinAsHost=async function(){
  const roomId=$("#hostRoomIdInput").value.trim().toUpperCase(),key=$("#hostKeyInput").value.trim().toUpperCase();
  const saved=findCreated(roomId);
  if(!saved||saved.hostKey!==key)return alert("Invalid Room ID or Host Key for this browser.");
  await openCreatedRoom(roomId);
};
registerFranchise=function(){
  if(me.role!=="member"||!state.room)return alert("Join Room as a player first.");
  const owner=$("#memberOwnerName").value.trim().slice(0,80),team=$("#memberTeamName").value.trim().slice(0,80);
  if(!owner||!team)return alert("Enter your name and franchise name.");
  const fresh=demoRead(state.room.code);
  if(!fresh)return alert("The room has been deleted.");
  const token=demoToken(activePlayerCode);
  if(fresh.franchises.some(f=>f.team.toLowerCase()===team.toLowerCase()&&f.memberToken!==token))return alert("That franchise name is already taken.");
  let f=fresh.franchises.find(x=>x.memberToken===token);
  if(!f){f={id:crypto.randomUUID(),owner,team,purse:fresh.room.startPurse,memberToken:token,joinedAt:Date.now(),online:true};fresh.franchises.push(f)}
  else{f.owner=owner;f.team=team}
  fresh.members??=[];
  let member=fresh.members.find(x=>x.memberToken===token);
  if(!member){member={memberToken:token,joinedAt:Date.now()};fresh.members.push(member)}
  Object.assign(member,{owner,team,ownerId:f.id,online:true,lastSeen:Date.now()});
  fresh.updatedAt=Date.now();localStorage.setItem(ROOM_PREFIX+fresh.room.code,JSON.stringify(fresh));
  state=migrateState(fresh);demoRole("owner",f.id,fresh.room.code);render();
};
sendCommand=function(){
  if(me.role!=="owner"||!state.room)return alert("Only a franchise owner can bid.");
  const fresh=demoRead(state.room.code);
  if(!fresh?.auction.running)return alert("No live auction is running.");
  const f=fresh.franchises.find(x=>x.id===me.ownerId);
  if(!f)return alert("Your team was not found.");
  const a=fresh.auction, next=a.leader?a.bid+10:a.bid;
  if(a.leader===f.id)return;
  if(f.purse<next)return alert("Insufficient team purse.");
  a.bid=next;a.leader=f.id;a.endsAt=Date.now()+15000;
  fresh.feed.unshift("💰 "+f.team+" bids "+money(next));fresh.updatedAt=Date.now();
  localStorage.setItem(ROOM_PREFIX+fresh.room.code,JSON.stringify(fresh));state=migrateState(fresh);render();
};
function preparePresentationDemo(){
  if(me.role!=="host")return alert("Only the creator can prepare a demo.");
  const names=[["Mumbai Mavericks","Demo Owner A"],["Chennai Challengers","Demo Owner B"]];
  const teams=names.map(([team,owner])=>{
    let f=state.franchises.find(x=>x.team===team);
    if(!f){f={id:crypto.randomUUID(),team,owner,purse:state.room.startPurse,joinedAt:Date.now(),online:false,demo:true};state.franchises.push(f)}
    return f;
  });
  for(const f of teams){
    const owned=state.players.filter(p=>p.active&&p.owner===f.id).length;
    for(const p of state.players.filter(p=>p.active&&!p.owner).slice(0,Math.max(0,11-owned))){
      p.owner=f.id;p.soldPrice=p.basePrice;f.purse=Math.max(0,f.purse-p.basePrice);
    }
  }
  state.feed.unshift("Presentation teams prepared. You can run a match or demonstrate an auction.");
  persist();
  $("#teamA").value=teams[0].id;$("#teamB").value=teams[1].id;
  $("#xiA").value=state.players.filter(p=>p.owner===teams[0].id&&p.active).slice(0,11).map(p=>p.name).join("\n");
  $("#xiB").value=state.players.filter(p=>p.owner===teams[1].id&&p.active).slice(0,11).map(p=>p.name).join("\n");
  chooseSeriesPreset();tab("auction");
}
function demoPlaceBid(i){
  if(!hostOnly())return;
  if(!state.auction.running)return alert("Start an auction before demonstrating a bid.");
  const f=state.franchises[i];if(f)processBid(f.id);
}
function chooseSeriesPreset(){
  const p=demoFormats[$("#seriesPreset")?.value]||demoFormats.ipl;
  $("#seriesName").value=p[0];$("#seriesOvers").value=p[2];
  $("#seriesHelp").textContent="Classroom format demonstration; Test matches use a simplified single-innings simulation.";
}
function createCompetition(){
  if(!hostOnly())return;
  const id=$("#seriesPreset").value,p=demoFormats[id]||demoFormats.ipl;
  const c={id:crypto.randomUUID(),name:$("#seriesName").value.trim()||p[0],preset:id,format:p[1],overs:Math.max(1,Number(id==="custom"?$("#seriesOvers").value:p[2])||20),games:Math.max(1,Math.min(30,Number($("#seriesMatches").value)||1)),fixtures:[],createdAt:Date.now()};
  state.competitions??=[];state.competitions.push(c);state.activeCompetitionId=c.id;
  $("#format").value=c.format;if(c.format==="custom")$("#customOvers").value=c.overs;
  formatChanged();persist();
}
function activateCompetition(id){
  if(!hostOnly())return;const c=(state.competitions||[]).find(x=>x.id===id);
  if(!c)return;state.activeCompetitionId=c.id;
  $("#format").value=c.format;if(c.format==="custom")$("#customOvers").value=c.overs;
  formatChanged();persist();
}
function generateCompetitionFixtures(){
  if(!hostOnly())return;
  let c=demoWho();if(!c){createCompetition();c=demoWho()}
  if(state.franchises.length<2)return alert("Prepare or register at least two teams first.");
  c.fixtures=[];
  for(let i=0;i<state.franchises.length;i++)for(let j=i+1;j<state.franchises.length;j++)
    for(let k=0;k<c.games;k++)c.fixtures.push({a:state.franchises[i].id,b:state.franchises[j].id,matchId:null});
  persist();
}
function demoRenderCompetition(){
  const c=demoWho(), host=me.role==="host"||me.role==="admin";
  $("#competitionHostSetup")?.classList.toggle("hidden",!host);
  $("#presentationDemo")?.classList.toggle("hidden",me.role!=="host");
  $("#hostPlayerMonitor")?.classList.toggle("hidden",!host);
  $("#offlineNotice")?.classList.add("hidden");
  if(!state.room)return;
  const active=(state.competitions||[]);
  const sel=$("#activeSeriesSelect");
  if(sel&&host){sel.innerHTML=active.map(x=>"<option value='"+x.id+"'>"+esc(x.name)+"</option>").join("");sel.value=c?.id||""}
  $("#competitionStatus").textContent=c?c.name:"No series selected";
  $("#competitionSummary").textContent=c?c.name+" • "+c.format.toUpperCase()+" • "+c.overs+" overs • "+(state.matches||[]).filter(m=>m.competitionId===c.id).length+" matches played":"The host can choose T20, ODI, World Cup, Test or custom competitions.";
  const fixtures=c?.fixtures||[];
  $("#fixtureBoard").innerHTML=fixtures.length?"<h4>Fixtures</h4>"+fixtures.slice(0,20).map((f,i)=>"<div class='demo-fixture'>"+(i+1)+". "+esc(ownerBy(f.a)?.team||"Team A")+" vs "+esc(ownerBy(f.b)?.team||"Team B")+" · "+(f.matchId?"Completed":"Upcoming")+"</div>").join(""):"";
  const seriesMatches=state.matches.filter(m=>m.competitionId===c?.id);
  const rows=state.franchises.map(f=>({f,played:seriesMatches.filter(m=>m.a===f.id||m.b===f.id).length,wins:seriesMatches.filter(m=>m.winner===f.id).length})).sort((a,b)=>b.wins-a.wins||b.played-a.played);
  $("#seriesStandings").innerHTML=c?rows.map((r,i)=>"<p>"+(i+1)+". "+esc(r.f.team)+" — "+r.wins+" wins / "+r.played+" played</p>").join(""):"No competition selected.";
  if(host){
    const players=state.members||[];
    $("#joinedCount").textContent=players.length+" joined";
    $("#joinedOnlineCount").textContent=players.filter(x=>x.online).length+" recently connected · "+state.franchises.length+" teams registered";
    $("#playerJoinList").innerHTML=players.map((x,i)=>"<div class='demo-fixture'>"+(i+1)+". "+esc(x.owner||"Pending setup")+" · "+esc(x.team||"Not assigned")+"</div>").join("")||"<p class='muted'>No players joined yet.</p>";
  }
}
render=function(){demoOriginalRender();demoRenderCompetition()};
simulateMatch=function(){
  const before=state.matches.length;
  const c=demoWho();
  if(c){$("#format").value=c.format;if(c.format==="custom")$("#customOvers").value=c.overs;formatChanged()}
  demoOriginalMatch();
  if(state.matches.length>before&&c){
    const match=state.matches.at(-1);match.competitionId=c.id;
    const fixture=(c.fixtures||[]).find(f=>!f.matchId&&((f.a===match.a&&f.b===match.b)||(f.b===match.a&&f.a===match.b)));
    if(fixture)fixture.matchId=match.id;
    persist();
  }
};
window.addEventListener("storage",(e)=>{
  if(e.key?.startsWith(DEMO_DELETED_PREFIX)&&e.newValue){
    const deletedRoom=e.key.slice(DEMO_DELETED_PREFIX.length);
    if(state.room?.code===deletedRoom){
      logoutRoom().catch(console.warn);
    }else{
      renderMyRooms();
    }
    return;
  }
  const roomId=state.room?.code;
  if(!roomId||e.key!==ROOM_PREFIX+roomId||!e.newValue)return;
  if(localStorage.getItem(DEMO_DELETED_PREFIX+roomId))return;
  const updated=demoRead(roomId);
  if(!updated)return;
  state=migrateState(updated);render();
});
async function deleteSavedRoom(code){
  const roomId=String(code||"").trim().toUpperCase();
  const saved=findCreated(roomId);
  if(!saved){renderMyRooms();return alert("This room is not in Your Created Rooms on this browser.");}
  if(!confirm("Permanently delete room "+roomId+" and all its saved squads, auction, matches and login codes from this browser?"))return false;

  const wasCurrent=state.room?.code===roomId;
  // Tombstone first. Other open tabs must exit and must never recreate deleted state.
  localStorage.setItem(DEMO_DELETED_PREFIX+roomId,String(Date.now()));
  saveCreated(loadCreated().filter(r=>r.roomId!==roomId));
  localStorage.removeItem(ROOM_PREFIX+roomId);
  localStorage.removeItem(OFFLINE_CACHE_PREFIX+saved.playerCode);
  localStorage.removeItem(MEMBER_PREFIX+saved.playerCode);

  if(wasCurrent){
    await logoutRoom();
  }else{
    renderMyRooms();
  }
  return true;
}
async function deleteCurrentRoom(){
  if(me.role!=="host"||!state.room?.code)return alert("Only the room creator can delete this room.");
  return deleteSavedRoom(state.room.code);
}
async function factoryReset(){return deleteCurrentRoom()}
(async function restorePresentationSession(){
  try{
    const saved=JSON.parse(sessionStorage.getItem(SESSION_KEY)||"null");
    if(!saved?.me?.roomCode)return;
    const code=saved.me.roomCode;
    if(saved.me.role==="host"){
      const creds=findCreated(code),snapshot=demoRead(code);
      if(!creds||!snapshot)return;
      state=migrateState(snapshot);activeHostKey=creds.hostKey;activePlayerCode=creds.playerCode;
      demoRole("host","host",code);enterGame();setNet("DEMO · LOCAL",true);
    }else if(["member","owner"].includes(saved.me.role)){
      const room=demoRead(code);if(!room)return;
      state=migrateState(room);activePlayerCode=saved.activePlayerCode;
      demoRole(saved.me.role,saved.me.ownerId,code);enterGame();setNet("DEMO · LOCAL",true);
    }
  }catch(e){console.warn("Demo session restore",e)}
})();
