// ============================================================================
// ISLAND OPS — online smoke test against a real server process.
//   npx tsx scripts/iocheck.mts
//
// Starts server/index.ts on a spare port, then two scripted players create and
// join a room, start with a bot in the empty seat, check the fog, have a bad
// order set rejected, ready up (the round only resolves once both are in),
// trade an emote, and reconnect into a seat with the saved token.
// ============================================================================

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 18000 + Math.floor(Math.random() * 1000);
// Run the server under node directly (not via npx) so killing it really stops it.
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
let failures = 0;
const check = (c: boolean, m: string) => {
  console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};
const done = (code: number) => {
  server.kill();
  process.exit(code);
};
setTimeout(() => {
  console.log('FAIL  timed out');
  done(1);
}, 60000).unref();

await new Promise<void>((resolve) => server.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/io`);
  const inbox: any[] = [];
  ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
  const wait = (pred: (m: any) => boolean, ms = 8000) =>
    new Promise<any>((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const i = inbox.findIndex(pred);
        if (i >= 0) {
          clearInterval(iv);
          res(inbox.splice(i, 1)[0]);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          rej(new Error('timed out waiting for a message'));
        }
      }, 20);
    });
  return { ws, inbox, wait, send: (m: any) => ws.send(JSON.stringify(m)), open: new Promise((r) => ws.on('open', r)) };
}

const deployAll = (v: any) => {
  const mine = Object.entries(v.map).find(([, r]: any) => r.owner === v.me)![0];
  return [{ kind: 'DEPLOY', region: mine, count: v.budget.troops }];
};

try {
  const a = client(), b = client();
  await a.open;
  await b.open;
  a.send({ t: 'create', name: 'Alice', faction: 'HELANG', seats: 3, level: 'REGULAR' });
  const ja = await a.wait((m) => m.t === 'joined');
  b.send({ t: 'join', code: ja.code, name: 'Bob' });
  const jb = await b.wait((m) => m.t === 'joined');
  check(ja.you === 'HELANG' && jb.you !== 'HELANG', 'host keeps their Pasukan; the joiner gets a free one');
  a.send({ t: 'start' });
  const va = await a.wait((m) => m.t === 'view');
  const vb = await b.wait((m) => m.t === 'view');
  const lobby = await a.wait((m) => m.t === 'lobby' && m.lobby.phase === 'PLAYING');
  check(lobby.lobby.seats.length === 3 && lobby.lobby.seats.some((s: any) => s.bot && s.ready), 'a bot fills the empty seat and readies at once');
  check(Object.values(va.view.map).some((r: any) => r.intel.kind === 'hidden'), 'each player gets a fogged view');
  check(typeof lobby.lobby.deadline === 'number' && lobby.lobby.deadline > Date.now(), 'the planning clock is running');
  a.send({ t: 'orders', orders: [{ kind: 'DEPLOY', region: 'tuas', count: 999 }] });
  check((await a.wait((m) => m.t === 'error')).message.length > 0, 'an illegal order set is rejected');
  a.send({ t: 'orders', orders: deployAll(va.view) });
  await b.wait((m) => m.t === 'lobby' && m.lobby.seats.some((s: any) => s.faction === ja.you && s.ready));
  check(!a.inbox.some((m) => m.t === 'view' && m.report), 'the round waits for every human');
  b.send({ t: 'emote', text: 'Shiok!' });
  check((await a.wait((m) => m.t === 'emote')).text === 'Shiok!', 'emotes reach the table');
  b.send({ t: 'orders', orders: deployAll(vb.view) });
  const r2 = await a.wait((m) => m.t === 'view' && m.report);
  check(r2.view.round === 2 && r2.report.steps.length > 0, 'once all are in, the round resolves and the report goes out');
  a.ws.close();
  const a2 = client();
  await a2.open;
  a2.send({ t: 'reconnect', code: ja.code, token: ja.token });
  const back = await a2.wait((m) => m.t === 'view');
  check(back.view.me === 'HELANG' && back.view.round === 2, 'a reconnect lands back in the same seat');
  const c = client();
  await c.open;
  c.send({ t: 'join', code: ja.code, name: 'Late' });
  check(/already started/.test((await c.wait((m) => m.t === 'error')).message), 'nobody can join mid-game');
} catch (e) {
  console.log('FAIL ', (e as Error).message);
  failures++;
}
if (failures) console.log(`\n${failures} check(s) failed`);
done(failures ? 1 : 0);
