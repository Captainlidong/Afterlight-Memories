export interface KVStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const focusKey = (exhibitionId: string) => `afterlight.focus.${exhibitionId}`;

export function markLandingFocus(storage: KVStorage, exhibitionId: string): void {
  storage.setItem(focusKey(exhibitionId), "1");
}

/** 自动跳转落地后消费一次：聚焦标题 + 温和播报；刷新/重渲染不重复。 */
export function consumeLandingFocus(storage: KVStorage, exhibitionId: string): boolean {
  if (storage.getItem(focusKey(exhibitionId)) !== "1") return false;
  storage.removeItem(focusKey(exhibitionId));
  return true;
}