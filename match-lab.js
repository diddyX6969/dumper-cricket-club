"use strict";

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[c]));
const PITCHES = {
  flat:{name:"Flat batting paradise",bat:14,pace:-8,spin:-5,note:"Ball carries well. Boundaries are easier to find."},
  green:{name:"Green seamer",bat:-10,pace:16,spin:-5,note:"Movement for seamers in the first spells."},
  dry:{name:"Dry turner",bat:-6,pace:-2,spin:16,note:"Spinners find serious grip."},
  slow:{name:"Slow & low",bat:-6,pace:-5,spin:8,note:"Timing is difficult; cutters work."},
  balanced:{name:"Balanced surface",bat:0,pace:2,spin:2,note:"Fair contest between bat and ball."}
};
let pitch = null, toss = null, lastMatch = null;
let cardsPlayed = 0;
const clamp = (value,low,high) => Math.min(high,Math.max(low,Number(value)||0));
const choice = (arr) => arr[Math.floor(Math.random()*arr.length)];
const oversText = (balls) => Math.floor(balls/6)+"."+(balls%6);
const inningsLimit = () => $("testFormat").value==="custom" ? Math.round(clamp($("testOvers").value,1,120)) : Number($("testFormat").value);
function teamNames(){
  return [$("testTeamA").value.trim()||"Team A",$("testTeamB").value.trim()||"Team B"];
}
function refreshConditions(){
  const [a,b]=teamNames();
  const p = pitch ? "<b>Pitch:</b> "+esc(pitch.name)+" — "+esc(pitch.note) : "<b>Pitch:</b> Not generated";
  const t = toss ? "<b>Toss:</b> "+esc(toss.winner===0?a:b)+" chose to "+esc(toss.decision) : "<b>Toss:</b> Not conducted";
  $("testConditions").innerHTML=p+"<p>"+t+"</p>";
}
function generateTestPitch(){
  const key = $("testPitch").value;
  pitch = {...PITCHES[key==="random"?choice(Object.keys(PITCHES)):key]};
  refreshConditions();
}
function conductTestToss(){
  toss = {winner:Math.random()<.5?0:1,decision:Math.random()<.52?"bat":"bowl"};
  refreshConditions();
}
function getSeedByName(name){
  return PLAYER_SEED.find(p=>p.name.toLowerCase()===name.toLowerCase());
}
function buildXI(raw){
  const names = raw.split(/[\n,]/).map(n=>n.trim()).filter(Boolean);
  if (names.length!==11) throw new Error("Each team must have exactly 11 players. You entered "+names.length+".");
  const seen = new Set();
  return names.map((name)=>{
    const key=name.toLowerCase();
    if(seen.has(key))throw new Error("A playing XI has the same player twice: "+name);
    seen.add(key);
    const seed=getSeedByName(name);
    if(seed)return {id:seed.id,name:seed.name,role:seed.role,bat:seed.bat,bowl:seed.bowl,field:seed.field};
    // Generic placeholder for custom test names only.
    return {id:"test-"+key,name,role:"Batter",bat:65,bowl:42,field:63};
  });
}
function loadTestPresets(){
  const a=PLAYER_SEED.filter(p=>p.sourceTeam==="MI"&&p.status==="retained").slice(0,11);
  const b=PLAYER_SEED.filter(p=>p.sourceTeam==="CSK"&&p.status==="retained").slice(0,11);
  if(a.length<11||b.length<11){alert("Sample IPL XIs are not available.");return;}
  $("testTeamA").value="Mumbai Test XI";
  $("testTeamB").value="Chennai Test XI";
  $("testXI_A").value=a.map(p=>p.name).join("\n");
  $("testXI_B").value=b.map(p=>p.name).join("\n");
  pitch=null;toss=null;refreshConditions();
}
function swapTestTeams(){
  const name=$("testTeamA").value, xi=$("testXI_A").value, bias=$("testBiasA").value;
  $("testTeamA").value=$("testTeamB").value;
  $("testXI_A").value=$("testXI_B").value;
  $("testBiasA").value=$("testBiasB").value;
  $("testTeamB").value=name;$("testXI_B").value=xi;$("testBiasB").value=bias;
  toss=null;refreshConditions();
}
function bowlType(p){return ["Bowler","All-rounder"].includes(p.role)}
function simulateInnings(xi,fielders,limit,target,bias,inningsName){
  const bats=xi.map(p=>({name:p.name,r:0,b:0,fours:0,sixes:0,out:false}));
  const bowlerCandidates=fielders.map((p,index)=>({p,index})).sort((a,b)=>b.p.bowl-a.p.bowl);
  let bowlers=bowlerCandidates.slice(0,6);
  if(!bowlers.length)throw new Error("Opposition XI is empty.");
  const figures=fielders.map(p=>({name:p.name,r:0,w:0,b:0,overs:0}));
  const events=[];
  let striker=0,nonStriker=1,nextBatter=2,runs=0,wickets=0,balls=0,extras=0;
  // Use an over-based bowling plan, with a bowlers' four-over limit in T20.
  const maxBowlerOvers=limit<=20?Math.max(1,Math.ceil(limit/5)):Math.max(1,Math.ceil(limit/5));
  const completedOvers=new Map();
  let selectedBowler=null;
  while(balls<limit*6&&wickets<10&&(!target||runs<target)){
    if(!bats[striker])break;
    const over=Math.floor(balls/6);
    if(balls%6===0 || !selectedBowler){
      const available=bowlers.filter(x=>(completedOvers.get(x.index)||0)<maxBowlerOvers);
      selectedBowler=available.length?available[over%available.length]:bowlerCandidates[over%bowlerCandidates.length];
    }
    const bowler=selectedBowler.p;
    const fig=figures[selectedBowler.index];
    const batter=xi[striker];
    const bat=bats[striker];
    const battingRating=clamp(batter.bat + pitch.bat + bias,10,125);
    const bowlingRating=clamp(bowler.bowl+(bowlType(bowler)?(pitch.pace+pitch.spin)/2:0),10,125);
    const wicketChance=clamp(0.045+(bowlingRating-battingRating)*0.00065,0.012,0.115);
    const roll=Math.random();
    const ballText=oversText(balls)+" · ";
    // Slightly more wides on aggressive fast bowling: not legal balls.
    if(Math.random()<0.006){
      runs++;extras++;fig.r++;events.push(ballText+"Wide from "+bowler.name+" (+1)");continue;
    }
    if(roll<wicketChance){
      wickets++;bat.out=true;fig.w++;events.push(ballText+"WICKET — "+bowler.name+" dismisses "+batter.name+"! "+runs+"/"+wickets);
      if(nextBatter<bats.length){striker=nextBatter++;}else{balls++;fig.b++;break;}
    }else{
      const dominance=clamp((battingRating-bowlingRating+80)/160,0.12,0.89);
      const x=Math.random();
      const r=x<0.295?0:x<0.58?1:x<0.70?2:x<0.72?3:x<0.72+dominance*0.20?4:x<0.72+dominance*0.29?6:0;
      runs+=r;bat.r+=r;fig.r+=r;
      if(r===4){bat.fours++;events.push(ballText+"FOUR — "+batter.name+" finds the boundary");}
      else if(r===6){bat.sixes++;events.push(ballText+"SIX — "+batter.name+" goes big!");}
      else if(r===0&&Math.random()<0.065)events.push(ballText+"Dot ball: "+bowler.name+" holds the line");
      if(r%2===1)[striker,nonStriker]=[nonStriker,striker];
    }
    bat.b++;balls++;fig.b++;
    if(balls%6===0){
      completedOvers.set(selectedBowler.index,(completedOvers.get(selectedBowler.index)||0)+1);
      [striker,nonStriker]=[nonStriker,striker];
      events.push(oversText(balls)+" ov · "+inningsName+" "+runs+"/"+wickets);
    }
  }
  const figuresUsed=figures.filter(x=>x.b>0).sort((a,b)=>b.w-a.w||a.r-b.r);
  return {runs,wickets,balls,extras,bats,figures:figuresUsed,events};
}
function cardMarkup(team,inn,target){
  const result='<div class="lab-score"><div><strong>'+esc(team)+'</strong><small>'+oversText(inn.balls)+' overs • '+inn.extras+' extras</small></div><b>'+inn.runs+'/'+inn.wickets+'</b></div>';
  const batting='<div class="lab-table"><table><thead><tr><th>Batter</th><th>R</th><th>B</th><th>4s</th><th>6s</th></tr></thead><tbody>'+inn.bats.filter(x=>x.b>0||x.r>0).map(x=>'<tr><td>'+esc(x.name)+(x.out?" †":"")+'</td><td>'+x.r+'</td><td>'+x.b+'</td><td>'+x.fours+'</td><td>'+x.sixes+'</td></tr>').join("")+'</tbody></table></div>';
  const bowling='<h3>Bowling</h3><div class="lab-table"><table><thead><tr><th>Bowler</th><th>O</th><th>R</th><th>W</th></tr></thead><tbody>'+inn.figures.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+oversText(x.b)+'</td><td>'+x.r+'</td><td>'+x.w+'</td></tr>').join("")+'</tbody></table></div>';
  return result+(target?'<p class="lab-muted">Target: '+target+'</p>':'')+batting+bowling;
}
function testAdvice(winner,loser,innA,innB){
  if(!winner)return "Tied game. Try changing the pitch, power hitters, bowling lineup or bias and run it again.";
  const losing=loser===0?innA:innB;
  const losingTop=losing.bats.slice(0,5).reduce((sum,b)=>sum+b.r,0);
  if(losing.wickets>=8)return "Management review: a collapse that belongs on a cautionary poster. Build batting depth and protect wickets in the middle overs.";
  if(losingTop<40)return "Management review: the top order forgot the assignment. Swap the batting order and test again.";
  return "Management review: close enough to hurt. Test stronger death bowling, strike rotation and better player matchups.";
}
function runTestMatch(){
  try{
    const [teamA,teamB]=teamNames();
    if(teamA.toLowerCase()===teamB.toLowerCase())throw new Error("Enter two different team names.");
    const a=buildXI($("testXI_A").value), b=buildXI($("testXI_B").value);
    if(!pitch)generateTestPitch();
    if(!toss)conductTestToss();
    const overs=inningsLimit();
    const first=toss.decision==="bat"?toss.winner:1-toss.winner,second=1-first;
    const xis=[a,b], names=[teamA,teamB], biases=[clamp($("testBiasA").value,-30,30),clamp($("testBiasB").value,-30,30)];
    const i1=simulateInnings(xis[first],xis[second],overs,null,biases[first],names[first]);
    const i2=simulateInnings(xis[second],xis[first],overs,i1.runs+1,biases[second],names[second]);
    const tie=i1.runs===i2.runs,winner=tie?null:(i2.runs>i1.runs?second:first);
    const loser=winner===null?null:1-winner;
    lastMatch={teamA,teamB,overs,first,second,i1,i2,tie,winner,at:new Date().toISOString()};
    cardsPlayed++;
    $("testStatus").textContent="Test #"+cardsPlayed+" completed";
    $("testScore").innerHTML='<div class="lab-metrics"><div><span>Pitch</span><strong>'+esc(pitch.name)+'</strong></div><div><span>Toss</span><strong>'+esc(names[toss.winner])+'</strong></div><div><span>Format</span><strong>'+overs+' overs</strong></div></div><div class="lab-score"><div><b>'+esc(names[first])+'</b><small>First innings • '+oversText(i1.balls)+' ov</small></div><b>'+i1.runs+'/'+i1.wickets+'</b></div><div class="lab-score"><div><b>'+esc(names[second])+'</b><small>Chase • '+oversText(i2.balls)+' ov</small></div><b>'+i2.runs+'/'+i2.wickets+'</b></div>';
    const verdict=tie?"Match tied":names[winner]+" won "+(winner===second?"by "+(10-i2.wickets)+" wickets":"by "+(i1.runs-i2.runs)+" runs");
    $("testReport").textContent="\nRESULT: "+verdict+"\n"+testAdvice(winner,loser,i1,i2);
    $("testScorecards").hidden=false;
    $("testCardA").innerHTML=cardMarkup(names[first],i1,null);
    $("testCardB").innerHTML=cardMarkup(names[second],i2,i1.runs+1);
    const events=[...i1.events.map(x=>names[first]+": "+x),...i2.events.map(x=>names[second]+": "+x)];
    $("testCommentary").innerHTML=events.slice(-130).map(x=>"<div>"+esc(x)+"</div>").join("")||"<p>No notable events.</p>";
  }catch(e){alert(e.message||String(e))}
}
function clearTestResult(){
  lastMatch=null;pitch=null;toss=null;
  $("testStatus").textContent="Ready";
  $("testScore").textContent="Run a simulation to see a match result here.";
  $("testReport").textContent="";
  $("testScorecards").hidden=true;
  $("testCommentary").innerHTML='<p class="lab-muted">Commentary appears after the match.</p>';
  refreshConditions();
}
loadTestPresets();
