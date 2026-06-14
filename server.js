import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const PORT = numberEnv('PORT', 7979);

const SECRET_KEY = stringEnv('SECRET_KEY');
const INWORLD_API_KEY = stringEnv('INWORLD_API_KEY');

const MODEL_ID = stringEnv('MODEL_ID', 'inworld-tts-2');
const AUDIO_ENCODING = stringEnv('AUDIO_ENCODING', 'MP3').toUpperCase();
const SAMPLE_RATE_HERTZ = numberEnv('SAMPLE_RATE_HERTZ', 48000);
const DELIVERY_MODE = stringEnv('DELIVERY_MODE', 'BALANCED');
const TEXT_NORMALIZATION = stringEnv('TEXT_NORMALIZATION', 'ON');

const TELEGRAM_BOT_TOKEN = stringEnv('TELEGRAM_BOT_TOKEN');

const TELEGRAM_ALLOWED_CHAT_IDS = new Set(
  stringEnv('TELEGRAM_ALLOWED_CHAT_IDS')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

const TELEGRAM_DEFAULT_VOICE = stringEnv(
  'TELEGRAM_DEFAULT_VOICE',
  'Beatriz'
);

const TELEGRAM_DEFAULT_LANGUAGE = normalizeLanguage(
  stringEnv('TELEGRAM_DEFAULT_LANGUAGE', 'PT_BR')
);

const TELEGRAM_SEND_MODE = normalizeSendMode(
  stringEnv('TELEGRAM_SEND_MODE', 'audio')
);

const TELEGRAM_MAX_TEXT_CHARS = numberEnv(
  'TELEGRAM_MAX_TEXT_CHARS',
  4096
);

const CLONE_MIN_SECONDS = numberEnv(
  'CLONE_MIN_SECONDS',
  5
);

const CLONE_MAX_SECONDS = numberEnv(
  'CLONE_MAX_SECONDS',
  15
);

const CLONE_SAMPLE_RATE_HERTZ = numberEnv(
  'CLONE_SAMPLE_RATE_HERTZ',
  24000
);

const CLONE_REMOVE_BACKGROUND_NOISE =
  boolEnv('CLONE_REMOVE_BACKGROUND_NOISE', true);

const DATA_DIR = stringEnv('DATA_DIR', '/app/data');
const STATE_FILE = path.join(DATA_DIR, 'telegram-state.json');

const INWORLD_AUTH = INWORLD_API_KEY.startsWith('Basic ')
  ? INWORLD_API_KEY
  : `Basic ${INWORLD_API_KEY}`;

const TELEGRAM_API = TELEGRAM_BOT_TOKEN
  ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`
  : '';

const missing = Object.entries({
  SECRET_KEY,
  INWORLD_API_KEY,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  console.error(
    `Faltando variável obrigatória: ${missing.join(', ')}`
  );
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, x-secret, Authorization',
};

const LANGUAGE_ALIASES = {
  pt: 'PT_BR',
  'pt-br': 'PT_BR',
  pt_br: 'PT_BR',
  en: 'EN_US',
  'en-us': 'EN_US',
  en_us: 'EN_US',
  es: 'ES_ES',
  'es-es': 'ES_ES',
  es_es: 'ES_ES',
  fr: 'FR_FR',
  'fr-fr': 'FR_FR',
  fr_fr: 'FR_FR',
  de: 'DE_DE',
  'de-de': 'DE_DE',
  de_de: 'DE_DE',
  it: 'IT_IT',
  'it-it': 'IT_IT',
  it_it: 'IT_IT',
  ja: 'JA_JP',
  'ja-jp': 'JA_JP',
  ja_jp: 'JA_JP',
  ko: 'KO_KR',
  'ko-kr': 'KO_KR',
  ko_kr: 'KO_KR',
  zh: 'ZH_CN',
  'zh-cn': 'ZH_CN',
  zh_cn: 'ZH_CN',
  ru: 'RU_RU',
  'ru-ru': 'RU_RU',
  ru_ru: 'RU_RU',
  ar: 'AR_SA',
  'ar-sa': 'AR_SA',
  ar_sa: 'AR_SA',
  pl: 'PL_PL',
  'pl-pl': 'PL_PL',
  pl_pl: 'PL_PL',
  nl: 'NL_NL',
  'nl-nl': 'NL_NL',
  nl_nl: 'NL_NL',
  hi: 'HI_IN',
  'hi-in': 'HI_IN',
  hi_in: 'HI_IN',
};

const state = {
  chats: {},
};

let voicesCache = {
  expiresAt: 0,
  byLanguage: new Map(),
};

const callbackVoices = new Map();

// ============================================================
// UTILITÁRIOS
// ============================================================

function stringEnv(name, fallback = '') {
  const value = process.env[name];
  return value == null
    ? fallback
    : String(value).trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);

  return Number.isFinite(value)
    ? value
    : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];

  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(
    String(value).toLowerCase()
  );
}

function normalizeLanguage(value) {
  if (!value) {
    return 'PT_BR';
  }

  const normalized = String(value)
    .trim()
    .toLowerCase();

  return (
    LANGUAGE_ALIASES[normalized] ||
    String(value)
      .trim()
      .toUpperCase()
      .replace('-', '_')
  );
}

function normalizeSendMode(value) {
  const normalized = String(value).toLowerCase();

  return (
    normalized === 'voice' ||
    normalized === 'voz'
  )
    ? 'voice'
    : 'audio';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

  if (details !== undefined) {
    payload.details = details;
  }

  sendJson(res, status, payload);
}

async function readJson(req) {
  let body = '';

  for await (const chunk of req) {
    body += chunk;

    if (body.length > 12_000_000) {
      throw new Error(
        'Corpo da requisição muito grande'
      );
    }
  }

  return body
    ? JSON.parse(body)
    : {};
}

function isAuthorized(req, body = {}) {
  const headerSecret = req.headers['x-secret'];

  const bearer =
    req.headers.authorization?.startsWith('Bearer ')
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

  if (normalized === 'MP3') {
    return 'audio/mpeg';
  }

  if (
    normalized === 'OGG_OPUS' ||
    normalized === 'OPUS'
  ) {
    return 'audio/ogg';
  }

  if (normalized === 'MULAW') {
    return 'audio/basic';
  }

  return 'audio/wav';
}

function extensionForContentType(contentType) {
  if (contentType === 'audio/mpeg') {
    return 'mp3';
  }

  if (contentType === 'audio/ogg') {
    return 'ogg';
  }

  return 'wav';
}

function safeError(error) {
  if (!error) {
    return 'Erro desconhecido';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error.data) {
    return JSON.stringify(error.data);
  }

  return error.message || String(error);
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (
      parsed?.chats &&
      typeof parsed.chats === 'object'
    ) {
      state.chats = parsed.chats;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(
        '[state] não foi possível carregar:',
        error
      );
    }
  }
}

async function saveState() {
  await mkdir(DATA_DIR, { recursive: true });

  await writeFile(
    STATE_FILE,
    JSON.stringify(state, null, 2),
    'utf8'
  );
}

function getChatState(chatId) {
  const key = String(chatId);

  if (!state.chats[key]) {
    state.chats[key] = {
      voiceId: TELEGRAM_DEFAULT_VOICE,
      modelId: MODEL_ID,
      sendMode: TELEGRAM_SEND_MODE,
      language: TELEGRAM_DEFAULT_LANGUAGE,
      pendingClone: null,
    };
  }

  return state.chats[key];
}

function isTelegramChatAllowed(chatId) {
  if (TELEGRAM_ALLOWED_CHAT_IDS.size === 0) {
    return true;
  }

  return TELEGRAM_ALLOWED_CHAT_IDS.has(
    String(chatId)
  );
}

// ============================================================
// INWORLD
// ============================================================

async function inworldRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: INWORLD_AUTH,
      ...(options.body
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();

  let data;

  try {
    data = raw
      ? JSON.parse(raw)
      : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      `Inworld respondeu HTTP ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

async function synthesizeSpeech({
  text,
  voiceId,
  modelId = MODEL_ID,
  audioEncoding = AUDIO_ENCODING,
  sampleRateHertz = SAMPLE_RATE_HERTZ,
  deliveryMode = DELIVERY_MODE,
  applyTextNormalization = TEXT_NORMALIZATION,
  language,
  temperature,
}) {
  const payload = {
    text,
    voiceId,
    modelId,
    audioConfig: {
      audioEncoding,
      sampleRateHertz,
    },
    deliveryMode,
    applyTextNormalization,
  };

  if (language) {
    payload.language = language;
  }

  if (Number.isFinite(Number(temperature))) {
    payload.temperature = Number(temperature);
  }

  const response = await inworldRequest(
    'https://api.inworld.ai/tts/v1/voice',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );

  const result = response.result || response;

  if (!result.audioContent) {
    throw new Error(
      'A Inworld não retornou audioContent'
    );
  }

  return {
    audio: Buffer.from(
      result.audioContent,
      'base64'
    ),
    usage: result.usage || {},
    audioEncoding,
    modelId:
      result.usage?.modelId ||
      modelId,
  };
}

function splitText(text, maxLength = 1800) {
  const clean = String(text)
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length <= maxLength) {
    return [clean];
  }

  const sentences =
    clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ||
    [clean];

  const chunks = [];
  let current = '';

  for (const sentenceRaw of sentences) {
    const sentence = sentenceRaw.trim();

    if (!sentence) {
      continue;
    }

    if (
      current &&
      `${current} ${sentence}`.length <= maxLength
    ) {
      current += ` ${sentence}`;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (sentence.length <= maxLength) {
      current = sentence;
      continue;
    }

    let remaining = sentence;

    while (remaining.length > maxLength) {
      let cut = remaining.lastIndexOf(
        ' ',
        maxLength
      );

      if (cut < maxLength * 0.5) {
        cut = maxLength;
      }

      chunks.push(
        remaining.slice(0, cut).trim()
      );

      remaining = remaining.slice(cut).trim();
    }

    current = remaining;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function synthesizeLongSpeech({
  text,
  voiceId,
  modelId,
}) {
  const chunks = splitText(text, 1800);
  const audioParts = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const generated = await synthesizeSpeech({
      text: chunks[index],
      voiceId,
      modelId,
      audioEncoding: 'MP3',
      sampleRateHertz: SAMPLE_RATE_HERTZ,
    });

    audioParts.push(generated.audio);
  }

  if (audioParts.length === 1) {
    return {
      audio: audioParts[0],
      modelId,
      chunks: 1,
    };
  }

  return {
    audio: await concatenateMp3Buffers(audioParts),
    modelId,
    chunks: audioParts.length,
  };
}

async function listVoices(language) {
  const normalizedLanguage = normalizeLanguage(language);
  const now = Date.now();

  const cached = voicesCache.byLanguage.get(
    normalizedLanguage
  );

  if (
    cached &&
    voicesCache.expiresAt > now
  ) {
    return cached;
  }

  const url = new URL(
    'https://api.inworld.ai/voices/v1/voices'
  );

  if (normalizedLanguage) {
    url.searchParams.append(
      'languages',
      normalizedLanguage
    );
  }

  const result = await inworldRequest(
    url.toString()
  );

  const voices = Array.isArray(result.voices)
    ? result.voices
    : [];

  if (voicesCache.expiresAt <= now) {
    voicesCache = {
      expiresAt: now + 10 * 60 * 1000,
      byLanguage: new Map(),
    };
  }

  voicesCache.byLanguage.set(
    normalizedLanguage,
    voices
  );

  return voices;
}

async function getVoicePreview(
  voiceId,
  modelId
) {
  const url = new URL(
    'https://api.inworld.ai/tts/v1/voice:preview'
  );

  url.searchParams.set(
    'voice_id',
    voiceId
  );

  url.searchParams.set(
    'model_id',
    modelId
  );

  const response = await inworldRequest(
    url.toString()
  );

  const result = response.result || response;

  if (!result.audioContent) {
    throw new Error(
      'A Inworld não retornou preview'
    );
  }

  return Buffer.from(
    result.audioContent,
    'base64'
  );
}

async function cloneVoice({
  displayName,
  langCode,
  wavBuffer,
  transcription,
  description,
}) {
  const sample = {
    audioData: wavBuffer.toString('base64'),
  };

  if (transcription) {
    sample.transcription = transcription;
  }

  const payload = {
    displayName,
    langCode: normalizeLanguage(langCode),
    voiceSamples: [sample],
    description:
      description ||
      `Voz clonada pelo Ghost1 TTS em ${new Date().toISOString()}.`,
    tags: [
      'ghost1',
      'telegram',
      'clone',
    ],
    audioProcessingConfig: {
      removeBackgroundNoise:
        CLONE_REMOVE_BACKGROUND_NOISE,
    },
  };

  const response = await inworldRequest(
    'https://api.inworld.ai/voices/v1/voices:clone',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );

  const result = response.result || response;
  const voice = result.voice;

  if (!voice?.voiceId) {
    throw new Error(
      'A Inworld não retornou o voiceId da voz clonada'
    );
  }

  voicesCache.expiresAt = 0;
  voicesCache.byLanguage.clear();

  return {
    voice,
    audioSamplesValidated:
      result.audioSamplesValidated || [],
  };
}

// ============================================================
// PROCESSAMENTO DE ÁUDIO
// ============================================================

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [
        'ignore',
        'pipe',
        'pipe',
      ],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} saiu com código ${code}: ${stderr}`
        )
      );
    });
  });
}

async function audioDurationSeconds(filePath) {
  const { stdout } = await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]
  );

  const duration = Number.parseFloat(
    stdout.trim()
  );

  return Number.isFinite(duration)
    ? duration
    : 0;
}

async function concatenateMp3Buffers(buffers) {
  const id = randomUUID();
  const tempDir = os.tmpdir();
  const partPaths = [];
  const listPath = path.join(
    tempDir,
    `ghost1-${id}-list.txt`
  );
  const outputPath = path.join(
    tempDir,
    `ghost1-${id}-combined.mp3`
  );

  try {
    for (
      let index = 0;
      index < buffers.length;
      index += 1
    ) {
      const partPath = path.join(
        tempDir,
        `ghost1-${id}-${index}.mp3`
      );

      await writeFile(
        partPath,
        buffers[index]
      );

      partPaths.push(partPath);
    }

    await writeFile(
      listPath,
      partPaths
        .map(filePath => `file '${filePath}'`)
        .join('\n'),
      'utf8'
    );

    try {
      await runProcess(
        'ffmpeg',
        [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c',
          'copy',
          outputPath,
        ]
      );
    } catch {
      await runProcess(
        'ffmpeg',
        [
          '-y',
          '-f',
          'concat',
          '-safe',
          '0',
          '-i',
          listPath,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '128k',
          outputPath,
        ]
      );
    }

    return await readFile(outputPath);
  } finally {
    await Promise.allSettled(
      [
        ...partPaths,
        listPath,
        outputPath,
      ].map(filePath => unlink(filePath))
    );
  }
}

async function prepareGeneratedAudio(
  inputBuffer,
  sendMode
) {
  const id = randomUUID();
  const tempDir = os.tmpdir();

  const inputPath = path.join(
    tempDir,
    `ghost1-${id}-input.mp3`
  );

  await writeFile(inputPath, inputBuffer);

  try {
    const duration =
      await audioDurationSeconds(inputPath);

    if (sendMode !== 'voice') {
      return {
        buffer: inputBuffer,
        filename: 'ghost1-tts.mp3',
        mimeType: 'audio/mpeg',
        duration,
      };
    }

    const outputPath = path.join(
      tempDir,
      `ghost1-${id}-voice.ogg`
    );

    try {
      await runProcess(
        'ffmpeg',
        [
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-c:a',
          'libopus',
          '-b:a',
          '64k',
          '-vbr',
          'on',
          outputPath,
        ]
      );

      return {
        buffer: await readFile(outputPath),
        filename: 'ghost1-tts.ogg',
        mimeType: 'audio/ogg',
        duration,
      };
    } finally {
      await unlink(outputPath)
        .catch(() => {});
    }
  } finally {
    await unlink(inputPath)
      .catch(() => {});
  }
}

async function prepareCloneSample(
  inputBuffer
) {
  const id = randomUUID();
  const tempDir = os.tmpdir();

  const inputPath = path.join(
    tempDir,
    `ghost1-${id}-clone-input`
  );

  const outputPath = path.join(
    tempDir,
    `ghost1-${id}-clone.wav`
  );

  await writeFile(inputPath, inputBuffer);

  try {
    const originalDuration =
      await audioDurationSeconds(inputPath);

    if (
      originalDuration <
      CLONE_MIN_SECONDS
    ) {
      throw new Error(
        `A amostra tem ${originalDuration.toFixed(1)}s. Envie pelo menos ${CLONE_MIN_SECONDS}s de voz.`
      );
    }

    const wasTrimmed =
      originalDuration >
      CLONE_MAX_SECONDS;

    await runProcess(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-t',
        String(CLONE_MAX_SECONDS),
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(CLONE_SAMPLE_RATE_HERTZ),
        '-c:a',
        'pcm_s16le',
        outputPath,
      ]
    );

    const wavBuffer =
      await readFile(outputPath);

    const finalDuration =
      await audioDurationSeconds(outputPath);

    return {
      wavBuffer,
      originalDuration,
      finalDuration,
      wasTrimmed,
    };
  } finally {
    await Promise.allSettled([
      unlink(inputPath),
      unlink(outputPath),
    ]);
  }
}

// ============================================================
// API HTTP
// ============================================================

async function handleSynthesize(req, res) {
  let body;

  try {
    body = await readJson(req);
  } catch (error) {
    return sendError(
      res,
      400,
      'JSON inválido',
      error.message
    );
  }

  if (!isAuthorized(req, body)) {
    return sendError(
      res,
      401,
      'Chave secreta inválida'
    );
  }

  const text = body.texto ?? body.text;
  const voiceId =
    body.voz ?? body.voiceId;

  if (
    !text ||
    typeof text !== 'string'
  ) {
    return sendError(
      res,
      400,
      'Campo "texto" obrigatório'
    );
  }

  if (text.length > 2000) {
    return sendError(
      res,
      400,
      'Texto muito longo para uma chamada HTTP; máximo de 2000 caracteres'
    );
  }

  if (
    !voiceId ||
    typeof voiceId !== 'string'
  ) {
    return sendError(
      res,
      400,
      'Campo "voz" obrigatório'
    );
  }

  try {
    const result = await synthesizeSpeech({
      text,
      voiceId,
      modelId:
        body.model ??
        body.modelId ??
        MODEL_ID,
      audioEncoding:
        body.audioEncoding ??
        AUDIO_ENCODING,
      sampleRateHertz:
        body.sampleRateHertz ??
        SAMPLE_RATE_HERTZ,
      deliveryMode:
        body.deliveryMode ??
        DELIVERY_MODE,
      applyTextNormalization:
        body.applyTextNormalization ??
        TEXT_NORMALIZATION,
      language: body.language,
      temperature: body.temperature,
    });

    const contentType =
      contentTypeForEncoding(
        result.audioEncoding
      );

    const extension =
      extensionForContentType(
        contentType
      );

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length':
        result.audio.length,
      'Content-Disposition':
        `inline; filename="audio.${extension}"`,
      'Cache-Control': 'no-store',
      'X-Inworld-Model':
        result.modelId,
      'X-Inworld-Characters': String(
        result.usage
          ?.processedCharactersCount ??
        text.length
      ),
      ...CORS,
    });

    res.end(result.audio);
  } catch (error) {
    console.error(
      '[TTS]',
      safeError(error)
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
    return sendError(
      res,
      401,
      'Chave secreta inválida'
    );
  }

  try {
    const language =
      url.searchParams.get('language') ||
      url.searchParams.get('lang') ||
      url.searchParams.get('languages');

    const voices =
      await listVoices(language);

    return sendJson(
      res,
      200,
      { voices }
    );
  } catch (error) {
    console.error(
      '[VOICES]',
      safeError(error)
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
    return sendError(
      res,
      401,
      'Chave secreta inválida'
    );
  }

  const voiceId =
    url.searchParams.get('voiceId') ||
    url.searchParams.get('voz');

  const modelId =
    url.searchParams.get('modelId') ||
    url.searchParams.get('model') ||
    MODEL_ID;

  if (!voiceId) {
    return sendError(
      res,
      400,
      'Parâmetro voiceId obrigatório'
    );
  }

  try {
    const audio =
      await getVoicePreview(
        voiceId,
        modelId
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

async function handleClone(req, res) {
  let body;

  try {
    body = await readJson(req);
  } catch (error) {
    return sendError(
      res,
      400,
      'JSON inválido',
      error.message
    );
  }

  if (!isAuthorized(req, body)) {
    return sendError(
      res,
      401,
      'Chave secreta inválida'
    );
  }

  const audioBase64 =
    body.audioData ||
    body.audioBase64;

  if (!audioBase64) {
    return sendError(
      res,
      400,
      'Campo audioData em Base64 obrigatório'
    );
  }

  if (!body.displayName) {
    return sendError(
      res,
      400,
      'Campo displayName obrigatório'
    );
  }

  try {
    const processed =
      await prepareCloneSample(
        Buffer.from(
          audioBase64,
          'base64'
        )
      );

    const result = await cloneVoice({
      displayName:
        body.displayName,
      langCode:
        body.langCode ||
        body.language ||
        'PT_BR',
      wavBuffer:
        processed.wavBuffer,
      transcription:
        body.transcription,
      description:
        body.description,
    });

    return sendJson(
      res,
      200,
      {
        ...result,
        sample: {
          originalDuration:
            processed.originalDuration,
          finalDuration:
            processed.finalDuration,
          wasTrimmed:
            processed.wasTrimmed,
        },
      }
    );
  } catch (error) {
    return sendError(
      res,
      error.status || 502,
      'Falha ao clonar voz',
      error.data || error.message
    );
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function telegramRequest(
  method,
  body,
  timeoutMs = 35000
) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN não configurado'
    );
  }

  const response = await fetch(
    `${TELEGRAM_API}/${method}`,
    {
      method: body
        ? 'POST'
        : 'GET',
      body,
      signal:
        AbortSignal.timeout(timeoutMs),
    }
  );

  const data = await response.json();

  if (
    !response.ok ||
    !data.ok
  ) {
    const error = new Error(
      data.description ||
      `Telegram HTTP ${response.status}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data.result;
}

