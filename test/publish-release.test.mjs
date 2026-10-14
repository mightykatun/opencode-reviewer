import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { publishRelease as publish } from "../scripts/publish-release.mjs"

const publishRelease = (tarball, pkg, bytes, options) => publish(tarball, pkg, bytes, {
  provenance: async () => ({ file: "/tmp/fixture.sigstore", dispose: async () => {} }), ...options,
})

const pkg = { name: "opencode-reviewer", version: "0.4.0", publishConfig: { access: "public", registry: "https://registry.npmjs.org/" } }
const bytes = Buffer.from("verified archive fixture")
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
const readClock = () => {
  let at = 0
  return { now: () => at, sleep: async (ms) => { at += ms }, readTimeoutMs: 25, intervalMs: 10 }
}

test("new uploads adopt the signed provenance file and release its ownership after npm settles", async () => {
  const calls = []
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async () => new Response(null, { status: 404 }),
    provenance: async () => { calls.push("sign"); return { file: "/tmp/private signing/release.sigstore", dispose: async () => calls.push("dispose") } },
    run: (command, args) => {
      calls.push("upload")
      assert.equal(command, "npm")
      assert.equal(args[args.indexOf("--provenance-file") + 1], "/tmp/private signing/release.sigstore")
      assert.ok(!args.includes("--provenance"))
    },
  })
  assert.deepEqual(result, { status: "submitted", tag: "latest" })
  assert.deepEqual(calls, ["sign", "upload", "dispose"])
})

test("missing or failed signing prevents upload and uncertain uploads dispose without retries", async () => {
  let signs = 0, writes = 0, disposed = 0
  const options = { fetcher: async () => new Response(null, { status: 404 }), run: () => { writes++ } }
  await assert.rejects(publish("/tmp/verified.tgz", pkg, bytes, options), /explicit verified provenance/)
  await assert.rejects(publish("/tmp/verified.tgz", pkg, bytes, { ...options,
    provenance: async () => { signs++; throw new Error("signing failed") },
  }), /signing failed/)
  assert.equal(writes, 0)
  assert.equal(signs, 1)
  assert.deepEqual(await publish("/tmp/verified.tgz", pkg, bytes, { ...options,
    provenance: async () => { signs++; return { file: "/tmp/signed.sigstore", dispose: async () => { disposed++ } } },
    run: () => { writes++; throw new Error("uncertain upload") },
  }), { status: "uncertain", tag: "latest" })
  assert.equal(signs, 2)
  assert.equal(writes, 1)
  assert.equal(disposed, 1)
  await publish("/tmp/verified.tgz", pkg, bytes, { ...options,
    fetcher: async () => Response.json({ dist: { integrity } }), provenance: async () => { throw new Error("must not sign existing bytes") },
  })
  assert.equal(writes, 1)
})

test("identical published archives are idempotent and never invoke npm", async () => {
  let writes = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async (url) => {
      assert.equal(new URL(url).pathname, "/opencode-reviewer/0.4.0")
      assert.ok(new URL(url).searchParams.has("release_check"))
      return Response.json({ dist: { integrity } })
    },
    run: () => { writes++ },
  })
  assert.deepEqual(result, { status: "existing" })
  assert.equal(writes, 0)
})

test("mismatched archives and registry failures never publish", async () => {
  for (const [response, expected] of [[Response.json({ dist: { integrity: "different" } }), /Published version differs/],
    [new Response(null, { status: 503 }), /registry HTTP 503/]]) {
    let writes = 0
    await assert.rejects(publishRelease("/tmp/verified.tgz", pkg, bytes, {
      ...readClock(),
      fetcher: async () => response, run: () => { writes++ },
    }), expected)
    assert.equal(writes, 0, "a rejection must precede every forbidden write attempt")
  }
  let writes = 0
  await assert.rejects(publishRelease("/tmp/verified.tgz", pkg, bytes, {
    ...readClock(),
    fetcher: async () => { throw new Error("offline") }, run: () => { writes++ },
  }), /registry request failed/)
  assert.equal(writes, 0)
})

