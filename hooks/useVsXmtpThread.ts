"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodedMessage, Dm } from "@xmtp/browser-sdk";
import type { XmtpClientInstance } from "@/lib/xmtp/types";
import {
  classifyXmtpThreadError,
  ensureVsDmThread,
  loadThreadMessages,
  type XmtpThreadErrorKind,
} from "@/lib/xmtp/chat-thread";
import {
  classifyXmtpFailureKind,
  nextXMtpFailure,
  type XmtpFailure,
} from "@/lib/xmtp/failure-state";
import {
  loadReadState,
  markThreadRead,
  saveReadState,
  type ReadStateMap,
} from "@/lib/xmtp/read-state";

const VISIBILITY_REFRESH_MIN_MS = 4000;

export type VsXmtpThreadPhase = "idle" | "loading" | "ready" | "error";

export type VsXmtpThreadError = {
  kind: XmtpThreadErrorKind;
  /** Mensaje técnico (logs / soporte); la UI debe mapear `kind` a i18n. */
  technical: string;
};

export type UseVsXmtpThreadOptions = {
  /** Wallet + VS eligible + peer conocido; no exige XMTP listo. */
  threadEligible: boolean;
  /** Cliente listo (solo con `xmtpStatus === "ready"). */
  client: XmtpClientInstance | null;
  peerAddress: string;
};

export type UseVsXmtpThreadResult = {
  phase: VsXmtpThreadPhase;
  dm: Dm | null;
  messages: DecodedMessage[];
  threadError: VsXmtpThreadError | null;
  /** El mismo fallo de apertura, ya clasificado para copy y reintento. */
  threadFailure: XmtpFailure | null;
  /**
   * Fallo del stream con el hilo ya abierto. No destruye hilo: los mensajes ya
   * cargados siguen visibles, pero pueden estar desactualizados hasta que se
   * reabra la conversación. Antes esto solo llegaba a `console.warn` el panel
   * seguía mostrando un hilo congelado sin ngun aviso.
   */
  streamFailure: XmtpFailure | null;
  isRefreshing: boolean;
  /** Sincroniza lista global + hilo y vuelve a cargar mensajes. */
  refreshThread: () => Promise<void>;
  /** Reinicia apertura del hilo (p. ej: tras error). */
  retryOpenThread: () => void;
  clearThreadError: () => void;
};

/**
 * Ciclo de vida del DM 1v1 VS: sync/consent (Paso 6), stream en vivo,
 * refresco al volver a la pestaña (throttle) e y refresco manual.
 */
