FROM node:22-alpine
WORKDIR /app
COPY server.mjs admin.mjs ./
ENV NODE_OPTIONS=--no-warnings
USER node
CMD ["node", "server.mjs"]
