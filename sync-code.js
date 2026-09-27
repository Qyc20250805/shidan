import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';
let active = null;
export function generateSyncCode() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export function normalizeSyncCode(value) {
  const code = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(code)) throw new Error('请完整粘贴系统生成的 64 位同步码');
  return code;
}
export async function identityForCode(value) {
  const code=normalizeSyncCode(value);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(code));
  return {id:'code:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')};
}
async function rpc(name, body) {
  if (navigator.onLine === false) throw new Error('当前离线，数据已保留在本机');
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
      method:'POST',headers:{apikey:SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:controller.signal,referrerPolicy:'no-referrer'
    });
    const data=await response.json();
    if(!response.ok){
      if(data?.code==='40001')throw Object.assign(new Error('云端有其他修改，请先处理冲突'),{code:'SYNC_CONFLICT'});
      if(data?.code==='P0002')throw new Error('同步码不存在，请检查是否完整复制');
      if(data?.code==='PGRST202')throw new Error('同步服务尚未配置，请先执行同步码 SQL');
      if(data?.code==='22023')throw new Error('同步码或工作台数据格式无效');
      throw new Error('同步服务暂不可用，本地数据已保留');
    }
    return data;
  } catch(error) {
    if(error.name==='AbortError')throw new Error('同步请求超时，本地数据已保留');
    throw error;
  } finally {clearTimeout(timer);}
}
export async function connectSyncCode(value, create=false) {
  const code=normalizeSyncCode(value);
  await rpc('shidan_code_open',{p_code:code,p_create:create});
  const user=await identityForCode(code);
  active={code,...user};return user;
}
export async function restoreSyncCode(value) {
  const code=normalizeSyncCode(value);const user=await identityForCode(code);
  active={code,...user};return user;
}
export function disconnectSyncCode(){active=null;}
export function currentSyncCode(){return active?.code || '';}
function check(id){if(!active || active.id!==id)throw new Error('同步码已切换，请重试');return active.code;}
export async function readCloudWorkspace(id){
  const data=await rpc('shidan_code_open',{p_code:check(id),p_create:false});
  return data.payload===null?null:data;
}
export async function saveCloudWorkspace(payload,revision,options={}){
  if(revision===null && !options.confirmLocalMigration)throw new Error('请先确认本地数据迁移');
  return rpc('shidan_code_save',{p_code:check(options.expectedUserId),p_payload:payload,p_revision:revision??0});
}
