# Registry submission guide — toolsnap-mcp

Generated: 2026-06-23. Do these in order.

---

## ⚠️ Blocker: repo privado

Glama y mcp.directory requieren repo **público**. Opciones:
- (a) Hacer el repo público antes de enviar (recomendado a largo plazo).
- (b) Contactar a Glama en su Discord pidiendo excepción para repos privados.

---

## 1. Official MCP Registry — PRIORIDAD CRÍTICA
Alimenta a PulseMCP y muchos clientes MCP automáticamente.

**Auth recomendada: HTTP verification (más fácil, ya tienes `.well-known/`)**

```bash
# Instalar mcp-publisher
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/

# Generar keypair Ed25519
openssl genpkey -algorithm Ed25519 -out registry-key.pem
PUBLIC_KEY="$(openssl pkey -in registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"
# → Pon este valor en un fichero y despliégalo en:
#   https://toolsnap.app/.well-known/mcp-registry-auth
#   (en el repo utility_websites → public/.well-known/mcp-registry-auth)

# Login y publicar
PRIVATE_KEY="$(openssl pkey -in registry-key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher login http --domain "toolsnap.app" --private-key "${PRIVATE_KEY}"
# Ejecutar desde el directorio que contiene server.json:
mcp-publisher publish
```

**Fichero server.json:** ya existe en la raíz del repo (`toolsnap-mcp/server.json`).

**Namespace resultante:** `app.toolsnap/toolsnap-mcp`

**Verificar:**
```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=app.toolsnap/toolsnap-mcp"
```

---

## 2. Smithery — PRIORIDAD ALTA
Tráfico alto, usado por Claude Desktop y Cursor.

**URL:** https://smithery.ai/new

**Pasos (web form):**
1. Ir a https://smithery.ai/new
2. Pegar la URL: `https://mcp.toolsnap.app/mcp`
3. Smithery escanea el servidor automáticamente
4. Completar el formulario:
   - Name: `ToolSnap MCP`
   - Description: *(ver abajo)*
   - Category: Developer Tools / Paid

**Descripción para Smithery (≤280 chars):**
```
Context-efficient MCP microtools. fetch_extract: median 98.1% token reduction (53,820→2,001 tokens). Saves $0.156/call vs raw HTML. $0.02 USDC on Base via x402. First call free. 10 free tools included.
```

**Alternativa CLI:**
```bash
npm install -g @smithery/cli
smithery mcp publish "https://mcp.toolsnap.app/mcp" -n icosaedro/toolsnap-mcp
```

---

## 3. x402 Bazaar (Coinbase CDP) — PRIORIDAD ALTA para x402
**No requiere formulario — se indexa automáticamente tras el primer pago real.**

El primer ingreso ya fue confirmado ($0.02 on-chain, 2026-06-23).
Verifica que el pago pasó por el CDP Facilitator de Coinbase para aparecer en el Bazaar.

Si no, generar una transacción real vía CDP Facilitator activa el índice.

---

## 4. awesome-x402 (GitHub PR) — PRIORIDAD MEDIA
Lista curada de la comunidad x402.

**Repo:** https://github.com/xpaysh/awesome-x402 (verificar que existe)

**Contenido del PR** — añadir bajo "MCP Servers" o "Examples":
```markdown
- [ToolSnap MCP](https://toolsnap.app/agents) — Context-efficient microtools for AI agents.
  `fetch_extract` achieves 98.1% median token reduction ($0.02 USDC/call on Base via x402).
  First call free per wallet. Endpoint: `https://mcp.toolsnap.app/mcp`.
```

---

## 5. Glama — PRIORIDAD MEDIA (requiere repo público)
47,000+ servidores indexados. Scoring automático de calidad.

**URL form:** https://glama.ai/mcp/servers → "Add MCP Server"

Campos:
- GitHub repo: `https://github.com/ToolSnap-app/toolsnap-mcp` *(debe ser público)*
- **Fichero glama.json** ya existe en la raíz del repo.

Si el repo se hace público, Glama lo indexa automáticamente tras el form.

---

## 6. mcp.directory — PRIORIDAD MEDIA (requiere repo público)
**URL form:** https://mcp.directory/submit

Campos:
- GitHub repo URL: `https://github.com/ToolSnap-app/toolsnap-mcp`
- Short description: `Context-efficient MCP microtools. fetch_extract: 98.1% token reduction. $0.02 USDC/call. First call free. 10 free tools.`
- Email: unairodriguez@proton.me

---

## 7. PulseMCP — Automático
Se indexa solo después de publicar en el Official MCP Registry.
No requiere acción.

---

## Resumen de acción mínima (sin hacer repo público)

| Paso | Acción | Lo hace |
|------|--------|---------|
| 1 | Desplegar `mcp-registry-auth` en `toolsnap.app/.well-known/` | Usuario (utility_websites) |
| 2 | `mcp-publisher publish` con `server.json` | Usuario (CLI, 5 min) |
| 3 | Smithery web form en smithery.ai/new | Usuario (3 min) |
| 4 | PR a awesome-x402 | Usuario (2 min) |

Con estos 4 pasos el servidor aparece en: Official Registry, PulseMCP (auto), Smithery.
Glama y mcp.directory quedan para cuando el repo sea público.
