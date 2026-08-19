'use strict';
const fs=require('fs'); const path=require('path');
const dir=path.resolve(process.env.DATA_DIR||path.join(__dirname,'..','data')); fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,'saas.json');
const base={users:{},admins:[],plans:{'premium-store':{price:0,durationDays:30},'auto-comment-jaseb':{price:0,durationDays:30},'tagall':{price:0,durationDays:30},'archive-store':{price:0,durationDays:30}},purchases:{},deposits:{},tenants:{},settings:{storeName:'Telegram SaaS',welcomeMessage:'👋 Selamat datang! Pilih bot yang ingin kamu gunakan.',bannerFileId:null,bannerType:'photo',bannerCaption:'',stickerFileId:null,qrisFileId:null,qrisCaption:'Scan QRIS lalu kirim bukti pembayaran.',disabledBots:[]}};
let backupHook=null;
let backupSuspended=false;
let state; try{state=JSON.parse(fs.readFileSync(file,'utf8'));}catch{state=structuredClone(base);save();}
function save(){const t=file+'.tmp';fs.writeFileSync(t,JSON.stringify(state,null,2));fs.renameSync(t,file);try{if(!backupSuspended&&backupHook)backupHook('saas-state-change')}catch{}}
function setBackupHook(fn){backupHook=typeof fn==='function'?fn:null}
const k=id=>String(id);
function user(id,patch={}){const key=k(id); if(!state.users[key])state.users[key]={id:Number(id),balance:0,createdAt:Date.now()}; Object.assign(state.users[key],patch); save(); return state.users[key]}
function getUser(id){return state.users[k(id)]||null}
function addAdmin(id){if(!state.admins.includes(Number(id)))state.admins.push(Number(id));save()}
function isAdmin(id){return Number(id)===Number(process.env.SAAS_OWNER_ID)||state.admins.includes(Number(id))}
function listAdmins(){return [...new Set([Number(process.env.SAAS_OWNER_ID),...state.admins].filter(Number.isFinite))]}
function addBalance(id,amount,meta={}){const u=user(id);u.balance=Number(u.balance||0)+Number(amount);u.updatedAt=Date.now();if(meta.depositId)meta.deposits=state.deposits;save();return u}
function purchase(p){const id='PUR-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,7).toUpperCase();state.purchases[id]={id,...p,createdAt:Date.now()};save();return state.purchases[id]}
function deposit(d){const id='DEP-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,7).toUpperCase();state.deposits[id]={id,status:'pending',...d,createdAt:Date.now()};save();return state.deposits[id]}
function getDeposit(id){return state.deposits[id]}
function updateDeposit(id,patch){if(!state.deposits[id])return null;Object.assign(state.deposits[id],patch, {updatedAt:Date.now()});save();return state.deposits[id]}
function tenant(id){return state.tenants[id]||null}
function setTenant(id,data){state.tenants[id]=Object.assign(state.tenants[id]||{},data,{updatedAt:Date.now()});save();return state.tenants[id]}
function listTenants(ownerId=null){return Object.values(state.tenants).filter(x=>ownerId==null||String(x.ownerId)===String(ownerId))}
function removeTenant(id){if(!state.tenants[id])return false;delete state.tenants[id];save();return true}
function disableBot(id){if(!state.settings.disabledBots.includes(id))state.settings.disabledBots.push(id);save()}
function enableBot(id){state.settings.disabledBots=state.settings.disabledBots.filter(x=>x!==id);save()}
function isBotEnabled(id){return !state.settings.disabledBots.includes(id)}
function settings(){return state.settings}
function setSetting(k,v){state.settings[k]=v;save()}
function plans(){return state.plans}
function setPlan(id,p){state.plans[id]=Object.assign(state.plans[id]||{},p);save()}
function raw(){return state}
function reload(){try{state=JSON.parse(fs.readFileSync(file,'utf8'));return state}catch{return state}}
function suspendBackupHooks(on=true){backupSuspended=!!on}
module.exports={save,user,getUser,addAdmin,isAdmin,listAdmins,addBalance,purchase,deposit,getDeposit,updateDeposit,tenant,setTenant,listTenants,removeTenant,disableBot,enableBot,isBotEnabled,settings,setSetting,plans,setPlan,raw,reload,setBackupHook,suspendBackupHooks};
