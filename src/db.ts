/**
 * KACHIBOT — persistence.
 * Two interchangeable backends behind one tiny interface:
 *  - Supabase (Postgres jsonb) when SUPABASE_URL + SUPABASE_KEY are set:
 *    tables kachi_users(user_id text pk, doc jsonb, updated_at),
 *           kachi_trades(id text pk, user_id text, doc jsonb, updated_at).
 *    (DDL in supabase/schema.sql)
 *  - otherwise one local JSON file — zero infra, free-tier friendly.
 */
import fs from 'node:fs';
import { SUPABASE_URL, SUPABASE_KEY, DB_FILE, DATA_DIR } from './config';
import { UserDoc, TradeRow, freshUser, ensureSettings } from './types';

export interface Store {
  getUser(userId: number): Promise<UserDoc>;
  saveUser(doc: UserDoc): Promise<void>;
  listUsers(): Promise<UserDoc[]>;
  listTrades(userId: number, status?: 'open' | 'closed' | 'failed', limit?: number): Promise<TradeRow[]>;
  putTrade(row: TradeRow): Promise<void>;
  closeTrade(id: string, patch: Partial<TradeRow>): Promise<void>;
  /** await durability of every pending write (used on shutdown / critical paths) */
  flush(): Promise<void>;
}

/* ------------------------------ local file ------------------------------ */

interface FileShape { users: Record<string, UserDoc>; trades: TradeRow[]; }

class FileStore implements Store {
  private data: FileShape;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.data = { users: {}, trades: [] };
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        this.data = { users: raw.users || {}, trades: raw.trades || [] };
      } catch (e) {
        console.error(`[db] could not parse ${DB_FILE} — starting fresh (${(e as Error).message})`);
      }
    }
  }
  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    this.writeQueue = this.writeQueue
      .then(async () => {
        const tmp = `${DB_FILE}.tmp`;
        await fs.promises.writeFile(tmp, snapshot);
        await fs.promises.rename(tmp, DB_FILE);
      })
      .catch((e) => console.error('[db] write failed:', (e as Error).message));
    return this.writeQueue;
  }
  async getUser(userId: number): Promise<UserDoc> {
    const d = this.data.users[String(userId)];
    if (!d) {
      const fresh = freshUser(userId);
      this.data.users[String(userId)] = fresh;
      await this.persist();
      return fresh;
    }
    return d;
  }
  async listUsers(): Promise<UserDoc[]> {
    return Object.values(this.data.users);
  }
  async saveUser(doc: UserDoc): Promise<void> {
    this.data.users[String(doc.userId)] = doc;
    await this.persist();
  }
  async listTrades(userId: number, status?: 'open' | 'closed' | 'failed', limit = 500): Promise<TradeRow[]> {
    let rows = this.data.trades.filter((t) => t.userId === userId);
    if (status) rows = rows.filter((t) => t.status === status);
    rows.sort((a, b) => b.entryTime - a.entryTime);
    return rows.slice(0, limit);
  }
  async putTrade(row: TradeRow): Promise<void> {
    const idx = this.data.trades.findIndex((t) => t.id === row.id);
    if (idx >= 0) this.data.trades[idx] = row; else this.data.trades.push(row);
    await this.persist();
  }
  async closeTrade(id: string, patch: Partial<TradeRow>): Promise<void> {
    const t = this.data.trades.find((r) => r.id === id);
    if (!t) return;
    Object.assign(t, patch);
    await this.persist();
  }
  async flush(): Promise<void> {
    await this.persist();
  }
}

/* -------------------------------- supabase ------------------------------ */

interface SbRow { id?: string; user_id?: string; doc: UserDoc | TradeRow; }

/**
 * Supabase store with an in-memory layer so Telegram replies never wait on
 * the network:
 *  - getUser: cached after first load (single-flight fetch)
 *  - saveUser: updates cache instantly, debounced background upsert (~250ms)
 *  - trades: money-critical writes stay awaited; reads cached 2.5s
 *  - flush(): await everything pending (shutdown / wallet-secret flows)
 */
class SupabaseStore implements Store {
  private sb: import('@supabase/supabase-js').SupabaseClient;
  private userCache = new Map<string, UserDoc>();
  private userLoading = new Map<string, Promise<UserDoc>>();
  private dirtyUsers = new Set<string>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private writeChain = new Map<string, Promise<void>>();
  private tradesCache = new Map<string, { at: number; rows: TradeRow[] }>();

