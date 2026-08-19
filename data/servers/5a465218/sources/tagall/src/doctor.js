const config=require('./config');
const major=Number(process.versions.node.split('.')[0]);
if(major<22) throw new Error(`Node.js 22+ diperlukan. Saat ini v${process.versions.node}`);
try{require('node:sqlite');}catch{throw new Error('node:sqlite tidak tersedia. Gunakan Node.js 22.');}
console.log(`✅ Node.js v${process.versions.node}`);
console.log('✅ Built-in SQLite: tersedia');
console.log(`✅ BOT_TOKEN: ${config.botToken?'terisi':'kosong'}`);
console.log(`✅ TARGET_GROUP_LINKS: ${config.targetLinks.length} target`);
console.log(`✅ API_ID: ${config.apiId?'terisi':'kosong'} | API_HASH: ${config.apiHash?'terisi':'kosong'}`);