async function telegramJson(
  method,
  payload,
  timeoutMs = 35000
) {
  return telegramRequest(
    method,
    new Blob(
      [JSON.stringify(payload)],
      { type: 'application/json' }
    ),
    timeoutMs
  );
}

async function sendTelegramMessage(
  chatId,
  text,
  extra = {}
) {
  return telegramJson(
    'sendMessage',
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...extra,
    },
    15000
  );
}

async function sendTelegramAction(
  chatId,
  action
) {
  try {
    await telegramJson(
      'sendChatAction',
      {
        chat_id: chatId,
        action,
      },
      10000
    );
  } catch {
    // Efeito visual apenas.
  }
}

async function answerCallbackQuery(
  callbackQueryId,
  text
) {
  try {
    await telegramJson(
      'answerCallbackQuery',
      {
        callback_query_id:
          callbackQueryId,
        text,
      },
      10000
    );
  } catch {
    // O botão pode ter expirado.
  }
}

async function sendTelegramAudio(
  chatId,
  preparedAudio,
  caption,
  sendMode
) {
  const form = new FormData();

  form.append(
    'chat_id',
    String(chatId)
  );

  form.append(
    'caption',
    caption
  );

  form.append(
    'duration',
    String(
      Math.max(
        0,
        Math.round(
          preparedAudio.duration
        )
      )
    )
  );

  const blob = new Blob(
    [preparedAudio.buffer],
    { type: preparedAudio.mimeType }
  );

  if (sendMode === 'voice') {
    form.append(
      'voice',
      blob,
      preparedAudio.filename
    );

    return telegramRequest(
      'sendVoice',
      form,
      120000
    );
  }

  form.append(
    'audio',
    blob,
    preparedAudio.filename
  );

  form.append(
    'title',
    'Ghost1 TTS'
  );

  form.append(
    'performer',
    'Inworld'
  );

  return telegramRequest(
    'sendAudio',
    form,
    120000
  );
}

