const localDateTimeOptions: Intl.DateTimeFormatOptions = {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
};

const localDateTimeWithYearOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
};

function parseDatabaseTimestamp(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  return new Date(hasTimezone ? normalized : `${normalized}Z`);
}

export function formatDatabaseTime(value: string | null | undefined, empty = "—") {
  return formatDatabaseTimeWith(value, localDateTimeOptions, empty);
}

export function formatDatabaseTimeWithYear(value: string | null | undefined, empty = "—") {
  return formatDatabaseTimeWith(value, localDateTimeWithYearOptions, empty);
}

/**
 * 判断一个「本地时间」串（`YYYY-MM-DD HH:mm`，也接受 `T` 分隔）是否晚于当前时刻。
 * 留 1 分钟容差：面板打开时自动填的「现在」，到保存时已经过去几十秒。
 */
export function isFutureMoment(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().replace(" ", "T");
  if (!normalized) return false;
  const date = new Date(normalized.length === 16 ? `${normalized}:00` : normalized);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() > Date.now() + 60_000;
}

function formatDatabaseTimeWith(value: string | null | undefined, options: Intl.DateTimeFormatOptions, empty: string) {
  if (!value) return empty;
  const date = parseDatabaseTimestamp(value);
  if (!date || Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", options);
}
