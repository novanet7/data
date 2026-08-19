const store = require('./store');
const { config, validate } = require('./config');
const { AccountManager } = require('./telegramClient');
const { AdminBot } = require('./adminBot');

(async () => {
  try {
    validate();
    store.ensure();
    const accounts = new AccountManager();
    await accounts.startAll();
    const admin = new AdminBot(accounts);
    admin.setup();
    await admin.launch();
    process.once('SIGINT', () => admin.bot.stop('SIGINT'));
    process.once('SIGTERM', () => admin.bot.stop('SIGTERM'));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
