FROM node:22-alpine

WORKDIR /app

COPY package.json server.js ./

RUN addgroup -S tts \
    && adduser -S tts -G tts

USER tts

EXPOSE 7979

CMD ["node", "server.js"]
