import http from 'node:http';

const PORT = Number.parseInt(process.env.PORT || '7979', 10);
const SECRET_KEY = process.env.SECRET_KEY || '';
const INWORLD_API_KEY = process.env.INWORLD_API_KEY || '';
const MODEL_ID = process.env.MODEL_ID || 'inworld-tts-2';
const AUDIO_ENCODING = process.env.AUDIO_ENCODING || 'MP3';
const SAMPLE_RATE_HERTZ = Number.parseInt(process.env.SAMPLE_RATE_HERTZ || '48000', 10);
const DELIVERY_MODE = process.env.DELIVERY_MODE || 'BALANCED';
const TEXT_NORMALIZATION = process.env.TEXT_NORMALIZATION || 'ON';

const missing = Object.entries({ SECRET_KEY, INWORLD_API_KEY })
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(`Faltando variável obrigatória: ${missing.join(', ')}`);
  process.exit(1);
}

const INWORLD_AUTH = INWORLD_API_KEY.startsWith('Basic ')
  ? INWORLD_API_KEY
  : `Basic ${INWORLD_API_KEY}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-secret, Authorization',
};

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message, details) {
  const payload = { error: message };
  if (details) payload.details = details;
  sendJson(res, status, payload);
}

async function readJson(req) {
  let body = '';

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 1_000_000) {
      throw new Error('Corpo da requisição muito grande');
    }
  }

  return body ? JSON.parse(body) : {};
}

function isAuthorized(req, body = {}) {
  const headerSecret = req.headers['x-secret'];

  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : '';

  return (
    body.chavesecreta === SECRET_KEY ||
    headerSecret === SECRET_KEY ||
    bearer === SECRET_KEY
  );
}

function contentTypeForEncoding(encoding) {
  const normalized = String(encoding).toUpperCase();

  if (normalized === 'MP3') return 'audio/mpeg';
  if (normalized === 'OGG_OPUS' || normalized === 'OPUS') return 'audio/ogg';
  if (normalized === 'MULAW') return 'audio/basic';

  return 'audio/wav';
}

async function inworldRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: INWORLD_AUTH,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();

  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(`Inworld respondeu HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

async function handleSynthesize(req, res) {
  let body;

  try {
    body = await readJson(req);
  } catch (error) {
    return sendError(res, 400, 'JSON inválido', error.message);
  }

  if (!isAuthorized(req, body)) {
    return sendError(res, 401, 'Chave secreta inválida');
  }

  const text = body.texto ?? body.text;
  const voiceId = body.voz ?? body.voiceId;

  if (!text || typeof text !== 'string') {
    return sendError(res, 400, 'Campo "texto" obrigatório');
  }

  if (text.length > 2000) {
    return sendError(res, 400, 'Texto muito longo; máximo de 2000 caracteres');
  }

  if (!voiceId || typeof voiceId !== 'string') {
    return sendError(res, 400, 'Campo "voz" obrigatório');
  }

  const modelId = body.model ?? body.modelId ?? MODEL_ID;
  const audioEncoding = body.audioEncoding ?? AUDIO_ENCODING;
  const sampleRateHertz = Number(
    body.sampleRateHertz ?? SAMPLE_RATE_HERTZ
  );

  const payload = {
    text,
    voiceId,
    modelId,
    audioConfig: {
      audioEncoding,
      sampleRateHertz,
    },
    deliveryMode: body.deliveryMode ?? DELIVERY_MODE,
    applyTextNormalization:
      body.applyTextNormalization ?? TEXT_NORMALIZATION,
  };

  if (body.language) {
    payload.language = body.language;
  }

  if (Number.isFinite(Number(body.temperature))) {
    payload.temperature = Number(body.temperature);
  }

  try {
    const result = await inworldRequest(
      'https://api.inworld.ai/tts/v1/voice',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );

    if (!result.audioContent) {
      return sendError(res, 502, 'A Inworld não retornou áudio');
    }

    const audio = Buffer.from(result.audioContent, 'base64');
    const contentType = contentTypeForEncoding(audioEncoding);

    const extension =
      contentType === 'audio/mpeg'
        ? 'mp3'
        : contentType === 'audio/ogg'
          ? 'ogg'
          : 'wav';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': audio.length,
      'Content-Disposition': `inline; filename="audio.${extension}"`,
      'Cache-Control': 'no-store',
      'X-Inworld-Model': result.usage?.modelId || modelId,
      'X-Inworld-Characters': String(
        result.usage?.processedCharactersCount ?? text.length
      ),
      ...CORS,
    });

    res.end(audio);
  } catch (error) {
    console.error(
      '[TTS]',
      error.status,
      error.data || error.message
    );

    return sendError(
      res,
      error.status || 502,
      'Falha ao gerar áudio na Inworld',
      error.data || error.message
    );
  }
}

