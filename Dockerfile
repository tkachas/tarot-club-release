FROM node:24-bookworm-slim

WORKDIR /app
COPY server.mjs ./
COPY public ./public

ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
