import type { Protocol } from "@gamespace/protocol";

/**
 * Сценарии, собранные в конструкторе, живут в браузере стенда. Это черновики:
 * то, что пошло в запись, выгружается файлом и кладётся рядом с данными — от
 * хранилища браузера воспроизводимости ждать нельзя, его чистят не спросив.
 */
const KEY = "gamespace.protocols";

export function stored(): Protocol[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as Protocol[]) : [];
  } catch {
    // Испорченная запись не должна ронять витрину: сценарии — черновики, а не
    // данные сессии, и потерять их менее страшно, чем не открыть стенд.
    return [];
  }
}

export function keep(doc: Protocol): void {
  const list = stored().filter((p) => p.id !== doc.id);
  list.push(doc);
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function forget(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(stored().filter((p) => p.id !== id)));
}
