import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"
import { archiveIntegrity, PUBLICATION_TIMEOUT_MS, registryReader, verifyPublication } from "../scripts/npm-publication.mjs"
import { publishRelease as publish } from "../scripts/publish-release.mjs"

const publishRelease = (tarball, pkg, bytes, options) => publish(tarball, pkg, bytes, {
  provenance: async () => ({ file: "/tmp/fixture.sigstore", dispose: async () => {} }), ...options,
})

const pkg = { name: "opencode-reviewer", version: "0.4.1", publishConfig: { access: "public", registry: "https://registry.npmjs.org/" } }
const bytes = Buffer.from("verified archive")
const metadata = { ...pkg, dist: {
  integrity: archiveIntegrity(bytes),
  tarball: "https://registry.npmjs.org/opencode-reviewer/-/opencode-reviewer-0.4.1.tgz",
} }
const versionPath = "/opencode-reviewer/0.4.1"
const tagsPath = "/-/package/opencode-reviewer/dist-tags"
const ready = (url, tag = "latest") => {
  const pathname = new URL(url).pathname
  return pathname === versionPath ? Response.json(metadata)
    : pathname === tagsPath ? Response.json({ [tag]: pkg.version })
    : new Response(bytes)
}
function clock() {
  let at = 0
  const messages = []
  return { now: () => at, sleep: async (ms) => { at += ms }, log: (s) => messages.push(s), messages, timeoutMs: 100, intervalMs: 10 }
}

test("accepted publication waits for metadata, dist-tag and archive without republishing", async () => {
  let publishes = 0, polls = 0
  const options = clock(), urls = new Set()
  assert.deepEqual(await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async () => new Response(null, { status: 404 }),
    run: () => { publishes++ },
  }), { status: "submitted", tag: "latest" })
  await verifyPublication(pkg, bytes, "latest", { ...options,
    fetcher: async (url, init) => {
      assert.equal(init.headers["cache-control"], "no-cache")
      assert.equal(init.redirect, "error")
      assert.ok(init.signal instanceof AbortSignal)
      assert.ok(new URL(url).searchParams.get("release_check"))
      assert.ok(!urls.has(url), "every poll must bypass negative registry caches")
      urls.add(url)
      const pathname = new URL(url).pathname
      if (pathname === versionPath && ++polls === 1) return new Response(null, { status: 404 })
      if (pathname === tagsPath && polls === 2) return Response.json({ latest: "0.4.0" })
      if (pathname.endsWith(".tgz") && polls === 3) return new Response(null, { status: 404 })
      return ready(url)
    },
  })
  assert.equal(publishes, 1)
  assert.equal(polls, 4)
  assert.equal(options.now(), 30)
  assert.match(options.messages.at(-1), /Verified.*archive integrity matches/)
})

test("an npm PUT 503 enters read-only verification and succeeds only when the identical archive appears", async () => {
  let uploads = 0, polls = 0, disposed = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async () => new Response(null, { status: 404 }),
    provenance: async () => ({ file: "/tmp/fixture.sigstore", dispose: async () => { disposed++ } }),
    run: () => { uploads++; throw Error("503 after committed PUT") },
  })
  assert.deepEqual(result, { status: "uncertain", tag: "latest" })
  assert.equal(disposed, 1)
  const options = clock()
  await verifyPublication(pkg, bytes, result.tag, { ...options,
    fetcher: async (url, init) => {
      assert.equal(init.method ?? "GET", "GET")
      if (new URL(url).pathname === versionPath && ++polls < 3) return new Response(null, { status: 404 })
      return ready(url)
    },
  })
  assert.equal(uploads, 1)
  assert.equal(polls, 3)
  assert.equal(options.now(), 20)
  assert.match(options.messages.at(-1), /Verified.*archive integrity matches/)
})

for (const outcome of ["absent", "mismatched"]) test(`uncertain upload verification stays failed when the archive is ${outcome}`, async () => {
  let uploads = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async () => new Response(null, { status: 404 }),
    run: () => { uploads++; throw Error("lost acknowledgement") },
  })
  const options = clock()
  await assert.rejects(verifyPublication(pkg, bytes, result.tag, { ...options,
    fetcher: async url => outcome === "absent" ? new Response(null, { status: 404 })
      : new URL(url).pathname.endsWith(".tgz") ? new Response(Buffer.alloc(bytes.length)) : ready(url),
  }), outcome === "absent" ? /publication could not be verified/ : /Downloaded npm archive differs/)
  assert.equal(uploads, 1)
  if (outcome === "absent") assert.equal(options.now(), 100)
  assert.equal(options.messages.some(message => message.startsWith("Verified")), false)
})

