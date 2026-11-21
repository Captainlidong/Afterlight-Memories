/**
 * 批量勾选的纯状态逻辑（任务书 v2.1 §19.4）。
 * scope 一律是点击时固定的 photo ID 集合，不包含后台后来新增照片；
 * 切换分组用 clear 清空勾选。state 为已选 ID 列表（保持插入序）。
 */
export type SelectionAction =
  | { type: "toggle"; id: string }
  | { type: "select_all"; scope: readonly string[] }
  | { type: "invert"; scope: readonly string[] }
  | { type: "clear" }
  | { type: "prune"; valid: readonly string[] };

export function selectionReducer(state: readonly string[], action: SelectionAction): string[] {
  switch (action.type) {
    case "toggle":
      return state.includes(action.id)
        ? state.filter((x) => x !== action.id)
        : [...state, action.id];
    case "select_all":
      return [...new Set(action.scope)];
    case "invert": {
      const sel = new Set(state);
      return [...new Set(action.scope)].filter((id) => !sel.has(id));
    }
    case "clear":
      return [];
    case "prune": {
      const valid = new Set(action.valid);
      return state.filter((id) => valid.has(id));
    }
  }
}