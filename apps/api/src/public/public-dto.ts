import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { QUESTION_TYPES, type QuestionTypeKey } from '../forms/questions/limits';

export class PublicOptionDto {
  @ApiProperty({ description: 'معرّف الخيار داخل هذا الإصدار (يُرسل في الإجابة)' }) id!: string;
  @ApiProperty({ description: 'مفتاح منطقي ثابت عبر الإصدارات (لنقل الإجابات عند التحديث)' })
  key!: string;
  @ApiProperty() label!: string;
}

export class PublicShowIfDto {
  @ApiProperty({ description: 'المفتاح المنطقي لسؤال الاختيار السابق' }) questionKey!: string;
  @ApiProperty({ type: [String], description: 'المفاتيح المنطقية للخيارات التي تُظهر السؤال' })
  optionKeys!: string[];
}

export class PublicQuestionDto {
  @ApiProperty({ description: 'معرّف السؤال داخل هذا الإصدار (يُرسل في الإجابة)' }) id!: string;
  @ApiProperty({ description: 'مفتاح منطقي ثابت عبر الإصدارات' }) key!: string;
  @ApiProperty({ enum: QUESTION_TYPES }) type!: QuestionTypeKey;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty() required!: boolean;
  @ApiProperty({ type: 'object', additionalProperties: true }) settings!: Record<string, unknown>;
  @ApiProperty({ type: [PublicOptionDto] }) options!: PublicOptionDto[];
  @ApiProperty({
    type: PublicShowIfDto,
    nullable: true,
    description:
      'شرط الظهور؛ null = ظاهر دائمًا. السؤال المخفي ليس إجباريًا، والخادم يرفض أي إجابة له.',
  })
  showIf!: PublicShowIfDto | null;
}

export class PublicFormDto {
  @ApiProperty() publicId!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ description: 'false عند إغلاق الاستقبال أو أرشفة النموذج' })
  acceptingResponses!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'الإصدار المنشور الحالي؛ null عند الإغلاق',
  })
  versionId!: string | null;
  @ApiProperty({ type: [PublicQuestionDto], description: 'فارغة عند إغلاق الاستقبال' })
  questions!: PublicQuestionDto[];
  @ApiProperty({
    description:
      'هل تُفحص الملفات المرفوعة ضد البرمجيات الخبيثة (false في UPLOAD_SCAN_MODE=disabled)',
  })
  fileScanning!: boolean;
}

export class SubmitAnswerDto {
  @ApiProperty({ format: 'uuid', description: 'id السؤال من PublicFormDto' }) questionId!: string;
  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description:
      'نص للإجابة القصيرة والفقرة؛ رقم كنص عشري للرقم؛ YYYY-MM-DD للتاريخ؛ id الخيار للاختيار الواحد والقائمة؛ مصفوفة ids للاختيار المتعدد',
  })
  value!: string | string[];
}

export class SubmitResponseDto {
  @ApiProperty({ format: 'uuid' }) versionId!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'مفتاح عشوائي لكل محاولة تعبئة؛ إعادة الطلب نفسه به تعيد الرقم المرجعي الأصلي',
  })
  idempotencyKey!: string;
  @ApiPropertyOptional({ type: [SubmitAnswerDto], maxItems: 100 }) answers!: SubmitAnswerDto[];
}

export class SubmitResultDto {
  @ApiProperty({ example: 'K7Q2-M9XD-4TPB', description: 'رقم مرجعي لا يمنح أي حق قراءة' })
  referenceCode!: string;
  @ApiProperty({ type: String, format: 'date-time' }) submittedAt!: string;
}
