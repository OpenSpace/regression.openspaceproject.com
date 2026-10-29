import { AppConfig, TestKey } from './types';

/**
 * Joins the provided values into a URL path, encoding each of them.
 */
function joinPath(...parts: string[]): string {
  return parts.map(encodeURIComponent).join('/');
}

/**
 * Returns the URL of a result of a test run (an image, a thumbnail, or the log).
 *
 * @param type The kind of result, for example "candidate" or "difference-thumbnail"
 * @param test The test to which the result belongs
 * @param timestamp The timestamp of the test run. If it is omitted, the latest run is used
 * @param revision If larger than 0, it is added to the URL so that the browser loads the
 *        image again after it has changed on the server
 */
export function resultUrl(
  type: string,
  test: TestKey,
  timestamp?: string,
  revision = 0
): string {
  const parts = [type, test.application, test.group, test.name, test.hardware];
  if (timestamp) {
    parts.push(timestamp);
  }
  const url = `/api/result/${joinPath(...parts)}`;
  return revision > 0 ? `${url}?revision=${revision}` : url;
}

/**
 * Returns the URL of the full history of a test.
 */
export function historyUrl(test: TestKey): string {
  return `/api/test-history/${joinPath(test.application, test.group, test.name, test.hardware)}`;
}

/**
 * Returns the URL of the comparison of the images of two hardware setups for a test.
 */
export function compareUrl(
  type: string,
  application: string,
  group: string,
  name: string,
  hardware1: string,
  hardware2: string
): string {
  return `/api/compare/${joinPath(type, application, group, name, hardware1, hardware2)}`;
}

/**
 * Returns the error message that the server sent with a failed response, or a message
 * containing the status code if the response does not contain one.
 */
export async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') {
      return body.error;
    }
  } catch {
    // The response did not contain JSON
  }
  return `The server responded with status ${response.status}`;
}

/**
 * Loads JSON from the provided URL and throws an Error with the server's error message if
 * the request fails.
 */
export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) {
    throw new Error(await errorMessage(response));
  }
  return (await response.json()) as T;
}

/**
 * Loads the configuration values that are relevant for the frontend.
 */
export function fetchConfig(signal?: AbortSignal): Promise<AppConfig> {
  return fetchJson<AppConfig>('/api/config', signal);
}