async function handleVoices(req, res, url) {
  if (!isAuthorized(req)) {
    return sendError(res, 401, 'Chave secreta inválida');
  }

  const upstream = new URL(
    'https://api.inworld.ai/voices/v1/voices'
  );

  for (const name of ['pageSize', 'pageToken', 'filter']) {
    const value = url.searchParams.get(name);

    if (value) {
      upstream.searchParams.set(name, value);
    }
  }

  try {
    const result = await inworldRequest(
      upstream.toString()
    );

    return sendJson(res, 200, result);
  } catch (error) {
    console.error(
      '[VOICES]',
      error.status,
      error.data || error.message
    );

    return sendError(
      res,
      error.status || 502,
      'Falha ao listar vozes da Inworld',
      error.data || error.message
    );
  }
}

async function handlePreview(req, res, url) {
  if (!isAuthorized(req)) {
    return sendError(res, 401, 'Chave secreta inválida');
  }

  const voiceId =
    url.searchParams.get('voiceId') ||
    url.searchParams.get('voz');

  const modelId =
    url.searchParams.get('modelId') ||
    MODEL_ID;

  if (!voiceId) {
    return sendError(
      res,
      400,
      'Parâmetro voiceId obrigatório'
    );
  }

  const upstream = new URL(
    'https://api.inworld.ai/tts/v1/voice:preview'
  );

  upstream.searchParams.set('voice_id', voiceId);
  upstream.searchParams.set('model_id', modelId);

  try {
    const result = await inworldRequest(
      upstream.toString()
    );

    if (!result.audioContent) {
      return sendError(
        res,
        502,
        'A Inworld não retornou preview'
      );
    }

    const audio = Buffer.from(
      result.audioContent,
      'base64'
    );

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'Content-Disposition':
        'inline; filename="preview.mp3"',
      'Cache-Control': 'no-store',
      ...CORS,
    });

    res.end(audio);
  } catch (error) {
    return sendError(
      res,
      error.status || 502,
      'Falha ao gerar preview',
      error.data || error.message
    );
  }
}

const server = http.createServer(
  async (req, res) => {
    const url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/health'
    ) {
      return sendJson(res, 200, {
        ok: true,
        service: 'tts.ghost1',
        model: MODEL_ID,
        port: PORT,
        timestamp: Date.now(),
      });
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/vozes'
    ) {
      return handleVoices(req, res, url);
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/preview'
    ) {
      return handlePreview(req, res, url);
    }

    if (
      req.method === 'POST' &&
      (
        url.pathname === '/' ||
        url.pathname === '/tts'
      )
    ) {
      return handleSynthesize(req, res);
    }

    return sendError(
      res,
      404,
      'Rota não encontrada'
    );
  }
);

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `tts.ghost1 ativo em http://0.0.0.0:${PORT}`
    );

    console.log('POST / ou /tts -> gera áudio');
    console.log('GET /vozes -> lista vozes');
    console.log('GET /preview -> preview de voz');
    console.log('GET /health -> diagnóstico');
  }
);
