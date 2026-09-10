require('dotenv').config({ path: '/home/user/.env' });
const path='/home/user/dist/bot.js';
const { KachiBot } = require(path);
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'x';
const b = new KachiBot(TELEGRAM_TOKEN);

function fakeCtx(uid, cb) {
  const out = [];
  return {
    out,
    uid,
    chat: { id: uid, type: 'private' },
    callbackQuery: cb ? { message: { message_id: null } } : undefined,
    from: { id: uid },
    reply: async (text, extra) => { out.push({ text, kb: extra && extra.reply_markup ? extra.reply_markup.inline_keyboard : null }); },
    answerCbQuery: async () => {},
    telegram: { editMessageText: async () => { throw new Error('no cb msg'); } },
  };
}
const show = (ctx) => { for (const m of ctx.out) {
  console.log(m.text);
  if (m.kb) for (const r of m.kb) console.log('   [' + r.map(x=>x.text).join(' ] [ ') + ']');
  console.log('---');
}};

(async () => {
  const uid = 5768594447;
  // global exit menu
  let ctx = fakeCtx(uid, true);
  await b.showExitMenu(ctx, 'g');
  console.log('=== GLOBAL EXIT MENU ===');
  show(ctx);

  // per-watch menu (use the user's real watch id)
  const { getStore } = require('/home/user/dist/db');
  const doc = await getStore().getUser(uid);
  const w = doc.watched[0];
  ctx = fakeCtx(uid, true);
  await b.showExitMenu(ctx, w.id);
  console.log(`=== EXIT MENU for ${w.label} ===`);
  show(ctx);

  // watch detail card
  ctx = fakeCtx(uid, true);
  await b.watchDetail(ctx, w.id);
  console.log('=== WATCH CARD ===');
  show(ctx);

  // per-watch buy-size menu
  ctx = fakeCtx(uid, true);
  await b.showBuySizeMenu(ctx, w.id);
  console.log('=== BUY SIZE MENU ===');
  show(ctx);

  // settings screen
  ctx = fakeCtx(uid, true);
  await b.showSettings(ctx);
  console.log('=== SETTINGS ===');
  show(ctx);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
