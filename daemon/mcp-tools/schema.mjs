// JSON Schema helpers shared by every daemon/mcp-tools/*.mjs definition file.

export const s = (t, desc) => ({ type: t, description: desc });
export const TAB_ID = ['tab_id', s('number', 'Session tab id (from ubb_tab_list / ubb_tab_create). Omit to use the most recent session tab.')];
