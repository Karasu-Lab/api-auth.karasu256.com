import { Resend } from 'resend';

interface VerificationEmail {
  email: string;
  url: string;
}

function resolveVerificationUrl(env: Env, url: string): string {
  const link = new URL(url);
  const callback = link.searchParams.get('callbackURL');
  if (!callback || callback === '/') {
    link.searchParams.set('callbackURL', `${env.AUTH_UI_URL}/email/verify/complete`);
  } else if (callback.startsWith('/')) {
    link.searchParams.set('callbackURL', `${env.AUTH_UI_URL}${callback}`);
  }
  return link.toString();
}

export async function sendVerificationEmail(env: Env, { email, url: rawUrl }: VerificationEmail): Promise<void> {
  const url = resolveVerificationUrl(env, rawUrl);
  const { error } = await new Resend(env.RESEND_API_KEY).emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: email,
    subject: 'メールアドレスの確認',
    html: [
      '<p>Karasu Lab へのご登録ありがとうございます。</p>',
      '<p>次のリンクを開いて、メールアドレスを確認してください。</p>',
      `<p><a href="${url}">メールアドレスを確認する</a></p>`,
      '<p>心当たりがない場合は、このメールを破棄してください。</p>',
    ].join(''),
    text: `Karasu Lab へのご登録ありがとうございます。\n次のリンクを開いて、メールアドレスを確認してください。\n${url}\n心当たりがない場合は、このメールを破棄してください。`,
  });
  if (error) {
    console.error('Resend rejected the verification email', error);
    throw new Error(error.message);
  }
}
