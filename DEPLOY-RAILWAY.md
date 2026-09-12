# 🚂 Deploy no Railway — passo a passo

## 1. Subir o código pro GitHub

```bash
# dentro da pasta garimpeiro-3d
git init
git add standalone.mjs public/ Dockerfile railway.toml
git commit -m "garimpeiro-3d v1"
git branch -M main
git remote add origin https://github.com/SEU_USER/garimpeiro-3d.git
git push -u origin main
```

## 2. Criar o serviço no Railway

1. Acesse https://railway.app/dashboard
2. **New Project** → **Deploy from GitHub repo**
3. Selecione `garimpeiro-3d`
4. Railway detecta o Dockerfile automaticamente e começa a build

## 3. Adicionar Volume (pra não perder o banco SQLite)

Quando o Railway reinicia o container, ele recria do zero. Sem volume, você perde todas as ofertas salvas.

1. Clique no serviço
2. **Variables** → não mexa ainda
3. Clique no serviço → **Settings** → **Volumes** → **+ New Volume**
   - Mount Path: `/app/data`
   - Size: 1 GB (free tier suporta)
4. Faça **Redeploy** (botão no canto superior direito)

## 4. Variáveis de ambiente

Em **Variables**, cole tudo do `.env.example`. Pode começar com só:
- `NODE_ENV=production`
- `WA_WEBHOOK_VERIFY_TOKEN=alguma-coisa-que-voce-vai-lembrar`

E ir preenchendo o resto depois pelo painel mesmo.

## 5. Pegar a URL pública

Em **Settings** → **Networking** → **Generate Domain**.

Você vai receber algo como:
```
garimpeiro-3d-production.up.railway.app
```

Teste no navegador:
- `https://garimpeiro-3d-production.up.railway.app/admin` → painel
- `https://garimpeiro-3d-production.up.railway.app/health` → health check

## 6. Configurar o webhook do WhatsApp

1. Vá em https://developers.facebook.com/apps → seu app → **WhatsApp** → **Configuration**
2. **Webhook** → **Edit**
   - Callback URL: `https://garimpeiro-3d-production.up.railway.app/webhook`
   - Verify Token: **o mesmo que você colocou em `WA_WEBHOOK_VERIFY_TOKEN`**
3. Clique em **Verify and Save**
4. Em **Webhook fields**, assine `messages`

## 7. Configurar o app pelo painel

Acesse `https://SEU-DOMINIO.up.railway.app/admin` e:

1. **🔌 Conexão WA** → cole o Phone ID + Token + Verify Token + URL pública do webhook (a mesma do passo 6). Clique em "Testar conexão".
2. **💰 Afiliados** → coloque os IDs
3. **👥 Grupos alvo** → adicione o grupo onde quer receber ofertas
4. Use o botão **🧪 Simular mensagem** pra testar sem mandar nada de verdade
5. Quando estiver tudo OK, vá em **⚙️ Configurações** e confirme que o modo dry-run está desligado

---

## 🎯 Tudo pronto?

Você deve ver:
- Painel carrega e mostra status "WhatsApp conectado" no sidebar
- Ao clicar "Rodar scan agora", vê ofertas aparecendo (ou não, se os scrapers estiverem bloqueados — isso depende da rede do Railway)
- Mensagens simuladas entram na fila e tentam ser enviadas (em dry-run fica só logado, em real saem pro grupo)

---

## ⚠️ Problemas comuns

**"Service unavailable" no painel**
→ O health check falhou. Veja os logs: clique no serviço → **Deployments** → **View Logs**.

**Webhook não verifica**
→ O `WA_WEBHOOK_VERIFY_TOKEN` da env não é o mesmo que você digitou na Meta.

**Banco reinicia toda vez**
→ Você esqueceu de criar o Volume. As ofertas vão pra `/app/data/garimpo.db` mas some quando o container reinicia.

**Scrapers retornam 0 ofertas**
→ Normal em produção. Os marketplaces mudam o layout/HTML constantemente e podem estar bloqueando requisições sem browser fingerprint. Os scrapers são um ponto pra evoluir depois.
