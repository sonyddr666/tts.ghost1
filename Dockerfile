FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg \
    && addgroup -S tts \
    && adduser -S tts -G tts \
    && mkdir -p /app/data \
    && chown -R tts:tts /app

COPY --chown=tts:tts package.json server.js ./

USER tts

EXPOSE 7979

CMD ["node", "server.js"]
