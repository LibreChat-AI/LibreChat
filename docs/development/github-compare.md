# Read-only GitHub comparison

Attached command agents with repository metadata receive `github_compare` through
the code-tool registrar. The normal built-in tool loader constructs it. The PR
Reviewer needs no Git checkout, worker slot, or writable Git metadata to orient.

Inputs are a public repository owner/name and full lowercase base/head commit
SHAs. One fixed-host GitHub GET returns the base, head, merge-base, relation and
commit counts. No credentials, shell command, redirects or arbitrary URLs are
accepted. Response bytes and request duration are bounded. Provider bodies are
never model-visible errors. Private repositories are intentionally unsupported.

Use comparison to verify the supplied merge-base before reading a frozen diff.
It does not replace source inspection or tests. No deployed agent record is
edited by this PR; the capability reaches attached reviewers after deployment.
