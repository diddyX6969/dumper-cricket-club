
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let state=loadState(), me=JSON.parse(sessionStorage.getItem("dcc-me")||'{"role":null,"ownerId":null}');
let timerHandle=null, netRoom=null, joinAction=null, replyAction=null, commandAction=null, stateAction=null, hostUserId=null;


function blankState(){return {room:null,players:structuredClone(PLAYER_SEED),franchises:[],auction:{playerId:null,bid:0,leader:null,running:false,endsAt:0},feed:[],pitch:null,toss:null,matches:[],stats:{},updatedAt:Date.now(),version:3}}
function loadState(){try{return JSON.parse(localStorage.getItem("dcc-state-v3"))||blankState()}catch{return blankState()}}
function saveLocal(){localStorage.setItem("dcc-state-v3",JSON.stringify(state));sessionStorage.setItem("dcc-me",JSON.stringify(me))}
function setMe(v){me=v;sessionStorage.setItem("dcc-me",JSON.stringify(v))}
function enc(s){return btoa(unescape(encodeURIComponent(String(s))))}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function money(v){v=Number(v||0);return v>=100?"₹"+(v/100).toFixed(v%100?2:0)+" Cr":"₹"+v+" L"}
function code(){return "DCC-"+Math.random().toString(36).slice(2,7).toUpperCase()}
function showCreate(){$("#createBox").classList.remove("hidden");$("#joinBox").classList.add("hidden")}
function showJoin(){$("#joinBox").classList.remove("hidden");$("#createBox").classList.add("hidden")}
function tab(id){$$(".panel").forEach(x=>x.classList.toggle("active",x.id===id))}
function enterGame(){$("#landing").classList.remove("active");$("#game").classList.add("active");$("#logoutBtn")?.classList.remove("hidden");render()}
function hostOnly(){if(!["host","owner"].includes(me.role)){alert("Join the room first.");return false}return true}
function ownerBy(id){return state.franchises.find(f=>f.id===id)}
function currentPlayer(){return state.players.find(p=>p.id===state.auction.playerId)}
function availablePlayers(){return state.players.filter(p=>p.active&&p.owner===null)}
function publicState(){const s=structuredClone(state);if(s.room)delete s.room.hostPass;s.franchises=s.franchises.map(({passHash,...x})=>x);return s}
function persist(){state.updatedAt=Date.now();saveLocal();if(me.role==="host"&&stateAction){stateAction.send(publicState()).catch(()=>{})}else if(me.role==="owner"&&commandAction&&hostUserId){commandAction.send({type:"replaceState",ownerId:me.ownerId,state:publicState()},{target:hostUserId}).catch(()=>{})}render()}
function setNet(text,ok=false){const el=$("#netBadge");if(!el)return;el.textContent=text;el.classList.toggle("online",ok)}

async function connectNetwork(roomCode,isHost){
  setNet("CONNECTING");
  try{
    const {joinRoom}=await import("https://esm.run/trystero");
    if(netRoom)try{await netRoom.leave()}catch{}
    netRoom=joinRoom({appId:"diddyx6969/dumper-cricket-club-v3",password:roomCode,identity:"none"},roomCode);
    const self=await netRoom.getSelf();
    joinAction=netRoom.makeAction("dcc-join");
    replyAction=netRoom.makeAction("dcc-reply");
    commandAction=netRoom.makeAction("dcc-cmd");
    stateAction=netRoom.makeAction("dcc-state");

    joinAction.onMessage((data,ctx)=>{if(me.role==="host")handleJoinRequest(data,ctx.userId)});
    replyAction.onMessage((data,ctx)=>{
      if(me.role==="host"||!data?.ok)return;
      hostUserId=ctx.userId;
      state=data.state;
      setMe({role:"owner",ownerId:data.ownerId,loginId:data.loginId});
      saveLocal();setNet("CONNECTED",true);enterGame();
    });
    commandAction.onMessage((data,ctx)=>{if(me.role==="host")handleRemoteCommand(data,ctx.userId)});
    stateAction.onMessage((incoming,ctx)=>{
      if(me.role==="host")return;
      if(hostUserId&&ctx.userId!==hostUserId)return;
      hostUserId=ctx.userId;state=incoming;saveLocal();render();
    });
    netRoom.onUserJoin(({userId})=>{if(me.role==="host"){setNet("ONLINE",true);state.feed.unshift("A player connected to the room.");persist()}});
    netRoom.onUserLeave(({userId})=>{if(me.role==="host"){const f=state.franchises.find(x=>x.userId===userId);if(f)state.feed.unshift(f.team+" disconnected.");persist()}});
    netRoom.onError(err=>{console.warn(err);setNet("NETWORK ISSUE")});
    if(isHost){
      hostUserId=self.userId;
      state.room.hostUserId=self.userId;
      setNet("HOST ONLINE",true);
      persist();
    }else{
      setNet("FINDING HOST");
    }
    return true;
  }catch(e){console.error(e);setNet("NETWORK ERROR");alert("Could not start peer networking. Check internet access and reload.");return false}
}

