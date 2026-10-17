import { Module } from '@nestjs/common';
import { FormsModule } from '../forms/forms.module.js';
import { TemplatesModule } from '../templates/templates.module.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingService } from './messaging.service.js';

/** Ready-made messages (Berichten): WhatsApp templates with merge fields and the click-to-chat link; nothing is ever sent by the system. */
@Module({
  imports: [FormsModule, TemplatesModule],
  controllers: [MessagingController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
