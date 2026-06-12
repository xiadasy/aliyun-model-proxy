FROM node:22-alpine
WORKDIR /app
COPY proxy.mjs ./
EXPOSE 3300
CMD ["node", "proxy.mjs"]