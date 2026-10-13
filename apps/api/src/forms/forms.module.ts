import { Module } from '@nestjs/common';
import { DraftService } from './draft.service';
import { FormsController } from './forms.controller';
import { FormsService } from './forms.service';
import { PublishService } from './publish.service';

@Module({ controllers: [FormsController], providers: [FormsService, DraftService, PublishService] })
export class FormsModule {}
