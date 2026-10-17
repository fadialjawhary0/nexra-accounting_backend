import { Module } from '@nestjs/common';
import { AddressBookController } from './address-book.controller.js';
import { AddressBookService } from './address-book.service.js';
import { AddressLabelsService } from './address-labels.service.js';

/** The address book (the tax office, banks …) and the envelope labels made from it. */
@Module({
  controllers: [AddressBookController],
  providers: [AddressBookService, AddressLabelsService],
  exports: [AddressBookService, AddressLabelsService],
})
export class AddressBookModule {}
