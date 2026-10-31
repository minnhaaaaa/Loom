"use client";
import { LoomSelect } from "./ui/loom-select";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  companyProviders,
  providerLabels,
  type CompanyProvider,
  type ModelChoice,
  type ProviderSettingsSnapshot,
} from "@loom/contracts";
import { accessRequest } from "./account-access";
import "../app/provider.css";

export function ProviderSettings({ workspaceId }: { workspaceId: string }) {
  return <ProviderSettingsForm key={workspaceId} workspaceId={workspaceId} />;
}
function ProviderSettingsForm({ workspaceId }: { workspaceId: string }) {
  const id = useId(),
    mounted = useRef(true),
    busyRef = useRef(false);
  const [settings, setSettings] = useState<ProviderSettingsSnapshot | null>(
    null,
  );
  const [provider, setProvider] = useState<CompanyProvider>("openai"),
    [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState(""),
    [maxTokens, setMaxTokens] = useState(4096);
  const [acknowledge, setAcknowledge] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const pending = useRef<{ signature: string; commandId: string } | null>(null);
  const catalogRequest = useRef<AbortController | null>(null);
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const [manualModel, setManualModel] = useState(false);
  const canLoadModels = Boolean(
    settings?.available &&
    (apiKey.trim().length >= 10 ||
      (settings.active && settings.provider === provider && !apiKey.trim())),
  );
  function clearModels() {
    catalogRequest.current?.abort();
    setModels(null);
    setLoadingModels(false);
    setModelError("");
    setManualModel(false);
  }
  async function loadModels() {
    if (!canLoadModels || busyRef.current) return;
    catalogRequest.current?.abort();
    const controller = new AbortController();
    catalogRequest.current = controller;
    setLoadingModels(true);
    setModelError("");
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    try {
      const value = await accessRequest<{ models: ModelChoice[] }>(
        "/api/workspaces/provider/models",
        {
          method: "POST",
          signal: controller.signal,
          headers: { "X-Loom-Workspace": workspaceId },
          body: JSON.stringify({
            provider,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          }),
        },
      );
      if (!controller.signal.aborted) setModels(value.models);
    } catch (reason) {
      if (
        mounted.current &&
        catalogRequest.current === controller &&
        (!controller.signal.aborted || timedOut)
      )
        setModelError(
          timedOut
            ? "Loading models timed out. Try again."
            : reason instanceof Error
              ? reason.message
              : "Models could not be loaded.",
        );
    } finally {
      clearTimeout(timeout);
      if (mounted.current && catalogRequest.current === controller)
        setLoadingModels(false);
    }
  }
  function adopt(value: ProviderSettingsSnapshot) {
    setSettings(value);
    if (value.provider) setProvider(value.provider);
    setModel(value.model || "");
    setMaxTokens(value.maxTokens);
  }
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void accessRequest<ProviderSettingsSnapshot>("/api/workspaces/provider", {
      signal: controller.signal,
      headers: { "X-Loom-Workspace": workspaceId },
    })
      .then((value) => {
        if (!controller.signal.aborted) adopt(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Company AI settings could not be loaded.",
          );
      });
    return () => {
      mounted.current = false;
      controller.abort();
      catalogRequest.current?.abort();
    };
  }, [workspaceId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!settings || busyRef.current) return;
    const signature = JSON.stringify({
      provider,
      model,
      apiKey,
      maxTokens,
      version: settings.version,
    });
    if (pending.current?.signature !== signature)
      pending.current = { signature, commandId: crypto.randomUUID() };
    await change({
      action: "test-and-save",
      commandId: pending.current.commandId,
      expectedVersion: settings.version,
      provider,
      model,
      apiKey,
      maxTokens,
      acknowledgeCharges: acknowledge,
    });
  }
  async function change(payload: unknown) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await accessRequest<ProviderSettingsSnapshot>(
        "/api/workspaces/provider",
        {
          method: "POST",
          headers: { "X-Loom-Workspace": workspaceId },
          body: JSON.stringify(payload),
        },
      );
      if (!mounted.current) return;
      adopt(value);
      if (!value.active) clearModels();
      setApiKey("");
      setAcknowledge(false);
      pending.current = null;
      setNotice(
        value.active
          ? "Connection tested and saved. Choose Company AI in Company setup to use this provider in the workspace."
          : "Company AI disconnected. The saved API key has been removed.",
      );
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error
            ? reason.message
            : "The connection could not be confirmed.",
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="company-provider" aria-labelledby={`${id}-title`}>
      <div className="company-provider-heading">
        <div>
          <span className="eyebrow">COMPANY AI</span>
          <h3 id={`${id}-title`}>Bring your AI provider</h3>
        </div>
        <span
          className={
            settings?.active ? "provider-state connected" : "provider-state"
          }
        >
          {settings?.active ? "Connected" : "Not connected"}
        </span>
      </div>
      {settings?.active && (
        <p className="provider-current">
          {providerLabels[settings.provider!]} ·{" "}
          <strong>{settings.model}</strong>
          <br />
          <small>
            Last tested {new Date(settings.testedAt!).toLocaleString()}
          </small>
        </p>
      )}
      {settings?.message && <p className="provider-note">{settings.message}</p>}
      <form onSubmit={(event) => void submit(event)}>
        <div className="provider-fields">
          <label htmlFor={`${id}-provider`}>
            Provider
            <LoomSelect
              id={`${id}-provider`}
              value={provider}
              disabled={busy || !settings?.available}
              onChange={(event) => {
                setProvider(event.target.value as CompanyProvider);
                setModel("");
                setApiKey("");
                clearModels();
                pending.current = null;
              }}
            >
              {companyProviders.map((item) => (
                <option key={item} value={item}>
                  {providerLabels[item]}
                </option>
              ))}
            </LoomSelect>
          </label>
          <div className="provider-key-field">
            <label htmlFor={`${id}-key`}>
              Company API key
              <input
                id={`${id}-key`}
                type="password"
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setModel("");
                  clearModels();
                }}
                disabled={busy || !settings?.available}
                required
                minLength={10}
                maxLength={4096}
                placeholder={
                  settings?.active
                    ? "Enter a new key to replace this connection"
                    : "Paste your company API key"
                }
                autoComplete="new-password"
                spellCheck={false}
              />
              <small>
                Encrypted on the server. Never shown to staff or returned after
                saving.
              </small>
            </label>
          </div>
          <div className="provider-model-field">
            <label htmlFor={`${id}-model`}>
              Model ID
              {manualModel ? (
                <input
                  id={`${id}-model`}
                  aria-label="Model ID"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  required
                  maxLength={150}
                  placeholder="Enter the exact model ID"
                  disabled={busy || !settings?.available}
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <LoomSelect
                  id={`${id}-model`}
                  aria-label="Model ID"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  onOpenChange={(open) => {
                    if (open && models === null && !loadingModels)
                      void loadModels();
                  }}
                  disabled={busy || !canLoadModels}
                  required
                >
                  <option value="" disabled>
                    {loadingModels
                      ? "Loading models…"
                      : modelError
                        ? "Could not load models"
                        : models?.length === 0
                          ? "No models returned"
                          : canLoadModels
                            ? "Choose a model"
                            : "Enter an API key first"}
                  </option>
                  {model && !models?.some((item) => item.id === model) && (
                    <option value={model}>{model}</option>
                  )}
                  {models?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name === item.id
                        ? item.id
                        : `${item.name} · ${item.id}`}
                    </option>
                  ))}
                </LoomSelect>
              )}
            </label>
            {modelError && (
              <p className="provider-model-error" role="alert">
                {modelError}
              </p>
            )}
            <div className="provider-model-actions">
              <button
                type="button"
                className="quiet provider-load-models"
                disabled={busy || loadingModels || !canLoadModels}
                onClick={() => void loadModels()}
              >
                {loadingModels
                  ? "Loading models…"
                  : modelError
                    ? "Retry loading models"
                    : models
                      ? "Refresh models"
                      : "Load models"}
              </button>
              {(modelError || models?.length === 0 || manualModel) && (
                <button
                  type="button"
                  className="quiet"
                  disabled={busy || !canLoadModels}
                  onClick={() => setManualModel((value) => !value)}
                >
                  {manualModel ? "Choose from list" : "Enter model ID"}
                </button>
              )}
            </div>
          </div>
          <label htmlFor={`${id}-tokens`}>
            Maximum output tokens per request
            <input
              id={`${id}-tokens`}
              type="number"
              min={256}
              max={8192}
              step={1}
              value={maxTokens}
              onChange={(event) => setMaxTokens(Number(event.target.value))}
              disabled={busy || !settings?.available}
              required
            />
            <small>
              This limits each reply; set spending limits with your provider.
            </small>
          </label>
        </div>
        <label className="provider-consent">
          <input
            type="checkbox"
            checked={acknowledge}
            onChange={(event) => setAcknowledge(event.target.checked)}
            disabled={busy || !settings?.available}
            required
          />
          <span>
            I authorize a small connection test and subsequent company AI
            requests on this API account. Provider charges may apply.
          </span>
        </label>
        <div className="provider-actions">
          <button
            type="submit"
            disabled={
              busy ||
              loadingModels ||
              !settings?.available ||
              !acknowledge ||
              !model.trim()
            }
          >
            {busy ? "Working…" : "Test and save connection"}
          </button>
          {settings?.active && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void change({
                  action: "revoke",
                  commandId: crypto.randomUUID(),
                  expectedVersion: settings.version,
                })
              }
            >
              Disconnect provider
            </button>
          )}
        </div>
      </form>
      {error && (
        <div role="alert" className="provider-error">
          {error}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              pending.current = null;
              setError("");
              setNotice(
                "You can now explicitly run a new connection test. A new test may incur another provider charge.",
              );
            }}
          >
            Start a new test
          </button>
        </div>
      )}
      {notice && (
        <p role="status" className="provider-notice">
          {notice}
        </p>
      )}
    </section>
  );
}
