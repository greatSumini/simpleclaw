/**
 * Minimal CDP client over Node's built-in WebSocket (no deps).
 *
 * Used by the Google Messages web bridge: attaches to the dedicated Chrome
 * instance (data/chrome-messages profile, --remote-debugging-port) and runs
 * page-level commands.
 *
 * Usage:
 *   node scripts/cdp.mjs shot <outPath>      # screenshot the active tab
 *   node scripts/cdp.mjs eval '<jsExpr>'     # evaluate JS in the active tab
 *   node scripts/cdp.mjs url <url>           # navigate the active tab
 */

const PORT = process.env.MESSAGES_CDP_PORT || '9333';
const HOST = `http://127.0.0.1:${PORT}`;

async function pickTarget() {
  const res = await fetch(`${HOST}/json/list`);
  const targets = await res.json();
  const match = process.env.MESSAGES_CDP_MATCH;
  const page = targets.find(
    (t) =>
      t.type === 'page' &&
      !t.url.startsWith('devtools://') &&
      (!match || t.url.includes(match)),
  );
  if (!page) throw new Error('no page target found on CDP port ' + PORT);
  return page;
}

export async function connect() {
  const target = await pickTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
    else entry.resolve(msg.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return { send, close: () => ws.close(), target };
}

export async function evalJs(expression) {
  const { send, close } = await connect();
  try {
    const r = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.result));
    }
    return r.result.value;
  } finally {
    close();
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'shot') {
    const { send, close } = await connect();
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(arg, Buffer.from(data, 'base64'));
    close();
    console.log(arg);
  } else if (cmd === 'eval') {
    console.log(JSON.stringify(await evalJs(arg), null, 2));
  } else if (cmd === 'url') {
    const { send, close } = await connect();
    await send('Page.navigate', { url: arg });
    close();
  } else {
    console.error('usage: cdp.mjs shot <out> | eval <js> | url <url>');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
