# tts.ghost1

Serviço HTTP compatível com a API anterior do projeto, mas usando diretamente a API oficial atual da Inworld.

## Compatibilidade mantida

- Porta `7979`
- `POST /`
- `POST /tts`
- `GET /vozes`
- `GET /preview`
- `GET /health`
- Campos antigos: `chavesecreta`, `voz`, `texto` e `model`
- Resposta da síntese como áudio binário

## Mudança principal

A autenticação antiga via Firebase e token do portal foi removida.

Agora o serviço utiliza:

```http
Authorization: Basic INWORLD_API_KEY
```

na API oficial:

```text
https://api.inworld.ai/tts/v1/voice
```

## Configuração

Copie o exemplo:

```bash
cp .env.example .env
```

Edite `.env`:

```env
SECRET_KEY=uma_senha_para_proteger_seu_proxy
INWORLD_API_KEY=sua_chave_oficial_da_inworld
MODEL_ID=inworld-tts-2
AUDIO_ENCODING=MP3
SAMPLE_RATE_HERTZ=48000
DELIVERY_MODE=BALANCED
TEXT_NORMALIZATION=ON
PORT=7979
```

A variável `INWORLD_API_KEY` pode ser informada apenas como a chave ou já começando com `Basic `.

## Rodar com Docker

```bash
docker compose up -d --build
```

Ver logs:

```bash
docker logs -f tts-ghost1
```

Testar saúde:

```bash
curl http://localhost:7979/health
```

## Gerar áudio

```bash
curl -X POST http://localhost:7979/ \
  -H "Content-Type: application/json" \
  -d '{
    "chavesecreta": "sua_senha",
    "voz": "Dennis",
    "texto": "Olá, este é um teste.",
    "model": "inworld-tts-2"
  }' \
  --output teste.mp3
```

Também aceita os nomes oficiais:

```json
{
  "text": "Olá",
  "voiceId": "Dennis",
  "modelId": "inworld-tts-2"
}
```

## Listar vozes

```bash
curl http://localhost:7979/vozes \
  -H "x-secret: sua_senha"
```

O serviço usa a nova Voices API:

```text
GET https://api.inworld.ai/voices/v1/voices
```

## Preview de uma voz

```bash
curl "http://localhost:7979/preview?voiceId=Dennis" \
  -H "x-secret: sua_senha" \
  --output preview.mp3
```

## Health check

```bash
curl http://localhost:7979/health
```

## Coolify

Use o repositório como recurso Docker Compose.

Configure as variáveis de ambiente no Coolify e mantenha a porta `7979`.

Para Cloudflare Tunnel:

```text
apitts.ghost1.cloud -> http://localhost:7979
```

## Segurança

Nunca envie o arquivo `.env` ao GitHub.

Use uma `SECRET_KEY` forte para impedir uso público não autorizado do proxy.
