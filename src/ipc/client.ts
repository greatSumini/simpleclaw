import net from 'net';
import { EventEmitter } from 'events';
import type { G2W, W2G, SerializedMessage } from './types.js';
import { IPC_SOCKET_PATH } from './server.js';

export class WorkerIpc extends EventEmitter {
  private socket: net.Socket | null = null;
  private connected = false;
  private sendBuf: W2G[] = [];
  private pending = new Map<string, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
  private stopping = false;

  async connect(): Promise<void> {
    await this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(IPC_SOCKET_PATH);
      socket.once('connect', () => {
        this.socket = socket;
        this.connected = true;
        const buf = [...this.sendBuf];
        this.sendBuf = [];
        for (const msg of buf) {
          socket.write(JSON.stringify(msg) + '\n');
        }
        resolve();
      });
      socket.once('error', (err) => {
        if (!this.connected) {
          socket.destroy();
          setTimeout(() => this.doConnect().then(resolve, reject), 500);
        } else {
          console.error('[worker-ipc] socket error', err);
        }
      });
      let buf = '';
      socket.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            this.handleGatewayMessage(JSON.parse(line) as G2W);
          } catch { /* ignore */ }
        }
      });
      socket.on('close', () => {
        this.connected = false;
        this.socket = null;
        if (!this.stopping) {
          setTimeout(() => this.doConnect().catch(() => {}), 1000);
        }
      });
    });
  }

  destroy(): void {
    this.stopping = true;
    this.socket?.destroy();
  }

  private handleGatewayMessage(msg: G2W): void {
    if (msg.type === 'ipc.ok' || msg.type === 'ipc.err') {
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      this.pending.delete(msg.reqId);
      if (msg.type === 'ipc.ok') p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    } else {
      this.emit('event', msg);
    }
  }

  ready(): void { this.rawSend({ type: 'worker.ready' }); }
  drain(): void { this.rawSend({ type: 'worker.drain' }); }

  async discordSend(channelId: string, content: string): Promise<{ messageId?: string }> {
    const reqId = this.newId();
    return this.request<{ messageId?: string }>({ type: 'discord.send', reqId, channelId, content });
  }

  async discordSendFile(channelId: string, filePath: string, caption?: string): Promise<void> {
    const reqId = this.newId();
    return this.request<void>({ type: 'discord.send.file', reqId, channelId, filePath, caption });
  }

  async discordSendUrl(channelId: string, url: string, caption?: string): Promise<void> {
    const reqId = this.newId();
    return this.request<void>({ type: 'discord.send.url', reqId, channelId, url, caption });
  }

  async discordSendComponents(channelId: string, content: string, components: unknown[]): Promise<{ messageId?: string }> {
    const reqId = this.newId();
    return this.request<{ messageId?: string }>({ type: 'discord.send.components', reqId, channelId, content, components });
  }

  async discordCreateThread(channelId: string, msgId: string, name: string): Promise<{ threadId: string }> {
    const reqId = this.newId();
    return this.request<{ threadId: string }>({ type: 'discord.thread.create', reqId, channelId, msgId, name });
  }

  async discordDeleteThread(channelId: string): Promise<void> {
    const reqId = this.newId();
    return this.request<void>({ type: 'discord.thread.delete', reqId, channelId });
  }

  discordDeleteMessage(channelId: string, msgId: string): void {
    this.rawSend({ type: 'discord.message.delete', channelId, msgId });
  }

  async discordArchiveThread(channelId: string): Promise<void> {
    const reqId = this.newId();
    return this.request<void>({ type: 'discord.thread.archive', reqId, channelId });
  }

  typingStart(channelId: string): void { this.rawSend({ type: 'discord.typing.start', channelId }); }
  typingStop(channelId: string): void { this.rawSend({ type: 'discord.typing.stop', channelId }); }

  async fetchMessage(channelId: string, msgId: string): Promise<SerializedMessage | null> {
    const reqId = this.newId();
    return this.request<SerializedMessage | null>({ type: 'discord.fetch.message', reqId, channelId, msgId });
  }

  async fetchMessages(channelId: string, limit: number, before?: string): Promise<SerializedMessage[]> {
    const reqId = this.newId();
    return this.request<SerializedMessage[]>({ type: 'discord.fetch.messages', reqId, channelId, limit, ...(before ? { before } : {}) });
  }

  async fetchStarterMessage(channelId: string): Promise<SerializedMessage | null> {
    const reqId = this.newId();
    return this.request<SerializedMessage | null>({ type: 'discord.fetch.starter', reqId, channelId });
  }

  async interactionReply(interactionId: string, token: string, content: string, ephemeral?: boolean): Promise<void> {
    const reqId = this.newId();
    return this.request<void>({ type: 'discord.interaction.reply', reqId, interactionId, token, content, ephemeral });
  }

  private async request<T>(msg: W2G & { reqId: string }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(msg.reqId)) {
          this.pending.delete(msg.reqId);
          reject(new Error(`IPC timeout: ${msg.type}`));
        }
      }, 30_000);
      this.pending.set(msg.reqId, {
        resolve: (d) => { clearTimeout(timer); resolve(d as T); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.rawSend(msg);
    });
  }

  private rawSend(msg: W2G): void {
    if (!this.connected || !this.socket) {
      this.sendBuf.push(msg);
      return;
    }
    try {
      this.socket.write(JSON.stringify(msg) + '\n');
    } catch {
      this.sendBuf.push(msg);
    }
  }

  private newId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
