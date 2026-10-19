/**
 * Edad del snapshot para copy de UI (relativo, locale-aware).
 *
 * Contrato:
 * - `ageMs` debe ser un numero finito y no negativo; en caso contrario se
 *   devuelve cadena vacia (estado invalido/desconocido).
 * - `locale` debe ser un locale BCP 47 valido; si `Intl` no puede resolverlo
 *   se cae a "en" para no romper el render (dependencia tolerante a fallos).
 * - El resultado es siempre una cadena no vacia para entradas validas, de
 *   modo que la UI pueda mostrar feedback estable sin parpadeos.
 */
export function formatDashboardSnapshotAge(
  ageMs: number,
  locale: string
): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return "";
  }
  let resolvedLocale = locale;
  try {
    resolvedLocale = Intl.getCanonicalLocales(locale)[0] ?? "en";
  } catch {
    resolvedLocale = "en";
  }
  const secTotal = Math.floor(ageMs / 1000);
  const rtf = new Intl.RelativeTimeFormat(resolvedLocale, { numeric: "auto" });
  if (secTotal < 60) {
    return rtf.format(-Math.max(1, secTotal), "second");
  }
  const min = Math.floor(secTotal / 60);
  if (min < 60) {
    return rtf.format(-min, "minute");
  }
  const hours = Math.floor(min / 60);
  if (hours < 48) {
    return rtf.format(-hours, "hour");
  }
  const days = Math.floor(hours / 24);
  return rtf.format(-days, "day");
}
