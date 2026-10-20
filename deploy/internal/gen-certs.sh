#!/bin/sh
# 生成内部 CA 与服务端证书（CentOS 7 / OpenSSL 1.0.2 兼容写法）
set -e
D=/opt/inspection/certs
mkdir -p $D
chmod 700 $D
cd $D

if [ -f server-chain.crt ] && [ -f server.key ]; then
  echo "已存在证书，跳过生成（如需重签，删除 $D 后重跑）"
  exit 0
fi

cat > ca.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
C = CN
O = Inspection Ledger
CN = Inspection Internal CA
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF

cat > server.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
C = CN
O = Inspection Ledger
CN = 10.1.114.115
EOF

cat > server.ext <<'EOF'
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt
[alt]
IP.1 = 10.1.114.115
IP.2 = 127.0.0.1
DNS.1 = localhost
DNS.2 = bogon
DNS.3 = inspection.internal
EOF

# 1) CA（10 年）
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
  -keyout ca.key -out ca.crt -config ca.cnf 2>/dev/null

# 2) 服务端密钥与 CSR
openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout server.key -out server.csr -config server.cnf 2>/dev/null

# 3) 用 CA 签发（825 天：iOS/macOS 对终端证书的有效期上限）
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 -sha256 -extfile server.ext 2>/dev/null

cat server.crt ca.crt > server-chain.crt

rm -f server.csr ca.srl ca.cnf server.cnf

chmod 600 ca.key server.key
chmod 644 ca.crt server.crt server-chain.crt server.ext

echo "=== 生成完成 ==="
ls -l $D
echo "=== 证书信息 ==="
openssl x509 -in server.crt -noout -subject -issuer -dates
openssl x509 -in server.crt -noout -text | grep -A2 "Subject Alternative Name"
