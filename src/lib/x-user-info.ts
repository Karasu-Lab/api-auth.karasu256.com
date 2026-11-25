import type { OAuth2Tokens } from '@better-auth/core/oauth2';
import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { z } from 'zod';

const profileSchema = z.object({
  data: z.object({
    id: z.string(),
    name: z.string(),
    username: z.string(),
    profile_image_url: z.string().optional(),
  }),
});

const emailSchema = z.object({
  data: z.object({ confirmed_email: z.string().optional() }),
});

const problemSchema = z.looseObject({
  type: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
});

async function getMe(accessToken: string | undefined, fields: string) {
  const response = await fetch(`https://api.x.com/2/users/me?user.fields=${fields}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }).catch(() => null);
  if (response?.ok) return { response, problem: null };
  const problem = problemSchema.safeParse(await response?.json().catch(() => null));
  return { response: null, status: response?.status ?? null, problem: problem.success ? problem.data : null };
}

export async function getXUserInfo(token: OAuth2Tokens) {
  const profileResult = await getMe(token.accessToken, 'profile_image_url');
  if (!profileResult.response) {
    console.error(JSON.stringify({ level: 'error', kind: 'x-user-info', status: profileResult.status, problem: profileResult.problem }));
    return null;
  }
  const profile = profileSchema.safeParse(await profileResult.response.json().catch(() => null));
  if (!profile.success) {
    console.error(JSON.stringify({ level: 'error', kind: 'x-user-info', status: 200, problem: 'unexpected profile response' }));
    return null;
  }

  const emailResult = await getMe(token.accessToken, 'confirmed_email');
  const email = emailResult.response ? emailSchema.safeParse(await emailResult.response.json().catch(() => null)) : null;
  const confirmedEmail = email?.success ? email.data.data.confirmed_email : undefined;

  const { id, name, profile_image_url } = profile.data.data;
  return {
    user: {
      name,
      email: confirmedEmail ?? createPlaceholderEmail({ identifier: id, namespace: 'twitter' }),
      image: profile_image_url,
      emailVerified: Boolean(confirmedEmail),
    },
    data: profile.data,
  };
}
