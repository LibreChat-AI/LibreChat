FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN mkdir -p /data

EXPOSE 8090

CMD ["node", "src/index.js"]
