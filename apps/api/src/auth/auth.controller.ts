import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import type { AuthContext } from './auth-context';
import { AuthService } from './auth.service';
import { CurrentAuth, Public, RequestMeta, RequestMetaData } from './decorators';
import { ChangePasswordDto, LoginDto, LoginResponseDto, MeDto } from './dto';
import { SessionService } from './session.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post('login')
  @Public()
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ submitIp: true, submitForm: true })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'تسجيل الدخول',
    description:
      'ينشئ جلسة جديدة ويضبط Cookie HttpOnly باسم lp_session وCookie lp_csrf. محدود بعدد محاولات في الدقيقة لكل عنوان (LOGIN_RATE_LIMIT_PER_MINUTE)، ويوقف الحساب مؤقتًا بعد محاولات فاشلة متتالية.',
  })
  @ApiOkResponse({ type: LoginResponseDto })
  async login(
    @Body() dto: LoginDto,
    @RequestMetaData() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const { me, session } = await this.auth.login(dto.username, dto.password, meta);
    this.sessions.setCookies(res, session);
    return { user: me, csrfToken: session.csrfToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('session')
  @ApiSecurity('csrf')
  @ApiOperation({ summary: 'تسجيل الخروج وإبطال الجلسة الحالية' })
  @ApiNoContentResponse()
  async logout(
    @CurrentAuth() auth: AuthContext,
    @RequestMetaData() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(auth, meta);
    this.sessions.clearCookies(res);
  }

  @Get('me')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'بيانات المستخدم الحالي وصلاحياته الفعلية' })
  @ApiOkResponse({ type: MeDto })
  me(@CurrentAuth() auth: AuthContext): MeDto {
    return this.auth.me(auth);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth('session')
  @ApiSecurity('csrf')
  @ApiOperation({
    summary: 'تغيير كلمة المرور',
    description: 'يتطلب كلمة المرور الحالية، ويبطل جميع الجلسات الأخرى للمستخدم.',
  })
  @ApiNoContentResponse()
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body() dto: ChangePasswordDto,
    @RequestMetaData() meta: RequestMeta,
  ): Promise<void> {
    await this.auth.changePassword(auth, dto.currentPassword, dto.newPassword, meta);
  }
}
