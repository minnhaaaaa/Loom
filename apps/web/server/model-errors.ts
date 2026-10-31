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

const chatgptFailures: Record<
  string,
  { status: number; message: string; retryable: boolean }
> = {
  subscription_sharing_user_not_eligible: {
    status: 403,
    retryable: false,
    message:
      "This ChatGPT account or workspace cannot share plan usage with Loom. Check account eligibility and workspace policy.",
  },
  subscription_sharing_usage_limit_exceeded: {
    status: 429,
    retryable: false,
    message:
      "ChatGPT plan usage for this connection has reached a limit. Check ChatGPT settings → Usage before trying again.",
  },
  subscription_sharing_usage_unavailable: {
    status: 503,
    retryable: true,
    message:
      "ChatGPT plan usage could not be checked. Keep this connection and try again later.",
  },
  subscription_sharing_unsupported_capability: {
    status: 400,
    retryable: false,
    message:
      "ChatGPT does not support a requested model or capability. Choose a supported model or adjust this request.",
  },
  subscription_sharing_route_not_supported: {
    status: 403,
    retryable: false,
    message:
      "ChatGPT rejected this integration's inference route. Ask the deployment administrator to check its configuration.",
  },
  subscription_sharing_invalid_user: {
    status: 401,
    retryable: false,
    message:
      "ChatGPT could not validate the selected account. Reconnect your ChatGPT account before trying again.",
  },
  chatpass_v2_scope_not_authorized: {
    status: 403,
    retryable: false,
    message:
      "ChatGPT plan permission was rejected. Check the integration's client and permission configuration.",
  },
  chatpass_v2_invalid_authorization_context: {
    status: 403,
    retryable: false,
    message:
      "ChatGPT plan permission was rejected. Check the integration's client and permission configuration.",
  },
  subscription_sharing_user_unavailable: {
    status: 503,
    retryable: true,
    message:
      "ChatGPT account or workspace information is temporarily unavailable. Keep this connection and try again later.",
  },
};

function chatgptResponseError(
  response: Response,
  type: string,
  isPersonalPlan: boolean,
) {
  const known = Object.hasOwn(chatgptFailures, type)
    ? chatgptFailures[type]
    : undefined;
  const status = response.ok ? known?.status || 502 : response.status;
  const reconnect =
    isPersonalPlan &&
    (response.status === 401 || type === "subscription_sharing_invalid_user");
  const messages: Record<number, string> = {
    400: "ChatGPT rejected the model or structured-output settings. Check the selected model and request.",
    401: "Your ChatGPT connection was not accepted. Reconnect your ChatGPT account before trying again.",
    402: "ChatGPT cannot complete this request with the current plan availability. Check your ChatGPT account settings.",
    403: "ChatGPT denied this request. Check account permissions, serving-region restrictions, and integration settings.",
    404: "The selected ChatGPT model or inference route is unavailable. Check the connection settings.",
    408: "The ChatGPT request timed out. No generated changes were saved; you can explicitly retry.",
    429: "ChatGPT has limited requests from this connection. Check ChatGPT usage and try again later.",
    503: "ChatGPT is temporarily unavailable. Keep this connection and try again later.",
  };
  const retryAfterSeconds = retryDelay(response);
  return new DomainError(
    reconnect
      ? "OPENAI_RECONNECT_REQUIRED"
      : type === "response_incomplete"
        ? "MODEL_INCOMPLETE"
        : `MODEL_HTTP_${status}`,
    reconnect
      ? messages[401]
      : known?.message ||
          messages[status] ||
          "ChatGPT could not complete this response. No generated changes were saved; you can explicitly retry.",
    status === 429 ? 429 : 502,
    {
      retryable: reconnect
        ? false
        : (known?.retryable ?? [408, 429, 500, 502, 503, 504].includes(status)),
      // A plan limit does not identify a reset time. Only use an explicit header.
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  );
}

// Provider text is used only to classify known failures. It is never returned or logged.
export function modelResponseError(
  response: Response,
  body: unknown,
  provider?: string,
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
  const code = String(error.code || "");
  const type = Object.hasOwn(chatgptFailures, code)
    ? code
    : String(error.error_type || error.type || error.code || "");
  if (provider === "openai-chatgpt" || Object.hasOwn(chatgptFailures, type))
    return chatgptResponseError(response, type, provider === "openai-chatgpt");
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
    401: "The AI provider rejected the API key. Ask your company owner to check the connection.",
    402: "The configured model cannot run with the current account budget. Check the model and account settings before retrying.",
    403: "The AI provider denied this request. Check the model and provider settings before retrying.",
    404: "No compatible endpoint is available for the configured model and routing settings. Choose a compatible model or retry later.",
    408: "The provider timed out. No draft was saved; you can explicitly retry.",
    429: "The AI provider rate-limited generation. Wait before retrying; your draft is preserved.",
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