async function createRoom(){
  const name=$("#hostName").value.trim(),id=$("#hostId").value.trim(),pass=$("#hostPass").value;
  if(!name||!id||!pass)return alert("Enter host name, ID and password.");
  state=blankState();
  state.room={code:code(),hostName:name,hostId:id,hostPass:enc(pass),startPurse:Math.max(1,Number($("#startPurse").value||120))*100,createdAt:Date.now()};
  setMe({role:"host",ownerId:"host"});
  saveLocal();enterGame();
  await connectNetwork(state.room.code,true);
}

async function joinRoom(){
  const req={roomCode:$("#joinCode").value.trim().toUpperCase(),loginId:$("#joinId").value.trim(),password:$("#joinPass").value,owner:$("#ownerName").value.trim(),team:$("#teamName").value.trim()};
  if(!req.roomCode||!req.loginId||!req.password||!req.owner||!req.team)return alert("Complete all join fields.");
  setMe({role:"guest",ownerId:null});
  const ok=await connectNetwork(req.roomCode,false);if(!ok)return;
  await joinAction.send(req);
  setTimeout(()=>{if(me.role==="guest")alert("Host not found yet. Check the room code and make sure the host page is open.")},8000);
}

function handleJoinRequest(data,userId){
  if(!state.room||data.roomCode!==state.room.code)return;
  let f=state.franchises.find(x=>x.loginId.toLowerCase()===data.loginId.toLowerCase());
  if(f){
    if(f.passHash!==enc(data.password)){replyAction.send({ok:false,error:"Wrong password"},{target:userId});return}
    f.userId=userId;f.online=true;
  }else{
    if(state.franchises.some(x=>x.team.toLowerCase()===data.team.toLowerCase())){replyAction.send({ok:false,error:"Team name already used"},{target:userId});return}
    f={id:crypto.randomUUID(),loginId:data.loginId,passHash:enc(data.password),owner:data.owner,team:data.team,purse:state.room.startPurse,userId,online:true,joinedAt:Date.now()};
    state.franchises.push(f);state.feed.unshift("🏏 "+f.team+" joined the room.");
  }
  persist();
  replyAction.send({ok:true,ownerId:f.id,loginId:f.loginId,state:publicState()},{target:userId});
}

function handleRemoteCommand(data,userId){
  const f=state.franchises.find(x=>x.id===data.ownerId&&x.userId===userId);
  if(!f)return;
  if(data.type==="bid"){processBid(f.id);return}
  if(data.type==="replaceState"&&data.state){
    const incoming=data.state;
    if(!incoming.players||!incoming.franchises||!incoming.auction)return;
    const oldPass=new Map(state.franchises.map(x=>[x.id,x.passHash]));
    const hostPass=state.room?.hostPass;
    state=incoming;
    if(state.room&&hostPass)state.room.hostPass=hostPass;
    state.franchises=state.franchises.map(x=>({...x,passHash:oldPass.get(x.id)||x.passHash}));
    state.feed.unshift("⚙️ "+f.team+" changed room controls.");
    persist();
  }
}

function sendCommand(data){if(!commandAction||!hostUserId)return alert("Not connected to host.");commandAction.send({...data,ownerId:me.ownerId},{target:hostUserId})}

