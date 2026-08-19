const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
function writeBackup(){ const file=path.join(config.dataDir,`backup_${Date.now()}.json`); fs.writeFileSync(file,JSON.stringify(db.exportAll(),null,2)); return file; }
function readBackup(file){ return db.importAll(JSON.parse(fs.readFileSync(file,'utf8'))); }
module.exports={writeBackup,readBackup};
