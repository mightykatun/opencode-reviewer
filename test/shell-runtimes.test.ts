import assert from "node:assert/strict"
import { test } from "node:test"
import { runtimeOperands } from "../src/shell-runtimes.js"
import { discover } from "../src/evidence.js"

test("conventional runtime identities and explicit script operands", () => {
  const cases: [string, string[], string[]][] = [
    ["node", ["--require", "./hook.cjs", "--env-file=.env", "app.js", "not-a-script.js"], ["app.js"]],
    ["/usr/bin/nodejs", ["-r./hook.js", "--", "-script.js"], ["-script.js"]],
    ["bun", ["--preload", "./hook.ts", "app.ts"], ["app.ts"]],
    ["bun", ["run", "./app.ts", "arg.ts"], ["./app.ts"]],
    ["/bin/deno", ["run", "--allow-read=./config", "--config", "./deno.json", "app.ts"], ["app.ts"]],
    ["tsx", ["watch", "--tsconfig", "tsconfig.json", "./main.tsx"], ["./main.tsx"]],
    ["ts-node", ["--project", "./config.json", "-r", "./hook.ts", "./main.ts"], ["./main.ts"]],
    ["ts-node-esm", ["--", "-start.ts"], ["-start.ts"]],
    ["ruby", ["-I", "./lib", "-rjson", "./entry.rb"], ["./entry.rb"]],
    ["perl", ["-Mstrict", "-I", "./lib", "program.pl"], ["program.pl"]],
    ["php", ["-d", "memory_limit=128M", "-f", "app.php"], ["app.php"]],
    ["php", ["--", "-app.php"], ["-app.php"]],
    ["lua", ["-l", "lfs", "./app.lua"], ["./app.lua"]],
    ["java", ["--source", "21", "-cp", "./lib", "Hello.java", "ignored.java"], ["Hello.java"]],
    ["go", ["run", "-tags", "local", "main.go", "util.go", "not-source.go-argument"], ["main.go", "util.go"]],
    ["dotnet", ["run", "--project", "./app.csproj", "--", "other.csproj"], ["./app.csproj"]],
    ["dotnet", ["run", "--project=./app.fsproj"], ["./app.fsproj"]],
  ]
  for (const [exe, args, files] of cases) {
    assert.deepEqual(runtimeOperands(exe, args), { handled: true, files, limitations: [] }, `${exe} ${args.join(" ")}`)
  }
})

test("module and inline modes do not turn program arguments into script sources", () => {
  const cases: [string, string[]][] = [
    ["node", ["--eval", "console.log(1)", "decoy.js"]],
    ["node", ["-p42", "decoy.js"]],
    ["node", ["--run", "build", "decoy.js"]],
    ["bun", ["-e", "console.log(1)", "decoy.ts"]],
    ["deno", ["eval", "console.log(1)", "decoy.ts"]],
    ["tsx", ["-e", "console.log(1)", "decoy.ts"]],
    ["ts-node", ["--eval", "console.log(1)", "decoy.ts"]],
    ["ruby", ["-e", "puts 1", "decoy.rb"]],
    ["perl", ["-e", "print 1", "decoy.pl"]],
    ["php", ["-r", "echo 1;", "decoy.php"]],
    ["lua", ["-e", "print(1)", "decoy.lua"]],
    ["java", ["-jar", "app.jar", "decoy.java"]],
    ["uv", ["run", "-m", "module", "decoy.py"]],
  ]
  for (const [exe, args] of cases) {
    const found = runtimeOperands(exe, args)
    assert.equal(found.handled, true)
    assert.deepEqual(found.files, [], `${exe} ${args.join(" ")}`)
    assert.ok(found.limitations.length, `${exe} ${args.join(" ")}`)
    assert.equal(found.child, undefined)
  }
})

