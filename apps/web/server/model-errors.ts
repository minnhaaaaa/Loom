import "server-only";
import { DomainError } from "@loom/domain";

function retryDelay(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric)
    ? numeric
    : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds)
    ? Math.max(1, Math.min(86_400, Math.ceil(seconds)))
    : undefined;
}

// Provider text is used only to classify known failures. It is never returned or logged.
export function modelResponseError(
  response: Response,
  body: unknown,
): DomainError | null {
  const object =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const choices = Array.isArray(object.choices) ? object.choices : [];
  const choiceError = choices.find(
    (choice) => choice && typeof choice === "object" && "error" in choice,
  )?.error;
  const failure = object.error || choiceError;
  if (response.ok && !failure) return null;
  const error =
    failure && typeof failure === "object"
      ? (failure as Record<string, unknown>)
      : {};
  const type = String(error.error_type || error.type || error.code || "");
  const numeric = Number(error.code);
  const typedStatus: Record<string, number> = {
    rate_limit_exceeded: 429,
    rate_limited: 429,
    rate_limit_error: 429,
    no_available_provider: 503,
    provider_unavailable: 503,
    provider_error: 502,
    invalid_api_key: 401,
    insufficient_credits: 402,
    invalid_request: 400,
    context_length_exceeded: 400,
  };
  const status =
    Number.isInteger(numeric) && numeric >= 400 && numeric <= 599
      ? numeric
      : typedStatus[type] || (response.ok ? 502 : response.status);
  const retryAfterSeconds = retryDelay(response);
  if (/data policy|privacy/i.test(String(error.message || "")))
    return new DomainError(
      "MODEL_PRIVACY",
      "The provider privacy policy blocks this endpoint. Choose a compatible model; no account setting was changed.",
      502,
      { retryable: false },
    );
  const messages: Record<number, string> = {
    400: "The model rejected the tool schema or structured-output settings.",
    401: "OpenRouter rejected the API key. Check the server configuration before retrying.",
    402: "The configured model cannot run with the current account budget. Check the model and account settings before retrying.",
    403: "OpenRouter denied this request. Check the model and provider settings before retrying.",
    404: "No compatible endpoint is available for the configured model and routing settings. Choose a compatible model or retry later.",
    408: "The provider timed out. No draft was saved; you can explicitly retry.",
    429: "OpenRouter rate-limited generation. Wait before retrying; your draft is preserved.",
    502: "The provider could not complete generation. No draft was saved; you can explicitly retry.",
    503: "No compatible model provider is currently available. Your draft is preserved; try again later.",
  };
  const retryable =
    [404, 408, 429, 502, 503, 504].includes(status) ||
    (status === 402 && retryAfterSeconds !== undefined);
  return new DomainError(
    `MODEL_HTTP_${status}`,
    messages[status] ||
      "The provider could not generate this tool. No draft was saved.",
    status === 429 ? 429 : 502,
    {
      retryable,
      ...(retryAfterSeconds !== undefined || status === 429
        ? { retryAfterSeconds: retryAfterSeconds ?? 60 }
        : {}),
    },
  );
}
