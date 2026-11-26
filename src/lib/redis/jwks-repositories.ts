import type { Jwk } from 'better-auth/plugins/jwt';
import { z } from 'zod';
import * as schema from '../../db/schema';
import { isRedisEnabled } from './cache-client';
import { RedisRepository } from './redis-repository';

const jwksSchema = z.array(
  z.object({
    id: z.string(),
    publicKey: z.string(),
    privateKey: z.string(),
    createdAt: z.coerce.date(),
    expiresAt: z.coerce
      .date()
      .nullish()
      .transform((value) => value ?? undefined),
    alg: z
      .custom<NonNullable<Jwk['alg']>>((value) => z.string().safeParse(value).success)
      .nullish()
      .transform((value) => value ?? undefined),
    crv: z
      .custom<NonNullable<Jwk['crv']>>((value) => z.string().safeParse(value).success)
      .nullish()
      .transform((value) => value ?? undefined),
  })
);

export type Jwks = z.output<typeof jwksSchema>;

export class JwksGetRepository extends RedisRepository {
  protected readonly prefix = 'jwks';

  async get(): Promise<Jwks | null> {
    const value = await this.redis.get<string>(`${this.prefix}-keys`);
    if (value === null) return null;
    const keys = jwksSchema.parse(JSON.parse(value));
    return keys.length > 0 ? keys : null;
  }
}

export class JwksCreateRepository extends RedisRepository {
  protected readonly prefix = 'jwks';

  async create(keys: unknown[]): Promise<Jwks> {
    const parsed = jwksSchema.parse(keys);
    if (parsed.length > 0) await this.store(`${this.prefix}-keys`, parsed);
    return parsed;
  }
}

export async function readJwks(env: Env, readFromDatabase: () => Promise<unknown[]>): Promise<Jwks> {
  if (!(await isRedisEnabled(env))) return jwksSchema.parse(await readFromDatabase());
  const cached = await new JwksGetRepository(env).get();
  if (cached) return cached;
  return new JwksCreateRepository(env).create(await readFromDatabase());
}

export class JwksDeleteRepository extends RedisRepository {
  protected readonly prefix = 'jwks';

  async invalidate(table: unknown): Promise<void> {
    if (table === schema.jwks) await this.redis.del(`${this.prefix}-keys`);
  }
}
