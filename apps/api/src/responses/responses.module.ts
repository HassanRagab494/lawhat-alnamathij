import { Module } from '@nestjs/common';
import { ResponseEditsController } from './response-edits.controller';
import { ResponseEditsService } from './response-edits.service';
import { ResponsesController } from './responses.controller';
import { ResponsesService } from './responses.service';

@Module({
  controllers: [ResponsesController, ResponseEditsController],
  providers: [ResponsesService, ResponseEditsService],
})
export class ResponsesModule {}
