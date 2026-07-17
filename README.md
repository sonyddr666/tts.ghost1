# tts.ghost1 — clonagem correta

API HTTP + bot Telegram usando a API oficial da Inworld.

## Regra correta dos 15 segundos

Os **5–15 segundos são somente para a amostra usada para clonar a voz**.

Fluxo:

```text
amostra de voz de 5–15s
        ↓
Inworld cria um voiceId
        ↓
esse voiceId pode gerar novos áudios normalmente
```

Os áudios gerados pelo TTS **não são cortados em 15 segundos**.

Quando o texto do Telegram ultrapassa o limite de uma chamada da Inworld, o programa divide o texto em partes, gera todas e reúne em um único MP3.

## Telegram

### Clonar uma voz

Envie:

```text
/clonar Minha Voz | PT_BR | Olá, esta é uma amostra da minha voz.
```

Depois envie uma mensagem de voz, MP3, WAV, OGG ou um vídeo. Para vídeos, o bot extrai a faixa de áudio automaticamente.

O bot:

1. baixa a amostra de áudio ou vídeo;
2. extrai a faixa de áudio quando a entrada for um vídeo;
3. verifica se tem pelo menos 5 segundos;
4. usa somente os primeiros 15 segundos quando a entrada for maior;
5. converte para WAV mono, 24 kHz e PCM 16-bit;
6. chama `POST https://api.inworld.ai/voices/v1/voices:clone`;
7. recebe o novo `voiceId`;
8. seleciona automaticamente a voz clonada;
9. usa essa voz para os próximos textos.

Use apenas áudio que você tenha autorização para clonar.

### Gerar áudio

Depois da clonagem, envie qualquer texto:

```text
Este texto será falado com a voz que acabei de clonar.
```

O áudio gerado não recebe corte de 15 segundos.

### Comandos

```text
/start
/clonar Nome | PT_BR | transcrição opcional
/cancelar
/vozes pt
/voz ID
/preview
/teste
/modelo inworld-tts-2
/modo audio
/modo voz
/status
```

## API HTTP mantida

```text
POST /        gerar áudio
POST /tts     gerar áudio
POST /clone   clonar voz
GET /vozes    listar vozes
GET /preview  obter preview
GET /health   diagnóstico
```

## Variáveis no Coolify

```env
SECRET_KEY=SUA_SENHA
INWORLD_API_KEY=SUA_CHAVE_OFICIAL
MODEL_ID=inworld-tts-2
PORT=7979

TELEGRAM_BOT_TOKEN=TOKEN_NOVO_DO_BOTFATHER
TELEGRAM_ALLOWED_CHAT_IDS=5619062865
TELEGRAM_DEFAULT_VOICE=Beatriz
TELEGRAM_DEFAULT_LANGUAGE=PT_BR
TELEGRAM_SEND_MODE=audio
TELEGRAM_MAX_TEXT_CHARS=4096

CLONE_MIN_SECONDS=5
CLONE_MAX_SECONDS=15
CLONE_SAMPLE_RATE_HERTZ=24000
CLONE_REMOVE_BACKGROUND_NOISE=true
```

A chave oficial da Inworld precisa ter permissão de escrita para a clonagem.

## Docker

```bash
docker compose up -d --build
```

Logs:

```bash
docker logs -f tts-ghost1
```

Health:

```bash
curl http://127.0.0.1:7979/health
```

## Coolify e Cloudflare

O Compose publica:

```text
7979:7979
```

Rota do Cloudflare:

```text
apitts.ghost1.cloud -> http://localhost:7979
```

## Segurança

Não envie `.env` ao GitHub.

Regere tokens que já tenham sido publicados em conversas ou logs.