export function useVsXmtpThread({
  threadEligible,
  client,
  peerAddress,
}: UseVsXmtpThreadOptions): UseVsXmtpThreadResult {
  const isNonFatalSyncNotice = useCallback((message: string) => {
    // XMTP can surface sync telemetry as an "error" string even when successful.
    // Example: "[GroupError::Sync] synced 1 messages, 0 failed 1 succeeded ..."
    return (
      /^\[GroupError::Sync\]/.test(message) &&
      /\b0\s+failed\b/i.test(message) &&
      /\bsucceeded\b/i.test(message)
    );
  }, []);
  const [phase, setPhase] = useState<VsXmtpThreadPhase>("idle");
  const [dm, setDm] = useState<Dm | null>(null);
  const [messages, setMessages] = useState<DecodedMessage[]>([]);
  const [threadError, setThreadError] = useState<VsXmtpThreadError | null>(
    null
  );
  /**
   * El mismo fallo de apertura, ya clasificado en la taxonomía que la UI pinta.
   * `threadError` se conserva porque la maqueta de demo 1v1 decide con
   * `kind === "peer_unreachable"`, y ese kind histórico no es 1:1 con
   * `XmtpFailureKind` (p. ej: `network` de `classifyXmtpThreadError` se desglosa
   * en `network` o `timeout`).
   */
  const [threadFailure, setThreadFailure] = useState<XmtpFailure | null>(null);
  const [streamFailure, setStreamFailure] = useState<XmtpFailure | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** Incrementar para forzar re-ejecución del efecto de apertura tras error. */
  const [openRetryNonce, setOpenRetryNonce] = useState(0);

  const initGen = useRef(0);
  const dmRef = useRef<Dm | null>(null);
  const clientRef = useRef<XmtpClientInstance | null>(null);
  const peerRef = useRef(peerAddress);
  const lastVisibilityRefreshAt = useRef(0);
  const wasHiddenRef = useRef(false);
  const readStateRef = useRef<ReadStateMap | null>(null);

  /**
   * Marca el hilo como leído siempre que hay un hilo abierto y mensajes vistos.
   * La ayuda de estado pura debe degradar silenciosamente si `safeStorage`
   * falla (SSR, cuota, modo privado, etc.).
   */
  const markCurrentThreadRead = useCallback(() => {
    const id = dmRef.current?.id;
    if (!id) return;
    const current = readStateRef.current ?? loadReadState();
    const next = markThreadRead(current, id, Date.now());
    readStateRef.current = next;
    if (next !== current) {
      saveReadState(next);
    }
  }, []);

  useEffect(() => {
    dmRef.current = dm;
  }, [dm]);

  useEffect(() => {
    clientRef.current = client;
  }, [client]);

  useEffect(() => {
    peerRef.current = peerAddress;
  }, [peerAddress]);

  const clearThreadError = useCallback(() => {
    setThreadError(null);
    setThreadFailure(null);
  }, []);

  /**
   * Registra un fallo de apertura/refresh en las dos formas que consume la UI: la
   * taxonomía histórica (`kind`, que decide la maqueta de demo) y la de fallo
   * (copy + política de reintento). Se registramos aquí, junto al error, para que
   * las dos no puedan derivar a categorías distintas del mismo fallo.
   */
  const recordThreadError = useCallback(
    (kind: XmtpThreadErrorKind, technical: string, cause?: unknown) => {
      setThreadError({ kind, technical });
      setThreadFailure((prev) =>
        nextXMtpFailure(
          prev,
          classifyXmtpFailureKind(cause ??  technical),
          technical
        )
      );
    },
    []
  );

  const retryOpenThread = useCallback(() => {
    setThreadError(null);
    setThreadFailure(null);
    setStreamFailure(null);
    setPhase("idle");
    setDm(null);
    setMessages([]);
    setOpenRetryNonce((n) => n + 1);
  }, []);

  const refreshThread = useCallback(async () => {
    const c = clientRef.current;
    const d = dmRef.current;
    const peer = peerRef.current;
    if (!c || !d || !peer) return;

    setIsRefreshing(true);
    clearThreadError();
    try {
      const { ConsentState } = await import("@xmtp/browser-sdk");
      await c.conversations.syncAll([ConsentState.Allowed]);
      await d.sync();
      const next = await loadThreadMessages(d);
      setMessages(next);
      // A fresh that lands proves the transport is alive again, so the
      // "messages may be stale" notice from a dead stream no longer applies.
      setStreamFailure(null);
      // Viewing the thread counts as reading it.
      markCurrentThreadRead();
    } catch (e) {
      const { kind, message } = classifyXMtpThreadError(e);
      if (isNonFatalSyncNotice(message)) {
        return;
      }
      recordThreadError(kind, message, e);
    } finally {
      setIsRefreshing(false);
    }
  }, [clearThreadError, isNonFatalSyncNotice, markCurrentThreadRead, recordThreadError]);

  const throttledVisibilityRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastVisibilityRefreshAt.current < VISIBILITY_REFRESH_MIN_MS) {
      return;
    }
    lastVisibilityRefreshAt.current = now;
    void refreshThread();
  }, [refreshThread]);

  useEffect(() => {
    if (!threadEligible || !client) {
      initGen.current += 1;
      setPhase("idle");
      setDm(null);
      setMessages([]);
      clearThreadError();
      setStreamFailure(null);
      return;
    }

    const myGen = ++initGen.current;
    setPhase("loading");
    clearThreadError();
    setStreamFailure(null);

    let streamEnd: (() => Promise<unknown>) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const { dm: opened, messages: initial } = await ensureVsDmThread(
          client,
          peerAddress,
          { timeoutMs: 20000 }
        );

        if (cancelled || myGen !== initGen.current) return;

        setDm(opened);
        setMessages(initial);
        setPhase("ready");
        // Opening a thread counts as reading it.
        markThreadRead(opened.id, Date.now());

        const stream = await opened.stream({
          onValue: (msg) => {
            if (myGen !== initGen.current) return;
            // A live value after a stream error is proof the stream recovered.
            setStreamFailure((prev) => (prev === null ? prev : null));
            setMessages((prev) => {
              if (prev.some((p) => p.id === msg.id)) return prev;
              return [...prev, msg].sort(
                (a, b) => a.sentAt.getTime() - b.sentAt.getTime()
              );
            });
            // A message viewed in the open thread counts as read.
            markThreadRead(opened.id, Date.now());
          },
          onError: (err) => {
            if (myGen !== initGen.current) return;
            // Non-destructive: the thread stays open and readable, but it is now
            // potentially stale and the UI must say so instead of going silent.
            setStreamFailure((prev) =>
              nextXmtpFailure(
                prev,
                "stream_lost",
                err instanceof Error ? err.message : String(err)
              )
            );
          },
        });
        streamEnd = () => stream.end();
      } catch (e) {
        if (cancelled || myGen !== initGen.current) return;
        const { kind, message } = classifyXmtpThreadError(e);
        if (isNonFatalSyncNotice(message)) {
          setPhase("idle");
          clearThreadError();
          return;
        }
        recordThreadError(kind, message, e);
        setPhase("error");
        setDm(null);
        setMessages([]);
        setStreamFailure(null);
      }
    })();

    return () => {
      cancelled = true;
      initGen.current += 1;
      void streamEnd?.();
      setDm(null);
      setMessages([]);
      setThreadFailure(null);
      setStreamFailure(null);
    };
  }, [threadEligible, client, peerAddress, openRetryNonce, clearThreadError, recordThreadError]);

  /**
   * Safety net: if the open flow gets stuck without throwing (SDK/worker edge cases),
   * fail fast into a recoverable error state instead of showing "Opening conversation…" forever.
   */
  useEffect(() => {
    if (!threadEligible) return;
    if (phase !== "loading") return;
    const myGen = initGen.current;
    const id = window.setTimeout(() => {
      // Only trip if we're still on the same init generation and still loading.
      if (initGen.current !== myGen) return;
      recordThreadError("network", "XMTP_OPEN_TIMEOUT");
      setPhase("error");
      setDm(null);
      setMessages([]);
      setStreamFailure(null);
    }, 25_000);
    return () => window.clearTimeout(id);
  }, [threadEligible, phase, recordThreadError]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (phase !== "ready" || !dm) return;

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        wasHiddenRef.current = true;
        return;
      }
      if (
        document.visibilityState === "visible" &&
        wasHiddenRef.current
      ) {
        wasHiddenRef.current = false;
        throttledVisibilityRefresh();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [phase, dm, throttledVisibilityRefresh]);

  return {
    phase,
    dm,
    messages,
    threadError,
    threadFailure,
    streamFailure,
    isRefreshing,
    refreshThread,
    retryOpenThread,
    clearThreadError,
  };
}
