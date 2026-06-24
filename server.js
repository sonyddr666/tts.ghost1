import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ============================================================
// UTILITÁRIOS DE CONFIGURAÇÃO
// ============================================================

function stringEnv(name, fallback = '') {
  const value = process.env[name];
  return value == null ? fallback : String(value).trim();
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];

  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on', 'sim'].includes(
    String(value).trim().toLowerCase()
  );
}

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

function normalizeLanguage(value) {
  if (!value) {
    return 'PT_BR';
  }

  const normalized = String(value).trim().toLowerCase();

  return (
    LANGUAGE_ALIASES[normalized] ||
    String(value).trim().toUpperCase().replaceAll('-', '_')
  );
}

function normalizeSendMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'voice' || normalized === 'voz'
    ? 'voice'
    : 'audio';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeError(error) {
  if (!error) {
    return 'Erro desconhecido';
  }

  if (typeof error === 'string') {
    return error;
  }

  if (error.data) {
    try {
      return JSON.stringify(error.data);
    } catch {
      return String(error.data);
    }
  }

  return error.message || String(error);
}

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
const INWORLD_TIMEOUT_MS = numberEnv('INWORLD_TIMEOUT_MS', 120000);
const PROCESS_TIMEOUT_MS = numberEnv('PROCESS_TIMEOUT_MS', 180000);
const INWORLD_WORKSPACE_ID = stringEnv(
  'INWORLD_WORKSPACE_ID',
  'default--pb4bm1oowkem_r9ri2wiw'
);

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

const CLONE_MIN_SECONDS = numberEnv('CLONE_MIN_SECONDS', 5);
const CLONE_MAX_SECONDS = numberEnv('CLONE_MAX_SECONDS', 15);
const CLONE_SAMPLE_RATE_HERTZ = numberEnv(
  'CLONE_SAMPLE_RATE_HERTZ',
  24000
);
const CLONE_REMOVE_BACKGROUND_NOISE = boolEnv(
  'CLONE_REMOVE_BACKGROUND_NOISE',
  true
);

const DATA_DIR = stringEnv('DATA_DIR', '/app/data');
const STATE_FILE = path.join(DATA_DIR, 'telegram-state.json');

const INWORLD_AUTH_DEFAULT = INWORLD_API_KEY.startsWith('Basic ')
  ? INWORLD_API_KEY
  : `Basic ${INWORLD_API_KEY}`;

// Chave ativa em runtime — pode ser trocada via /setkey sem reiniciar
let runtimeInworldAuth = INWORLD_AUTH_DEFAULT;

function getInworldAuth() {
  return runtimeInworldAuth;
}

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
  console.error(`Faltando variável obrigatória: ${missing.join(', ')}`);
  process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`PORT inválida: ${PORT}`);
  process.exit(1);
}

if (CLONE_MIN_SECONDS <= 0 || CLONE_MAX_SECONDS < CLONE_MIN_SECONDS) {
  console.error(
    'Configuração inválida: CLONE_MAX_SECONDS deve ser maior ou igual a CLONE_MIN_SECONDS.'
  );
  process.exit(1);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-secret, Authorization',
};

// ============================================================
// ESTADO
// ============================================================

const state = {
  chats: {},
  clonedVoices: [],
};

let saveStateQueue = Promise.resolve();

let voicesCache = {
  expiresAt: 0,
  byLanguage: new Map(),
};

const callbackVoices = new Map();

const telegramRuntime = {
  enabled: Boolean(TELEGRAM_BOT_TOKEN),
  configured: false,
  polling: false,
  lastUpdateAt: null,
  lastError: null,
};

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);

    if (parsed?.chats && typeof parsed.chats === 'object') {
      state.chats = parsed.chats;
    }

    if (Array.isArray(parsed?.clonedVoices)) {
      state.clonedVoices = parsed.clonedVoices.filter(
        voice => voice && typeof voice === 'object' && voice.voiceId
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[state] não foi possível carregar:', safeError(error));
    }
  }
}

function saveState() {
  saveStateQueue = saveStateQueue
    .catch(() => {})
    .then(async () => {
      await mkdir(DATA_DIR, { recursive: true });

      const tempFile = `${STATE_FILE}.${randomUUID()}.tmp`;
      await writeFile(tempFile, JSON.stringify(state, null, 2), 'utf8');
      await rename(tempFile, STATE_FILE);
    });

  return saveStateQueue;
}

function getChatState(chatId) {
  const key = String(chatId);

  if (!state.chats[key]) {
    state.chats[key] = {
      voiceId: TELEGRAM_DEFAULT_VOICE,
      voiceDisplayName: TELEGRAM_DEFAULT_VOICE,
      voiceSource: 'SYSTEM',
      voiceResourceName: '',
      voiceWorkspaceId: '',
      modelId: MODEL_ID,
      sendMode: TELEGRAM_SEND_MODE,
      language: TELEGRAM_DEFAULT_LANGUAGE,
      pendingClone: null,
    };
  }

  const chatState = state.chats[key];

  chatState.voiceId = String(
    chatState.voiceId ||
    TELEGRAM_DEFAULT_VOICE
  ).trim();

  chatState.voiceDisplayName = String(
    chatState.voiceDisplayName ||
    chatState.voiceId ||
    TELEGRAM_DEFAULT_VOICE
  ).trim();

  chatState.voiceSource = String(
    chatState.voiceSource ||
    ''
  ).trim();

  chatState.voiceResourceName = String(
    chatState.voiceResourceName ||
    ''
  ).trim();

  chatState.voiceWorkspaceId = String(
    chatState.voiceWorkspaceId ||
    voiceWorkspaceId(chatState.voiceId) ||
    ''
  ).trim();

  return chatState;
}

function isTelegramChatAllowed(chatId) {
  if (TELEGRAM_ALLOWED_CHAT_IDS.size === 0) {
    return true;
  }

  return TELEGRAM_ALLOWED_CHAT_IDS.has(String(chatId));
}

function clearVoicesCache() {
  voicesCache.expiresAt = 0;
  voicesCache.byLanguage.clear();
}

function normalizeVoiceText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

