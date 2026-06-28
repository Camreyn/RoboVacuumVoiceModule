import {
  CheckCircle2,
  FileAudio,
  Home,
  KeyRound,
  Loader2,
  LogOut,
  Pause,
  RefreshCcw,
  Search,
  Send,
  ShieldCheck,
  Square,
  Upload,
  XCircle,
} from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import {
  clearSession,
  DeviceSummary,
  findDevices,
  getApiBaseUrl,
  getVoiceProperties,
  installVoicePack,
  InstallResult,
  login,
  sendVoiceTestAction,
  setApiBaseUrl as saveApiBaseUrl,
  verifyTwoFactor,
  VoicePropertiesResponse,
  VoiceTestAction,
} from "./api";

type Status = {
  tone: "neutral" | "success" | "danger";
  text: string;
};

type AuthState = "signed_out" | "captcha" | "two_factor" | "signed_in";

const DEFAULT_LOGIN = {
  username: "",
  password: "",
  country: "us",
  captchaCode: "",
  twoFactorCode: "",
};

export function App() {
  const [credentials, setCredentials] = useState(DEFAULT_LOGIN);
  const [authState, setAuthState] = useState<AuthState>("signed_out");
  const [captchaImage, setCaptchaImage] = useState<string | null>(null);
  const [twoFactorDestination, setTwoFactorDestination] = useState<string | undefined>();
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => loadSelectedDevice());
  const [voiceStatus, setVoiceStatus] = useState<VoicePropertiesResponse | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);
  const [sendOnUpload, setSendOnUpload] = useState(false);
  const [status, setStatus] = useState<Status>({ tone: "neutral", text: "Ready" });
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [apiBaseUrl, setApiBaseUrlState] = useState<string>(() => getApiBaseUrl());

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );
  const isAuthenticated = authState === "signed_in";
  const deviceName = selectedDevice?.name || selectedDevice?.model || selectedDeviceId || "No X40 selected";

  function handleApiEndpointSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = saveApiBaseUrl(apiBaseUrl);
    setApiBaseUrlState(saved);
    setStatus({ tone: "success", text: "API endpoint saved" });
  }

  function handleLocalApiEndpoint() {
    const saved = saveApiBaseUrl("http://localhost:8787");
    setApiBaseUrlState(saved);
    setStatus({ tone: "neutral", text: "Using local API" });
  }
  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("login", async () => {
      const result = await login({
        username: credentials.username,
        password: credentials.password,
        country: credentials.country,
        captchaCode: credentials.captchaCode || undefined,
      });
      applyLoginResult(result);
    });
  }

  async function handleTwoFactor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("two_factor", async () => {
      const result = await verifyTwoFactor(credentials.twoFactorCode);
      applyLoginResult(result);
    });
  }

  function applyLoginResult(result: Awaited<ReturnType<typeof login>>) {
    if (result.status === "authenticated") {
      setAuthState("signed_in");
      setCaptchaImage(null);
      setTwoFactorDestination(undefined);
      setCredentials((current) => ({ ...current, password: "", captchaCode: "", twoFactorCode: "" }));
      setStatus({ tone: "success", text: "Local session active" });
      void handleDeviceSearch();
      return;
    }

    if (result.status === "captcha_required") {
      setAuthState("captcha");
      setCaptchaImage(result.captchaImage);
      setStatus({ tone: "neutral", text: "Captcha required" });
      return;
    }

    setAuthState("two_factor");
    setTwoFactorDestination(result.destination);
    setStatus({ tone: "neutral", text: "Verification required" });
  }

  async function handleLogout() {
    await runAction("logout", async () => {
      await clearSession();
      setAuthState("signed_out");
      setDevices([]);
      setVoiceStatus(null);
      setInstallResult(null);
      setStatus({ tone: "neutral", text: "Session cleared" });
    });
  }

  async function handleDeviceSearch() {
    await runAction("devices", async () => {
      const result = await findDevices();
      setDevices(result.devices);
      if (result.devices.length === 1) {
        selectDevice(result.devices[0]);
        setStatus({ tone: "success", text: "1 vacuum found" });
        return;
      }
      setStatus({
        tone: result.devices.length ? "success" : "danger",
        text: result.devices.length ? `${result.devices.length} vacuums found` : result.message || "No vacuums found",
      });
    });
  }

  function selectDevice(device: DeviceSummary) {
    setSelectedDeviceId(device.id);
    persistSelectedDevice(device.id);
    setVoiceStatus(null);
    setInstallResult(null);
    void refreshVoiceStatus(device.id);
  }

  async function handleVoiceRefresh() {
    await refreshVoiceStatus(selectedDeviceId);
  }

  async function handleVoiceTest(action: VoiceTestAction) {
    if (!selectedDeviceId) {
      setStatus({ tone: "danger", text: "Choose a vacuum first" });
      return;
    }

    await runAction(`voice-test-${action}`, async () => {
      const result = await sendVoiceTestAction(selectedDeviceId, action);
      const voice = await getVoiceProperties(selectedDeviceId).catch((error) => ({
        message: error instanceof Error ? error.message : "Voice status refresh failed",
      }));
      setVoiceStatus(voice);
      setStatus({ tone: "success", text: `${result.label} sent` });
    });
  }

  async function refreshVoiceStatus(deviceId: string) {
    if (!deviceId) {
      setStatus({ tone: "danger", text: "Choose a vacuum first" });
      return;
    }

    await runAction("voice", async () => {
      const result = await getVoiceProperties(deviceId);
      setVoiceStatus(result);
      setStatus({ tone: "success", text: "Voice status loaded" });
    });
  }

  async function handleInstall() {
    if (!selectedDeviceId) {
      setStatus({ tone: "danger", text: "Choose a vacuum first" });
      return;
    }
    if (!file) {
      setStatus({ tone: "danger", text: "Choose a voice-pack file first" });
      return;
    }

    await runAction("install", async () => {
      const result = await installVoicePack(selectedDeviceId, file, { send: sendOnUpload });
      setInstallResult(result);
      setVoiceStatus(result.after || result.before || null);
      setStatus({ tone: result.success ? "success" : "neutral", text: result.message });
    });
  }

  async function runAction(action: string, callback: () => Promise<void>) {
    setBusyAction(action);
    setStatus({ tone: "neutral", text: "Working" });
    try {
      await callback();
    } catch (error) {
      setStatus({ tone: "danger", text: error instanceof Error ? error.message : "Request failed" });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="shell">
      <section className="topbar" aria-label="Application header">
        <div>
          <p className="eyebrow">Local Dreame X40</p>
          <h1>Voice-pack installer</h1>
        </div>
        <StatusPill status={status} busy={Boolean(busyAction)} />
      </section>

      <section className="workspace">
        <form className="panel endpoint-panel" onSubmit={handleApiEndpointSave}>
          <div className="panel-title">
            <KeyRound aria-hidden="true" />
            <h2>API endpoint</h2>
          </div>
          <label>
            URL
            <input
              autoComplete="url"
              onChange={(event) => setApiBaseUrlState(event.target.value)}
              placeholder="https://example.trycloudflare.com"
              value={apiBaseUrl}
            />
          </label>
          <div className="button-row">
            <button type="submit">Save</button>
            <button className="secondary" onClick={handleLocalApiEndpoint} type="button">
              Local
            </button>
          </div>
        </form>
        <form className="panel auth-panel" onSubmit={handleLogin}>
          <div className="panel-title">
            <ShieldCheck aria-hidden="true" />
            <h2>Dreamehome account</h2>
          </div>
          <label>
            Email or phone
            <input
              autoComplete="username"
              disabled={busyAction === "login" || isAuthenticated}
              onChange={(event) => setCredentials((current) => ({ ...current, username: event.target.value }))}
              value={credentials.username}
            />
          </label>
          <div className="field-grid compact-grid">
            <label>
              Password
              <input
                autoComplete="current-password"
                disabled={busyAction === "login" || isAuthenticated}
                onChange={(event) => setCredentials((current) => ({ ...current, password: event.target.value }))}
                type="password"
                value={credentials.password}
              />
            </label>
            <label>
              Cloud region
              <input
                disabled={busyAction === "login" || isAuthenticated}
                onChange={(event) => setCredentials((current) => ({ ...current, country: event.target.value.toLowerCase() }))}
                value={credentials.country}
              />
            </label>
          </div>
          {authState === "captcha" ? (
            <div className="challenge-box">
              {captchaImage ? <img alt="Captcha challenge" src={captchaImage} /> : null}
              <label>
                Captcha
                <input
                  onChange={(event) => setCredentials((current) => ({ ...current, captchaCode: event.target.value }))}
                  value={credentials.captchaCode}
                />
              </label>
            </div>
          ) : null}
          <div className="button-row">
            <button disabled={isAuthenticated || busyAction === "login" || !credentials.username || !credentials.password} type="submit">
              <KeyRound aria-hidden="true" />
              Sign in
            </button>
            <button className="secondary" disabled={busyAction === "logout"} onClick={handleLogout} type="button">
              <LogOut aria-hidden="true" />
              Clear
            </button>
          </div>
        </form>

        {authState === "two_factor" ? (
          <form className="panel" onSubmit={handleTwoFactor}>
            <div className="panel-title">
              <ShieldCheck aria-hidden="true" />
              <h2>Two-factor code</h2>
            </div>
            {twoFactorDestination ? <p className="hint">Code sent to {twoFactorDestination}</p> : null}
            <label>
              Code
              <input
                inputMode="numeric"
                onChange={(event) => setCredentials((current) => ({ ...current, twoFactorCode: event.target.value }))}
                value={credentials.twoFactorCode}
              />
            </label>
            <button disabled={!credentials.twoFactorCode || busyAction === "two_factor"} type="submit">
              <ShieldCheck aria-hidden="true" />
              Verify
            </button>
          </form>
        ) : null}

        <section className="panel">
          <div className="panel-title">
            <Search aria-hidden="true" />
            <h2>Vacuum</h2>
          </div>
          <div className="button-row">
            <button disabled={!isAuthenticated || busyAction === "devices"} onClick={handleDeviceSearch} type="button">
              <Search aria-hidden="true" />
              Find X40
            </button>
            <button className="secondary" disabled={!isAuthenticated || !selectedDeviceId || busyAction === "voice"} onClick={handleVoiceRefresh} type="button">
              <RefreshCcw aria-hidden="true" />
              Status
            </button>
          </div>
          {devices.length ? (
            <div className="device-list">
              {devices.map((device) => (
                <button
                  className={`device-option ${device.id === selectedDeviceId ? "selected" : ""}`}
                  key={device.id}
                  onClick={() => selectDevice(device)}
                  type="button"
                >
                  <span>{device.name || device.model || device.id}</span>
                  <small>{device.model || "unknown model"} / {device.id}</small>
                </button>
              ))}
            </div>
          ) : null}
          <div className="device-strip">
            <span>{deviceName}</span>
            {selectedDeviceId ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
          </div>
          <VoiceStatus value={voiceStatus} />
          <div className="test-actions" aria-label="Voice test actions">
            <button disabled={!isAuthenticated || !selectedDeviceId || Boolean(busyAction)} onClick={() => handleVoiceTest("charge")} type="button">
              <Home aria-hidden="true" />
              Return
            </button>
            <button className="secondary" disabled={!isAuthenticated || !selectedDeviceId || Boolean(busyAction)} onClick={() => handleVoiceTest("pause")} type="button">
              <Pause aria-hidden="true" />
              Pause
            </button>
            <button className="secondary" disabled={!isAuthenticated || !selectedDeviceId || Boolean(busyAction)} onClick={() => handleVoiceTest("stop")} type="button">
              <Square aria-hidden="true" />
              Stop
            </button>
          </div>
        </section>

        <section className="panel install-panel">
          <div className="panel-title">
            <Upload aria-hidden="true" />
            <h2>Voice pack</h2>
          </div>
          <label className="file-picker">
            <input onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" />
            <FileAudio aria-hidden="true" />
            <span>{file ? file.name : "Choose file"}</span>
          </label>
          {file ? (
            <div className="file-meta">
              <span>{(file.size / 1024 / 1024).toFixed(2)} MiB</span>
              <span>{file.type || "binary"}</span>
            </div>
          ) : null}
          <label className="send-toggle">
            <input
              checked={sendOnUpload}
              onChange={(event) => setSendOnUpload(event.target.checked)}
              type="checkbox"
            />
            <span>Send command to vacuum after preparing</span>
          </label>
          <button className="primary-wide" disabled={!isAuthenticated || !selectedDeviceId || !file || busyAction === "install"} onClick={handleInstall} type="button">
            <Send aria-hidden="true" />
            {sendOnUpload ? "Send pack" : "Prepare pack"}
          </button>
          {installResult ? <InstallSummary result={installResult} /> : null}
        </section>
      </section>
    </main>
  );
}

function VoiceStatus({ value }: { value: VoicePropertiesResponse | null }) {
  if (!value) {
    return <div className="status-grid muted">Voice status not loaded</div>;
  }

  const properties = value.properties || {};
  return (
    <div className="status-grid">
      <span>Packet</span>
      <strong>{String(properties.voice_packet_id ?? "unknown")}</strong>
      <span>Change status</span>
      <strong>{String(properties.voice_change_status ?? "unknown")}</strong>
      <span>Change value</span>
      <strong>{String(properties.voice_change ?? "unknown")}</strong>
    </div>
  );
}

function InstallSummary({ result }: { result: InstallResult }) {
  return (
    <div className="install-summary">
      <div>
        <span>Job</span>
        <strong>{result.jobId}</strong>
      </div>
      {result.fileName ? (
        <div>
          <span>Serving</span>
          <strong>{result.fileName}</strong>
        </div>
      ) : null}
      {result.diagnostics?.unwrappedFrom ? (
        <div>
          <span>Unwrapped</span>
          <strong>{result.diagnostics.unwrappedFrom}</strong>
        </div>
      ) : null}
      {result.md5 ? (
        <div>
          <span>MD5</span>
          <strong>{result.md5}</strong>
        </div>
      ) : null}
      {result.diagnostics?.mode ? (
        <div>
          <span>Mode</span>
          <strong>{result.diagnostics.mode}</strong>
        </div>
      ) : null}
      {result.diagnostics?.publicFileBaseUrl ? (
        <div>
          <span>LAN base</span>
          <strong>{result.diagnostics.publicFileBaseUrl}</strong>
        </div>
      ) : null}
      {result.fileUrl ? (
        <a href={result.fileUrl} target="_blank" rel="noreferrer">
          Local pack URL
        </a>
      ) : null}
      {result.command ? <pre>{JSON.stringify(result.command, null, 2)}</pre> : null}
    </div>
  );
}

function StatusPill({ status, busy }: { status: Status; busy: boolean }) {
  return (
    <div className={`status status-${status.tone}`}>
      {busy ? <Loader2 aria-hidden="true" /> : null}
      {status.text}
    </div>
  );
}

function loadSelectedDevice(): string {
  return window.localStorage.getItem("dreame-selected-device") || "";
}

function persistSelectedDevice(deviceId: string) {
  window.localStorage.setItem("dreame-selected-device", deviceId);
}
