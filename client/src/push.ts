import { getDeviceId } from "./deviceId";

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: string };

export function pushSupport(): PushSupport {
  if (typeof window === "undefined") return { supported: false, reason: "no window" };
  if (!("serviceWorker" in navigator)) return { supported: false, reason: "Service workers not supported" };
  if (!("PushManager" in window)) return { supported: false, reason: "Push API not supported in this browser" };
  if (!("Notification" in window)) return { supported: false, reason: "Notifications API not supported" };
  return { supported: true };
}

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function ensureSwRegistered(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return navigator.serviceWorker.register("/sw.js");
}

export async function subscribeToPush(routeIds: string[]): Promise<{ ok: boolean; message?: string }> {
  const sup = pushSupport();
  if (!sup.supported) return { ok: false, message: sup.reason };

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, message: "Permission denied" };

  const keyRes = await fetch("/api/push/vapid-public-key");
  if (!keyRes.ok) return { ok: false, message: "Server has push disabled" };
  const { key } = await keyRes.json();

  const reg = await ensureSwRegistered();
  await navigator.serviceWorker.ready;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
  }

  const r = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: getDeviceId(),
      subscription: sub.toJSON(),
      routeIds,
    }),
  });
  if (!r.ok) return { ok: false, message: `Server returned ${r.status}` };
  return { ok: true };
}

export async function updatePushRoutes(routeIds: string[]) {
  try {
    await fetch("/api/push/update-routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: getDeviceId(), routeIds }),
    });
  } catch { /* swallow — best effort */ }
}

export async function unsubscribeFromPush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg) {
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  }
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: getDeviceId() }),
  });
}

export async function sendTestPush(): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await fetch("/api/push/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: getDeviceId() }),
    });
    if (r.ok) return { ok: true };
    const body = await r.json().catch(() => ({}));
    return { ok: false, message: body.error || `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function isSubscribed(): Promise<boolean> {
  if (!pushSupport().supported) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub;
}
