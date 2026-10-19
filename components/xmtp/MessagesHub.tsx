"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useWallet } from "@/lib/wallet";
import { getUserVSFast, type VSData } from "@/lib/contract";
import { shortenAddress } from "@/lib/constants";
import { isXmtpFeatureEnabled } from "@/lib/xmtp/config";
import {
  VS_XMTP_CHAT_ANCHOR_ID,
  canOpenVsXmtpChat,
  getVsXmtpPeerAddress,
  getVsXmtpUnavailableReason,
  isSampleVsIdForXmtp,
} from "@/lib/xmtp/vs-chat-eligibility";
import {
  clearThreadRead,
  isThreadUnread,
  markThreadRead,
} from "@/lib/xmtp/read-state";
import { getVSTotalPot } from "@/lib/contract";
import PageTransition, { AnimatedItem } from "@/components/PageTransition";
import { Button, GlassCard } from "@/components/ui";
import MessagesWalletGate from "@/components/xmtp/MessagesWalletGate";
import MessagesPageHero from "@/components/xmtp/MessagesPageHero";
import VsXmtpPanel from "@/components/xmtp/VsXmtpPanel";
import {
  ChevronRight,
  Radio,
  Lock,
  Zap,
  Clock,
  Ban,
  AlertCircle,
  MessageCircle,
  Bell,
} from "lucide-react";