async function downloadTelegramFile(
  fileId
) {
  const file = await telegramJson(
    'getFile',
    {
      file_id: fileId,
    },
    15000
  );

  const response = await fetch(
    `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`,
    {
      signal:
        AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Falha ao baixar arquivo do Telegram: HTTP ${response.status}`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

function telegramMenu(chatState) {
  return [
    '🎙️ GHOST1 TTS',
    '',
    'Envie texto e receba o áudio completo.',
    'A geração NÃO é cortada em 15 segundos.',
    '',
    'CLONAR VOZ:',
    '/clonar Nome | PT_BR | transcrição opcional',
    `Depois envie uma mensagem de voz ou arquivo de áudio com ${CLONE_MIN_SECONDS}-${CLONE_MAX_SECONDS}s.`,
    '',
    `Voz atual: ${chatState.voiceId}`,
    `Modelo: ${chatState.modelId}`,
    `Formato: ${chatState.sendMode === 'voice' ? 'mensagem de voz' : 'arquivo MP3'}`,
    '',
    'Comandos:',
    '/vozes pt - escolher voz',
    '/voz NOME_OU_ID - definir voz',
    '/preview - ouvir voz atual',
    '/clonar ... - iniciar clonagem',
    '/cancelar - cancelar clonagem',
    '/modelo ID - trocar modelo',
    '/modo audio|voz - formato',
    '/teste - gerar teste',
    '/status - configuração',
    '/ajuda - este menu',
  ].join('\n');
}

function telegramStatus(chatState) {
  const pending = chatState.pendingClone
    ? `aguardando áudio para "${chatState.pendingClone.displayName}"`
    : 'nenhuma clonagem pendente';

  return [
    '✅ Ghost1 TTS está ativo',
    `Voz: ${chatState.voiceId}`,
    `Modelo: ${chatState.modelId}`,
    `Idioma: ${chatState.language}`,
    `Formato: ${chatState.sendMode}`,
    `Texto máximo no Telegram: ${TELEGRAM_MAX_TEXT_CHARS} caracteres`,
    `Clonagem: ${CLONE_MIN_SECONDS}-${CLONE_MAX_SECONDS}s de amostra`,
    `Estado da clonagem: ${pending}`,
    'Geração de fala: sem corte de 15 segundos',
  ].join('\n');
}

function callbackTokenForVoice(voice) {
  const hash = createHash('sha256')
    .update(
      `${voice.voiceId}:${Date.now()}:${Math.random()}`
    )
    .digest('base64url')
    .slice(0, 18);

  callbackVoices.set(hash, voice);

  return hash;
}

async function sendVoiceKeyboard(
  chatId,
  language
) {
  const normalizedLanguage =
    normalizeLanguage(language);

  const voices = await listVoices(
    normalizedLanguage
  );

  if (voices.length === 0) {
    await sendTelegramMessage(
      chatId,
      `Nenhuma voz encontrada para ${normalizedLanguage}.`
    );

    return;
  }

  const visible = voices.slice(0, 40);
  const buttons = [];

  for (
    let index = 0;
    index < visible.length;
    index += 2
  ) {
    const row = visible
      .slice(index, index + 2)
      .map(voice => ({
        text:
          voice.displayName ||
          voice.voiceId ||
          voice.name,
        callback_data:
          `voice:${callbackTokenForVoice(voice)}`,
      }));

    buttons.push(row);
  }

  await sendTelegramMessage(
    chatId,
    [
      `Vozes ${normalizedLanguage}:`,
      'Toque para selecionar.',
      `Mostrando ${visible.length} de ${voices.length}.`,
    ].join('\n'),
    {
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function generateAndSendTelegramAudio(
  chatId,
  text,
  chatState
) {
  const cleanText =
    String(text || '').trim();

  if (!cleanText) {
    await sendTelegramMessage(
      chatId,
      'Envie algum texto para gerar o áudio.'
    );

    return;
  }

  if (
    cleanText.length >
    TELEGRAM_MAX_TEXT_CHARS
  ) {
    await sendTelegramMessage(
      chatId,
      `Texto grande demais. Máximo no Telegram: ${TELEGRAM_MAX_TEXT_CHARS} caracteres.`
    );

    return;
  }

  await sendTelegramAction(
    chatId,
    chatState.sendMode === 'voice'
      ? 'record_voice'
      : 'upload_audio'
  );

  const generated =
    await synthesizeLongSpeech({
      text: cleanText,
      voiceId: chatState.voiceId,
      modelId: chatState.modelId,
    });

  const prepared =
    await prepareGeneratedAudio(
      generated.audio,
      chatState.sendMode
    );

  const caption = [
    `🎙️ ${chatState.voiceId}`,
    `Modelo: ${generated.modelId}`,
    generated.chunks > 1
      ? `Texto dividido em ${generated.chunks} chamadas e reunido em um único áudio.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  await sendTelegramAudio(
    chatId,
    prepared,
    caption,
    chatState.sendMode
  );
}

function parseCloneCommand(argument, chatState) {
  const parts = String(argument)
    .split('|')
    .map(value => value.trim());

  const displayName = parts[0];
  const langCode =
    normalizeLanguage(
      parts[1] ||
      chatState.language
    );

  const transcription =
    parts.slice(2).join(' | ').trim();

  return {
    displayName,
    langCode,
    transcription,
  };
}

async function handleCloneAudio(
  chatId,
  message,
  chatState
) {
  const source =
    message.voice ||
    message.audio ||
    message.document;

  if (!source?.file_id) {
    return false;
  }

  if (!chatState.pendingClone) {
    await sendTelegramMessage(
      chatId,
      [
        'Recebi um áudio, mas nenhuma clonagem foi iniciada.',
        'Use:',
        '/clonar Nome da Voz | PT_BR | transcrição opcional',
        `Depois envie uma amostra de ${CLONE_MIN_SECONDS}-${CLONE_MAX_SECONDS}s.`,
      ].join('\n')
    );

    return true;
  }

  const mimeType =
    source.mime_type || '';

  if (
    message.document &&
    mimeType &&
    !mimeType.startsWith('audio/')
  ) {
    await sendTelegramMessage(
      chatId,
      'O documento enviado não parece ser um arquivo de áudio.'
    );

    return true;
  }

  try {
    await sendTelegramAction(
      chatId,
      'typing'
    );

    await sendTelegramMessage(
      chatId,
      '🔄 Baixando e preparando a amostra para clonagem...'
    );

    const originalBuffer =
      await downloadTelegramFile(
        source.file_id
      );

    const processed =
      await prepareCloneSample(
        originalBuffer
      );

    await sendTelegramMessage(
      chatId,
      processed.wasTrimmed
        ? `A amostra tinha ${processed.originalDuration.toFixed(1)}s e foi cortada para ${CLONE_MAX_SECONDS}s, somente para a clonagem.`
        : `Amostra aceita: ${processed.finalDuration.toFixed(1)}s.`
    );

    const cloned = await cloneVoice({
      displayName:
        chatState.pendingClone.displayName,
      langCode:
        chatState.pendingClone.langCode,
      wavBuffer:
        processed.wavBuffer,
      transcription:
        chatState.pendingClone.transcription,
    });

    chatState.voiceId =
      cloned.voice.voiceId;

    chatState.language =
      cloned.voice.langCode ||
      chatState.pendingClone.langCode;

    chatState.pendingClone = null;

    await saveState();

    await sendTelegramMessage(
      chatId,
      [
        '✅ VOZ CLONADA',
        `Nome: ${cloned.voice.displayName}`,
        `Voice ID: ${cloned.voice.voiceId}`,
        `Idioma: ${cloned.voice.langCode}`,
        '',
        'A voz clonada já foi selecionada.',
        'Agora envie qualquer texto ou use /teste.',
        '',
        'Os áudios gerados não são limitados a 15 segundos.',
      ].join('\n')
    );
  } catch (error) {
    console.error(
      '[telegram clone]',
      safeError(error)
    );

    await sendTelegramMessage(
      chatId,
      `❌ Não foi possível clonar a voz.\n${safeError(error)}`
    );
  }

  return true;
}

async function handleTelegramCommand(
  chatId,
  text
) {
  const [rawCommand, ...args] =
    text.trim().split(/\s+/);

  const command =
    rawCommand
      .split('@')[0]
      .toLowerCase();

  const argument =
    args.join(' ').trim();

  const chatState =
    getChatState(chatId);

  if (
    command === '/start' ||
    command === '/ajuda' ||
    command === '/help'
  ) {
    await sendTelegramMessage(
      chatId,
      telegramMenu(chatState)
    );

    return;
  }

  if (command === '/status') {
    await sendTelegramMessage(
      chatId,
      telegramStatus(chatState)
    );

    return;
  }

  if (command === '/vozes') {
    const language =
      normalizeLanguage(
        argument ||
        chatState.language
      );

    chatState.language = language;
    await saveState();

    await sendVoiceKeyboard(
      chatId,
      language
    );

    return;
  }

  if (command === '/voz') {
    if (!argument) {
      await sendTelegramMessage(
        chatId,
        `Voz atual: ${chatState.voiceId}\nUse /voz Beatriz ou /vozes pt`
      );

      return;
    }

    chatState.voiceId = argument;
    await saveState();

    await sendTelegramMessage(
      chatId,
      `✅ Voz alterada para: ${argument}`
    );

    return;
  }

  if (command === '/modelo') {
    if (!argument) {
      await sendTelegramMessage(
        chatId,
        `Modelo atual: ${chatState.modelId}`
      );

      return;
    }

    chatState.modelId = argument;
    await saveState();

    await sendTelegramMessage(
      chatId,
      `✅ Modelo alterado para: ${argument}`
    );

    return;
  }

  if (command === '/modo') {
    if (
      !argument ||
      ![
        'audio',
        'voz',
        'voice',
      ].includes(
        argument.toLowerCase()
      )
    ) {
      await sendTelegramMessage(
        chatId,
        'Use /modo audio ou /modo voz'
      );

      return;
    }

    chatState.sendMode =
      normalizeSendMode(argument);

    await saveState();

    await sendTelegramMessage(
      chatId,
      `✅ Formato alterado para: ${chatState.sendMode === 'voice' ? 'mensagem de voz' : 'arquivo MP3'}`
    );

    return;
  }

  if (command === '/clonar') {
    const cloneConfig =
      parseCloneCommand(
        argument,
        chatState
      );

    if (!cloneConfig.displayName) {
      await sendTelegramMessage(
        chatId,
        [
          'Use:',
          '/clonar Nome da Voz | PT_BR | texto falado opcional',
          '',
          'Exemplo:',
          '/clonar Minha Voz | PT_BR | Olá, esta é uma amostra da minha voz.',
          '',
          `Depois envie um áudio de ${CLONE_MIN_SECONDS}-${CLONE_MAX_SECONDS}s.`,
          'Envie somente uma voz que você tenha autorização para clonar.',
        ].join('\n')
      );

      return;
    }

    chatState.pendingClone =
      cloneConfig;

    await saveState();

    await sendTelegramMessage(
      chatId,
      [
        '🎤 CLONAGEM INICIADA',
        `Nome: ${cloneConfig.displayName}`,
        `Idioma: ${cloneConfig.langCode}`,
        cloneConfig.transcription
          ? `Transcrição: ${cloneConfig.transcription}`
          : 'Transcrição: não informada',
        '',
        `Agora envie uma mensagem de voz ou arquivo de áudio com ${CLONE_MIN_SECONDS}-${CLONE_MAX_SECONDS}s.`,
        `Se passar de ${CLONE_MAX_SECONDS}s, somente a amostra de clonagem será cortada.`,
        'A geração TTS posterior não será cortada.',
      ].join('\n')
    );

    return;
  }

  if (command === '/cancelar') {
    chatState.pendingClone = null;
    await saveState();

    await sendTelegramMessage(
      chatId,
      'Clonagem cancelada.'
    );

    return;
  }

  if (command === '/preview') {
    await sendTelegramAction(
      chatId,
      'upload_audio'
    );

    const preview =
      await getVoicePreview(
        chatState.voiceId,
        chatState.modelId
      );

    const prepared =
      await prepareGeneratedAudio(
        preview,
        chatState.sendMode
      );

    await sendTelegramAudio(
      chatId,
      prepared,
      `Preview: ${chatState.voiceId}`,
      chatState.sendMode
    );

    return;
  }

  if (command === '/teste') {
    await generateAndSendTelegramAudio(
      chatId,
      'Olá! Este é um teste do Ghost1 TTS usando a voz selecionada.',
      chatState
    );

    return;
  }

  await sendTelegramMessage(
    chatId,
    'Comando desconhecido. Use /ajuda.'
  );
}

async function handleTelegramMessage(message) {
  const chatId =
    message?.chat?.id;

  if (!chatId) {
    return;
  }

  if (!isTelegramChatAllowed(chatId)) {
    await sendTelegramMessage(
      chatId,
      '⛔ Este chat não está autorizado.'
    );

    return;
  }

  const chatState =
    getChatState(chatId);

  const handledAudio =
    await handleCloneAudio(
      chatId,
      message,
      chatState
    );

  if (handledAudio) {
    return;
  }

  const text =
    message.text?.trim();

  if (!text) {
    await sendTelegramMessage(
      chatId,
      'Envie texto para gerar áudio ou use /clonar antes de enviar uma amostra de voz.'
    );

    return;
  }

  try {
    if (text.startsWith('/')) {
      await handleTelegramCommand(
        chatId,
        text
      );

      return;
    }

    await generateAndSendTelegramAudio(
      chatId,
      text,
      chatState
    );
  } catch (error) {
    console.error(
      '[telegram message]',
      safeError(error)
    );

    await sendTelegramMessage(
      chatId,
      `❌ Não foi possível concluir.\n${safeError(error)}`
    );
  }
}

async function handleTelegramCallback(
  callbackQuery
) {
  const chatId =
    callbackQuery
      ?.message
      ?.chat
      ?.id;

  const data =
    callbackQuery?.data || '';

  if (
    !chatId ||
    !data.startsWith('voice:')
  ) {
    return;
  }

  if (!isTelegramChatAllowed(chatId)) {
    await answerCallbackQuery(
      callbackQuery.id,
      'Não autorizado'
    );

    return;
  }

  const token =
    data.slice('voice:'.length);

  const voice =
    callbackVoices.get(token);

  if (!voice) {
    await answerCallbackQuery(
      callbackQuery.id,
      'Este botão expirou. Use /vozes novamente.'
    );

    return;
  }

  const chatState =
    getChatState(chatId);

  chatState.voiceId =
    voice.voiceId ||
    voice.name;

  await saveState();

  await answerCallbackQuery(
    callbackQuery.id,
    `Voz: ${voice.displayName || chatState.voiceId}`
  );

  await sendTelegramMessage(
    chatId,
    `✅ Voz selecionada: ${voice.displayName || chatState.voiceId}\nID: ${chatState.voiceId}`
  );
}

async function configureTelegramBot() {
  await telegramJson(
    'deleteWebhook',
    {
      drop_pending_updates: true,
    },
    15000
  );

  await telegramJson(
    'setMyCommands',
    {
      commands: [
        {
          command: 'start',
          description: 'Abrir o menu',
        },
        {
          command: 'clonar',
          description: 'Clonar voz com amostra de 5-15s',
        },
        {
          command: 'vozes',
          description: 'Escolher uma voz',
        },
        {
          command: 'voz',
          description: 'Definir voz por ID',
        },
        {
          command: 'preview',
          description: 'Ouvir a voz atual',
        },
        {
          command: 'teste',
          description: 'Gerar áudio de teste',
        },
        {
          command: 'modo',
          description: 'MP3 ou mensagem de voz',
        },
        {
          command: 'status',
          description: 'Mostrar configuração',
        },
        {
          command: 'cancelar',
          description: 'Cancelar clonagem pendente',
        },
      ],
    },
    15000
  );
}

async function telegramLoop() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log(
      '[telegram] desativado: TELEGRAM_BOT_TOKEN ausente'
    );

    return;
  }

  try {
    await configureTelegramBot();
    console.log('[telegram] bot configurado');
  } catch (error) {
    console.error(
      '[telegram] falha na configuração:',
      safeError(error)
    );
  }

  let offset = 0;

  while (true) {
    try {
      const updates =
        await telegramJson(
          'getUpdates',
          {
            offset,
            timeout: 25,
            allowed_updates: [
              'message',
              'callback_query',
            ],
          },
          35000
        );

      for (const update of updates) {
        offset = Math.max(
          offset,
          update.update_id + 1
        );

        if (update.message) {
          await handleTelegramMessage(
            update.message
          );
        }

        if (update.callback_query) {
          await handleTelegramCallback(
            update.callback_query
          );
        }
      }
    } catch (error) {
      console.error(
        '[telegram loop]',
        safeError(error)
      );

      await sleep(3000);
    }
  }
}

