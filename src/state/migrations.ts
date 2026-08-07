import type Database from 'better-sqlite3';

interface Migration {
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    name: '001_init',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        thread_id          TEXT PRIMARY KEY,
        claude_session_id  TEXT NOT NULL,
        repo               TEXT NOT NULL,
        cwd                TEXT NOT NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mail_state (
        account            TEXT PRIMARY KEY,
        last_history_id    TEXT,
        last_polled_at     TEXT
      );

      CREATE TABLE IF NOT EXISTS sender_policies (
        email              TEXT NOT NULL,
        account            TEXT NOT NULL,
        policy             TEXT NOT NULL,
        reason             TEXT,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (email, account)
      );

      CREATE TABLE IF NOT EXISTS mail_threads (
        discord_thread_id  TEXT PRIMARY KEY,
        gmail_msg_id       TEXT NOT NULL,
        gmail_thread_id    TEXT NOT NULL,
        account            TEXT NOT NULL,
        subject            TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'awaiting_user',
        created_at         TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                 TEXT NOT NULL,
        type               TEXT NOT NULL,
        channel            TEXT,
        thread_id          TEXT,
        summary            TEXT NOT NULL,
        meta_json          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id);
      CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(type, ts);
    `,
  },
  {
    name: '002_session_analyses',
    sql: `
      CREATE TABLE IF NOT EXISTS session_analyses (
        source_thread_id   TEXT PRIMARY KEY,
        analysis_session_id TEXT NOT NULL,
        analyzed_at        TEXT NOT NULL,
        user_msg_count     INTEGER NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending'
      );
    `,
  },
  {
    name: '003_message_queue',
    sql: `
      CREATE TABLE IF NOT EXISTS message_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  TEXT NOT NULL,
        message_id  TEXT NOT NULL UNIQUE,
        queued_at   TEXT NOT NULL
      );
    `,
  },
  {
    name: '004_session_skill_cache',
    sql: `
      ALTER TABLE sessions ADD COLUMN last_skill TEXT;
      ALTER TABLE sessions ADD COLUMN last_response TEXT;
    `,
  },
  {
    name: '005_events_fts',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        summary,
        content='events',
        content_rowid='id',
        tokenize='unicode61'
      );

      INSERT INTO events_fts(events_fts) VALUES('rebuild');

      CREATE TRIGGER IF NOT EXISTS events_fts_ins AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, summary) VALUES (new.id, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_upd AFTER UPDATE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
        INSERT INTO events_fts(rowid, summary) VALUES (new.id, new.summary);
      END;
      CREATE TRIGGER IF NOT EXISTS events_fts_del AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts, rowid, summary) VALUES ('delete', old.id, old.summary);
      END;
    `,
  },
  {
    name: '006_skill_proposals',
    sql: `
      CREATE TABLE IF NOT EXISTS skill_proposals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL,
        kind            TEXT NOT NULL,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL,
        content         TEXT NOT NULL,
        repo_full_name  TEXT,
        source_thread_id TEXT,
        status          TEXT NOT NULL DEFAULT 'pending'
      );
    `,
  },
  {
    name: '007_memory_system',
    sql: `
      -- Layer 1: 단기 후보 (7일 TTL)
      CREATE TABLE IF NOT EXISTS memories_candidate (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'general',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 50,
        expires_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'explicit',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, key)
      );

      -- Layer 1 관계 (그래프 엣지)
      CREATE TABLE IF NOT EXISTS candidate_edges (
        id_a INTEGER NOT NULL REFERENCES memories_candidate(id) ON DELETE CASCADE,
        id_b INTEGER NOT NULL REFERENCES memories_candidate(id) ON DELETE CASCADE,
        relation TEXT NOT NULL DEFAULT 'related',
        PRIMARY KEY(id_a, id_b)
      );

      -- Layer 2: 장기 기억
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'general',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        score REAL NOT NULL DEFAULT 50,
        reference_count INTEGER NOT NULL DEFAULT 0,
        last_referenced_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        promoted_from INTEGER,
        source TEXT NOT NULL DEFAULT 'explicit',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, key)
      );

      -- Layer 2 FTS
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        value, tags,
        content='memories',
        content_rowid='id',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS memories_fts_ins AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, value, tags) VALUES (new.id, new.value, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_upd AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, value, tags) VALUES ('delete', old.id, old.value, old.tags);
        INSERT INTO memories_fts(rowid, value, tags) VALUES (new.id, new.value, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_del AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, value, tags) VALUES ('delete', old.id, old.value, old.tags);
      END;

      -- 점수 감사 로그 (Layer 1 + 2 통합)
      CREATE TABLE IF NOT EXISTS memory_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER,
        layer TEXT NOT NULL,
        event_type TEXT NOT NULL,
        delta REAL NOT NULL DEFAULT 0,
        thread_id TEXT,
        created_at TEXT NOT NULL
      );

      -- Discord 메시지 → 참조된 메모리 매핑 (✅/❌ 리액션 처리용)
      CREATE TABLE IF NOT EXISTS memory_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_message_id TEXT NOT NULL,
        memory_id INTEGER NOT NULL,
        layer TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_refs_msg ON memory_references(discord_message_id);
    `,
  },
  {
    name: '008_memory_references_thread_id',
    sql: `
      ALTER TABLE memory_references ADD COLUMN thread_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_memory_refs_thread ON memory_references(thread_id);
    `,
  },
  {
    name: '009_memory_embeddings',
    sql: `
      ALTER TABLE memories ADD COLUMN embedding TEXT;
    `,
  },
  {
    name: '010_mail_threads_message_id',
    sql: `
      ALTER TABLE mail_threads ADD COLUMN discord_message_id TEXT;
    `,
  },
  {
    name: '011_github_issue_state',
    sql: `
      CREATE TABLE IF NOT EXISTS github_issue_state (
        repo               TEXT PRIMARY KEY,
        last_issue_number  INTEGER NOT NULL DEFAULT 0,
        last_polled_at     TEXT
      );
    `,
  },
  {
    name: '012_github_issue_threads',
    sql: `
      CREATE TABLE IF NOT EXISTS github_issue_threads (
        repo               TEXT NOT NULL,
        issue_number       INTEGER NOT NULL,
        discord_thread_id  TEXT NOT NULL,
        discord_message_id TEXT,
        created_at         TEXT NOT NULL,
        PRIMARY KEY (repo, issue_number)
      );
    `,
  },
  {
    name: '013_github_issue_auto_solve',
    sql: `
      ALTER TABLE github_issue_threads ADD COLUMN auto_solve_status TEXT;
      ALTER TABLE github_issue_threads ADD COLUMN auto_solve_pr_url TEXT;
    `,
  },
  {
    name: '014_github_pr_tracking',
    sql: `
      CREATE TABLE IF NOT EXISTS github_pr_state (
        repo             TEXT PRIMARY KEY,
        last_pr_number   INTEGER NOT NULL DEFAULT 0,
        last_polled_at   TEXT
      );

      CREATE TABLE IF NOT EXISTS github_pr_threads (
        repo               TEXT NOT NULL,
        pr_number          INTEGER NOT NULL,
        discord_thread_id  TEXT NOT NULL,
        discord_message_id TEXT,
        created_at         TEXT NOT NULL,
        PRIMARY KEY (repo, pr_number)
      );
    `,
  },
  {
    name: '015_usage_ledger',
    sql: `
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                   TEXT NOT NULL,
        session_id           TEXT NOT NULL,
        context_window_used  INTEGER NOT NULL DEFAULT 0,
        context_window_max   INTEGER NOT NULL DEFAULT 0,
        cost_usd             REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_ts ON usage_ledger(ts);
    `,
  },
  {
    name: '016_imessage_state',
    sql: `
      CREATE TABLE IF NOT EXISTS imessage_state (
        id             INTEGER PRIMARY KEY DEFAULT 1,
        last_row_id    INTEGER NOT NULL DEFAULT 0,
        last_polled_at TEXT
      );
    `,
  },
  {
    name: '017_background_jobs',
    sql: `
      CREATE TABLE IF NOT EXISTS background_jobs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id       TEXT NOT NULL,
        description     TEXT NOT NULL,
        check_cmd       TEXT NOT NULL,
        cwd             TEXT NOT NULL,
        done_message    TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TEXT NOT NULL,
        checked_at      TEXT,
        expires_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_background_jobs_status ON background_jobs(status);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL
    );
  `);

  const isApplied = db.prepare<[string], { name: string }>(
    'SELECT name FROM _migrations WHERE name = ?',
  );
  const recordApplied = db.prepare<[string, string]>(
    'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
  );

  for (const migration of MIGRATIONS) {
    const existing = isApplied.get(migration.name);
    if (existing) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      recordApplied.run(migration.name, new Date().toISOString());
    });
    apply();
  }
}
