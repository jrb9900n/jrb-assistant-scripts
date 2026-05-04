// scheduler/task-poller.js
import { runAgent } from '../core/agent.js';
import { logger } from '../core/logger.js';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
async function sb(p, opts={}) { const r=await fetch(SUPABASE_URL+'/rest/v1/'+p,{...opts,headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'return=representation',...(opts.headers||{})}}); if(!r.ok){const t=await r.text();throw new Error('Supabase '+r.status+': '+t);} return r.json(); }
async function pollTasks() { let rows; try{rows=await sb('agent_tasks?status=eq.pending&order=created_at.asc&limit=3');}catch(err){logger.warn('[task-poller] Poll failed',{err:err.message});return;} for(const row of rows){try{await sb('agent_tasks?id=eq.'+row.id,{method:'PATCH',body:JSON.stringify({status:'running'})});}catch(e){} let result,status; try{const{result:r}=await runAgent({task:row.task,taskType:'general'});result=r;status='done';}catch(err){result='Error: '+err.message;status='error';} try{await sb('agent_tasks?id=eq.'+row.id,{method:'PATCH',body:JSON.stringify({status,result})});}catch(e){}} }
if(SUPABASE_URL&&SUPABASE_KEY){logger.info('[task-poller] Started');setInterval(pollTasks,30000);pollTasks();}
export{pollTasks};
