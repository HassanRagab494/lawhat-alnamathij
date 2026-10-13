# صورة تشغيل الـ API (NestJS + Prisma). سياق البناء: جذر المستودع.
#   docker build -f apps/api/Dockerfile -t lawha-api .
# عند الإقلاع: prisma migrate deploy (تطبيق migrations الجديدة فقط، دون reset أو مسح) ثم تشغيل الخادم.
# لا تحتوي الصورة على أي بيانات أو حسابات اختبار؛ المدير الأول يُنشأ يدويًا (انظر deploy/coolify/README.md).

FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- البناء: كل الاعتماديات ثم nest build ----
FROM base AS build
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/api/prisma apps/api/prisma
RUN npm ci --workspace @lawha/api
COPY apps/api apps/api
RUN npm run build -w @lawha/api

# ---- اعتماديات التشغيل فقط (prisma مطلوب لـ migrate deploy) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/api/prisma apps/api/prisma
RUN npm ci --omit=dev --workspace @lawha/api && npm cache clean --force

# ---- التشغيل ----
FROM base AS runtime
ENV NODE_ENV=production \
  API_PORT=4000
COPY --from=deps --chown=node:node /app /app
COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist
COPY --chown=node:node apps/api/docker-entrypoint.sh /app/apps/api/docker-entrypoint.sh
WORKDIR /app/apps/api
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "/app/apps/api/docker-entrypoint.sh"]
