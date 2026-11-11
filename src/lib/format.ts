const dateTime = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(value: Date | null | undefined): string {
  return value ? dateTime.format(value) : "—";
}

export function relativeDays(value: Date): string {
  const days = Math.ceil((value.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return "expired";
  if (days === 0) return "expira hoje";
  return `expira em ${days} dia${days === 1 ? "" : "s"}`;
}