function truncateQuestion(q: string, max = 72): string {
  const t = q.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}…`;
}

const HUB_SHELL = "mx-auto w-full max-w-[720px] px-4 pb-16 sm:px-6";
const HUB_SHELL_WIDE =
  "mx-auto w-full max-w-[1280px] px-4 pb-16 sm:px-6 lg:px-8";
const CONTENT_DIVIDER = "mt-6 border-t border-pv-ink/[0.06] pt-8 sm:mt-8 sm:pt-10";

// Light blush surface to match the rest of the site (pv-bg #FCF8F8 / pv-surface
// #FBEFEF). Previous dark gradient + heavy shadow + backdrop-blur fought the
// soft palette used by Council / Stats / VS pages.
const HUB_SPLIT_SHELL =
  "mt-6 flex min-h-[min(72vh,680px)] flex-col overflow-hidden rounded-2xl border border-pv-border/35 bg-pv-surface/60 shadow-[0_18px_50px_-30px_rgba(120,40,40,0.18)] sm:mt-8 md:flex-row";

function ChannelListSkeleton({ ariaLabel }: { ariaLabel: string }) {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy="true"
      aria-label={ariaLabel}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-[4.75rem] rounded-xl border border-pv-border/25 bg-pv-surface2/40 animate-pulse sm:h-[5.25rem]"
        />
      ))}
    </div>
  );
}

export default function MessagesHub() {
  const { address, isConnected, isConnecting, connect } = useWallet();
  const t = useTranslations("messagesHub");
  const featureOn = useMemo(() => isXmtpFeatureEnabled(), []);

  const [duels, setDuels] = useState<VSData[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!address) {
        setDuels([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setLoadError(false);
      try {
        const snapshot = await getUserVSFast(address);
        if (!cancelled) {
          const results = (snapshot.items ?? []).sort((a, b) => b.id - a.id);
          setDuels(results);
        }
      } catch (e) {
        console.error("[MessagesHub]", e);
        if (!cancelled) {
          setLoadError(true);
          setDuels([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [address]);

  const { eligible, other } = useMemo(() => {
    const el: VSData[] = [];
    const rest: VSData[] = [];
    for (const vs of duels) {
      if (!isSampleVsIdForXmtp(vs.id) && canOpenVsXmtpChat(vs)) {
        el.push(vs);
      } else {
        rest.push(vs);
      }
    }
    return { eligible: el, other: rest };
  }, [duels]);

  const [hubListTab, setHubListTab] = useState<"active" | "pending">("active");

  useEffect(() => {
    if (eligible.length > 0 && other.length === 0) {
      setHubListTab("active");
    } else if (eligible.length === 0 && other.length > 0) {
      setHubListTab("pending");
    }
  }, [eligible.length, other.length]);

  const [selectedVsId, setSelectedVsId] = useState<number | null>(null);
  const hubChatPanelRef = useRef<HTMLDivElement>(null);

  const [readTick, setReadTick] = useState(0);

  const markRead = useCallback((vsId: number) => {
    markThreadRead(vsId, Date.now());
    setReadTick((n) => n + 1);
  }, []);

  const clearRead = useCallback((vsId: number) => {
    clearThreadRead(vsId);
    setReadTick((n) => n + 1);
  }, []);

  const selectedVs = useMemo(
    () => duels.find((d) => d.id === selectedVsId) ?? null,
    [duels, selectedVsId]
  );

  useEffect(() => {
    if (selectedVsId == null) return;
    if (!duels.some((d) => d.id === selectedVsId)) {
      setSelectedVsId(null);
    }
  }, [duels, selectedVsId]);

  useEffect(() => {
    if (selectedVsId == null) return;
    markThreadRead(selectedVsId, Date.now());
    setReadTick((n) => n + 1);
  }, [selectedVsId]);

  useEffect(() => {
    if (selectedVsId == null) return;
    if (typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    hubChatPanelRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [selectedVsId]);

  const participating = duels.length > 0;
  const showHubSplit =
    participating && !loadError && (eligible.length > 0 || other.length > 0);
  const showActiveInColumn =
    eligible.length > 0 &&
    (hubListTab === "active" || other.length === 0);
  const showPendingInColumn =
    other.length > 0 && (hubListTab === "pending" || eligible.length === 0);

  const unreadByVsId = useMemo(() => {
    void readTick;
    const map = new Map<number, boolean>();
    for (const vs of eligible) {
      map.set(vs.id, isThreadUnread(vs.id));
    }
    return map;
  }, [eligible, readTick]);

  if (!featureOn) {
    return (
      <PageTransition>
        <div className={HUB_SHELL}>
          <AnimatedItem>
            <MessagesPageHero variant="featureOff" className="pt-2 sm:pt-4" />
          </AnimatedItem>
          <div className={CONTENT_DIVIDER}>
            <AnimatedItem>
              <GlassCard className="border border-pv-ink/[0.1]">
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className="rounded-lg border border-pv-muted/25 bg-pv-surface2 p-2.5 sm:p-3">
                    <Lock className="text-pv-muted" size={22} aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display text-xs font-bold uppercase tracking-[0.16em] text-pv-text sm:text-sm sm:tracking-[0.18em]">
                      {t("featureOffTitle")}
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-pv-muted sm:text-[15px]">
                      {t("featureOffDesc")}
                    </p>
                  </div>
                </div>
              </GlassCard>
            </AnimatedItem>
          </div>
        </div>
      </PageTransition>
    );
  }

  if (!isConnected) {
    return (
      <MessagesWalletGate onConnect={connect} isConnecting={isConnecting} />
    );
  }

  return (
    <PageTransition>
      <div className={HUB_SHELL_WIDE}>
        <AnimatedItem>
          <MessagesPageHero className="pt-2 sm:pt-4" />
        </AnimatedItem>

        <div className={showHubSplit ? "mt-6 sm:mt-8" : CONTENT_DIVIDER}>
          {loading && (
            <ChannelListSkeleton ariaLabel={t("loadingAria")} />
          )}

          {!loading && loadError && (
            <AnimatedItem>
              <GlassCard className="border border-pv-danger/25 bg-pv-danger/[0.05]">
                <div className="flex gap-3 sm:gap-4">
                  <div className="shrink-0 pt-0.5">
                    <AlertCircle
                      className="text-pv-danger"
                      size={22}
                      strokeWidth={2}
                      aria-hidden
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-relaxed text-pv-danger">
                      {t("loadError")}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      fullWidth={false}
                      className="mt-4 !w-auto min-h-[44px] px-4 text-xs"
                      onClick={() => {
                        if (!address) return;
                        setLoading(true);
                        setLoadError(false);
                        void getUserVSFast(address)
                          .then((snapshot) => {
                            const r = (snapshot.items ?? []).sort((a, b) => b.id - a.id);
                            setDuels(r);
                          })
                          .catch(() => setLoadError(true))
                          .finally(() => setLoading(false));
                      }}
                    >
                      {t("retry")}
                    </Button>
                  </div>
                </div>
              </GlassCard>
            </AnimatedItem>
          )}

          {!loading && !loadError && !participating && (
            <AnimatedItem>
              <GlassCard className="relative overflow-hidden border border-pv-ink/[0.1]">
                <div className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-pv-emerald/[0.06] blur-2xl" />
                <div className="relative flex flex-col items-center px-4 py-10 text-center sm:px-6 sm:py-12">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full border border-pv-emerald/20 bg-pv-emerald/[0.08] sm:h-16 sm:w-16">
                    <Radio
                      className="text-pv-emerald/90"
                      size={28}
                      strokeWidth={1.5}
                      aria-hidden
                    />
                  </div>
                  <h2 className="mt-5 font-display text-base font-bold uppercase tracking-[0.08em] text-pv-text sm:text-lg sm:tracking-tight">
                    {t("noParticipationTitle")}
                  </h2>
                  <p className="mt-3 max-w-md text-sm leading-relaxed text-pv-muted sm:text-[15px]">
                    {t("noParticipationDesc")}
                  </p>
                  <div className="mt-8 flex w-full max-w-sm flex-col gap-3 sm:flex-row sm:justify-center">
                    <Link href="/explorer" className="w-full sm:w-auto">
                      <Button
                        variant="ghost"
                        fullWidth
                        className="min-h-[44px] sm:!w-auto sm:min-w-[10rem] sm:px-6"
                      >
                        {t("goExplore")}
                      </Button>
                    </Link>
                    <Link href="/vs/create" className="w-full sm:w-auto">
                      <Button
                        variant="primary"
                        fullWidth
                        className="min-h-[44px] sm:!w-auto sm:min-w-[10rem] sm:px-6"
                      >
                        {t("goChallenge")}
                      </Button>
                    </Link>
                  </div>
                </div>
              </GlassCard>
            </AnimatedItem>
          )}

          {!loading && !loadError && showHubSplit && (
            <AnimatedItem>
              <div className={HUB_SPLIT_SHELL}>
                <div className="flex w-full flex-col border-b border-pv-border/30 md:max-h-[min(72vh,680px)] md:w-[400px] md:shrink-0 md:border-b-0 md:border-r md:border-pv-border/30">
                  <div className="border-b border-pv-border/30 bg-pv-surface2/40 px-5 py-5 sm:px-6">
                    <div className="flex flex-wrap items-center gap-2.5 gap-y-2">
                      <h2 className="font-display text-lg font-bold uppercase tracking-tight text-pv-text sm:text-xl">
                        {t("title")}
                      </h2>
                      <span className="rounded border border-pv-border/30 bg-pv-bg/50 px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-pv-muted">
                        {t("hubSplitBadge")}
                      </span>
                    </div>
                    <p className="mt-2.5 text-[11px] leading-relaxed text-pv-muted">
                      {t("hubSplitLead")}
                    </p>
                  </div>

                  {eligible.length > 0 && other.length > 0 ? (
                    <div
                      className="flex border-b border-pv-border/30 bg-pv-surface2/25 px-1"
                      role="tablist"
                      aria-label={t("title")}
                    >
                      <button
                        type="button"
                        role="tab"
                        aria-selected={hubListTab === "active"}
                        id="messages-hub-tab-active"
                        aria-controls="messages-hub-tabpanel"
                        onClick={() => setHubListTab("active")}
                        className={`flex-1 px-2 py-2.5 text-center font-display text-[10px] font-bold uppercase tracking-[0.16em] transition-colors sm:tracking-[0.18em] ${
                          hubListTab === "active"
                            ? "border-b-2 border-pv-emerald bg-pv-emerald/[0.08] text-pv-emerald"
                            : "border-b-2 border-transparent text-pv-muted hover:bg-pv-surface2/40 hover:text-pv-text"
                        }`}
                      >
                        {t("sectionActive")}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={hubListTab === "pending"}
                        id="messages-hub-tab-pending"
                        aria-controls="messages-hub-tabpanel"
                        onClick={() => setHubListTab("pending")}
                        className={`flex-1 px-2 py-2.5 text-center font-display text-[10px] font-bold uppercase tracking-[0.16em] transition-colors sm:tracking-[0.18em] ${
                          hubListTab === "pending"
                            ? "border-b-2 border-pv-emerald bg-pv-emerald/[0.08] text-pv-emerald"
                            : "border-b-2 border-transparent text-pv-muted hover:bg-pv-surface2/40 hover:text-pv-text"
                        }`}
                      >
                        {t("sectionPending")}
                      </button>
                    </div>
                  ) : null}

                  <div
                    id="messages-hub-tabpanel"
                    role="tabpanel"
                    aria-label={
                      eligible.length > 0 && other.length > 0
                        ? hubListTab === "active"
                          ? t("sectionActive")
                          : t("sectionPending")
                        : showActiveInColumn
                          ? t("sectionActive")
                          : t("sectionPending")
                    }
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                  >
                    {showActiveInColumn ? (
                      <ul className="divide-y divide-pv-border/25">
                        {eligible.map((vs, i) => {
                          const peer = getVsXmtpPeerAddress(vs, address);
                          const vsPageHref = `/vs/${vs.id}#${VS_XMTP_CHAT_ANCHOR_ID}`;
                          const pot = getVSTotalPot(vs);
                          const isSelected = selectedVsId === vs.id;
                          const isUnread = unreadByVsId.get(vs.id) === true;
                          return (
                            <li key={vs.id}>
                              <motion.div
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{
                                  duration: 0.32,
                                  delay: i * 0.04,
                                  ease: [0.25, 0.46, 0.45, 0.94],
                                }}
                              >
                                <div
                                  className={`border-l-[3px] border-l-pv-emerald transition-[background-color,box-shadow] ${
                                    isSelected
                                      ? "bg-pv-emerald/[0.1] ring-1 ring-inset ring-pv-emerald/35"
                                      : "bg-pv-emerald/[0.05]"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    aria-pressed={isSelected}
                                    aria-controls="messages-hub-chat-panel"
                                    aria-label={t("hubSelectThreadAria", {
                                      id: vs.id,
                                    })}
                                    onClick={() => {
                                      setSelectedVsId(vs.id);
                                      markRead(vs.id);
                                    }}
                                    className={`focus-ring w-full px-5 pb-4 pt-5 text-left outline-none transition-colors sm:px-6 ${
                                      isSelected
                                        ? ""
                                        : "hover:bg-pv-emerald/[0.07]"
                                    }`}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <span className="font-display text-sm font-bold tabular-nums tracking-tight text-pv-emerald sm:text-[15px]">
                                        VS #{vs.id}
                                      </span>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        {isUnread ? (
                                          <span
                                            className="inline-flex items-center gap-1 rounded border border-pv-gold/40 bg-pv-gold/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-pv-gold"
                                            aria-label={t("unreadBadgeAria", {
                                              id: vs.id,
                                            })}
                                          >
                                            <Bell size={10} aria-hidden />
                                            {t("unreadBadge")}
                                          </span>
                                        ) : null}
                                        <span className="inline-flex items-center gap-1 rounded border border-pv-emerald/30 bg-pv-emerald/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-pv-emerald">
                                          <Zap size={10} aria-hidden />
                                          {t("badgeLive")}
                                        </span>
                                      </div>
                                    </div>
                                    <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug text-pv-text">
                                      {truncateQuestion(vs.question)}
                                    </p>
                                    <div className="mt-3 text-[10px] font-mono uppercase tracking-tight text-pv-muted">
                                      {peer
                                        ? t("withPeer", {
                                            address: shortenAddress(peer),
                                          })
                                        : null}
                                      {peer && pot > 0 ? " · " : ""}
                                      {pot > 0 ? (
                                        <span className="text-pv-gold/85">
                                          {pot} USDC
                                        </span>
                                      ) : null}
                                    </div>
                                  </button>
                                  <div className="flex justify-end border-t border-pv-border/25 px-5 py-3 sm:px-6">
                                    {isUnread ? (
                                      <button
                                        type="button"
                                        onClick={() => clearRead(vs.id)}
                                        className="focus-ring mr-auto inline-flex min-h-[44px] items-center gap-1 rounded-md font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted transition-colors hover:text-pv-text"
                                      >
                                        {t("markRead")}
                                      </button>
                                    ) : null}
                                    <Link
                                      href={vsPageHref}
                                      className="group focus-ring inline-flex min-h-[44px] items-center gap-1 rounded-md font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-emerald transition-colors hover:text-pv-emerald/85"
                                    >
                                      {t("viewVs")}
                                      <ChevronRight
                                        size={14}
                                        strokeWidth={2.25}
                                        className="transition-transform duration-200 group-hover:translate-x-0.5"
                                        aria-hidden
                                      />
                                    </Link>
                                  </div>
                                </div>
                              </motion.div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}

                    {showPendingInColumn ? (
                      <ul className="divide-y divide-pv-border/25">
                        {other.map((vs, i) => {
                          const reason =
                            getVsXmtpUnavailableReason(vs) ?? "not_accepted";
                          const isWaiting = reason === "not_accepted";
                          const StateIcon = isWaiting ? Clock : Ban;
                          const isSelected = selectedVsId === vs.id;
                          return (
                            <li key={vs.id}>
                              <motion.div
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{
                                  duration: 0.28,
                                  delay: 0.06 + i * 0.035,
                                  ease: [0.25, 0.46, 0.45, 0.94],
                                }}
                              >
                                <div
                                  className={`border-l-[3px] transition-[background-color,box-shadow] ${
                                    isWaiting
                                      ? isSelected
                                        ? "border-l-amber-400/70 bg-amber-400/[0.1] ring-1 ring-inset ring-amber-400/25"
                                        : "border-l-amber-400/55 bg-amber-400/[0.04]"
                                      : isSelected
                                        ? "border-l-pv-border/60 bg-pv-surface2/50 ring-1 ring-inset ring-pv-border/40"
                                        : "border-l-pv-border/35 bg-transparent"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    aria-pressed={isSelected}
                                    aria-controls="messages-hub-chat-panel"
                                    aria-label={t("hubSelectThreadAria", {
                                      id: vs.id,
                                    })}
                                    onClick={() => setSelectedVsId(vs.id)}
                                    className={`focus-ring w-full px-5 pb-4 pt-5 text-left outline-none transition-colors sm:px-6 ${
                                      isWaiting && !isSelected
                                        ? "hover:bg-amber-400/[0.06]"
                                        : !isWaiting && !isSelected
                                          ? "hover:bg-pv-surface2/40"
                                          : ""
                                    }`}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <span
                                        className={`font-display text-sm font-bold tabular-nums tracking-tight sm:text-[15px] ${
                                          isWaiting
                                            ? "text-amber-200/90"
                                            : "text-pv-muted"
                                        }`}
                                      >
                                        VS #{vs.id}
                                      </span>
                                      <StateIcon
                                        size={16}
                                        strokeWidth={1.75}
                                        className={`shrink-0 ${
                                          isWaiting
                                            ? "text-amber-200/75"
                                            : "text-pv-muted/80"
                                        }`}
                                        aria-hidden
                                      />
                                    </div>
                                    <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug text-pv-text">
                                      {truncateQuestion(vs.question, 72)}
                                    </p>
                                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                      <span
                                        className={`inline-flex items-center rounded border px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] ${
                                          isWaiting
                                            ? "border-amber-400/35 bg-amber-400/[0.08] text-amber-200/95"
                                            : "border-pv-border/30 bg-pv-bg/50 text-pv-muted"
                                        }`}
                                      >
                                        {isWaiting
                                          ? t("badgeAwaiting")
                                          : t("badgeNoComms")}
                                      </span>
                                    </div>
                                    <p className="mt-1.5 font-mono text-[10px] leading-snug text-pv-muted [overflow-wrap:anywhere]">
                                      {t(`reason.${reason}`)}
                                    </p>
                                  </button>
                                  <div className="flex justify-end border-t border-pv-border/25 px-5 py-3 sm:px-6">
                                    <Link
                                      href={`/vs/${vs.id}`}
                                      aria-label={`${t("viewVs")} — VS ${vs.id}`}
                                      className="group focus-ring inline-flex min-h-[44px] items-center gap-1 font-display text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted transition-colors hover:text-pv-emerald"
                                    >
                                      {t("viewVs")}
                                      <ChevronRight
                                        size={14}
                                        strokeWidth={2.25}
                                        className="transition-transform duration-200 group-hover:translate-x-0.5"
                                        aria-hidden
                                      />
                                    </Link>
                                  </div>
                                </div>
                              </motion.div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                </div>

                <div
                  ref={hubChatPanelRef}
                  id="messages-hub-chat-panel"
                  className="flex min-h-[min(52dvh,320px)] flex-1 flex-col bg-pv-bg/55 scroll-mt-20 md:min-h-0"
                >
                  {eligible.length === 0 ? (
                    <div className="border-b border-amber-400/25 bg-amber-400/[0.06] px-5 py-4 sm:px-6">
                      <p className="font-display text-xs font-bold uppercase tracking-[0.14em] text-pv-text">
                        {t("hubDisabledTitle")}
                      </p>
                      <p className="mt-1.5 text-xs leading-relaxed text-pv-muted sm:text-sm">
                        {t("hubDisabledDesc")}
                      </p>
                    </div>
                  ) : null}
                  {selectedVs ? (
                    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4 md:p-5">
                      <VsXmtpPanel vs={selectedVs} embedded />
                    </div>
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 sm:px-10">
                      <div className="max-w-md text-center">
                        <div
                          className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl border border-pv-emerald/25 bg-pv-emerald/[0.08]"
                          aria-hidden
                        >
                          <MessageCircle
                            className="text-pv-emerald"
                            size={24}
                            strokeWidth={1.75}
                          />
                        </div>
                        <h3 className="mt-6 font-display text-xs font-bold uppercase tracking-[0.2em] text-pv-text sm:text-sm">
                          {t("hubPanelTitle")}
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-pv-muted sm:text-[15px]">
                          {t("hubPanelBody")}
                        </p>
                        <p className="mt-8 font-mono text-[9px] uppercase tracking-[0.22em] text-pv-muted/70">
                          {t("hubPanelMeta")}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </AnimatedItem>
          )}
        </div>
      </div>
    </PageTransition>
  );
}
