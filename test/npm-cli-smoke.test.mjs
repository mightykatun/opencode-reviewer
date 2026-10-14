import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gunzipSync } from "node:zlib"
import { archiveIntegrity } from "../scripts/npm-publication.mjs"
import { inspectPackageArchive, packageFiles } from "../scripts/release-artifact.mjs"
import { npmReleaseVersion } from "../scripts/release-version.mjs"
import { publishRelease } from "../scripts/publish-release.mjs"
import { archiveFixture, artifactFixture, fixturePackage, highBitNumericArchiveFixture, provenanceEnv } from "./release-fixture.mjs"

const globalRoot = execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim()
const npmRoot = path.join(globalRoot, "npm")
assert.equal(JSON.parse(await readFile(path.join(npmRoot, "package.json"), "utf8")).version, "12.2.0", "This separate smoke test requires installed npm 12.2.0")
const npmRequire = createRequire(path.join(npmRoot, "package.json"))

test("actual npm provenance builder and file verifier adopt signed release source with offline boundaries", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "npm provenance offline "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = archiveFixture(), fixture = artifactFixture(bytes)
  const program = `
    import assert from "node:assert/strict";
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import { writeFile } from "node:fs/promises";
    import net from "node:net";
    import http from "node:http";
    import https from "node:https";
    import { releaseStatement, attestStatement } from ${JSON.stringify(new URL("../scripts/release-provenance.mjs", import.meta.url).href)};
    const deny = () => { throw new Error("UNEXPECTED LIVE NETWORK"); };
    net.Socket.prototype.connect = deny; http.request = deny; https.request = deny; globalThis.fetch = deny;
    syncBuiltinESMExports();
    const root = ${JSON.stringify(npmRoot)};
    const require = createRequire(root + "/node_modules/libnpmpublish/lib/provenance.js");
    const install = (name, exports) => { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; };
    let signed = [], verified = [], uploads = [];
    install("sigstore", {
      async attest(payload, type, options) {
        signed.push(JSON.parse(payload));
        assert.equal(type, "application/vnd.in-toto+json");
        if (options.explicitFixture !== true) {
          assert.equal(options.retry, 0); assert.equal(options.timeout, 10000); assert.equal(options.tlogUpload, true);
        }
        return { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          dsseEnvelope: { payloadType: type, payload: payload.toString("base64"), signatures: [{ sig: "offline-fixture" }] },
          verificationMaterial: { tlogEntries: [{}] } };
      },
      async verify(bundle) {
        assert.equal(bundle.dsseEnvelope.signatures[0].sig, "offline-fixture", "crypto boundary rejects invalid signatures");
        verified.push(bundle);
      },
    });
    const fakeFetch = async (url, options) => {
      assert.equal(options.method, "PUT"); assert.equal(options.provenanceFile, ${JSON.stringify(path.join(root, "explicit.sigstore"))});
      // Model npm registry's certificate/source check, which local npm verifies
      // only cryptographically. Never request real OIDC or a registry write.
      const bundle = JSON.parse(options.body._attachments["opencode-reviewer-0.4.0.sigstore"].data);
      const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"));
      const source = statement.predicate.buildDefinition.resolvedDependencies[0];
      if (source.uri !== "git+https://github.com/mightykatun/opencode-reviewer@refs/heads/main"
        || source.digest.gitCommit !== "b".repeat(40)) {
        throw Object.assign(new Error("Invalid GitHub Actions SLSA v1 provenance predicate: SourceRepositoryURI/SourceRepositoryDigest mismatch"), { code: "E422" });
      }
      uploads.push(options.body); return {};
    };
    fakeFetch.pickRegistry = () => "https://registry.npmjs.org/";
    fakeFetch.json = async (url, options) => {
      assert.equal(new URL(url).pathname, "/-/npm/v1/oidc/token/exchange/package/opencode-reviewer");
      assert.equal(options.method, "POST"); return { token: "offline-exchange" };
    };
    install("npm-registry-fetch", fakeFetch);
    install("make-fetch-happen", async url => {
      assert.equal(new URL(url).origin, "https://oidc.invalid");
      assert.equal(new URL(url).searchParams.get("audience"), "npm:registry.npmjs.org");
      return { ok: true, status: 200, json: async () => ({ value: "e30." + Buffer.from(JSON.stringify({ repository_visibility: "public" })).toString("base64") + ".offline" }) };
    });
    install("libnpmaccess", { getVisibility: deny });
    const { generateProvenance, verifyProvenance } = require(root + "/node_modules/libnpmpublish/lib/provenance.js");
    const publish = require(root + "/node_modules/libnpmpublish/lib/publish.js");
    const bytes = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64");
    const statement = releaseStatement(${JSON.stringify(fixture.manifest)}, bytes, process.env);
    const subject = statement.subject[0];
    await generateProvenance([subject], { explicitFixture: true });
    assert.equal(signed[0].predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, "b".repeat(40), "stock npm uses the trigger commit");
    const bundle = await attestStatement(statement, { npmRoot: root });
    assert.deepEqual(signed[1].predicate.buildDefinition.resolvedDependencies[0], {
      name: "workflow-policy", uri: signed[0].predicate.buildDefinition.resolvedDependencies[0].uri,
      digest: signed[0].predicate.buildDefinition.resolvedDependencies[0].digest,
    });
    assert.deepEqual(signed[1].predicate.buildDefinition.resolvedDependencies[1], {
      name: "release-source", uri: "git+https://github.com/mightykatun/opencode-reviewer@refs/tags/v0.4.0", digest: { gitCommit: "a".repeat(40) },
    });
    const file = ${JSON.stringify(path.join(root, "explicit.sigstore"))};
    await writeFile(file, JSON.stringify(bundle));
    assert.deepEqual(await verifyProvenance(subject, file), bundle);
    const opts = { provenanceFile: file, defaultTag: "archive", access: "public", fetchRetries: 0 };
    const configValues = new Map();
    const config = { get: key => configValues.get(key), set: (key, value) => configValues.set(key, value),
      delete: key => configValues.delete(key), isDefault: key => { assert.equal(key, "provenance"); return true; } };
    const { oidc } = require(root + "/lib/utils/oidc.js");
    await oidc({ packageName: "opencode-reviewer", registry: "https://registry.npmjs.org/", opts, config, enableProvenanceAutoConfiguration: true });
    assert.equal(opts["//registry.npmjs.org/:_authToken"], "offline-exchange", "actual OIDC exchange succeeded");
    assert.equal(opts.provenanceFile, file); assert.equal(opts.provenance, undefined);
    await publish(${JSON.stringify(fixturePackage())}, bytes, opts);
    assert.equal(uploads.length, 1); assert.equal(signed.length, 2, "file publication must not auto-generate provenance");
    const attachments = uploads[0]._attachments;
    assert.equal(attachments["opencode-reviewer-0.4.0.sigstore"].data, JSON.stringify(bundle));
    assert.ok(Buffer.from(attachments["opencode-reviewer-0.4.0.tgz"].data, "base64").equals(bytes));
    assert.deepEqual(uploads[0]["dist-tags"], { archive: "0.4.0" });
    const wrongSource = structuredClone(statement);
    wrongSource.predicate.buildDefinition.resolvedDependencies.reverse();
    const wrongBundle = structuredClone(bundle);
    wrongBundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(wrongSource)).toString("base64");
    await writeFile(file, JSON.stringify(wrongBundle));
    await assert.rejects(publish(${JSON.stringify(fixturePackage())}, bytes, opts), { code: "E422" });
    assert.equal(uploads.length, 1, "the original tag-first ordering must be rejected at the modeled registry boundary");
    for (const change of [
      s => { s.subject[0].name = "pkg:npm/wrong@0.4.0"; },
      s => { s.subject[0].digest.sha512 = "0".repeat(128); },
      s => { s.subject.push(s.subject[0]); }, s => { s.subject = []; },
    ]) {
      const wrong = structuredClone(statement); change(wrong);
      const bad = structuredClone(bundle); bad.dsseEnvelope.payload = Buffer.from(JSON.stringify(wrong)).toString("base64");
      await writeFile(file, JSON.stringify(bad));
      const previous = verified.length;
      await assert.rejects(publish(${JSON.stringify(fixturePackage())}, bytes, opts));
      assert.equal(verified.length, previous, "subject mismatch rejects before crypto verification");
      assert.equal(uploads.length, 1);
    }
    const invalidSignature = structuredClone(bundle); invalidSignature.dsseEnvelope.signatures[0].sig = "invalid";
    await writeFile(file, JSON.stringify(invalidSignature));
    await assert.rejects(publish(${JSON.stringify(fixturePackage())}, bytes, opts), /crypto boundary/);
    await assert.rejects(publish(${JSON.stringify(fixturePackage())}, bytes, { ...opts, provenanceFile: file + ".absent" }), /Invalid provenance/);
    assert.equal(uploads.length, 1);
    console.log(JSON.stringify({ signed: signed.length, verified: verified.length, uploads: uploads.length }));
  `
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    env: { PATH: process.env.PATH, HOME: root, XDG_DATA_HOME: root, ...provenanceEnv(fixture.env),
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "offline-fixture" },
  })
  assert.deepEqual(JSON.parse(output), { signed: 2, verified: 3, uploads: 1 })
})

