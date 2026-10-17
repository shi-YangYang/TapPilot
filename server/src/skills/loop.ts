import { modelScope } from "../learning/schema.js";
import type { ModelConfig, ModelFetch } from "../runtime/model.js";
import { generateSkill } from "./generation.js";
import { evaluateSkill, SkillEvaluationError } from "./evaluation.js";
import { skillHash, type SkillFeedback, type SkillSpec } from "./schema.js";
import { SkillStore, type StoreStatus } from "./store.js";

export type ImprovementPhase = "idle"|"queued"|"generating"|"evaluating"|"adopted"|"rejected"|"paused"|"budget_exhausted"|"error";
export type ImprovementReason = "model_unavailable"|"cancelled"|"interrupted"|"no_candidate"|"evaluation_rejected"|"budget_exhausted"|"storage_unavailable"|"generation_failed";
export type ImprovementStatus = StoreStatus & {phase: ImprovementPhase; lastReason?: ImprovementReason};
export type ImproverOptions = {store: SkillStore; resolveModel: ()=>ModelConfig|undefined|Promise<ModelConfig|undefined>;
  modelFetch?: ModelFetch; onStatus?: (status: ImprovementStatus)=>void; now?: ()=>number};
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise<T>((resolve,reject)=>{const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener("abort",abort);
    signal.addEventListener("abort",abort,{once:true});work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
/** Preserve cancellation during response streaming as well as the initial request.
 * This wrapper never stores a request body, credential, or model response. */
function cancellableResponse(response: Response, signal: AbortSignal): Response {
  if(!response.body)return response;
  const reader=response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller){try{const chunk=await abortable(reader.read(),signal);if(chunk.done)controller.close();else controller.enqueue(chunk.value);}
      catch(error){void reader.cancel().catch(()=>{});controller.error(error);}},
    cancel(){void reader.cancel().catch(()=>{});},
  }),{status:response.status,statusText:response.statusText,headers:response.headers});
}

/** Background jobs run only on synthetic phones. They never share a live phone
 * bridge, tool executor or credential store with the evaluator. */
