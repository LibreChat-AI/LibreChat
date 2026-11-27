import Authz.Vectors

def main : IO Unit := do
  IO.FS.createDirAll "vectors"
  IO.FS.writeFile "vectors/shared-link.ndjson" (Authz.render Authz.shareHeader Authz.shareLines)
  IO.FS.writeFile "vectors/resource.ndjson" (Authz.render Authz.resourceHeader Authz.resourceLines)