function normalizeVoiceLookup(value) {
  let normalized = normalizeVoiceText(value);

  normalized = normalized
    .replace(/^workspaces\/[^/]+\/voices\//, '');

  if (normalized.includes('__')) {
    normalized = normalized
      .split('__')
      .slice(1)
      .join('__');
  }

  return normalized.replace(/[^a-z0-9]+/g, '');
}

function voiceWorkspaceId(value) {
  const raw = String(value || '').trim();

  if (raw.startsWith('workspaces/')) {
    return raw.split('/')[1] || '';
  }

  const separator = raw.indexOf('__');

  if (separator > 0) {
    return raw.slice(0, separator);
  }

  return '';
}

function voiceShortId(value) {
  const raw = String(value || '').trim();

  if (!raw) {
    return '';
  }

  if (raw.startsWith('workspaces/')) {
    return raw.split('/voices/')[1] || raw;
  }

  const separator = raw.indexOf('__');

  if (separator >= 0) {
    return raw.slice(separator + 2);
  }

  return raw;
}

function buildVoiceIdFromResourceName(name) {
  const raw = String(name || '').trim();
  const match = raw.match(
    /^workspaces\/([^/]+)\/voices\/(.+)$/
  );

  if (!match) {
    return '';
  }

  return `${match[1]}__${match[2]}`;
}

function normalizeVoiceRecord(voice) {
  if (!voice || typeof voice !== 'object') {
    return null;
  }

  const resourceName = String(
    voice.name ||
    voice.resourceName ||
    ''
  ).trim();

  const voiceId = String(
    voice.voiceId ||
    voice.voice_id ||
    buildVoiceIdFromResourceName(resourceName) ||
    ''
  ).trim();

  if (!voiceId) {
    return null;
  }

  const shortId = voiceShortId(voiceId);
  const displayName = String(
    voice.displayName ||
    voice.display_name ||
    voice.title ||
    shortId ||
    voiceId
  ).trim();

  const rawLangCode =
    voice.langCode ||
    voice.lang_code ||
    voice.language ||
    voice.languages?.[0] ||
    '';

  const langCode = rawLangCode
    ? normalizeLanguage(rawLangCode)
    : '';

  const source = String(
    voice.source ||
    (voiceId.includes('__') ? 'IVC' : 'SYSTEM')
  )
    .trim()
    .toUpperCase();

  return {
    ...voice,
    voiceId,
    name: resourceName || voice.name || voiceId,
    displayName,
    langCode,
    source,
    workspaceId:
      voice.workspaceId ||
      voiceWorkspaceId(voiceId) ||
      voiceWorkspaceId(resourceName),
    shortId,
  };
}

function voiceKey(voice) {
  const normalized = normalizeVoiceRecord(voice);

  return String(
    normalized?.voiceId ||
    normalized?.name ||
    normalized?.displayName ||
    ''
  ).trim();
}

function isCustomVoice(voice) {
  const normalized = normalizeVoiceRecord(voice);

  if (!normalized) {
    return false;
  }

  const source = String(normalized.source || '').toUpperCase();
  const tags = Array.isArray(normalized.tags)
    ? normalized.tags.map(tag => String(tag).toLowerCase())
    : [];

  return (
    normalized.isCustom === true ||
    normalized.voiceId.includes('__') ||
    ['IVC', 'PVC', 'CUSTOM', 'DESIGNED', 'VOICE_DESIGN'].includes(source) ||
    tags.includes('clone') ||
    tags.includes('cloned') ||
    tags.includes('ghost1') ||
    tags.includes('custom')
  );
}

function voiceMatchesLanguage(voice, language) {
  if (!language) {
    return true;
  }

  const normalized = normalizeVoiceRecord(voice);

  if (!normalized) {
    return false;
  }

  if (
    !normalized.langCode ||
    normalized.langCode === 'AUTO'
  ) {
    return true;
  }

  return normalized.langCode === normalizeLanguage(language);
}

function voiceLabel(voice) {
  const normalized = normalizeVoiceRecord(voice);

  if (!normalized) {
    return 'Voz';
  }

  return normalized.displayName ||
    normalized.shortId ||
    normalized.voiceId;
}

function voiceWorkspaceLabel(voice) {
  const normalized = normalizeVoiceRecord(voice);

  return normalized?.workspaceId || '';
}

function voiceSearchValues(voice) {
  const normalized = normalizeVoiceRecord(voice);

  if (!normalized) {
    return [];
  }

  return Array.from(
    new Set(
      [
        normalized.displayName,
        normalized.voiceId,
        normalized.name,
        normalized.shortId,
        normalized.voiceId.replace(
          `${normalized.workspaceId}__`,
          ''
        ),
      ]
        .map(value => String(value || '').trim())
        .filter(Boolean)
    )
  );
}

function voiceMatchScore(voice, query) {
  const normalizedQuery = normalizeVoiceLookup(query);

  if (!normalizedQuery) {
    return 0;
  }

  const normalized = normalizeVoiceRecord(voice);

  if (!normalized) {
    return 0;
  }

  const rawQuery = normalizeVoiceText(query);
  const exactRawValues = voiceSearchValues(normalized)
    .map(normalizeVoiceText);

  if (exactRawValues.includes(rawQuery)) {
    return 1000;
  }

  const candidates = voiceSearchValues(normalized)
    .map(normalizeVoiceLookup)
    .filter(Boolean);

  if (candidates.includes(normalizedQuery)) {
    return isCustomVoice(normalized) ? 980 : 960;
  }

  const displayName = normalizeVoiceLookup(
    normalized.displayName
  );

  if (
    displayName.startsWith(normalizedQuery) ||
    normalizedQuery.startsWith(displayName)
  ) {
    return isCustomVoice(normalized) ? 820 : 780;
  }

  const shortId = normalizeVoiceLookup(
    normalized.shortId
  );

  if (
    shortId.startsWith(normalizedQuery) ||
    normalizedQuery.startsWith(shortId)
  ) {
    return isCustomVoice(normalized) ? 760 : 720;
  }

  if (
    displayName.includes(normalizedQuery) ||
    normalizedQuery.includes(displayName)
  ) {
    return isCustomVoice(normalized) ? 680 : 640;
  }

  if (
    shortId.includes(normalizedQuery) ||
    normalizedQuery.includes(shortId)
  ) {
    return isCustomVoice(normalized) ? 620 : 580;
  }

  return 0;
}

function mergeAndSortVoices(...voiceLists) {
  const voicesByKey = new Map();

  for (const list of voiceLists) {
    for (const rawVoice of Array.isArray(list) ? list : []) {
      const voice = normalizeVoiceRecord(rawVoice);
      const key = voiceKey(voice);

      if (!voice || !key) {
        continue;
      }

      const previous = voicesByKey.get(key) || {};

      voicesByKey.set(
        key,
        normalizeVoiceRecord({
          ...previous,
          ...voice,
        })
      );
    }
  }

  return [...voicesByKey.values()]
    .filter(Boolean)
    .sort((a, b) => {
      const customDifference =
        Number(isCustomVoice(b)) -
        Number(isCustomVoice(a));

      if (customDifference !== 0) {
        return customDifference;
      }

      return voiceLabel(a).localeCompare(
        voiceLabel(b),
        'pt-BR',
        { sensitivity: 'base' }
      );
    });
}

function rememberClonedVoice(voice) {
  const normalized = normalizeVoiceRecord(voice);
  const key = voiceKey(normalized);

  if (!normalized || !key) {
    return false;
  }

  const before = JSON.stringify(state.clonedVoices);

  state.clonedVoices = mergeAndSortVoices(
    state.clonedVoices,
    [{
      ...normalized,
      isCustom: true,
      source: normalized.source || 'IVC',
      tags: Array.from(
        new Set([
          ...(Array.isArray(normalized.tags)
            ? normalized.tags
            : []),
          'ghost1',
          'clone',
        ])
      ),
    }]
  ).filter(isCustomVoice);

  return before !== JSON.stringify(state.clonedVoices);
}

function applyVoiceToChatState(chatState, voice) {
  const normalized = normalizeVoiceRecord(voice);

  if (!normalized) {
    throw new Error(
      'A voz selecionada não possui um voiceId válido.'
    );
  }

  const before = JSON.stringify({
    voiceId: chatState.voiceId,
    voiceDisplayName: chatState.voiceDisplayName,
    voiceSource: chatState.voiceSource,
    voiceResourceName: chatState.voiceResourceName,
    voiceWorkspaceId: chatState.voiceWorkspaceId,
    language: chatState.language,
  });

  chatState.voiceId = normalized.voiceId;
  chatState.voiceDisplayName = normalized.displayName;
  chatState.voiceSource = normalized.source;
  chatState.voiceResourceName = normalized.name || '';
  chatState.voiceWorkspaceId = normalized.workspaceId || '';

  if (
    normalized.langCode &&
    normalized.langCode !== 'AUTO'
  ) {
    chatState.language = normalized.langCode;
  }

  const after = JSON.stringify({
    voiceId: chatState.voiceId,
    voiceDisplayName: chatState.voiceDisplayName,
    voiceSource: chatState.voiceSource,
    voiceResourceName: chatState.voiceResourceName,
    voiceWorkspaceId: chatState.voiceWorkspaceId,
    language: chatState.language,
  });

  return before !== after;
}

function voiceCandidateSummary(voice) {
  const normalized = normalizeVoiceRecord(voice);

  if (!normalized) {
    return null;
  }

  return {
    displayName: normalized.displayName,
    voiceId: normalized.voiceId,
    shortId: normalized.shortId,
    workspaceId: normalized.workspaceId,
    source: normalized.source,
    langCode: normalized.langCode,
  };
}

function isUnknownVoiceError(error) {
  return safeError(error)
    .toLowerCase()
    .includes('unknown voice');
}

function createVoiceNotFoundError(query, extra = '') {
  const error = new Error(
    [
      `A voz "${query}" não foi encontrada na conta atual da Inworld.`,
      INWORLD_WORKSPACE_ID
        ? `Workspace configurado: ${INWORLD_WORKSPACE_ID}.`
        : '',
      'Use /vozes para selecionar uma voz válida.',
      extra,
    ]
      .filter(Boolean)
      .join(' ')
  );

  error.code = 'VOICE_NOT_FOUND';
  return error;
}

// ============================================================
// HTTP
// ============================================================

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...CORS,
    ...extraHeaders,
  });

  res.end(payload);
}

