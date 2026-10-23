FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/gate/package.json apps/gate/
COPY apps/console/package.json apps/console/
RUN npm ci
COPY apps/console apps/console
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/apps/console
RUN npx next build
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