test("default verification survives long npm processing across metadata, channel and archive without another upload", async () => {
  const options = clock(), minute = 60000
  let publishes = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async () => new Response(null, { status: 404 }),
    run: () => { publishes++ },
  })
  await verifyPublication(pkg, bytes, result.tag, { ...options, timeoutMs: undefined, intervalMs: minute,
    fetcher: async url => {
      const pathname = new URL(url).pathname
      if (pathname === versionPath && options.now() < 20 * minute) return new Response(null, { status: 404 })
      if (pathname === tagsPath && options.now() < 40 * minute) return Response.json({ latest: "0.4.0" })
      if (pathname.endsWith(".tgz") && options.now() < 50 * minute) return new Response(null, { status: 404 })
      return ready(url)
    },
  })
  assert.equal(publishes, 1)
  assert.equal(options.now(), 50 * minute)
  assert.match(options.messages.at(-1), /Verified.*archive integrity matches/)
})

test("default verification still stops after one hour when npm never becomes available", async () => {
  const options = clock()
  await assert.rejects(verifyPublication(pkg, bytes, "latest", { ...options, timeoutMs: undefined, intervalMs: 60000,
    fetcher: async () => new Response(null, { status: 404 }),
  }), /within 3600s: registry HTTP 404/)
  assert.equal(options.now(), PUBLICATION_TIMEOUT_MS)
  assert.ok(options.messages.every(message => !message.startsWith("Verified")))
})

test("metadata, channel and archive body failures after headers retry within the original deadline", async () => {
  for (const target of [versionPath, tagsPath, new URL(metadata.dist.tarball).pathname]) {
    for (const error of [new TypeError("socket closed"), new DOMException("body timed out", "TimeoutError")]) {
      const options = clock(), urls = new Set()
      let failed = false, calls = 0
      await verifyPublication(pkg, bytes, "latest", { ...options, fetcher: async (url, init) => {
        calls++
        assert.equal(init.redirect, "error")
        assert.ok(!urls.has(url))
        urls.add(url)
        if (!failed && new URL(url).pathname === target) {
          failed = true
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(Buffer.from(target.endsWith(".tgz") ? "partial archive" : '{"partial":'))
            controller.error(error)
          } }))
        }
        return ready(url)
      } })
      assert.equal(options.now(), 10)
      assert.equal(calls, target === versionPath ? 4 : target === tagsPath ? 5 : 6)
    }
  }
})

test("persistent body failures exhaust the same polling deadline without success", async () => {
  const options = clock()
  let calls = 0
  await assert.rejects(verifyPublication(pkg, bytes, undefined, { ...options, timeoutMs: 25,
    fetcher: async () => {
      calls++
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("broken body")) } }))
    },
  }), /within 0\.025s: registry response body failed or timed out/)
  assert.equal(options.now(), 25)
  assert.equal(calls, 3)
  assert.ok(options.messages.every((message) => !message.startsWith("Verified")))
})

test("a stalled response body is canceled at its request timeout", async () => {
  let canceled = 0
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const get = registryReader({ now: () => performance.now(), end: performance.now() + 500, requestTimeoutMs: 15,
      fetcher: async () => new Response(new ReadableStream({ cancel() { canceled++ } })),
    })
    await assert.rejects(get.json("https://registry.npmjs.org/opencode-reviewer/0.4.1"), /body failed or timed out/)
    assert.equal(canceled, 1)
  } finally { clearTimeout(keepAlive) }
})

test("complete malformed metadata and redirect responses remain terminal", async () => {
  for (const response of [new Response('{"broken"'), new Response(Buffer.from([0xff])),
    new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } })]) {
    const options = clock()
    let calls = 0
    await assert.rejects(verifyPublication(pkg, bytes, undefined, { ...options, fetcher: async (_, init) => {
      calls++
      assert.equal(init.redirect, "error")
      return response
    } }))
    assert.equal(options.now(), 0)
    assert.equal(calls, 1)
  }
})

