# Deploy de toolsnap-portal desde Actions

Nota para la sesión principal (A14/A16, 2026-10-30). Comprobado con `gh`:
`ToolSnap-app/toolsnap-portal` existe (privado, rama `main`) y **no tiene ningún
workflow** (solo `.github/dependabot.yml`), ni environments ni secrets. Hoy se
despliega a mano desde el Mac (decisión D5 del 27-10), así que ningún
`wrangler deploy` del portal pasa por `registrar-deploy.sh` y la vigilancia de
A14 avisa de cada uno. Esta nota propone el workflow; **no se ha creado allí**
(fuera de alcance de esta PR). Hay que llevarlo a ese repo.

## Qué hay que preparar antes (lo hace Unai o la sesión con acceso)

1. **Environment `production`** en `toolsnap-portal`, restringido a la rama
   `main` (como en `toolsnap-mcp`, para que un workflow editado en otra rama no
   lea el token):

   ```bash
   gh api -X PUT repos/ToolSnap-app/toolsnap-portal/environments/production \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/ToolSnap-app/toolsnap-portal/environments/production/deployment-branches \
     -f name=main -f type=branch
   ```

2. **Token propio** `github-actions-toolsnap-portal-editor` (cuenta ToolSnap,
   como A3): Editor solo sobre el Worker `toolsnap-portal` (Workers Scripts:
   Edit acotado a ese Worker), más **Workers KV Storage: Edit** para el paso de
   registro, y **Workers Metadata Read-Only** (o Scripts Read) para leer su
   deployment. El portal tiene una ruta `custom_domain` (`portal.toolsnap.app`)
   y un D1; si `wrangler deploy` pide permisos de zona para el dominio (Workers
   Routes: Edit en `toolsnap.app`), se verá en el primer run: el error lo
   dice, y la solución es dárselo acotado a esa zona. Caducidad 6 meses.
   Guardarlo con `gh secret set CLOUDFLARE_API_TOKEN --env production -R ToolSnap-app/toolsnap-portal`
   (nombre igual al de `toolsnap-mcp`; cada repo tiene el suyo).

3. **`account_id` en `wrangler.jsonc` del portal.** Un token de cuenta no
   puede listar cuentas, así que `wrangler deploy` en CI necesita
   `"account_id": "561a4c3a5324b4554556517bd1929bc1"` (hoy el portal no lo
   tiene; `toolsnap-mcp` y `toolsnap-x-personal` sí).

4. **Copiar `scripts/registrar-deploy.sh`** a `toolsnap-portal` (mismo
   contenido) o descargarlo en el workflow; el workflow de abajo supone que
   está en `scripts/`. No lleva nada del repo principal: solo usa el token y la
   API de Cloudflare. El KV es el `X402_NONCES` de `toolsnap-mcp` (id por
   defecto en el script).

## Workflow propuesto: `.github/workflows/deploy.yml`

Sigue el patrón de `toolsnap-mcp` (A12): pasos fijados por SHA, instalación sin
scripts junto al token, `production` solo desde `main`. Los SHA son los del
workflow de `toolsnap-mcp` (v7.0.1 de checkout, v7.1.0 de setup-node);
Dependabot los actualizará.

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch: {}

concurrency:
  group: deploy-production
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  deploy:
    name: Typecheck + deploy toolsnap-portal
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
          cache: npm

      # Sin scripts de instalacion junto al token.
      - run: npm ci --ignore-scripts
      - run: npm run typecheck

      - name: Deploy toolsnap-portal
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

      # A14: registra el deployment como esperado para la vigilancia.
      # Sin Workers KV Storage: Edit en el token falla sin cortar el deploy
      # y la vigilancia avisara por este deployment.
      - name: Register deployment as expected
        continue-on-error: true
        run: bash scripts/registrar-deploy.sh toolsnap-portal
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

      # El portal es la mitad del flujo OAuth del MCP: comprobar que contesta.
      - name: Smoke test portal
        run: |
          set -euo pipefail
          for i in 1 2 3 4 5; do
            if curl -sSf https://portal.toolsnap.app/.well-known/oauth-authorization-server --max-time 20 | grep -q '"registration_endpoint"'; then
              echo "smoke test OK"; exit 0
            fi
            echo "attempt $i failed, retrying in 10s"; sleep 10
          done
          echo "::error::portal smoke test failed after deploy"; exit 1
```

## Notas

- El portal tiene `package-lock.json`, así que `npm ci` funciona.
- Si el repo prefiere seguir desplegando desde el Mac (D5), basta con ejecutar
  a mano `CLOUDFLARE_API_TOKEN=... bash scripts/registrar-deploy.sh toolsnap-portal`
  en los tres minutos siguientes al deploy; el workflow solo automatiza eso.
- Nakin tiene `read` en el portal (D6): con `production` restringido a `main`
  y la regla de PR de ese repo, un cambio no llega a desplegarse sin revisión.
