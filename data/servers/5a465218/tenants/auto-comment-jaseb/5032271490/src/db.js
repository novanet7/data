const fs=require('fs');
const path=require('path');
const DATA_DIR=path.join(__dirname,'..','data');
const FILE=path.join(DATA_DIR,'app.json');
fs.mkdirSync(DATA_DIR,{recursive:true});
const base={users:[],accounts:[],keywords:[],targets:[],logs:[],sender:{},sent:[],meta:{},jaseb:{}};
let db;
try{db=JSON.parse(fs.readFileSync(FILE,'utf8'));}catch{db=structuredClone(base);save();}
for(const k of Object.keys(base)) if(db[k]===undefined) db[k]=structuredClone(base[k]);
function save(){const tmp=FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db,null,2));fs.renameSync(tmp,FILE);}
function now(){return Math.floor(Date.now()/1000)}
function id(arr){return arr.length?Math.max(...arr.map(x=>Number(x.id)||0))+1:1}
function ensureUser(tgId,role='user'){let u=db.users.find(x=>String(x.telegram_id)===String(tgId));if(!u){u={telegram_id:String(tgId),role,enabled:1,expires_at:role==='owner'?null:0,created_at:now()};db.users.push(u);save();} else if(role==='owner'&&u.role!=='owner'){u.role='owner';u.enabled=1;u.expires_at=null;save();}return u}
function getUser(tgId){return db.users.find(x=>String(x.telegram_id)===String(tgId))||null}
function active(u){return !!u&&(u.role==='owner'||(u.enabled===1&&Number(u.expires_at)>now()))}
function addPremium(tgId,weeks){let u=ensureUser(tgId,'user');const from=Math.max(now(),Number(u.expires_at)||0);u.expires_at=from+weeks*7*86400;u.enabled=1;save();return u}
function disableExpired(){let changed=false;for(const u of db.users){if(u.role!=='owner'&&u.enabled===1&&Number(u.expires_at)<=now()){u.enabled=0;changed=true;}}if(changed)save()}
function listUsers(){return [...db.users]}
function accounts(owner){return db.accounts.filter(a=>String(a.owner_id)===String(owner)&&a.enabled===1)}
function addAccount(owner,data){const a={id:id(db.accounts),owner_id:String(owner),enabled:1,created_at:now(),...data};db.accounts.push(a);save();return a}
function getAccount(owner,accountId){return accounts(owner).find(a=>Number(a.id)===Number(accountId))||null}
function removeAccount(owner,accountId){const a=db.accounts.find(a=>String(a.owner_id)===String(owner)&&Number(a.id)===Number(accountId));if(!a)return false;a.enabled=0;save();return a}
function listKeywords(owner){return db.keywords.filter(k=>String(k.owner_id)===String(owner)&&k.enabled!==0)}
function addKeyword(owner,word,comment,targetId=null){const cleanWord=String(word||'').replace(/\s+/g,' ').trim();const k={id:id(db.keywords),owner_id:String(owner),target_id:targetId==null?null:Number(targetId),word:cleanWord,comment:String(comment),enabled:1,created_at:now()};db.keywords.push(k);save();return k}
function listKeywordsForTarget(owner,targetId){const rows=db.keywords.filter(k=>String(k.owner_id)===String(owner)&&k.enabled!==0);return rows.filter(k=>k.target_id==null||Number(k.target_id)===Number(targetId));}
function delKeyword(owner,kid){const k=db.keywords.find(x=>String(x.owner_id)===String(owner)&&Number(x.id)===Number(kid));if(!k)return false;k.enabled=0;save();return true}
function listTargets(owner){return db.targets.filter(t=>String(t.owner_id)===String(owner)&&t.enabled!==0)}
function addTarget(owner,data){const t={id:id(db.targets),owner_id:String(owner),enabled:1,created_at:now(),...data};db.targets.push(t);save();return t}
function delTarget(owner,tid){const t=db.targets.find(x=>String(x.owner_id)===String(owner)&&Number(x.id)===Number(tid));if(!t)return false;t.enabled=0;save();return true}
function getSender(owner){return db.sender[String(owner)]||null}
function getMeta(owner,key){const bucket=db.meta[String(owner)]||{}; return bucket[String(key)];}
function setMeta(owner,key,value){const id=String(owner); if(!db.meta[id]) db.meta[id]={}; db.meta[id][String(key)]=value; save(); return value;}
function setSender(owner,s){db.sender[String(owner)]={...(db.sender[String(owner)]||{}),...s};save();return db.sender[String(owner)]}

