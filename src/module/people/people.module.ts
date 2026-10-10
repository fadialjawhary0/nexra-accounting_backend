import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { PeopleController } from './people.controller.js';
import { PeopleService } from './people.service.js';

/** The people records (the humans behind owners, directors, partners, contact persons and workers) on the person form. */
@Module({
  imports: [FormsModule, FilesModule],
  controllers: [PeopleController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}
