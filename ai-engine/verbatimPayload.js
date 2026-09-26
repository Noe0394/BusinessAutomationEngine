'use strict';

const MESSAGE_TOOLS = new Set([
  'sendWhatsAppMessage', 'sendTelegramMessage', 'sendWhatsAppMessageBatch',
  'sendTelegramMessageBatch', 'createCampaignDraft',
]);

function extractVerbatimText(request) {
  const source = String(request || '');
  if (!/\b(?:exactement|mot\s+pour\s+mot|tel\s+quel|litt[eé]ralement|sans\s+(?:aucune\s+)?modification)\b/i.test(source)) return null;
  const marker = /\b(?:message|texte)(?:\s+(?:suivant|ci[- ]dessous))?\s*[:：][\t ]*(?:\r?\n)?/ig;
  let match; let payload = null;
  while ((match = marker.exec(source))) payload = source.slice(marker.lastIndex);
  if (payload == null) return null;
  payload = payload.trim();
  const wrappers = [
    [/^«([\s\S]*)»$/u, 1], [/^“([\s\S]*)”$/u, 1], [/^"([\s\S]*)"$/u, 1],
    [/^'([\s\S]*)'$/u, 1], [/^```[\t ]*\r?\n([\s\S]*?)\r?\n```$/u, 1],
  ];
  for (const [pattern, group] of wrappers) {
    const wrapped = payload.match(pattern);
    if (wrapped) return wrapped[group];
  }
  return payload;
}

function applyVerbatimText(toolName, args, request) {
  if (!MESSAGE_TOOLS.has(String(toolName || ''))) return args;
  const text = extractVerbatimText(request);
  return text == null ? args : Object.assign({}, args || {}, { text });
}

module.exports = { extractVerbatimText, applyVerbatimText };
