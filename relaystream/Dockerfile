FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV RELAYSTREAM_PORT=8092
EXPOSE 8092
USER node
CMD ["node", "server.js"]