function sendError(res, status, message, details) {
  const payload = { error: message };

  if (details !== undefined) {
    payload.details = details;
  }

  sendJson(res, status, payload);
}

async function readJson(req, maxBytes = 12_000_000) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > maxBytes) {
      const error = new Error('Corpo da requisição muito grande');
      error.status = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
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

  if (normalized === 'MP3') {
    return 'audio/mpeg';
  }

  if (normalized === 'OGG_OPUS' || normalized === 'OPUS') {
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

// ============================================================
// INWORLD
// ============================================================

async function inworldRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INWORLD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: getInworldAuth(),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
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
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(
        `A Inworld excedeu o tempo limite de ${INWORLD_TIMEOUT_MS}ms`
      );
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
    payload.language = normalizeLanguage(language);
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
    throw new Error('A Inworld não retornou audioContent');
  }

  return {
    audio: Buffer.from(result.audioContent, 'base64'),
    usage: result.usage || {},
    audioEncoding,
    modelId: result.usage?.modelId || modelId,
  };
}

function splitText(text, maxLength = 1800) {
  const clean = String(text).replace(/\s+/g, ' ').trim();

  if (!clean) {
    return [];
  }

  if (clean.length <= maxLength) {
    return [clean];
  }

  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let current = '';

  for (const sentenceRaw of sentences) {
    const sentence = sentenceRaw.trim();

    if (!sentence) {
      continue;
    }

    if (current && `${current} ${sentence}`.length <= maxLength) {
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
      let cut = remaining.lastIndexOf(' ', maxLength);

      if (cut < maxLength * 0.5) {
        cut = maxLength;
      }

      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }

    current = remaining;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function synthesizeLongSpeech({ text, voiceId, modelId }) {
  const chunks = splitText(text, 1800);

  if (chunks.length === 0) {
    throw new Error('Texto vazio');
  }

  const audioParts = [];
  let usedModelId = modelId;

  for (const chunk of chunks) {
    const generated = await synthesizeSpeech({
      text: chunk,
      voiceId,
      modelId,
      audioEncoding: 'MP3',
      sampleRateHertz: SAMPLE_RATE_HERTZ,
    });

    usedModelId = generated.modelId || usedModelId;
    audioParts.push(generated.audio);
  }

  if (audioParts.length === 1) {
    return {
      audio: audioParts[0],
      modelId: usedModelId,
      chunks: 1,
    };
  }

  return {
    audio: await concatenateMp3Buffers(audioParts),
    modelId: usedModelId,
    chunks: audioParts.length,
  };
}

async function listVoices(
  language,
  { refresh = false } = {}
) {
  const normalizedLanguage = language
    ? normalizeLanguage(language)
    : '';
  const cacheKey = normalizedLanguage || '__ALL__';
  const now = Date.now();
  const cached = voicesCache.byLanguage.get(cacheKey);

  if (
    !refresh &&
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

  const result = await inworldRequest(url.toString());
  const remoteVoices = Array.isArray(result.voices)
    ? result.voices
    : [];

  // A resposta atual da API é a fonte de verdade.
  // Vozes salvas localmente não são recolocadas na lista
  // quando desapareceram do workspace, evitando IDs mortos.
  const voices = mergeAndSortVoices(
    remoteVoices
  );

  let stateChanged = false;

  for (
    const voice of remoteVoices.filter(isCustomVoice)
  ) {
    stateChanged =
      rememberClonedVoice(voice) ||
      stateChanged;
  }

  if (stateChanged) {
    await saveState();
  }

  if (
    refresh ||
    voicesCache.expiresAt <= now
  ) {
    voicesCache = {
      expiresAt:
        now + 10 * 60 * 1000,
      byLanguage: new Map(),
    };
  }

  voicesCache.byLanguage.set(cacheKey, voices);
  return voices;
}

async function listSelectableVoices(
  language,
  { refresh = false } = {}
) {
  const normalizedLanguage = language
    ? normalizeLanguage(language)
    : '';

  const filteredVoices = await listVoices(
    normalizedLanguage,
    { refresh }
  );

  if (!normalizedLanguage) {
    return filteredVoices;
  }

  const allVoices = await listVoices(
    '',
    { refresh }
  );

  const allCustomVoices = allVoices.filter(
    voice =>
      isCustomVoice(voice) &&
      (
        voiceMatchesLanguage(
          voice,
          normalizedLanguage
        ) ||
        !voice.langCode ||
        voice.langCode === 'AUTO'
      )
  );

  return mergeAndSortVoices(
    allCustomVoices,
    filteredVoices
  );
}

async function getVoiceById(voiceId) {
  const normalizedId = String(
    voiceId ||
    ''
  ).trim();

  if (!normalizedId) {
    return null;
  }

  const url =
    `https://api.inworld.ai/voices/v1/voices/` +
    encodeURIComponent(normalizedId);

  try {
    const result = await inworldRequest(url);
    const voice = normalizeVoiceRecord(
      result.voice ||
      result.result ||
      result
    );

    if (
      voice &&
      isCustomVoice(voice)
    ) {
      const changed = rememberClonedVoice(voice);

      if (changed) {
        await saveState();
      }
    }

    return voice;
  } catch (error) {
    if (
      error.status === 400 ||
      error.status === 404
    ) {
      return null;
    }

    throw error;
  }
}

function forgetClonedVoice(voiceId) {
  const normalizedId = String(
    voiceId ||
    ''
  ).trim();

  if (!normalizedId) {
    return false;
  }

  const before = state.clonedVoices.length;

  state.clonedVoices = state.clonedVoices.filter(
    voice =>
      normalizeVoiceRecord(voice)?.voiceId !==
      normalizedId
  );

  return state.clonedVoices.length !== before;
}

async function resolveVoiceReference(
  query,
  language,
  {
    refresh = false,
    excludeVoiceIds = [],
  } = {}
) {
  const rawQuery = String(
    query ||
    ''
  ).trim();

  if (!rawQuery) {
    return {
      status: 'not_found',
      query: rawQuery,
      matches: [],
    };
  }

  if (refresh) {
    clearVoicesCache();
  }

  const excluded = new Set(
    excludeVoiceIds
      .map(value => String(value || '').trim())
      .filter(Boolean)
  );

  const voices = (
    await listSelectableVoices(
      language,
      { refresh }
    )
  ).filter(
    voice =>
      !excluded.has(
        normalizeVoiceRecord(voice)?.voiceId
      )
  );

  const ranked = voices
    .map(voice => ({
      voice: normalizeVoiceRecord(voice),
      score: voiceMatchScore(voice, rawQuery),
    }))
    .filter(
      item =>
        item.voice &&
        item.score > 0
    )
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      const customDifference =
        Number(isCustomVoice(b.voice)) -
        Number(isCustomVoice(a.voice));

      if (customDifference !== 0) {
        return customDifference;
      }

      return voiceLabel(a.voice).localeCompare(
        voiceLabel(b.voice),
        'pt-BR',
        { sensitivity: 'base' }
      );
    });

  if (ranked.length > 0) {
    const best = ranked[0];
    const tiedBest = ranked.filter(
      item => item.score === best.score
    );

    if (
      tiedBest.length === 1 &&
      best.score >= 620
    ) {
      return {
        status: 'found',
        query: rawQuery,
        voice: best.voice,
        matches: ranked
          .slice(0, 10)
          .map(item => item.voice),
      };
    }

    return {
      status: 'ambiguous',
      query: rawQuery,
      matches: tiedBest
        .slice(0, 10)
        .map(item => item.voice),
    };
  }

  const directCandidates = [];

  if (
    rawQuery.startsWith('workspaces/')
  ) {
    directCandidates.push(
      buildVoiceIdFromResourceName(rawQuery)
    );
  }

  if (rawQuery.includes('__')) {
    directCandidates.push(rawQuery);
  } else if (INWORLD_WORKSPACE_ID) {
    const shortId = voiceShortId(rawQuery)
      .trim()
      .replace(/\s+/g, '-');

    if (shortId) {
      directCandidates.push(
        `${INWORLD_WORKSPACE_ID}__${shortId}`
      );
    }
  }

  for (
    const candidate of Array.from(
      new Set(
        directCandidates.filter(Boolean)
      )
    )
  ) {
    if (excluded.has(candidate)) {
      continue;
    }

    const voice = await getVoiceById(candidate);

    if (voice) {
      return {
        status: 'found',
        query: rawQuery,
        voice,
        matches: [voice],
      };
    }
  }

  return {
    status: 'not_found',
    query: rawQuery,
    matches: [],
  };
}

async function resolveChatVoice(
  chatState,
  {
    refresh = false,
    excludeVoiceIds = [],
  } = {}
) {
  const queries = Array.from(
    new Set(
      [
        chatState.voiceId,
        chatState.voiceDisplayName,
      ]
        .map(value => String(value || '').trim())
        .filter(Boolean)
    )
  );

  let ambiguousResult = null;

  for (const query of queries) {
    const result = await resolveVoiceReference(
      query,
      chatState.language,
      {
        refresh,
        excludeVoiceIds,
      }
    );

    if (result.status === 'found') {
      const changed = applyVoiceToChatState(
        chatState,
        result.voice
      );

      if (changed) {
        await saveState();
      }

      return result.voice;
    }

    if (
      result.status === 'ambiguous' &&
      !ambiguousResult
    ) {
      ambiguousResult = result;
    }
  }

  if (ambiguousResult) {
    const error = new Error(
      `O nome "${ambiguousResult.query}" corresponde a mais de uma voz. Use /vozes e toque na voz correta.`
    );

    error.code = 'VOICE_AMBIGUOUS';
    error.matches = ambiguousResult.matches;
    throw error;
  }

  throw createVoiceNotFoundError(
    chatState.voiceDisplayName ||
    chatState.voiceId
  );
}

async function recoverChatVoiceAfterUnknown(
  chatState
) {
  const invalidVoiceId = chatState.voiceId;
  const displayName =
    chatState.voiceDisplayName ||
    voiceShortId(invalidVoiceId) ||
    invalidVoiceId;

  const removed = forgetClonedVoice(
    invalidVoiceId
  );

  clearVoicesCache();

  const result = await resolveVoiceReference(
    displayName,
    chatState.language,
    {
      refresh: true,
      excludeVoiceIds: [invalidVoiceId],
    }
  );

  if (result.status === 'found') {
    applyVoiceToChatState(
      chatState,
      result.voice
    );

    await saveState();
    return result.voice;
  }

  if (removed) {
    await saveState();
  }

  throw createVoiceNotFoundError(
    displayName,
    `O ID antigo era "${invalidVoiceId}" e foi removido do estado salvo.`
  );
}

async function getVoicePreview(voiceId, modelId) {
  const url = new URL('https://api.inworld.ai/tts/v1/voice:preview');
  url.searchParams.set('voice_id', voiceId);
  url.searchParams.set('model_id', modelId);

  const response = await inworldRequest(url.toString());
  const result = response.result || response;

  if (!result.audioContent) {
    throw new Error('A Inworld não retornou preview');
  }

  return Buffer.from(result.audioContent, 'base64');
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
    tags: ['ghost1', 'telegram', 'clone'],
    audioProcessingConfig: {
      removeBackgroundNoise: CLONE_REMOVE_BACKGROUND_NOISE,
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
    throw new Error('A Inworld não retornou o voiceId da voz clonada');
  }

  rememberClonedVoice(voice);
  await saveState();

  voicesCache.expiresAt = 0;
  voicesCache.byLanguage.clear();

  return {
    voice,
    audioSamplesValidated: result.audioSamplesValidated || [],
  };
}

// ============================================================
// PROCESSAMENTO DE ÁUDIO
// ============================================================

function runProcess(command, args, timeoutMs = PROCESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(`${command} excedeu o tempo limite de ${timeoutMs}ms`)
      );
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', code => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} saiu com código ${code}: ${stderr}`));
    });
  });
}

