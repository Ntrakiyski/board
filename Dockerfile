FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
ARG VITE_TLDRAW_LICENSE_KEY
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_TLDRAW_LICENSE_KEY=$VITE_TLDRAW_LICENSE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5421
ENV DATA_DIR=/data

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY server ./server
COPY openapi.json ./openapi.json

RUN mkdir -p /data/rooms /data/uploads

EXPOSE 5421

CMD ["npm", "start"]