function copyRoom(){navigator.clipboard?.writeText(state.room?.code||"");}
async function logoutRoom(){
  try{await netRoom?.leave()}catch{}
  netRoom=null;hostUserId=null;
  sessionStorage.removeItem("dcc-me");
  setMe({role:null,ownerId:null});
  $("#game")?.classList.remove("active");
  $("#landing")?.classList.add("active");
  $("#logoutBtn")?.classList.add("hidden");
  setNet("OFFLINE");
  render();
}
function renderAuctionSelect(){
  const q=($("#auctionSearch")?.value||"").trim().toLowerCase(),sel=$("#playerSelect");if(!sel)return;
  const old=sel.value;sel.innerHTML=availablePlayers().filter(p=>!q||p.name.toLowerCase().includes(q)||p.iplTeam.toLowerCase().includes(q)).map(p=>"<option value='"+p.id+"'>"+esc(p.name)+" • "+p.iplTeam+" • "+money(p.basePrice)+"</option>").join("");
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
function factoryReset(){if(!hostOnly())return;if(!confirm("Erase/reset this room state from your browser?"))return;localStorage.removeItem("dcc-state-v3");sessionStorage.removeItem("dcc-me");location.reload()}

function render(){
  $("#roomBadge").textContent=state.room?.code||"NO ROOM";
  $("#logoutBtn")?.classList.toggle("hidden",!["host","owner"].includes(me.role));
  $("#adminTab")?.classList.remove("hidden");
  $("#auctionHostControls")?.classList.remove("hidden");
  $("#ownerBidBtn")?.classList.toggle("hidden",me.role!=="owner");
  if(!state.room)return;
  $("#roomTitle").textContent=state.room.code;
  $("#roomInfo").innerHTML="Host: <b>"+esc(state.room.hostName)+"</b><br>Starting purse: <b>"+money(state.room.startPurse)+"</b>";
  $("#franchiseList").innerHTML=state.franchises.map(f=>"<div class='teamCard'><div class='row-between'><h4>"+esc(f.team)+"</h4><span class='dot "+(f.online?"on":"")+"'></span></div><div>"+esc(f.owner)+"</div><div class='money'>"+money(f.purse)+"</div></div>").join("")||"<span class='muted'>Waiting for franchise owners.</span>";
  const sold=state.players.filter(p=>p.owner).length;
  $("#leaguePulse").innerHTML="<div><b>"+state.franchises.length+"</b><span>Teams</span></div><div><b>"+sold+"</b><span>Players sold</span></div><div><b>"+state.matches.length+"</b><span>Matches</span></div><div><b>"+availablePlayers().length+"</b><span>Available</span></div>";
  $("#soldCounter").textContent=sold+" sold • "+availablePlayers().length+" available";
  renderAuctionSelect();renderAuction();renderSquads();renderTeamSelects();renderAdmin();renderStandings();if(state.matches.length)renderMatch(state.matches.at(-1));
}
function renderAuction(){const p=currentPlayer();$("#aName").textContent=p?.name||"Choose a player";$("#aMeta").textContent=p?(p.iplTeam+" • "+p.role+" • Base "+money(p.basePrice)):"";$("#aBid").textContent=state.auction.bid?money(state.auction.bid):"—";$("#aLeader").textContent=state.auction.leader?(ownerBy(state.auction.leader)?.team||"Unknown")+" leads":"No bids";$("#aTimer").textContent=state.auction.running?Math.max(0,Math.ceil((state.auction.endsAt-Date.now())/1000)):"—";$("#auctionFeed").innerHTML=state.feed.slice(0,100).map(x=>"<div>"+esc(x)+"</div>").join("")||"<span class='muted'>Auction has not started.</span>"}
function renderSquads(){$("#squadGrid").innerHTML=state.franchises.map(f=>{const sq=state.players.filter(p=>p.owner===f.id&&p.active);return "<div class='teamCard'><h4>"+esc(f.team)+"</h4><div class='money'>"+money(f.purse)+" left</div><p>"+sq.length+" players</p><ol>"+sq.map(p=>"<li>"+esc(p.name)+" <span class='muted'>"+money(p.soldPrice)+" • "+p.role+"</span></li>").join("")+"</ol></div>"}).join("")||"<span class='muted'>No squads yet.</span>"}
function renderTeamSelects(){const opts=state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");for(const id of ["teamA","teamB"]){const el=$("#"+id);if(!el)continue;const old=el.value;el.innerHTML=opts;if([...el.options].some(o=>o.value===old))el.value=old}$("#pitchBox").textContent=state.pitch?state.pitch.name+" — "+state.pitch.desc:"No pitch generated.";$("#tossBox").textContent=state.toss?(ownerBy(state.toss.winner)?.team+" won the toss and chose to "+state.toss.choice):"Toss not conducted."}
function renderAdmin(){const psel=$("#editPlayer"),oldp=psel.value;psel.innerHTML=state.players.filter(p=>p.active).map(p=>"<option value='"+p.id+"'>"+esc(p.name)+"</option>").join("");if([...psel.options].some(o=>o.value===oldp))psel.value=oldp;const teams="<option value=''>Unassigned</option>"+state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");$("#assignTeam").innerHTML=teams;const tsel=$("#adminTeam"),oldt=tsel.value;tsel.innerHTML=state.franchises.map(f=>"<option value='"+f.id+"'>"+esc(f.team)+"</option>").join("");if([...tsel.options].some(o=>o.value===oldt))tsel.value=oldt;loadPlayerEditor();loadTeamEditor()}
function renderMatch(m){const a=ownerBy(m.a),b=ownerBy(m.b);if(!a||!b)return;$("#scoreboard").innerHTML="<div class='scoreline'><span>"+esc(a.team)+"</span><b>"+m.i1.runs+"/"+m.i1.wickets+"</b><small>"+(m.i1.balls/6).toFixed(1)+" ov</small></div><div class='scoreline'><span>"+esc(b.team)+"</span><b>"+m.i2.runs+"/"+m.i2.wickets+"</b><small>"+(m.i2.balls/6).toFixed(1)+" ov</small></div><p class='muted'>"+esc(m.pitch)+"</p>";$("#matchResult").textContent=m.tied?"TIED":(ownerBy(m.winner)?.team||"")+" WON";$("#commentary").innerHTML=m.i1.events.concat(m.i2.events).slice(-100).map(x=>"<div>"+esc(x)+"</div>").join("");$("#advice").innerHTML="<div class='notice'><b>Brutal review:</b> "+esc(roastFor(m))+"</div><div class='notice'><b>Improvement:</b> "+esc(adviceFor(m))+"</div>"}
function renderStandings(){const rows=standings();$("#pointsBody").innerHTML=rows.map((r,i)=>"<tr><td>"+(i+1)+"</td><td>"+esc(r.team)+"</td><td>"+r.P+"</td><td>"+r.W+"</td><td>"+r.L+"</td><td>"+r.T+"</td><td>"+r.NR+"</td><td><b>"+r.pts+"</b></td><td>"+r.nrr.toFixed(3)+"</td></tr>").join("");const sr=Object.entries(state.stats).map(([id,s])=>({p:state.players.find(x=>x.id===id),...s})).filter(x=>x.p);$("#batLeaders").innerHTML=[...sr].sort((a,b)=>b.runs-a.runs).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+x.runs+" runs</b></p>").join("")||"No matches yet.";$("#bowlLeaders").innerHTML=[...sr].sort((a,b)=>b.wickets-a.wickets).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+x.wickets+" wickets</b></p>").join("")||"No matches yet.";$("#mvpLeaders").innerHTML=[...sr].sort((a,b)=>(b.runs+b.wickets*25)-(a.runs+a.wickets*25)).slice(0,10).map((x,i)=>"<p>"+(i+1)+". "+esc(x.p.name)+" — <b>"+(x.runs+x.wickets*25)+" pts</b></p>").join("")||"No matches yet.";$("#bestTeam").innerHTML=rows[0]?"<h2>"+esc(rows[0].team)+"</h2><p>"+rows[0].pts+" points • NRR "+rows[0].nrr.toFixed(3)+"</p>":"No matches yet."}

window.addEventListener("beforeunload",()=>{try{netRoom?.leave()}catch{}});
render();
if(state.room&&me.role==="host"){enterGame();connectNetwork(state.room.code,true);if(state.auction.running)runTimer()}else if(state.room&&me.role==="owner"){enterGame();connectNetwork(state.room.code,false)}
