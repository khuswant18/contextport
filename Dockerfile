# Production image: API + website on one port.
FROM node:22-alpine AS build
WORKDIR /app
COPY site/package*.json site/
RUN cd site && npm ci
COPY shared shared
COPY site site
RUN cd site && npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json server/
RUN cd server && npm ci --omit=dev
COPY shared shared
COPY server/src server/src
COPY package.json .
COPY --from=build /app/site/dist site/dist
USER node
EXPOSE 8787
CMD ["node", "server/src/index.js"]
