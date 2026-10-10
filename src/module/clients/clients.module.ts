import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ListsModule } from '../lists/lists.module.js';
import { NumberingModule } from '../numbering/numbering.module.js';
import { ClientFoldersService } from './client-folders.service.js';
import { ClientPeopleService } from './client-people.service.js';
import { ClientQualityService } from './client-quality.service.js';
import { ClientRelationsService } from './client-relations.service.js';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';
import { PeopleController } from './people.controller.js';

/** Clients (Klanten): the grid, the client form, people and their roles, relations between clients, the client's folders, data quality and export. */
@Module({
  imports: [FormsModule, NumberingModule, ListsModule, FilesModule],
  controllers: [ClientsController, PeopleController],
  providers: [ClientsService, ClientPeopleService, ClientRelationsService, ClientFoldersService, ClientQualityService],
  exports: [ClientsService],
})
export class ClientsModule {}
