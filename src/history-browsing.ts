/** Durable mutation generations cover raw SQL on this or another connection.
 * Payload/context text deliberately does not invalidate structural validation:
 * selected context and payload are fetched and validated on every poll.
 */
export const browsingSchema = `
CREATE TABLE IF NOT EXISTS history_generations (id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
${["history", "reviews"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => {
  const columns = table === "reviews" && operation === "UPDATE" ? " OF id,entry,root,session" : ""
  const roots = operation === "INSERT" ? ["new"] : operation === "DELETE" ? ["old"] : ["old", "new"]
  return `CREATE TRIGGER IF NOT EXISTS browse_${table}_${operation} AFTER ${operation}${columns} ON ${table} BEGIN
    ${roots.map(row => `INSERT INTO history_generations VALUES (${row}.root,1)
      ON CONFLICT(id) DO UPDATE SET generation=generation+1;`).join("\n")}
    END;`
})).join("\n")}
${["INSERT", "UPDATE", "DELETE"].map(operation => {
  const rows = operation === "INSERT" ? ["new"] : operation === "DELETE" ? ["old"] : ["old", "new"]
  return `CREATE TRIGGER IF NOT EXISTS browse_sessions_${operation} AFTER ${operation} ON sessions BEGIN
    ${rows.map(row => `INSERT INTO history_generations SELECT DISTINCT root,1 FROM history WHERE session=${row}.id
      ON CONFLICT(id) DO UPDATE SET generation=generation+1;`).join("\n")}
    END;`
}).join("\n")}`

export interface BrowsingIndex { generation: number; total: number; ranks: Map<string, number> }
/** Bounded worker-local cache. No report bodies or contexts are retained. */
export class HistoryBrowsing {
  private roots = new Map<string, BrowsingIndex>()
  get(root: string, generation: number) {
    const saved = this.roots.get(root)
    if (saved?.generation !== generation) { this.roots.delete(root); return undefined }
    this.roots.delete(root); this.roots.set(root, saved)
    return saved
  }
  save(root: string, generation: number, total: number): BrowsingIndex {
    const saved = { generation, total, ranks: new Map<string, number>() }
    if (this.roots.size >= 32) this.roots.delete(this.roots.keys().next().value!)
    this.roots.set(root, saved)
    return saved
  }
  rank(index: BrowsingIndex, entry: string, rank: number) {
    if (index.ranks.size >= 128) index.ranks.delete(index.ranks.keys().next().value!)
    index.ranks.set(entry, rank)
  }
}
