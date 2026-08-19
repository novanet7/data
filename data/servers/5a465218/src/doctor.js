'use strict';
const fs=require('fs');const path=require('path');
const env=path.join(__dirname,'..','.env');
require('dotenv').config({path:env});
const req=['SAAS_BOT_TOKEN','SAAS_OWNER_ID'];const miss=req.filter(k=>!process.env[k]);
if(miss.length){console.error('Missing:',miss.join(', '));process.exit(1)}
const n=Number(process.versions.node.split('.')[0]);if(n<22){console.error('Node.js 22+ diperlukan. Versi:',process.version);process.exit(1)}
for(const d of ['data','tenants','sources','emoji'])if(!fs.existsSync(path.join(__dirname,'..',d)))fs.mkdirSync(path.join(__dirname,'..',d),{recursive:true});
console.log('✅ SaaS doctor OK',process.version);
