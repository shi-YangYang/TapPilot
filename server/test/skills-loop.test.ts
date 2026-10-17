import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { modelScope } from "../src/learning/schema.js";
import { SKILL_POLICY_REVISION, skillHash, type SkillSpec } from "../src/skills/schema.js";
import { compactTrace, createEpisode } from "../src/skills/trace.js";
import { SkillStore } from "../src/skills/store.js";
import { ContinuousImprover } from "../src/skills/loop.js";
import { Adb } from "../src/adb.js";
import { createPhoneClient } from "../src/client-tools.js";
import { ScenarioPhone, type Json } from "../src/eval/synthetic-phone.js";
import { generateScenarios } from "../src/eval/scenarios.js";
import { observedPolicy, currentObservation } from "../src/eval/runner.js";
import { runAgent } from "../src/runtime/index.js";
import type { FailureEpisode } from "../src/skills/trace.js";
import type { BridgeResponse } from "../src/bridge.js";
import { evaluateSkill, type SkillReceipt } from "../src/skills/evaluation.js";

const secret="PRIVATE-password-chat-验证码";
const model={baseUrl:"https://skill-loop.invalid/v1",model:"fixture",apiKey:secret};
const scope={hostVersion:"0.3.19",policyRevision:SKILL_POLICY_REVISION,modelProfile:modelScope(model).modelProfile};
const before={snapshotId:"private:1",sessionId:"private",windowId:1,packageName:"private.app",truncated:false,nodes:[{nodeId:"private-target",text:secret,clickable:false,enabled:true,visible:true}]};
const diagnostic={actionKind:"tap_element",errorCode:"NODE_NOT_ACTIONABLE",reason:"NO_CLICKABLE_TARGET",dispatchState:"not_sent",acceptanceState:"rejected",effectState:"unknown"}as const;
const step=compactTrace({index:1,before,after:before,targetNodeId:"private-target",diagnostic});
const episode=(nodeCount=1)=>createEpisode({scope,trigger:{actionKind:diagnostic.actionKind,errorCode:diagnostic.errorCode,reason:diagnostic.reason},steps:[{...step,after:{...step.after,nodeCount}}],termination:"failed",appliedSkillHashes:[]});
const spec=(expiresAt=Date.now()+86_400_000):SkillSpec=>({schemaVersion:1,scope,trigger:episode().trigger,entryConditions:[],program:{entry:0,nodes:[{kind:"step",operation:{op:"inspect",aspect:"hierarchy"},next:1},{kind:"end",outcome:"continue"}]},lineage:{negativeFeedback:[]},basis:"hypothesis",expiresAt});
const withStore=async(work:(store:SkillStore,root:string)=>Promise<void>)=>{const root=await mkdtemp(join(tmpdir(),"tappilot-skill-loop-"));try{await work(new SkillStore(root),root);}finally{await rm(root,{recursive:true,force:true});}};

test("private ledger accepts only sanitized structure, deduplicates evidence and rejects symlinks",async()=>withStore(async(store,root)=>{
  const first=episode();await assert.rejects(store.recordEpisode({...first,task:secret}),/SKILLS_INVALID_EPISODE/);
  const queued=await store.recordEpisode(first);assert.equal(queued.queued,true);
  assert.equal((await store.recordEpisode({...first,id:randomUUID(),createdAt:Date.now()+1})).queued,false);
  const text=await readFile(join(store.directory,"state.json"),"utf8");assert.equal(text.includes(secret),false);assert.equal(text.includes("private.app"),false);
  assert.equal((await stat(store.directory)).mode&0o777,0o700);assert.equal((await stat(join(store.directory,"state.json"))).mode&0o777,0o600);
  await unlink(join(store.directory,"state.json"));await symlink(join(root,"outside"),join(store.directory,"state.json"));
  await assert.rejects(store.recordEpisode(episode(2)),/SKILLS_UNSAFE_STORAGE/);
}));

test("adoption rejects fabricated receipts and cross-scope candidates",async()=>withStore(async(store)=>{
  const queued=await store.recordEpisode(episode());await store.beginJob(scope.modelProfile);
  await assert.rejects(store.addCandidate(queued.id,{...spec(),scope:{...scope,modelProfile:"e".repeat(64)}}),/SKILLS_INVALID_CANDIDATE/);
  const candidate=spec(),hash=await store.addCandidate(queued.id,candidate);
  await assert.rejects(store.adopt(queued.id,hash,{passed:true}as unknown as SkillReceipt));
  assert.equal((await store.loadSnapshot(scope)).length,0);
}));

