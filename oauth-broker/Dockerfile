FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV OAUTH_BROKER_PORT=8091
EXPOSE 8091
USER node
CMD ["node", "server.js"]
