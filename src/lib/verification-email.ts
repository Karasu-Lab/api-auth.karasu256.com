import { Resend } from 'resend';

interface VerificationEmail {
  email: string;
  url: string;
}

export async function sendVerificationEmail(env: Env, { email, url }: VerificationEmail): Promise<void> {
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
