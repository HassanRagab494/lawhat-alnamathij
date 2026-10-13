import { Controller, Get, Injectable, Module } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Permission, UserRole } from '@prisma/client';
import type { AuthContext } from '../auth/auth-context';
import { CurrentAuth } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

class FormsSummaryDto {
  @ApiProperty() active!: number;
  @ApiProperty() archived!: number;
}

class UsersSummaryDto {
  @ApiProperty() supervisors!: number;
  @ApiProperty() activeSupervisors!: number;
  @ApiProperty() inactiveSupervisors!: number;
}

class DashboardSummaryDto {
  @ApiPropertyOptional({ type: FormsSummaryDto, description: 'يظهر لمن يملك عرض النماذج' })
  forms?: FormsSummaryDto;
  @ApiPropertyOptional({ type: UsersSummaryDto, description: 'يظهر لمدير النظام فقط' })
  users?: UsersSummaryDto;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** أرقام حقيقية من القاعدة، ولا تُحسب الأقسام التي لا يملك المستخدم صلاحيتها. */
  async summary(auth: AuthContext): Promise<DashboardSummaryDto> {
    const result: DashboardSummaryDto = {};
    if (auth.permissions.includes(Permission.FORMS_VIEW)) {
      const [active, archived] = await this.prisma.$transaction([
        this.prisma.form.count({ where: { archivedAt: null } }),
        this.prisma.form.count({ where: { archivedAt: { not: null } } }),
      ]);
      result.forms = { active, archived };
    }
    if (auth.role === UserRole.ADMIN) {
      const [supervisors, activeSupervisors] = await this.prisma.$transaction([
        this.prisma.user.count({ where: { role: UserRole.SUPERVISOR, deletedAt: null } }),
        this.prisma.user.count({
          where: { role: UserRole.SUPERVISOR, deletedAt: null, isActive: true },
        }),
      ]);
      result.users = {
        supervisors,
        activeSupervisors,
        inactiveSupervisors: supervisors - activeSupervisors,
      };
    }
    return result;
  }
}

@ApiTags('dashboard')
@ApiCookieAuth('session')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({ summary: 'ملخص الصفحة الرئيسية حسب صلاحيات المستخدم' })
  @ApiOkResponse({ type: DashboardSummaryDto })
  summary(@CurrentAuth() auth: AuthContext): Promise<DashboardSummaryDto> {
    return this.dashboard.summary(auth);
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}
