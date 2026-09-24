import net from 'net';
import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { G2W, W2G } from './types.js';

/**
 * Where the socket lived before 2026-09. Kept only so a stale file from an older build gets
 * cleaned up on start — nothing connects here anymore.
 */
const LEGACY_IPC_SOCKET_PATH = '/tmp/claw-ipc.sock';

/**
 * Resolved at call time so the gateway and the worker it spawns agree on one path.
 *
 * Under DATA_DIR rather than /tmp: `onWorkerConnect` accepts whoever connects as *the* worker,
 * and W2G messages like `discord.send.file` make the gateway read an arbitrary path and upload
 * it. A sandboxed engine runs under the same uid, so file mode alone would not keep it out —
 * the path has to sit inside a directory its sandbox profile denies.
 */
export function ipcSocketPath(): string {
  const explicit = process.env['SIMPLECLAW_IPC_SOCKET'];
  if (explicit) return explicit;
  const dataDir = process.env['DATA_DIR'] ?? path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'ipc.sock');
}

export class GatewayIpc extends EventEmitter {
  private server: net.Server;
  private workerSocket: net.Socket | null = null;
  private workerProcess: ChildProcess | null = null;
  private workerReady = false;
  private draining = false;
  private eventBuffer: G2W[] = [];
  private discordHandler: ((req: W2G) => Promise<void>) | null = null;
  private readonly workerBin: string;
  private readonly workerCwd: string;
  private readonly workerEnv: NodeJS.ProcessEnv;
  private readonly socketPath: string;
  private stopping = false;

  constructor(opts: { workerBin: string; cwd: string; env?: NodeJS.ProcessEnv }) {
    super();
    this.workerBin = opts.workerBin;
    this.workerCwd = opts.cwd;
    this.workerEnv = opts.env ?? process.env;
    this.socketPath = ipcSocketPath();
    this.server = net.createServer((socket) => this.onWorkerConnect(socket));
  }

  async start(): Promise<void> {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
    try { fs.unlinkSync(LEGACY_IPC_SOCKET_PATH); } catch { /* ignore */ }
    await new Promise<void>((resolve, reject) => {
      this.server.listen(this.socketPath, () => resolve());
      this.server.once('error', reject);
    });
    this.spawnWorker();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.workerProcess?.kill('SIGTERM');
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
  }

  setDiscordHandler(fn: (req: W2G) => Promise<void>): void {
    this.discordHandler = fn;
  }

  /** Buffer or forward a Discord event to Worker */
  forwardEvent(event: G2W): void {
    if (!this.workerReady || this.draining) {
      this.eventBuffer.push(event);
      return;
    }
    this.sendToWorker(event);
  }

  sendToWorker(msg: G2W): void {
    if (!this.workerSocket || this.workerSocket.destroyed) return;
    try {
      this.workerSocket.write(JSON.stringify(msg) + '\n');
    } catch { /* ignore */ }
  }

  private onWorkerConnect(socket: net.Socket): void {
    this.workerSocket = socket;
    let buf = '';
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handleWorkerMessage(JSON.parse(line) as W2G);
        } catch (err) {
          console.error('[gateway-ipc] parse error', err, line);
        }
      }
    });
    socket.on('close', () => {
      this.workerSocket = null;
      this.workerReady = false;
    });
    socket.on('error', (err) => {
      console.error('[gateway-ipc] socket error', err);
    });
  }

  private handleWorkerMessage(msg: W2G): void {
    if (msg.type === 'worker.ready') {
      console.log('[gateway-ipc] worker ready');
      this.workerReady = true;
      this.draining = false;
      this.emit('worker:ready');
      this.flushBuffer();
    } else if (msg.type === 'worker.drain') {
      console.log('[gateway-ipc] worker draining');
      this.draining = true;
    } else {
      // Discord API request from Worker — dispatch to handler
      this.discordHandler?.(msg).catch((err) => {
        console.error('[gateway-ipc] discord handler error', err);
      });
    }
  }

  private flushBuffer(): void {
    const events = [...this.eventBuffer];
    this.eventBuffer = [];
    if (events.length > 0) {
      console.log(`[gateway-ipc] flushing ${events.length} buffered events`);
    }
    for (const event of events) {
      this.sendToWorker(event);
    }
  }

  private spawnWorker(): void {
    if (this.stopping) return;
    console.log('[gateway-ipc] spawning worker:', this.workerBin);
    this.workerReady = false;
    const child = spawn('node', [this.workerBin], {
      cwd: this.workerCwd,
      // Pin the worker to the path we actually bound, so a differing DATA_DIR/cwd can't
      // silently point the two halves at different sockets.
      env: { ...this.workerEnv, SIMPLECLAW_IPC_SOCKET: this.socketPath },
      stdio: 'inherit',
    });
    this.workerProcess = child;
    child.on('exit', (code, signal) => {
      if (this.stopping) return;
      console.log(`[gateway-ipc] worker exited code=${code} signal=${signal}`);
      this.workerSocket = null;
      this.workerReady = false;
      if (this.draining) {
        // Intentional drain exit — restart gateway so launchd respawns with updated code.
        // SIGTERM triggers the graceful shutdown handler in server.ts; launchd KeepAlive
        // restarts the whole gateway (server.js + fresh worker) with the latest dist/.
        console.log('[gateway-ipc] drain complete, sending SIGTERM to gateway for full restart');
        this.draining = false;
        process.kill(process.pid, 'SIGTERM');
      } else if (code !== 0 || signal != null) {
        // Crash — respawn after short delay
        console.warn(`[gateway-ipc] worker crashed, respawning in 2s`);
        setTimeout(() => this.spawnWorker(), 2000);
      }
      // code === 0 without drain = clean SIGTERM during gateway shutdown
    });
  }
}
