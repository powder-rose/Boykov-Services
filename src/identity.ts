export const initials = (name?: string | null) =>
  name
    ?.trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join("")
    .toUpperCase() || "Б";
