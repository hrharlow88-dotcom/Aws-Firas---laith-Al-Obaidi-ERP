import { execute, selectOne } from '../db/query';
import { decryptField, encryptField } from '../utils/crypto';
import { getSettings } from './settings';

const SECRET_KEY = 'anthropic_api_key';

export async function setAiKey(value: string | null, userId: string): Promise<void> {
  if (!value) {
    await execute('DELETE FROM app_secrets WHERE key = :key', { key: SECRET_KEY });
    return;
  }
  await execute(
    `INSERT INTO app_secrets (key, value_enc, updated_by) VALUES (:key, :value, :userId)
     ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    { key: SECRET_KEY, value: encryptField(value), userId },
  );
}

async function aiKey(): Promise<string | null> {
  const row = await selectOne<{ value: string }>('SELECT value_enc AS value FROM app_secrets WHERE key = :key', { key: SECRET_KEY });
  return row ? decryptField(row.value) : null;
}

export async function aiStatus(): Promise<{ configured: boolean; enabled: boolean; model: string }> {
  const settings = await getSettings();
  return { configured: Boolean(await aiKey()), enabled: settings.hr.ai.enabled, model: settings.hr.ai.model };
}

/** True when the owner has set a key and switched the assistant on. */
export async function aiReady(): Promise<boolean> {
  const status = await aiStatus();
  return status.configured && status.enabled;
}

/**
 * Asks Claude for a JSON answer. The system prompt fixes the shape; the
 * caller still validates every value before anything is shown or applied.
 */
export async function askJson<T>(system: string, user: string, maxTokens = 2000): Promise<T> {
  const key = await aiKey();
  const settings = await getSettings();
  if (!key || !settings.hr.ai.enabled) throw new Error('AI_OFF');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: settings.hr.ai.model, max_tokens: maxTokens, system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`AI_HTTP_${response.status}`);
  const json = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (json.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI_NO_JSON');
  return JSON.parse(match[0]) as T;
}
