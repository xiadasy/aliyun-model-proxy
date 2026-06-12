FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile || npm install
COPY . .
RUN npx tsc -p tsconfig.json || true
EXPOSE 3300
CMD ["node", "dist/index.js"]
