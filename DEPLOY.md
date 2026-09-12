# 🚀 Deploy do Garimpeiro 3D

Você tem dois caminhos simples. Os dois usam o **mesmo `Dockerfile`**.

## 🅰️ Render.com (recomendado pra testar)

**Por quê Render:**
- Plano **free de verdade** (sem cartão de crédito)
- Docker nativo, build rápido (~2 min)
- Disco persistente 1 GB grátis
- URL pública tipo `garimpeiro-3d.onrender.com`
- ⚠️ **Hiberna após 15 min sem tráfego** no free tier — primeiro request depois disso demora ~30s

### Passo a passo

1. **Crie um repo no GitHub** e suba os arquivos da pasta `garimpeiro-3d/`:
   ```
   garimpeiro-3d/
   ├── standalone.mjs
   ├── public/admin.html
   ├── Dockerfile
   ├── render.yaml        ← este guia o Render a criar tudo certinho
   └── .env.example
   ```

2. **No Render** → https://dashboard.render.com → **New +** → **Blueprint**
   - Conecte o repo do GitHub
   - Render lê o `render.yaml` automaticamente e propõe criar o serviço
   - Clique **Apply**

3. **Aguarde o build** (1–3 min, vai aparecer "Live")

4. **Pegue a URL** — aparece no topo do dashboard, tipo:
   ```
   https://garimpeiro-3d-xxxx.onrender.com
   ```

5. **Acesse o painel:**
   ```
   https://garimpeiro-3d-xxxx.onrender.com/admin
   ```

6. **Configurar o webhook do WhatsApp:**
   - Na Meta: webhook URL = `https://garimpeiro-3d-xxxx.onrender.com/webhook`
   - Verify Token = o mesmo que está em `WA_WEBHOOK_VERIFY_TOKEN` (variável de ambiente)

7. **Configurar pelo painel:**
   - 🔌 Conexão WA → Phone ID + Token + Verify + URL
   - 💰 Afiliados → IDs
   - 👥 Grupos alvo → adicionar

### Variáveis no Render

No painel do serviço → **Environment** → **Add Environment Variable**. O `render.yaml` já define:
- `NODE_ENV=production`
- `PORT=3040` (Render ignora; ele injeta a própria)
- `WA_WEBHOOK_VERIFY_TOKEN=garimpo-3d-verify`

Você adiciona depois as outras conforme precisar.

---

## 🅱️ Railway

Mais rápido no cold start (não hiberna agressivamente), 500h/mês grátis + volume grátis.

1. **GitHub** → suba o código
2. **Railway** → New Project → Deploy from GitHub Repo
3. Crie **Volume** montado em `/app/data` (senão perde o banco a cada redeploy)
4. Settings → Networking → Generate Domain

Veja detalhes em `DEPLOY-RAILWAY.md`.

---

## Comparação rápida

| | **Render free** | **Railway free** |
|---|---|---|
| Cartão de crédito | Não | Não |
| Hibernação | Após 15 min sem uso | Não hiberna |
| Cold start | ~30s | ~5s |
| Disco persistente | 1 GB grátis | 1 GB grátis |
| Uptime | Pode hibernar | 24/7 |
| URL pública | ✅ | ✅ |

**Pra testar agora**, vai de Render. **Pra ficar 24/7 sem dor**, Railway.

---

## Problemas comuns

**`Application failed to start`**
→ Abra os logs do Render (no painel → Logs). Em geral é falta de `PORT` ou erro no `node:sqlite`.

**Painel carrega mas tudo vazio**
→ Normal no primeiro boot. O scan inicial roda 5s depois do start.

**Webhook do WhatsApp não verifica**
→ O `WA_WEBHOOK_VERIFY_TOKEN` da env precisa ser **exatamente igual** ao que você digitou na Meta.

**O serviço hibernou e demora pra acordar**
→ Free tier do Render hiberna pra economizar CPU. É normal. Pra evitar, abra o painel uma vez a cada 10 min ou faça upgrade ($7/mês → sem hibernação).
