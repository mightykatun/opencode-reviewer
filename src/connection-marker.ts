/** Only the exact startup-admitted public marker is an initial bridge echo.
 * Missing admission never exempts an event from reconnect fencing. */
export function initialConnectionEcho(admitted: string | undefined, observed: string | undefined): boolean {
  return admitted !== undefined && observed === admitted
}
