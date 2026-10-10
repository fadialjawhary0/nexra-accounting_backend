export type MailLocale = 'nl' | 'en';

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function layout(heading: string, paragraphs: string[], button: { label: string; link: string }, footer: string): string {
  const body = paragraphs.map(text => `<p style="margin:0 0 16px;line-height:1.55">${escapeHtml(text)}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f7f5ef;font-family:Inter,Arial,sans-serif;color:#222">
<div style="max-width:520px;margin:0 auto;padding:32px 20px">
<div style="background:#fff;border:1px solid #ededed;border-radius:12px;padding:28px">
<p style="margin:0 0 20px;font-weight:600;color:#0f172a">Nexra B.V.</p>
<h1 style="margin:0 0 16px;font-size:20px;color:#0f172a">${escapeHtml(heading)}</h1>
${body}
<p style="margin:24px 0"><a href="${escapeHtml(button.link)}" style="background:#0f172a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:600">${escapeHtml(button.label)}</a></p>
<p style="margin:0;font-size:12px;color:#6b6b6b;line-height:1.5">${escapeHtml(footer)}<br><span style="word-break:break-all">${escapeHtml(button.link)}</span></p>
</div></div></body></html>`;
}

export function inviteMail(locale: MailLocale, input: { name: string; inviter: string; link: string; days: number }): RenderedMail {
  if (locale === 'en') {
    const lines = [`Hi ${input.name},`, `${input.inviter} invited you to Nexra B.V., the practice management app of the office. Choose a password to activate your account.`];
    return {
      subject: 'You have been invited to Nexra B.V.',
      text: `${lines.join('\n\n')}\n\n${input.link}\n\nThis link works for ${input.days} days.`,
      html: layout('You have been invited', lines, { label: 'Activate your account', link: input.link }, `This link works for ${input.days} days. If you did not expect this e-mail you can ignore it.`),
    };
  }
  const lines = [`Hallo ${input.name},`, `${input.inviter} heeft je uitgenodigd voor Nexra B.V., de kantoorsoftware van het kantoor. Kies een wachtwoord om je account te activeren.`];
  return {
    subject: 'Je bent uitgenodigd voor Nexra B.V.',
    text: `${lines.join('\n\n')}\n\n${input.link}\n\nDeze link is ${input.days} dagen geldig.`,
    html: layout('Je bent uitgenodigd', lines, { label: 'Account activeren', link: input.link }, `Deze link is ${input.days} dagen geldig. Verwachtte je deze e-mail niet? Dan kun je hem negeren.`),
  };
}

export function resetMail(locale: MailLocale, input: { name: string; link: string; minutes: number }): RenderedMail {
  if (locale === 'en') {
    const lines = [`Hi ${input.name},`, 'We received a request to reset your Nexra B.V. password. Choose a new one with the button below.'];
    return {
      subject: 'Reset your Nexra B.V. password',
      text: `${lines.join('\n\n')}\n\n${input.link}\n\nThis link works for ${input.minutes} minutes and only once.`,
      html: layout('Reset your password', lines, { label: 'Choose a new password', link: input.link }, `This link works for ${input.minutes} minutes and only once. If you did not ask for this, you can ignore this e-mail — your password stays the same.`),
    };
  }
  const lines = [`Hallo ${input.name},`, 'We hebben een verzoek ontvangen om je wachtwoord voor Nexra B.V. opnieuw in te stellen. Kies met de knop hieronder een nieuw wachtwoord.'];
  return {
    subject: 'Stel je wachtwoord voor Nexra B.V. opnieuw in',
    text: `${lines.join('\n\n')}\n\n${input.link}\n\nDeze link is ${input.minutes} minuten geldig en werkt maar één keer.`,
    html: layout('Wachtwoord opnieuw instellen', lines, { label: 'Nieuw wachtwoord kiezen', link: input.link }, `Deze link is ${input.minutes} minuten geldig en werkt maar één keer. Heb je dit niet aangevraagd? Negeer deze e-mail dan — je wachtwoord blijft hetzelfde.`),
  };
}
