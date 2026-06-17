/**
 * Send a one-off test email via Resend (quickstart).
 *
 *   cd scripts/resend && npm install
 *   node --env-file=../../.env send-test-email.mjs
 *
 * Replace re_xxxxxxxxx below with your real API key, or set RESEND_API_KEY in .env.
 */
import { Resend } from 'resend';

const apiKey = (process.env.RESEND_API_KEY || 're_xxxxxxxxx').trim();

if (apiKey === 're_xxxxxxxxx') {
  console.warn(
    'Using placeholder API key. Replace re_xxxxxxxxx with your real Resend API key, or set RESEND_API_KEY in .env.',
  );
}

const resend = new Resend(apiKey);

const { data, error } = await resend.emails.send({
  from: 'onboarding@resend.dev',
  to: 'joshmaz@gmail.com',
  subject: 'Hello World',
  html: '<p>Congrats on sending your first email!</p>',
});

if (error) {
  console.error('Resend error:', error);
  process.exit(1);
}

console.log('Email sent:', data);