test("unsupported and missing options fail closed, with explicit limitations", () => {
  const cases: [string, string[]][] = [
    ["node", ["--mystery", "decoy.js", "real.js"]],
    ["node", ["--require", "--", "decoy.js"]],
    ["bun", ["run", "build", "decoy.ts"]],
    ["deno", ["run", "--unknown", "decoy.ts"]],
    ["tsx", ["--tsconfig", "--watch", "decoy.ts"]],
    ["ts-node", ["--project"]],
    ["ruby", ["-S", "decoy.rb"]],
    ["perl", ["-S", "decoy.pl"]],
    ["php", ["-S", "localhost:8000", "router.php"]],
    ["lua", ["-Z", "decoy.lua"]],
    ["go", ["run", "./package"]],
    ["java", ["-Dflag=1", "Decoy.java"]],
    ["dotnet", ["run", "--project", "./dir"]],
    ["npm", ["run", "build"]],
    ["uv", ["run", "--unknown", "python", "decoy.py"]],
    ["uv", ["run", "--directory", "other", "python", "decoy.py"]],
    ["bun", ["--cwd", "other", "app.ts"]],
    ["deno", ["run", "https://example.test/app.ts"]],
    ["node", ["data:text/javascript,console.log(1)"]],
  ]
  for (const [exe, args] of cases) {
    const found = runtimeOperands(exe, args)
    assert.equal(found.handled, true)
    assert.deepEqual(found.files, [], `${exe} ${args.join(" ")}`)
    assert.ok(found.limitations.length, `${exe} ${args.join(" ")}`)
    assert.equal(found.child, undefined)
  }
})

test("uv run forwards only an explicit decoded child argv, without resolving it", () => {
  for (const args of [
    ["run", "--python", "3.12", "--", "python", "./app.py", "-x"],
    ["run", "-p3.12", "python", "./app.py", "-x"],
    ["run", "--with-requirements", "requirements.txt", "python", "./app.py", "-x"],
  ]) {
    assert.deepEqual(runtimeOperands("uv", args), {
      handled: true, files: [], limitations: [], child: ["python", "./app.py", "-x"],
    })
  }
})

test("variable markers, home expansion, globbing, and arbitrary-path identities are not inferred", () => {
  const variable = "\u0000UNRESOLVED_VARIABLE\u0000"
  for (const file of [`./${variable}.ts`, "~/app.ts", "./*.ts", "./[ab].ts"]) {
    const found = runtimeOperands("node", [file])
    assert.deepEqual(found.files, [])
    assert.ok(found.limitations.length)
  }
  assert.deepEqual(runtimeOperands("uv", ["run", "python", `./${variable}.py`]).files, [])
  assert.equal(runtimeOperands("uv", ["run", "python", `./${variable}.py`]).child, undefined)
  assert.deepEqual(runtimeOperands("./node", ["./main.js"]), { handled: false, files: [], limitations: [] })
  assert.deepEqual(runtimeOperands("/opt/custom/bin/node", ["./main.js"]), { handled: false, files: [], limitations: [] })
  assert.deepEqual(runtimeOperands("/usr/local/bin/node", ["./main.js"]), { handled: false, files: [], limitations: [] })
  assert.deepEqual(runtimeOperands("/bin/../bin/node", ["./main.js"]), { handled: false, files: [], limitations: [] })
})

test("runtime operands integrate with shell wrappers without letting indirect children change shell cwd", () => {
  for (const command of ["node app.js", "bun ./app.ts", "deno run ./app.ts", "ruby task.rb",
    "perl task.pl", "php -f page.php", "lua game.lua", "go run main.go util.go", "java Main.java",
    "dotnet run --project ./app.csproj", "uv run python job.py", "command env -- node app.js"]) {
    const found = discover(command, "/project")
    assert.ok(found.references.length, command)
    assert.ok(found.references.every(file => file.cwd === "/project" && !file.executable), command)
  }
  const wrapped = discover("uv run cd sub; python job.py", "/project")
  assert.deepEqual(wrapped.references, [{ filename: "job.py", cwd: "/project", executable: false }])
  assert.deepEqual(discover("npm run build; make test", "/project").references, [])
})
