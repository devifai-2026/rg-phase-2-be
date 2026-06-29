const axios = require('axios');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const logger = require('../utils/logger');

/**
 * WhatsApp delivery via the self-hosted WABridge HTTP bridge.
 * Replicates the productivo-backend contract exactly:
 *   POST {WABRIDGE_BASE_URL}/createtextmessage
 *   body: { 'app-key', 'auth-key', destination_number, device_id, message }
 *   success = truthy response.data.status
 */

/** Always send as 91 + last 10 digits (handles inputs already 91-prefixed). */
function normalizeNumber(phone) {
  const last10 = String(phone).replace(/\D/g, '').slice(-10);
  return `91${last10}`;
}

function isConfigured() {
  return !!(env.waBridge.appKey && env.waBridge.authKey && env.waBridge.deviceId);
}

async function sendText({ to, message }) {
  // In dev or when unconfigured, log instead of calling the bridge.
  if (!isConfigured()) {
    logger.warn('[WABridge MOCK] would send WhatsApp', { to: normalizeNumber(to), message });
    return { messageId: 'mock', mock: true };
  }

  const payload = {
    'app-key': env.waBridge.appKey,
    'auth-key': env.waBridge.authKey,
    destination_number: normalizeNumber(to),
    device_id: env.waBridge.deviceId,
    message,
  };

  const { data } = await axios.post(`${env.waBridge.baseUrl}/createtextmessage`, payload, {
    // No client timeout — WABridge runs slow in prod (~15s+) and the OTP send is
    // fire-and-forget (otpService), so we let even a slow send complete rather
    // than abort it.
    headers: { 'Content-Type': 'application/json' },
  });

  if (!data || !data.status) {
    throw new AppError((data && data.message) || 'WhatsApp message send failed', 502);
  }
  return { messageId: (data.data && data.data.messageid) || '', raw: data };
}

async function sendTemplate({ to, templateId, variables = [], buttonVariable = [], media = '' }) {
  if (!isConfigured()) {
    logger.warn('[WABridge MOCK] would send WhatsApp template', { to: normalizeNumber(to), templateId, variables, buttonVariable, media });
    return { messageId: 'mock', mock: true };
  }

  if (!templateId) {
    throw new AppError('templateId is required', 400);
  }

  const payload = {
    'app-key': env.waBridge.appKey,
    'auth-key': env.waBridge.authKey,
    destination_number: normalizeNumber(to),
    device_id: env.waBridge.deviceId,
    template_id: templateId,
    variables,
    button_variable: buttonVariable,
    media,
    message: '',
  };

  const { data } = await axios.post(`${env.waBridge.baseUrl}/createmessage`, payload, {
    // No client timeout — WABridge runs slow in prod (~15s+) and the OTP send is
    // fire-and-forget (otpService), so we let even a slow send complete rather
    // than abort it.
    headers: { 'Content-Type': 'application/json' },
  });

  if (!data || !data.status) {
    throw new AppError((data && data.message) || 'WABridge template send failed', 502);
  }
  return { messageId: (data.data && data.data.messageid) || '', raw: data };
}

module.exports = { sendText, sendTemplate, normalizeNumber, isConfigured };