// ============================================================
// SERVIDOR
// ============================================================

const server = http.createServer(
  async (req, res) => {
    const url = new URL(
      req.url,
      `http://${req.headers.host || 'localhost'}`
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/health'
    ) {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'tts.ghost1',
          model: MODEL_ID,
          port: PORT,
          telegram: {
            enabled:
              Boolean(TELEGRAM_BOT_TOKEN),
            sendMode:
              TELEGRAM_SEND_MODE,
            generationAudioLimitSeconds:
              null,
          },
          cloning: {
            enabled: true,
            minSampleSeconds:
              CLONE_MIN_SECONDS,
            maxSampleSeconds:
              CLONE_MAX_SECONDS,
          },
          timestamp: Date.now(),
        }
      );

      return;
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/vozes'
    ) {
      await handleVoices(
        req,
        res,
        url
      );

      return;
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/preview'
    ) {
      await handlePreview(
        req,
        res,
        url
      );

      return;
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/clone'
    ) {
      await handleClone(
        req,
        res
      );

      return;
    }

    if (
      req.method === 'POST' &&
      (
        url.pathname === '/' ||
        url.pathname === '/tts'
      )
    ) {
      await handleSynthesize(
        req,
        res
      );

      return;
    }

    sendError(
      res,
      404,
      'Rota não encontrada'
    );
  }
);

await loadState();

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `tts.ghost1 ativo em http://0.0.0.0:${PORT}`
    );

    console.log('POST / ou /tts -> gera áudio');
    console.log('POST /clone -> clona voz');
    console.log('GET /vozes -> lista vozes');
    console.log('GET /preview -> preview');
    console.log('GET /health -> diagnóstico');

    void telegramLoop();
  }
);
