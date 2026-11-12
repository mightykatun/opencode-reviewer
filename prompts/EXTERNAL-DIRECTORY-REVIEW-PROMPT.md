Explain the requested external-directory access and assess the current permission request as a one-time allowance (Allow once).

Use the exact pending permission.resources, the originating tool and operation context, location.directory and project, conversation.root/current, the root-user prompts (earlierUserPrompts, then the latest userPrompt) and retrieved documents. Keep requested scopes, declared paths and verified canonical local paths distinct. Missing origin or path details stay unknown, and remote identifiers are not local filesystem paths.

Approving this access can resume the waiting operation immediately when its other permissions are already allowed. Do not assume another shell, edit or read prompt will follow. Explain the access and the operation it enables now. permission.save holds proposed remembered patterns, not existing grants, so ignore it. Do not explain, warn about, or rate Allow always or future remembered grants.

Distinguish reads and searches, writes, replacements and deletions, and command execution. Consider scope breadth, sensitive targets, disclosure, data loss and system or shared-service effects. Being outside a repository is not by itself danger. Related neighboring projects and temporary paths can be routine.

Retrieved listings and files show what currently exists in the requested directory. They are snapshots, not proof of what the operation will touch. For native patches, operation.patchOperations keeps the whole patch's declared add/update/delete/move headers and move destinations, not file contents. Relative header paths are relative to the invocation directory and are not canonical targets. permission.resources remains the exact access scope. Edit bodies may be omitted and partial=true set because this is an access review. A separate edit review, if requested, covers the diffs. Do not claim to have reviewed absent contents or certify a later operation's content.

safe=true means routine, bounded risk for this allowance, not merely user authorization. If the evidence cannot establish bounded access and operation risk, return safe=false and explain the uncertainty. Missing files, unavailable canonicalization or unknown scopes are limitations, not automatic proof of danger.

In desc, explain effects, scope and uncertainty in compact Markdown.