test("job budgets are durable and repeated evidence cannot bypass them",async()=>withStore(async(store)=>{
  const queued=await store.recordEpisode(episode());assert.ok(await store.beginJob(scope.modelProfile));
  for(let index=0;index<100;index++)await store.reserveModelCall(queued.id);
  await assert.rejects(store.reserveModelCall(queued.id),/SKILLS_BUDGET_EXHAUSTED/);
  await store.finishJob(queued.id,"exhausted");assert.equal((await store.recordEpisode(episode())).queued,false);
  const second=await store.recordEpisode(episode(2));assert.ok(await store.beginJob(scope.modelProfile));await store.finishJob(second.id,"rejected");
  await store.recordEpisode(episode(3));assert.equal(await store.beginJob(scope.modelProfile),undefined);
  assert.equal((await store.status()).dailyJobs,2);assert.equal((await store.status()).dailyModelCalls,100);
}));

test("dead write locks recover and crashed jobs do not replay after restart",async()=>withStore(async(store,root)=>{
  const queued=await store.recordEpisode(episode());await store.beginJob(scope.modelProfile);
  const path=join(store.directory,"state.json"),raw=JSON.parse(await readFile(path,"utf8"));raw.jobs[0].ownerPid=2_147_483_647;
  await writeFile(path,JSON.stringify(raw),{mode:0o600});
  await writeFile(join(store.directory,".write-lock"),JSON.stringify({pid:2_147_483_647,token:randomUUID()}),{mode:0o600});
  const restarted=new SkillStore(root);await restarted.recoverInterrupted();assert.equal(await restarted.beginJob(scope.modelProfile),undefined);
  assert.equal((await restarted.history()).jobs.find(j=>j.id===queued.id)?.state,"interrupted");
  assert.equal((await restarted.recordEpisode(episode())).queued,false);
}));

test("foreground pause aborts even an uncooperative request; stop clears pending jobs",async()=>withStore(async(store)=>{
  await store.recordEpisode(episode());await store.recordEpisode(episode(2));
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
  const loop=new ContinuousImprover({store,resolveModel:()=>model,modelFetch:async()=>{began();return new Promise<Response>(()=>{});}});
  loop.schedule();await started;const start=Date.now();await loop.pause();assert.ok(Date.now()-start<1000);
  assert.equal((await store.history()).jobs[0]?.state,"interrupted");assert.equal((await store.status()).queued,1);
  await loop.cancel();assert.equal((await store.status()).queued,0);assert.equal((await loop.status()).phase,"paused");
  assert.equal((await store.loadSnapshot(scope)).length,0);
}));

test("failed generation ends the job without repeated model calls or storing response prose",async()=>withStore(async(store)=>{
  await store.recordEpisode(episode());let calls=0;
  const loop=new ContinuousImprover({store,resolveModel:()=>model,modelFetch:async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify({instructions:secret})}}]}));}});
  loop.schedule();await loop.waitForIdle();assert.equal(calls,1);assert.equal((await loop.status()).phase,"rejected");
  loop.schedule();await loop.waitForIdle();assert.equal(calls,1);
  assert.equal((await readFile(join(store.directory,"state.json"),"utf8")).includes(secret),false);
  assert.equal((await store.history()).jobs[0]?.state,"rejected");
}));

test("a new failed adopted-skill identity is new evidence, but same skill failure deduplicates",async()=>withStore(async(store)=>{
  const original=episode();await store.recordEpisode(original);
  const applied={...episode(),appliedSkillHashes:[skillHash(spec())]};assert.equal((await store.recordEpisode(applied)).queued,true);
  assert.equal((await store.recordEpisode({...applied,id:randomUUID()})).queued,false);
}));

