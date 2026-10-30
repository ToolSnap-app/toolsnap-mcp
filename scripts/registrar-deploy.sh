#!/usr/bin/env bash
# Accion A14: registra como ESPERADO el deployment que acaba de hacerse de un
# Worker, para que la vigilancia (src/alerts/deploy-watch.ts) no avise.
#
#   CLOUDFLARE_API_TOKEN=... scripts/registrar-deploy.sh <worker>
#
# Lo llama .github/workflows/deploy.yml tras `wrangler deploy`; tambien sirve a
# mano tras un despliegue hecho desde el Mac (o tras un `wrangler secret put`,
# que crea una version nueva). Lee el deployment mas reciente del Worker y
# escribe `esperado:{worker}:{versionId}` en el KV de X402_NONCES (caduca a los
# 90 dias). Se registra el DEPLOYMENT y no la version para que un rollback a
# una version ya conocida siga avisando. El token necesita Workers Metadata
# Read-Only (o Scripts Read) y Workers KV Storage Edit en la cuenta. No imprime el token ni ninguna respuesta de la API.
#
# Variables opcionales: CF_ACCOUNT_ID, KV_NAMESPACE_ID.
set -euo pipefail

worker="${1:-}"
if [ -z "$worker" ]; then
  echo "uso: scripts/registrar-deploy.sh <worker>" >&2
  exit 2
fi
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "falta CLOUDFLARE_API_TOKEN en el entorno" >&2
  exit 2
fi

export WORKER="$worker"
export CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-561a4c3a5324b4554556517bd1929bc1}"
export KV_NAMESPACE_ID="${KV_NAMESPACE_ID:-2d9952d84d604b66863c96766a2c58c4}"

# node en vez de curl: el token no aparece en la lista de procesos.
exec node --input-type=module -e '
const { CLOUDFLARE_API_TOKEN: token, WORKER: worker, CF_ACCOUNT_ID: acc, KV_NAMESPACE_ID: ns } = process.env;
const api = "https://api.cloudflare.com/client/v4/accounts/" + acc;
const headers = { Authorization: "Bearer " + token };

const dep = await fetch(api + "/workers/scripts/" + encodeURIComponent(worker) + "/deployments", { headers });
if (!dep.ok) { console.error("no se pudo leer los deployments de " + worker + ": HTTP " + dep.status); process.exit(1); }
const latest = (await dep.json()).result?.deployments?.[0];
if (!latest?.id) { console.error("el Worker " + worker + " no tiene deployments"); process.exit(1); }

const key = encodeURIComponent("esperado:" + worker + ":dep:" + latest.id);
const res = await fetch(api + "/storage/kv/namespaces/" + ns + "/values/" + key + "?expiration_ttl=7776000", {
  method: "PUT",
  headers: { ...headers, "Content-Type": "text/plain" },
  body: new Date().toISOString(),
});
if (!res.ok) { console.error("no se pudo registrar el deployment " + latest.id + ": HTTP " + res.status + (res.status === 403 ? " (falta Workers KV Storage Edit)" : "")); process.exit(1); }
console.log("registrado " + worker + " deployment " + latest.id);
'