  constructor() {
    const { createClient } = require('@supabase/supabase-js') as typeof import('@supabase/supabase-js');
    // Node <22 has no native WebSocket — give supabase realtime the `ws` transport
    let transport: unknown = undefined;
    try { transport = require('ws'); } catch { /* Node >=22: native WebSocket is used */ }
    const opts = transport ? { realtime: { transport } } : {};
    this.sb = createClient(SUPABASE_URL, SUPABASE_KEY, opts as never);
  }
  private tableHint(err: unknown): void {
    const msg = String((err as { message?: string })?.message || err);
    if (/relation .* does not exist|does not exist/i.test(msg)) {
      console.error('[db] Supabase tables missing — create them with supabase/schema.sql (see README)');
    }
  }
  private upsertUser(key: string): Promise<void> {
    const doc = this.userCache.get(key);
    if (!doc) return Promise.resolve();
    const prev = this.writeChain.get(key) || Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() =>
        this.sb
          .from('kachi_users')
          .upsert({ user_id: key, doc, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
          .then(({ error }) => { if (error) { this.tableHint(error); throw error; } }),
      )
      .catch((e) => console.error(`[db] user write failed (${key}):`, (e as Error).message));
    this.writeChain.set(key, run);
    return run;
  }
  private scheduleFlush(key: string): void {
    this.dirtyUsers.add(key);
    const existing = this.flushTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.flushTimers.delete(key);
      if (this.dirtyUsers.has(key)) {
        this.dirtyUsers.delete(key);
        void this.upsertUser(key);
      }
    }, 250);
    timer.unref?.();
    this.flushTimers.set(key, timer);
  }
  async flush(): Promise<void> {
    for (const key of [...this.flushTimers.keys()]) {
      const t = this.flushTimers.get(key);
      if (t) clearTimeout(t);
      this.flushTimers.delete(key);
    }
    for (const key of [...this.dirtyUsers]) {
      this.dirtyUsers.delete(key);
      void this.upsertUser(key);
    }
    await Promise.all([...this.writeChain.values()]);
  }

  async getUser(userId: number): Promise<UserDoc> {
    const key = String(userId);
    const cached = this.userCache.get(key);
    if (cached) return cached;
    const loading = this.userLoading.get(key);
    if (loading) return loading;
    const p = (async (): Promise<UserDoc> => {
      const { data, error } = await this.sb
        .from('kachi_users').select('doc').eq('user_id', key).maybeSingle();
      if (error) { this.tableHint(error); throw error; }
      if (!data?.doc) {
        const fresh = freshUser(userId);
        this.userCache.set(key, fresh);
        this.scheduleFlush(key);
        return fresh;
      }
      const doc = data.doc as UserDoc;
      ensureSettings(doc.settings);
      this.userCache.set(key, doc);
      return doc;
    })();
    this.userLoading.set(key, p);
    try { return await p; } finally { this.userLoading.delete(key); }
  }
  async listUsers(): Promise<UserDoc[]> {
    if (this.userCache.size > 0) return [...this.userCache.values()];
    const { data, error } = await this.sb.from('kachi_users').select('doc').limit(500);
    if (error) { this.tableHint(error); throw error; }
    const users = (data || []).map((r: SbRow) => r.doc as UserDoc);
    for (const u of users) { ensureSettings(u.settings); this.userCache.set(String(u.userId), u); }
    return users;
  }
  async saveUser(doc: UserDoc): Promise<void> {
    const key = String(doc.userId);
    this.userCache.set(key, doc);
    this.scheduleFlush(key);
  }
  private invalidateTrades(userId: string): void {
    this.tradesCache.delete(userId);
  }
  async listTrades(userId: number, status?: 'open' | 'closed' | 'failed', limit = 500): Promise<TradeRow[]> {
    const key = String(userId);
    const hit = this.tradesCache.get(key);
    if (hit && Date.now() - hit.at < 2500) {
      let rows = hit.rows;
      if (status) rows = rows.filter((t) => t.status === status);
      rows.sort((a, b) => b.entryTime - a.entryTime);
      return rows.slice(0, limit);
    }
    const { data, error } = await this.sb
      .from('kachi_trades').select('doc').eq('user_id', key).limit(Math.min(limit, 1000));
    if (error) { this.tableHint(error); throw error; }
    let rows = (data || []).map((r: SbRow) => r.doc as TradeRow);
    this.tradesCache.set(key, { at: Date.now(), rows: [...rows] });
    if (status) rows = rows.filter((t) => t.status === status);
    rows.sort((a, b) => b.entryTime - a.entryTime);
    return rows.slice(0, limit);
  }
  async putTrade(row: TradeRow): Promise<void> {
    this.invalidateTrades(String(row.userId));
    const { error } = await this.sb
      .from('kachi_trades')
      .upsert({ id: row.id, user_id: String(row.userId), doc: row, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) this.tableHint(error);
    if (error) throw error;
  }
  async closeTrade(id: string, patch: Partial<TradeRow>): Promise<void> {
    const { data } = await this.sb.from('kachi_trades').select('doc').eq('id', id).maybeSingle();
    if (!data?.doc) return;
    const merged = { ...(data.doc as TradeRow), ...patch };
    await this.putTrade(merged);
  }
}

let instance: Store | null = null;
export function getStore(): Store {
  if (!instance) {
    instance = SUPABASE_URL && SUPABASE_KEY ? new SupabaseStore() : new FileStore();
    console.log(`[db] using ${SUPABASE_URL && SUPABASE_KEY ? 'Supabase (postgres jsonb)' : 'local JSON file'} store`);
  }
  return instance;
}