test("actual npm CLI forwards --provenance-file through crypto verification before its intercepted PUT", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "npm file adoption "))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bytes = archiveFixture(), tarball = path.join(root, "verified.tgz"), file = path.join(root, "signed provenance.sigstore")
  const capture = path.join(root, "boundary.json"), config = path.join(root, "user.npmrc"), empty = path.join(root, "global.npmrc")
  await writeFile(tarball, bytes)
  await writeFile(config, "//registry.npmjs.org/:_authToken=offline-fixture\n")
  await writeFile(empty, "")
  const preload = `
    import assert from "node:assert/strict";
    import { createRequire, syncBuiltinESMExports } from "node:module";
    import { writeFileSync } from "node:fs";
    import net from "node:net";
    import http from "node:http";
    import https from "node:https";
    const deny = () => { throw new Error("UNEXPECTED LIVE NETWORK"); };
    net.Socket.prototype.connect = deny; http.request = deny; https.request = deny; globalThis.fetch = deny;
    syncBuiltinESMExports();
    const require = createRequire(${JSON.stringify(path.join(npmRoot, "package.json"))});
    const install = (name, exports) => { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports }; };
    let verified = false;
    install("sigstore", { attest: deny, verify: async bundle => {
      assert.equal(bundle.dsseEnvelope.signatures[0].sig, "offline-fixture"); verified = true;
    } });
    const fakeFetch = async (url, options) => {
      assert.equal(options.method, "PUT"); assert.equal(verified, true);
      assert.equal(options.provenanceFile, ${JSON.stringify(file)});
      if (process.env.FIXTURE_PROVENANCE_REJECTION === "1") {
        throw Object.assign(new Error("422 Unprocessable Entity - PUT https://registry.npmjs.org/opencode-reviewer - Error verifying sigstore provenance bundle: Invalid GitHub Actions SLSA v1 provenance predicate"), { code: "E422" });
      }
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify(options.body));
      return {};
    };
    fakeFetch.pickRegistry = () => "https://registry.npmjs.org/";
    fakeFetch.json = deny;
    install("npm-registry-fetch", fakeFetch);
    const pacote = require("pacote");
    pacote.packument = async () => ({ versions: {} });
  `
  const subject = { name: "pkg:npm/opencode-reviewer@0.4.0", digest: { sha512: Buffer.from(archiveIntegrity(bytes).slice(7), "base64").toString("hex") } }
  const bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", dsseEnvelope: {
    payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify({ subject: [subject] })).toString("base64"),
    signatures: [{ sig: "offline-fixture" }],
  } }
  const run = (overrides = {}) => execFileSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    path.join(npmRoot, "bin/npm-cli.js"), "publish", tarball, "--ignore-scripts", "--json", "--provenance-file", file,
    "--access", "public", "--tag", "archive", "--registry", "https://registry.npmjs.org/", "--fetch-retries=0"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
    env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8", NPM_CONFIG_CACHE: path.join(root, "cache"), XDG_DATA_HOME: path.join(root, "xdg"),
      NPM_CONFIG_USERCONFIG: config, NPM_CONFIG_GLOBALCONFIG: empty, NPM_CONFIG_UPDATE_NOTIFIER: "false", ...overrides },
  })
  await writeFile(file, JSON.stringify(bundle))
  run()
  const payload = JSON.parse(await readFile(capture, "utf8"))
  assert.equal(payload._attachments["opencode-reviewer-0.4.0.sigstore"].data, JSON.stringify(bundle))
  assert.ok(Buffer.from(payload._attachments["opencode-reviewer-0.4.0.tgz"].data, "base64").equals(bytes))
  await rm(capture)
  for (const wrong of [{ ...subject, name: "pkg:npm/decoy@0.4.0" }, { ...subject, digest: { sha512: "0".repeat(128) } }]) {
    await writeFile(file, JSON.stringify({ ...bundle, dsseEnvelope: { ...bundle.dsseEnvelope,
      payload: Buffer.from(JSON.stringify({ subject: [wrong] })).toString("base64") } }))
    assert.throws(run, error => { assert.match(error.stdout + error.stderr, /does not match the package/); return true })
    await assert.rejects(lstat(capture), { code: "ENOENT" })
  }
  await writeFile(file, JSON.stringify(bundle))
  let uploads = 0, disposed = 0
  await assert.rejects(publishRelease(tarball, fixturePackage(), bytes, {
    fetcher: async () => new Response(null, { status: 404 }),
    provenance: async () => ({ file, dispose: async () => { disposed++ } }),
    run: () => { uploads++; return run({ FIXTURE_PROVENANCE_REJECTION: "1" }) },
  }), /npm rejected the signed provenance \(HTTP 422\)/)
  assert.equal(uploads, 1, "the actual npm CLI's structured refusal must not be retried")
  assert.equal(disposed, 1)
  await assert.rejects(lstat(capture), { code: "ENOENT" })
  assert.ok((await readFile(tarball)).equals(bytes))
})

