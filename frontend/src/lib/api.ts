export class ApiError extends Error {
  constructor(message: string, public status: number, public details?: unknown) {
    super(message);
  }
}

export interface ApiResult<T> {
  data: T;
}

/** background: polling that must not count as activity for the idle sign-out. */
type Options = { method?: string; body?: unknown; form?: FormData; background?: boolean };

export async function api<T>(path: string, token?: string, options: Options = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method || (options.body || options.form ? 'POST' : 'GET'),
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.background ? { 'X-Background': '1' } : {}),
    },
    ...(options.form ? { body: options.form } : options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(result.message || 'تعذر إكمال الطلب.', response.status, result.details);
  }
  return result as T;
}

/** Sends a form and reports how much of it has gone up (large files); fails like api(). */
export function apiUpload<T>(path: string, token: string, form: FormData, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/api${path}`);
    request.setRequestHeader('Authorization', `Bearer ${token}`);
    request.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    request.onload = () => {
      let result: { message?: string; details?: unknown } = {};
      try { result = JSON.parse(request.responseText || '{}'); } catch { /* not JSON (a proxy page) */ }
      if (request.status >= 200 && request.status < 300) resolve(result as T);
      else reject(new ApiError(result.message || (request.status === 413 ? 'الملف أكبر من الحجم المسموح.' : 'تعذر إكمال الطلب.'), request.status, result.details));
    };
    request.onerror = () => reject(new ApiError('انقطع الاتصال أثناء رفع الملف. حاول مرة أخرى.', 0));
    request.send(form);
  });
}

/** Fetches a protected file (document, export) and returns it as a blob URL. */
export async function apiBlob(path: string, token: string): Promise<{ url: string; name: string | null }> {
  const response = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new ApiError(result.message || 'تعذر تحميل الملف.', response.status);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const plain = disposition.match(/filename="([^"]+)"/)?.[1];
  return { url: URL.createObjectURL(await response.blob()), name: encoded ? decodeURIComponent(encoded) : plain ?? null };
}

export async function downloadFile(path: string, token: string, fallbackName: string): Promise<void> {
  const { url, name } = await apiBlob(path, token);
  const link = document.createElement('a');
  link.href = url;
  link.download = name || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function openFile(path: string, token: string): Promise<void> {
  // Open the tab synchronously so pop-up blockers allow it, then load the file.
  const tab = window.open('', '_blank');
  try {
    const { url } = await apiBlob(path, token);
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (error) {
    tab?.close();
    throw error;
  }
}
