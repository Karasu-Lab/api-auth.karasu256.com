import type { SecondaryStorage } from 'better-auth';
import { connect } from 'cloudflare:sockets';

type Reply = string | number | null | RedisReplyError | Reply[];

const COMMAND_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

class RedisReplyError extends Error {}

function encodeCommand(args: string[]): Uint8Array {
  let command = `*${args.length}\r\n`;
  for (const arg of args) command += `$${encoder.encode(arg).byteLength}\r\n${arg}\r\n`;
  return encoder.encode(command);
}

function findLineEnd(buffer: Uint8Array, from: number): number {
  for (let i = from; i < buffer.length - 1; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10) return i;
  }
  return -1;
}

function parseReply(buffer: Uint8Array, offset: number): { value: Reply; offset: number } | null {
  const lineEnd = findLineEnd(buffer, offset);
  if (lineEnd === -1) return null;
  const line = decoder.decode(buffer.subarray(offset + 1, lineEnd));
  const next = lineEnd + 2;
  switch (buffer[offset]) {
    case 43:
      return { value: line, offset: next };
    case 45:
      return { value: new RedisReplyError(line), offset: next };
    case 58:
      return { value: Number(line), offset: next };
    case 36: {
      const length = Number(line);
      if (length === -1) return { value: null, offset: next };
      if (buffer.length < next + length + 2) return null;
      return { value: decoder.decode(buffer.subarray(next, next + length)), offset: next + length + 2 };
    }
    case 42: {
      const count = Number(line);
      if (count === -1) return { value: null, offset: next };
      const items: Reply[] = [];
      let cursor = next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buffer, cursor);
        if (!item) return null;
        items.push(item.value);
        cursor = item.offset;
      }
      return { value: items, offset: cursor };
    }
    default:
      throw new Error('Unexpected Redis reply');
  }
}

export class RedisClient {
  private socket: Socket | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private buffer = new Uint8Array(0);
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly url: URL) {}

  command(...args: string[]): Promise<Reply> {
    const result = this.pending.then(() => this.withTimeout(this.send(args)));
    this.pending = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.writer = null;
    this.reader = null;
    this.buffer = new Uint8Array(0);
    if (socket) await socket.close().catch(() => undefined);
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Redis command timed out')), COMMAND_TIMEOUT_MS);
    });
    try {
      return await Promise.race([promise, timeout]);
    } catch (error) {
      if (!(error instanceof RedisReplyError)) await this.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(args: string[]): Promise<Reply> {
    await this.ensureConnected();
    return this.exchange(args);
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket) return;
    const socket = connect(
      { hostname: this.url.hostname, port: Number(this.url.port || 6379) },
      { secureTransport: this.url.protocol === 'rediss:' ? 'on' : 'off', allowHalfOpen: false },
    );
    this.socket = socket;
    this.writer = socket.writable.getWriter();
    this.reader = socket.readable.getReader();
    const username = decodeURIComponent(this.url.username);
    const password = decodeURIComponent(this.url.password);
    if (password) await this.exchange(username ? ['AUTH', username, password] : ['AUTH', password]);
    const database = this.url.pathname.slice(1);
    if (database) await this.exchange(['SELECT', database]);
  }

  private async exchange(args: string[]): Promise<Reply> {
    if (!this.writer) throw new Error('Redis connection closed');
    await this.writer.write(encodeCommand(args));
    return this.readReply();
  }

  private async readReply(): Promise<Reply> {
    for (;;) {
      const parsed = parseReply(this.buffer, 0);
      if (parsed) {
        this.buffer = this.buffer.subarray(parsed.offset);
        if (parsed.value instanceof RedisReplyError) throw parsed.value;
        return parsed.value;
      }
      if (!this.reader) throw new Error('Redis connection closed');
      const { value, done } = await this.reader.read();
      if (done) throw new Error('Redis connection closed');
      const merged = new Uint8Array(this.buffer.length + value.length);
      merged.set(this.buffer);
      merged.set(value, this.buffer.length);
      this.buffer = merged;
    }
  }
}

export function createRedis(env: Env): RedisClient | null {
  if (!env.REDIS_URL) return null;
  return new RedisClient(new URL(env.REDIS_URL));
}

export async function closeRedis(redis: RedisClient | null): Promise<void> {
  if (!redis) return;
  await redis.close();
}

export function redisSecondaryStorage(redis: RedisClient): SecondaryStorage {
  return {
    get: async (key) => (await redis.command('GET', key)) as string | null,
    getAndDelete: async (key) => (await redis.command('GETDEL', key)) as string | null,
    increment: async (key, ttl) => {
      const value = (await redis.command('INCR', key)) as number;
      await redis.command('EXPIRE', key, String(ttl));
      return value;
    },
    set: async (key, value, ttl) => {
      if (ttl) await redis.command('SET', key, value, 'EX', String(ttl));
      else await redis.command('SET', key, value);
    },
    delete: async (key) => {
      await redis.command('DEL', key);
    },
  };
}
