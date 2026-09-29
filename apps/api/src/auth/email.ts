/**
 * The sign-in code email (owner: CORE). It carries the 6-digit code and a link to
 * /cuenta/codigo with the email and code in the URL fragment: the fragment never reaches the
 * server or its logs, and the page signs in only after a click, so link scanners cannot burn
 * the code. When the email is read on a phone, the user can still type the code on the
 * computer that is signing in. docs/API.md §4.1.
 */
import type { MailMessage } from '../context';
import { escapeHtml } from '../pages/layout';

export const SIGN_IN_CODE_MINUTES = 10;

export function signInCodeLink(baseUrl: string, email: string, otp: string): string {
  const fragment = new URLSearchParams({ email, otp }).toString();
  return `${baseUrl}/cuenta/codigo#${fragment}`;
}

export function signInCodeEmail(baseUrl: string, email: string, otp: string): MailMessage {
  const link = signInCodeLink(baseUrl, email, otp);
  const text = [
    'Hola:',
    '',
    `Tu código para entrar en Céntrate es: ${otp}`,
    '',
    `Caduca en ${SIGN_IN_CODE_MINUTES} minutos. También puedes abrir este enlace en el ordenador donde estás entrando y pulsar «Entrar»:`,
    link,
    '',
    'Si no has pedido este código, ignora este mensaje: nadie puede entrar en tu cuenta sin él.',
    '',
    'Céntrate',
  ].join('\n');
  const html = [
    '<!doctype html><html lang="es"><body>',
    '<p>Hola:</p>',
    `<p>Tu código para entrar en Céntrate es:</p>`,
    `<p style="font-size:28px;font-weight:600;letter-spacing:4px">${escapeHtml(otp)}</p>`,
    `<p>Caduca en ${SIGN_IN_CODE_MINUTES} minutos. También puedes abrir este enlace en el ordenador donde estás entrando y pulsar «Entrar»:</p>`,
    `<p><a href="${escapeHtml(link)}">Entrar en Céntrate</a></p>`,
    '<p>Si no has pedido este código, ignora este mensaje: nadie puede entrar en tu cuenta sin él.</p>',
    '<p>Céntrate</p>',
    '</body></html>',
  ].join('');
  return {
    to: email,
    // No code in the subject: it would show on lock screens and notification previews.
    subject: 'Tu código para entrar en Céntrate',
    text,
    html,
    tag: 'sign_in_code',
  };
}
