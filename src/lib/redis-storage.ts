import type { SecondaryStorage } from 'better-auth';
import { SessionCreateRepository, SessionDeleteRepository, SessionGetRepository, SessionUpdateRepository } from './redis/session-repositories';

export function redisSecondaryStorage(env: Env): SecondaryStorage {
  const getRepository = new SessionGetRepository(env);
  const createRepository = new SessionCreateRepository(env);
  const updateRepository = new SessionUpdateRepository(env);
  const deleteRepository = new SessionDeleteRepository(env);
  const isVerification = (key: string) => key.startsWith('verification:');
  const set = async (key: string, value: string, ttl?: number) => {
    if (!(await createRepository.create(key, value, ttl))) await updateRepository.update(key, value, ttl);
  };
  return {
    get: async (key) => (isVerification(key) ? null : await getRepository.get(key)),
    getAndDelete: async (key) => {
      if (isVerification(key)) return null;
      const value = await getRepository.get(key);
      if (value !== null) await deleteRepository.delete(key);
      return value;
    },
    increment: async (key, ttl) => {
      const value = Number((await getRepository.get(key)) ?? 0) + 1;
      await set(key, String(value), ttl);
      return value;
    },
    set: async (key, value, ttl) => {
      if (isVerification(key)) return;
      await set(key, value, ttl);
    },
    delete: async (key) => {
      if (isVerification(key)) return;
      await deleteRepository.delete(key);
    },
  };
}
