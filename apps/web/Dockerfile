# صورة تشغيل الواجهة (Next.js standalone). سياق البناء: جذر المستودع.
#   docker build -f apps/web/Dockerfile --build-arg API_ORIGIN=http://lawha-api-backend:4000 -t lawha-web .
# API_ORIGIN يُثبَّت وقت البناء في إعادة توجيه /api/*؛ تغييره يتطلب إعادة البناء.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @lawha/web --ignore-scripts
COPY apps/web apps/web
ARG API_ORIGIN
ARG APP_NAME="لوحة النماذج"
RUN test -n "$API_ORIGIN" || (echo "API_ORIGIN مطلوب كـ build arg (العنوان الداخلي للـ API)" >&2 && exit 1)
ENV API_ORIGIN=$API_ORIGIN \
  APP_NAME=$APP_NAME \
  NEXT_OUTPUT=standalone
RUN npm run build -w @lawha/web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  HOSTNAME=0.0.0.0 \
  PORT=3000
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
