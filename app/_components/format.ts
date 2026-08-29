/** Shared display helpers. Wait formatting itself lives in the domain layer. */

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

export function statusLabel(status: string, breakUntil: Date | string | null): string {
  switch (status) {
    case "available":
      return "Available";
    case "with_client":
      return "With a client";
    case "on_break": {
      if (!breakUntil) return "On a break";
      const until = new Date(breakUntil);
      const minutes = Math.round((until.getTime() - Date.now()) / 60000);
      if (minutes <= 0) return "Back any minute";
      return `Back in about ${minutes} min`;
    }
    default:
      return "Off today";
  }
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
