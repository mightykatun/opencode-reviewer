/** Escape controls rather than letting source or model text issue terminal commands
 * or reorder the displayed rating through bidi controls. Shared by the server's
 * report sanitization and the viewer, which must not import the engine. */
export function displayText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
}
