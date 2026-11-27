/** Durable mutation generations cover raw SQL on this or another connection.
 * Payload/context text deliberately does not invalidate structural validation:
 * selected context and payload are fetched and validated on every poll.
 * Review identity changes invalidate the roots of actual history references,
 * not the review's possibly changed ownership or an unreferenced pending review.
 */
export const browsingSchema = `
CREATE TABLE IF NOT EXISTS history_generations (id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS history_review ON history(review);
${["INSERT", "UPDATE", "DELETE"].map(operation => {
  const roots = operation === "INSERT" ? ["new"] : operation === "DELETE" ? ["old"] : ["old", "new"]
  return `CREATE TRIGGER browse_history_${operation} AFTER ${operation} ON history BEGIN
    ${roots.map(row => `INSERT INTO history_generations SELECT ${row}.root,1
      WHERE 1
      ON CONFLICT(id) DO UPDATE SET generation=generation+1;`).join("\n")}
    END;`
}).join("\n")}
${["INSERT", "UPDATE", "DELETE"].map(operation => {
  const columns = operation === "UPDATE" ? " OF id,entry,root,session" : ""
  const rows = operation === "INSERT" ? ["new"] : operation === "DELETE" ? ["old"] : ["old", "new"]
  return `CREATE TRIGGER browse_reviews_${operation} AFTER ${operation}${columns} ON reviews BEGIN
    ${rows.map(row => `INSERT INTO history_generations SELECT DISTINCT root,1 FROM history WHERE review=${row}.id
      ON CONFLICT(id) DO UPDATE SET generation=generation+1;`).join("\n")}
    END;`
}).join("\n")}
${["INSERT", "UPDATE", "DELETE"].map(operation => {
  const rows = operation === "INSERT" ? ["new"] : operation === "DELETE" ? ["old"] : ["old", "new"]
  return `CREATE TRIGGER browse_sessions_${operation} AFTER ${operation} ON sessions BEGIN
    ${rows.map(row => `INSERT INTO history_generations SELECT DISTINCT root,1 FROM history WHERE session=${row}.id
      ON CONFLICT(id) DO UPDATE SET generation=generation+1;`).join("\n")}
    END;`
}).join("\n")}`

export interface BrowsingIndex {
  generation: number; total: number; ranks: Map<string, number>
  latest?: string | null
  neighbors: Map<string, string | null>
}
/** 32 roots, each with <=128 ranks and <=128 hashed neighbor keys. No report/context text. */
export class HistoryBrowsing {
  private roots = new Map<string, BrowsingIndex>()
  get(root: string, generation: number) {
    const saved = this.roots.get(root)
    if (saved?.generation !== generation) { this.roots.delete(root); return undefined }
    this.roots.delete(root); this.roots.set(root, saved)
    return saved
  }
  save(root: string, generation: number, total: number): BrowsingIndex {
    const saved: BrowsingIndex = { generation, total, ranks: new Map<string, number>(), neighbors: new Map<string, string | null>() }
    if (this.roots.size >= 32) this.roots.delete(this.roots.keys().next().value!)
    this.roots.set(root, saved)
    return saved
  }
  rank(index: BrowsingIndex, entry: string, rank: number) {
    if (index.ranks.size >= 128) index.ranks.delete(index.ranks.keys().next().value!)
    index.ranks.set(entry, rank)
  }
  neighbor(index: BrowsingIndex, key: string, entry: string | null) {
    if (index.neighbors.size >= 128) index.neighbors.delete(index.neighbors.keys().next().value!)
    index.neighbors.set(key, entry)
  }
}
