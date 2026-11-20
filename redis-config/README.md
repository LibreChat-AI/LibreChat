# Redis Configuration and Setup

This directory contains comprehensive Redis configuration files and scripts for LibreChat development and testing, supporting both cluster and single-node setups with optional TLS encryption.

## Supported Configurations

### 1. Redis Cluster (3 Nodes)
- **3 Redis nodes** running on ports 7001, 7002, and 7003
- **No replicas** (each node is a master)
- **Automatic hash slot distribution** across all nodes

### 2. Single Redis with TLS Encryption
- **Single Redis instance** on port 6380 with TLS encryption
- **CA certificate validation** for secure connections
- **Self-signed certificates** with proper Subject Alternative Names

### 3. Standard Single Redis
- **Basic Redis instance** on port 6379 (default)
- **No encryption** - suitable for local development

All configurations are designed for **local development and testing**.

## Prerequisites

1. **Redis** must be installed on your system:
   ```bash
   # macOS
   brew install redis
   
   # Ubuntu/Debian
   sudo apt-get install redis-server
   
   # CentOS/RHEL
   sudo yum install redis
   ```

2. **Redis CLI** should be available (usually included with Redis)

## Quick Start

### Option 1: Redis Cluster (3 Nodes)

```bash
# Navigate to the redis-config directory
cd redis-config

# Start and initialize the cluster
./start-cluster.sh
```

### Option 2: Single Redis with TLS

```bash
# Start Redis with TLS encryption on port 6380
./start-redis-tls.sh
```

### Option 3: Standard Redis

```bash
# Use system Redis on default port 6379
redis-server
```

## Testing Your Setup

### Test Cluster
```bash
# Connect to the cluster
redis-cli -c -p 7001

# Test basic operations
SET test_key "Hello World"
GET test_key
```

### Test TLS Redis
```bash
# Test with CA certificate validation
redis-cli --tls --cacert certs/ca-cert.pem -p 6380 ping
```

### Test Standard Redis
```bash
# Connect to default Redis
redis-cli ping
```

## Stopping Services

### Stop Cluster
```bash
./stop-cluster.sh
```

### Stop TLS Redis
```bash
# Find and stop TLS Redis process
ps aux | grep "redis-server.*6380"
kill <PID>
```

## Configuration Files

- `redis-7001.conf` - Configuration for node 1 (port 7001)
- `redis-7002.conf` - Configuration for node 2 (port 7002)
- `redis-7003.conf` - Configuration for node 3 (port 7003)

## Scripts

- `start-cluster.sh` - Starts and initializes the Redis cluster
- `stop-cluster.sh` - Stops all Redis nodes and cleans up
- `start-redis-tls.sh` - Starts Redis with TLS encryption and CA certificate validation
- `redis-tls.conf` - TLS Redis configuration file

## Directory Structure

```
redis-config/
├── README.md
├── redis-7001.conf         # Cluster node 1 configuration
├── redis-7002.conf         # Cluster node 2 configuration
├── redis-7003.conf         # Cluster node 3 configuration
├── redis-tls.conf          # TLS Redis configuration
├── start-cluster.sh        # Start cluster script
├── stop-cluster.sh         # Stop cluster script
├── start-redis-tls.sh      # Start TLS Redis script
├── certs/                  # TLS certificates (created automatically)
│   ├── ca-cert.pem         # Certificate Authority certificate
│   ├── ca-key.pem          # CA private key
│   ├── server-cert.pem     # Server certificate with SAN
│   ├── server-key.pem      # Server private key
│   ├── redis.dh            # Diffie-Hellman parameters
│   └── server.conf         # OpenSSL certificate configuration
├── data/                   # Data files (created automatically)
│   ├── 7001/               # Cluster node 1 data
│   ├── 7002/               # Cluster node 2 data
│   └── 7003/               # Cluster node 3 data
└── logs/                   # Log directory (created automatically)
    # Note: By default, Redis logs to stdout/stderr
    # Log files would be created here if enabled in config
```

## Using with LibreChat

Update your `.env` file based on your chosen Redis configuration:

### For Redis Cluster
```bash
USE_REDIS=true
REDIS_URI=redis://127.0.0.1:7001,redis://127.0.0.1:7002,redis://127.0.0.1:7003
```

### For TLS Redis
```bash
USE_REDIS=true
REDIS_URI=rediss://127.0.0.1:6380
REDIS_CA=/path/to/LibreChat/redis-config/certs/ca-cert.pem
```

### For Standard Redis
```bash
USE_REDIS=true
REDIS_URI=redis://127.0.0.1:6379
```

### Optional Configuration
```bash
# Use environment variable for dynamic key prefixing
REDIS_KEY_PREFIX_VAR=K_REVISION

# Or set static prefix
REDIS_KEY_PREFIX=librechat

# Connection limits
REDIS_MAX_LISTENERS=40

# Ping interval to keep connection alive (seconds, 0 to disable)
REDIS_PING_INTERVAL=0

# Reconnection configuration
REDIS_RETRY_MAX_DELAY=3000      # Max delay between reconnection attempts (ms)
REDIS_RETRY_MAX_ATTEMPTS=10     # Max reconnection attempts (0 = infinite)
REDIS_CONNECT_TIMEOUT=10000     # Connection timeout (ms)
REDIS_ENABLE_OFFLINE_QUEUE=true # Queue commands when disconnected
```

## TLS/SSL Redis Setup

For secure Redis connections using TLS encryption with CA certificate validation:

### 1. Start Redis with TLS

```bash
# Start Redis with TLS on port 6380
./start-redis-tls.sh
```

### 2. Configure LibreChat for TLS

Update your `.env` file:

