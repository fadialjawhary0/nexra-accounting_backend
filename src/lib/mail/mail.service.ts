import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { AppConfigService } from '../config/app-config.service.js';

export interface MailMessage {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  attachments?: { filename: string; content: Buffer | string; contentType?: string }[];
}

export interface MailResult {
  /** `false` when no SMTP server is configured and the mail was only logged. */
  delivered: boolean;
  messageId?: string;
}

/** Sends e-mail (invitations, password resets, reminders). Without SMTP settings it writes the mail to the log instead. */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;

  constructor(private readonly config: AppConfigService) {
    const smtp = config.smtp;
    this.transporter = smtp ? nodemailer.createTransport(smtp) : null;
  }

  async send(message: MailMessage): Promise<MailResult> {
    const to = Array.isArray(message.to) ? message.to.join(', ') : message.to;
    if (!this.transporter) {
      this.logger.log(`[mail not sent — no SMTP_HOST] to: ${to} · subject: ${message.subject}\n${message.text ?? message.html ?? ''}`);
      return { delivered: false };
    }
    const info = await this.transporter.sendMail({ from: this.config.mailFrom, ...message, to });
    return { delivered: true, messageId: info.messageId };
  }
}
