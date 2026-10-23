FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/gate/package.json apps/gate/
COPY apps/console/package.json apps/console/
RUN npm ci --omit=dev=false
COPY apps/gate apps/gate
ENV NODE_ENV=production
WORKDIR /app/apps/gate
EXPOSE 3001
CMD ["npx", "tsx", "src/index.ts"]