// Same observable policy in both arms; no phone state or success oracle is visible.
function recoveryFetch(onProposal?:(body:any)=>void, firstBad=false){
  let call=0,proposals=0;
  return async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(!body.tools){onProposal?.(body);if(firstBad&&++proposals===1)return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify({entryConditions:[],program:{entry:0,nodes:[{kind:"step",operation:{op:"inspect",aspect:"hierarchy"},next:1},{kind:"end",outcome:"stop"}]}})}}]}));return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{role:"assistant",content:JSON.stringify({entryConditions:[],program:{entry:0,nodes:[
      {kind:"step",operation:{op:"discard_stale_target"},next:1},{kind:"step",operation:{op:"observe",mode:"reuse_latest"},next:2},
      {kind:"step",operation:{op:"resolve_target",capability:"clickable",maxAncestorHops:1},next:3},{kind:"end",outcome:"continue"}]}})}}]}));}
    let tree:any;
    const visit=(value:any)=>{if(!value||typeof value!=="object")return;if(value.snapshotId&&Array.isArray(value.nodes))tree=value;else Object.values(value).forEach(visit);};
    for(const message of body.messages)if(message.role==="tool")try{visit(JSON.parse(message.content));}catch{}
    const tools=body.messages.filter((m:any)=>m.role==="tool").map((m:any)=>m.content).join(" ");
    let decision:any;
    if(!body.messages[0].content.includes("Stop this recovery attempt")&&tree&&!tools.includes("SESSION_CHANGED")&&!tree.nodes.some((n:any)=>n.text==="项目详情")){
      const target=tree.nodes.find((n:any)=>[n.desc,n.text].some(value=>typeof value==="string"&&/^合成(?:恢复)?项目/.test(value)));
      const hinted=body.messages[0].content.includes("Validated procedural hint only");
      const waited=body.messages.some((m:any)=>m.tool_calls?.some((c:any)=>c.function.name==="wait_for_ui_change"));
      if(tools.includes("STALE_SNAPSHOT")&&!hinted&&!waited)decision={name:"wait_for_ui_change",arguments:{sinceRevision:tree.revision,timeoutMs:1}};
      else if(target)decision={name:"act_and_observe",arguments:{action:"tap_element",arguments:{snapshotId:tree.snapshotId,nodeId:target.nodeId}}};
    }
    return new Response(JSON.stringify({choices:[{finish_reason:decision?"tool_calls":"stop",message:{role:"assistant",content:decision?null:"Synthetic task finished.",...(decision?{tool_calls:[{id:`loop-${++call}`,type:"function",function:{name:decision.name,arguments:JSON.stringify(decision.arguments)}}]}:{})}}]}));
  };
}
function boundsEpisode(){
  const base=episode();return createEpisode({...base,trigger:{actionKind:"tap_element",errorCode:"STALE_SNAPSHOT",reason:"NODE_BOUNDS_CHANGED"},steps:[{...step,errorCode:"STALE_SNAPSHOT",reason:"NODE_BOUNDS_CHANGED",
    target:{...step.target,clickable:"yes",editable:"no",scrollable:"no",ancestorClickable:"no",focused:"no"},
    changes:{...step.changes,context:"no",targetBounds:"yes",targetIdentity:"no"}}]});
}

async function recordedBoundsEpisode():Promise<FailureEpisode>{
  const scenario=generateScenarios({mechanisms:["fresh_ids"]})[0]!;
  class MovingPhone extends ScenarioPhone {
    private changed=false;
    override snapshot():Json{const tree=super.snapshot();if(this.changed){const target=tree.nodes.find((n:Json)=>String(n.resourceId).endsWith("/target"));if(target)target.bounds=target.bounds.map((v:number,i:number)=>v+(i%2?24:0));}return tree;}
    override async call(method:string,args:Json={},timeout?:number,beforeDispatch?:()=>void):Promise<BridgeResponse>{
      if(method==="act_and_observe"&&!this.changed){beforeDispatch?.();this.changed=true;return{id:"recorded-fixture",ok:false,error:{code:"STALE_SNAPSHOT",message:"Synthetic bounds changed",retryable:true,details:{reason:"NODE_BOUNDS_CHANGED"}},meta:{durationMs:1}};}
      return super.call(method,args,timeout,beforeDispatch);
    }
  }
  const client=createPhoneClient(new MovingPhone(scenario),new Adb());let result:FailureEpisode|undefined,call=0;
  try{await runAgent({task:scenario.task,model,diagnosticVersion:scope.hostVersion,tools:client.tools,maxTurns:8,
    execute:(name,args,signal)=>client.execute(name,args,signal),onFailureEpisode:value=>{result=value;},modelFetch:async(_url,init)=>{
      const body=JSON.parse(String(init.body)),decision=observedPolicy(currentObservation(body),body,scenario);
      return new Response(JSON.stringify({choices:[{finish_reason:decision?"tool_calls":"stop",message:{role:"assistant",content:decision?null:"Synthetic task finished.",...(decision?{tool_calls:[{id:`capture-${++call}`,type:"function",function:{name:decision.name,arguments:JSON.stringify(decision.arguments)}}]}:{})}}]}));
    }});}finally{await client.close();}
  assert.ok(result,"production runtime emitted a structural failure episode");return result;
}

