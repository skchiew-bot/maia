import type { PublicTicket } from '@aoc/contracts';
import { ApiError } from '../../api/client';

export const INTAKE_PATH = '/portal/api/intakes';

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadHandle {
  promise: Promise<PublicTicket>;
  /** Cancels the upload; the promise rejects with an AbortError and nothing is filed. */
  abort: () => void;
}

function errorFrom(status: number, body: string): ApiError {
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const err = (obj.error && typeof obj.error === 'object' ? obj.error : {}) as Record<string, unknown>;
  const code = typeof err.code === 'string' ? err.code : `http_${status}`;
  const message = typeof err.message === 'string' ? err.message : 'Request failed';
  return new ApiError(status, code, message, err.details);
}

/**
 * Files an intake as multipart form data. XMLHttpRequest rather than fetch, because only XHR reports upload
 * progress. Same cookie session and CSRF header as the JSON client.
 */
export function sendIntake(body: FormData, onProgress: (p: UploadProgress) => void): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<PublicTicket>((resolve, reject) => {
    xhr.open('POST', INTAKE_PATH);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Requested-With', 'aoc-web');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
    };
    xhr.onload = () => {
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(errorFrom(xhr.status, text));
        return;
      }
      try {
        resolve(JSON.parse(text) as PublicTicket);
      } catch {
        reject(new ApiError(xhr.status, 'invalid_json', 'The server returned a response that is not JSON'));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Network request failed'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.send(body);
  });
  return { promise, abort: () => xhr.abort() };
}
