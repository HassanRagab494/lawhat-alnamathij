import { Module } from '@nestjs/common';
import { ResponseEditsController } from './response-edits.controller';
import { ResponseEditsService } from './response-edits.service';
import { AllResponsesController, ResponsesController } from './responses.controller';
import { ResponsesService } from './responses.service';

@Module({
  controllers: [AllResponsesController, ResponsesController, ResponseEditsController],
  providers: [ResponsesService, ResponseEditsService],
})
export class ResponsesModule {}