test("real HTTP post-header disconnects retry complete reads and redirect targets are never contacted", async () => {
  let target, failed = false, redirected = 0, redirectMode = false
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://fixture").pathname
    if (pathname === "/redirect-target") { redirected++; res.end("unexpected"); return }
    if (redirectMode) { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/redirect-target` }); res.end(); return }
    const body = pathname === versionPath ? Buffer.from(JSON.stringify(metadata))
      : pathname === tagsPath ? Buffer.from(JSON.stringify({ latest: pkg.version })) : bytes
    if (!failed && pathname === target) {
      failed = true
      res.writeHead(200, { "content-length": body.length + 100 })
      res.flushHeaders()
      res.write(body.subarray(0, 1))
      await sleep(10)
      res.destroy()
      return
    }
    res.writeHead(200, { "content-length": body.length })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const fetcher = (url, init) => {
    assert.equal(init.redirect, "error")
    const source = new URL(url)
    return fetch(`http://127.0.0.1:${server.address().port}${source.pathname}${source.search}`, init)
  }
  try {
    for (target of [versionPath, tagsPath, new URL(metadata.dist.tarball).pathname]) {
      failed = false
      const options = clock()
      await verifyPublication(pkg, bytes, "latest", { ...options, timeoutMs: 1000, fetcher })
      assert.equal(options.now(), 10)
      assert.ok(options.messages.some((message) => message.includes("response body failed")), "failure followed successfully received headers")
    }
    redirectMode = true
    const options = clock()
    await assert.rejects(verifyPublication(pkg, bytes, undefined, { ...options, timeoutMs: 25, fetcher }), /publication could not be verified/)
    assert.equal(options.now(), 25)
    assert.equal(redirected, 0)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test("temporary registry failures retry only reads within the deadline", async () => {
  for (const status of [404, 408, 429, 500, 503, "network"]) {
    const options = clock()
    let calls = 0
    await verifyPublication(pkg, bytes, "latest", { ...options,
      fetcher: async (url) => {
        if (++calls === 1) {
          if (status === "network") throw new Error("offline")
          return new Response(null, { status })
        }
        return ready(url)
      },
    })
    assert.equal(options.now(), 10)
    assert.equal(calls, 4)
  }
})

test("prerelease verification requires next rather than latest", async () => {
  const prerelease = { ...pkg, version: "0.5.0-beta.1" }
  await verifyPublication(prerelease, bytes, "next", { ...clock(), fetcher: async (url) => {
    const pathname = new URL(url).pathname
    return pathname === tagsPath ? Response.json({ next: prerelease.version, latest: "1.0.0" })
      : pathname.endsWith(".tgz") ? new Response(bytes) : Response.json({ ...metadata, version: prerelease.version,
        dist: { ...metadata.dist, tarball: `https://registry.npmjs.org/opencode-reviewer/-/opencode-reviewer-${prerelease.version}.tgz` } })
  } })
})

test("historical archive verification does not read or require any dist-tag", async () => {
  const reads = []
  const options = clock()
  await verifyPublication(pkg, bytes, undefined, { ...options, fetcher: async (url) => {
    const pathname = new URL(url).pathname
    reads.push(pathname)
    assert.notEqual(pathname, tagsPath, "archive verification must not look up channel ownership")
    return ready(url)
  } })
  assert.deepEqual(reads, [versionPath, "/opencode-reviewer/-/opencode-reviewer-0.4.1.tgz"])
  assert.equal(options.now(), 0)
  assert.match(options.messages.at(-1), /Verified opencode-reviewer@0\.4\.1 on npm; archive integrity matches/)
})

test("an identical historical rerun verifies its download without publishing or channel reads", async () => {
  let reads = 0, writes = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async (url) => {
      reads++
      assert.equal(new URL(url).pathname, versionPath)
      return Response.json(metadata)
    },
    run: () => { writes++ },
  })
  assert.deepEqual(result, { status: "existing" })
  assert.equal(reads, 1)
  assert.equal(writes, 0)
  await verifyPublication(pkg, bytes, result.tag, { ...clock(), fetcher: async (url) => {
    assert.notEqual(new URL(url).pathname, tagsPath)
    return ready(url)
  } })
})

test("a new historical upload uses archive and verifies independently of the newer channel", async () => {
  let reads = 0, publishes = 0
  const result = await publishRelease("/tmp/verified.tgz", pkg, bytes, {
    fetcher: async (url) => {
      if (++reads === 1) return new Response(null, { status: 404 })
      assert.equal(new URL(url).pathname, tagsPath)
      return Response.json({ latest: "0.10.0" })
    },
    run: (command, args) => {
      publishes++
      assert.equal(command, "npm")
      assert.equal(args[0], "publish")
      assert.equal(args[args.indexOf("--tag") + 1], "archive")
    },
  })
  assert.deepEqual(result, { status: "submitted", tag: "archive" })
  await verifyPublication(pkg, bytes, result.tag === "archive" ? undefined : result.tag, { ...clock(), fetcher: async (url) => {
    assert.notEqual(new URL(url).pathname, tagsPath)
    return ready(url)
  } })
  assert.equal(publishes, 1)
})

test("a primary channel that advances during verification does not invalidate the archive", async () => {
  for (const [tag, owner] of [["latest", "0.10.0"], ["next", "0.5.0-beta.10"]]) {
    const options = clock()
    await verifyPublication(pkg, bytes, tag, { ...options, fetcher: async (url) =>
      new URL(url).pathname === tagsPath ? Response.json({ [tag]: owner }) : ready(url),
    })
    assert.equal(options.now(), 0)
    assert.match(options.messages.at(-1), new RegExp(`${tag} is ${owner.replaceAll(".", "\\.")}`))
  }
})

test("archive-only verification still rejects mismatched downloaded bytes", async () => {
  await assert.rejects(verifyPublication(pkg, bytes, undefined, { ...clock(), fetcher: async (url) =>
    new URL(url).pathname.endsWith(".tgz") ? new Response(Buffer.alloc(bytes.length)) : ready(url),
  }), /Downloaded npm archive differs/)
})

test("primary-channel verification waits for missing or older owners and rejects noncanonical owners", async () => {
  for (const owner of [undefined, "0.4.0"]) {
    const options = clock()
    await assert.rejects(verifyPublication(pkg, bytes, "latest", { ...options, timeoutMs: 25, fetcher: async (url) =>
      new URL(url).pathname === tagsPath ? Response.json(owner === undefined ? {} : { latest: owner }) : ready(url),
    }), /latest has not reached 0\.4\.1/)
    assert.equal(options.now(), 25)
  }
  for (const [owner, expected] of [["malformed", /valid semantic versioning/], ["0.4.1+other-build", /build metadata/]]) {
    const options = clock()
    await assert.rejects(verifyPublication(pkg, bytes, "latest", { ...options, fetcher: async (url) =>
      new URL(url).pathname === tagsPath ? Response.json({ latest: owner }) : ready(url),
    }), expected)
    assert.equal(options.now(), 0)
  }
})

test("noncanonical archive identity is rejected before registry verification reads", async () => {
  let reads = 0
  await assert.rejects(verifyPublication({ ...pkg, version: "0.4.1+build" }, bytes, undefined, {
    ...clock(), fetcher: async (url) => { reads++; return ready(url) },
  }), /build metadata/)
  assert.equal(reads, 0)
})

test("verification fails promptly on authentication, metadata or archive mismatch", async () => {
  for (const bad of [
    new Response(null, { status: 403 }),
    Response.json({ ...metadata, version: "0.4.0" }),
    Response.json({ ...metadata, dist: { ...metadata.dist, integrity: "different" } }),
  ]) {
    const options = clock()
    await assert.rejects(verifyPublication(pkg, bytes, "latest", { ...options, fetcher: async () => bad }))
    assert.equal(options.now(), 0)
  }
  for (const archive of [Buffer.from("short"), Buffer.alloc(bytes.length)]) {
    await assert.rejects(verifyPublication(pkg, bytes, "latest", { ...clock(),
      fetcher: async (url) => new URL(url).pathname.endsWith(".tgz") ? new Response(archive) : ready(url),
    }), /archive.*differs/)
  }
})

test("archive verification never sends a registry request to another origin", async () => {
  let calls = 0
  await assert.rejects(verifyPublication(pkg, bytes, "latest", { ...clock(),
    fetcher: async (url) => {
      calls++
      return new URL(url).pathname === versionPath
        ? Response.json({ ...metadata, dist: { ...metadata.dist, tarball: "https://elsewhere.test/file.tgz" } })
        : ready(url)
    },
  }), /Expected the npm registry/)
  assert.equal(calls, 2)
})

test("persistent processing ends with an explicit timeout, not success", async () => {
  const options = clock()
  let calls = 0
  await assert.rejects(verifyPublication(pkg, bytes, "latest", { ...options, timeoutMs: 25,
    fetcher: async () => { calls++; return new Response(null, { status: 404 }) },
  }), /publication could not be verified.*do not republish/)
  assert.equal(options.now(), 25)
  assert.equal(calls, 3)
  assert.ok(options.messages.every((message) => !message.startsWith("Verified")))
})
