"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  companyProviders,
  providerLabels,
  type CompanyProvider,
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
      <p>
        Your team uses Loom normally. AI requests are billed to your company’s
        API account. Chat subscriptions and external coding agents are separate
        connections.
      </p>
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
      {settings && <p className="provider-note">{settings.message}</p>}
      <form onSubmit={(event) => void submit(event)}>
        <div className="provider-fields">
          <label htmlFor={`${id}-provider`}>
            Provider
            <select
              id={`${id}-provider`}
              value={provider}
              disabled={busy || !settings?.available}
              onChange={(event) => {
                setProvider(event.target.value as CompanyProvider);
                setModel("");
                setApiKey("");
                pending.current = null;
              }}
            >
              {companyProviders.map((item) => (
                <option key={item} value={item}>
                  {providerLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-model`}>
            Model ID
            <input
              id={`${id}-model`}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={busy || !settings?.available}
              required
              maxLength={150}
              placeholder="Enter a model from your provider account"
              autoComplete="off"
            />
          </label>
          <label htmlFor={`${id}-key`}>
            Company API key
            <input
              id={`${id}-key`}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
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
            disabled={busy || !settings?.available || !acknowledge}
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