test("new releases publish the existing archive, with semantic channels and provenance", async () => {
  for (const [version, tag] of [["0.4.0", "latest"], ["0.5.0-beta.1", "next"]]) {
    let calls = 0
    assert.deepEqual(await publishRelease("/tmp/verified.tgz", { ...pkg, version }, bytes, {
      fetcher: async () => new Response(null, { status: 404 }),
      run: (command, args) => {
        calls++
        assert.equal(command, "npm")
        assert.deepEqual(args, ["publish", "/tmp/verified.tgz", "--ignore-scripts", "--access", "public", "--provenance-file", "/tmp/fixture.sigstore", "--tag", tag, "--registry", "https://registry.npmjs.org/", "--fetch-retries=0"])
      },
    }), { status: "submitted", tag })
    assert.equal(calls, 1)
  }
})

test("new uploads advance only their semantic channel and archive historical versions", async () => {
  for (const [version, tags, tag] of [
    ["0.4.0", { latest: "0.5.0" }, "archive"],
    ["0.5.0-beta.1", { next: "0.5.0-beta.2" }, "archive"],
    ["0.10.0", { latest: "0.9.0", next: "1.0.0-beta" }, "latest"],
    ["0.5.0-beta.10", { latest: "1.0.0", next: "0.5.0-beta.2" }, "next"],
    ["0.5.0", { next: "1.0.0-beta" }, "latest"],
    ["0.5.0-beta", { latest: "1.0.0" }, "next"],
    ["0.5.0", { latest: "0.5.0" }, "latest"],
  ]) {
    const reads = [], writes = []
    const result = await publishRelease("/tmp/verified.tgz", { ...pkg, version }, bytes, {
      fetcher: async (url, init) => {
        reads.push(decodeURIComponent(new URL(url).pathname))
        assert.ok(new URL(url).searchParams.has("release_check"))
        assert.equal(init.method ?? "GET", "GET")
        assert.ok(init.signal instanceof AbortSignal)
        return reads.length === 1 ? new Response(null, { status: 404 }) : Response.json(tags)
      },
      run: (command, args) => writes.push({ command, args }),
    })
    assert.deepEqual(reads, [`/opencode-reviewer/${version}`, "/-/package/opencode-reviewer/dist-tags"])
    assert.deepEqual(result, { status: "submitted", tag })
    assert.deepEqual(writes, [{ command: "npm", args: ["publish", "/tmp/verified.tgz", "--ignore-scripts", "--access", "public",
      "--provenance-file", "/tmp/fixture.sigstore", "--tag", tag, "--registry", "https://registry.npmjs.org/", "--fetch-retries=0"] }])
  }
})

test("unreadable or malformed channel state cannot authorize an upload", async () => {
  for (const [response, expected] of [
    [new Response(null, { status: 503 }), /registry HTTP 503/], [new Response(null, { status: 403 }), /HTTP 403/],
    [Response.json([]), /invalid dist-tags/], [Response.json(null), /invalid dist-tags/],
    [Response.json({ latest: null }), /valid semantic versioning/],
    [Response.json({ latest: "not-a-version" }), /valid semantic versioning/],
    [Response.json({ latest: "0.5.0-01" }), /leading zeros/],
    [Response.json({ latest: "0.5.0+build" }), /build metadata/],
  ]) {
    let reads = 0, writes = 0
    await assert.rejects(publishRelease("/tmp/verified.tgz", pkg, bytes, {
      ...readClock(),
      fetcher: async () => ++reads === 1 ? new Response(null, { status: 404 }) : response,
      run: () => { writes++ },
    }), expected)
    assert.ok(reads >= 2)
    assert.equal(writes, 0)
  }
})

test("post-header lookup failures retry reads before a single upload under one deadline", async () => {
  const options = readClock()
  let reads = 0, writes = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, { ...options,
    fetcher: async (url, init) => {
      assert.equal(init.redirect, "error")
      if (++reads === 1) return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("body connection lost")) } }))
      return new URL(url).pathname.endsWith("/dist-tags") ? Response.json({ latest: "0.3.0" }) : new Response(null, { status: 404 })
    },
    run: () => { writes++ },
  })
  assert.deepEqual(result, { status: "submitted", tag: "latest" })
  assert.equal(options.now(), 10)
  assert.equal(reads, 3)
  assert.equal(writes, 1)
})

