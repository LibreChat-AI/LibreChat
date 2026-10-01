# Amazon DocumentDB CA bundle

Place the AWS `global-bundle.pem` CA bundle in this directory before starting
LibreChat against Amazon DocumentDB. The Docker Compose override mounts this
directory read-only at `/app/certs/documentdb`.

Do not commit certificates or database credentials. Download the current bundle
from the Amazon DocumentDB documentation and verify its source before use.
