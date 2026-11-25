import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { z } from 'zod';
import { signXRequest, type XConsumer } from './x-oauth1';

const profileSchema = z.looseObject({
  id_str: z.string(),
  name: z.string(),
  screen_name: z.string(),
  profile_image_url_https: z.string().optional(),
  email: z.string().nullish(),
});

const problemSchema = z.looseObject({
  errors: z.array(z.looseObject({ code: z.number().optional(), message: z.string().optional() })).optional(),
});

export async function getXUserInfo(consumer: XConsumer, token: string, tokenSecret: string) {
  const url = 'https://api.x.com/1.1/account/verify_credentials.json?include_email=true&skip_status=true';
  const response = await fetch(url, {
    headers: { authorization: await signXRequest(consumer, 'GET', url, { token, tokenSecret }) },
  }).catch(() => null);
  const body = await response?.json().catch(() => null);
  if (!response?.ok) {
    const problem = problemSchema.safeParse(body);
    console.error(JSON.stringify({ level: 'error', kind: 'x-user-info', status: response?.status ?? null, problem: problem.success ? problem.data : null }));
    return null;
  }
  const profile = profileSchema.safeParse(body);
  if (!profile.success) {
    console.error(JSON.stringify({ level: 'error', kind: 'x-user-info', status: 200, problem: 'unexpected profile response' }));
    return null;
  }

  const { id_str, name, screen_name, profile_image_url_https, email } = profile.data;
  return {
    user: {
      name,
      email: email ?? createPlaceholderEmail({ identifier: id_str, namespace: 'twitter' }),
      image: profile_image_url_https,
      emailVerified: Boolean(email),
    },
    data: {
      data: { id: id_str, name, username: screen_name, profile_image_url: profile_image_url_https },
    },
  };
}