```bash
# .env file - TLS Redis with CA certificate validation
USE_REDIS=true
REDIS_URI=rediss://127.0.0.1:6380
REDIS_CA=/path/to/LibreChat/redis-config/certs/ca-cert.pem
```

### 3. Test TLS Connection

```bash
# Test Redis TLS connection with CA certificate
redis-cli --tls --cacert certs/ca-cert.pem -p 6380 ping

# Should return: PONG

# Test basic operations
redis-cli --tls --cacert certs/ca-cert.pem -p 6380 set test_tls "TLS Working"
redis-cli --tls --cacert certs/ca-cert.pem -p 6380 get test_tls
```

### 4. Test Backend Integration

```bash
# Start LibreChat backend
npm run backend

# Look for these success indicators in logs:
# ✅ "No changes needed for 'USER' role permissions"
# ✅ "No changes needed for 'ADMIN' role permissions"
# ✅ "Server listening at http://localhost:3080"
# ✅ No "IoRedis connection error" messages
```

### TLS Certificate Details

The TLS setup includes:

- **CA Certificate**: Self-signed Certificate Authority for validation
- **Server Certificate**: Contains Subject Alternative Names (SAN) for:
  - `DNS: localhost`
  - `IP: 127.0.0.1`
- **TLS Configuration**: 
  - TLS v1.2 and v1.3 support
  - No client certificate authentication required
  - Strong cipher suites (AES-256-GCM, ChaCha20-Poly1305)

### Troubleshooting TLS

#### Certificate Validation Errors

```bash
# If you see "Hostname/IP does not match certificate's altnames"
# Check certificate SAN entries:
openssl x509 -in certs/server-cert.pem -text -noout | grep -A3 "Subject Alternative Name"

# Should show: DNS:localhost, IP Address:127.0.0.1
```

#### Connection Refused

```bash
# Check if Redis TLS is running
lsof -i :6380

# Check Redis TLS server logs
ps aux | grep redis-server
```

#### Backend Connection Issues

```bash
# Verify CA certificate path in .env
ls -la /path/to/LibreChat/redis-config/certs/ca-cert.pem

# Test LibreChat Redis configuration
cd /path/to/LibreChat
npm run backend
# Look for Redis connection errors in output
```

## Common Operations

### Check Cluster Status

```bash
# Cluster information
redis-cli -p 7001 cluster info

# Node information
redis-cli -p 7001 cluster nodes

# Check specific node
redis-cli -p 7002 info replication
```

### Monitor Cluster

```bash
# Monitor all operations
redis-cli -p 7001 monitor

# Check memory usage
redis-cli -p 7001 info memory
redis-cli -p 7002 info memory
redis-cli -p 7003 info memory
```

### Troubleshooting

#### Cluster Won't Start

1. Check if Redis is installed: `redis-server --version`
2. Check for port conflicts: `netstat -tlnp | grep :700`
3. Check Redis processes: `ps aux | grep redis-server`
4. Check if nodes are responding: `redis-cli -p 7001 ping`

#### Cluster Initialization Fails

1. Ensure all nodes are running: `./start-cluster.sh`
2. Check cluster configuration: `redis-cli -p 7001 cluster nodes`
3. Reset if needed: `redis-cli -p 7001 CLUSTER RESET`

#### Performance Issues

1. Monitor memory usage: `redis-cli -p 7001 info memory`
2. Check slow queries: `redis-cli -p 7001 slowlog get 10`
3. Adjust `maxmemory` settings in configuration files

## Configuration Details

### Node Configuration

Each node is configured with:
- **Memory limit**: 256MB with LRU eviction
- **Persistence**: AOF + RDB snapshots
- **Clustering**: Enabled with 15-second timeout
- **Logging**: Notice level (logs to stdout/stderr by default)

### Hash Slot Distribution

With 3 nodes and no replicas:
- Node 1 (7001): Hash slots 0-5460
- Node 2 (7002): Hash slots 5461-10922
- Node 3 (7003): Hash slots 10923-16383

## Security Note

### Development Setup
The basic Redis cluster setup is designed for **local development only**.

### TLS Setup
The TLS Redis configuration provides:
- ✅ **TLS encryption** with CA certificate validation
- ✅ **Server certificate** with proper Subject Alternative Names
- ✅ **Strong cipher suites** (AES-256-GCM, ChaCha20-Poly1305)
- ✅ **Certificate validation** via self-signed CA

### Production Considerations
For production use, consider:
- Authentication (`requirepass` or `AUTH` commands)
- Client certificate authentication (`tls-auth-clients yes`)
- Firewall configuration
- Replica nodes for high availability
- Proper certificate management (not self-signed)
- Key rotation policies

## Backup and Recovery

### Backup

```bash
# Backup all nodes
mkdir -p backup
redis-cli -p 7001 BGSAVE
redis-cli -p 7002 BGSAVE
redis-cli -p 7003 BGSAVE

# Copy backup files
cp data/7001/dump.rdb backup/dump-7001.rdb
cp data/7002/dump.rdb backup/dump-7002.rdb
cp data/7003/dump.rdb backup/dump-7003.rdb
```

### Recovery

```bash
# Stop cluster
./stop-cluster.sh

# Restore backup files
cp backup/dump-7001.rdb data/7001/dump.rdb
cp backup/dump-7002.rdb data/7002/dump.rdb
cp backup/dump-7003.rdb data/7003/dump.rdb

# Start cluster
./start-cluster.sh
```

## Support

For Redis-specific issues:
- [Redis Documentation](https://redis.io/docs/)
- [Redis Cluster Tutorial](https://redis.io/docs/manual/scaling/)

For LibreChat integration:
- [LibreChat Documentation](https://github.com/LibreChat-AI/LibreChat)