async function audioDurationSeconds(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);

  const duration = Number.parseFloat(stdout.trim());
  return Number.isFinite(duration) ? duration : 0;
}

async function concatenateMp3Buffers(buffers) {
  const id = randomUUID();
  const tempDir = os.tmpdir();
  const partPaths = [];
  const listPath = path.join(tempDir, `ghost1-${id}-list.txt`);
  const outputPath = path.join(tempDir, `ghost1-${id}-combined.mp3`);

  try {
    for (let index = 0; index < buffers.length; index += 1) {
      const partPath = path.join(tempDir, `ghost1-${id}-${index}.mp3`);
      await writeFile(partPath, buffers[index]);
      partPaths.push(partPath);
    }

    await writeFile(
      listPath,
      partPaths.map(filePath => `file '${filePath}'`).join('\n'),
      'utf8'
    );

    try {
      await runProcess('ffmpeg', [
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
      ]);
    } catch {
      await runProcess('ffmpeg', [
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
      ]);
    }

    return await readFile(outputPath);
  } finally {
    await Promise.allSettled(
      [...partPaths, listPath, outputPath].map(filePath => unlink(filePath))
    );
  }
}

async function prepareGeneratedAudio(inputBuffer, sendMode) {
  const id = randomUUID();
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `ghost1-${id}-input.mp3`);

  await writeFile(inputPath, inputBuffer);

  try {
    const duration = await audioDurationSeconds(inputPath);

    if (sendMode !== 'voice') {
      return {
        buffer: inputBuffer,
        filename: 'ghost1-tts.mp3',
        mimeType: 'audio/mpeg',
        duration,
      };
    }

    const outputPath = path.join(tempDir, `ghost1-${id}-voice.ogg`);

    try {
      await runProcess('ffmpeg', [
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
      ]);

      return {
        buffer: await readFile(outputPath),
        filename: 'ghost1-tts.ogg',
        mimeType: 'audio/ogg',
        duration,
      };
    } finally {
      await unlink(outputPath).catch(() => {});
    }
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

async function prepareCloneSample(inputBuffer) {
  const id = randomUUID();
  const tempDir = os.tmpdir();
  const inputPath = path.join(tempDir, `ghost1-${id}-clone-input`);
  const outputPath = path.join(tempDir, `ghost1-${id}-clone.wav`);

  await writeFile(inputPath, inputBuffer);

  try {
    const originalDuration = await audioDurationSeconds(inputPath);

    if (originalDuration < CLONE_MIN_SECONDS) {
      throw new Error(
        `A amostra tem ${originalDuration.toFixed(1)}s. Envie pelo menos ${CLONE_MIN_SECONDS}s de voz.`
      );
    }

    const wasTrimmed = originalDuration > CLONE_MAX_SECONDS;

    await runProcess('ffmpeg', [
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
    ]);

    const wavBuffer = await readFile(outputPath);
    const finalDuration = await audioDurationSeconds(outputPath);

    return {
      wavBuffer,
      originalDuration,
      finalDuration,
      wasTrimmed,
    };
  } finally {
    await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
  }
}

// ============================================================
// ROTAS DA API HTTP
// ============================================================

async function handleSynthesize(req, res) {
  let body;

  try {
    body = await readJson(req);
  } catch (error) {
    return sendError(
      res,
      error.status || 400,
      'JSON inválido',
      error.message
    );
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
    return sendError(
      res,
      400,
      'Texto muito longo para uma chamada HTTP; máximo de 2000 caracteres'
    );
  }

  if (!voiceId || typeof voiceId !== 'string') {
    return sendError(res, 400, 'Campo "voz" obrigatório');
  }

  try {
    const resolution = await resolveVoiceReference(
      voiceId,
      body.language || TELEGRAM_DEFAULT_LANGUAGE
    );

    if (resolution.status === 'ambiguous') {
      return sendJson(res, 409, {
        error: 'Nome de voz ambíguo',
        message:
          `Mais de uma voz corresponde a "${voiceId}". Envie o voiceId completo.`,
        matches: resolution.matches
          .map(voiceCandidateSummary)
          .filter(Boolean),
      });
    }

    if (resolution.status !== 'found') {
      return sendJson(res, 404, {
        error: 'Voz não encontrada',
        message: createVoiceNotFoundError(
          voiceId
        ).message,
      });
    }

    let resolvedVoice = resolution.voice;
    let result;

    try {
      result = await synthesizeSpeech({
        text,
        voiceId: resolvedVoice.voiceId,
        modelId: body.model ?? body.modelId ?? MODEL_ID,
        audioEncoding: body.audioEncoding ?? AUDIO_ENCODING,
        sampleRateHertz: body.sampleRateHertz ?? SAMPLE_RATE_HERTZ,
        deliveryMode: body.deliveryMode ?? DELIVERY_MODE,
        applyTextNormalization:
          body.applyTextNormalization ?? TEXT_NORMALIZATION,
        language: body.language,
        temperature: body.temperature,
      });
    } catch (error) {
      if (!isUnknownVoiceError(error)) {
        throw error;
      }

      forgetClonedVoice(resolvedVoice.voiceId);
      clearVoicesCache();

      const refreshed = await resolveVoiceReference(
        resolvedVoice.displayName || voiceId,
        body.language || TELEGRAM_DEFAULT_LANGUAGE,
        {
          refresh: true,
          excludeVoiceIds: [resolvedVoice.voiceId],
        }
      );

      if (refreshed.status !== 'found') {
        throw createVoiceNotFoundError(
          resolvedVoice.displayName || voiceId,
          `O ID inválido era "${resolvedVoice.voiceId}".`
        );
      }

      resolvedVoice = refreshed.voice;

      try {
        result = await synthesizeSpeech({
          text,
          voiceId: resolvedVoice.voiceId,
          modelId: body.model ?? body.modelId ?? MODEL_ID,
          audioEncoding: body.audioEncoding ?? AUDIO_ENCODING,
          sampleRateHertz: body.sampleRateHertz ?? SAMPLE_RATE_HERTZ,
          deliveryMode: body.deliveryMode ?? DELIVERY_MODE,
          applyTextNormalization:
            body.applyTextNormalization ?? TEXT_NORMALIZATION,
          language: body.language,
          temperature: body.temperature,
        });
      } catch (retryError) {
        if (isUnknownVoiceError(retryError)) {
          throw createVoiceNotFoundError(
            resolvedVoice.displayName ||
            resolvedVoice.voiceId,
            `O ID "${resolvedVoice.voiceId}" também foi recusado pela Inworld.`
          );
        }

        throw retryError;
      }
    }

    const contentType = contentTypeForEncoding(result.audioEncoding);
    const extension = extensionForContentType(contentType);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': result.audio.length,
      'Content-Disposition': `inline; filename="audio.${extension}"`,
      'Cache-Control': 'no-store',
      'X-Inworld-Model': result.modelId,
      'X-Inworld-Voice-Id': resolvedVoice.voiceId,
      'X-Inworld-Voice-Name': encodeURIComponent(
        resolvedVoice.displayName
      ),
      'X-Inworld-Characters': String(
        result.usage?.processedCharactersCount ?? text.length
      ),
      ...CORS,
    });

    res.end(result.audio);
  } catch (error) {
    console.error('[TTS]', safeError(error));

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

  try {
    const language =
      url.searchParams.get('language') ||
      url.searchParams.get('lang') ||
      url.searchParams.get('languages') ||
      TELEGRAM_DEFAULT_LANGUAGE;

    const voices = await listSelectableVoices(language);
    return sendJson(res, 200, {
      workspaceId: INWORLD_WORKSPACE_ID,
      voices,
      customVoices: voices.filter(isCustomVoice),
    });
  } catch (error) {
    console.error('[VOICES]', safeError(error));

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
    url.searchParams.get('voiceId') || url.searchParams.get('voz');
  const modelId =
    url.searchParams.get('modelId') ||
    url.searchParams.get('model') ||
    MODEL_ID;

  if (!voiceId) {
    return sendError(res, 400, 'Parâmetro voiceId obrigatório');
  }

  try {
    const resolution = await resolveVoiceReference(
      voiceId,
      url.searchParams.get('language') ||
      url.searchParams.get('lang') ||
      TELEGRAM_DEFAULT_LANGUAGE
    );

    if (resolution.status === 'ambiguous') {
      return sendJson(res, 409, {
        error: 'Nome de voz ambíguo',
        matches: resolution.matches
          .map(voiceCandidateSummary)
          .filter(Boolean),
      });
    }

    if (resolution.status !== 'found') {
      return sendJson(res, 404, {
        error: 'Voz não encontrada',
        message: createVoiceNotFoundError(
          voiceId
        ).message,
      });
    }

    const resolvedVoice = resolution.voice;
    const audio = await getVoicePreview(
      resolvedVoice.voiceId,
      modelId
    );

    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      'Content-Disposition': 'inline; filename="preview.mp3"',
      'Cache-Control': 'no-store',
      'X-Inworld-Voice-Id':
        resolvedVoice.voiceId,
      'X-Inworld-Voice-Name':
        encodeURIComponent(
          resolvedVoice.displayName
        ),
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
      error.status || 400,
      'JSON inválido',
      error.message
    );
  }

  if (!isAuthorized(req, body)) {
    return sendError(res, 401, 'Chave secreta inválida');
  }

  const audioBase64 = body.audioData || body.audioBase64;

  if (!audioBase64 || typeof audioBase64 !== 'string') {
    return sendError(res, 400, 'Campo audioData em Base64 obrigatório');
  }

  if (!body.displayName || typeof body.displayName !== 'string') {
    return sendError(res, 400, 'Campo displayName obrigatório');
  }

  try {
    const processed = await prepareCloneSample(
      Buffer.from(audioBase64, 'base64')
    );

    const result = await cloneVoice({
      displayName: body.displayName,
      langCode: body.langCode || body.language || 'PT_BR',
      wavBuffer: processed.wavBuffer,
      transcription: body.transcription,
      description: body.description,
    });

    return sendJson(res, 200, {
      ...result,
      sample: {
        originalDuration: processed.originalDuration,
        finalDuration: processed.finalDuration,
        wasTrimmed: processed.wasTrimmed,
      },
    });
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

async function telegramRequest(method, options = {}, timeoutMs = 35000) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      ...options,
      signal: controller.signal,
    });

    const raw = await response.text();
    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { ok: false, description: raw || 'Resposta inválida do Telegram' };
    }

    if (!response.ok || !data.ok) {
      const error = new Error(
        data.description || `Telegram HTTP ${response.status}`
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data.result;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error(
        `Telegram excedeu o tempo limite de ${timeoutMs}ms`
      );
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function telegramJson(method, payload, timeoutMs = 35000) {
  return telegramRequest(
    method,
    {
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    timeoutMs
  );
}

async function sendTelegramMessage(chatId, text, extra = {}) {
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

async function sendTelegramAction(chatId, action) {
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
    // É apenas um indicador visual.
  }
}

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await telegramJson(
      'answerCallbackQuery',
      {
        callback_query_id: callbackQueryId,
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
  form.append('chat_id', String(chatId));
  form.append('caption', caption.slice(0, 1024));
  form.append(
    'duration',
    String(Math.max(0, Math.round(preparedAudio.duration || 0)))
  );

  const blob = new Blob([preparedAudio.buffer], {
    type: preparedAudio.mimeType,
  });

  if (sendMode === 'voice') {
    form.append('voice', blob, preparedAudio.filename);

    return telegramRequest(
      'sendVoice',
      {
        body: form,
      },
      120000
    );
  }

  form.append('audio', blob, preparedAudio.filename);
  form.append('title', 'Ghost1 TTS');
  form.append('performer', 'Inworld');

  return telegramRequest(
    'sendAudio',
    {
      body: form,
    },
    120000
  );
}

async function downloadTelegramFile(fileId) {
  const file = await telegramJson(
    'getFile',
    {
      file_id: fileId,
    },
    15000
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(
      `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`,
      { signal: controller.signal }
    );

    if (!response.ok) {
      throw new Error(
        `Falha ao baixar arquivo do Telegram: HTTP ${response.status}`
      );
    }

    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timeout);
  }
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
    `Voz atual: ${
      chatState.voiceDisplayName ||
      chatState.voiceId
    }`,
    `Voice ID: ${chatState.voiceId}`,
    `Workspace: ${
      chatState.voiceWorkspaceId ||
      INWORLD_WORKSPACE_ID ||
      'voz do sistema'
    }`,
    `Modelo: ${chatState.modelId}`,
    `Formato: ${
      chatState.sendMode === 'voice'
        ? 'mensagem de voz'
        : 'arquivo MP3'
    }`,
    '',
    'Comandos:',
    '/vozes pt - escolher voz',
    '/voz NOME_OU_ID - procurar e definir voz',
    '/workspace - diagnosticar workspace e clonadas',
    '/preview - ouvir voz atual',
    '/clonar ... - iniciar clonagem',
    '/cancelar - cancelar clonagem',
    '/setkey - configurar chave Inworld',
    '/resetkey - resetar chave Inworld',
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
    `Voz: ${
      chatState.voiceDisplayName ||
      chatState.voiceId
    }`,
    `Voice ID: ${chatState.voiceId}`,
    `Origem: ${
      chatState.voiceSource ||
      (
        chatState.voiceId.includes('__')
          ? 'IVC'
          : 'SYSTEM'
      )
    }`,
    `Workspace da voz: ${
      chatState.voiceWorkspaceId ||
      voiceWorkspaceId(chatState.voiceId) ||
      'voz do sistema'
    }`,
    `Workspace configurado: ${
      INWORLD_WORKSPACE_ID ||
      'derivado da chave da API'
    }`,
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
    .update(`${voice.voiceId}:${Date.now()}:${Math.random()}`)
    .digest('base64url')
    .slice(0, 18);

  if (callbackVoices.size > 1000) {
    callbackVoices.clear();
  }

  callbackVoices.set(hash, voice);
  return hash;
}

function voiceButtonText(
  voice,
  duplicateNames = new Map()
) {
  const normalized = normalizeVoiceRecord(voice);
  const label = voiceLabel(normalized);
  const key = normalizeVoiceLookup(label);
  const isDuplicate =
    (duplicateNames.get(key) || 0) > 1;

  const suffix = isDuplicate
    ? ` · ${normalized.shortId}`
    : '';

  const prefix = isCustomVoice(normalized)
    ? '🧬 '
    : '';

  return `${prefix}${label}${suffix}`
    .slice(0, 60);
}

async function sendVoiceOptionsKeyboard(
  chatId,
  title,
  voices
) {
  const normalizedVoices = mergeAndSortVoices(
    voices
  ).slice(0, 80);

  if (normalizedVoices.length === 0) {
    await sendTelegramMessage(
      chatId,
      'Nenhuma voz válida foi encontrada.'
    );
    return;
  }

  const duplicateNames = new Map();

  for (const voice of normalizedVoices) {
    const key = normalizeVoiceLookup(
      voiceLabel(voice)
    );

    duplicateNames.set(
      key,
      (duplicateNames.get(key) || 0) + 1
    );
  }

  const buttons = [];

  for (
    let index = 0;
    index < normalizedVoices.length;
    index += 2
  ) {
    const row = normalizedVoices
      .slice(index, index + 2)
      .map(voice => ({
        text: voiceButtonText(
          voice,
          duplicateNames
        ),
        callback_data:
          `voice:${callbackTokenForVoice(voice)}`,
      }));

    buttons.push(row);
  }

  await sendTelegramMessage(
    chatId,
    title,
    {
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

async function sendVoiceKeyboard(chatId, language) {
  const normalizedLanguage =
    normalizeLanguage(language);

  const voices = await listSelectableVoices(
    normalizedLanguage
  );

  if (voices.length === 0) {
    await sendTelegramMessage(
      chatId,
      `Nenhuma voz encontrada para ${normalizedLanguage}.`
    );
    return;
  }

  const customVoices = voices
    .filter(isCustomVoice)
    .sort((a, b) => {
      const aConfigured =
        voiceWorkspaceLabel(a) ===
        INWORLD_WORKSPACE_ID;

      const bConfigured =
        voiceWorkspaceLabel(b) ===
        INWORLD_WORKSPACE_ID;

      if (aConfigured !== bConfigured) {
        return Number(bConfigured) -
          Number(aConfigured);
      }

      return voiceLabel(a).localeCompare(
        voiceLabel(b),
        'pt-BR',
        { sensitivity: 'base' }
      );
    });

  const systemVoices = voices.filter(
    voice => !isCustomVoice(voice)
  );

  const visible = [
    ...customVoices,
    ...systemVoices.slice(
      0,
      Math.max(
        0,
        60 - customVoices.length
      )
    ),
  ].slice(0, 80);

  await sendVoiceOptionsKeyboard(
    chatId,
    [
      `Vozes ${normalizedLanguage}:`,
      `Workspace: ${
        INWORLD_WORKSPACE_ID ||
        'derivado da chave'
      }`,
      customVoices.length > 0
        ? `🧬 ${customVoices.length} clonada(s) aparecem primeiro, usando o nome real e não o código do workspace.`
        : 'Nenhuma voz clonada foi encontrada nesta chave/workspace.',
      'Toque para selecionar.',
      `Mostrando ${visible.length} de ${voices.length}.`,
    ].join('\n'),
    visible
  );
}

async function sendAmbiguousVoiceKeyboard(
  chatId,
  query,
  matches
) {
  await sendVoiceOptionsKeyboard(
    chatId,
    [
      `Encontrei mais de uma voz para "${query}".`,
      'Toque na voz correta:',
    ].join('\n'),
    matches
  );
}

async function sendWorkspaceDiagnostic(
  chatId
) {
  const voices = await listVoices('');
  const customVoices = voices.filter(
    isCustomVoice
  );

  const workspaces = Array.from(
    new Set(
      customVoices
        .map(voiceWorkspaceLabel)
        .filter(Boolean)
    )
  );

  const configuredVoices = customVoices.filter(
    voice =>
      voiceWorkspaceLabel(voice) ===
      INWORLD_WORKSPACE_ID
  );

  await sendTelegramMessage(
    chatId,
    [
      '🧬 DIAGNÓSTICO DE VOZES',
      `Workspace configurado: ${
        INWORLD_WORKSPACE_ID ||
        'não definido'
      }`,
      `Workspaces encontrados pela chave: ${
        workspaces.length > 0
          ? workspaces.join(', ')
          : 'nenhum'
      }`,
      `Vozes clonadas encontradas: ${
        customVoices.length
      }`,
      `Vozes do workspace configurado: ${
        configuredVoices.length
      }`,
      '',
      configuredVoices.length === 0
        ? 'Se suas clonadas aparecem no painel mas não aqui, a INWORLD_API_KEY provavelmente pertence a outro workspace ou não possui permissão de leitura.'
        : 'A chave e o workspace estão enxergando as vozes clonadas.',
    ].join('\n')
  );
}

async function generateAndSendTelegramAudio(
  chatId,
  text,
  chatState
) {
  const cleanText = String(
    text ||
    ''
  ).trim();

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

  let resolvedVoice = await resolveChatVoice(
    chatState
  );

  let generated;

  try {
    generated = await synthesizeLongSpeech({
      text: cleanText,
      voiceId: resolvedVoice.voiceId,
      modelId: chatState.modelId,
    });
  } catch (error) {
    if (!isUnknownVoiceError(error)) {
      throw error;
    }

    resolvedVoice =
      await recoverChatVoiceAfterUnknown(
        chatState
      );

    try {
      generated = await synthesizeLongSpeech({
        text: cleanText,
        voiceId: resolvedVoice.voiceId,
        modelId: chatState.modelId,
      });
    } catch (retryError) {
      if (isUnknownVoiceError(retryError)) {
        throw createVoiceNotFoundError(
          resolvedVoice.displayName ||
          resolvedVoice.voiceId,
          `O ID "${resolvedVoice.voiceId}" também foi recusado pela Inworld.`
        );
      }

      throw retryError;
    }
  }

  const prepared =
    await prepareGeneratedAudio(
      generated.audio,
      chatState.sendMode
    );

  const caption = [
    `🎙️ ${voiceLabel(resolvedVoice)}`,
    isCustomVoice(resolvedVoice)
      ? `ID: ${resolvedVoice.voiceId}`
      : '',
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

  return {
    displayName: parts[0],
    langCode: normalizeLanguage(parts[1] || chatState.language),
    transcription: parts.slice(2).join(' | ').trim(),
  };
}

async function handleCloneAudio(chatId, message, chatState) {
  const source = message.voice || message.audio || message.document;

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

  const mimeType = source.mime_type || '';

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
    await sendTelegramAction(chatId, 'typing');
    await sendTelegramMessage(
      chatId,
      '🔄 Baixando e preparando a amostra para clonagem...'
    );

    const originalBuffer = await downloadTelegramFile(source.file_id);
    const processed = await prepareCloneSample(originalBuffer);

    await sendTelegramMessage(
      chatId,
      processed.wasTrimmed
        ? `A amostra tinha ${processed.originalDuration.toFixed(
            1
          )}s e foi cortada para ${CLONE_MAX_SECONDS}s, somente para a clonagem.`
        : `Amostra aceita: ${processed.finalDuration.toFixed(1)}s.`
    );

    const cloned = await cloneVoice({
      displayName: chatState.pendingClone.displayName,
      langCode: chatState.pendingClone.langCode,
      wavBuffer: processed.wavBuffer,
      transcription: chatState.pendingClone.transcription,
    });

    applyVoiceToChatState(
      chatState,
      cloned.voice
    );

    chatState.language =
      cloned.voice.langCode ||
      chatState.pendingClone.langCode;

    chatState.pendingClone = null;

    await saveState();

    await sendTelegramMessage(
      chatId,
      [
        '✅ VOZ CLONADA',
        `Nome: ${cloned.voice.displayName || 'Voz clonada'}`,
        `Voice ID: ${cloned.voice.voiceId}`,
        `Idioma: ${cloned.voice.langCode || chatState.language}`,
        '',
        'A voz clonada já foi selecionada.',
        'Agora envie qualquer texto ou use /teste.',
        '',
        'Os áudios gerados não são limitados a 15 segundos.',
      ].join('\n')
    );
  } catch (error) {
    console.error('[telegram clone]', safeError(error));

    await sendTelegramMessage(
      chatId,
      `❌ Não foi possível clonar a voz.\n${safeError(error)}`
    );
  }

  return true;
}

async function handleTelegramCommand(chatId, text) {
  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();
  const argument = args.join(' ').trim();
  const chatState = getChatState(chatId);

  if (
    command === '/start' ||
    command === '/ajuda' ||
    command === '/help'
  ) {
    await sendTelegramMessage(chatId, telegramMenu(chatState));
    return;
  }

  if (command === '/status') {
    await sendTelegramMessage(
      chatId,
      telegramStatus(chatState)
    );
    return;
  }

  if (command === '/workspace') {
    await sendWorkspaceDiagnostic(chatId);
    return;
  }

  if (command === '/vozes') {
    const language = normalizeLanguage(argument || chatState.language);
    chatState.language = language;
    await saveState();
    await sendVoiceKeyboard(chatId, language);
    return;
  }

  if (command === '/voz') {
    if (!argument) {
      await sendTelegramMessage(
        chatId,
        [
          `Voz atual: ${
            chatState.voiceDisplayName ||
            chatState.voiceId
          }`,
          `Voice ID: ${chatState.voiceId}`,
          'Use /voz Ultron, /voz ID_COMPLETO ou /vozes pt',
        ].join('\n')
      );
      return;
    }

    const resolution = await resolveVoiceReference(
      argument,
      chatState.language
    );

    if (resolution.status === 'ambiguous') {
      await sendAmbiguousVoiceKeyboard(
        chatId,
        argument,
        resolution.matches
      );
      return;
    }

    if (resolution.status !== 'found') {
      await sendTelegramMessage(
        chatId,
        [
          `❌ Não encontrei a voz "${argument}".`,
          `Workspace configurado: ${
            INWORLD_WORKSPACE_ID ||
            'derivado da chave'
          }`,
          'Use /vozes para ver as vozes que esta chave realmente consegue acessar.',
        ].join('\n')
      );
      return;
    }

    const voice = resolution.voice;

    applyVoiceToChatState(
      chatState,
      voice
    );

    await saveState();

    await sendTelegramMessage(
      chatId,
      [
        '✅ Voz alterada',
        `Nome: ${voiceLabel(voice)}`,
        `Voice ID: ${voice.voiceId}`,
        `Origem: ${voice.source}`,
        isCustomVoice(voice)
          ? `Workspace: ${
              voiceWorkspaceLabel(voice) ||
              INWORLD_WORKSPACE_ID
            }`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
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
    await sendTelegramMessage(chatId, `✅ Modelo alterado para: ${argument}`);
    return;
  }

  if (command === '/modo') {
    if (
      !argument ||
      !['audio', 'voz', 'voice'].includes(argument.toLowerCase())
    ) {
      await sendTelegramMessage(chatId, 'Use /modo audio ou /modo voz');
      return;
    }

    chatState.sendMode = normalizeSendMode(argument);
    await saveState();

    await sendTelegramMessage(
      chatId,
      `✅ Formato alterado para: ${
        chatState.sendMode === 'voice'
          ? 'mensagem de voz'
          : 'arquivo MP3'
      }`
    );
    return;
  }

  if (command === '/clonar') {
    const cloneConfig = parseCloneCommand(argument, chatState);

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

    chatState.pendingClone = cloneConfig;
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
    await sendTelegramMessage(chatId, 'Clonagem cancelada.');
    return;
  }

  // ── /setkey NOVA_CHAVE ──────────────────────────────────────
  if (command === '/setkey') {
    if (!argument) {
      await sendTelegramMessage(
        chatId,
        [
          '🔑 Envie a nova chave Inworld:',
          '/setkey SUA_NOVA_CHAVE',
          '',
          'A chave só muda em memória — o .env do Coolify não é alterado.',
          'Use /resetkey para voltar ao padrão a qualquer hora.',
        ].join('\n')
      );
      return;
    }
    const newKey = argument.trim();
    runtimeInworldAuth = newKey.startsWith('Basic ')
      ? newKey
      : `Basic ${newKey}`;
    clearVoicesCache();
    const maskedNew = `${newKey.slice(0, 6)}****${newKey.slice(-4)}`;
    await sendTelegramMessage(
      chatId,
      [
        '✅ Chave Inworld atualizada!',
        `🔑 ${maskedNew}`,
        '',
        'Válida até reiniciar o servidor ou usar /resetkey.',
        'O .env do Coolify não foi alterado.',
      ].join('\n')
    );
    return;
  }

  // ── /resetkey ───────────────────────────────────────────────
  if (command === '/resetkey') {
    runtimeInworldAuth = INWORLD_AUTH_DEFAULT;
    clearVoicesCache();
    const defaultKey = INWORLD_API_KEY.startsWith('Basic ')
      ? INWORLD_API_KEY.slice(6)
      : INWORLD_API_KEY;
    const maskedDef = `${defaultKey.slice(0, 6)}****${defaultKey.slice(-4)}`;
    await sendTelegramMessage(
      chatId,
      [
        '✅ Chave redefinida para o padrão do Coolify!',
        `🔑 ${maskedDef}`,
      ].join('\n')
    );
    return;
  }

  // ── /keyinfo ────────────────────────────────────────────────
  if (command === '/keyinfo') {
    const current = runtimeInworldAuth.startsWith('Basic ')
      ? runtimeInworldAuth.slice(6)
      : runtimeInworldAuth;
    const isDefault = runtimeInworldAuth === INWORLD_AUTH_DEFAULT;
    const masked = `${current.slice(0, 6)}****${current.slice(-4)}`;
    await sendTelegramMessage(
      chatId,
      [
        `🔑 Chave ativa: ${masked}`,
        `Origem: ${
          isDefault
            ? '🏠 Padrão do Coolify (.env)'
            : '✏️ Definida via /setkey'
        }`,
        '',
        '/setkey CHAVE — trocar chave',
        '/resetkey — voltar ao padrão',
      ].join('\n')
    );
    return;
  }

  if (command === '/preview') {
    await sendTelegramAction(
      chatId,
      'upload_audio'
    );

    let resolvedVoice =
      await resolveChatVoice(chatState);

    let preview;

    try {
      preview = await getVoicePreview(
        resolvedVoice.voiceId,
        chatState.modelId
      );
    } catch (error) {
      if (!isUnknownVoiceError(error)) {
        throw error;
      }

      resolvedVoice =
        await recoverChatVoiceAfterUnknown(
          chatState
        );

      try {
        preview = await getVoicePreview(
          resolvedVoice.voiceId,
          chatState.modelId
        );
      } catch (retryError) {
        if (isUnknownVoiceError(retryError)) {
          throw createVoiceNotFoundError(
            resolvedVoice.displayName ||
            resolvedVoice.voiceId,
            `O ID "${resolvedVoice.voiceId}" também foi recusado pela Inworld.`
          );
        }

        throw retryError;
      }
    }

    const prepared =
      await prepareGeneratedAudio(
        preview,
        chatState.sendMode
      );

    await sendTelegramAudio(
      chatId,
      prepared,
      [
        `Preview: ${voiceLabel(resolvedVoice)}`,
        isCustomVoice(resolvedVoice)
          ? `ID: ${resolvedVoice.voiceId}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
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
  const chatId = message?.chat?.id;

  if (!chatId) {
    return;
  }

  if (!isTelegramChatAllowed(chatId)) {
    await sendTelegramMessage(chatId, '⛔ Este chat não está autorizado.');
    return;
  }

  const chatState = getChatState(chatId);
  const handledAudio = await handleCloneAudio(chatId, message, chatState);

  if (handledAudio) {
    return;
  }

  const text = message.text?.trim();

  if (!text) {
    await sendTelegramMessage(
      chatId,
      'Envie texto para gerar áudio ou use /clonar antes de enviar uma amostra de voz.'
    );
    return;
  }

  try {
    if (text.startsWith('/')) {
      await handleTelegramCommand(chatId, text);
      return;
    }

    await generateAndSendTelegramAudio(chatId, text, chatState);
  } catch (error) {
    console.error('[telegram message]', safeError(error));

    await sendTelegramMessage(
      chatId,
      `❌ Não foi possível concluir.\n${safeError(error)}`
    ).catch(() => {});
  }
}

async function handleTelegramCallback(callbackQuery) {
  const chatId = callbackQuery?.message?.chat?.id;
  const data = callbackQuery?.data || '';

  if (!chatId || !data.startsWith('voice:')) {
    return;
  }

  if (!isTelegramChatAllowed(chatId)) {
    await answerCallbackQuery(callbackQuery.id, 'Não autorizado');
    return;
  }

  const token = data.slice('voice:'.length);
  const voice = callbackVoices.get(token);

  if (!voice) {
    await answerCallbackQuery(
      callbackQuery.id,
      'Este botão expirou. Use /vozes novamente.'
    );
    return;
  }

  const chatState = getChatState(chatId);
  const normalizedVoice =
    normalizeVoiceRecord(voice);

  applyVoiceToChatState(
    chatState,
    normalizedVoice
  );

  await saveState();

  await answerCallbackQuery(
    callbackQuery.id,
    `Voz: ${voiceLabel(normalizedVoice)}`
  );

  await sendTelegramMessage(
    chatId,
    [
      `✅ Voz selecionada: ${
        voiceLabel(normalizedVoice)
      }`,
      `ID: ${normalizedVoice.voiceId}`,
      isCustomVoice(normalizedVoice)
        ? `Workspace: ${
            normalizedVoice.workspaceId ||
            INWORLD_WORKSPACE_ID
          }`
        : 'Origem: voz do sistema',
    ].join('\n')
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
        { command: 'start', description: 'Abrir o menu' },
        {
          command: 'clonar',
          description: 'Clonar voz com amostra de 5-15s',
        },
        { command: 'vozes', description: 'Escolher uma voz' },
        { command: 'voz', description: 'Definir voz por nome ou ID' },
        {
          command: 'workspace',
          description: 'Diagnosticar workspace e vozes',
        },
        { command: 'preview', description: 'Ouvir a voz atual' },
        { command: 'teste', description: 'Gerar áudio de teste' },
        { command: 'modelo', description: 'Trocar modelo da Inworld' },
        { command: 'modo', description: 'MP3 ou mensagem de voz' },
        { command: 'status', description: 'Mostrar configuração' },
        {
          command: 'cancelar',
          description: 'Cancelar clonagem pendente',
        },
        { command: 'ajuda', description: 'Mostrar ajuda' },
      ],
    },
    15000
  );
}

async function telegramLoop() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[telegram] desativado: TELEGRAM_BOT_TOKEN ausente');
    return;
  }

  try {
    await configureTelegramBot();
    telegramRuntime.configured = true;
    telegramRuntime.lastError = null;
    console.log('[telegram] bot configurado');
  } catch (error) {
    telegramRuntime.lastError = safeError(error);
    console.error(
      '[telegram] falha na configuração:',
      telegramRuntime.lastError
    );
  }

  let offset = 0;
  telegramRuntime.polling = true;

  while (true) {
    try {
      const updates = await telegramJson(
        'getUpdates',
        {
          offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        },
        35000
      );

      telegramRuntime.lastError = null;

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        telegramRuntime.lastUpdateAt = Date.now();

        if (update.message) {
          await handleTelegramMessage(update.message);
        }

        if (update.callback_query) {
          await handleTelegramCallback(update.callback_query);
        }
      }
    } catch (error) {
      telegramRuntime.lastError = safeError(error);
      console.error('[telegram loop]', telegramRuntime.lastError);
      await sleep(3000);
    }
  }
}

// ============================================================
// SERVIDOR
// ============================================================

async function handleHttpRequest(req, res) {
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'tts.ghost1',
      model: MODEL_ID,
      workspaceId: INWORLD_WORKSPACE_ID,
      port: PORT,
      uptimeSeconds: Math.floor(process.uptime()),
      telegram: {
        enabled: telegramRuntime.enabled,
        configured: telegramRuntime.configured,
        polling: telegramRuntime.polling,
        lastUpdateAt: telegramRuntime.lastUpdateAt,
        lastError: telegramRuntime.lastError,
        sendMode: TELEGRAM_SEND_MODE,
        generationAudioLimitSeconds: null,
      },
      cloning: {
        enabled: true,
        minSampleSeconds: CLONE_MIN_SECONDS,
        maxSampleSeconds: CLONE_MAX_SECONDS,
      },
      timestamp: Date.now(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/vozes') {
    await handleVoices(req, res, url);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/preview') {
    await handlePreview(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/clone') {
    await handleClone(req, res);
    return;
  }

  if (
    req.method === 'POST' &&
    (url.pathname === '/' || url.pathname === '/tts')
  ) {
    await handleSynthesize(req, res);
    return;
  }

  sendError(res, 404, 'Rota não encontrada');
}

const server = http.createServer((req, res) => {
  void handleHttpRequest(req, res).catch(error => {
    console.error('[http]', safeError(error));

    if (!res.headersSent) {
      sendError(res, 500, 'Erro interno do servidor', safeError(error));
      return;
    }

    res.destroy(error);
  });
});

server.on('clientError', (error, socket) => {
  console.error('[http client]', safeError(error));

  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

await loadState();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`tts.ghost1 ativo em http://0.0.0.0:${PORT}`);
  console.log('POST / ou /tts -> gera áudio');
  console.log('POST /clone -> clona voz');
  console.log('GET /vozes -> lista vozes');
  console.log('GET /preview -> preview');
  console.log('GET /health -> diagnóstico');

  void telegramLoop();
});

function shutdown(signal) {
  console.log(`[server] encerrando por ${signal}`);

  server.close(error => {
    if (error) {
      console.error('[server] falha ao encerrar:', safeError(error));
      process.exitCode = 1;
    }
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