test("persistent post-header failures or redirects never authorize an upload", async () => {
  for (const status of ["body", 302]) {
    const options = readClock()
    let writes = 0
    await assert.rejects(publishRelease("/tmp/verified.tgz", pkg, bytes, { ...options,
      fetcher: async (_, init) => {
        assert.equal(init.redirect, "error")
        return status === "body" ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("failed body")) } }))
          : new Response(null, { status, headers: { location: "https://elsewhere.test/" } })
      },
      run: () => { writes++ },
    }), status === "body" ? /no upload was attempted/ : /HTTP 302/)
    assert.equal(options.now(), status === "body" ? 25 : 0)
    assert.equal(writes, 0)
  }
})

test("a channel response that consumes the remaining read deadline cannot dispatch an upload", async () => {
  const options = readClock()
  let writes = 0
  await assert.rejects(publishRelease("/tmp/verified.tgz", pkg, bytes, { ...options,
    fetcher: async (url) => {
      if (new URL(url).pathname.endsWith("/dist-tags")) {
        await options.sleep(25)
        return Response.json({ latest: "0.3.0" })
      }
      return new Response(null, { status: 404 })
    },
    run: () => { writes++ },
  }), /no upload was attempted/)
  assert.equal(options.now(), 25)
  assert.equal(writes, 0)
})

test("noncanonical versions and publication overrides fail before registry reads or writes", async () => {
  for (const [change, expected] of [
    [(value) => { value.version = "0.4.0+build" }, /build metadata/],
    [(value) => { value.version = "0.5.0-beta.1+build" }, /build metadata/],
    [(value) => { value.version = "9007199254740992.0.0" }, /SemVer bounds/],
    [(value) => { value.tag = "latest" }, /top-level tag/],
    [(value) => { value.tag = null }, /top-level tag/],
    [(value) => { value.publishConfig.tag = "latest" }, /only access and registry/],
    [(value) => { value.publishConfig["ignore-scripts"] = false }, /only access and registry/],
    [(value) => { value.publishConfig.provenance = false }, /only access and registry/],
    [(value) => { value.publishConfig.cache = "/shared/cache" }, /only access and registry/],
  ]) {
    const invalid = structuredClone(pkg)
    change(invalid)
    let reads = 0, writes = 0
    await assert.rejects(publishRelease("/tmp/verified.tgz", invalid, bytes, {
      fetcher: async () => { reads++; return new Response(null, { status: 404 }) },
      run: () => { writes++ },
    }), expected)
    assert.equal(reads, 0)
    assert.equal(writes, 0)
  }
})

test("an uncertain upload is never automatically retried or followed by a dist-tag mutation", async () => {
  let writes = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async () => new Response(null, { status: 404 }),
    run: (command, args) => {
      assert.equal(command, "npm")
      assert.equal(args[0], "publish")
      assert.ok(args.includes("--fetch-retries=0"), "the npm CLI must not retry the upload internally")
      writes++
      throw new Error("upload acknowledgement lost")
    },
  })
  assert.deepEqual(result, { status: "uncertain", tag: "latest" })
  assert.equal(writes, 1)
})

test("serialized out-of-order uploads and reruns cannot regress either npm channel", async () => {
  for (const order of [["0.10.0", "0.9.1", "1.0.0-beta.10", "1.0.0-beta.2"],
    ["0.9.1", "0.10.0", "1.0.0-beta.2", "1.0.0-beta.10"]]) {
    const tags = { latest: "0.9.0", next: "1.0.0-beta.1" }, versions = new Set(), writes = []
    for (const version of [...order, ...order]) {
      await publishRelease("/tmp/verified.tgz", { ...pkg, version }, bytes, {
        fetcher: async (url) => new URL(url).pathname.endsWith("/dist-tags") ? Response.json(tags)
          : versions.has(version) ? Response.json({ dist: { integrity } }) : new Response(null, { status: 404 }),
        run: (command, args) => {
          assert.equal(command, "npm")
          assert.equal(args[0], "publish")
          const tag = args[args.indexOf("--tag") + 1]
          tags[tag] = version
          versions.add(version)
          writes.push(tag)
        },
      })
    }
    assert.equal(tags.latest, "0.10.0")
    assert.equal(tags.next, "1.0.0-beta.10")
    assert.equal(writes.length, 4, "each immutable version is uploaded only once")
    assert.deepEqual(writes, order[0] === "0.10.0" ? ["latest", "archive", "next", "archive"] : ["latest", "latest", "next", "next"])
  }
})
