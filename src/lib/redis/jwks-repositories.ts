import type { Jwk } from 'better-auth/plugins/jwt';
import { z } from 'zod';
import * as schema from '@karasu-lab/db/schema';
import { RedisRepository } from './redis-repository';

const jwksSchema = z.array(
  z.object({
    id: z.string(),
    publicKey: z.string(),
    privateKey: z.string(),
    createdAt: z.coerce.date(),
    expiresAt: z.coerce.date().nullish().transform((value) => value ?? undefined),
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
  protected readonly prefix = 'jwks:';

  async get(): Promise<Jwks | null> {
    const value = await this.redis.get<string>(`${this.prefix}keys`);
    return value === null ? null : jwksSchema.parse(JSON.parse(value));
  }
}

export class JwksCreateRepository extends RedisRepository {
  protected readonly prefix = 'jwks:';

  async create(keys: unknown[]): Promise<Jwks> {
    const parsed = jwksSchema.parse(keys);
    await this.redis.set(`${this.prefix}keys`, JSON.stringify(parsed));
    return parsed;
  }
}

export class JwksDeleteRepository extends RedisRepository {
  protected readonly prefix = 'jwks:';

  async invalidate(table: unknown): Promise<void> {
    if (table === schema.jwks) await this.redis.del(`${this.prefix}keys`);
  }
}
