import { Resend } from 'resend';

interface ChallengeEmail {
  email: string;
  otp: string;
  expiresAt: Date;
}

/**
 * Sends the sign-in code through Resend. The plugin treats a throw as a
 * failed send and discards the challenge it just created.
 *
 * @throws {Error} When the Resend API call fails.
 */
export async function sendChallengeEmail(env: Env, { email, otp, expiresAt }: ChallengeEmail): Promise<void> {
  const minutes = Math.max(1, Math.round((expiresAt.getTime() - Date.now()) / 60_000));
  const { error } = await new Resend(env.RESEND_API_KEY).emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: email,
    subject: 'サインインコード',
    html: [
      '<p>Karasu Lab のサインインコードです。</p>',
      `<p style="font-size:28px;font-weight:600;letter-spacing:0.2em;font-family:monospace">${otp}</p>`,
      `<p>このコードは ${minutes} 分間有効です。心当たりがない場合は、このメールを破棄してください。</p>`,
    ].join(''),
    text: `Karasu Lab のサインインコード: ${otp}\nこのコードは ${minutes} 分間有効です。心当たりがない場合は、このメールを破棄してください。`,
  });
  if (error) throw new Error(error.message);
}
