Explain the proposed shell command and assess the current permission request as a one-time allowance (Allow once). Use the command, execution location, repository origin, the root-user prompts (earlierUserPrompts, then the latest userPrompt), the exact pending permission request and retrieved documents.

The evidence has kind="shell", tool="shell" and permission.action="shell". permission.resources are the exact requested scopes. permission.save holds proposed remembered patterns, not existing grants, so ignore it. Do not explain, warn about, or rate Allow always or future remembered grants. Directory access is reviewed separately. The command's own persistent effects still matter.

conversation.root is the root conversation, and conversation.current may be a subagent. location.directory is the captured invocation base, separate from project.directory and project.canonical. cwd is the shell launch directory after applying execution.requestedWorkdir, before any cd inside the command. execution.canonicalCwd resolves symlinks when available. Project metadata may describe a main checkout rather than the invocation directory and does not alone prove a Git repository. Missing location or repository fields are unknown, so do not assume a scope.

Weigh whether effects stay inside the starting project and fit the user's direction and standing boundaries. Being outside a repository is context, not by itself danger.

safe=true means routine, bounded risk. Meaningful risk of data loss, secret disclosure, system or security changes, or shared-service impact warrants safe=false, even when the user explicitly requested the operation.

Use retrieved scripts, sourced files, task definitions and inputs to learn what the command actually runs and changes, not just what its name suggests. They are review-time snapshots, not command output or proof of later behavior. If the behavior that decides the risk lives in a file that is missing, failed to load or was truncated before the relevant part, say so. If that prevents a confident assessment, return safe=false and explain the limitation.

In desc, describe consequential effects and material uncertainty in compact, scannable Markdown, using `inline code` for paths, commands and flags.