export class ContinuousImprover {
  private phase: ImprovementPhase="idle";
  private lastReason?: ImprovementReason;
  private task?: Promise<void>;
  private controller?: AbortController;
  private paused=false;
  private discard=false;
  private rescheduleRequested=false;
  private readonly now: ()=>number;
  constructor(readonly options: ImproverOptions){this.now=options.now??Date.now;}
  async status():Promise<ImprovementStatus>{return{...await this.options.store.status(this.now()),phase:this.phase,...(this.lastReason?{lastReason:this.lastReason}:{})};}
  private async announce(phase:ImprovementPhase, reason?:ImprovementReason){this.phase=phase;this.lastReason=reason;
    if(this.options.onStatus)try{this.options.onStatus(await this.status());}catch{/* UI observers cannot alter job outcomes. */}}
  schedule():void{
    this.paused=false;this.discard=false;
    if(this.task){this.rescheduleRequested=true;return;}
    this.task=this.pump().catch(async()=>{await this.announce("error","storage_unavailable");}).finally(()=>{this.task=undefined;this.controller=undefined;
      const again=this.rescheduleRequested&&!this.paused;this.rescheduleRequested=false;if(again)this.schedule();
    });
  }
  async waitForIdle():Promise<void>{while(this.task)await this.task;}
  async pause():Promise<void>{this.paused=true;this.rescheduleRequested=false;this.controller?.abort(new Error("SKILLS_INTERRUPTED"));await this.task;await this.announce("paused","interrupted");}
  async cancel():Promise<void>{this.paused=true;this.rescheduleRequested=false;this.discard=true;this.controller?.abort(new Error("SKILLS_CANCELLED"));
    await this.options.store.cancelQueued(this.now());await this.task;await this.announce("paused","cancelled");}
  async setEnabled(enabled:boolean):Promise<void>{if(!enabled)await this.cancel();await this.options.store.setEnabled(enabled);if(enabled)this.schedule();else await this.announce("paused");}
  async rollback():Promise<void>{await this.pause();await this.options.store.rollback(this.now());await this.announce("paused");}
  private async pump():Promise<void>{
    await this.options.store.recoverInterrupted(this.now());
    await this.announce("queued");
    while(!this.paused){
      const state=await this.options.store.status(this.now());if(!state.enabled||!state.queued){if(this.phase==="queued")await this.announce("idle");return;}
      if(state.dailyJobs>=2||state.dailyModelCalls>=200){await this.announce("budget_exhausted","budget_exhausted");return;}
      let model:ModelConfig|undefined;try{model=await this.options.resolveModel();}catch{/* no secret-bearing error text */}
      if(this.paused)return;
      if(!model){await this.announce("paused","model_unavailable");return;}
      const frozenModel=Object.freeze({...model});
      let profile:string;try{profile=modelScope(frozenModel).modelProfile;}catch{await this.announce("paused","model_unavailable");return;}
      const claimed=await this.options.store.beginJob(profile,this.now());if(!claimed){await this.announce("idle");return;}
      if(this.paused){await this.options.store.finishJob(claimed.job.id,"interrupted",this.now());return;}
      this.controller=new AbortController();const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(5*60_000)]);
      const {job,episode}=claimed;let parent=claimed.parent,feedback:SkillFeedback[]=[];let budgetExhausted=false;
      if(parent&&episode.appliedSkillHashes.includes(skillHash(parent)))feedback=[{skillHash:skillHash(parent),outcome:"runtime_failure",errorCode:episode.trigger.errorCode,reason:episode.trigger.reason,metric:"unknown"}];
      const budgetFetch:ModelFetch=async(url,init)=>{
        signal.throwIfAborted();try{await this.options.store.reserveModelCall(job.id,this.now());}catch(error){if(error instanceof Error&&error.message==="SKILLS_BUDGET_EXHAUSTED")budgetExhausted=true;throw error;}signal.throwIfAborted();
        const combined=init.signal?AbortSignal.any([signal,init.signal]):signal;
        const response=await abortable((this.options.modelFetch??globalThis.fetch)(url,{...init,signal:combined}),combined);
        return cancellableResponse(response,combined);
      };
      let adopted=false;
      try{
        for(let candidateIndex=0;candidateIndex<2;candidateIndex++){
          signal.throwIfAborted();await this.announce("generating");
          const spec:SkillSpec=await generateSkill(episode,{model:frozenModel,modelFetch:budgetFetch,signal,now:this.now(),parent,feedback});
          signal.throwIfAborted();const hash=await this.options.store.addCandidate(job.id,spec,this.now());
          await this.announce("evaluating");
          try{
            const evaluation=await evaluateSkill(spec,episode,{model:frozenModel,modelFetch:budgetFetch,signal,
              incumbents:await this.options.store.loadSnapshot(episode.scope,this.now()),maxModelCalls:100,maxDurationMs:5*60_000});
            signal.throwIfAborted();await this.options.store.adopt(job.id,hash,evaluation.receipt,this.now());adopted=true;await this.announce("adopted");break;
          }catch(error){
            signal.throwIfAborted();
            if(!(error instanceof SkillEvaluationError))throw error;
            await this.options.store.rejectCandidate(job.id,error.feedback);feedback=[error.feedback];parent=spec;
          }
        }
        if(!adopted){await this.options.store.finishJob(job.id,"rejected",this.now());await this.announce("rejected","evaluation_rejected");}
      }catch(error){
        const budget=budgetExhausted||error instanceof Error&&/BUDGET|LIMIT/.test(error.message);
        const interrupted=this.paused||signal.aborted;
        await this.options.store.finishJob(job.id,interrupted?(this.discard?"cancelled":"interrupted"):budget?"exhausted":"rejected",this.now());
        await this.announce(interrupted?"paused":budget?"budget_exhausted":"rejected",interrupted?(this.discard?"cancelled":"interrupted"):budget?"budget_exhausted":"generation_failed");
      }finally{this.controller=undefined;}
    }
  }
}
