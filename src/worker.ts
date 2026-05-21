import 'dotenv/config';

import { loadConfig } from './config.js';
import { log } from './log.js';
import { getDb, closeDb } from './state/db.js';
import { WorkerIpc } from './ipc/client.js';
import { DiscordAdapter } from './adapters/discord.js';

async function main(): Promise<void> {
  const config = loadConfig();

  log.info({ pid: process.pid }, 'SimpleClaw worker starting');

  const db = getDb(config.paths.dbFile);

  const ipc = new WorkerIpc();
  await ipc.connect();

  const discord = new DiscordAdapter({ config, db, ipc });
  discord.start();

  process.on('SIGTERM', () => {
    log.info('worker SIGTERM — stopping');
    void discord.stop().catch(() => {});
    closeDb();
    ipc.destroy();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    log.error({ err: { message: err.message, stack: err.stack } }, '[worker] uncaughtException');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, '[worker] unhandledRejection');
  });

  log.info('SimpleClaw worker running');
}

main().catch((err) => {
  log.fatal({ err: { message: (err as Error).message, stack: (err as Error).stack } }, 'fatal worker startup error');
  process.exit(1);
});