function getJaseb(owner){return db.jaseb[String(owner)]||null}
function setJaseb(owner,value){db.jaseb[String(owner)]={...(db.jaseb[String(owner)]||{}),...value};save();return db.jaseb[String(owner)]}
function clearJaseb(owner){delete db.jaseb[String(owner)];save()}
function addJasebMessage(owner,data){const k=String(owner);if(!db.jaseb[k])db.jaseb[k]={};if(!Array.isArray(db.jaseb[k].messages))db.jaseb[k].messages=[];db.jaseb[k].messages.push({...data,created_at:now()});if(db.jaseb[k].messages.length>500)db.jaseb[k].messages.splice(0,db.jaseb[k].messages.length-500);save();return data}
function getJasebMessages(owner){const v=db.jaseb[String(owner)];return Array.isArray(v?.messages)?[...v.messages]:[]}
function clearJasebMessages(owner){const k=String(owner);if(db.jaseb[k]){db.jaseb[k].messages=[];save();}}
function log(owner,type,status,message,extra={}){db.logs.push({id:id(db.logs),owner_id:String(owner),type,status,message:String(message||''),created_at:now(),...extra});if(db.logs.length>10000)db.logs.splice(0,db.logs.length-10000);save()}
function logs(owner,limit=30){return db.logs.filter(l=>String(l.owner_id)===String(owner)&&l.type!=='ui').sort((a,b)=>b.id-a.id).slice(0,limit)}
function clearLogs(owner){db.logs=db.logs.filter(l=>String(l.owner_id)!==String(owner));save()}
function allAccounts(){return db.accounts.filter(a=>a.enabled===1)}
function sentKey(owner,keyValue){return db.sent.some(x=>String(x.owner_id)===String(owner)&&x.key===String(keyValue))}
function markSent(owner,keyValue,meta={}){if(sentKey(owner,keyValue))return false;db.sent.push({owner_id:String(owner),key:String(keyValue),created_at:now(),...meta});if(db.sent.length>20000)db.sent.splice(0,db.sent.length-20000);save();return true}
function stats(owner){const rows=db.logs.filter(l=>String(l.owner_id)===String(owner)&&l.type!=='ui');return {total:rows.length,raw:rows.filter(l=>l.type==='monitor'&&(l.status==='raw'||l.status==='event')).length,sent:rows.filter(l=>l.type==='comment'&&l.status==='success').length,matched:rows.filter(l=>l.status==='match').length,errors:rows.filter(l=>l.status==='error').length,skipped:rows.filter(l=>l.status==='skip').length,ready:rows.filter(l=>l.type==='monitor'&&l.status==='ready').length,lastSent:rows.find(l=>l.type==='comment'&&l.status==='success')||null,lastEvent:rows[0]||null}}
module.exports={now,save,ensureUser,getUser,active,addPremium,disableExpired,listUsers,accounts,addAccount,getAccount,removeAccount,listKeywords,listKeywordsForTarget,addKeyword,delKeyword,listTargets,addTarget,delTarget,getSender,setSender,getJaseb,setJaseb,clearJaseb,addJasebMessage,getJasebMessages,clearJasebMessages,getMeta,setMeta,log,logs,clearLogs,allAccounts,sentKey,markSent,stats};