test("release identities match npm 12's actual semver cleaning and bounds", () => {
  const semver = npmRequire("semver")
  for (const version of ["0.4.0", "1.0.0-rc.1", "9007199254740991.0.0", "1.0.0-beta.9007199254740993"]) {
    assert.equal(npmReleaseVersion(version), semver.clean(version))
  }
  for (const version of ["0.4.0+build", "0.5.0-beta.1+build", "v0.4.0", "=0.4.0", " 0.4.0 "]) {
    assert.notEqual(semver.clean(version), version)
    assert.throws(() => npmReleaseVersion(version))
  }
  for (const version of ["9007199254740992.0.0", `1.0.0-${"a".repeat(251)}`]) {
    assert.equal(semver.clean(version), null)
    assert.throws(() => npmReleaseVersion(version), /SemVer bounds/)
  }
})

test("npm 12's bundled publication builder demonstrates manifest tag override and version normalization without network", () => {
  // Run the unmodified npm library in a child; replace only its HTTP boundary.
  // This builds payloads in memory, never publishes and never attempts OIDC/provenance.
  const program = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    const publishPath = ${JSON.stringify(path.join(npmRoot, "node_modules/libnpmpublish/lib/publish.js"))};
    const require = createRequire(publishPath);
    const fetchPath = require.resolve("npm-registry-fetch");
    const payloads = [];
    const fakeFetch = async (url, options) => {
      assert.equal(options.method, "PUT");
      payloads.push({ tags: options.body["dist-tags"], versions: Object.keys(options.body.versions) });
      return {};
    };
    fakeFetch.pickRegistry = () => "https://registry.npmjs.org/";
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: fakeFetch };
    const publish = require(publishPath);
    for (const manifest of ${JSON.stringify([fixturePackage(), { ...fixturePackage(), tag: "latest" }, fixturePackage("0.4.0+build")])}) {
      await publish(manifest, Buffer.from("in-memory transport fixture"), { defaultTag: "archive", access: "public", provenance: false });
    }
    console.log(JSON.stringify(payloads));
  `
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  assert.deepEqual(JSON.parse(output), [
    { tags: { archive: "0.4.0" }, versions: ["0.4.0"] },
    { tags: { latest: "0.4.0" }, versions: ["0.4.0"] },
    { tags: { archive: "0.4.0" }, versions: ["0.4.0"] },
  ])
})

test("validated tar prefixes agree with npm 12's actual parser and invalid markers are rejected", () => {
  const { Header } = npmRequire("tar")
  const entries = [...inspectPackageArchive(archiveFixture()).files].map(([name, content]) => ({ name, content }))
  const valid = archiveFixture({ entries, alterHeader(header) { header.write("package", 345) } })
  assert.equal(new Header(gunzipSync(valid)).path, "package/LICENSE")
  assert.deepEqual([...inspectPackageArchive(valid).files.keys()].sort(), packageFiles)
  const disagreement = archiveFixture({ entries, alterHeader(header) { header.write("package", 345); header.fill(0, 257, 265) } })
  assert.equal(new Header(gunzipSync(disagreement)).path, "LICENSE", "npm ignores the prefix when the USTAR marker is absent")
  assert.throws(() => inspectPackageArchive(disagreement), /USTAR/)
})

test("npm 12's actual Header size disagrees with masked ASCII digits and validation rejects the checksummed archive", () => {
  const { Header } = npmRequire("tar")
  const valid = archiveFixture()
  assert.equal(new Header(gunzipSync(valid)).size, 16)
  assert.equal(inspectPackageArchive(valid).files.get("LICENSE").length, 16)
  const bytes = highBitNumericArchiveFixture("size"), header = gunzipSync(bytes).subarray(0, 512)
  assert.equal(Number.parseInt(header.subarray(124, 136).toString("ascii"), 8), 16, "former decoding silently cleared the high bit")
  const parsed = new Header(header)
  assert.equal(parsed.cksumValid, true, "this is a correctly checksummed parser disagreement")
  assert.equal(parsed.path, "package/LICENSE")
  assert.equal(parsed.size, 2, "npm's UTF-8 numeric parser stops at the corrupted digit")
  assert.throws(() => inspectPackageArchive(bytes), /Unsupported tar numeric field encoding/)
})

test("actual npm publish dry-run unpacks only validated files inside a private cache and executes no package code", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "npm-cli-dry-run-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, "home"), cwd = path.join(root, "cwd")
  await mkdir(home)
  await mkdir(cwd)
  const cache = await mkdtemp(path.join(root, "npm-release-cache."))
  await chmod(cache, 0o700)
  const marker = path.join(root, "package-code-ran")
  const hook = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unexpected")`)}`
  const pkg = { ...fixturePackage(), scripts: Object.fromEntries(["prepack", "prepare", "prepublishOnly", "publish", "postpublish", "install", "postinstall"].map((name) => [name, hook])) }
  const entries = [...inspectPackageArchive(archiveFixture({ pkg })).files].map(([name, content]) => ({ name: `package/${name}`,
    content: name === "dist/tui.js" ? "throw new Error('PACKAGE_ENTRYPOINT_MUST_NOT_EXECUTE')\n" : content }))
  const bytes = archiveFixture({ entries })
  const files = inspectPackageArchive(bytes).files
  const tarball = path.join(root, "opencode-reviewer-0.4.0.tgz")
  await writeFile(tarball, bytes)
  const observer = path.join(root, "observe-extraction.cjs"), observations = path.join(root, "extractions.jsonl")
  await writeFile(observer, `
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    require(${JSON.stringify(path.join(npmRoot, "node_modules/pacote"))});
    const FileFetcher = require(${JSON.stringify(path.join(npmRoot, "node_modules/pacote/lib/file.js"))});
    const extract = FileFetcher.prototype.extract;
    function walk(dir, prefix = "") {
      return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const relative = prefix + entry.name, file = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(file, relative + "/");
        if (!entry.isFile()) throw new Error("unexpected nonregular extraction member");
        return [{ file: relative, digest: crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64") }];
      });
    }
    FileFetcher.prototype.extract = async function (...args) {
      const result = await extract.apply(this, args);
      fs.appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ directory: args[0], files: walk(args[0]) }) + "\\n");
      return result;
    };
  `)
  const userconfig = path.join(root, "user.npmrc"), globalconfig = path.join(root, "global.npmrc")
  await writeFile(userconfig, "")
  await writeFile(globalconfig, "")
  const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig }
  const output = execFileSync(process.execPath, ["--require", observer, path.join(npmRoot, "bin/npm-cli.js"), "publish", tarball,
    "--dry-run", "--json", "--offline", "--ignore-scripts", "--provenance", "--access", "public", "--tag", "archive",
    "--registry", "https://registry.npmjs.org/", "--fetch-retries=0"], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  const report = JSON.parse(output)
  const contents = Array.isArray(report) ? report[0] : report["opencode-reviewer"]
  assert.equal(contents.version, "0.4.0")
  assert.equal(contents.integrity, archiveIntegrity(bytes), "dry-run uses the original validated archive bytes")
  assert.deepEqual(contents.files.map((file) => file.path).sort(), packageFiles)
  const records = (await readFile(observations, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  assert.ok(records.length >= 2, "CLI reads both initial and authoritative manifests through actual file extraction")
  for (const record of records) {
    assert.ok(record.directory.startsWith(`${cache}${path.sep}`))
    assert.ok(record.directory.includes(`${path.sep}tmp${path.sep}`))
    assert.deepEqual(record.files.map((file) => file.file).sort(), packageFiles)
    for (const file of record.files) assert.equal(file.digest, archiveIntegrity(files.get(file.file)).slice("sha512-".length))
  }
  assert.equal((await lstat(cache)).mode & 0o777, 0o700)
  await assert.rejects(lstat(marker), { code: "ENOENT" })
  assert.deepEqual(await readdir(home), [], "npm must not use a HOME-owned shared cache")
  assert.deepEqual(await readdir(cwd), [], "package extraction must not populate the working directory")
  assert.ok((await readFile(tarball)).equals(bytes), "CLI dry-run must leave the artifact unchanged")
})
