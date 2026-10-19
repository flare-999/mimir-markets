/**
 * Extra market sources beyond crypto and equities.
 *
 * Every market Mimir opens has to be settleable by an oracle that fetches ONE url
 * and reads a number out of it. That rules out most "interesting" topics and is the
 * reason the arena drifted into being all price predictions: they were the only
 * sources wired up.
 *
 * These two are free, keyless, and return JSON whose answer is a number or a date —
 * so the settlement is arithmetic rather than interpretation:
 *
 *   Open-Meteo        tomorrow's maximum temperature for a named city
 *   Launch Library 2  whether a named rocket launch happens before a date
 *
 * The resolution URL IS the API call, so the oracle reads the same document the
 * market was written from. A page that might be rewritten later is not evidence.
 */

export interface WeatherEvent {
  city: string;
  country: string;
  resolutionUrl: string;
  /** Forecast high for the target day, Celsius. */
  forecastHighC: number;
  targetDate: string;
}

export interface LaunchEvent {
  id: string;
  name: string;
  provider: string;
  windowStart: string;
  windowStartMs: number;
  resolutionUrl: string;
}

const CITIES = [
  { city: "New York", country: "US", lat: 40.71, lon: -74.01 },
  { city: "London", country: "UK", lat: 51.51, lon: -0.13 },
  { city: "Tokyo", country: "JP", lat: 35.68, lon: 139.69 },
  { city: "Istanbul", country: "TR", lat: 41.01, lon: 28.98 },
  { city: "Sydney", country: "AU", lat: -33.87, lon: 151.21 },
  { city: "Berlin", country: "DE", lat: 52.52, lon: 13.41 },
] as const;

const FETCH_TIMEOUT_MS = 12_000;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "Mimir-MarketCreator/1.0" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    // A source that is down costs us that category this run, nothing more.
    return null;
  }
}

/**
 * Tomorrow's forecast high per city.
 *
 * `forecast_days=2` and reading index 1 gives tomorrow in the city's own timezone,
 * which is the day a reader means by "tomorrow" — UTC would put Sydney a day out.
 */
export async function fetchWeatherEvents(): Promise<{ text: string; events: WeatherEvent[] }> {
  const events: WeatherEvent[] = [];

  for (const spot of CITIES) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}`
      + `&daily=temperature_2m_max&timezone=auto&forecast_days=2`;
    const data = await getJson<{ daily?: { time?: string[]; temperature_2m_max?: number[] } }>(url);
    const high = data?.daily?.temperature_2m_max?.[1];
    const date = data?.daily?.time?.[1];
    if (typeof high !== "number" || !date) continue;
    events.push({
      city: spot.city, country: spot.country, resolutionUrl: url,
      forecastHighC: Math.round(high * 10) / 10, targetDate: date,
    });
  }

  if (events.length === 0) return { text: "Weather: source unavailable this run.", events };
  const text = events
    .map((event) => `${event.city} (${event.country}) — forecast high ${event.forecastHighC}°C on ${event.targetDate}`)
    .join("\n");
  return { text: `Weather forecasts (Open-Meteo, resolves to daily max temperature):\n${text}`, events };
}

/**
 * Upcoming orbital launches.
 *
 * Filtered to launches with a real window inside the next week: "will it launch
 * eventually" is not a market, and a slip beyond the deadline is exactly the
 * uncertainty being traded.
 *
 * Deduplicates by launch ID to ensure Mimir preserves funded-state safety and
 * clear operational boundaries. If the API returns multiple entries for the same
 * launch (e.g., status updates or historical records mixed in), only the first
 * valid one is kept.
 */
export async function fetchLaunchEvents(): Promise<{ text: string; events: LaunchEvent[] }> {
  const url = "https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=8&mode=list";
  const data = await getJson<{
    results?: Array<{ id?: string; name?: string; net?: string; launch_service_provider?: { name?: string } }>;
  }>(url);

  const now = Date.now();
  const week = now + 7 * 86_400_000;
  const events: LaunchEvent[] = [];
  const seenIds = new Set<string>();

  for (const result of data?.results ?? []) {
    const windowStartMs = Date.parse(result.net ?? "");
    if (!Number.isFinite(windowStartMs)) continue;
    if (windowStartMs <= now || windowStartMs > week) continue;

    const id = String(result.id ?? "");
    // Deduplicate by ID to prevent duplicate market creation for the same event.
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    events.push({
      id,
      name: String(result.name ?? "").slice(0, 120),
      provider: String(result.launch_service_provider?.name ?? "unknown"),
      windowStart: new Date(windowStartMs).toISOString(),
      windowStartMs,
      // One launch, so the oracle reads a single record rather than a list it has
      // to search through.
      resolutionUrl: `https://ll.thespacedevs.com/2.2.0/launch/${id}/`,
    });
  }

  if (events.length === 0) return { text: "Spaceflight: no launches scheduled in the next week.", events };
  const text = events
    .map((event) => `${event.name} — ${event.provider}, window opens ${event.windowStart}`)
    .join("\n");
  return {
    text: `Upcoming orbital launches (Launch Library, resolves from the launch record's status):\n${text}`,
    events,
  };
}