test("actual generation and trusted paired evaluation automatically adopt; negative observed use revokes frozen winner and queues child",async()=>withStore(async(store)=>{
  const actual=await recordedBoundsEpisode();await store.recordEpisode(actual);let proposals=0;let sawParent=false;
  const loop=new ContinuousImprover({store,resolveModel:()=>model,modelFetch:recoveryFetch(body=>{proposals++;const input=JSON.parse(body.messages[1].content);sawParent=Boolean(input.parent);})});
  loop.schedule();await loop.waitForIdle();
  assert.equal((await loop.status()).phase,"adopted",JSON.stringify(await loop.status()));
  const snapshot=await store.loadSnapshot(actual.scope);assert.equal(snapshot.length,1);assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot[0]!.program.nodes));
  const hash=skillHash(snapshot[0]!);assert.equal((await store.history()).jobs[0]?.state,"adopted");
  assert.ok((await store.status()).dailyModelCalls>1);assert.ok((await store.status()).dailyModelCalls<=100);
  assert.equal((await store.loadTaskSnapshot(scope)).length,1);
  await store.recordUsageOutcome([hash],"failure");assert.equal((await store.loadSnapshot(scope)).length,0);
  assert.equal(skillHash(snapshot[0]!),hash,"already running tasks retain their frozen validated program");
  assert.equal((await store.recordEpisode({...actual,id:randomUUID(),appliedSkillHashes:[hash]})).queued,true);
  loop.schedule();await loop.waitForIdle();assert.equal(sawParent,true);assert.equal(proposals,2);
  assert.equal((await store.loadSnapshot(scope)).length,0,"unchanged failed program cannot be re-adopted");
  assert.equal((await store.history()).skills[0]?.state,"revoked");
}));


test("a rejected candidate's measured feedback drives a different child that is tested and adopted automatically",async()=>withStore(async(store)=>{
  await store.recordEpisode(boundsEpisode());const inputs:any[]=[];
  const loop=new ContinuousImprover({store,resolveModel:()=>model,modelFetch:recoveryFetch(body=>inputs.push(JSON.parse(body.messages[1].content)),true)});
  loop.schedule();await loop.waitForIdle();
  assert.equal((await loop.status()).phase,"adopted",JSON.stringify(await loop.status()));
  assert.equal(inputs.length,2);assert.ok(inputs[1].parent);assert.equal(inputs[1].negativeFeedback.length,1);
  assert.equal(inputs[1].negativeFeedback[0].outcome,"regression");
  const history=await store.history();assert.deepEqual(history.skills.map(r=>r.state),["rejected","active"]);
  const snapshot=await store.loadSnapshot(scope);assert.equal(snapshot[0]!.lineage.parentHash,history.skills[0]!.hash);
  assert.equal(history.jobs[0]!.feedback.length,1);assert.equal(history.jobs[0]!.candidateHashes.length,2);
}));


test("rollback withdraws all active app winners, not just the three retrieved by one task",async()=>withStore(async(store)=>{
  for(let index=0;index<4;index++){
    const appScope={...scope,appDigest:String(index+1).repeat(64)},trace={...boundsEpisode(),scope:appScope};
    const queued=await store.recordEpisode(trace);assert.ok(await store.beginJob(scope.modelProfile,Date.now()+Math.floor(index/2)*86_400_000));
    const candidate={...spec(),scope:appScope,trigger:trace.trigger};const hash=await store.addCandidate(queued.id,candidate);
    const proof=await evaluateSkill(candidate,trace,{model,modelFetch:recoveryFetch()});
    await store.adopt(queued.id,hash,proof.receipt);
  }
  const frozen=await store.loadTaskSnapshot(scope);assert.equal(frozen.length,4);
  await store.rollback();assert.equal((await store.status()).activeSkills,0);assert.equal((await store.loadTaskSnapshot(scope)).length,0);
  assert.deepEqual((await store.history()).skills.map(item=>item.state),["revoked","revoked","revoked","revoked"]);
  assert.equal(frozen.length,4,"existing task snapshots remain frozen after future-task rollback");
}));

test("a schedule request during a running pump is not lost during final cleanup",async()=>withStore(async(store)=>{
  let requested=false;let loop:ContinuousImprover;
  loop=new ContinuousImprover({store,resolveModel:()=>undefined,onStatus:state=>{if(state.phase==="idle"&&!requested){requested=true;loop.schedule();}}});
  loop.schedule();await loop.waitForIdle();assert.equal(requested,true);assert.equal((await loop.status()).phase,"idle");
}));
